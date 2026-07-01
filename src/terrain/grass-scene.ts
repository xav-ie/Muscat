import { LINE_W, layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { jitterColor, mixColors } from "../util/color.js";
import { embedCanvasAsImage } from "../util/canvas-layer.js";
import { renderMultiDrawToCanvas, type GpuDraw } from "../util/webgpu.js";
import {
  BUTTERFLY_STRIDE,
  BUTTERFLY_WGSL,
  BUTTERFLY_WIDTH_MM,
  DEFAULT_VORONOI,
  emitButterfly,
  SIDE_SCALE,
} from "./butterfly.js";

type Point = [number, number];
type RGB = [number, number, number];
interface Hill {
  pts: Point[];
  color: RGB;
}
interface FlowerHue {
  petal: RGB;
  center: RGB;
}

// 12 px/mm matches print resolution (300 DPI ≈ 11.8 px/mm).  Higher than
// the other terrains because grass has thin high-contrast features —
// blades land on 8×8 JPEG block boundaries at lower densities and pick up
// visible compression ringing.  The bump roughly doubles JPEG encoding
// cost; GPU render time is unchanged.
const PX_PER_MM = 12;

// Per-blade instance stride: 5 vec2 control points (P0, C1, P1, C2, P2) +
// 3 floats RGB = 13 floats per instance.  Used for both grass blades and
// flower stems (the same Bezier-strip shader handles both).
const BLADE_STRIDE = 13;

// Per-ellipse instance stride: cx, cy, rx, ry, angle, r, g, b = 8 floats.
// Used for leaves, flower petals, and flower centers.
const ELLIPSE_STRIDE = 8;

// Per-vertex stride for solid_mesh draws (hills + backdrop): x, y, r, g, b.
const MESH_STRIDE = 5;

// Triangle-strip segments per blade.  16 segments → 34 vertices, 32
// triangles.  Higher = smoother curves at small vertex cost.  At 12 px/mm
// each step is well below the 4× MSAA edge precision so curves stay
// smooth.
const BLADE_SEGMENTS = 16;
const BLADE_VERTS = (BLADE_SEGMENTS + 1) * 2;

// How strongly grass blades lean to match the local hill slope.  0 = all
// blades straight up.  1 = perfectly perpendicular to the hill surface.
// Slight bias reads as "grass following the ground" without looking
// blown-over.
const SLOPE_BIAS = 0.3;

// A grass tuft's tallest (central) blade rises ~5×scale mm above its base —
// see grassTuftOnGround, where heightBase peaks at (3 + 2)·scale and the
// centre blade's heightCurve is 1.  Used to know how far a hill's grass reaches
// above its crest when deciding whether a flower/butterfly behind it is buried.
const MAX_BLADE_HEIGHT_MM = 5;

// Per-hill tuft scale ranges [min, max].  Single source of truth shared by
// plantTufts (blade size) and the occlusion test (how tall the grass in front
// of a flower/butterfly can be), so the two can't drift apart.
const TUFT_SCALE_RANGE = {
  back: [0.55, 0.85],
  mid: [0.85, 1.2],
  front: [1.2, 1.7],
} as const;

// ─── WGSL SHADERS ────────────────────────────────────────────────────
// All three shaders share the same Uniforms struct (banner origin + size in
// mm) and use the same `mmToNdc` mapping to translate scene-space mm
// coordinates into normalized device coordinates.

const SHARED_UNIFORM_DECL = /* wgsl */ `
struct Uniforms {
  bannerOrigin: vec2<f32>,
  bannerSize: vec2<f32>,
  // Seed-driven scroll offset into the cloud noise field — re-rolling the
  // board moves the sky to a fresh patch of clouds.  Only SKY_WGSL reads it.
  cloudOffset: vec2<f32>,
  _pad: vec2<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

fn mmToNdc(p: vec2<f32>) -> vec4<f32> {
  let nx = (p.x - u.bannerOrigin.x) / u.bannerSize.x * 2.0 - 1.0;
  let ny = 1.0 - (p.y - u.bannerOrigin.y) / u.bannerSize.y * 2.0;
  return vec4<f32>(nx, ny, 0.0, 1.0);
}
`;

// Solid mesh: hills + backdrop.  Storage buffer holds pre-tessellated
// triangle-strip vertices as flat (x, y, r, g, b) records.
const SOLID_MESH_WGSL =
  SHARED_UNIFORM_DECL +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> verts: array<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let base = idx * ${String(MESH_STRIDE)}u;
  let p = vec2<f32>(verts[base], verts[base + 1u]);
  let color = vec4<f32>(verts[base + 2u], verts[base + 3u], verts[base + 4u], 1.0);
  return VsOut(mmToNdc(p), color);
}

@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
`;

// Blade: tessellated quadratic-Bezier strip.  Each instance is 13 floats:
// five 2D control points (P0, C1, P1, C2, P2) defining left/right curves
// from base to tip, plus RGB.  Vertex shader generates a triangle strip
// alternating left/right edge samples at SEGMENTS+1 t-values from 0..1.
const BLADE_WGSL =
  SHARED_UNIFORM_DECL +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> instances: array<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}

fn bezier(a: vec2<f32>, c: vec2<f32>, b: vec2<f32>, t: f32) -> vec2<f32> {
  let s = 1.0 - t;
  return s * s * a + 2.0 * s * t * c + t * t * b;
}

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32,
) -> VsOut {
  let base = iIdx * ${String(BLADE_STRIDE)}u;
  let p0 = vec2<f32>(instances[base], instances[base + 1u]);
  let c1 = vec2<f32>(instances[base + 2u], instances[base + 3u]);
  let p1 = vec2<f32>(instances[base + 4u], instances[base + 5u]);
  let c2 = vec2<f32>(instances[base + 6u], instances[base + 7u]);
  let p2 = vec2<f32>(instances[base + 8u], instances[base + 9u]);
  let color = vec3<f32>(instances[base + 10u], instances[base + 11u], instances[base + 12u]);

  let seg = vIdx / 2u;
  let t = f32(seg) / f32(${String(BLADE_SEGMENTS)}u);
  let isLeft = (vIdx & 1u) == 0u;
  var pos: vec2<f32>;
  if (isLeft) {
    pos = bezier(p0, c1, p1, t);
  } else {
    pos = bezier(p2, c2, p1, t);
  }
  return VsOut(mmToNdc(pos), vec4<f32>(color, 1.0));
}

@fragment
fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
`;

// Ellipse: rotated filled ellipse via SDF.  Each instance is 8 floats:
// cx, cy, rx, ry, angle, r, g, b.  Vertex shader emits a 4-vertex
// triangle-strip quad in the ellipse's local (rotated) space; fragment
// shader discards pixels outside the unit disk in normalized local coords.
// `discard` keeps the prior framebuffer value, so ellipses naturally
// composite over hills and blades.
const ELLIPSE_WGSL =
  SHARED_UNIFORM_DECL +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> instances: array<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) localNorm: vec2<f32>,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vIdx: u32,
  @builtin(instance_index) iIdx: u32,
) -> VsOut {
  let base = iIdx * ${String(ELLIPSE_STRIDE)}u;
  let cx = instances[base];
  let cy = instances[base + 1u];
  let rx = instances[base + 2u];
  let ry = instances[base + 3u];
  let ang = instances[base + 4u];
  let color = vec3<f32>(instances[base + 5u], instances[base + 6u], instances[base + 7u]);

  var signs = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0,  1.0),
  );
  let s = signs[vIdx];
  let local = s * vec2<f32>(rx, ry);
  let cosA = cos(ang);
  let sinA = sin(ang);
  let rotated = vec2<f32>(local.x * cosA - local.y * sinA, local.x * sinA + local.y * cosA);
  let world = vec2<f32>(cx + rotated.x, cy + rotated.y);
  return VsOut(mmToNdc(world), vec4<f32>(color, 1.0), s);
}

@fragment
fn fs_main(@location(0) color: vec4<f32>, @location(1) localNorm: vec2<f32>) -> @location(0) vec4<f32> {
  if (dot(localNorm, localNorm) > 1.0) { discard; }
  return color;
}
`;

// Render a 0..1 channel as a WGSL float literal — integers (0, 1) get a
// trailing `.0` since WGSL won't implicitly convert an int literal mixed
// into an f32 vector constructor in every position.
function wgslFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : n.toString();
}

// Format an RGB hex as a WGSL `vec3<f32>(...)` literal so palette colors can
// be baked straight into shader source.
function wgslVec3(hex: string): string {
  const [r, g, b] = hexToRgb01(hex);
  return `vec3<f32>(${wgslFloat(r)}, ${wgslFloat(g)}, ${wgslFloat(b)})`;
}

// Sky: a single full-banner quad whose fragment shader paints a vertical
// gradient and procedural clouds.  Replaces the old flat backdrop + scattered
// leaf/ellipse clouds.  Technique (Inigo Quilez 2D clouds + domain warping):
//   1. value-noise fBm — 6 octaves with a rotation between octaves to
//      decorrelate them and kill axis-aligned grid artifacts;
//   2. two-level domain warp — feed fBm coordinates through fBm twice, which
//      turns bland blobs into billowing, self-similar cloud shapes;
//   3. coverage threshold — smoothstep over the density remaps "below
//      threshold = clear sky, above = cloud" with soft wispy edges;
//   4. fake lighting — compare density against a sample offset toward the sun
//      so cloud tops read bright and undersides fall into shadow.
// The scene is baked once (no animation), so there's no time term.
const SKY_WGSL =
  SHARED_UNIFORM_DECL +
  /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  // Triangle-strip quad covering the whole banner; uv runs 0..1 with
  // uv.y = 0 at the top edge (sky) and 1 at the bottom.
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
  );
  let uv = corners[idx];
  let world = u.bannerOrigin + uv * u.bannerSize;
  return VsOut(mmToNdc(world), uv);
}

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

// Value noise: hash the four lattice corners, Hermite-smooth the cell coords,
// bilinearly interpolate.
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = hash2(i + vec2<f32>(0.0, 0.0));
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// 6-octave fBm.  Each octave rotates (mtx) and roughly doubles frequency
// while halving amplitude.  Normalized to ~0..1.
fn fbm(p0: vec2<f32>) -> f32 {
  var p = p0;
  var f = 0.0;
  var amp = 0.5;
  let mtx = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
  for (var i = 0; i < 6; i = i + 1) {
    f = f + amp * vnoise(p);
    p = mtx * p * 2.02;
    amp = amp * 0.5;
  }
  return f / 0.984375;
}

// Billow fBm — like fbm() but each octave uses |2·noise−1|, which yields
// rounded, cotton-like lumps instead of smooth rolling hills.  This is what
// gives clouds their puffy cumulus silhouette.  (A strong domain warp, by
// contrast, smears noise into marble veins — which is NOT what we want.)
fn fbmBillow(p0: vec2<f32>) -> f32 {
  var p = p0;
  var f = 0.0;
  var amp = 0.5;
  let mtx = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
  for (var i = 0; i < 6; i = i + 1) {
    f = f + amp * abs(2.0 * vnoise(p) - 1.0);
    p = mtx * p * 2.02;
    amp = amp * 0.5;
  }
  return f / 0.984375;
}

// Cloud density: billowy cumulus shapes nudged by a *gentle* domain warp
// (low amplitude — enough to break up symmetry without veining into marble).
fn cloudDensity(p: vec2<f32>) -> f32 {
  let warp = vec2<f32>(
    fbm(p * 0.6 + vec2<f32>(1.7, 9.2)),
    fbm(p * 0.6 + vec2<f32>(8.3, 2.8)),
  );
  return fbmBillow(p + 0.6 * warp);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let uv = in.uv;

  // Vertical sky gradient; pow() biases the blend so most of the visible
  // band stays a rich blue, paling only near the horizon.
  let skyTop = ${wgslVec3("#2f7fd6")};
  let skyHorizon = ${wgslVec3("#cfe8f7")};
  var col = mix(skyTop, skyHorizon, pow(clamp(uv.y, 0.0, 1.0), 0.55));

  // Aspect-correct the sample coords so clouds stay round, not stretched,
  // and add the seed-driven offset so each re-roll shows different clouds.
  let aspect = u.bannerSize.x / u.bannerSize.y;
  let p = vec2<f32>(uv.x * aspect, uv.y) * 2.0 + u.cloudOffset;

  let density = cloudDensity(p);
  // The cutoff carves discrete puffy clouds with blue sky between them; the
  // soft ramp gives fluffy, feathered edges.  Lower start = more/bigger puffs.
  let coverage = smoothstep(0.42, 0.64, density);

  // Fake lighting: sample density a step toward the (upper-left) sun.  Where
  // the cloud thins toward the sun the point is lit; where it thickens it is
  // self-shadowed.
  let sunward = cloudDensity(p + vec2<f32>(-0.28, -0.45));
  let lit = clamp(0.55 + (density - sunward) * 2.6, 0.0, 1.0);
  let cloudColor = mix(${wgslVec3("#9fb2cc")}, ${wgslVec3("#ffffff")}, lit);

  // Keep clouds in the upper sky: full coverage across the top ~tenth, then
  // fade out before the hilltops (whose highest crest is around uv.y ≈ 0.22).
  let band = smoothstep(0.32, 0.10, uv.y);
  col = mix(col, cloudColor, coverage * band);

  return vec4<f32>(col, 1.0);
}
`;

// Same crest-y helpers as the prior CPU implementation.
function crestYOrFallback(crest: Point[] | undefined, px: number, fallback: number): number {
  return crest ? crestYAt(crest, px) : fallback;
}
function crestYAt(crest: Point[], px: number): number {
  let lo = 0,
    hi = crest.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (crest[mid][0] <= px) lo = mid;
    else hi = mid;
  }
  const span = Math.max(1e-6, crest[hi][0] - crest[lo][0]);
  const t = (px - crest[lo][0]) / span;
  return crest[lo][1] + (crest[hi][1] - crest[lo][1]) * t;
}

// Reject a candidate flower placement if it overlaps any previously-placed
// flower's bounding circle.  Module-scoped so grassScene's loop body
// stays a single straight branch.
interface PlacedFlower {
  headX: number;
  headY: number;
  radius: number;
}
function flowerOverlap(
  placed: PlacedFlower[],
  headX: number,
  headY: number,
  radius: number,
): boolean {
  for (const p of placed) {
    const dx = p.headX - headX;
    const dy = p.headY - headY;
    const minSeparation = p.radius + radius;
    if (dx * dx + dy * dy < minSeparation * minSeparation) return true;
  }
  return false;
}

// True when more than half of an object centred at `headY` falls below the top
// of the occluding hill's grass.  Blades on the occluder grow up to
// `grassReach` mm above its crest, so the grass tops out at crest − grassReach;
// when the object's centre sits below that line, the taller foreground grass
// hides most of it and it shouldn't count as successfully placed.  The crest
// alone (the old demarcation) ignored grass height, so objects tucked just
// above the next hill still rendered buried in its blades.  No occluder (the
// front hill) means nothing in front to hide behind.
function buriedUnderGrass(
  occluder: Point[] | undefined,
  grassReach: number,
  gx: number,
  headY: number,
): boolean {
  if (!occluder) return false;
  return headY > crestYAt(occluder, gx) - grassReach;
}

// A hill layer eligible for flower/butterfly scatter.  `occluder` is the nearer
// hill (if any) whose crest and grass bound the visible band.
interface PlacementLayer {
  hill: { pts: Point[] };
  occluder: { pts: Point[] } | undefined;
  sizeScale: number;
  occluderGrassReach: number;
}
interface BandPlacement {
  gx: number;
  gy: number;
  headX: number;
  headY: number;
  radius: number;
}

// Roll one candidate placement inside a layer's visible band [crest, nextCrest]
// and reject it against the grass-occlusion and overlap rules.  Returns
// undefined when the candidate should be skipped (caller does `continue`).
// Shared by the flower and butterfly loops so both scatter identically.
function sampleBandPlacement(
  layer: PlacementLayer,
  bounds: { x: number; y: number; w: number; h: number; margin: number },
  placed: PlacedFlower[],
): BandPlacement | undefined {
  const { x, y, w, h, margin } = bounds;
  const gx = x + margin + 3 + rng() * (w - 2 * (margin + 3));
  // Scatter the base anywhere in the visible band [thisCrest, nextCrest].
  // Without this, flowers all line up along the upper ridge of each hill.
  const bandTop = crestYAt(layer.hill.pts, gx);
  const bandBottom = layer.occluder ? crestYAt(layer.occluder.pts, gx) : y + h;
  if (bandBottom <= bandTop) return undefined;
  const gy = bandTop + rng() * (bandBottom - bandTop);
  const stemH = (2.5 + rng() * 2) * layer.sizeScale;
  const headX = gx + (rng() - 0.5) * 0.6 * layer.sizeScale;
  const headY = gy - stemH;
  const radius = 3 * layer.sizeScale;
  // Reject heads more than half-buried under the nearer hill's tall grass —
  // the bare crest band lets flowers sit just above the next hill where its
  // upward-growing blades still cover most of the bloom.
  if (buriedUnderGrass(layer.occluder?.pts, layer.occluderGrassReach, gx, headY)) return undefined;
  if (flowerOverlap(placed, headX, headY, radius)) return undefined;
  return { gx, gy, headX, headY, radius };
}

// Multiply each RGB channel of a flower hue by `factor` (0..1).  Used for
// atmospheric perspective: deeper hills fade toward darker tones.
function darkenHue(hue: FlowerHue, factor: number): FlowerHue {
  return {
    petal: [hue.petal[0] * factor, hue.petal[1] * factor, hue.petal[2] * factor],
    center: [hue.center[0] * factor, hue.center[1] * factor, hue.center[2] * factor],
  };
}

// Local slope (dy/dx) of a crest polyline at column `px`.  Centered finite
// difference — epsilon small enough to capture local curvature, large
// enough to be stable.
function crestSlope(crest: Point[], px: number): number {
  const eps = 0.5;
  return (crestYAt(crest, px + eps) - crestYAt(crest, px - eps)) / (2 * eps);
}

// Append one BLADE_STRIDE-sized instance to `target`.  Stride must match
// the WGSL shader's read pattern.
function pushBlade(
  target: number[],
  p0: Point,
  c1: Point,
  p1: Point,
  c2: Point,
  p2: Point,
  color: RGB,
): void {
  target.push(
    p0[0],
    p0[1],
    c1[0],
    c1[1],
    p1[0],
    p1[1],
    c2[0],
    c2[1],
    p2[0],
    p2[1],
    color[0],
    color[1],
    color[2],
  );
}

// Append one ELLIPSE_STRIDE-sized instance to `target`.
function pushEllipse(
  target: number[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angleRadians: number,
  color: RGB,
): void {
  target.push(cx, cy, rx, ry, angleRadians, color[0], color[1], color[2]);
}
// Parse "#rrggbb" to [r, g, b] normalized to [0, 1].
function hexToRgb01(hex: string): RGB {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

// Composite grass scene rendered entirely on the GPU.  JS generates all
// primitive data (positions, colors, sizes) using the seeded RNG in the
// same call order as the prior CPU implementation, packs the data into
// storage buffers, then issues ~11 draws in z-order.  The result is a
// single JPEG-encoded <image> embed identical to the previous flow.
export async function grassScene(x: number, y: number, w: number, h: number): Promise<void> {
  const HILL_BACK = "#2e6118";
  const HILL_MID = "#477f1f";
  const HILL_FRONT = "#629f28";
  const BLADE_BACK = "#244e14";
  const BLADE_MID = "#356117";
  const BLADE_FRONT = "#4c7a1c";
  // Sky colors live in SKY_WGSL (baked into the shader); the procedural sky
  // pass replaces the old flat backdrop and scattered cloud ellipses.
  const STEM_COLOR = "#2a5e1a";

  const flowerHues: FlowerHue[] = [
    { petal: hexToRgb01("#e94f8a"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#f0f0f0"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#f4d65a"), center: hexToRgb01("#c08a1a") },
    { petal: hexToRgb01("#b075d6"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#ee8c45"), center: hexToRgb01("#7a2e0c") },
  ];

  // Butterfly wing palette — vivid hues mirroring the flower colors so the
  // two read as part of the same meadow.  Each butterfly picks one at
  // random and jitters it per-wing.
  const butterflyColors = [
    "#e94f8a",
    "#f4d65a",
    "#5aa0f4",
    "#b075d6",
    "#ee8c45",
    "#f0f0f0",
    "#ff6f4f",
  ];
  const BUTTERFLY_BODY = "#2e2418";

  // ─── Hill construction (no RNG consumed) ─────────────────────────
  function buildHill(
    crestFrac: number,
    ampFrac: number,
    phase: number,
    freqA: number,
    freqB: number,
    colorHex: string,
  ): Hill {
    const samples = 80;
    const crestY = y + h * crestFrac;
    const amp = h * ampFrac;
    const pts: Point[] = [];
    for (let index = 0; index <= samples; index++) {
      const t = index / samples;
      const px = x + t * w;
      const noise =
        Math.sin(t * Math.PI * freqA + phase) * 0.65 +
        Math.sin(t * Math.PI * freqB + phase * 1.7) * 0.35;
      const py = crestY - amp * noise;
      pts.push([px, py]);
    }
    return { pts, color: hexToRgb01(colorHex) };
  }

  // ─── Mesh tessellation (hills) ───────────────────────────────────
  // Hill: triangle-strip alternating between top-curve sample and the
  // bottom edge at the same x.  Yields a strip filling the hill polygon.
  function buildHillMesh(hill: Hill): Float32Array<ArrayBuffer> {
    const data: number[] = [];
    const bottomY = y + h;
    for (const [px, py] of hill.pts) {
      data.push(
        px,
        py,
        hill.color[0],
        hill.color[1],
        hill.color[2],
        px,
        bottomY,
        hill.color[0],
        hill.color[1],
        hill.color[2],
      );
    }
    return new Float32Array(data);
  }

  // ─── Blade and ellipse accumulators ──────────────────────────────
  // Tufts: one accumulator per hill layer (back / mid / front).
  const backTuftBlades: number[] = [];
  const midTuftBlades: number[] = [];
  const frontTuftBlades: number[] = [];
  // Butterflies: one solid-mesh accumulator (flat x,y,r,g,b triangles) per hill
  // layer, mirroring flowerSinks, so each layer's butterflies draw between their
  // hill and the next one up and a front hill correctly occludes butterflies
  // behind it.  Each butterfly's SVG path order already encodes its internal
  // z-order, so one mesh per layer suffices.
  const butterflySinks: number[][] = [[], [], []];
  // Flowers: one set of accumulators per hill so each can be drawn between
  // its hill and the next one up.  Without this split, back-hill flowers
  // would render on top of mid and front hills.
  const flowerSinks: {
    stems: number[];
    petals: number[];
    centers: number[];
  }[] = [
    { stems: [], petals: [], centers: [] },
    { stems: [], petals: [], centers: [] },
    { stems: [], petals: [], centers: [] },
  ];

  // ─── plantTufts: same RNG consumption order as the CPU version ───
  function plantTufts(
    thisCrest: Point[],
    nextCrest: Point[] | undefined,
    count: number,
    darkColor: string,
    lightColor: string,
    minScale: number,
    maxScale: number,
    target: number[],
  ): void {
    const edgeBleed = 4;
    const xMin = x - edgeBleed,
      xMax = x + w + edgeBleed;
    const tufts: { bx: number; by: number; scale: number; tilt: number }[] = [];
    for (let index = 0; index < count; index++) {
      const bx = xMin + rng() * (xMax - xMin);
      const xClamp = Math.max(x, Math.min(x + w, bx));
      const topY = crestYAt(thisCrest, xClamp);
      const botY = crestYOrFallback(nextCrest, xClamp, y + h + edgeBleed);
      if (botY <= topY) continue;
      const by = topY + rng() * (botY - topY);
      const scale = minScale + rng() * (maxScale - minScale);
      // Tilt = small fraction of the local crest slope angle.  Positive
      // slope (hill going down to the right) tilts blades right.
      const tilt = Math.atan(crestSlope(thisCrest, xClamp)) * SLOPE_BIAS;
      tufts.push({ bx, by, scale, tilt });
    }
    tufts.sort((a, b) => a.by - b.by);
    for (const t of tufts) {
      grassTuftOnGround(t.bx, t.by, darkColor, lightColor, t.scale, t.tilt, target);
    }
  }

  function grassTuftOnGround(
    gx: number,
    gy: number,
    darkColor: string,
    lightColor: string,
    scale: number,
    tilt: number,
    target: number[],
  ): void {
    const n = 3 + Math.floor(rng() * 3);
    const baseSpread = 1.4 * scale;
    // Pre-rotate every blade point around the tuft anchor (gx, gy) so all
    // blades in this tuft lean by the same `tilt` amount.
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    function tiltAround(px: number, py: number): Point {
      const dx = px - gx;
      const dy = py - gy;
      return [gx + dx * cosT - dy * sinT, gy + dx * sinT + dy * cosT];
    }
    for (let index = 0; index < n; index++) {
      const t = (index - (n - 1) / 2) / Math.max(1, n - 1);
      const bx = gx + t * baseSpread;
      const by = gy + 0.3 * scale;
      const heightBase = (3 + rng() * 2) * scale;
      const heightCurve = 1 - Math.abs(t) * 0.3;
      const height = heightBase * heightCurve;
      // Halved relative to the previous CPU values — full-strength lean
      // read as overly chaotic ("wiggly") at higher blade densities.  Same
      // two RNG draws, halved amplitude, so seed determinism is preserved.
      const leanAmount = (t * (0.9 + rng() * 0.7) + (rng() - 0.5) * 0.4) * 0.5;
      const tipX = bx + leanAmount * scale;
      const tipY = by - height;
      // Wider base + control points pulled toward the linear midpoint so
      // edges read more like straight tapered triangles than soft curves.
      const halfBase = 0.42 * scale;
      const ctrl1X = bx - halfBase + (tipX - (bx - halfBase)) * 0.48;
      const ctrl1Y = by + (tipY - by) * 0.5;
      const ctrl2X = bx + halfBase + (tipX - (bx + halfBase)) * 0.48;
      const ctrl2Y = by + (tipY - by) * 0.5;
      const mixT = Math.pow(rng(), 1.6);
      const baseHex = mixColors(darkColor, lightColor, mixT);
      const finalHex = jitterColor(baseHex, 0.6);
      pushBlade(
        target,
        tiltAround(bx - halfBase, by),
        tiltAround(ctrl1X, ctrl1Y),
        tiltAround(tipX, tipY),
        tiltAround(ctrl2X, ctrl2Y),
        tiltAround(bx + halfBase, by),
        hexToRgb01(finalHex),
      );
    }
  }

  // ─── Flower emission ────────────────────────────────────────────
  // sizeScale shrinks the whole flower (stem thickness, petal size, center
  // disc); darken multiplies the stem color toward black for atmospheric
  // perspective on the back hills.  Petal/center colors are already
  // darkened by the caller before being passed in.
  function emitFlower(
    sink: { stems: number[]; petals: number[]; centers: number[] },
    gx: number,
    gy: number,
    headX: number,
    headY: number,
    hue: FlowerHue,
    sizeScale: number,
    darken: number,
  ): void {
    const stemCtrlX = (gx + headX) / 2 + (rng() - 0.5) * 0.5 * sizeScale;
    const stemCtrlY = (gy + headY) / 2;
    const dx = headX - gx;
    const dy = headY - gy;
    const dlen = Math.max(1e-6, Math.hypot(dx, dy));
    const perpX = -dy / dlen;
    const perpY = dx / dlen;
    const halfWidth = LINE_W * 0.35 * sizeScale;
    const baseStem = hexToRgb01(STEM_COLOR);
    const stemColor: RGB = [baseStem[0] * darken, baseStem[1] * darken, baseStem[2] * darken];
    pushBlade(
      sink.stems,
      [gx - perpX * halfWidth, gy - perpY * halfWidth],
      [stemCtrlX - perpX * halfWidth, stemCtrlY - perpY * halfWidth],
      [headX, headY],
      [stemCtrlX + perpX * halfWidth, stemCtrlY + perpY * halfWidth],
      [gx + perpX * halfWidth, gy + perpY * halfWidth],
      stemColor,
    );

    const nPetals = 6;
    const petalRx = 0.55 * sizeScale;
    const petalRy = 1.05 * sizeScale;
    const ringR = 0.85 * sizeScale;
    for (let index = 0; index < nPetals; index++) {
      const a = index * ((Math.PI * 2) / nPetals);
      const px = headX + Math.cos(a) * ringR;
      const py = headY + Math.sin(a) * ringR;
      const rotation = a + Math.PI / 2;
      pushEllipse(sink.petals, px, py, petalRx, petalRy, rotation, hue.petal);
    }

    const centerR = 0.75 * sizeScale;
    pushEllipse(sink.centers, headX, headY, centerR, centerR, 0, hue.center);
  }

  // ─── Build hills (no RNG) ────────────────────────────────────────
  const backHill = buildHill(0.4, 0.18, 0.6, 1.2, 3.1, HILL_BACK);
  const midHill = buildHill(0.55, 0.22, 2.1, 1.6, 4.3, HILL_MID);
  const frontHill = buildHill(0.72, 0.2, 0, 1.8, 5.7, HILL_FRONT);

  // ─── Generate primitives ─────────────────────────────────────────
  // The sky (gradient + procedural clouds) is drawn by SKY_WGSL and needs no
  // CPU-side generation.  RNG-driven primitives:
  //   1. plantTufts back
  //   2. plantTufts mid
  //   3. plantTufts front
  //   4. flowers
  // Scale ranges bumped ~1.4× to read as bigger, more geometric blades.
  const [backMin, backMax] = TUFT_SCALE_RANGE.back;
  const [midMin, midMax] = TUFT_SCALE_RANGE.mid;
  const [frontMin, frontMax] = TUFT_SCALE_RANGE.front;
  plantTufts(
    backHill.pts,
    midHill.pts,
    10_000,
    BLADE_BACK,
    HILL_BACK,
    backMin,
    backMax,
    backTuftBlades,
  );
  plantTufts(midHill.pts, frontHill.pts, 8000, BLADE_MID, HILL_MID, midMin, midMax, midTuftBlades);
  plantTufts(
    frontHill.pts,
    undefined,
    8000,
    BLADE_FRONT,
    HILL_FRONT,
    frontMin,
    frontMax,
    frontTuftBlades,
  );

  // Flowers scattered across all three hills.  Each flower picks a hill
  // Each layer pairs a hill (whose surface holds flowers) with the hill
  // immediately in front (which bounds the visible band, since anything
  // below it on this hill is hidden).  The front hill has no occluder so
  // its band extends down to the banner bottom.  Per-layer style adds
  // atmospheric perspective: deeper hills get smaller and darker flowers.
  // `occluderGrassReach` is how far the next (nearer) hill's tallest blades
  // rise above its crest — the foreground grass a flower/butterfly on this hill
  // can be hidden behind.  It's the occluder's max tuft scale × the per-tuft
  // blade height, so it tracks the same blades plantTufts actually draws.
  const flowerLayers = [
    {
      hill: backHill,
      occluder: midHill,
      sizeScale: 0.5,
      darken: 0.5,
      occluderGrassReach: MAX_BLADE_HEIGHT_MM * TUFT_SCALE_RANGE.mid[1],
    },
    {
      hill: midHill,
      occluder: frontHill,
      sizeScale: 0.75,
      darken: 0.75,
      occluderGrassReach: MAX_BLADE_HEIGHT_MM * TUFT_SCALE_RANGE.front[1],
    },
    { hill: frontHill, occluder: undefined, sizeScale: 1, darken: 1, occluderGrassReach: 0 },
  ] as const;
  const margin = 2;
  // Per-hill flower quota — the *distribution* of flowers across hills.  This
  // matches the old skew (`Math.pow(rng(), 0.5)` → ~1/9, 3/9, 5/9 of the count),
  // so the meadow still thins toward the back for atmospheric perspective, but
  // the split is now fixed up front instead of an emergent side effect of the
  // placement loop.
  //
  // Why a quota instead of rolling a skewed layer per attempt: the old loop
  // chose a layer *then* could reject the candidate (`buriedUnderGrass` or
  // `flowerOverlap`) and try again against a freshly-rolled layer.  Only the
  // back and mid hills have an occluder in front of them, so only their
  // candidates ever fail `buriedUnderGrass` — front candidates almost never do.
  // With `while (placed.length < total)`, every rejected back/mid attempt
  // was effectively replaced by a front success, pulling the realized mix far
  // more front-heavy than the 11/33/56 the skew intended.  Quotas decouple "how
  // many flowers per hill" (distribution) from "where on the hill" (placement
  // quality): rejection now only reshuffles a flower within its own layer and
  // can never steal it for the front.
  //
  // [back, mid, front].  The back share is lifted above the old 4 because back
  // flowers are small (sizeScale 0.5) and atmospherically darkened (darken 0.5),
  // so an equal count reads as far fewer — the back needs more blooms just to
  // register as a populated hill rather than a bare ridge.
  const layerQuota = [10, 12, 20] as const;
  // Rejection sampling — placed flower heads can't overlap.  Each flower's
  // visible footprint is roughly `ringR + petalRy` (~1.9 * sizeScale); 3 *
  // sizeScale spaces them out more (1.5× the previous separation).
  const placed: PlacedFlower[] = [];
  for (const [layerIndex, layer] of flowerLayers.entries()) {
    const quota = layerQuota[layerIndex];
    const maxAttempts = quota * 50;
    let placedInLayer = 0;
    let attempts = 0;
    while (placedInLayer < quota && attempts < maxAttempts) {
      attempts++;
      const candidate = sampleBandPlacement(layer, { x, y, w, h, margin }, placed);
      if (!candidate) continue;
      const { gx, gy, headX, headY, radius } = candidate;
      const hue = flowerHues[Math.floor(rng() * flowerHues.length)];
      emitFlower(
        flowerSinks[layerIndex],
        gx,
        gy,
        headX,
        headY,
        darkenHue(hue, layer.darken),
        layer.sizeScale,
        layer.darken,
      );
      placed.push({ headX, headY, radius });
      placedInLayer++;
    }
  }

  // 6. Butterflies — same placement algorithm as flowers: skewed per-layer
  // selection, scatter within the visible band, per-layer size and darken,
  // and rejection sampling against the SAME `placed` set so butterflies
  // neither overlap each other nor the flowers.  The body floats at the
  // flower "head" height (gy - stemH) rather than sitting on the ground.
  const butterflyCount = 5;
  const butterflyMaxAttempts = butterflyCount * 50;
  // Wing hues are handed out without replacement, so no two butterflies share a
  // base color.  Drawn only once a placement is accepted, so a rejected
  // candidate never burns a hue.
  const availableWingColors = [...butterflyColors];
  // Stricter spacing than flowers: butterflies sit at least a full wingspan
  // apart (the flower rule only keeps bounding circles from touching, which
  // still lets wings crowd or overlap).  Tracked separately with each
  // butterfly's wingspan so the rule is butterfly-to-butterfly.
  const placedButterflies: { x: number; y: number; width: number }[] = [];
  let butterfliesPlaced = 0;
  let butterflyAttempts = 0;
  while (butterfliesPlaced < butterflyCount && butterflyAttempts < butterflyMaxAttempts) {
    butterflyAttempts++;
    const layerIndex = Math.min(
      flowerLayers.length - 1,
      Math.floor(Math.pow(rng(), 0.5) * flowerLayers.length),
    );
    const layer = flowerLayers[layerIndex];
    // Same band scatter and grass-aware rejection as flowers: drop bodies that
    // would render mostly behind the nearer hill's tall blades.
    const candidate = sampleBandPlacement(layer, { x, y, w, h, margin }, placed);
    if (!candidate) continue;
    const { headX, headY, radius } = candidate;
    // Side profiles are preferred 2:1 over the rarer top-down view (~67% side);
    // side ones bank less (the perspective already reads as 3D) and pick a
    // random left/right facing.
    const side = rng() < 2 / 3;
    const faceSign = rng() < 0.5 ? -1 : 1;
    const tilt = (rng() - 0.5) * (side ? 0.6 : 1.2);
    const seed = rng() * 100;
    // Reject if within a wingspan of any already-placed butterfly (the larger
    // of the two spans, so neither sits inside the other's width).
    const sizeScale = side ? layer.sizeScale * SIDE_SCALE : layer.sizeScale;
    const width = BUTTERFLY_WIDTH_MM * sizeScale;
    let tooClose = false;
    for (const b of placedButterflies) {
      const dx = b.x - headX;
      const dy = b.y - headY;
      const minSeparation = Math.max(width, b.width);
      if (dx * dx + dy * dy < minSeparation * minSeparation) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    // Each butterfly picks one unique palette hue (jittered) for its wings,
    // recolored across the SVG's blue tones.  The pool refills only if it ever
    // runs dry (more butterflies than palette entries).
    if (availableWingColors.length === 0) availableWingColors.push(...butterflyColors);
    const wingHex = availableWingColors.splice(
      Math.floor(rng() * availableWingColors.length),
      1,
    )[0];
    const base = hexToRgb01(jitterColor(wingHex, 0.4));
    // A second palette hue (distinct from the wing's) drives the Voronoi cells.
    const spotChoices = butterflyColors.filter((c) => c !== wingHex);
    const spotHex = spotChoices[Math.floor(rng() * spotChoices.length)];
    const spot = hexToRgb01(jitterColor(spotHex, 0.4));
    emitButterfly(butterflySinks[layerIndex], {
      bx: headX,
      by: headY,
      sizeScale,
      tilt,
      side,
      faceSign,
      base,
      spot,
      bodyColor: hexToRgb01(BUTTERFLY_BODY),
      darken: layer.darken,
      seed,
      hindOverlay: DEFAULT_VORONOI.hindOverlay,
      sideForewingDeg: DEFAULT_VORONOI.sideForewingDeg,
      topForewingDeg: DEFAULT_VORONOI.topForewingDeg,
    });
    placed.push({ headX, headY, radius });
    placedButterflies.push({ x: headX, y: headY, width });
    butterfliesPlaced++;
  }

  // ─── Pack uniforms and dispatch draws ────────────────────────────
  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));
  // Seed-driven cloud scroll offset.  Drawn from the RNG *after* every other
  // primitive is generated, so it shifts the clouds on re-roll without
  // perturbing the grass/flower/butterfly layout.  The large multiplier jumps
  // far across the noise field so successive seeds look unrelated.
  const cloudOffsetX = rng() * 500;
  const cloudOffsetY = rng() * 500;
  // Shared uniform buffer: vec2 bannerOrigin + vec2 bannerSize + vec2
  // cloudOffset + vec2 pad = 32 bytes.  Float32Array<ArrayBuffer> (concrete)
  // is needed so its `.buffer` narrows to `ArrayBuffer` rather than the
  // default `ArrayBufferLike` (which would include `SharedArrayBuffer`).
  const uniforms: Float32Array<ArrayBuffer> = new Float32Array([
    x,
    y,
    w,
    h,
    cloudOffsetX,
    cloudOffsetY,
    0,
    0,
  ]);

  function meshDraw(verts: Float32Array<ArrayBuffer>): GpuDraw {
    return {
      wgsl: SOLID_MESH_WGSL,
      topology: "triangle-strip",
      vertexCount: verts.length / MESH_STRIDE,
      uniforms,
      storage: verts,
    };
  }
  function bladeDraw(blades: number[]): GpuDraw {
    const instanceCount = blades.length / BLADE_STRIDE;
    const storage: Float32Array<ArrayBuffer> = new Float32Array(blades);
    return {
      wgsl: BLADE_WGSL,
      topology: "triangle-strip",
      vertexCount: BLADE_VERTS,
      instanceCount,
      uniforms,
      storage,
    };
  }
  function ellipseDraw(ellipses: number[]): GpuDraw {
    const instanceCount = ellipses.length / ELLIPSE_STRIDE;
    const storage: Float32Array<ArrayBuffer> = new Float32Array(ellipses);
    return {
      wgsl: ELLIPSE_WGSL,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount,
      uniforms,
      storage,
    };
  }
  // Butterfly triangle-LIST draw: pre-tessellated SVG triangles with the
  // Voronoi wing shader.  4× MSAA anti-aliases the flattened SVG edges.
  function butterflyDraw(verts: number[]): GpuDraw {
    const storage: Float32Array<ArrayBuffer> = new Float32Array(verts);
    return {
      wgsl: BUTTERFLY_WGSL,
      topology: "triangle-list",
      vertexCount: verts.length / BUTTERFLY_STRIDE,
      uniforms,
      storage,
    };
  }

  // Procedural sky: one full-banner quad, no storage buffer — the fragment
  // shader generates the gradient and clouds from uv + uniforms alone.
  function skyDraw(): GpuDraw {
    return {
      wgsl: SKY_WGSL,
      topology: "triangle-strip",
      vertexCount: 4,
      uniforms,
    };
  }

  // Each hill's flower set draws AFTER its own tufts but BEFORE the next
  // hill, so a hill in front correctly occludes flowers behind it.  The
  // layer's butterflies draw last within the set — above its flowers but still
  // occluded by any nearer hill.
  function flowerDraws(index: number): GpuDraw[] {
    const sink = flowerSinks[index];
    return [
      bladeDraw(sink.stems),
      ellipseDraw(sink.petals),
      ellipseDraw(sink.centers),
      butterflyDraw(butterflySinks[index]),
    ];
  }
  const draws: GpuDraw[] = [
    skyDraw(),
    meshDraw(buildHillMesh(backHill)),
    bladeDraw(backTuftBlades),
    ...flowerDraws(0),
    meshDraw(buildHillMesh(midHill)),
    bladeDraw(midTuftBlades),
    ...flowerDraws(1),
    meshDraw(buildHillMesh(frontHill)),
    bladeDraw(frontTuftBlades),
    ...flowerDraws(2),
  ].filter((d) => d.vertexCount > 0 && (d.instanceCount ?? 1) > 0);

  const canvas = await renderMultiDrawToCanvas({
    width: W,
    height: H,
    draws,
  });
  // PNG (lossless) — JPEG block-ringing showed up around the thin
  // high-contrast blade edges.  Render cost goes up but the result is
  // artifact-free.
  embedCanvasAsImage(layers.rasters, canvas, x, y, w, h);
}

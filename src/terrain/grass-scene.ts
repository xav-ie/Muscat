import { LINE_W, layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { jitterColor, mixColors } from "../util/color.js";
import { embedCanvasAsImage } from "../util/canvas-layer.js";
import { renderMultiDrawToCanvas, type GpuDraw } from "../util/webgpu.js";

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
type CrestFunction = (px: number) => number;

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
// triangles.  Higher = smoother curves at small vertex cost.  At 8 px/mm
// a 5 mm blade is ~40 px tall, so 16 segments keeps each step ≲ 2.5 px —
// below the 4× MSAA edge precision.
const BLADE_SEGMENTS = 16;
const BLADE_VERTS = (BLADE_SEGMENTS + 1) * 2;

// How strongly grass blades lean to match the local hill slope.  0 = all
// blades straight up.  1 = perfectly perpendicular to the hill surface.
// Slight bias reads as "grass following the ground" without looking
// blown-over.
const SLOPE_BIAS = 0.3;

// ─── WGSL SHADERS ────────────────────────────────────────────────────
// All three shaders share the same Uniforms struct (banner origin + size in
// mm) and use the same `mmToNdc` mapping to translate scene-space mm
// coordinates into normalized device coordinates.

const SHARED_UNIFORM_DECL = /* wgsl */ `
struct Uniforms {
  bannerOrigin: vec2<f32>,
  bannerSize: vec2<f32>,
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

// Same crest-y helpers as the prior CPU implementation.
function crestYFunction(crest: Point[]): CrestFunction {
  return (px: number) => crestYAt(crest, px);
}
function asCrestFunction(value: number | CrestFunction): CrestFunction {
  return typeof value === "function" ? value : () => value;
}
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
  const BACKDROP = "#143008";
  const LEAF_DARK = "#1f3e10";
  const LEAF_LIGHT = "#2e5818";
  const STEM_COLOR = "#2a5e1a";

  const flowerHues: FlowerHue[] = [
    { petal: hexToRgb01("#e94f8a"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#f0f0f0"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#f4d65a"), center: hexToRgb01("#c08a1a") },
    { petal: hexToRgb01("#b075d6"), center: hexToRgb01("#f4d65a") },
    { petal: hexToRgb01("#ee8c45"), center: hexToRgb01("#7a2e0c") },
  ];

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

  // ─── Mesh tessellation (hills + backdrop) ────────────────────────
  // Backdrop: 4-vertex triangle-strip quad covering the banner.
  function buildBackdropMesh(): Float32Array<ArrayBuffer> {
    const c = hexToRgb01(BACKDROP);
    const data: number[] = [];
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ]) {
      data.push(px, py, c[0], c[1], c[2]);
    }
    return new Float32Array(data);
  }
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
  // Leaves all sit in the canopy band behind the back hill.
  const leafEllipses: number[] = [];
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
      const halfBase = 0.28 * scale;
      const ctrl1X = bx - halfBase + (tipX - (bx - halfBase)) * 0.4;
      const ctrl1Y = by + (tipY - by) * 0.5;
      const ctrl2X = bx + halfBase + (tipX - (bx + halfBase)) * 0.4;
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

  // ─── Leaf scatter — same RNG order as before ─────────────────────
  function plantLeavesInBand(
    topYArgument: number | CrestFunction,
    botYArgument: number | CrestFunction,
    darkColor: string,
    lightColor: string,
    leafCount: number,
    target: number[],
  ): void {
    const edgeBleed = 4;
    const xMin = x - edgeBleed,
      xMax = x + w + edgeBleed;
    const topYFunction = asCrestFunction(topYArgument);
    const botYFunction = asCrestFunction(botYArgument);
    for (let index = 0; index < leafCount; index++) {
      const lx = xMin + rng() * (xMax - xMin);
      const xClamp = Math.max(x, Math.min(x + w, lx));
      const topY = topYFunction(xClamp);
      const botY = botYFunction(xClamp);
      if (botY <= topY) continue;
      const ly = topY + rng() * (botY - topY);
      const depthT = (ly - topY) / Math.max(0.001, botY - topY);
      const sizeScale = 0.6 + depthT * 0.6 + rng() * 0.4;
      const rx = 0.85 * sizeScale * (0.9 + rng() * 0.2);
      const ry = 0.4 * sizeScale * (0.9 + rng() * 0.2);
      const angleDegrees = rng() * 360;
      const baseHex = rng() < 0.7 ? darkColor : lightColor;
      const colorHex = jitterColor(baseHex, 1.2);
      pushEllipse(target, lx, ly, rx, ry, (angleDegrees * Math.PI) / 180, hexToRgb01(colorHex));
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

  // ─── Generate primitives — preserves prior RNG consumption order ─
  // Order MUST match the CPU implementation:
  //   1. plantLeavesInBand (backdrop band)
  //   2. plantTufts back
  //   3. plantTufts mid
  //   4. plantTufts front
  //   5. flowers
  plantLeavesInBand(y, crestYFunction(backHill.pts), LEAF_DARK, LEAF_LIGHT, 6500, leafEllipses);
  plantTufts(backHill.pts, midHill.pts, 10_000, BLADE_BACK, HILL_BACK, 0.4, 0.6, backTuftBlades);
  plantTufts(midHill.pts, frontHill.pts, 8000, BLADE_MID, HILL_MID, 0.6, 0.85, midTuftBlades);
  plantTufts(frontHill.pts, undefined, 8000, BLADE_FRONT, HILL_FRONT, 0.85, 1.2, frontTuftBlades);

  // Flowers scattered across all three hills.  Each flower picks a hill
  // Each layer pairs a hill (whose surface holds flowers) with the hill
  // immediately in front (which bounds the visible band, since anything
  // below it on this hill is hidden).  The front hill has no occluder so
  // its band extends down to the banner bottom.  Per-layer style adds
  // atmospheric perspective: deeper hills get smaller and darker flowers.
  const flowerLayers = [
    { hill: backHill, occluder: midHill, sizeScale: 0.5, darken: 0.5 },
    { hill: midHill, occluder: frontHill, sizeScale: 0.75, darken: 0.75 },
    { hill: frontHill, occluder: undefined, sizeScale: 1, darken: 1 },
  ] as const;
  const flowerCount = 36;
  const margin = 2;
  // Rejection sampling — placed flower heads can't overlap.  Each flower's
  // visible footprint is roughly `ringR + petalRy` (~1.9 * sizeScale); 3 *
  // sizeScale spaces them out more (1.5× the previous separation).
  const placed: PlacedFlower[] = [];
  const maxAttempts = flowerCount * 50;
  let attempts = 0;
  while (placed.length < flowerCount && attempts < maxAttempts) {
    attempts++;
    const layerIndex = Math.floor(rng() * flowerLayers.length);
    const layer = flowerLayers[layerIndex];
    const gx = x + margin + 3 + rng() * (w - 2 * (margin + 3));
    // Scatter the base anywhere in the visible band [thisCrest, nextCrest].
    // Without this, flowers all line up along the upper ridge of each hill.
    const bandTop = crestYAt(layer.hill.pts, gx);
    const bandBottom = layer.occluder ? crestYAt(layer.occluder.pts, gx) : y + h;
    if (bandBottom <= bandTop) continue;
    const gy = bandTop + rng() * (bandBottom - bandTop);
    const stemH = (2.5 + rng() * 2) * layer.sizeScale;
    const headX = gx + (rng() - 0.5) * 0.6 * layer.sizeScale;
    const headY = gy - stemH;
    const radius = 3 * layer.sizeScale;
    if (flowerOverlap(placed, headX, headY, radius)) continue;
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
  }

  // ─── Pack uniforms and dispatch draws ────────────────────────────
  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));
  // Shared uniform buffer: vec2 bannerOrigin + vec2 bannerSize = 16 bytes.
  // Float32Array<ArrayBuffer> (concrete) is needed so its `.buffer` narrows
  // to `ArrayBuffer` rather than the default `ArrayBufferLike` (which
  // would include `SharedArrayBuffer`).
  const uniforms: Float32Array<ArrayBuffer> = new Float32Array([x, y, w, h]);

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

  // Each hill's flower set draws AFTER its own tufts but BEFORE the next
  // hill, so a hill in front correctly occludes flowers behind it.
  function flowerDraws(index: number): GpuDraw[] {
    const sink = flowerSinks[index];
    return [bladeDraw(sink.stems), ellipseDraw(sink.petals), ellipseDraw(sink.centers)];
  }
  const draws: GpuDraw[] = [
    meshDraw(buildBackdropMesh()),
    ellipseDraw(leafEllipses),
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

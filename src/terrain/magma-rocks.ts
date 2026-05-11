import { layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { embedCanvasAsImage } from "../util/canvas-layer.js";
import { renderFragmentToCanvas } from "../util/webgpu.js";
import { freshSineWarpPhases } from "../util/sine-warp.js";

// Render resolution.  8 px/mm is a sweet spot: matches Retina display
// density (~2× supersampled there), keeps the encoded image compact, and
// the GPU work is sub-ms regardless.  The encoding step (toDataURL) scales
// linearly with pixel count, so going higher here costs encoding time.
const PX_PER_MM = 8;

// WGSL port of the Voronoi rock + lava field.  The JS reference (and the
// inline comments below) lived in this file before the GPU port; see git
// history (`641a56c` and earlier) for the original `precomputeFieldArray`
// and `shadePixel` implementations.  The shader recomputes the field at
// each of the 5 sample points (center + 4 neighbors for normal-map
// gradient) on the fly — extra work per pixel, but GPU runs every pixel
// in parallel so the total is still ~10x faster than the CPU two-pass.
//
// Uniform layout (matches std140-style WGSL uniform alignment):
//   offset 0  vec2 size           (W, H in pixels)
//   offset 8  f32  cellDensity
//   offset 12 f32  thickness
//   offset 16 f32  thicknessFalloff
//   offset 20 f32  heightStrength
//   offset 24 f32  flowStrength
//   offset 28 f32  cragginess
//   offset 32 f32  wobble
//   offset 36 f32  angleOffset
//   offset 48 vec4 flowPhases       (ph1x, ph1y, ph2x, ph2y)
//   offset 64 vec4[2] craggyPhases  (8 floats packed as 2 vec4)
//   offset 96 vec4[2] wobblePhases  (8 floats packed as 2 vec4)
//   total 128 bytes
const MAGMA_WGSL = /* wgsl */ `
struct Uniforms {
  size: vec2<f32>,
  cellDensity: f32,
  thickness: f32,
  thicknessFalloff: f32,
  heightStrength: f32,
  flowStrength: f32,
  cragginess: f32,
  wobble: f32,
  angleOffset: f32,
  flowPhases: vec4<f32>,
  craggyPhases: array<vec4<f32>, 2>,
  wobblePhases: array<vec4<f32>, 2>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  // Three vertices covering the full viewport (no vertex buffer required).
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(positions[idx], 0.0, 1.0);
}

// Quilez's hash → deterministic [0,1] vector per cell coordinate.
fn randomVector(cellX: f32, cellY: f32, ang: f32) -> vec2<f32> {
  var ux = cellX * 15.27 + cellY * 99.41;
  var uy = cellX * 47.63 + cellY * 89.98;
  ux = sin(ux) * 46839.32;
  uy = sin(uy) * 46839.32;
  ux = ux - floor(ux);
  uy = uy - floor(uy);
  return vec2<f32>(sin(uy * ang) * 0.5 + 0.5, cos(ux * ang) * 0.5 + 0.5);
}

struct Field { dCenter: f32, dEdge: f32 }

fn voronoiField(uvX: f32, uvY: f32) -> Field {
  let sX = uvX * u.cellDensity;
  let sY = uvY * u.cellDensity;
  let cellX = floor(sX);
  let cellY = floor(sY);
  let posX = sX - cellX;
  let posY = sY - cellY;

  // Find closest seed in the 3x3 neighborhood.
  var dCenterSq = 8.0;
  var coX = 0.0;
  var coY = 0.0;
  for (var yy: i32 = -1; yy <= 1; yy = yy + 1) {
    for (var xx: i32 = -1; xx <= 1; xx = xx + 1) {
      let rv = randomVector(cellX + f32(xx), cellY + f32(yy), u.angleOffset);
      let cox = f32(xx) - posX + rv.x;
      let coy = f32(yy) - posY + rv.y;
      let d = cox * cox + coy * coy;
      if (d < dCenterSq) {
        dCenterSq = d;
        coX = cox;
        coY = coy;
      }
    }
  }
  let dCenter = sqrt(dCenterSq);

  // Hard-min bisector distance (sharp polygon vertices).
  var dEdge = 8.0;
  for (var yy: i32 = -1; yy <= 1; yy = yy + 1) {
    for (var xx: i32 = -1; xx <= 1; xx = xx + 1) {
      let rv = randomVector(cellX + f32(xx), cellY + f32(yy), u.angleOffset);
      let cox = f32(xx) - posX + rv.x;
      let coy = f32(yy) - posY + rv.y;
      let dx = cox - coX;
      let dy = coy - coY;
      let dlen = sqrt(dx * dx + dy * dy);
      if (dlen >= 1e-6) {
        let nx = dx / dlen;
        let ny = dy / dlen;
        let midX = 0.5 * (coX + cox);
        let midY = 0.5 * (coY + coy);
        let d = midX * nx + midY * ny;
        if (d < dEdge) { dEdge = d; }
      }
    }
  }
  return Field(dCenter, dEdge);
}

// Two-octave sine warp matching util/sine-warp.ts.
fn flowUV(uvX: f32, uvY: f32) -> vec2<f32> {
  let amp = u.flowStrength;
  let A2 = amp * 0.33;
  let p = u.flowPhases;
  let wx = sin(uvX * 8.0 + uvY * 6.0 + p.x) * amp
         + sin(uvX * 21.0 - uvY * 11.0 + p.z) * A2;
  let wy = sin(uvY * 8.0 + uvX * 6.0 + p.y) * amp
         + sin(uvY * 21.0 - uvX * 11.0 + p.w) * A2;
  return vec2<f32>(uvX + wx, uvY + wy);
}

// 3-octave sin·cos noise — high frequency, perturbs the edge value to give
// ragged cell boundaries.
fn craggyNoise(uvX: f32, uvY: f32) -> f32 {
  let f1 = 14.0;
  let p0 = u.craggyPhases[0];
  let p1 = u.craggyPhases[1];
  let n = sin(uvX * f1 + p0.x) * cos(uvY * f1 + p0.y)
        + sin(uvX * f1 * 2.1 + p0.z) * cos(uvY * f1 * 2.1 + p0.w) * 0.5
        + sin(uvX * f1 * 4.3 + p1.x) * cos(uvY * f1 * 4.3 + p1.y) * 0.25;
  return n / 1.75;
}

// 2-octave medium-frequency noise — gives each edge visible wavy bumps.
fn wobbleNoise(uvX: f32, uvY: f32) -> f32 {
  let wf = u.cellDensity * 6.0;
  let p0 = u.wobblePhases[0];
  let n = sin(uvX * wf + p0.x) * cos(uvY * wf + p0.y)
        + sin(uvX * wf * 2.0 + p0.z) * cos(uvY * wf * 2.0 + p0.w) * 0.5;
  return n / 1.5;
}

fn heightFn(rawH: f32) -> f32 {
  if (rawH <= 0.0) { return 0.0; }
  return pow(rawH, 1.5);
}

// Single-pixel dEdge sample with the flow warp + craggy/wobble perturbations.
fn dEdgeAt(uvX0: f32, uvY0: f32) -> f32 {
  let p = flowUV(uvX0, uvY0);
  let f = voronoiField(p.x, p.y);
  return f.dEdge
       + craggyNoise(uvX0, uvY0) * u.cragginess
       + wobbleNoise(uvX0, uvY0) * u.wobble;
}

fn rockColor(h: f32) -> vec3<f32> {
  let HI = vec3<f32>(106.0, 94.0, 82.0) / 255.0;
  let MD = vec3<f32>(53.0, 44.0, 36.0) / 255.0;
  let LO = vec3<f32>(16.0, 9.0, 6.0) / 255.0;
  if (h < 0.5) { return mix(LO, MD, h * 2.0); }
  return mix(MD, HI, (h - 0.5) * 2.0);
}

fn lavaColor(c: f32) -> vec3<f32> {
  let DEEP = vec3<f32>(165.0, 42.0, 8.0) / 255.0;
  let MID  = vec3<f32>(232.0, 82.0, 31.0) / 255.0;
  let HOT  = vec3<f32>(252.0, 185.0, 106.0) / 255.0;
  if (c < 0.4) { return mix(HOT, MID, c / 0.4); }
  return mix(MID, DEEP, (c - 0.4) / 0.6);
}

@fragment
fn fs_main(@builtin(position) coord: vec4<f32>) -> @location(0) vec4<f32> {
  let W = u.size.x;
  let H = u.size.y;
  let aspect = H / W;

  // @builtin(position) is the pixel-center coordinate (e.g. 0.5, 1.5, ...).
  // Match the JS reference's integer pixel indexing for neighbor clamping.
  let px = floor(coord.x);
  let py = floor(coord.y);
  let xL = max(0.0, px - 1.0);
  let xR = min(W - 1.0, px + 1.0);
  let yT = max(0.0, py - 1.0);
  let yB = min(H - 1.0, py + 1.0);

  // UV = ((px + 0.5)/W, ((py + 0.5)/H) * aspect)
  let uvCx = (px + 0.5) / W;
  let uvCy = ((py + 0.5) / H) * aspect;
  let uvLx = (xL + 0.5) / W;
  let uvRx = (xR + 0.5) / W;
  let uvTy = ((yT + 0.5) / H) * aspect;
  let uvBy = ((yB + 0.5) / H) * aspect;

  let dE_C = dEdgeAt(uvCx, uvCy);
  let dE_L = dEdgeAt(uvLx, uvCy);
  let dE_R = dEdgeAt(uvRx, uvCy);
  let dE_T = dEdgeAt(uvCx, uvTy);
  let dE_B = dEdgeAt(uvCx, uvBy);

  let mask = smoothstep(u.thickness, u.thickness + u.thicknessFalloff, dE_C);
  let heightHere = heightFn(max(0.0, dE_C - u.thickness));

  let hL = heightFn(max(0.0, dE_L - u.thickness));
  let hR = heightFn(max(0.0, dE_R - u.thickness));
  let hT = heightFn(max(0.0, dE_T - u.thickness));
  let hB = heightFn(max(0.0, dE_B - u.thickness));
  let dzdx = (hR - hL) * u.heightStrength * u.cellDensity * 0.5;
  let dzdy = (hB - hT) * u.heightStrength * u.cellDensity * 0.5;
  let normal = normalize(vec3<f32>(-dzdx, -dzdy, 1.0));

  let lightDir = normalize(vec3<f32>(-0.55, -0.55, 0.62));
  let lambert = max(0.0, dot(normal, lightDir));
  let shading = 0.3 + 0.85 * lambert;

  let heightNorm = min(1.0, heightHere * u.heightStrength * u.cellDensity);
  let rockBase = rockColor(heightNorm);
  let lavaBase = lavaColor(min(1.0, dE_C / max(0.001, u.thickness)));

  let mixed = mix(lavaBase, rockBase * shading, mask);
  return vec4<f32>(mixed, 1.0);
}
`;

// Pack uniforms in the exact layout declared by the shader.  Each entry is
// 4 bytes; positions match the offsets in the comment above MAGMA_WGSL.
function packMagmaUniforms(
  W: number,
  H: number,
  angleOffset: number,
  flowPhases: { ph1x: number; ph1y: number; ph2x: number; ph2y: number },
  craggyPhases: number[],
  wobblePhases: number[],
): ArrayBuffer {
  const f = new Float32Array(32);
  f[0] = W;
  f[1] = H;
  f[2] = 12; // cellDensity — 12 cells per banner width
  f[3] = 0.08; // thickness
  f[4] = 0.14; // thicknessFalloff
  f[5] = 3.3; // heightStrength
  f[6] = 0.036; // flowStrength
  f[7] = 0.06; // cragginess
  f[8] = 0.06; // wobble
  f[9] = angleOffset;
  // f[10], f[11] — pad to 16-byte boundary for the following vec4
  f[12] = flowPhases.ph1x;
  f[13] = flowPhases.ph1y;
  f[14] = flowPhases.ph2x;
  f[15] = flowPhases.ph2y;
  for (let index = 0; index < 8; index++) f[16 + index] = craggyPhases[index];
  for (let index = 0; index < 8; index++) f[24 + index] = wobblePhases[index];
  return f.buffer;
}

// Lava — Voronoi `DistFromEdge` (Quilez) renders rocks rising out of glowing
// channels via normal-map shading.  All math runs in a WGSL fragment shader;
// JS only draws the per-render randomness (in the same order as the prior
// CPU implementation, so seed determinism is preserved) and packs uniforms.
export async function magmaRocks(x: number, y: number, w: number, h: number): Promise<void> {
  // RNG draws — order MUST match the prior CPU implementation so the same
  // seed produces the same scene composition.
  const angleOffset = rng() * 1000;
  const flowPhases = freshSineWarpPhases(rng);
  const craggyPhases: number[] = [];
  for (let index = 0; index < 8; index++) craggyPhases.push(rng() * Math.PI * 2);
  const wobblePhases: number[] = [];
  for (let index = 0; index < 8; index++) wobblePhases.push(rng() * Math.PI * 2);

  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));
  const uniforms = packMagmaUniforms(W, H, angleOffset, flowPhases, craggyPhases, wobblePhases);

  const canvas = await renderFragmentToCanvas({
    width: W,
    height: H,
    wgsl: MAGMA_WGSL,
    uniforms,
  });

  embedCanvasAsImage(layers.shapes, canvas, x, y, w, h, {
    mime: "image/jpeg",
    quality: 0.92,
  });
}

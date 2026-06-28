import { layers, SVG_NS, getDefs } from "../state.js";
import { uid } from "../util/uid.js";
import { random as rng } from "../util/rng.js";
import { poissonDisk } from "../util/poisson.js";
import { embedCanvasAsImage } from "../util/canvas-layer.js";
import { renderFragmentToCanvas } from "../util/webgpu.js";
import { freshSineWarpPhases } from "../util/sine-warp.js";

type RGB = [number, number, number];
interface LayerCfg {
  count: number;
  smoothFrac: number;
  thrLo: number;
  thrHi: number;
  warp: number;
  color: RGB;
}

const PX_PER_MM = 8;

// Shark silhouette — single path in an
// 833×362 viewBox.  Rendered as a dark-blue silhouette lurking near the
// bottom-left of the water tile.
const SHARK_VIEW_W = 833;
const SHARK_VIEW_H = 362;
const SHARK_PATH =
  "M830.386 266.561C815.886 290.561 729.886 292.561 673.886 260.061C659.593 251.765 633.735 242.753 601.793 234.23C592.819 303.681 530.804 367.544 498.386 361.061C465.754 354.534 539.175 292.808 532.642 218.432C472.038 206.554 404.95 198.005 354.383 197.849C340.548 207.652 325.847 215.518 317.068 199.707C311.947 200.326 307.203 201.107 302.886 202.061C221.386 220.061 43.018 148.316 8.3863 52.0607C-25.6138 -42.4393 41.8863 168.561 245.386 150.561C362.503 140.202 403.106 124.046 447.165 112.197C437.526 91.2791 395.314 83.9577 416.886 81.5607C438.797 79.1262 464.337 77.6593 497.207 101.896C516.621 99.2302 539.769 97.502 569.997 97.1343C610.838 22.0056 583.421 -1.36353 602.886 0.0607392C621.755 1.44136 654.601 50.6866 642.556 106.08C767.761 137.92 845.554 241.456 830.386 266.561Z";

// Place the shark silhouette near the bottom-left of the water tile.  Drawn
// on top of the caustics image with multiply blend at 50% opacity so it
// darkens the water beneath it as a soft silhouette.
function emitShark(x: number, y: number, w: number, h: number): void {
  const sharkW = w * 0.28; // tile-relative width
  const scale = sharkW / SHARK_VIEW_W;
  const sharkH = SHARK_VIEW_H * scale;
  const tx = x + w * 0.05; // left padding
  const ty = y + h - sharkH - h * 0.1; // bottom padding

  // Soft-edge blur filter.  stdDeviation is in the shark's local viewBox
  // units, so it scales down with the shark and stays a consistent ~edge
  // softness regardless of tile size.  Region is buffered so the blur isn't
  // clipped at the filter bounds.
  const filterId = uid("shark-blur");
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", filterId);
  filter.setAttribute("x", "-20%");
  filter.setAttribute("y", "-20%");
  filter.setAttribute("width", "140%");
  filter.setAttribute("height", "140%");
  const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "8");
  filter.append(blur);
  getDefs().append(filter);

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `translate(${String(tx)} ${String(ty)}) scale(${String(scale)})`);
  g.setAttribute("style", "mix-blend-mode: multiply");
  g.setAttribute("opacity", "0.5");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", SHARK_PATH);
  p.setAttribute("fill", "#23406b");
  p.setAttribute("filter", `url(#${filterId})`);
  g.append(p);
  layers.rasters.append(g);
}

// WGSL port of the two-layer Voronoi-edge caustic.  JS pre-computes seed
// points (Poisson-disk sampled with the seeded RNG so the layout stays
// deterministic per seed) and packs them into a storage buffer; the shader
// reads them per-pixel.  Compared to the previous CPU implementation:
//   * Bucket grid optimization is gone — the GPU can afford to brute-force
//     all 75 seeds per pixel.  Removes a lot of branchy code.
//   * Sharp F1 (`d1`) and smooth F1 (`d2`, via log-sum-exp) are computed in
//     the same loop, since both need the per-seed distance.
const WATER_WGSL = /* wgsl */ `
struct Uniforms {
  size: vec2<f32>,
  pad0: vec2<f32>,
  warpPhases: vec4<f32>,
  waterColor: vec4<f32>,
  blueColor: vec4<f32>,
  middleColor: vec4<f32>,
  whiteColor: vec4<f32>,
  blueSmoothness: f32,
  blueThrLo: f32,
  blueThrHi: f32,
  blueWarp: f32,
  middleSmoothness: f32,
  middleThrLo: f32,
  middleThrHi: f32,
  middleWarp: f32,
  whiteSmoothness: f32,
  whiteThrLo: f32,
  whiteThrHi: f32,
  whiteWarp: f32,
  blueSeedStart: u32,
  blueSeedCount: u32,
  middleSeedStart: u32,
  middleSeedCount: u32,
  whiteSeedStart: u32,
  whiteSeedCount: u32,
}

@group(0) @binding(0) var<uniform> uni: Uniforms;
@group(0) @binding(1) var<storage, read> seeds: array<vec2<f32>>;

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  return vec4<f32>(positions[idx], 0.0, 1.0);
}

// Two-octave sine warp.  Mirrors util/sine-warp.ts.  Inputs (u, v) are
// normalized [0,1] across the canvas; output is also in UV space.
fn warpUVs(uvX: f32, uvY: f32, amp: f32) -> vec2<f32> {
  let A2 = amp * 0.33;
  let p = uni.warpPhases;
  let wx = sin(uvX * 8.0 + uvY * 6.0 + p.x) * amp
         + sin(uvX * 21.0 - uvY * 11.0 + p.z) * A2;
  let wy = sin(uvY * 8.0 + uvX * 6.0 + p.y) * amp
         + sin(uvY * 21.0 - uvX * 11.0 + p.w) * A2;
  return vec2<f32>(uvX + wx, uvY + wy);
}

// Compute the threshold-mask m (0..1) at warped pixel-space position
// (wx, wy) for one layer.  d1 = min distance to any seed (sharp Voronoi);
// d2 = soft-min via log-sum-exp; edge = (d1 - d2) / smoothness gives a
// thin rim wherever cells meet.
fn fieldMask(
  wx: f32, wy: f32,
  seedStart: u32, seedCount: u32,
  smoothness: f32, thrLo: f32, thrHi: f32,
) -> f32 {
  var d1 = 1e9;
  var sumExp = 0.0;
  for (var i: u32 = 0u; i < seedCount; i = i + 1u) {
    let s = seeds[seedStart + i];
    let dx = wx - s.x;
    let dy = wy - s.y;
    let d = sqrt(dx * dx + dy * dy);
    if (d < d1) { d1 = d; }
    sumExp = sumExp + exp(-d / smoothness);
  }
  let d2 = -smoothness * log(sumExp);
  let edge = (d1 - d2) / smoothness;
  let m = clamp((edge - thrLo) / (thrHi - thrLo), 0.0, 1.0);
  return m * m * (3.0 - 2.0 * m);
}

@fragment
fn fs_main(@builtin(position) coord: vec4<f32>) -> @location(0) vec4<f32> {
  let W = uni.size.x;
  let H = uni.size.y;
  // Match the JS reference: warp UV-space coords, then scale back to
  // pixel-space for the seed distance lookup.
  let uvX = coord.x / W;
  let uvY = coord.y / H;

  let bWarp = warpUVs(uvX, uvY, uni.blueWarp);
  let mWarp = warpUVs(uvX, uvY, uni.middleWarp);
  let wWarp = warpUVs(uvX, uvY, uni.whiteWarp);
  let blueP = vec2<f32>(bWarp.x * W, bWarp.y * H);
  let middleP = vec2<f32>(mWarp.x * W, mWarp.y * H);
  let whiteP = vec2<f32>(wWarp.x * W, wWarp.y * H);

  let mBlue = fieldMask(
    blueP.x, blueP.y,
    uni.blueSeedStart, uni.blueSeedCount,
    uni.blueSmoothness, uni.blueThrLo, uni.blueThrHi,
  );
  let mMiddle = fieldMask(
    middleP.x, middleP.y,
    uni.middleSeedStart, uni.middleSeedCount,
    uni.middleSmoothness, uni.middleThrLo, uni.middleThrHi,
  );
  let mWhite = fieldMask(
    whiteP.x, whiteP.y,
    uni.whiteSeedStart, uni.whiteSeedCount,
    uni.whiteSmoothness, uni.whiteThrLo, uni.whiteThrHi,
  );

  // Layer composition: water → blue (50%) → middle (20%) → white (95%).
  var c = mix(uni.waterColor.rgb, uni.blueColor.rgb, mBlue * 0.5);
  c = mix(c, uni.middleColor.rgb, mMiddle * 0.2);
  c = mix(c, uni.whiteColor.rgb, mWhite * 0.95);
  return vec4<f32>(c, 1.0);
}
`;

// Pack uniforms into a 176-byte buffer (168 bytes used, rounded up for the
// 16-byte struct alignment WGSL requires).  Scalar tail block uses
// Float32Array AND Uint32Array views over the same ArrayBuffer because
// seed-start/count fields are u32 in WGSL.
function packWaterUniforms(
  W: number,
  H: number,
  warpPhases: { ph1x: number; ph1y: number; ph2x: number; ph2y: number },
  blueCfg: LayerCfg,
  middleCfg: LayerCfg,
  whiteCfg: LayerCfg,
  blueSmoothness: number,
  middleSmoothness: number,
  whiteSmoothness: number,
  blueSeedStart: number,
  blueSeedCount: number,
  middleSeedStart: number,
  middleSeedCount: number,
  whiteSeedStart: number,
  whiteSeedCount: number,
  waterColor: RGB,
): ArrayBuffer {
  const buf = new ArrayBuffer(176);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  f[0] = W;
  f[1] = H;
  // f[2], f[3] — pad to vec4 alignment for warpPhases
  f[4] = warpPhases.ph1x;
  f[5] = warpPhases.ph1y;
  f[6] = warpPhases.ph2x;
  f[7] = warpPhases.ph2y;
  // waterColor (vec4, alpha unused but kept 1 for clarity)
  f[8] = waterColor[0] / 255;
  f[9] = waterColor[1] / 255;
  f[10] = waterColor[2] / 255;
  f[11] = 1;
  // blueColor
  f[12] = blueCfg.color[0] / 255;
  f[13] = blueCfg.color[1] / 255;
  f[14] = blueCfg.color[2] / 255;
  f[15] = 1;
  // middleColor
  f[16] = middleCfg.color[0] / 255;
  f[17] = middleCfg.color[1] / 255;
  f[18] = middleCfg.color[2] / 255;
  f[19] = 1;
  // whiteColor
  f[20] = whiteCfg.color[0] / 255;
  f[21] = whiteCfg.color[1] / 255;
  f[22] = whiteCfg.color[2] / 255;
  f[23] = 1;
  // Scalar tail
  f[24] = blueSmoothness;
  f[25] = blueCfg.thrLo;
  f[26] = blueCfg.thrHi;
  f[27] = blueCfg.warp;
  f[28] = middleSmoothness;
  f[29] = middleCfg.thrLo;
  f[30] = middleCfg.thrHi;
  f[31] = middleCfg.warp;
  f[32] = whiteSmoothness;
  f[33] = whiteCfg.thrLo;
  f[34] = whiteCfg.thrHi;
  f[35] = whiteCfg.warp;
  u[36] = blueSeedStart;
  u[37] = blueSeedCount;
  u[38] = middleSeedStart;
  u[39] = middleSeedCount;
  u[40] = whiteSeedStart;
  u[41] = whiteSeedCount;
  return buf;
}

// Water caustics — "sharp F1 minus smooth F1" Voronoi technique, two
// layers (dark-blue rim under, white crisp ridge over).  All per-pixel
// math now runs in a WGSL fragment shader; JS only generates the seed
// points (with the seeded RNG, for determinism) and warp phases.
export async function waterCaustics(x: number, y: number, w: number, h: number): Promise<void> {
  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));

  const blueCfg: LayerCfg = {
    count: 50,
    smoothFrac: 0.2,
    thrLo: 0.1,
    thrHi: 1.18,
    warp: 0.018,
    color: [0x0a, 0x3a, 0x6b],
  };
  const whiteCfg: LayerCfg = {
    count: 25,
    smoothFrac: 0.22,
    thrLo: 0.42,
    thrHi: 1.18,
    warp: 0.01,
    color: [0xff, 0xff, 0xff],
  };
  // Middle layer reuses the white config (new seeds via continued RNG).
  const middleCfg: LayerCfg = { ...whiteCfg };

  function generateSeeds(cfg: LayerCfg): { seeds: [number, number][]; smoothness: number } {
    const cellSpacing = Math.sqrt((W * H) / cfg.count);
    const minDistribution = cellSpacing * 0.55;
    const seeds = poissonDisk(0, 0, W, H, minDistribution, cfg.count, rng, 80);
    return { seeds, smoothness: cellSpacing * cfg.smoothFrac };
  }
  const blue = generateSeeds(blueCfg);
  const middle = generateSeeds(middleCfg);
  const white = generateSeeds(whiteCfg);

  const warpPhases = freshSineWarpPhases(rng);

  // Pack seeds into a single storage buffer: [blue | middle | white].
  // Each seed is two f32s (8 bytes); the storage array reads as
  // array<vec2<f32>> with stride 8.
  const allSeeds = [...blue.seeds, ...middle.seeds, ...white.seeds];
  const seedBuf = new Float32Array(allSeeds.length * 2);
  for (const [index, [sx, sy]] of allSeeds.entries()) {
    seedBuf[index * 2] = sx;
    seedBuf[index * 2 + 1] = sy;
  }

  const uniforms = packWaterUniforms(
    W,
    H,
    warpPhases,
    blueCfg,
    middleCfg,
    whiteCfg,
    blue.smoothness,
    middle.smoothness,
    white.smoothness,
    0,
    blue.seeds.length,
    blue.seeds.length,
    middle.seeds.length,
    blue.seeds.length + middle.seeds.length,
    white.seeds.length,
    [0x3a, 0x91, 0xc2], // base water blue
  );

  const canvas = await renderFragmentToCanvas({
    width: W,
    height: H,
    wgsl: WATER_WGSL,
    uniforms,
    storage: seedBuf.buffer,
  });

  embedCanvasAsImage(layers.rasters, canvas, x, y, w, h);

  // Shark silhouette on top of the caustics (multiply blend, 50% opacity).
  emitShark(x, y, w, h);
}

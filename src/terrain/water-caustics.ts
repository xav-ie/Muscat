import { layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { poissonDisk } from "../util/poisson.js";
import { createPxCanvas, embedCanvasAsImage } from "../util/canvas-layer.js";
import { freshSineWarpPhases, sineWarpOffsets } from "../util/sine-warp.js";

type RGB = [number, number, number];
interface LayerCfg {
  count: number;
  smoothFrac: number;
  thrLo: number;
  thrHi: number;
  warp: number;
  color: RGB;
}
interface Field {
  seeds: [number, number][];
  grid: [number, number][][];
  gridCols: number;
  gridRows: number;
  bucketSize: number;
  smoothness: number;
  thrLo: number;
  thrHi: number;
  color: RGB;
  warp: number;
}

// Visit every seed in the 5×5 bucket neighborhood around (gx, gy). The
// bounds are clamped to the grid so the inner loops have no per-iteration
// boundary check.
function sweepBuckets(
  field: Field,
  gx: number,
  gy: number,
  visit: (sx: number, sy: number) => void,
): void {
  const y0 = Math.max(0, gy - 2);
  const y1 = Math.min(field.gridRows - 1, gy + 2);
  const x0 = Math.max(0, gx - 2);
  const x1 = Math.min(field.gridCols - 1, gx + 2);
  for (let ggy = y0; ggy <= y1; ggy++) {
    for (let ggx = x0; ggx <= x1; ggx++) {
      for (const [sx, sy] of field.grid[ggy * field.gridCols + ggx]) visit(sx, sy);
    }
  }
}

// Compute the threshold-mask `m` (0..1) for one field at a sample point.
function fieldMask(field: Field, wux: number, wuy: number): number {
  let d1 = Infinity;
  let sumExp = 0;
  const accumulate = (sx: number, sy: number): void => {
    const d = Math.hypot(wux - sx, wuy - sy);
    if (d < d1) d1 = d;
    sumExp += Math.exp(-d / field.smoothness);
  };
  const gx = Math.min(field.gridCols - 1, Math.max(0, Math.floor(wux / field.bucketSize)));
  const gy = Math.min(field.gridRows - 1, Math.max(0, Math.floor(wuy / field.bucketSize)));
  sweepBuckets(field, gx, gy, accumulate);
  if (sumExp <= 0) for (const [sx, sy] of field.seeds) accumulate(sx, sy);
  const d2 = -field.smoothness * Math.log(sumExp);
  const edge = (d1 - d2) / field.smoothness;
  const m = Math.max(0, Math.min(1, (edge - field.thrLo) / (field.thrHi - field.thrLo)));
  return m * m * (3 - 2 * m);
}

// Water caustics — implements the "sharp F1 minus smooth F1" Voronoi trick
// from the shader-graph technique:
//   1. Distort UV with a couple sine octaves (stand-in for Musgrave fBM)
//   2. Sharp Voronoi F1 distance field (`d1`)
//   3. Smooth Voronoi F1 distance field (`d2`) using log-sum-exp soft-min
//   4. Edge = d1 - d2  →  bright thin rim wherever cells border each other
//   5. Threshold + smooth-step → crisp caustic line mask
//   6. Mix bright caustic color over water blue using the mask
//
// Rasterized to a hidden <canvas>, then embedded as an SVG <image> so the
// per-pixel math runs once at render time and the result composites with
// the rest of the SVG.
export function waterCaustics(x: number, y: number, w: number, h: number): void {
  // Render resolution — 4 px / mm.  Higher = sharper caustics, but more
  // work.  Banner ~285x35mm → ~1140x140px = 160k pixels.
  const { canvas, context, img, data, W, H } = createPxCanvas(w, h);

  // ── Two-layer caustics ──────────────────────────────────────────────
  // 1. UNDER (dark blue): wider, softer, deeper-blue rim.
  // 2. OVER  (bright white): tight, crisp white ridge.
  // Both layers' parameters are baked in (chosen via prior tuning).  Each
  // layer has its own warp strength so they distort independently.
  const layerCfg: { blue: LayerCfg; white: LayerCfg } = {
    blue: {
      count: 50,
      smoothFrac: 0.2,
      thrLo: 0.1,
      thrHi: 1.18,
      warp: 0.018,
      color: [0x0a, 0x3a, 0x6b], // dark blue (matches WINDOW_OUTLINE)
    },
    white: {
      count: 25,
      smoothFrac: 0.22,
      thrLo: 0.42,
      thrHi: 1.18,
      warp: 0.01,
      color: [0xff, 0xff, 0xff],
    },
  };

  // Build a Voronoi field (seeds + grid + smoothness) for one layer.
  function buildField(cfg: LayerCfg): Field {
    const cellSpacing = Math.sqrt((W * H) / cfg.count);
    const minDistribution = cellSpacing * 0.55;
    const seeds = poissonDisk(0, 0, W, H, minDistribution, cfg.count, rng, 80);
    const bucketSize = cellSpacing;
    const gridCols = Math.ceil(W / bucketSize) + 1;
    const gridRows = Math.ceil(H / bucketSize) + 1;
    const grid: [number, number][][] = Array.from({ length: gridCols * gridRows }, () => []);
    for (const s of seeds) {
      const gx = Math.min(gridCols - 1, Math.floor(s[0] / bucketSize));
      const gy = Math.min(gridRows - 1, Math.floor(s[1] / bucketSize));
      grid[gy * gridCols + gx].push(s);
    }
    return {
      seeds,
      grid,
      gridCols,
      gridRows,
      bucketSize,
      smoothness: cellSpacing * cfg.smoothFrac,
      thrLo: cfg.thrLo,
      thrHi: cfg.thrHi,
      color: cfg.color,
      warp: cfg.warp,
    };
  }
  const fieldBlue = buildField(layerCfg.blue);
  const fieldWhite = buildField(layerCfg.white);

  // UV warp parameters — shared sine phases (so both layers warp from the
  // same noise field) but each layer chooses its OWN amplitude.
  const warpPhases = freshSineWarpPhases(rng);
  function warpUV(px: number, py: number, amp: number): [number, number] {
    const [wx, wy] = sineWarpOffsets(px / W, py / H, amp, warpPhases);
    return [px + wx * W, py + wy * H];
  }

  // Caustic look parameters
  const WATER_R = 0x3a,
    WATER_G = 0x91,
    WATER_B = 0xc2; // base water blue

  // Per-pixel main loop — composite blue UNDER white.  Each layer warps
  // its UV with its own amplitude so the sliders only affect the blue.
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const cx = px + 0.5,
        cy = py + 0.5;
      const [bux, buy] = warpUV(cx, cy, fieldBlue.warp);
      const [wux, wuy] = warpUV(cx, cy, fieldWhite.warp);
      const mBlue = fieldMask(fieldBlue, bux, buy);
      const mWhite = fieldMask(fieldWhite, wux, wuy);

      // Layer 1: water → dark blue using mBlue
      let r = WATER_R + (fieldBlue.color[0] - WATER_R) * mBlue;
      let g = WATER_G + (fieldBlue.color[1] - WATER_G) * mBlue;
      let b = WATER_B + (fieldBlue.color[2] - WATER_B) * mBlue;
      // Layer 2: that → white using mWhite (so white sits on top)
      r = r + (fieldWhite.color[0] - r) * mWhite;
      g = g + (fieldWhite.color[1] - g) * mWhite;
      b = b + (fieldWhite.color[2] - b) * mWhite;

      const index = (py * W + px) * 4;
      data[index] = Math.trunc(r);
      data[index + 1] = Math.trunc(g);
      data[index + 2] = Math.trunc(b);
      data[index + 3] = 255;
    }
  }
  context.putImageData(img, 0, 0);

  // Embed the canvas as an SVG <image>.
  embedCanvasAsImage(layers.shapes, canvas, x, y, w, h);
}

import { layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { poissonDisk } from "../util/poisson.js";
import { embedCanvasAsImage, get2dContext } from "../util/canvas-layer.js";

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
  // Render resolution — 4x the banner dimensions in mm, so each mm has
  // 4 pixels.  Higher = sharper caustics, but more work.  We're in a
  // banner ~285x35mm so this is ~1140x140px = 160k pixels — fast.
  const PX_PER_MM = 4;
  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const context = get2dContext(canvas);
  const img = context.createImageData(W, H);
  const data = img.data;

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
  const ph1x = rng() * Math.PI * 2;
  const ph1y = rng() * Math.PI * 2;
  const ph2x = rng() * Math.PI * 2;
  const ph2y = rng() * Math.PI * 2;
  function warpUV(px: number, py: number, amp: number): [number, number] {
    const u = px / W,
      v = py / H;
    const A1 = amp;
    const A2 = A1 * 0.33;
    const wx = Math.sin(u * 8 + v * 6 + ph1x) * A1 + Math.sin(u * 21 - v * 11 + ph2x) * A2;
    const wy = Math.sin(v * 8 + u * 6 + ph1y) * A1 + Math.sin(v * 21 - u * 11 + ph2y) * A2;
    return [px + wx * W, py + wy * H];
  }

  // Compute the threshold-mask `m` (0..1) for one field at a sample point.
  function fieldMask(field: Field, wux: number, wuy: number): number {
    const gx = Math.min(field.gridCols - 1, Math.max(0, Math.floor(wux / field.bucketSize)));
    const gy = Math.min(field.gridRows - 1, Math.max(0, Math.floor(wuy / field.bucketSize)));
    let d1 = Infinity;
    let sumExp = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const ggy = gy + dy;
      if (ggy < 0 || ggy >= field.gridRows) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const ggx = gx + dx;
        if (ggx < 0 || ggx >= field.gridCols) continue;
        const bucket = field.grid[ggy * field.gridCols + ggx];
        for (const [sx, sy] of bucket) {
          const ddx = wux - sx,
            ddy = wuy - sy;
          const d = Math.hypot(ddx, ddy);
          if (d < d1) d1 = d;
          sumExp += Math.exp(-d / field.smoothness);
        }
      }
    }
    if (sumExp <= 0) {
      for (const [sx, sy] of field.seeds) {
        const ddx = wux - sx,
          ddy = wuy - sy;
        const d = Math.hypot(ddx, ddy);
        if (d < d1) d1 = d;
        sumExp += Math.exp(-d / field.smoothness);
      }
    }
    const d2 = -field.smoothness * Math.log(sumExp);
    const edge = (d1 - d2) / field.smoothness;
    let m = (edge - field.thrLo) / (field.thrHi - field.thrLo);
    if (m < 0) m = 0;
    else if (m > 1) m = 1;
    return m * m * (3 - 2 * m);
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

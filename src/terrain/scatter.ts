import { LINE_W, layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { poissonDisk } from "../util/poisson.js";
import { svgPath } from "../svg/primitives.js";

// ─────────────────────────────────────────────────────────────────────
// TERRAIN ORNAMENTS — small repeated decorations scattered across each
// banner.  Each function takes the banner rect and a stroke/fill color
// (typically the banner's outline color) and returns nothing — it
// directly appends shapes into shapesLayer.
// ─────────────────────────────────────────────────────────────────────

// One grass tuft: 3-5 thin curved blades fanning out from a single ground
// point.  Each blade is a quadratic bezier from base to tip.
export function grassTuft(cx: number, groundY: number, color: string): void {
  const n = 3 + Math.floor(rng() * 3); // 3-5 blades
  const baseSpread = 1.6; // mm of horizontal spread at ground
  for (let i = 0; i < n; i++) {
    // Distribute base x positions along a small horizontal arc
    const t = (i - (n - 1) / 2) / Math.max(1, n - 1);
    const bx = cx + t * baseSpread;
    const by = groundY;
    const height = 2.6 + rng() * 1.8; // 2.6-4.4mm tall
    // Tip leans outward
    const lean = t * (1.8 + rng() * 1.4);
    const tx = bx + lean;
    const ty = by - height;
    // Control point bows the blade outward
    const ctrlX = bx + lean * 0.5 + (rng() - 0.5) * 0.6;
    const ctrlY = by - height * 0.5;
    const d = `M ${bx} ${by} Q ${ctrlX} ${ctrlY} ${tx} ${ty}`;
    layers.shapes.append(
      svgPath(d, {
        fill: "none",
        stroke: color,
        strokeWidth: LINE_W * 0.9,
      }),
    );
  }
}

// Scatter `count` tufts across a banner.  Tufts are distributed across the
// full height of the banner so the grass fills the whole row, not just the
// bottom strip.  Each tuft's "ground line" is jittered so blades don't all
// start at the same y.
export function scatterGrass(
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  count: number,
): void {
  const margin = 4; // keep away from the box edges
  for (let i = 0; i < count; i++) {
    const cx = x + margin + rng() * (w - margin * 2);
    // Distribute ground points throughout the banner; blades grow upward
    // from each so the tuft tops lie within the banner.
    const cy = y + h * 0.25 + rng() * h * 0.65;
    grassTuft(cx, cy, color);
  }
}

// One wave: a small ~ shape with two crests, drawn as a single cubic.
export function wave(
  cx: number,
  cy: number,
  width: number,
  color: string,
): void {
  const half = width / 2;
  const amp = width * 0.18;
  // Cubic that goes up then down then up again across the span
  const d =
    `M ${cx - half} ${cy} ` +
    `C ${cx - half * 0.5} ${cy - amp}, ${cx - half * 0.2} ${cy + amp}, ${cx} ${cy} ` +
    `C ${cx + half * 0.2} ${cy - amp}, ${cx + half * 0.5} ${cy + amp}, ${cx + half} ${cy}`;
  layers.shapes.append(
    svgPath(d, {
      fill: "none",
      stroke: color,
      strokeWidth: LINE_W * 0.9,
    }),
  );
}

// Scatter `count` waves across the sea banner WITHOUT overlap.
// Uses Poisson-disk rejection sampling so wave centres stay ≥ 12mm apart.
export function scatterWaves(
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  count: number,
): void {
  const margin = 5;
  const placed = poissonDisk(
    x + margin,
    y + margin,
    w - margin * 2,
    h - margin * 2,
    12,
    count,
    rng,
  );
  for (const [cx, cy] of placed) {
    const ww = 8 + rng() * 4; // 8-12mm wide
    wave(cx, cy, ww, color);
  }
}

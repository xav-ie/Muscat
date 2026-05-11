import { LINE_W, layers } from "../state.js";
import { svg } from "../svg/template.js";
import { random as rng } from "../util/rng.js";
import { svgPath } from "../svg/primitives.js";
import { wave } from "./scatter.js";

// Build an SVG path "M x y L x y L x y …" from a list of points.
function buildEdgePath(pts: [number, number][]): string {
  let d = svg`M ${pts[0][0]} ${pts[0][1]} `;
  for (let index = 1; index < pts.length; index++)
    d += svg`L ${pts[index][0]} ${pts[index][1]} `;
  return d;
}

// Composite river scene: SAND zone above, MUD zone below, with a meandering
// blue river band running horizontally across the middle.  The river's edges
// undulate; flow lines inside suggest current.
export function riverScene(x: number, y: number, w: number, h: number): void {
  const SAND = "#e8c773";
  const MUD = "#6b4d2e";
  const RIVER_BLUE = "#3a91c2";
  const DEEP_BLUE = "#0e3450";

  // River runs horizontally through the middle ~50% of the banner height,
  // with sinusoidal undulation top-and-bottom.  Big slow S-curves dominate;
  // a small higher-frequency wiggle adds character without breaking flow.
  const riverMidY = y + h * 0.5;
  const riverHalfBase = h * 0.3; // half-thickness at midline
  function riverEdgeY(side: -1 | 1, px: number): number {
    // side: -1 = top edge, +1 = bottom edge.  Both edges undulate together
    // following the same big S-curve so the river itself meanders, with a
    // smaller independent wobble on each edge.
    const t = (px - x) / w;
    // Big slow primary wave — drives the meander
    const meander = Math.sin(t * Math.PI * 1.6 + 0.5) * 0.85;
    // Small fast wobble — different phase per edge, much smaller amplitude
    const phase = side === -1 ? 0 : 1.2;
    const wobble = Math.sin(t * Math.PI * 4.2 + phase) * 0.18;
    // Both edges shifted by the SAME meander → river snakes left/right
    return (
      riverMidY +
      meander * h * 0.15 +
      side * (riverHalfBase + wobble * h * 0.08)
    );
  }
  const samples = 60;
  const topPts: [number, number][] = [],
    botPts: [number, number][] = [];
  for (let index = 0; index <= samples; index++) {
    const px = x + (index / samples) * w;
    topPts.push([px, riverEdgeY(-1, px)]);
    botPts.push([px, riverEdgeY(1, px)]);
  }

  // 1. SAND on top — a polygon from banner top to river top edge
  let dSand = svg`M ${x} ${y} L ${x + w} ${y} `;
  for (let index = topPts.length - 1; index >= 0; index--) {
    dSand += svg`L ${topPts[index][0]} ${topPts[index][1]} `;
  }
  dSand += "Z";
  layers.shapes.append(svgPath(dSand, { fill: SAND }));

  // 2. MUD on bottom — banner bottom up to river bottom edge
  let dMud = svg`M ${x} ${y + h} L ${x + w} ${y + h} `;
  for (let index = botPts.length - 1; index >= 0; index--) {
    dMud += svg`L ${botPts[index][0]} ${botPts[index][1]} `;
  }
  dMud += "Z";
  layers.shapes.append(svgPath(dMud, { fill: MUD }));

  // 3. RIVER body — between top and bottom edges
  let dRiver = svg`M ${topPts[0][0]} ${topPts[0][1]} `;
  for (let index = 1; index < topPts.length; index++) {
    dRiver += svg`L ${topPts[index][0]} ${topPts[index][1]} `;
  }
  for (let index = botPts.length - 1; index >= 0; index--) {
    dRiver += svg`L ${botPts[index][0]} ${botPts[index][1]} `;
  }
  dRiver += "Z";
  layers.shapes.append(svgPath(dRiver, { fill: RIVER_BLUE }));

  // 4. River bank outlines (top and bottom edges of the river)
  layers.shapes.append(
    svgPath(buildEdgePath(topPts), {
      fill: "none",
      stroke: DEEP_BLUE,
      strokeWidth: LINE_W,
    }),
  );
  layers.shapes.append(
    svgPath(buildEdgePath(botPts), {
      fill: "none",
      stroke: DEEP_BLUE,
      strokeWidth: LINE_W,
    }),
  );

  // 5. A few flow waves inside the river to suggest current
  const flowCount = 8;
  for (let index = 0; index < flowCount; index++) {
    const cx = x + ((index + 0.5 + (rng() - 0.5) * 0.5) * w) / flowCount;
    const cy = riverMidY + (rng() - 0.5) * h * 0.18;
    const ww = 6 + rng() * 3;
    wave(cx, cy, ww, DEEP_BLUE);
  }
}

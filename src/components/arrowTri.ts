// @ts-nocheck
import { layers } from "../state.js";
import { svgPath } from "../svg/primitives.js";

// Small filled triangle. (cx, cy) is the apex; the base extends opposite to dir.
export function arrowTri(cx, cy, len, dir, color = "#111") {
  const half = len * 0.75; // wider base for legibility
  let p1, p2, p3;
  if (dir === "up") {
    p1 = [cx, cy];
    p2 = [cx + half, cy + len];
    p3 = [cx - half, cy + len];
  }
  if (dir === "down") {
    p1 = [cx, cy];
    p2 = [cx - half, cy - len];
    p3 = [cx + half, cy - len];
  }
  if (dir === "left") {
    p1 = [cx, cy];
    p2 = [cx + len, cy - half];
    p3 = [cx + len, cy + half];
  }
  if (dir === "right") {
    p1 = [cx, cy];
    p2 = [cx - len, cy + half];
    p3 = [cx - len, cy - half];
  }
  const d = `M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]} L ${p3[0]} ${p3[1]} Z`;
  layers.shapes.appendChild(
    svgPath(d, { fill: color, stroke: color, strokeWidth: 0.2 }),
  );
}

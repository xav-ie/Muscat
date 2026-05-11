import { layers } from "../state.js";
import { svgPath } from "../svg/primitives.js";

// Continuous wavy ground: a single shape spanning the banner with a top
// edge that rises and dips along multiple superimposed sine waves, and the
// bottom anchored at the banner's bottom edge so there's no gap.  Returns
// nothing — appends the filled shape directly.
//
// `crestY` controls the ground's average top y-coordinate (the "horizon").
// `amplitude` controls how high humps rise above the average horizon.
export function wavyGround(
  x: number,
  y: number,
  w: number,
  h: number,
  crestY: number,
  amplitude: number,
  fillColor: string,
): void {
  // Sample the top edge as a series of points combining two sine waves so
  // the bumps look natural (some big, some small).
  const samples = 80;
  const pts: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const px = x + t * w;
    const noise =
      Math.sin(t * Math.PI * 2.0 + 0.4) * 0.55 +
      Math.sin(t * Math.PI * 5.3 + 1.2) * 0.3 +
      Math.sin(t * Math.PI * 9.1) * 0.15;
    const py = crestY - amplitude * (0.5 + noise * 0.5);
    pts.push([px, py]);
  }
  // Build path: top wavy edge left-to-right, then down to bottom-right
  // corner, across to bottom-left, close.
  let d = `M ${pts[0]![0]} ${pts[0]![1]} `;
  for (let i = 1; i < pts.length; i++) {
    d += `L ${pts[i]![0]} ${pts[i]![1]} `;
  }
  d += `L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  layers.shapes!.appendChild(svgPath(d, { fill: fillColor }));
}

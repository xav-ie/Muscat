import { SVG_NS, LINE_W } from "../state.js";
import { svg } from "./template.js";

// ─────────────────────────────────────────────────────────────────────
// Plain-SVG drawing helpers — no rough.js.  All "hand-drawn" character
// comes from the turbulence/displacement filter applied to shapesLayer.
// ─────────────────────────────────────────────────────────────────────

// SVG <path> with stroke and/or fill
export function svgPath(
  d: string,
  {
    fill = "none",
    stroke = "none",
    strokeWidth = 0,
  }: { fill?: string; stroke?: string; strokeWidth?: number } = {},
): SVGPathElement {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", fill);
  if (stroke && stroke !== "none") {
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", String(strokeWidth));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  }
  return p;
}

// SVG <line>
export function svgLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  { stroke = "#111", strokeWidth = LINE_W }: { stroke?: string; strokeWidth?: number } = {},
): SVGLineElement {
  const l = document.createElementNS(SVG_NS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  l.setAttribute("stroke", stroke);
  l.setAttribute("stroke-width", String(strokeWidth));
  l.setAttribute("stroke-linecap", "round");
  return l;
}

// Plain SVG rounded rect (used as crisp fill underlay so the rough outline can wobble freely on top)
export function svgRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  rx = 0,
): SVGRectElement {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  if (rx) {
    r.setAttribute("rx", String(rx));
    r.setAttribute("ry", String(rx));
  }
  r.setAttribute("fill", fill);
  return r;
}

// Plain SVG image element for raster icons
export function svgImage(
  href: string,
  x: number,
  y: number,
  w: number,
  h: number,
): SVGImageElement {
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
  img.setAttribute("href", href);
  img.setAttribute("x", String(x));
  img.setAttribute("y", String(y));
  img.setAttribute("width", String(w));
  img.setAttribute("height", String(h));
  img.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return img;
}

// Helper: build a rounded-rect path string. rough.js's rectangle() ignores rx,
// so we hand-roll a path so corners stay round.
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) {
    return svg`M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  }
  return [
    svg`M ${x + r} ${y}`,
    svg`H ${x + w - r}`,
    svg`Q ${x + w} ${y} ${x + w} ${y + r}`,
    svg`V ${y + h - r}`,
    svg`Q ${x + w} ${y + h} ${x + w - r} ${y + h}`,
    svg`H ${x + r}`,
    svg`Q ${x} ${y + h} ${x} ${y + h - r}`,
    svg`V ${y + r}`,
    svg`Q ${x} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

export type ArrowDirection = "up" | "down" | "left" | "right";

// Build a path that is a rounded square OPTIONALLY with a triangular arrow
// protruding from one of its sides (the merged shape).  When `arrowDirection` is
// 'right' | 'down' | 'left' | 'up', the side perpendicular to that direction
// is interrupted at its midpoint by an outward-pointing triangle of length
// `arrowLength` (apex distance) and half-width `arrowHalf` (along the side).
// Path is traversed clockwise; arrow protrusions break the side into:
// "side-up-to-base-corner → out to apex → back to other-base-corner →
//  continue along side".  Non-arrow sides traverse normally.
export function squareWithArrowPath(
  x: number,
  y: number,
  size: number,
  r: number,
  arrowDirection: ArrowDirection | null | undefined,
  arrowLength: number,
  arrowHalf: number,
): string {
  if (!arrowDirection || arrowLength <= 0) return roundedRectPath(x, y, size, size, r);
  r = Math.max(0, Math.min(r, size / 2));
  const mid = size / 2;
  const xL = x,
    xR = x + size,
    yT = y,
    yB = y + size;
  const parts = [svg`M ${xL + r} ${yT}`];

  // --- TOP EDGE (left → right) ---
  if (arrowDirection === "up") {
    parts.push(
      svg`H ${xL + mid - arrowHalf}`,
      svg`L ${xL + mid} ${yT - arrowLength}`,
      svg`L ${xL + mid + arrowHalf} ${yT}`,
      svg`H ${xR - r}`,
    );
  } else {
    parts.push(svg`H ${xR - r}`);
  }
  parts.push(svg`Q ${xR} ${yT} ${xR} ${yT + r}`); // top-right corner

  // --- RIGHT EDGE (top → bottom) ---
  if (arrowDirection === "right") {
    parts.push(
      svg`V ${yT + mid - arrowHalf}`,
      svg`L ${xR + arrowLength} ${yT + mid}`,
      svg`L ${xR} ${yT + mid + arrowHalf}`,
      svg`V ${yB - r}`,
    );
  } else {
    parts.push(svg`V ${yB - r}`);
  }
  parts.push(svg`Q ${xR} ${yB} ${xR - r} ${yB}`); // bottom-right corner

  // --- BOTTOM EDGE (right → left) ---
  if (arrowDirection === "down") {
    parts.push(
      svg`H ${xL + mid + arrowHalf}`,
      svg`L ${xL + mid} ${yB + arrowLength}`,
      svg`L ${xL + mid - arrowHalf} ${yB}`,
      svg`H ${xL + r}`,
    );
  } else {
    parts.push(svg`H ${xL + r}`);
  }
  parts.push(svg`Q ${xL} ${yB} ${xL} ${yB - r}`); // bottom-left corner

  // --- LEFT EDGE (bottom → top) ---
  if (arrowDirection === "left") {
    parts.push(
      svg`V ${yT + mid + arrowHalf}`,
      svg`L ${xL - arrowLength} ${yT + mid}`,
      svg`L ${xL} ${yT + mid - arrowHalf}`,
      svg`V ${yT + r}`,
    );
  } else {
    parts.push(svg`V ${yT + r}`);
  }
  parts.push(svg`Q ${xL} ${yT} ${xL + r} ${yT}`, "Z");
  return parts.join(" ");
}

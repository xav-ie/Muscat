import { SVG_NS, LINE_W } from "../state.js";

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
  {
    stroke = "#111",
    strokeWidth = LINE_W,
  }: { stroke?: string; strokeWidth?: number } = {},
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
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) {
    return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  }
  return [
    `M ${x + r} ${y}`,
    `H ${x + w - r}`,
    `Q ${x + w} ${y} ${x + w} ${y + r}`,
    `V ${y + h - r}`,
    `Q ${x + w} ${y + h} ${x + w - r} ${y + h}`,
    `H ${x + r}`,
    `Q ${x} ${y + h} ${x} ${y + h - r}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

export type ArrowDir = "up" | "down" | "left" | "right";

// Build a path that is a rounded square OPTIONALLY with a triangular arrow
// protruding from one of its sides (the merged shape).  When `arrowDir` is
// 'right' | 'down' | 'left' | 'up', the side perpendicular to that direction
// is interrupted at its midpoint by an outward-pointing triangle of length
// `arrowLen` (apex distance) and half-width `arrowHalf` (along the side).
// Path is traversed clockwise; arrow protrusions break the side into:
// "side-up-to-base-corner → out to apex → back to other-base-corner →
//  continue along side".  Non-arrow sides traverse normally.
export function squareWithArrowPath(
  x: number,
  y: number,
  size: number,
  r: number,
  arrowDir: ArrowDir | null | undefined,
  arrowLen: number,
  arrowHalf: number,
): string {
  if (!arrowDir || arrowLen <= 0) return roundedRectPath(x, y, size, size, r);
  r = Math.max(0, Math.min(r, size / 2));
  const mid = size / 2;
  const xL = x,
    xR = x + size,
    yT = y,
    yB = y + size;
  const parts = [`M ${xL + r} ${yT}`];

  // --- TOP EDGE (left → right) ---
  if (arrowDir === "up") {
    parts.push(`H ${xL + mid - arrowHalf}`);
    parts.push(`L ${xL + mid} ${yT - arrowLen}`);
    parts.push(`L ${xL + mid + arrowHalf} ${yT}`);
    parts.push(`H ${xR - r}`);
  } else {
    parts.push(`H ${xR - r}`);
  }
  parts.push(`Q ${xR} ${yT} ${xR} ${yT + r}`); // top-right corner

  // --- RIGHT EDGE (top → bottom) ---
  if (arrowDir === "right") {
    parts.push(`V ${yT + mid - arrowHalf}`);
    parts.push(`L ${xR + arrowLen} ${yT + mid}`);
    parts.push(`L ${xR} ${yT + mid + arrowHalf}`);
    parts.push(`V ${yB - r}`);
  } else {
    parts.push(`V ${yB - r}`);
  }
  parts.push(`Q ${xR} ${yB} ${xR - r} ${yB}`); // bottom-right corner

  // --- BOTTOM EDGE (right → left) ---
  if (arrowDir === "down") {
    parts.push(`H ${xL + mid + arrowHalf}`);
    parts.push(`L ${xL + mid} ${yB + arrowLen}`);
    parts.push(`L ${xL + mid - arrowHalf} ${yB}`);
    parts.push(`H ${xL + r}`);
  } else {
    parts.push(`H ${xL + r}`);
  }
  parts.push(`Q ${xL} ${yB} ${xL} ${yB - r}`); // bottom-left corner

  // --- LEFT EDGE (bottom → top) ---
  if (arrowDir === "left") {
    parts.push(`V ${yT + mid + arrowHalf}`);
    parts.push(`L ${xL - arrowLen} ${yT + mid}`);
    parts.push(`L ${xL} ${yT + mid - arrowHalf}`);
    parts.push(`V ${yT + r}`);
  } else {
    parts.push(`V ${yT + r}`);
  }
  parts.push(`Q ${xL} ${yT} ${xL + r} ${yT}`); // top-left corner
  parts.push("Z");
  return parts.join(" ");
}

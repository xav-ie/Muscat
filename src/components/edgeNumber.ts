import { SVG_NS, layers } from "../state.js";

export type TextAlign = "start" | "middle" | "end";
export interface TextOutline {
  color: string;
  width: number;
}

// Number rendered with the Kranky display font.
// `align` is one of 'start' | 'middle' | 'end' — picks the SVG text-anchor.
// `cy` is the vertical center of the text.
// If the text starts with '-', the minus sign is rendered in a smaller tspan
// so it doesn't look like an oversized horizontal dash next to the digit.
// If `outline` is given (`{ color, width }`), the text gets a stroke of that
// color and width drawn BEHIND the fill (paint-order: stroke fill).
export function edgeNumber(
  x: number,
  cy: number,
  text: string,
  color: string,
  sizeMm: number,
  align: TextAlign = "middle",
  outline?: TextOutline,
): void {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", String(x));
  t.setAttribute("y", String(cy));
  t.setAttribute("text-anchor", align);
  t.setAttribute("dominant-baseline", "central");
  t.setAttribute("font-family", '"Kranky", "Caveat", "Comic Sans MS", cursive');
  t.setAttribute("font-size", String(sizeMm));
  t.setAttribute("fill", color);
  if (outline) {
    // paint-order: stroke fill — stroke behind so visible glyph color is fill
    t.setAttribute("paint-order", "stroke fill");
    t.setAttribute("stroke", outline.color);
    t.setAttribute("stroke-width", String(outline.width));
    t.setAttribute("stroke-linejoin", "round");
  }
  if (text.startsWith("-")) {
    // Render '-' in a smaller tspan but vertically aligned with the digit.
    // Setting dominant-baseline on each tspan (rather than only the parent
    // <text>) makes both glyphs anchor at the same vertical center regardless
    // of font-size differences.
    const minus = document.createElementNS(SVG_NS, "tspan");
    minus.setAttribute("font-size", String(sizeMm * 0.55));
    minus.setAttribute("dominant-baseline", "central");
    minus.textContent = "-";
    t.append(minus);
    const rest = document.createElementNS(SVG_NS, "tspan");
    rest.setAttribute("dominant-baseline", "central");
    // dx on the DIGIT shifts it right relative to where it would naturally
    // land after the minus.  This is what actually opens a gap (dx on the
    // minus only shifts both the minus AND the digit left together).
    rest.setAttribute("dx", String(2));
    rest.textContent = text.slice(1);
    t.append(rest);
  } else {
    t.textContent = text;
  }
  layers.text.append(t);
}

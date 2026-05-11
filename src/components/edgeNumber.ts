// @ts-nocheck
import { SVG_NS, layers } from "../state.js";

// Number rendered with the Kranky display font.
// `align` is one of 'start' | 'middle' | 'end' — picks the SVG text-anchor.
// `cy` is the vertical center of the text.
// If the text starts with '-', the minus sign is rendered in a smaller tspan
// so it doesn't look like an oversized horizontal dash next to the digit.
// If `outline` is given (`{ color, width }`), the text gets a stroke of that
// color and width drawn BEHIND the fill (paint-order: stroke fill).
export function edgeNumber(
  x,
  cy,
  text,
  color,
  sizeMm,
  align = "middle",
  outline = null,
) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", x);
  t.setAttribute("y", cy);
  t.setAttribute("text-anchor", align);
  t.setAttribute("dominant-baseline", "central");
  t.setAttribute("font-family", '"Kranky", "Caveat", "Comic Sans MS", cursive');
  t.setAttribute("font-size", sizeMm);
  t.setAttribute("fill", color);
  if (outline) {
    // paint-order: stroke fill — stroke behind so visible glyph color is fill
    t.setAttribute("paint-order", "stroke fill");
    t.setAttribute("stroke", outline.color);
    t.setAttribute("stroke-width", outline.width);
    t.setAttribute("stroke-linejoin", "round");
  }
  if (text.startsWith("-")) {
    // Render '-' in a smaller tspan but vertically aligned with the digit.
    // Setting dominant-baseline on each tspan (rather than only the parent
    // <text>) makes both glyphs anchor at the same vertical center regardless
    // of font-size differences.
    const minus = document.createElementNS(SVG_NS, "tspan");
    minus.setAttribute("font-size", sizeMm * 0.55);
    minus.setAttribute("dominant-baseline", "central");
    minus.textContent = "-";
    t.appendChild(minus);
    const rest = document.createElementNS(SVG_NS, "tspan");
    rest.setAttribute("dominant-baseline", "central");
    // dx on the DIGIT shifts it right relative to where it would naturally
    // land after the minus.  This is what actually opens a gap (dx on the
    // minus only shifts both the minus AND the digit left together).
    rest.setAttribute("dx", 2);
    rest.textContent = text.slice(1);
    t.appendChild(rest);
  } else {
    t.textContent = text;
  }
  layers.text.appendChild(t);
}

import { SVG_NS } from "../state.js";

// Get a 2D context from a canvas, throwing if unavailable. The browser only
// returns null in obscure cases (already-locked context, etc.) — we treat it
// as a hard error rather than poisoning every caller with null handling.
export function get2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  return ctx;
}

// Bake an HTMLCanvasElement to a data URL and embed it as an SVG <image>
// with absolute positioning (preserveAspectRatio='none' so it stretches to
// the requested rect).  Used by magmaRocks, crackedDesert (no — uses paths),
// waterCaustics — anywhere we rasterize via 2D canvas and embed in the SVG.
export function embedCanvasAsImage(
  parent: SVGElement,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): SVGImageElement {
  const dataURL = canvas.toDataURL("image/png");
  const imgEl = document.createElementNS(SVG_NS, "image");
  imgEl.setAttribute("x", String(x));
  imgEl.setAttribute("y", String(y));
  imgEl.setAttribute("width", String(w));
  imgEl.setAttribute("height", String(h));
  imgEl.setAttribute("preserveAspectRatio", "none");
  imgEl.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", dataURL);
  imgEl.setAttribute("href", dataURL);
  parent.append(imgEl);
  return imgEl;
}

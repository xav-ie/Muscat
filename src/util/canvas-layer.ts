import { SVG_NS } from "../state.js";

// Get a 2D context from a canvas, throwing if unavailable. The browser only
// returns null in obscure cases (already-locked context, etc.) — we treat it
// as a hard error rather than poisoning every caller with null handling.
export function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2D context unavailable");
  return context;
}

// Bake an HTMLCanvasElement to a data URL and embed it as an SVG <image>
// with absolute positioning (preserveAspectRatio='none' so it stretches to
// the requested rect).  Used by every rasterized terrain — magma and water
// from their WebGPU canvases, grass from its WebGPU instanced canvas.
//
// `mime` lets callers opt into JPEG (e.g. `"image/jpeg"`, with a `quality`
// 0..1) when the canvas is fully opaque and the encoding cost of PNG is the
// bottleneck.  PNG stays the default for crisp / low-contrast imagery.
export function embedCanvasAsImage(
  parent: SVGElement,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  { mime = "image/png", quality }: { mime?: string; quality?: number } = {},
): SVGImageElement {
  const dataURL = canvas.toDataURL(mime, quality);
  const imgElement = document.createElementNS(SVG_NS, "image");
  imgElement.setAttribute("x", String(x));
  imgElement.setAttribute("y", String(y));
  imgElement.setAttribute("width", String(w));
  imgElement.setAttribute("height", String(h));
  imgElement.setAttribute("preserveAspectRatio", "none");
  imgElement.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", dataURL);
  imgElement.setAttribute("href", dataURL);
  parent.append(imgElement);
  return imgElement;
}

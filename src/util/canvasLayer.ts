// @ts-nocheck
import { SVG_NS } from "../state.js";

// Bake an HTMLCanvasElement to a data URL and embed it as an SVG <image>
// with absolute positioning (preserveAspectRatio='none' so it stretches to
// the requested rect).  Used by magmaRocks, crackedDesert (no — uses paths),
// waterCaustics — anywhere we rasterize via 2D canvas and embed in the SVG.
export function embedCanvasAsImage(parent, canvas, x, y, w, h) {
  const dataURL = canvas.toDataURL("image/png");
  const imgEl = document.createElementNS(SVG_NS, "image");
  imgEl.setAttribute("x", x);
  imgEl.setAttribute("y", y);
  imgEl.setAttribute("width", w);
  imgEl.setAttribute("height", h);
  imgEl.setAttribute("preserveAspectRatio", "none");
  imgEl.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", dataURL);
  imgEl.setAttribute("href", dataURL);
  parent.appendChild(imgEl);
  return imgEl;
}

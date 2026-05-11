export const SVG_NS = "http://www.w3.org/2000/svg";

// One line weight for the entire board — castle, banner boxes, zigzag, and
// the quadlet square outlines all draw at this width. Keep them visually
// unified.
export const LINE_W = 0.7;

const boardElement = document.querySelector<SVGSVGElement>("#board");
if (!boardElement) throw new Error("#board element not found in document");
export const board = boardElement;

// Global rendering state.
//   seed:                feeds both the SVG turbulence pattern AND the JS PRNG,
//                        so "re-roll" reshuffles every procedural shape too.
//   grainFreq/grainScale: control the SVG-filter EDGE TEXTURE matching Kranky
export const G = {
  seed: 1,
  grainFreq: 0.8,
  grainScale: 0.5,
};

// Targets that render helpers append into — set up by setupLayers() each render.
//   shapes: gets a turbulence/displacement filter that gives every drawn edge
//           a subtle hand-drawn texture matching Kranky's letterforms.
//   text:   plain group, NO filter — Kranky already has its own texture
//           built into the glyphs and shouldn't be doubly-displaced.
//
// quadlet() temporarily reassigns `layers.shapes` to its own group so child
// helpers append into the quadlet, then restores it via try/finally.
//
// Implemented as accessors backed by private state so reads return non-null
// `SVGElement` (with a runtime guard against access before setupLayers()),
// while assignment still works for the swap pattern.
let _shapes: SVGElement | undefined;
let _text: SVGElement | undefined;

export const layers = {
  get shapes(): SVGElement {
    if (!_shapes)
      throw new Error("layers.shapes accessed before setupLayers()");
    return _shapes;
  },
  set shapes(element: SVGElement) {
    _shapes = element;
  },
  get text(): SVGElement {
    if (!_text) throw new Error("layers.text accessed before setupLayers()");
    return _text;
  },
  set text(element: SVGElement) {
    _text = element;
  },
};

// `<defs>` lookup — used by helpers that register filters/clipPaths against
// the board's top-level defs. Throws if defs is missing (which would mean
// setupLayers hasn't run yet).
export function getDefs(): SVGDefsElement {
  const defs = board.querySelector("defs");
  if (!defs)
    throw new Error("board <defs> not found — run setupLayers() first");
  return defs;
}

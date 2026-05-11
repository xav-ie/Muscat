export const SVG_NS = "http://www.w3.org/2000/svg";

// One line weight for the entire board — castle, banner boxes, zigzag, and
// the quadlet square outlines all draw at this width. Keep them visually
// unified.
export const LINE_W = 0.7;

export const board = document.getElementById(
  "board",
) as unknown as SVGSVGElement;

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
export const layers: { shapes: SVGElement | null; text: SVGElement | null } = {
  shapes: null,
  text: null,
};

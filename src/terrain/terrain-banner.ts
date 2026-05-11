import { SVG_NS, LINE_W, layers, getDefs } from "../state.js";
import { uid } from "../util/uid.js";
import { svgPath, svgRect, roundedRectPath } from "../svg/primitives.js";
import { magmaRocks } from "./magma-rocks.js";
import { crackedDesert } from "./cracked-desert.js";
import { waterCaustics } from "./water-caustics.js";
import { grassScene } from "./grass-scene.js";

function decorateBanner(s: number, x: number, y: number, w: number, h: number): void {
  switch (s) {
    case 0: {
      // Lava — Voronoi rocks with glowing magma cracks between them.
      magmaRocks(x, y, w, h);

      break;
    }
    case 1: {
      // Sand — cracked desert: Voronoi cells in mottled sand colors,
      // separated by thin dark dried-mud cracks.
      crackedDesert(x, y, w, h);

      break;
    }
    case 2: {
      // Sea — water caustics: two layers of sharp-minus-smooth Voronoi
      // distance fields.  Dark blue underlay (slider-controlled) + bright
      // white tight ridges (baked) on top.
      waterCaustics(x, y, w, h);

      break;
    }
    case 3: {
      // Grass row: mounds, scattered tufts, flowers
      grassScene(x, y, w, h);

      break;
    }
    // No default
  }
}

// Themed terrain banner — a filled rounded rectangle with a colored outline,
// optionally decorated with terrain ornaments keyed off the section index.
export function terrainBanner(
  s: number,
  x: number,
  y: number,
  w: number,
  h: number,
  fillColor: string,
  strokeColor: string,
): void {
  // Crisp fill underlay so color stays uniform under any displacement
  layers.shapes.append(svgRect(x, y, w, h, fillColor, 2.5));

  // Set up a clipPath matching the banner's rounded-rect shape so any
  // decoration that draws beyond the banner (e.g. sand Voronoi cells that
  // expand slightly past the rectangle) is clipped to the rounded outline.
  const clipId = uid("banner-clip");
  const cp = document.createElementNS(SVG_NS, "clipPath");
  cp.setAttribute("id", clipId);
  const cpPath = document.createElementNS(SVG_NS, "path");
  cpPath.setAttribute("d", roundedRectPath(x, y, w, h, 2.5));
  cp.append(cpPath);
  getDefs().append(cp);

  // Decorations live inside a clipped group so they can't escape the
  // banner shape.  Append our clipped group to the current shapesLayer
  // (which may itself be inside a filter, e.g. for the grain effect) and
  // SWAP shapesLayer for the duration so decoration primitives append
  // into the clipped group.
  const clipped = document.createElementNS(SVG_NS, "g");
  clipped.setAttribute("clip-path", `url(#${clipId})`);
  const saved = layers.shapes;
  saved.append(clipped);
  layers.shapes = clipped;
  try {
    decorateBanner(s, x, y, w, h);
  } finally {
    layers.shapes = saved;
  }

  // Outline on top (outside the clip so the stroke's outer half stays visible)
  layers.shapes.append(
    svgPath(roundedRectPath(x, y, w, h, 2.5), {
      fill: "none",
      stroke: strokeColor,
      strokeWidth: LINE_W,
    }),
  );
}

import { SVG_NS, LINE_W, layers, getDefs } from "../state.js";
import { uid } from "../util/uid.js";
import { svgPath, svgRect, roundedRectPath } from "../svg/primitives.js";
import { magmaRocks } from "./magma-rocks.js";
import { crackedDesert } from "./cracked-desert.js";
import { waterCaustics } from "./water-caustics.js";
import { grassScene } from "./grass-scene.js";

// Section-index → terrain decoration:
//   0 lava (magma rocks)         1 cracked desert
//   2 water caustics             3 grass scene
type Decorator = (x: number, y: number, w: number, h: number) => void | Promise<void>;
const DECORATORS: Decorator[] = [magmaRocks, crackedDesert, waterCaustics, grassScene];

async function decorateBanner(
  s: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<void> {
  await DECORATORS[s]?.(x, y, w, h);
}

// Themed terrain banner — a filled rounded rectangle with a colored outline,
// optionally decorated with terrain ornaments keyed off the section index.
export async function terrainBanner(
  s: number,
  x: number,
  y: number,
  w: number,
  h: number,
  fillColor: string,
  strokeColor: string,
): Promise<void> {
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
    await decorateBanner(s, x, y, w, h);
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

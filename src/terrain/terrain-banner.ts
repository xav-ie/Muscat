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

  // Decorations live inside CLIPPED groups so they can't escape the banner
  // shape.  Path-based decoration (e.g. sand cracks) goes into the shapes
  // layer's clip (inheriting the grain filter); rasterized decoration
  // (lava/water/grass <image>) goes into the rasters layer's clip
  // (UNFILTERED — the grain displacement otherwise smears their pixels into
  // a visible wobble).  Both swap their respective `layers.*` for the
  // duration of the decorator call.
  function clipped(parent: SVGElement): SVGElement {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("clip-path", `url(#${clipId})`);
    parent.append(g);
    return g;
  }
  const clippedShapes = clipped(layers.shapes);
  const clippedRasters = clipped(layers.rasters);
  const savedShapes = layers.shapes;
  const savedRasters = layers.rasters;
  layers.shapes = clippedShapes;
  layers.rasters = clippedRasters;
  try {
    await decorateBanner(s, x, y, w, h);
  } finally {
    layers.shapes = savedShapes;
    layers.rasters = savedRasters;
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

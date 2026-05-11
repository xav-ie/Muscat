import { SVG_NS, LINE_W, layers, getDefs } from "../state.js";
import { ICONS } from "../constants.js";
import { uid } from "../util/uid.js";
import {
  svgPath,
  svgRect,
  svgImage,
  roundedRectPath,
  squareWithArrowPath,
} from "../svg/primitives.js";
import type { ArrowDir } from "../svg/primitives.js";

export interface IconTheme {
  squareFill: string;
  iconColor: string;
  outline: string;
}

// Rough rounded square. If `fill` is set, a crisp SVG rect is laid down first
// so the rough outline can wobble outside its edges without smearing the color.
// Rounded square. If `fill` is set, a crisp SVG rect is laid down first so the
// outline (now plain SVG, displaced by the grain filter) wobbles outside its
// edges without smearing the color.
export function square(
  x: number,
  y: number,
  size: number,
  {
    fill = "none",
    stroke = "#111",
    strokeWidth = LINE_W,
    radius = 1.5,
  }: {
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    radius?: number;
  } = {},
): void {
  if (fill && fill !== "none") {
    layers.shapes.append(svgRect(x, y, size, size, fill, radius));
  }
  if (stroke && stroke !== "none") {
    layers.shapes.append(
      svgPath(roundedRectPath(x, y, size, size, radius), {
        fill: "none",
        stroke,
        strokeWidth,
      }),
    );
  }
}

// Tint-filter registry — maps a hex color to a filter id that recolors any
// graphic to that color while preserving its alpha channel. Used to recolor
// the icon SVGs at render time without baking in colors at build time.
// Cleared (not nulled) between renders so identity stays stable.
const __tintRegistry = new Map<string, string>();

export function resetTintRegistry(): void {
  __tintRegistry.clear();
}

export function getTintFilterId(color: string): string {
  const cached = __tintRegistry.get(color);
  if (cached !== undefined) return cached;
  const id = uid(`tint-${color.replace("#", "")}`);
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", id);
  filter.setAttribute("color-interpolation-filters", "sRGB");
  // Flood the filter region with the target color, then keep only where the
  // source had alpha (composite "in" with SourceGraphic).  Result: source
  // shape, target color, original alpha.
  const flood = document.createElementNS(SVG_NS, "feFlood");
  flood.setAttribute("flood-color", color);
  flood.setAttribute("flood-opacity", "1");
  flood.setAttribute("result", "flood");
  const composite = document.createElementNS(SVG_NS, "feComposite");
  composite.setAttribute("in", "flood");
  composite.setAttribute("in2", "SourceGraphic");
  composite.setAttribute("operator", "in");
  filter.append(flood);
  filter.append(composite);
  getDefs().append(filter);
  __tintRegistry.set(color, id);
  return id;
}

// Square + icon centered inside.
// `theme` controls coloring per quadlet row:
//   theme.squareFill — fill of the rounded square
//   theme.iconColor  — recolor target for the icon SVG
//   theme.outline    — square outline color
export function iconSquare(
  x: number,
  y: number,
  size: number,
  iconKey: string,
  theme: IconTheme,
  arrowDir: ArrowDir | undefined,
): void {
  // Build the path: a rounded square optionally with a triangular arrow
  // protrusion on one side.  When merged, the arrow becomes part of the
  // square's path so it gets the same outline, the same fill, the same
  // inset-shadow filter perimeter, and is locked to its source square (so
  // it can't visually disconnect from it under the grain filter's edge
  // displacement).
  const radius = 1.5;
  const arrowLen = arrowDir ? size * 0.18 : 0; // matches the gap inside quadlet()
  const arrowHalf = arrowLen * 0.75;
  const path = squareWithArrowPath(
    x,
    y,
    size,
    radius,
    arrowDir,
    arrowLen,
    arrowHalf,
  );

  // Crisp filled underlay (uniform color regardless of grain displacement)
  if (theme.squareFill && theme.squareFill !== "none") {
    layers.shapes.append(
      svgPath(path, {
        fill: theme.squareFill,
        stroke: "none",
      }),
    );
  }
  // Stroked outline — wobbles via grain filter
  if (theme.outline && theme.outline !== "none") {
    const outlinePath = svgPath(path, {
      fill: "none",
      stroke: theme.outline,
      strokeWidth: LINE_W,
    });
    // Round line joins so the angle where the side meets the slanted arrow
    // edge doesn't spike out as a miter point under stroke-linejoin='miter'.
    outlinePath.setAttribute("stroke-linejoin", "round");
    outlinePath.setAttribute("stroke-linecap", "round");
    layers.shapes.append(outlinePath);
  }

  // Icon image, padded inside the square
  const pad = size * 0.08;
  const iconSize = size - pad * 2;
  const dataUrl = `data:image/svg+xml;base64,${ICONS[iconKey]}`;
  const img = svgImage(dataUrl, x + pad, y + pad, iconSize, iconSize);
  img.setAttribute("filter", `url(#${getTintFilterId(theme.iconColor)})`);
  layers.shapes.append(img);
}

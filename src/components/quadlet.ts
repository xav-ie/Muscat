import { SVG_NS, layers } from "../state.js";
import { iconSquare } from "./iconSquare.js";
import type { IconTheme } from "./iconSquare.js";
import type { ArrowDir } from "../svg/primitives.js";

// One quadlet: 2x2 grid of icon squares with 4 directional arrows in the gaps
// indicating a cyclic reading flow:  TL → TR → BR → BL → TL  (clockwise)
//   [jester ] → [lute   ]
//      ↑           ↓
//   [feather] ← [crystal]
export function quadlet(
  x: number,
  y: number,
  sq: number,
  theme: IconTheme,
): void {
  const gap = sq * 0.18; // gap between the 2x2 squares
  const iconKeys: string[][] = [
    ["jester", "lute"],
    ["feather", "crystal"],
  ];
  // Each square's outgoing arrow is now MERGED into its own path (in
  // squareWithArrowPath), so the arrow inherits the square's papyrus
  // outline, the same fill color, and the printed-on-paper inset shadow
  // around the union perimeter.  The apex stops exactly at the
  // destination square's edge — no bleed past — because the arrow can't
  // visually disconnect from its source under grain-filter displacement
  // (they're the same path).  Cyclic flow TL→TR→BR→BL→TL:
  const arrowDirs: ArrowDir[][] = [
    ["right", "down"], // row 0: TL points right, TR points down
    ["up", "left"], // row 1: BL points up,    BR points left
  ];

  // Wrap the quadlet in a filtered group so the merged shapes get the
  // "printed on paper" effect (multiply-noise + inset edge shadow).
  // Lowered opacity lets the parchment fibers and stains bleed through
  // the colored fill, so the squares read as ink soaked into paper
  // rather than opaque overlays.
  const saved = layers.shapes;
  const inkGroup = document.createElementNS(SVG_NS, "g");
  inkGroup.setAttribute("filter", "url(#printed-on-paper)");
  inkGroup.setAttribute("opacity", "0.80");
  saved!.appendChild(inkGroup);
  layers.shapes = inkGroup;
  try {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        iconSquare(
          x + c * (sq + gap),
          y + r * (sq + gap),
          sq,
          iconKeys[r]![c]!,
          theme,
          arrowDirs[r]![c]!,
        );
      }
    }
  } finally {
    layers.shapes = saved;
  }
}

// Row of `count` quadlets, evenly spaced.  `theme` colors apply to all icons,
// arrows and squares in the row.
export function quadletRow(
  x: number,
  y: number,
  sq: number,
  count: number,
  spanW: number,
  theme: IconTheme,
): void {
  const quadW = sq * 2 + sq * 0.18; // matches gap inside quadlet()
  const totalQuad = quadW * count;
  const gap = (spanW - totalQuad) / (count - 1);
  for (let i = 0; i < count; i++) {
    quadlet(x + i * (quadW + gap), y, sq, theme);
  }
}

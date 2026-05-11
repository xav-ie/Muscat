import { SVG_NS, LINE_W, G, layers, getDefs } from "./state.js";
import { reseed } from "./util/rng.js";
import { svgPath } from "./svg/primitives.js";
import { clear, setupLayers, ensureSvgFont } from "./svg/filters.js";
import { resetTintRegistry } from "./components/icon-square.js";
import { quadletRow } from "./components/quadlet.js";
import { edgeNumber } from "./components/edge-number.js";
import { castle } from "./components/castle.js";
import { terrainBanner } from "./terrain/terrain-banner.js";
import type { IconTheme } from "./components/icon-square.js";

// ─────────────────────────────────────────────────────────────────────
// COMPOSE THE BOARD
// ─────────────────────────────────────────────────────────────────────
export function render(): void {
  reseed(G.seed);
  resetTintRegistry();
  clear();
  ensureSvgFont();
  setupLayers();

  // Layout in mm
  const W = 304.8; // poster width (12 in)
  const H = 457.2; // poster height (18 in)
  const sq = 20; // square size (20mm as specified)
  const quadCount = 5;
  const sectionCount = 4;
  const numFontSize = 24;

  // Quadlet rows + zigzag banners share one (wider) content area.  This is what
  // gives the quadlets enough breathing room to read as separate clusters.
  const contentInset = 30;
  const contentX = contentInset;
  const contentW = W - contentInset * 2;

  // Castle is narrower than the content area — only the castle shrinks to make
  // room for the wider "10" labels, the quadlets/banners are unaffected.
  const castleInset = 38;
  const castleX = castleInset;
  const castleW = W - castleInset * 2;

  // Left numbers are RIGHT-aligned with their right edges anchored just outside
  // the content area; right numbers stay right-aligned at the paper edge.
  // Both anchors are right edges of the text — wider numbers like "10" extend
  // further leftward into the margin.
  const numEdgePad = 4; // gap between number's right edge and content
  const leftNumX = contentInset - numEdgePad;
  const rightNumX = W - 6; // 6mm from the right paper edge

  // ── Castle (positioned near top of page; banner overlaps it like a
  //    mounted sign).  Drawn FIRST so the title banner renders on top.
  const castleH = 95;
  const brickH = castleH * 0.045; // matches merlonH inside castle()
  const topMargin = 6 + brickH; // move castle DOWN one brick height
  castle(castleX, topMargin, castleW, castleH);
  const castleMidY = topMargin + castleH / 2;
  // The left "10" anchors to the CASTLE's left edge (not the wider content
  // area), so it has the same 4mm gap to the castle that "8"/"6"/etc. have to
  // their quadlet rows.  The right "10" stays at the paper-edge anchor.
  const castleLeftNumX = castleInset - numEdgePad;
  edgeNumber(castleLeftNumX, castleMidY, "10", "#111", numFontSize, "end");
  edgeNumber(rightNumX, castleMidY, "10", "#111", numFontSize, "end");

  // ── Title banner — drawn AFTER the castle so it overlays the castle wall.
  //    Positioned to hang across the upper portion of the castle like a
  //    mounted sign / pennant.  Centered horizontally; vertically the
  //    banner straddles the castle's crenellation line.
  const titleH = 18; // banner height in mm (overall, not counting tails)
  const titleW = 130; // banner width — narrower than castle
  // Vertical position: banner moved UP by one brick height from its
  // previous reference (castle-top + 4mm) so it floats higher relative
  // to the castle wall — more of the banner sits ABOVE the merlon line.
  const titleTop = topMargin + 4 - brickH * 2; // up by 2*brickH
  const titleX = (W - titleW) / 2;
  const titleTailLen = 10; // how far each pointed tail extends past the body
  const titleNotch = 6; // depth of the inward V-notch between tails
  const BANNER_FILL = "#5e2a8a"; // medieval purple
  const BANNER_STROKE = "#ffffff"; // white border
  const BANNER_SHADOW = "#2a0a44"; // dark purple inner fold shade

  // Banner body extends from titleX..titleX+titleW; the rectangular middle
  // sits inset from each end by `titleTailLen` so the pointed tails extend
  // OUT past the body.  At each end:
  //   * top tail tip = (body-edge ± tailLen, top)
  //   * bottom tail tip = (body-edge ± tailLen, bottom)
  //   * inward notch tip = (body-edge ∓ notch, mid)
  const tT = titleTop;
  const tB = titleTop + titleH;
  const tM = titleTop + titleH / 2;
  const tL = titleX;
  const tR = titleX + titleW;
  // Body x-range (rectangular middle, between the tail-tip x-positions)
  const bodyL = tL + titleTailLen;
  const bodyR = tR - titleTailLen;
  // Path: start at top-left tail tip, around clockwise.
  const bannerPath =
    `M ${tL} ${tT} ` + // top-left tail tip
    `L ${tR} ${tT} ` + // → top-right tail tip
    `L ${bodyR + titleNotch} ${tM} ` + // ↘ inward to right notch tip
    `L ${tR} ${tB} ` + // ↘ to bottom-right tail tip
    `L ${tL} ${tB} ` + // ← along bottom
    `L ${bodyL - titleNotch} ${tM} ` + // ↗ inward to left notch tip
    `Z`; // back to start
  // Subtle drop shadow under the banner so it reads as a separate object
  // floating above the castle wall.
  const titleShadowId = "title-banner-shadow";
  if (!document.querySelector(`#${titleShadowId}`)) {
    const f = document.createElementNS(SVG_NS, "filter");
    f.setAttribute("id", titleShadowId);
    f.setAttribute("x", "-10%");
    f.setAttribute("y", "-10%");
    f.setAttribute("width", "120%");
    f.setAttribute("height", "140%");
    const off = document.createElementNS(SVG_NS, "feOffset");
    off.setAttribute("in", "SourceAlpha");
    off.setAttribute("dx", "0.4");
    off.setAttribute("dy", "0.8");
    off.setAttribute("result", "offA");
    f.append(off);
    const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
    blur.setAttribute("in", "offA");
    blur.setAttribute("stdDeviation", "0.6");
    blur.setAttribute("result", "blurA");
    f.append(blur);
    const ct = document.createElementNS(SVG_NS, "feComponentTransfer");
    ct.setAttribute("in", "blurA");
    const fa = document.createElementNS(SVG_NS, "feFuncA");
    fa.setAttribute("type", "linear");
    fa.setAttribute("slope", "0.45");
    ct.append(fa);
    ct.setAttribute("result", "sh");
    f.append(ct);
    const merge = document.createElementNS(SVG_NS, "feMerge");
    for (const src of ["sh", "SourceGraphic"]) {
      const n = document.createElementNS(SVG_NS, "feMergeNode");
      n.setAttribute("in", src);
      merge.append(n);
    }
    f.append(merge);
    getDefs().append(f);
  }
  // Banner fill + WHITE border
  const bannerEl = svgPath(bannerPath, {
    fill: BANNER_FILL,
    stroke: BANNER_STROKE,
    strokeWidth: LINE_W * 1.5,
  });
  bannerEl.setAttribute("filter", `url(#${titleShadowId})`);
  layers.shapes.append(bannerEl);
  // Title text — Kranky, sized to fit the banner height, centered horizontally
  // within the rectangular body (not extending into the tails).  White text
  // with a subtle dark-purple stroke outline for readability.
  edgeNumber(
    (bodyL + bodyR) / 2,
    tM,
    "Muscat",
    "#ffffff",
    titleH * 0.85,
    "middle",
    { color: BANNER_SHADOW, width: LINE_W },
  );

  // ── Four sections of [quadlet row + terrain banner]
  // Castle moved up + smaller bottom margin + smaller inter-section gap
  // gives each section much more vertical room → bigger terrain banners.
  const sectionTopY = topMargin + castleH + 4;
  const remainingH = H - sectionTopY - 4; // tighter bottom margin
  const sectionH = remainingH / sectionCount;

  const quadletNums = ["8", "6", "4", "2"];
  const bannerNums = ["-4", "-3", "-2", "-1"];
  // Per-section terrain colors (top → bottom: -4 lava, -3 sand, -2 sea, -1 grass)
  const bannerColors: { fill: string; stroke: string }[] = [
    { fill: "#e8521f", stroke: "#7a1a05" }, // lava red / dark magma
    { fill: "#e8c773", stroke: "#7a5a2a" }, // sand yellow / dirt
    { fill: "#3a91c2", stroke: "#0e3450" }, // sea blue / dark ocean
    { fill: "#6fbf3f", stroke: "#1f4a14" }, // grass green / dark green
  ];

  for (let s = 0; s < sectionCount; s++) {
    const sy = sectionTopY + s * sectionH;
    const quadH = sq * 2 + sq * 0.18;
    const bannerY = sy + quadH + 3;
    const bannerH = sectionH - quadH - 6;

    // Quadlet row uses the BANNER STROKE color as the square fill (the
    // darker shade in each section's theme).  Icons / outlines are painted
    // in papyrus so they pop uniformly across every section as one cohesive
    // icon family.  Arrows keep the per-section stroke color so they remain
    // visible against the papyrus background between squares (and they
    // double as a subtle terrain-color cue).
    const PAPYRUS = "#f5e8c4";
    const rowTheme: IconTheme = {
      squareFill: bannerColors[s].stroke,
      iconColor: PAPYRUS,
      outline: PAPYRUS,
    };
    quadletRow(contentX, sy, sq, quadCount, contentW, rowTheme);
    terrainBanner(
      s,
      contentX,
      bannerY,
      contentW,
      bannerH,
      bannerColors[s].fill,
      bannerColors[s].stroke,
    );

    // Edge labels — black for quadlet rows, red for banners.  All same size.
    const quadMidY = sy + quadH / 2;
    const bannerMidY = bannerY + bannerH / 2;
    edgeNumber(leftNumX, quadMidY, quadletNums[s], "#111", numFontSize, "end");
    edgeNumber(rightNumX, quadMidY, quadletNums[s], "#111", numFontSize, "end");
    edgeNumber(
      leftNumX,
      bannerMidY,
      bannerNums[s],
      "#E31D1D",
      numFontSize,
      "end",
    );
    edgeNumber(
      rightNumX,
      bannerMidY,
      bannerNums[s],
      "#E31D1D",
      numFontSize,
      "end",
    );
  }
}

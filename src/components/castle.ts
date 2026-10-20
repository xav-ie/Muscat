import { SVG_NS, LINE_W, layers } from "../state.js";
import { svg } from "../svg/template.js";
import { uid } from "../util/uid.js";
import { svgPath, svgRect, svgLine, roundedRectPath } from "../svg/primitives.js";
import { applyInsetShadow } from "../svg/inset-shadow.js";
import { edgeNumber } from "./edge-number.js";

// Castle at the top of the board.
// Footprint: (x, y) is top-left of the bounding box, (w, h) is the size.
// Many setAttribute calls in this file pass numbers; this wraps them via
// String() at the call site. Hoisted to module scope so it isn't recreated
// per render.
function set(element: Element, k: string, v: string | number): void {
  element.setAttribute(k, String(v));
}

// Built from primitives: an outer silhouette path, an arch, and inner squares.
// `opts.windows` (default true) toggles the flanking window grids — set false
// to render just the towers/wall/door (used by the portfolio-icon extractor).
export function castle(
  x: number,
  y: number,
  w: number,
  h: number,
  options: {
    windows?: boolean;
    bodyScale?: number;
    handleScale?: number;
    handleSpread?: number;
    towerMerlons?: number;
    doorScale?: number;
  } = {},
): void {
  const {
    windows = true,
    bodyScale = 1,
    handleScale = 1,
    handleSpread = 1,
    towerMerlons = 3,
    doorScale = 1,
  } = options;
  // Proportions.  Heights snap to a whole number of brick rows so the bottom
  // row always renders as a full brick (no thin slivers).
  const towerW = w * 0.13;
  // `towerMerlons` = raised bumps across each tower top (default 3). Fewer
  // merlons → wider bricks; the brick ROW height scales to match so bricks grow
  // proportionally (keep their shape) rather than becoming squat.
  const towerSegCount = 2 * towerMerlons - 1; // merlon+crenel segments, M-C-…-M
  const towerBrickW = towerW / towerSegCount;
  const merlonH = h * 0.045 * (5 / towerSegCount); // brick row height, scaled with brick width
  const towerRows = Math.round((h * 1) / merlonH);
  const bodyRows = Math.round((h * 0.78) / merlonH);
  const towerH = towerRows * merlonH;
  const bodyH = bodyRows * merlonH;
  const towerTop = y;
  const groundY = towerTop + towerH;
  const bodyTop = groundY - bodyH;
  // `bodyScale` (<1) narrows just the central body/"meat" — but only the WALL
  // flanking the door.  The door itself keeps its full-size width (its share of
  // the un-scaled body), so shrinking the wall brings the towers in toward the
  // door without shrinking the door.  Towers keep their width; the overall
  // castle width shrinks accordingly, and downstream code uses `x + w` for the
  // right edge, so re-derive `w`.
  const bodyWFull = w - towerW * 2;
  const doorW = bodyWFull * 0.28; // door width — fixed, independent of bodyScale
  const bodyW = doorW + (bodyWFull - doorW) * bodyScale;
  w = towerW * 2 + bodyW;
  const bodyX = x + towerW;

  // Crenellation parameters — square notches across the top edge.  The pattern
  // is M-C-M-C-...-M (always starting and ending with a merlon) so the corners
  // of every parapet read as raised bumps.  Pass the desired merlonCount per
  // section to control how many bumps appear.
  function crenellate(
    x0: number,
    x1: number,
    topY: number,
    merlonCount: number,
  ): [number, number][] {
    const segCount = 2 * merlonCount - 1; // M C M C ... M
    const segW = (x1 - x0) / segCount;
    // Index parity → y: even = merlon top, odd = crenel floor. Looked up by
    // `parity` and `1 - parity` to get the segment's y and its step-into-next.
    const yByParity = [topY, topY + merlonH];
    const pts: [number, number][] = [[x0, yByParity[0]]];
    for (let index = 0; index < segCount; index++) {
      const segEnd = x0 + (index + 1) * segW;
      const parity = index % 2;
      pts.push([segEnd, yByParity[parity]]);
      // Vertical step into the next segment (skip after the final segment).
      if (index < segCount - 1) pts.push([segEnd, yByParity[1 - parity]]);
    }
    return pts;
  }

  // Build full outline as a single path so rough.js draws a unified silhouette.
  // Side walls reach all the way up to merlon level so the corners ARE merlons,
  // not crenels.
  //
  // BRICK GRID: each tower has `towerMerlons` merlons → (2·n−1) segments — so
  // brickW = towerW / segCount.  We pick the body's merlon count so its segments
  // are about the same width — one consistent brick grid across the whole wall.
  const brickH = merlonH; // brick row = merlon height
  // Round body to the nearest valid odd segment count given a brick close to
  // the tower brick width
  const bodySegCount = Math.max(3, Math.round(bodyW / towerBrickW / 2) * 2 + 1);
  const bodyMerlons = (bodySegCount + 1) / 2;
  const bodyBrickW = bodyW / bodySegCount;

  // Build full outline as a single path so rough.js draws a unified
  // silhouette. Side walls reach all the way up to merlon level so the
  // corners ARE merlons, not crenels.
  function buildSilhouettePath(): string {
    let result = svg`M ${x} ${groundY} L ${x} ${towerTop}`;
    for (const [px, py] of crenellate(x, x + towerW, towerTop, towerMerlons)) {
      result += svg` L ${px} ${py}`;
    }
    result += svg` L ${x + towerW} ${bodyTop}`;
    for (const [px, py] of crenellate(x + towerW, x + towerW + bodyW, bodyTop, bodyMerlons)) {
      result += svg` L ${px} ${py}`;
    }
    result += svg` L ${x + towerW + bodyW} ${towerTop}`;
    for (const [px, py] of crenellate(x + towerW + bodyW, x + w, towerTop, towerMerlons)) {
      result += svg` L ${px} ${py}`;
    }
    return result + svg` L ${x + w} ${groundY} Z`;
  }
  const d = buildSilhouettePath();

  // Color: castle outline (darker gray, since the towers now have a 3D
  // gradient that visually delineates them on their own).
  const CASTLE_STROKE = "#6a6a6a"; // a touch darker than BRICK_GROUT (#7a7a7a)
  const BRICK_FILL = "#b8b6b1"; // gray brick body
  const BRICK_GROUT = "#7a7a7a"; // light gray mortar (matches other lines in tone)

  // ── Brick fill of the castle silhouette ──
  // Each section (left tower, body, right tower) is painted by paintBricks()
  // below, clipped to its own column, so the merlon row is the top row of
  // bricks and each section keeps its own brick width.

  // Build a <defs> just for this castle (the section clip paths).  Living
  // inside the SVG, not the top-level defs, keeps the coordinates
  // self-contained: change the castle position and the clips follow.
  const localDefs = document.createElementNS(SVG_NS, "defs");

  // Clip paths so each fill region stays within its column.  Easier than the
  // full silhouette: clip to a simple rectangle per section (left tower,
  // body, right tower).  The silhouette outline drawn after will mask any
  // overflow visually.
  function clipRectId(
    idSuffix: string,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
  ): SVGClipPathElement {
    const cp = document.createElementNS(SVG_NS, "clipPath");
    cp.setAttribute("id", idSuffix);
    const r = document.createElementNS(SVG_NS, "rect");
    set(r, "x", rx);
    set(r, "y", ry);
    set(r, "width", rw);
    set(r, "height", rh);
    cp.append(r);
    return cp;
  }
  const ltClipId = uid("cliptl");
  const bClipId = uid("clipb");
  const rtClipId = uid("cliprt");
  localDefs.append(clipRectId(ltClipId, x, towerTop, towerW, h));
  localDefs.append(clipRectId(bClipId, x + towerW, bodyTop, bodyW, h - (bodyTop - towerTop)));
  localDefs.append(clipRectId(rtClipId, x + towerW + bodyW, towerTop, towerW, h));
  layers.shapes.append(localDefs);

  // Brick fill: instead of tiling a pattern (which causes subtle tile-boundary
  // artifacts where every other row appears thinner), we draw the bricks
  // explicitly per section.  Each section gets:
  //   - a solid BRICK_FILL rect (clipped to the section's silhouette)
  //   - a single <path> containing every horizontal and vertical grout line,
  //     in absolute coordinates, drawn ONCE — no tile boundaries to worry
  //     about so all rows render identically.
  function paintBricks(
    originX: number,
    originY: number,
    sectionW: number,
    sectionH: number,
    brickW: number,
    clipId: string,
  ): void {
    // Solid fill — clip to silhouette
    const fillPath = document.createElementNS(SVG_NS, "path");
    fillPath.setAttribute("d", d);
    fillPath.setAttribute("fill", BRICK_FILL);
    fillPath.setAttribute("clip-path", `url(#${clipId})`);
    layers.shapes.append(fillPath);

    // Build grout lines explicitly.  Skip lines that would land exactly on
    // the section's TOP edge (towerTop) or BOTTOM edge (groundY) — those
    // overlap the silhouette outline and produce visible artifacts.  Same
    // stroke width as every other line in the design (LINE_W).
    const numberRows = Math.ceil(sectionH / brickH) + 1;
    const numberCols = Math.ceil(sectionW / brickW) + 1;
    const sectionBottomY = originY + sectionH;
    // Tiny inset from each edge so the bricks don't paint right on the
    // silhouette outline (which causes doubled-stroke artifacts).
    const edgeInset = 0.3;
    const bottomStop = sectionBottomY - edgeInset;

    // Vertical grout lines for one brick row (running bond uses rowOffset).
    function rowVerticals(ry0: number, ry1: number, rowOffset: number): string {
      let s = "";
      for (let c = -1; c <= numberCols; c++) {
        const vx = originX + rowOffset + c * brickW;
        s += svg`M ${vx} ${ry0} L ${vx} ${ry1} `;
      }
      return s;
    }
    // Horizontal grout lines: one BETWEEN each pair of brick rows. Skip r=0
    // (= section top) and any line at/below the section bottom.
    function buildHorizontals(): string {
      let s = "";
      for (let r = 1; r < numberRows; r++) {
        const ry = originY + r * brickH;
        if (ry >= bottomStop) break;
        s += svg`M ${originX} ${ry} L ${originX + sectionW} ${ry} `;
      }
      return s;
    }
    // Vertical grout: alternate offset per row (running bond). Skip the
    // bottom partial row so verticals don't touch the silhouette outline.
    function buildVerticals(): string {
      let s = "";
      for (let r = 0; r < numberRows; r++) {
        const ry0 = originY + r * brickH;
        const ry1 = ry0 + brickH;
        if (ry1 > bottomStop) break;
        s += rowVerticals(ry0, ry1, r % 2 === 0 ? 0 : brickW / 2);
      }
      return s;
    }
    const grout = buildHorizontals() + buildVerticals();
    const groutPath = document.createElementNS(SVG_NS, "path");
    groutPath.setAttribute("d", grout);
    groutPath.setAttribute("stroke", BRICK_GROUT);
    set(groutPath, "stroke-width", LINE_W);
    groutPath.setAttribute("stroke-linecap", "round");
    groutPath.setAttribute("stroke-linejoin", "round");
    groutPath.setAttribute("fill", "none");
    groutPath.setAttribute("clip-path", `url(#${clipId})`);
    layers.shapes.append(groutPath);
  }

  paintBricks(x, towerTop, towerW, h, towerBrickW, ltClipId);
  paintBricks(x + towerW, bodyTop, bodyW, h - (bodyTop - towerTop), bodyBrickW, bClipId);
  paintBricks(x + towerW + bodyW, towerTop, towerW, h, towerBrickW, rtClipId);

  // 3D illusion on the towers — each tower gets its OWN horizontal gradient
  // in user-space coordinates, going dark → transparent → dark across its
  // full width.  At 50% black opacity the effect is subtle but clearly
  // suggests cylindrical shading.
  function makeTowerGradient(id: string, x0: number, x1: number): SVGLinearGradientElement {
    const g = document.createElementNS(SVG_NS, "linearGradient");
    g.setAttribute("id", id);
    g.setAttribute("gradientUnits", "userSpaceOnUse");
    set(g, "x1", x0);
    set(g, "y1", 0);
    set(g, "x2", x1);
    set(g, "y2", 0);
    const stops: [number, string, number][] = [
      [0, "#000", 0.18],
      [0.5, "#000", 0],
      [1, "#000", 0.18],
    ];
    for (const [offset, color, opacity] of stops) {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", svg`${offset * 100}%`);
      s.setAttribute("stop-color", color);
      set(s, "stop-opacity", opacity);
      g.append(s);
    }
    return g;
  }
  const leftGradId = uid("lgrad");
  const rightGradId = uid("rgrad");
  localDefs.append(makeTowerGradient(leftGradId, x, x + towerW));
  localDefs.append(makeTowerGradient(rightGradId, x + towerW + bodyW, x + w));

  function towerOverlayClipped(clipId: string, gradId: string): void {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", `url(#${gradId})`);
    p.setAttribute("clip-path", `url(#${clipId})`);
    layers.shapes.append(p);
  }
  towerOverlayClipped(ltClipId, leftGradId);
  towerOverlayClipped(rtClipId, rightGradId);

  // Outer outline — drawn AFTER bricks AND gradient so it sits on top.
  // Per user request: thinner outline weight (LINE_W * 0.85) since the tower
  // gradient now does most of the visual delineation.
  layers.shapes.append(
    svgPath(d, {
      fill: "none",
      stroke: CASTLE_STROKE,
      strokeWidth: LINE_W * 0.85,
    }),
  );

  // Inner vertical lines at the tower–body seams.  These run from the body's
  // roof level (merlon top — same level as where the silhouette steps down)
  // to the ground, making the towers read as distinct columns.
  const leftSeamX = x + towerW;
  const rightSeamX = x + towerW + bodyW;
  for (const sx of [leftSeamX, rightSeamX]) {
    layers.shapes.append(
      svgLine(sx, bodyTop, sx, groundY, {
        stroke: CASTLE_STROKE,
        strokeWidth: LINE_W * 0.85,
      }),
    );
  }

  // Arched doorway in the center of the body — TWO doors meeting at a center
  // seam, each rendered by the door() primitive.  The wood pattern tiles from
  // the seam outward so plank dividers line up across both doors.
  const archW = doorW;
  const archH = bodyH * 0.65;
  const archX = bodyX + (bodyW - archW) / 2;
  const archY = groundY - archH;
  const seamX = archX + archW / 2;
  // Path geometry shared by both halves: the full arch. The top is a true
  // half-ellipse (oval) rather than a quadratic corner — straight sides up to
  // the springline (0.45·archH below the crown), then an elliptical arc over.
  const archSpringY = archY + archH * 0.45; // where the straight side meets the curve
  const archRise = archSpringY - archY; // = archH * 0.45
  const archD = [
    svg`M ${archX} ${groundY}`,
    svg`L ${archX} ${archSpringY}`,
    svg`A ${archW / 2} ${archRise} 0 0 1 ${archX + archW} ${archSpringY}`,
    svg`L ${archX + archW} ${groundY}`,
  ].join(" ");

  // Each half-door is the full arch path, clipped to its half via a clip rect.
  // The wood pattern's `patternTransform` translates so x=0 of the tile sits
  // at the seam — both halves anchor from the same seam, so plank dividers
  // line up across.
  function door(halfClipId: string, flip: boolean): void {
    // Wood pattern is already in top-level defs; reusing it directly anchors
    // from (0,0) which is wrong.  Make a per-door pattern instance with a
    // shifted patternTransform so x=0 of the tile sits at the seam.
    const patId = uid("wood-" + (flip ? "r" : "l"));
    const reference = document.createElementNS(SVG_NS, "pattern");
    reference.setAttribute("id", patId);
    reference.setAttribute("href", "#wood");
    // For the left half: pattern's x=0 should land at the seam, which means
    // translating the tile origin to (seamX, 0).  For the right half: same
    // (so the first divider on the inner edge is at the seam).
    reference.setAttribute("patternTransform", svg`translate(${seamX} 0)`);
    localDefs.append(reference);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", archD);
    path.setAttribute("fill", `url(#${patId})`);
    path.setAttribute("clip-path", `url(#${halfClipId})`);
    layers.shapes.append(path);
  }
  // Two clip rects: left half from archX to seamX, right half from seamX to archX+archW.
  const dlClipId = uid("doorL");
  const drClipId = uid("doorR");
  localDefs.append(clipRectId(dlClipId, archX, archY, archW / 2, archH));
  localDefs.append(clipRectId(drClipId, seamX, archY, archW / 2, archH));

  // Brick frame around the door — like a window sill, but tracing the arch.
  // Built as a wider, taller arch path drawn BEFORE the doors so the doors
  // and outline cover its inner edge, leaving only the outer band visible.
  const frameThickness = archW * 0.06 * doorScale;
  const fArchX = archX - frameThickness;
  const fArchY = archY - frameThickness;
  const fArchW = archW + frameThickness * 2;
  const fArchH = archH + frameThickness; // grows up only; bottom stays on groundY
  const fPeakX = fArchX + fArchW / 2;
  const fPeakY = fArchY;
  void fPeakX;
  void fPeakY;
  const fSpringY = fArchY + fArchH * 0.45;
  const fRise = fSpringY - fArchY;
  const frameD = [
    svg`M ${fArchX} ${groundY}`,
    svg`L ${fArchX} ${fSpringY}`,
    svg`A ${fArchW / 2} ${fRise} 0 0 1 ${fArchX + fArchW} ${fSpringY}`,
    svg`L ${fArchX + fArchW} ${groundY}`,
  ].join(" ");
  // Filled gray (brick color)
  const frameFill = document.createElementNS(SVG_NS, "path");
  frameFill.setAttribute("d", frameD);
  frameFill.setAttribute("fill", BRICK_FILL);
  // Role tag so the preview can recolour the frame apart from the same-hex walls.
  frameFill.dataset.part = "arch-frame";
  layers.shapes.append(frameFill);

  // Frame gets a soft inset shadow — light center (the stone color shows
  // through), gentle darkening just inside the outer outline.  Combined
  // with a centerline highlight (radial gradient lighter in the middle)
  // for a "raised stone band" look.
  const frameHighlightId = uid("framehl");
  const frameHl = document.createElementNS(SVG_NS, "radialGradient");
  frameHl.setAttribute("id", frameHighlightId);
  frameHl.setAttribute("cx", "50%");
  frameHl.setAttribute("cy", "60%");
  frameHl.setAttribute("r", "60%");
  frameHl.setAttribute("fx", "50%");
  frameHl.setAttribute("fy", "60%");
  for (const [offset, op] of [
    [0, 0.45],
    [0.6, 0],
  ] as [number, number][]) {
    const s = document.createElementNS(SVG_NS, "stop");
    s.setAttribute("offset", svg`${offset * 100}%`);
    s.setAttribute("stop-color", "#ffffff");
    set(s, "stop-opacity", op);
    frameHl.append(s);
  }
  localDefs.append(frameHl);
  // Apply highlight via a clipped rect (clipped to frame path)
  const frameClipId = uid("frameclip");
  const frameClip = document.createElementNS(SVG_NS, "clipPath");
  frameClip.setAttribute("id", frameClipId);
  const frameClipPath = document.createElementNS(SVG_NS, "path");
  frameClipPath.setAttribute("d", frameD);
  frameClip.append(frameClipPath);
  localDefs.append(frameClip);
  const frameHlRect = document.createElementNS(SVG_NS, "rect");
  set(frameHlRect, "x", fArchX);
  set(frameHlRect, "y", fArchY);
  set(frameHlRect, "width", fArchW);
  set(frameHlRect, "height", groundY - fArchY);
  frameHlRect.setAttribute("fill", `url(#${frameHighlightId})`);
  frameHlRect.setAttribute("clip-path", `url(#${frameClipId})`);
  layers.shapes.append(frameHlRect);
  // ── Frame relief shading ──
  // Shade the arch band to match its geometry so it reads as a rounded stone
  // molding rather than a flat gray blob: an elliptical RADIAL gradient over
  // the curved TOP and a LINEAR gradient down each straight SIDE. Each runs
  // dark → stone → dark across the band, so both the outer rim and the inner
  // (door) edge are shadowed while the centre stays the (opaque) stone colour.
  const FRAME_SHADOW = "#2a2a2a";
  const FRAME_SHADOW_OPACITY = 0.44;
  // Offset (0 = outer rim, 1 = inner/door edge) at which the SIDE gradient's
  // outer dark fades to clear. The outer dark holds as a short plateau first
  // (SIDE_OUTER_PLATEAU × this) so it reads as a defined band — matching the
  // top's crispness — rather than one long gradual (blurry-looking) fade.
  const SIDE_OUTER_POS = 0.43;
  const SIDE_OUTER_PLATEAU = 0.55;
  // How far (mm) the side (linear) region starts ABOVE the springline, so it
  // overlaps the top (radial) region — lets the two blend across the join.
  const SIDE_TOP_OVERLAP = 0;
  const shoulderY = fArchY + fArchH * 0.45; // where the arch curve meets the sides
  // Inner edge of the band is geometrically at archW/fArchW ≈ 0.89; nudged in
  // slightly (tuned) so the top's inner shadow sits right on the door line.
  const innerFrac = 0.87;
  const midFrac = (innerFrac + 1) / 2;

  function shadowStops(grad: SVGGradientElement, pairs: [number, number, string][]): void {
    for (const [offset, op, color] of pairs) {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", svg`${offset * 100}%`);
      s.setAttribute("stop-color", color);
      set(s, "stop-opacity", op);
      grad.append(s);
    }
  }

  const frameShadowG = document.createElementNS(SVG_NS, "g");
  frameShadowG.setAttribute("clip-path", `url(#${frameClipId})`);
  // Soften the join where the top (radial) and side (linear) gradients meet at
  // the springline — a small blur blends the two so there's no hard seam. It's
  // applied before the band clip, so the shadow still ends crisply at the band
  // edges rather than bleeding onto the door/wall.
  const seamBlurId = uid("frameseamblur");
  const seamBlur = document.createElementNS(SVG_NS, "filter");
  seamBlur.setAttribute("id", seamBlurId);
  seamBlur.setAttribute("x", "-15%");
  seamBlur.setAttribute("y", "-15%");
  seamBlur.setAttribute("width", "130%");
  seamBlur.setAttribute("height", "130%");
  const seamBlurNode = document.createElementNS(SVG_NS, "feGaussianBlur");
  set(seamBlurNode, "stdDeviation", frameThickness * 0.22);
  seamBlur.append(seamBlurNode);
  localDefs.append(seamBlur);
  frameShadowG.setAttribute("filter", `url(#${seamBlurId})`);

  // Top: an elliptical radial shadow whose ellipse matches the ARCH itself —
  // centered on the arch's springline (where the curve meets the sides) with
  // radii equal to the arch's half-width and rise. Its iso-lines then run
  // parallel to the door's curved top, so the shading follows that contour.
  const archRx = fArchW / 2; // horizontal radius of the arch
  const archRy = shoulderY - fArchY; // vertical rise from springline to crown
  const topShId = uid("frametop");
  const topSh = document.createElementNS(SVG_NS, "radialGradient");
  topSh.setAttribute("id", topShId);
  topSh.setAttribute("gradientUnits", "userSpaceOnUse");
  set(topSh, "cx", fPeakX);
  set(topSh, "cy", shoulderY);
  set(topSh, "r", archRx);
  const sy = archRy / archRx; // squash the circle into the arch's ellipse
  topSh.setAttribute("gradientTransform", svg`matrix(1 0 0 ${sy} 0 ${shoulderY * (1 - sy)})`);
  // Dark at the inner + outer band edges (radial offsets innerFrac and 1),
  // transparent through the middle.
  shadowStops(topSh, [
    [0, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
    [innerFrac, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
    [midFrac, 1, BRICK_FILL],
    [1, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
  ]);
  localDefs.append(topSh);
  const topRect = document.createElementNS(SVG_NS, "rect");
  set(topRect, "x", fArchX);
  set(topRect, "y", fArchY);
  set(topRect, "width", fArchW);
  set(topRect, "height", shoulderY - fArchY);
  topRect.setAttribute("fill", `url(#${topShId})`);
  frameShadowG.append(topRect);

  // Sides: a horizontal linear gradient per column, dark at both the outer and
  // inner edges and clear in the middle — gives each side a rounded, beveled look.
  function sideShadow(outerX: number, innerX: number, colX: number): void {
    const id = uid("frameside");
    const lin = document.createElementNS(SVG_NS, "linearGradient");
    lin.setAttribute("id", id);
    lin.setAttribute("gradientUnits", "userSpaceOnUse");
    set(lin, "x1", outerX);
    set(lin, "y1", 0);
    set(lin, "x2", innerX);
    set(lin, "y2", 0);
    shadowStops(lin, [
      [0, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
      [SIDE_OUTER_POS * SIDE_OUTER_PLATEAU, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
      [SIDE_OUTER_POS, 1, BRICK_FILL],
      [1, FRAME_SHADOW_OPACITY, FRAME_SHADOW],
    ]);
    localDefs.append(lin);
    const r = document.createElementNS(SVG_NS, "rect");
    set(r, "x", colX);
    set(r, "y", shoulderY - SIDE_TOP_OVERLAP);
    set(r, "width", frameThickness * 2.5);
    set(r, "height", groundY - (shoulderY - SIDE_TOP_OVERLAP));
    r.setAttribute("fill", `url(#${id})`);
    frameShadowG.append(r);
  }
  // Span the gradient across (nearly) the full band width so both the outer and
  // inner edges are shadowed and the middle stays lit.
  const sideSpan = 1.05;
  // Left column: outer edge = fArchX, inner edge one span in.
  sideShadow(fArchX, fArchX + frameThickness * sideSpan, fArchX);
  // Right column: outer edge = fArchX + fArchW, inner edge one span in.
  sideShadow(
    fArchX + fArchW,
    fArchX + fArchW - frameThickness * sideSpan,
    fArchX + fArchW - frameThickness * 2.5,
  );

  layers.shapes.append(frameShadowG);

  layers.shapes.append(
    svgPath(frameD, {
      fill: "none",
      stroke: CASTLE_STROKE,
      strokeWidth: LINE_W * doorScale,
    }),
  );

  door(dlClipId, false);
  door(drClipId, true);

  // Plank dividers — drawn as continuous full-height lines from archY to
  // groundY, anchored at seamX so they align with the wood pattern.  The
  // pattern's vertical dividers were removed because they suffered the same
  // tile-boundary thickness artifacts the bricks did; drawing one continuous
  // line per divider eliminates the issue.  Each line is clipped to the
  // arch silhouette so divisions don't poke past the door edges.
  const plankClipId = uid("plankclip");
  const plankClip = document.createElementNS(SVG_NS, "clipPath");
  plankClip.setAttribute("id", plankClipId);
  const plankClipPath = document.createElementNS(SVG_NS, "path");
  plankClipPath.setAttribute("d", archD);
  plankClip.append(plankClipPath);
  localDefs.append(plankClip);

  // Build all dividers and horizontal joints as a single path so the stroke
  // renders as one pass (consistent thickness, no pattern artifacts).
  const PLANK_W = 6 * doorScale;
  const TILE_H = 24 * doorScale;

  // Joint y-positions for one plank. Even-indexed planks: TILE_H, 2*TILE_H...
  // Odd-indexed: TILE_H/2, 3*TILE_H/2... — matches the original pattern's
  // running-bond stagger.
  function plankJoints(plankLeftX: number, plankRightX: number, parity: number): string {
    let dString = "";
    const firstJy = parity === 0 ? TILE_H : TILE_H * 0.5;
    for (let jy = firstJy; jy < groundY; jy += TILE_H) {
      if (jy <= archY) continue;
      dString += svg`M ${plankLeftX} ${jy} L ${plankRightX} ${jy} `;
    }
    return dString;
  }

  // Vertical plank dividers at every PLANK_W from the seam outward.
  function buildPlankVerticals(): string {
    let result = "";
    for (let dx = 0; seamX - dx >= archX - PLANK_W; dx += PLANK_W) {
      const px = seamX - dx;
      result += svg`M ${px} ${archY} L ${px} ${groundY} `;
    }
    for (let dx = PLANK_W; seamX + dx <= archX + archW + PLANK_W; dx += PLANK_W) {
      const px = seamX + dx;
      result += svg`M ${px} ${archY} L ${px} ${groundY} `;
    }
    return result;
  }
  // Per-plank horizontal joints (running-bond stagger). Plank index n: x
  // range [seamX + n*PLANK_W, seamX + (n+1)*PLANK_W]. Right of seam: n ≥ 0;
  // left of seam: n ≤ -1. Stop when the plank is fully outside the door.
  function buildPlankHorizontals(): string {
    let result = "";
    for (let n = 0; seamX + n * PLANK_W <= archX + archW; n++) {
      const lx = seamX + n * PLANK_W;
      result += plankJoints(lx, lx + PLANK_W, ((n % 2) + 2) % 2);
    }
    for (let n = -1; seamX + (n + 1) * PLANK_W >= archX; n--) {
      const lx = seamX + n * PLANK_W;
      result += plankJoints(lx, lx + PLANK_W, ((n % 2) + 2) % 2);
    }
    return result;
  }
  const plankD = buildPlankVerticals() + buildPlankHorizontals();

  const plankPath = document.createElementNS(SVG_NS, "path");
  plankPath.setAttribute("d", plankD);
  plankPath.setAttribute("stroke", "#4a3520");
  set(plankPath, "stroke-width", 0.5 * doorScale);
  plankPath.setAttribute("fill", "none");
  plankPath.setAttribute("clip-path", `url(#${plankClipId})`);
  layers.shapes.append(plankPath);

  // ── Door shadows ──
  // Tunables shared by both shadow systems (inset all-edges + seam linear).
  const DOOR_SHADOW_COLOR = "#2a1408";
  const DOOR_SHADOW_OPACITY = 0.4;
  // Vertical fade for the seam gradient (chosen values, hard-coded):
  //   fadeEnd    = 0.20 → seam reaches full opacity ~20% down from the top
  //   fadeSpread = 1.00 → fade STARTS at the very top, ramps in continuously
  // The fade STARTS at (fadeEnd - fadeSpread) and ENDS at fadeEnd.  Above
  // fadeStart the gradient is fully hidden.
  const fadeEnd = 0.2;
  const fadeSpread = 1;
  const fadeStart = Math.max(0, fadeEnd - fadeSpread);

  // 1. Inset shadow extending from ALL edges of the arch silhouette,
  //    matching the window treatment — emphasizes the arched shape from
  //    every edge (curved top, sides, floor).
  applyInsetShadow(layers.shapes, archD, localDefs, {
    color: DOOR_SHADOW_COLOR,
    thickness: archW * 0.22,
    blur: archW * 0.05,
    opacity: DOOR_SHADOW_OPACITY,
  });

  // 2. Per-door inner-edge (seam) linear gradient shadows.  Each gradient is
  //    clipped to its door half so it only paints on that door, AND masked
  //    by a vertical fade that hides the gradient near the curved top.
  //    That fade prevents the seam shadow from compounding with the curved-
  //    top inset shadow.
  // Build the mask once — both seam gradients share it.
  const seamFadeMaskId = uid("seamfade");
  const seamFadeMask = document.createElementNS(SVG_NS, "mask");
  seamFadeMask.setAttribute("id", seamFadeMaskId);
  seamFadeMask.setAttribute("maskUnits", "userSpaceOnUse");
  set(seamFadeMask, "x", archX);
  set(seamFadeMask, "y", archY);
  set(seamFadeMask, "width", archW);
  set(seamFadeMask, "height", archH);
  // Mask gradient: black (hidden) at the very top, white (shown) by
  // archY + archH * DOOR_FADE_END_FRAC, then white all the way down.
  // The longer fade range means the seam shadow ramps in gradually rather
  // than appearing abruptly partway down the door.
  const seamFadeGradId = uid("seamfadegrad");
  const seamFadeGrad = document.createElementNS(SVG_NS, "linearGradient");
  seamFadeGrad.setAttribute("id", seamFadeGradId);
  seamFadeGrad.setAttribute("gradientUnits", "userSpaceOnUse");
  set(seamFadeGrad, "x1", 0);
  set(seamFadeGrad, "y1", archY);
  set(seamFadeGrad, "x2", 0);
  set(seamFadeGrad, "y2", archY + archH);
  for (const [offset, color] of [
    [0, "black"], // top: hidden
    [fadeStart, "black"], // remain hidden up to fadeStart
    [fadeEnd, "white"], // visible by fadeEnd
    [1, "white"], // bottom: visible
  ] as [number, string][]) {
    const s = document.createElementNS(SVG_NS, "stop");
    s.setAttribute("offset", svg`${offset * 100}%`);
    s.setAttribute("stop-color", color);
    seamFadeGrad.append(s);
  }
  localDefs.append(seamFadeGrad);
  const seamFadeRect = document.createElementNS(SVG_NS, "rect");
  set(seamFadeRect, "x", archX);
  set(seamFadeRect, "y", archY);
  set(seamFadeRect, "width", archW);
  set(seamFadeRect, "height", archH);
  seamFadeRect.setAttribute("fill", `url(#${seamFadeGradId})`);
  seamFadeMask.append(seamFadeRect);
  localDefs.append(seamFadeMask);

  function doorEdgeGradient(
    idSuffix: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    halfClipId: string,
    opacity: number,
    fadeFrac: number,
  ): void {
    const lin = document.createElementNS(SVG_NS, "linearGradient");
    const id = uid(`dooredge-${idSuffix}`);
    lin.setAttribute("id", id);
    lin.setAttribute("gradientUnits", "userSpaceOnUse");
    set(lin, "x1", x1);
    set(lin, "y1", y1);
    set(lin, "x2", x2);
    set(lin, "y2", y2);
    // Sharp dark at the edge, fading to clear by `fadeFrac` of the way along
    for (const [offset, op] of [
      [0, opacity],
      [fadeFrac, 0],
    ] as [number, number][]) {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", svg`${offset * 100}%`);
      s.setAttribute("stop-color", DOOR_SHADOW_COLOR);
      set(s, "stop-opacity", op);
      lin.append(s);
    }
    localDefs.append(lin);
    const r = document.createElementNS(SVG_NS, "rect");
    set(r, "x", archX);
    set(r, "y", archY);
    set(r, "width", archW);
    set(r, "height", archH);
    r.setAttribute("fill", `url(#${id})`);
    r.setAttribute("clip-path", `url(#${halfClipId})`);
    // Apply the vertical fade mask so the gradient fades out toward the
    // curved-top region (avoids compounding with the inset shadow there).
    r.setAttribute("mask", `url(#${seamFadeMaskId})`);
    layers.shapes.append(r);
  }
  // Left door: seam is on the RIGHT edge of the half.  Gradient runs from
  // seam (dark) leftward (clear).  Spread = 0.20 of arch width — chosen value.
  doorEdgeGradient("l-seam", seamX, 0, seamX - archW * 0.2, 0, dlClipId, DOOR_SHADOW_OPACITY, 1);
  // Right door: seam is on the LEFT edge of the half.
  doorEdgeGradient("r-seam", seamX, 0, seamX + archW * 0.2, 0, drClipId, DOOR_SHADOW_OPACITY, 1);

  // Outline on top
  layers.shapes.append(
    svgPath(archD, {
      fill: "none",
      stroke: CASTLE_STROKE,
      strokeWidth: LINE_W * doorScale,
    }),
  );

  // Gold ring handles — one on each door, positioned near the inner edge
  // (close to the seam) at a comfortable hand height.
  const handleY = groundY - archH * 0.5;
  const handleR = archW * 0.045 * handleScale;
  const handleInset = archW * 0.1 * handleSpread; // distance from seam toward each door's outer edge
  // Soft drop shadow so the gold rings lift off the door and stay legible.
  const ringShadowId = uid("ringshadow");
  const ringShadow = document.createElementNS(SVG_NS, "filter");
  ringShadow.setAttribute("id", ringShadowId);
  ringShadow.setAttribute("x", "-60%");
  ringShadow.setAttribute("y", "-60%");
  ringShadow.setAttribute("width", "220%");
  ringShadow.setAttribute("height", "220%");
  const ringDrop = document.createElementNS(SVG_NS, "feDropShadow");
  set(ringDrop, "dx", 0);
  set(ringDrop, "dy", handleR * 0.16);
  set(ringDrop, "stdDeviation", handleR * 0.22);
  ringDrop.setAttribute("flood-color", "#000000");
  ringDrop.setAttribute("flood-opacity", "0.55");
  ringShadow.append(ringDrop);
  localDefs.append(ringShadow);
  function doorHandle(cx: number, cy: number, r: number): void {
    // Group the ring parts so one drop shadow lifts the whole handle.
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("filter", `url(#${ringShadowId})`);
    // Thicker gold ring: outer dark-gold stroke, inner highlight stroke
    const ring = document.createElementNS(SVG_NS, "circle");
    set(ring, "cx", cx);
    set(ring, "cy", cy);
    set(ring, "r", r);
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "#caa030"); // gold body
    set(ring, "stroke-width", r * 0.45);
    g.append(ring);
    // Highlight – inner thin lighter ring for a hint of metallic shine
    const hi = document.createElementNS(SVG_NS, "circle");
    set(hi, "cx", cx);
    set(hi, "cy", cy);
    set(hi, "r", r * 0.85);
    hi.setAttribute("fill", "none");
    hi.setAttribute("stroke", "#f4d65a");
    set(hi, "stroke-width", r * 0.1);
    g.append(hi);
    // Mounting plate: small dark anchor where the ring attaches to the door
    const anchor = document.createElementNS(SVG_NS, "circle");
    set(anchor, "cx", cx);
    set(anchor, "cy", cy - r);
    set(anchor, "r", r * 0.18);
    anchor.setAttribute("fill", "#8a6f1c");
    g.append(anchor);
    layers.shapes.append(g);
  }
  doorHandle(seamX - handleInset, handleY, handleR);
  doorHandle(seamX + handleInset, handleY, handleR);

  // Small squares inside the body, flanking the arch.
  // Windows are deep sky blue with a wider-clear-middle "box gradient" cushion
  // shade (darker at all four edges, brighter in the center).  The sill below
  // each window matches the brick color and gets a gentle matching gradient.
  // Sized to match the 20mm icon-tile dimension used everywhere else on the
  // board so the castle visually keys to the same grid as the quadlet rows.
  const sqSize = 20;
  const sqGap = sqSize * 0.18;
  const sqRowY1 = bodyTop + bodyH * 0.3;
  const sqRowY2 = sqRowY1 + sqSize + sqGap;

  const WINDOW_BLUE = "#3da5e0"; // deep sky blue base
  const WINDOW_OUTLINE = "#0a3a6b"; // matching dark blue outline
  const WINDOW_OPACITY = 0.65; // semi-transparent — reveals interior bricks
  // Interior bricks — nearly black to read as a deep, shadowed cavity
  // behind the glass.  A faint warm tint keeps the texture from looking
  // like a flat patch of paint.
  const INTERIOR_BRICK = "#0a0806";
  const INTERIOR_GROUT = "#020101";
  // Outer body bricks are ≈ 5.84 × 4.28 mm.  Shrink both interior axes by
  // ~70% so the interior bricks look like the same wall seen from further
  // away.  Previously only the height was reduced, which made interior
  // bricks read as too wide.
  const INTERIOR_BRICK_W = 4;
  const INTERIOR_BRICK_H = 3;

  // Horizontal grout lines across the window's full width, one per row
  // boundary.  Skips the row at y=0 (which would lie on the window border).
  function interiorHorizontals(sx: number, sy: number, size: number): string {
    const numberRows = Math.ceil(size / INTERIOR_BRICK_H) + 1;
    let result = "";
    for (let r = 1; r < numberRows; r++) {
      const ry = sy + r * INTERIOR_BRICK_H;
      if (ry >= sy + size) break;
      result += svg`M ${sx} ${ry} L ${sx + size} ${ry} `;
    }
    return result;
  }

  // Vertical grout lines for one row of bricks, offset by `rowOffset` for
  // the running-bond stagger.
  function interiorRowVerticals(
    sx: number,
    size: number,
    ry0: number,
    ry1: number,
    rowOffset: number,
  ): string {
    const numberCols = Math.ceil(size / INTERIOR_BRICK_W) + 1;
    let result = "";
    for (let c = -1; c <= numberCols; c++) {
      const vx = sx + rowOffset + c * INTERIOR_BRICK_W;
      result += svg`M ${vx} ${ry0} L ${vx} ${ry1} `;
    }
    return result;
  }

  // All vertical grout lines for the window — running-bond stagger
  // alternates the row offset every row.
  function interiorVerticals(sx: number, sy: number, size: number): string {
    const numberRows = Math.ceil(size / INTERIOR_BRICK_H) + 1;
    let result = "";
    for (let r = 0; r < numberRows; r++) {
      const ry0 = sy + r * INTERIOR_BRICK_H;
      const ry1 = ry0 + INTERIOR_BRICK_H;
      if (ry1 > sy + size) break;
      const rowOffset = r % 2 === 0 ? 0 : INTERIOR_BRICK_W / 2;
      result += interiorRowVerticals(sx, size, ry0, ry1, rowOffset);
    }
    return result;
  }

  // Paint interior bricks within one window's bounds, mirroring the outer
  // castle's explicit-grout approach.  Avoids the every-other-row thin-
  // line artifact that <pattern>-based tiling suffers from at tile
  // boundaries.
  function paintInteriorBricks(sx: number, sy: number, size: number): void {
    const winClipId = uid("winint");
    const winClip = document.createElementNS(SVG_NS, "clipPath");
    winClip.setAttribute("id", winClipId);
    const winClipPath = document.createElementNS(SVG_NS, "path");
    winClipPath.setAttribute("d", roundedRectPath(sx, sy, size, size, 0.6));
    winClip.append(winClipPath);
    localDefs.append(winClip);

    const fill = svgRect(sx, sy, size, size, INTERIOR_BRICK, 0.6);
    fill.setAttribute("clip-path", `url(#${winClipId})`);
    layers.shapes.append(fill);

    const groutPath = document.createElementNS(SVG_NS, "path");
    groutPath.setAttribute(
      "d",
      interiorHorizontals(sx, sy, size) + interiorVerticals(sx, sy, size),
    );
    groutPath.setAttribute("stroke", INTERIOR_GROUT);
    set(groutPath, "stroke-width", LINE_W * 0.6);
    groutPath.setAttribute("stroke-linecap", "round");
    groutPath.setAttribute("stroke-linejoin", "round");
    groutPath.setAttribute("fill", "none");
    groutPath.setAttribute("clip-path", `url(#${winClipId})`);
    layers.shapes.append(groutPath);
  }

  // Sill: thicker than before (touches the next row's window top to hide
  // distracting brick between rows), filled with brick gray.
  const sillExtend = sqSize * 0.08; // overhang on each side
  const sillH = sqGap; // = full gap between rows
  function placeWindow(sx: number, sy: number): void {
    // 1. INTERIOR BRICKS — drawn explicitly (not via <pattern>) so all
    //    rows render identically, matching the outer castle's brick
    //    treatment.
    paintInteriorBricks(sx, sy, sqSize);
    // 2. SEMI-TRANSPARENT GLASS — sky-blue overlay at ~65% opacity, so
    //    the interior bricks ghost through.  Drawn as the standard
    //    window square but with reduced fill opacity.
    const glassRect = svgRect(sx, sy, sqSize, sqSize, WINDOW_BLUE, 0.6);
    set(glassRect, "opacity", WINDOW_OPACITY);
    layers.shapes.append(glassRect);
    // 3. Window outline (full opacity) — sits on top of the glass
    layers.shapes.append(
      svgPath(roundedRectPath(sx, sy, sqSize, sqSize, 0.6), {
        fill: "none",
        stroke: WINDOW_OUTLINE,
        strokeWidth: LINE_W,
      }),
    );
    // 4. Inset shadow gives a soft frame of darkening just inside the
    //    window edge.
    applyInsetShadow(layers.shapes, roundedRectPath(sx, sy, sqSize, sqSize, 0.6), localDefs, {
      color: "#0a3a6b",
      thickness: sqSize * 0.22,
      blur: sqSize * 0.08,
      opacity: 0.85,
    });

    // Sill — gray rectangle bridging the gap to the next row.
    const sillX = sx - sillExtend;
    const sillY = sy + sqSize;
    const sillW = sqSize + sillExtend * 2;
    layers.shapes.append(svgRect(sillX, sillY, sillW, sillH, BRICK_FILL, 0.3));
    // Gentle inset shadow on the sill — small region, subtle
    applyInsetShadow(layers.shapes, roundedRectPath(sillX, sillY, sillW, sillH, 0.3), localDefs, {
      color: "#3a3a3a",
      thickness: sillH * 0.4,
      blur: sillH * 0.15,
      opacity: 0.35,
    });
    // Thin outline
    layers.shapes.append(
      svgPath(roundedRectPath(sillX, sillY, sillW, sillH, 0.3), {
        fill: "none",
        stroke: CASTLE_STROKE,
        strokeWidth: LINE_W,
      }),
    );
  }

  // Place a 1x2 window row. When `labelRight` is true, the right window
  // gets a "4/5" overlay (used on the right-hand set's both rows).
  function placeWindowRow(startX: number, rowY: number, labelRight: boolean): void {
    for (let c = 0; c < 2; c++) {
      const sx = startX + c * (sqSize + sqGap);
      placeWindow(sx, rowY);
      if (labelRight && c === 1) {
        edgeNumber(sx + sqSize / 2, rowY + sqSize / 2, "4/5", "#ffffff", sqSize * 0.55, "middle", {
          color: WINDOW_OUTLINE,
          width: LINE_W * 2,
        });
      }
    }
  }
  function placeWindowGrid(startX: number, labelRightColumn: boolean): void {
    placeWindowRow(startX, sqRowY1, labelRightColumn);
    placeWindowRow(startX, sqRowY2, labelRightColumn);
  }
  if (windows) {
    placeWindowGrid(bodyX + bodyW * 0.07, false);
    placeWindowGrid(bodyX + bodyW - bodyW * 0.07 - (sqSize * 2 + sqGap), true);
  }
}

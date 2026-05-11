import { SVG_NS, LINE_W, layers } from "../state.js";
import { svg } from "../svg/template.js";
import { random as rng } from "../util/rng.js";
import { voronoiCellsWithWavyEdges } from "./voronoi.js";
import type { Point, VoronoiToolkit } from "./voronoi.js";

interface CrackSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface Spine {
  pts: Point[];
  length_: number;
  directionX: number;
  directionY: number;
  perpX: number;
  perpY: number;
}
interface AlongInfo {
  x: number;
  y: number;
  directionX: number;
  directionY: number;
  segIndex: number;
}

// ── Pure helpers (hoisted to module scope so they aren't recreated per call)

// True iff every argument is a finite number (rejects NaN / ±Infinity).
function allFinite(...values: number[]): boolean {
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

// Pick a polygon-vertex index not yet used. Tries up to 2N rolls before
// giving up. Returns undefined if every retry landed on a used vertex.
function pickUnusedVertex(c: { poly: Point[] }, usedVerts: Set<number>): number | undefined {
  let vIndex = Math.floor(rng() * c.poly.length);
  let attempts = 1;
  while (usedVerts.has(vIndex) && attempts < c.poly.length * 2) {
    vIndex = Math.floor(rng() * c.poly.length);
    attempts++;
  }
  return usedVerts.has(vIndex) ? undefined : vIndex;
}

// Early-exit predicate for the recursive growBranch. Branches at depth > 3,
// shorter than 0.5, or thinner than `minBranchWidth` are dropped because
// they'd render as imperceptible wisps. Also rejects NaN/Infinity inputs
// (occasionally produced by degenerate angle math upstream).
function canGrowBranch(
  depth: number,
  length: number,
  baseW: number,
  minBranchWidth: number,
  baseX: number,
  baseY: number,
  directionX: number,
  directionY: number,
): boolean {
  if (depth > 3 || length < 0.5 || baseW < minBranchWidth) return false;
  return allFinite(baseX, baseY, directionX, directionY, length, baseW);
}

// Per-attempt probability of spawning a side branch. Attempt 0: 60%;
// attempt 1: 35%. Indexed directly by attemptIndex.
const SIDE_BRANCH_PROB = [0.6, 0.35];

// Side selection for a branch attempt. The FIRST attempt picks freely
// (50/50); subsequent attempts prefer the OPPOSITE side of the first (70%
// flip). Returns both the chosen side AND the updated `firstSide` carry,
// so the caller doesn't have to maintain that ternary itself.
function pickBranchSide(
  attemptIndex: number,
  firstSide: number,
): { side: number; nextFirstSide: number } {
  if (attemptIndex === 0) {
    const side = rng() < 0.5 ? -1 : 1;
    return { side, nextFirstSide: side };
  }
  return {
    side: rng() < 0.7 ? -firstSide : firstSide,
    nextFirstSide: firstSide,
  };
}

// Average of polygon vertex coordinates (NOT the area-weighted centroid).
// Adequate for picking a "central" starting point inside the polygon.
function polygonCentroid(poly: Point[]): [number, number] {
  let cx = 0,
    cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / poly.length, cy / poly.length];
}

// Cumulative arc-length along a polyline. cumLength[0] = 0; cumLength[i] is
// the total length from pts[0] to pts[i].
function cumulativeLengths(pts: Point[]): number[] {
  const cumLength = [0];
  for (let index = 1; index < pts.length; index++) {
    cumLength.push(
      cumLength[index - 1] +
        Math.hypot(pts[index][0] - pts[index - 1][0], pts[index][1] - pts[index - 1][1]),
    );
  }
  return cumLength;
}

// Build a meandering spine polyline from (startX, startY) → (endX, endY) with
// `nSegs` segments; each interior point gets perpendicular jog of magnitude
// `len * jogFraction * sin(πt)` (envelope keeps endpoints anchored).
function buildSpine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  nSegs: number,
  jogFraction: number,
): Spine | undefined {
  const dx = endX - startX,
    dy = endY - startY;
  const length_ = Math.hypot(dx, dy);
  if (length_ < 0.1) return undefined;
  const directionX = dx / length_,
    directionY = dy / length_;
  const perpX = -directionY,
    perpY = directionX;
  const jogAmp = length_ * jogFraction;
  const pts: Point[] = [[startX, startY]];
  for (let s = 1; s < nSegs; s++) {
    const t = s / nSegs;
    const baseX = startX + dx * t;
    const baseY = startY + dy * t;
    const envelope = Math.sin(t * Math.PI);
    const jog = (rng() - 0.5) * 2 * jogAmp * envelope;
    pts.push([baseX + perpX * jog, baseY + perpY * jog]);
  }
  pts.push([endX, endY]);
  return { pts, length_, directionX, directionY, perpX, perpY };
}

// Local tangent at vertex `index`: forward at start, backward at end,
// centered finite-difference everywhere else.
function ribbonTangent(pts: Point[], index: number): [number, number] {
  const n = pts.length;
  if (index === 0) return [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
  if (index === n - 1) return [pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]];
  return [pts[index + 1][0] - pts[index - 1][0], pts[index + 1][1] - pts[index - 1][1]];
}

// Filled tapered-ribbon polygon helper. Builds a polygon path that's
// `widthAtBaseEnd` wide at the first point and tapers to `widthAtTipEnd`.
function ribbonPath(pts: Point[], widthAtBaseEnd: number, widthAtTipEnd: number): string {
  const n = pts.length;
  if (n < 2) return "";
  const cumLength = cumulativeLengths(pts);
  const total = cumLength[n - 1];
  if (total < 0.1) return "";
  const top: Point[] = [];
  const bot: Point[] = [];
  for (let index = 0; index < n; index++) {
    const t = cumLength[index] / total;
    const halfW = (widthAtTipEnd + (widthAtBaseEnd - widthAtTipEnd) * t) * 0.5;
    const [tx, ty] = ribbonTangent(pts, index);
    const tl = Math.max(1e-6, Math.hypot(tx, ty));
    const nx = -ty / tl;
    const ny = tx / tl;
    top.push([pts[index][0] + nx * halfW, pts[index][1] + ny * halfW]);
    bot.push([pts[index][0] - nx * halfW, pts[index][1] - ny * halfW]);
  }
  return (
    svg`M ${top[0][0]} ${top[0][1]} ` +
    top
      .slice(1)
      .map((p) => svg`L ${p[0]} ${p[1]} `)
      .join("") +
    bot
      .toReversed()
      .map((p) => svg`L ${p[0]} ${p[1]} `)
      .join("") +
    "Z"
  );
}

// Tangent at vertex `index` along the polyline. Prefer the segment from
// pts[index-1] → pts[index]; if degenerate (zero-length), walk forward then
// backward to find a non-degenerate neighbour. Returns `dl = 0` only when
// the entire polyline is degenerate.
function tangentAtVertex(pts: Point[], index: number): { dx: number; dy: number; dl: number } {
  // Forward sweep: index, index+1, ... — covers the direct case at index.
  for (let index_ = index; index_ < pts.length; index_++) {
    const dx = pts[index_][0] - pts[index - 1][0];
    const dy = pts[index_][1] - pts[index - 1][1];
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-6) return { dx, dy, dl };
  }
  // Backward sweep: index-2, index-3, ... (signs flip so tangent stays
  // forward-pointing).
  for (let index_ = index - 2; index_ >= 0; index_--) {
    const dx = pts[index - 1][0] - pts[index_][0];
    const dy = pts[index - 1][1] - pts[index_][1];
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-6) return { dx, dy, dl };
  }
  return { dx: 0, dy: 0, dl: 0 };
}

// Find the point at fraction t (0..1) along a polyline by arc length, plus
// the local tangent direction at that point. Used so branches attach to the
// ACTUAL jagged spine rather than the idealized straight line.
// Interpolate the (x, y) at fraction `t` of total arc-length along the
// polyline `pts` (with precomputed `cumLength`). `segIndex` is the upper
// endpoint of the containing segment (so the segment runs from
// pts[segIndex - 1] → pts[segIndex]). Bounded at the last segment so
// t == 1 / numerical drift past it still resolves.
function interpolateAlongPolyline(
  pts: Point[],
  cumLength: number[],
  t: number,
): { x: number; y: number; segIndex: number } {
  const lastIndex = pts.length - 1;
  const targetLength = t * cumLength[lastIndex];
  let index = 1;
  while (index < lastIndex && cumLength[index] < targetLength) index++;
  const segLength = cumLength[index] - cumLength[index - 1];
  const segT = segLength > 1e-6 ? (targetLength - cumLength[index - 1]) / segLength : 0;
  return {
    x: pts[index - 1][0] + (pts[index][0] - pts[index - 1][0]) * segT,
    y: pts[index - 1][1] + (pts[index][1] - pts[index - 1][1]) * segT,
    segIndex: index,
  };
}

function pointAlongPolyline(pts: Point[], t: number): AlongInfo | undefined {
  if (pts.length < 2) return undefined;
  const cumLength = cumulativeLengths(pts);
  if (cumLength[pts.length - 1] < 1e-6) return undefined;
  const { x, y, segIndex } = interpolateAlongPolyline(pts, cumLength, t);
  const { dx, dy, dl } = tangentAtVertex(pts, segIndex);
  if (dl < 1e-6) return undefined;
  return { x, y, directionX: dx / dl, directionY: dy / dl, segIndex: segIndex - 1 };
}

// Counter-clockwise orientation predicate for three points.
function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

// True iff two points are within 1e-6 of each other.
function pointsCoincide(a: Point, b: Point): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
}

// True if either endpoint of segment (p1,p2) coincides with either endpoint
// of segment (p3,p4). Used to short-circuit segmentsIntersect: shared
// endpoints aren't crossings.
function segmentsShareEndpoint(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  return (
    pointsCoincide(p1, p3) ||
    pointsCoincide(p1, p4) ||
    pointsCoincide(p2, p3) ||
    pointsCoincide(p2, p4)
  );
}

// Segments (p1,p2) and (p3,p4) intersect at non-endpoint points. Endpoint
// sharing is OK so branches can MEET at points without forming X.
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  if (segmentsShareEndpoint(p1, p2, p3, p4)) return false;
  return (
    ccw(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1]) !==
      ccw(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1]) &&
    ccw(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]) !== ccw(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
  );
}

// Test whether a candidate polyline crosses any segment in the existing
// crack pool. `attachSegIndex` (optional): the index of a pool segment that
// this candidate is intentionally attaching to — ignored in the cross-test.
function segmentCrossesPool(
  a: Point,
  b: Point,
  pool: CrackSeg[],
  attachSegIndex: number | undefined,
): boolean {
  for (const [index_, seg] of pool.entries()) {
    if (index_ === attachSegIndex) continue;
    if (segmentsIntersect(a, b, [seg.x1, seg.y1], [seg.x2, seg.y2])) return true;
  }
  return false;
}

function polylineCrossesPool(polyPts: Point[], pool: CrackSeg[], attachSegIndex?: number): boolean {
  for (let index = 0; index < polyPts.length - 1; index++) {
    if (segmentCrossesPool(polyPts[index], polyPts[index + 1], pool, attachSegIndex)) return true;
  }
  return false;
}

// Record a polyline's segments in the pool so future candidates can test
// against it. Returns the starting index for caller reference.
function recordPolyline(polyPts: Point[], pool: CrackSeg[]): number {
  const startIndex = pool.length;
  for (let index = 0; index < polyPts.length - 1; index++) {
    pool.push({
      x1: polyPts[index][0],
      y1: polyPts[index][1],
      x2: polyPts[index + 1][0],
      y2: polyPts[index + 1][1],
    });
  }
  return startIndex;
}

// Cell crack count: 0-4, weighted toward 1-2 (~20% un-cracked, occasional
// 3-4). `crackProb` scales the roll: <1 reduces toward 0, >1 increases.
function pickCrackCount(roll: number, crackProb: number): number {
  const effectiveRoll = roll / Math.max(0.001, crackProb);
  if (effectiveRoll < 0.2) return 0;
  if (effectiveRoll < 0.55) return 1;
  if (effectiveRoll < 0.85) return 2;
  if (effectiveRoll < 0.97) return 3;
  return 4;
}

// Build the sand-colored cell-fill group, one path per cell with a random
// palette color. Uses expanded (wavy-edge) polygons for visual continuity
// with the boundary cracks.
function buildCellFillsGroup(v: VoronoiToolkit, palette: string[]): SVGGElement {
  const group = document.createElementNS(SVG_NS, "g");
  for (const c of v.cells) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", v.straightClosedPath(v.expandedPolygon(c.poly)));
    path.setAttribute("fill", palette[Math.floor(rng() * palette.length)]);
    group.append(path);
  }
  return group;
}

// Path-d for one wavy cell edge, or "" when the edge is on the rect border
// (those are covered by the silhouette outline, not the crack overlay).
function wavyEdgePathOrEmpty(v: VoronoiToolkit, a: Point, b: Point): string {
  return v.onBorder(a, b) ? "" : v.straightOpenPath(v.wavyEdgePoints(a, b));
}

// Concatenated SVG `d` for every internal cell edge, drawn once via the
// edge-noise cache so adjacent cells share their wavy boundary.
function buildBoundaryCrackPath(v: VoronoiToolkit): string {
  const seenEdges = new Set<string>();
  let d = "";
  for (const c of v.cells) {
    for (let index = 0; index < c.poly.length; index++) {
      const a = c.poly[index];
      const b = c.poly[(index + 1) % c.poly.length];
      const k = v.edgeKey(a, b);
      if (seenEdges.has(k)) continue;
      seenEdges.add(k);
      d += wavyEdgePathOrEmpty(v, a, b);
    }
  }
  return d;
}

// Cracked desert — Voronoi cells filled with sand color in slightly varied
// shades, separated by thin dark cracks along the cell boundaries.  Uses
// the same wavy-edge machinery so the cracks look like dried-mud fissures
// rather than polygon outlines.
export function crackedDesert(x: number, y: number, w: number, h: number): void {
  // Baked configuration (chosen values)
  const count = 45;
  const noiseAmp = 0.115; // cell-edge wobble
  const crackWidth = LINE_W * 2.05;
  const innerWidth = LINE_W * 2;
  const crackProb = 1;
  const innerSegs = 3;
  const innerJog = 0.2;
  const v = voronoiCellsWithWavyEdges(x, y, w, h, count, 3, noiseAmp);

  // Sand cell colors: each cell gets one of several sand variants for a
  // slightly mottled desert surface.  All hues sit in the same warm-yellow
  // family so cells read as one terrain rather than separate tiles.
  const sandPalette = ["#e8c773", "#dcb960", "#e3c068", "#d4ae54", "#ecca7d"];
  layers.shapes.append(buildCellFillsGroup(v, sandPalette));

  // ── Cell-boundary cracks ─────────────────────────────────────────
  // Thin dark fissures along each cell edge.  Straight segments + miter
  // joins keep the visible kinks at every wavy-edge inflection point.
  const crack = document.createElementNS(SVG_NS, "path");
  crack.setAttribute("d", buildBoundaryCrackPath(v));
  crack.setAttribute("stroke", "#7a5a2a");
  crack.setAttribute("stroke-width", String(crackWidth));
  crack.setAttribute("stroke-linecap", "butt");
  crack.setAttribute("stroke-linejoin", "miter");
  crack.setAttribute("stroke-miterlimit", "4");
  crack.setAttribute("fill", "none");
  crack.setAttribute("opacity", "1");
  layers.shapes.append(crack);

  // ── Intra-cell cracks ────────────────────────────────────────────
  // Each crack is drawn as a FILLED TAPERED RIBBON — a polygon that's
  // widest at its connected end (cell vertex) and tapers to a sharp
  // point at its open inner end.  Recursive natural-looking branching;
  // rejection sampling prevents crack X-shapes.

  // (buildSpine, ribbonPath, pointAlongPolyline, ccw, segmentsIntersect,
  //  polylineCrossesPool, recordPolyline are pure helpers hoisted to module
  //  scope at the top of this file.)

  // Width of a crack's WIDE (base/connected) end.  Tip end always 0.
  const CRACK_BASE_W = innerWidth;
  // Minimum allowed branch base width — branches narrower than this
  // would render as imperceptible wisps and look unnatural.  Set to
  // 40% of the main crack width so all branches stay visually credible.
  const MIN_BRANCH_W = CRACK_BASE_W * 0.4;
  let innerD = "";

  // ── Recursive branch growth ──────────────────────────────────────
  // Walks naturally: branches at random positions along the parent,
  // random angles, random lengths.  Each branch decides INDEPENDENTLY
  // (and stochastically) whether to spawn sub-branches.  Some branches
  // are very short stubs; some are nearly as long as the parent.
  // `attachSegIndex` is the index of the pool segment the branch base
  // sits on — that segment is exempt from the rejection cross-test.
  function growBranch(
    baseX: number,
    baseY: number,
    directionX: number,
    directionY: number,
    length: number,
    baseW: number,
    depth: number,
    pool: CrackSeg[],
    attachSegIndex: number,
  ): void {
    if (!canGrowBranch(depth, length, baseW, MIN_BRANCH_W, baseX, baseY, directionX, directionY))
      return;
    const endX = baseX + directionX * length;
    const endY = baseY + directionY * length;
    const segs = Math.max(2, Math.min(5, Math.floor(length * 0.6) + 2));
    const localJog = innerJog * (0.4 + rng() * 0.8);
    // Rejection: candidate may cross any pool segment EXCEPT the parent
    // segment it's attaching to (which it legitimately touches).
    const s = buildSpine(baseX, baseY, endX, endY, segs, localJog);
    if (!s || polylineCrossesPool(s.pts, pool, attachSegIndex)) return;
    const branchStartIndex = recordPolyline(s.pts, pool);

    // Render: pts[0] is the BASE so reverse for ribbonPath (tip-first)
    const reversed = s.pts.toReversed();
    innerD += ribbonPath(reversed, baseW, 0);

    // ── Sub-branch decisions ─────────────────────────────────────
    const maxAttempts = 3 - depth;
    for (let att = 0; att < maxAttempts; att++) {
      attemptSubBranch(s, att, depth, length, baseW, pool, branchStartIndex);
    }
  }

  // One sub-branch attempt off a parent branch's spine. Mirrors the
  // attemptSideBranch pattern but uses the recursive growBranch entry.
  function attemptSubBranch(
    s: Spine,
    att: number,
    depth: number,
    length: number,
    baseW: number,
    pool: CrackSeg[],
    branchStartIndex: number,
  ): void {
    const subProb = 0.4 * Math.pow(0.6, att) * Math.pow(0.7, depth);
    if (rng() >= subProb) return;
    // Random position along the parent spine, biased toward the wider
    // (base/attached) half so sub-branches stay credibly sized.
    const subT = 0.3 + rng() * 0.55;
    const along = pointAlongPolyline(s.pts, subT);
    if (!along) return;
    const sideSign = rng() < 0.5 ? -1 : 1;
    const angleFromPerp = (rng() - 0.4) * Math.PI * 0.75;
    const cosA = Math.cos(angleFromPerp);
    const sinA = Math.sin(angleFromPerp);
    // LOCAL spine tangent at the attach point (not the global parent
    // direction) so the angle is relative to where the spine goes locally.
    const ldx = along.directionX,
      ldy = along.directionY;
    const lpx = -ldy,
      lpy = ldx;
    const subDx = lpx * sideSign * cosA + ldx * sinA;
    const subDy = lpy * sideSign * cosA + ldy * sinA;
    const subLength = Math.hypot(subDx, subDy);
    if (subLength < 1e-6) return;
    const branchLength = length * (0.15 + Math.pow(rng(), 1.8) * 0.65);
    const localParentW = baseW * (1 - subT);
    const subBaseW = Math.min(localParentW, baseW * (0.55 + rng() * 0.25));
    growBranch(
      along.x,
      along.y,
      subDx / subLength,
      subDy / subLength,
      branchLength,
      subBaseW,
      depth + 1,
      pool,
      branchStartIndex + along.segIndex,
    );
  }

  // One side-branch attempt off a main crack. Returns the chosen side sign
  // so a subsequent attempt can prefer the opposite. Returns `firstSide`
  // unchanged if the attempt rolls a miss or hits a degenerate path.
  function attemptSideBranch(
    s: Spine,
    attemptIndex: number,
    firstSide: number,
    mainStartIndex: number,
    pool: CrackSeg[],
  ): number {
    if (rng() >= SIDE_BRANCH_PROB[attemptIndex]) return firstSide;
    const branchT = 0.4 + rng() * 0.45;
    const along = pointAlongPolyline(s.pts, branchT);
    if (!along) return firstSide;
    const { side: sideSign, nextFirstSide } = pickBranchSide(attemptIndex, firstSide);
    const ldx = along.directionX,
      ldy = along.directionY;
    const lpx = -ldy,
      lpy = ldx;
    const angleFromPerp = (rng() - 0.4) * Math.PI * 0.7;
    const cosA = Math.cos(angleFromPerp);
    const sinA = Math.sin(angleFromPerp);
    const bx = lpx * sideSign * cosA + ldx * sinA;
    const by = lpy * sideSign * cosA + ldy * sinA;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-6) return nextFirstSide;
    const branchLength = s.length_ * (0.2 + Math.pow(rng(), 1.7) * 0.55);
    const localW = CRACK_BASE_W * branchT * (0.7 + rng() * 0.3);
    growBranch(
      along.x,
      along.y,
      bx / blen,
      by / blen,
      branchLength,
      localW,
      0,
      pool,
      mainStartIndex + along.segIndex,
    );
    return nextFirstSide;
  }

  // Lay one main crack into cell `c` from a centroid-ish start toward a
  // randomly-chosen unused boundary vertex, then attempt two side branches.
  function attemptMainCrack(
    c: { poly: Point[] },
    cx: number,
    cy: number,
    pool: CrackSeg[],
    usedVerts: Set<number>,
  ): void {
    const vIndex = pickUnusedVertex(c, usedVerts);
    if (vIndex === undefined) return;
    const target = c.poly[vIndex];

    const dxT = target[0] - cx,
      dyT = target[1] - cy;
    if (Math.hypot(dxT, dyT) < 0.5) return;

    // Start somewhere along centroid→target line, biased toward centroid.
    const startFrac = 0.05 + rng() * 0.2;
    const startX = cx + dxT * startFrac;
    const startY = cy + dyT * startFrac;
    const segs = Math.max(2, Math.round(innerSegs * (0.7 + rng() * 0.6)));
    // Per-crack jog varies — some are nearly straight, some wander.
    const localJog = innerJog * (0.5 + rng() * 0.9);
    const s = buildSpine(startX, startY, target[0], target[1], segs, localJog);
    if (!s) return;
    // Main cracks don't attach to anything yet, so reject ANY crossing.
    if (polylineCrossesPool(s.pts, pool)) return;

    usedVerts.add(vIndex);
    const mainStartIndex = recordPolyline(s.pts, pool);
    innerD += ribbonPath(s.pts, CRACK_BASE_W, 0);

    // ── Branches off this main crack ─────────────────────────────
    // 0-2 attempts at first-level branches. Branches attach along the
    // ACTUAL jagged spine, not the start→end line.
    const firstSide = attemptSideBranch(s, 0, 0, mainStartIndex, pool);
    attemptSideBranch(s, 1, firstSide, mainStartIndex, pool);
  }

  // Lay 0-4 cracks into one cell (count picked stochastically per the
  // crackProb dial). Each crack runs centroid → boundary vertex, then may
  // spawn two side branches.
  function generateCracksForCell(c: { poly: Point[] }): void {
    if (c.poly.length < 3) return;
    const [cx, cy] = polygonCentroid(c.poly);
    const nCracks = pickCrackCount(rng(), crackProb);
    if (nCracks === 0) return;
    const pool: CrackSeg[] = [];
    const usedVerts = new Set<number>();
    for (let k = 0; k < nCracks; k++) attemptMainCrack(c, cx, cy, pool, usedVerts);
  }
  for (const c of v.cells) generateCracksForCell(c);
  // Filled crack polygons rendered as a single path — no stroke.
  const innerCrack = document.createElementNS(SVG_NS, "path");
  innerCrack.setAttribute("d", innerD);
  innerCrack.setAttribute("fill", "#7a5a2a");
  innerCrack.setAttribute("stroke", "none");
  innerCrack.setAttribute("fill-rule", "nonzero");
  innerCrack.setAttribute("opacity", "1");
  layers.shapes.append(innerCrack);
}

import { SVG_NS, LINE_W, layers, getDefs } from "../state.js";
import { svg } from "../svg/template.js";
import { uid } from "../util/uid.js";
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

// Uniform random ±1.
function randomSign(): number {
  return rng() < 0.5 ? -1 : 1;
}

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

// Tangent at vertex `index` along the polyline. Try the direct segment
// (anchor → index) first, then walk forward, then backward — each candidate
// gives a forward-pointing tangent. Returns `dl = 0` only when the entire
// polyline is degenerate.
function tangentAtVertex(pts: Point[], index: number): { dx: number; dy: number; dl: number } {
  const anchor = index - 1;
  // Candidate (from, to) pairs in priority order. Forward sweep keeps anchor
  // as `from`; backward sweep slides `from` further back so the resulting
  // (to − from) vector still points forward along the polyline.
  const forward = Array.from(
    { length: pts.length - index },
    (_, k) => [anchor, index + k] as const,
  );
  const backward = Array.from({ length: anchor }, (_, k) => [anchor - 1 - k, anchor] as const);
  for (const [from, to] of [...forward, ...backward]) {
    const dx = pts[to][0] - pts[from][0];
    const dy = pts[to][1] - pts[from][1];
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

// Build a candidate spine and reject it if buildSpine failed OR the result
// would cross any existing crack in the pool (with the usual attach-segment
// exemption). Returns undefined on rejection.
function buildAcceptableSpine(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  segs: number,
  jogFraction: number,
  pool: CrackSeg[],
  attachSegIndex?: number,
): Spine | undefined {
  const s = buildSpine(startX, startY, endX, endY, segs, jogFraction);
  if (!s || polylineCrossesPool(s.pts, pool, attachSegIndex)) return undefined;
  return s;
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

// Upper bound of each crack-count bucket. effectiveRoll < 0.20 → 0 cracks,
// < 0.55 → 1, < 0.85 → 2, < 0.97 → 3, otherwise 4.
const CRACK_COUNT_THRESHOLDS = [0.2, 0.55, 0.85, 0.97];

// Cell crack count: 0-4, weighted toward 1-2 (~20% un-cracked, occasional
// 3-4). `crackProb` scales the roll: <1 reduces toward 0, >1 increases.
function pickCrackCount(roll: number, crackProb: number): number {
  const effectiveRoll = roll / Math.max(0.001, crackProb);
  for (const [index, threshold] of CRACK_COUNT_THRESHOLDS.entries()) {
    if (effectiveRoll < threshold) return index;
  }
  return CRACK_COUNT_THRESHOLDS.length;
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

// Cow skull — full multi-path markup kept
// verbatim so its individual fills/strokes survive.  Rendered as a nested
// <svg> scaled into the top-right corner of the desert tile.  fill="none" on
// the root makes the stroke-only paths inherit no fill (SVG default = black).
const COW_SVG = `<svg viewBox="0 0 557 604" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M232.295 200.506C246.295 199.506 251.295 188.006 278.795 187.506V362.006C278.795 375.006 273.795 592.506 272.795 600.006C271.795 607.506 252.795 601.506 232.295 600.006C211.795 598.506 218.795 572.006 218.295 534.506C217.795 497.006 195.795 486.506 184.795 471.506C173.795 456.506 184.795 386.006 167.795 391.006C150.795 396.006 155.295 348.006 155.295 319.006C155.295 290.006 176.795 287.506 184.795 271.006C191.195 257.806 167.795 248.506 155.295 245.506C156.628 233.006 160.995 206.506 167.795 200.506C176.295 193.006 218.295 201.506 232.295 200.506Z" fill="#F3F0E0"/>
<path d="M249.303 424.242C249.3 424.247 249.297 424.253 249.295 424.258C249.243 424.369 249.194 424.488 249.146 424.614L249.017 424.992C248.728 425.916 248.992 427.098 248.898 428.568C248.791 430.241 248.807 432.204 248.918 434.359C249.14 438.668 249.742 443.712 250.488 448.679C251.981 458.616 254.045 468.194 254.776 470.875C255.148 472.238 255.561 473.103 255.932 473.5C256.111 473.691 256.224 473.714 256.269 473.714C256.311 473.714 256.426 473.693 256.607 473.488C256.987 473.057 257.419 472.088 257.815 470.4C258.206 468.737 258.547 466.451 258.796 463.464C258.922 461.949 259.105 460.727 259.335 459.768C259.563 458.816 259.844 458.089 260.187 457.59C260.535 457.085 260.993 456.753 261.557 456.757C262.089 456.762 262.565 457.069 262.961 457.465C263.758 458.263 264.522 459.706 265.176 461.431C265.836 463.174 266.407 465.267 266.787 467.419C267.151 469.484 267.931 471.086 268.863 471.962C269.324 472.396 269.807 472.637 270.285 472.697C270.757 472.755 271.276 472.642 271.832 472.276C272.969 471.527 274.22 469.739 275.311 466.435C276.094 464.063 276.78 460.95 277.29 456.964C277.089 465.561 276.881 474.329 276.67 483.081C276.145 504.822 275.6 526.464 275.101 545.121C274.862 545.127 274.65 545.031 274.482 544.897C274.08 544.575 273.748 544.06 273.465 543.446C273.176 542.822 272.915 542.046 272.675 541.153C272.194 539.366 271.784 537.055 271.424 534.426C270.703 529.167 270.17 522.573 269.671 516.233C269.17 509.882 268.702 503.791 268.111 499.504C267.814 497.353 267.492 495.698 267.133 494.698C266.993 494.309 266.865 494.071 266.765 493.941L266.677 493.844C266.664 493.852 266.646 493.863 266.624 493.882C266.571 493.929 266.478 494.047 266.358 494.283C266.243 494.51 266.118 494.813 265.988 495.194C265.728 495.954 265.454 496.984 265.169 498.251C264.598 500.784 263.991 504.22 263.35 508.256C262.07 516.331 260.665 526.758 259.164 537.079C257.664 547.39 256.069 557.593 254.408 565.191C253.579 568.986 252.728 572.155 251.857 574.368C251.423 575.47 250.973 576.367 250.498 576.988C250.037 577.59 249.458 578.055 248.759 578.005C247.672 577.928 246.658 577.157 245.723 576.009C244.775 574.845 243.833 573.201 242.903 571.184C241.042 567.146 239.189 561.521 237.436 555.011C233.929 541.985 230.801 525.339 228.799 510.574C227.195 498.746 230.17 481.934 234.522 465.733C238.88 449.511 244.468 433.878 248.496 424.258C248.55 424.117 248.607 423.98 248.668 423.85L249.303 424.242Z" fill="#0A0A0A"/>
<path d="M277.295 332.506C274.795 332.506 276.795 327.506 273.795 333.506C270.795 339.506 272.295 342.006 269.795 338.506C267.295 335.006 262.795 324.506 261.295 331.506C259.795 338.506 249.295 382.006 244.795 381.006M247.295 435.006C249.219 422.913 251.143 408.811 250.907 398.006C250.715 389.155 249.073 382.515 244.795 381.006M244.795 381.006C242.491 380.494 236.909 377.36 229.795 376.572M180.795 368.506C195.295 368.006 190.295 401.006 206.795 385.006C214.846 377.199 223.016 375.821 229.795 376.572M250.907 398.006C238.795 402.006 233.795 412.506 229.795 419.006C225.795 425.506 224.795 414.006 219.795 415.006C214.795 416.006 212.295 423.006 206.795 419.006C201.295 415.006 198.795 408.006 193.795 411.506C188.795 415.006 176.795 403.006 176.295 400.506M229.795 376.572C221.295 370.506 208.795 333.506 201.295 331.506" stroke="black"/>
<path d="M162.17 295.059C165.457 296.015 169.022 298.107 172.786 300.984C182.647 308.521 194.185 321.693 206.169 335.174L205.498 335.909C199.785 331.686 194.768 329.759 191.053 329.819C189.206 329.849 187.7 330.368 186.57 331.319C185.441 332.269 184.644 333.689 184.286 335.599C183.661 338.931 181.632 341.932 179.396 344.311C177.437 346.397 175.286 348.039 173.692 349.046L190.091 361.104L190.387 361.321L190.268 361.668C188.087 368.042 183.639 377.595 177.363 385.566C175.582 387.828 173.646 389.969 171.567 391.877C171.236 391.665 170.891 391.506 170.529 391.402C169.779 391.187 168.924 391.195 167.936 391.486C165.701 392.143 163.764 391.941 162.122 390.968C160.498 390.006 159.224 388.328 158.217 386.154C156.206 381.814 155.171 375.296 154.671 367.79C153.67 352.771 154.795 333.456 154.795 319.006C154.795 311.692 156.151 306.024 158.326 301.38C159.426 299.033 160.732 296.953 162.17 295.059Z" fill="black"/>
<path d="M160.795 250.506C155.195 222.106 180.128 200.34 193.295 193.006C181.795 193.006 151.095 190.706 92.2949 157.506C18.7949 116.006 32.7951 -0.993629 10.2951 0.00637073C-12.2049 1.00637 5.29506 127.006 32.7951 177.506C54.7951 217.906 127.295 243.006 160.795 250.506Z" fill="#2B1D00"/>
<path d="M323.795 200.513C309.795 199.513 304.795 188.013 277.295 187.513V362.013C277.295 375.013 282.295 592.513 283.295 600.013C284.295 607.513 303.295 601.513 323.795 600.013C344.295 598.513 337.295 572.013 337.795 534.513C338.295 497.013 360.295 486.513 371.295 471.513C382.295 456.513 371.295 386.013 388.295 391.013C405.295 396.013 400.795 348.013 400.795 319.013C400.795 290.013 379.295 287.513 371.295 271.013C364.895 257.813 388.295 248.513 400.795 245.513C399.461 233.013 395.095 206.513 388.295 200.513C379.795 193.013 337.795 201.513 323.795 200.513Z" fill="#F3F0E0"/>
<path d="M306.787 424.248C306.789 424.254 306.793 424.259 306.795 424.265C306.846 424.375 306.896 424.494 306.943 424.62L307.073 424.998C307.362 425.923 307.097 427.104 307.192 428.574C307.299 430.247 307.283 432.211 307.172 434.365C306.95 438.674 306.348 443.719 305.602 448.686C304.109 458.622 302.045 468.2 301.314 470.881C300.942 472.244 300.529 473.11 300.157 473.507C299.979 473.697 299.866 473.721 299.82 473.721C299.779 473.721 299.664 473.7 299.483 473.494C299.103 473.063 298.671 472.094 298.275 470.406C297.884 468.743 297.543 466.457 297.294 463.471C297.168 461.956 296.984 460.734 296.755 459.774C296.527 458.822 296.246 458.096 295.902 457.597C295.555 457.092 295.096 456.759 294.532 456.764C294 456.768 293.525 457.075 293.129 457.472C292.332 458.269 291.568 459.713 290.914 461.438C290.254 463.181 289.683 465.273 289.303 467.426C288.939 469.49 288.159 471.092 287.227 471.969C286.766 472.402 286.283 472.644 285.805 472.703C285.333 472.762 284.813 472.648 284.258 472.282C283.121 471.533 281.869 469.745 280.778 466.441C279.995 464.07 279.309 460.956 278.8 456.971C279.001 465.567 279.209 474.335 279.42 483.087C279.945 504.828 280.49 526.47 280.988 545.127C281.228 545.133 281.44 545.037 281.608 544.903C282.01 544.581 282.341 544.066 282.625 543.452C282.913 542.828 283.175 542.052 283.415 541.159C283.896 539.372 284.306 537.061 284.666 534.433C285.387 529.173 285.919 522.579 286.419 516.239C286.92 509.888 287.387 503.797 287.979 499.511C288.275 497.359 288.598 495.704 288.957 494.704C289.097 494.315 289.225 494.078 289.324 493.947L289.413 493.851C289.426 493.858 289.444 493.869 289.466 493.889C289.519 493.935 289.612 494.053 289.732 494.289C289.847 494.517 289.971 494.82 290.102 495.2C290.362 495.961 290.636 496.991 290.921 498.258C291.492 500.79 292.099 504.226 292.739 508.263C294.02 516.337 295.425 526.764 296.926 537.085C298.426 547.396 300.021 557.6 301.682 565.197C302.511 568.992 303.362 572.162 304.233 574.374C304.666 575.476 305.117 576.373 305.592 576.994C306.053 577.597 306.632 578.062 307.331 578.012C308.418 577.934 309.432 577.163 310.366 576.016C311.315 574.852 312.257 573.207 313.187 571.19C315.048 567.153 316.901 561.527 318.653 555.018C322.16 541.992 325.289 525.345 327.291 510.58C328.895 498.753 325.92 481.941 321.568 465.739C317.21 449.518 311.622 433.884 307.594 424.265C307.54 424.123 307.483 423.987 307.422 423.856L306.787 424.248Z" fill="#0A0A0A"/>
<path d="M277.295 332.506C279.295 332.506 279.295 327.513 282.295 333.513C285.295 339.513 283.795 342.013 286.295 338.513C288.795 335.013 293.295 324.513 294.795 331.513C296.295 338.513 306.795 382.013 311.295 381.013M308.795 435.013C306.871 422.92 304.947 408.818 305.182 398.013C305.375 389.161 307.017 382.522 311.295 381.013M311.295 381.013C313.599 380.501 319.181 377.367 326.295 376.578M375.295 368.513C360.795 368.013 365.795 401.013 349.295 385.013C341.244 377.206 333.074 375.827 326.295 376.578M305.182 398.013C317.295 402.013 322.295 412.513 326.295 419.013C330.295 425.513 331.295 414.013 336.295 415.013C341.295 416.013 343.795 423.013 349.295 419.013C354.795 415.013 357.295 408.013 362.295 411.513C367.295 415.013 379.295 403.013 379.795 400.513M326.295 376.578C334.795 370.513 347.295 333.513 354.795 331.513" stroke="black"/>
<path d="M393.92 295.065C390.633 296.022 387.068 298.113 383.304 300.99C373.443 308.527 361.905 321.699 349.921 335.181L350.592 335.915C356.305 331.693 361.322 329.765 365.037 329.825C366.884 329.855 368.39 330.375 369.52 331.325C370.649 332.276 371.446 333.695 371.804 335.605C372.429 338.938 374.458 341.938 376.693 344.317C378.653 346.403 380.804 348.046 382.398 349.053L365.999 361.11L365.703 361.327L365.822 361.675C368.003 368.048 372.451 377.602 378.727 385.572C380.507 387.834 382.444 389.975 384.523 391.884C384.854 391.671 385.199 391.512 385.561 391.408C386.31 391.193 387.166 391.202 388.153 391.492C390.389 392.15 392.326 391.947 393.968 390.975C395.592 390.013 396.866 388.334 397.873 386.16C399.884 381.82 400.919 375.303 401.419 367.796C402.42 352.777 401.295 333.463 401.295 319.013C401.295 311.698 399.939 306.031 397.764 301.387C396.664 299.039 395.358 296.959 393.92 295.065Z" fill="black"/>
<path d="M395.295 250.513C400.895 222.113 375.962 200.346 362.795 193.013C374.295 193.013 404.995 190.713 463.795 157.513C537.295 116.013 523.295 -0.987282 545.795 0.0127184C568.295 1.01272 550.795 127.013 523.295 177.513C501.295 217.913 428.795 243.013 395.295 250.513Z" fill="#2B1D00"/>
</svg>`;

// Parse the cow-skull markup into a fresh nested <svg> sized cowW × cowH,
// positioned at local (0,0).  A new copy each call so the shadow and the
// skull are independent elements.
function makeCowSkull(cowW: number, cowH: number): Element {
  const parsed = new DOMParser().parseFromString(COW_SVG, "image/svg+xml");
  const skull = document.importNode(parsed.documentElement, true) as Element;
  skull.setAttribute("x", "0");
  skull.setAttribute("y", "0");
  skull.setAttribute("width", String(cowW));
  skull.setAttribute("height", String(cowH));
  skull.setAttribute("overflow", "visible");
  return skull;
}

// Place the cow skull into the top-right corner of the desert tile, tilted
// 30°, with a blurred fully-black copy behind it as a top-down shadow.  Sized
// by tile height so it always fits; the banner clip handles any overhang.
function emitCow(x: number, y: number, w: number, h: number): void {
  const cowH = h * 0.6;
  const cowW = cowH * (557 / 604);
  // Center the (rotated) skull near the top-right of the tile.
  const centerX = x + w - cowW * 0.55 - w * 0.04;
  const centerY = y + h * 0.46;

  // Shadow filter: blur SourceAlpha so the result is a fully-black blurred
  // silhouette of whatever it's applied to, regardless of the skull's fills.
  const filterId = uid("cow-shadow");
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", filterId);
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("in", "SourceAlpha");
  blur.setAttribute("stdDeviation", String(cowW * 0.04));
  filter.append(blur);
  getDefs().append(filter);

  // Group: move to the chosen center, tilt 45°, then offset so the skull's
  // own box center sits at that point.
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute(
    "transform",
    `translate(${String(centerX)} ${String(centerY)}) rotate(30) translate(${String(-cowW / 2)} ${String(-cowH / 2)})`,
  );

  // Shadow first (behind), nudged down-right so it reads as cast on the sand.
  const shadow = makeCowSkull(cowW, cowH);
  shadow.setAttribute("x", String(cowW * 0.06));
  shadow.setAttribute("y", String(cowH * 0.07));
  shadow.setAttribute("filter", `url(#${filterId})`);
  shadow.setAttribute("opacity", "0.3");
  group.append(shadow);

  // Skull on top.
  group.append(makeCowSkull(cowW, cowH));

  // Bottom-to-top dark gradient over the skull (in its LOCAL, pre-rotation
  // frame) so its lower end reads as sunk lower / in shade.  Masked to the
  // skull silhouette so the sand around it stays untouched.
  // 1) Vertical gradient: black & semi-opaque at the bottom, transparent up.
  const gradId = uid("skull-shade");
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", gradId);
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "1"); // bottom
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "0"); // top
  const stopBottom = document.createElementNS(SVG_NS, "stop");
  stopBottom.setAttribute("offset", "0");
  stopBottom.setAttribute("stop-color", "#000");
  stopBottom.setAttribute("stop-opacity", "0.5");
  const stopTop = document.createElementNS(SVG_NS, "stop");
  stopTop.setAttribute("offset", "0.45");
  stopTop.setAttribute("stop-color", "#000");
  stopTop.setAttribute("stop-opacity", "0");
  grad.append(stopBottom, stopTop);
  getDefs().append(grad);

  // 2) Mask = whitened skull silhouette (luminance mask → shows only over
  //    the skull's filled area).
  const whitenId = uid("skull-whiten");
  const whiten = document.createElementNS(SVG_NS, "filter");
  whiten.setAttribute("id", whitenId);
  const cm = document.createElementNS(SVG_NS, "feColorMatrix");
  cm.setAttribute("type", "matrix");
  cm.setAttribute("values", "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0");
  whiten.append(cm);
  getDefs().append(whiten);

  const maskId = uid("skull-mask");
  const mask = document.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", maskId);
  const maskSkull = makeCowSkull(cowW, cowH);
  maskSkull.setAttribute("filter", `url(#${whitenId})`);
  mask.append(maskSkull);
  getDefs().append(mask);

  // 3) Gradient-filled rect over the skull box, masked to its shape.
  const shade = document.createElementNS(SVG_NS, "rect");
  shade.setAttribute("x", "0");
  shade.setAttribute("y", "0");
  shade.setAttribute("width", String(cowW));
  shade.setAttribute("height", String(cowH));
  shade.setAttribute("fill", `url(#${gradId})`);
  shade.setAttribute("mask", `url(#${maskId})`);
  group.append(shade);

  layers.shapes.append(group);
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
    // Candidate may cross any pool segment EXCEPT the parent it attaches to.
    const s = buildAcceptableSpine(baseX, baseY, endX, endY, segs, localJog, pool, attachSegIndex);
    if (!s) return;
    const branchStartIndex = recordPolyline(s.pts, pool);

    // Render: pts[0] is the BASE so reverse for ribbonPath (tip-first)
    const reversed = s.pts.toReversed();
    innerD += ribbonPath(reversed, baseW, 0);
    attemptAllSubBranches(s, depth, length, baseW, pool, branchStartIndex);
  }

  // Spawn up to 3 - depth sub-branch attempts off the parent spine.
  function attemptAllSubBranches(
    s: Spine,
    depth: number,
    length: number,
    baseW: number,
    pool: CrackSeg[],
    branchStartIndex: number,
  ): void {
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
    const sideSign = randomSign();
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
    const dxT = target[0] - cx;
    const dyT = target[1] - cy;
    if (Math.hypot(dxT, dyT) < 0.5) return;

    // Start somewhere along centroid→target line, biased toward centroid.
    const startFrac = 0.05 + rng() * 0.2;
    const startX = cx + dxT * startFrac;
    const startY = cy + dyT * startFrac;
    const segs = Math.max(2, Math.round(innerSegs * (0.7 + rng() * 0.6)));
    // Per-crack jog varies — some are nearly straight, some wander.
    const localJog = innerJog * (0.5 + rng() * 0.9);
    // Build the spine; reject if it failed OR would cross any existing crack
    // (main cracks don't attach to anything yet, so any crossing is invalid).
    const s = buildAcceptableSpine(startX, startY, target[0], target[1], segs, localJog, pool);
    if (!s) return;

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

  // Cow grazing in the top-right corner, on top of the sand + cracks.
  emitCow(x, y, w, h);
}

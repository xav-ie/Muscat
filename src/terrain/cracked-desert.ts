import { SVG_NS, LINE_W, layers } from "../state.js";
import { svg } from "../svg/template.js";
import { random as rng } from "../util/rng.js";
import { voronoiCellsWithWavyEdges } from "./voronoi.js";
import type { Point } from "./voronoi.js";

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

// Filled tapered-ribbon polygon helper. Builds a polygon path that's
// `widthAtBaseEnd` wide at the first point and tapers to `widthAtTipEnd`.
function ribbonPath(
  pts: Point[],
  widthAtBaseEnd: number,
  widthAtTipEnd: number,
): string {
  const n = pts.length;
  if (n < 2) return "";
  const cumLength = [0];
  for (let index = 1; index < n; index++) {
    cumLength.push(
      cumLength[index - 1] +
        Math.hypot(
          pts[index][0] - pts[index - 1][0],
          pts[index][1] - pts[index - 1][1],
        ),
    );
  }
  const total = cumLength[n - 1];
  if (total < 0.1) return "";
  const top: Point[] = [],
    bot: Point[] = [];
  for (let index = 0; index < n; index++) {
    const t = cumLength[index] / total;
    const halfW = (widthAtTipEnd + (widthAtBaseEnd - widthAtTipEnd) * t) * 0.5;
    let tx: number, ty: number;
    if (index === 0) {
      tx = pts[1][0] - pts[0][0];
      ty = pts[1][1] - pts[0][1];
    } else if (index === n - 1) {
      tx = pts[n - 1][0] - pts[n - 2][0];
      ty = pts[n - 1][1] - pts[n - 2][1];
    } else {
      tx = pts[index + 1][0] - pts[index - 1][0];
      ty = pts[index + 1][1] - pts[index - 1][1];
    }
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl,
      ny = tx / tl;
    top.push([pts[index][0] + nx * halfW, pts[index][1] + ny * halfW]);
    bot.push([pts[index][0] - nx * halfW, pts[index][1] - ny * halfW]);
  }
  let d = svg`M ${top[0][0]} ${top[0][1]} `;
  for (let index = 1; index < n; index++)
    d += svg`L ${top[index][0]} ${top[index][1]} `;
  for (let index = n - 1; index >= 0; index--)
    d += svg`L ${bot[index][0]} ${bot[index][1]} `;
  d += "Z";
  return d;
}

// Find the point at fraction t (0..1) along a polyline by arc length, plus
// the local tangent direction at that point. Used so branches attach to the
// ACTUAL jagged spine rather than the idealized straight line.
function pointAlongPolyline(pts: Point[], t: number): AlongInfo | undefined {
  if (pts.length < 2) return undefined;
  const cumLength = [0];
  for (let index = 1; index < pts.length; index++) {
    cumLength.push(
      cumLength[index - 1] +
        Math.hypot(
          pts[index][0] - pts[index - 1][0],
          pts[index][1] - pts[index - 1][1],
        ),
    );
  }
  const total = cumLength[pts.length - 1];
  if (total < 1e-6) return undefined;
  const targetLength = t * total;
  let index = 1;
  while (index < pts.length && cumLength[index] < targetLength) index++;
  if (index >= pts.length) index = pts.length - 1;
  const segLength = cumLength[index] - cumLength[index - 1];
  const segT =
    segLength > 1e-6 ? (targetLength - cumLength[index - 1]) / segLength : 0;
  const x = pts[index - 1][0] + (pts[index][0] - pts[index - 1][0]) * segT;
  const y = pts[index - 1][1] + (pts[index][1] - pts[index - 1][1]) * segT;
  // Local tangent: prefer this segment's direction; if it's degenerate
  // (zero-length), walk outward to find a non-degenerate neighbour.
  let dx = pts[index][0] - pts[index - 1][0];
  let dy = pts[index][1] - pts[index - 1][1];
  let dl = Math.hypot(dx, dy);
  if (dl < 1e-6) {
    // Look forward, then backward
    for (let index_ = index + 1; index_ < pts.length; index_++) {
      dx = pts[index_][0] - pts[index - 1][0];
      dy = pts[index_][1] - pts[index - 1][1];
      dl = Math.hypot(dx, dy);
      if (dl > 1e-6) break;
    }
    if (dl < 1e-6) {
      for (let index_ = index - 2; index_ >= 0; index_--) {
        dx = pts[index - 1][0] - pts[index_][0];
        dy = pts[index - 1][1] - pts[index_][1];
        dl = Math.hypot(dx, dy);
        if (dl > 1e-6) break;
      }
    }
    if (dl < 1e-6) return undefined; // entire polyline degenerate
  }
  return {
    x,
    y,
    directionX: dx / dl,
    directionY: dy / dl,
    segIndex: index - 1,
  };
}

// Counter-clockwise orientation predicate for three points.
function ccw(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

// Segments (p1,p2) and (p3,p4) intersect at non-endpoint points. Endpoint
// sharing is OK so branches can MEET at points without forming X.
function segmentsIntersect(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): boolean {
  const eps = 1e-6;
  if (Math.hypot(p1[0] - p3[0], p1[1] - p3[1]) < eps) return false;
  if (Math.hypot(p1[0] - p4[0], p1[1] - p4[1]) < eps) return false;
  if (Math.hypot(p2[0] - p3[0], p2[1] - p3[1]) < eps) return false;
  if (Math.hypot(p2[0] - p4[0], p2[1] - p4[1]) < eps) return false;
  return (
    ccw(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1]) !==
      ccw(p2[0], p2[1], p3[0], p3[1], p4[0], p4[1]) &&
    ccw(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]) !==
      ccw(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])
  );
}

// Test whether a candidate polyline crosses any segment in the existing
// crack pool. `attachSegIndex` (optional): the index of a pool segment that
// this candidate is intentionally attaching to — ignored in the cross-test.
function polylineCrossesPool(
  polyPts: Point[],
  pool: CrackSeg[],
  attachSegIndex?: number,
): boolean {
  for (let index = 0; index < polyPts.length - 1; index++) {
    const a = polyPts[index],
      b = polyPts[index + 1];
    for (const [index_, seg] of pool.entries()) {
      if (index_ === attachSegIndex) continue;
      if (segmentsIntersect(a, b, [seg.x1, seg.y1], [seg.x2, seg.y2]))
        return true;
    }
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

// Cracked desert — Voronoi cells filled with sand color in slightly varied
// shades, separated by thin dark cracks along the cell boundaries.  Uses
// the same wavy-edge machinery so the cracks look like dried-mud fissures
// rather than polygon outlines.
export function crackedDesert(
  x: number,
  y: number,
  w: number,
  h: number,
): void {
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
  // Cells use STRAIGHT-segment closed paths so the polygon corners stay
  // angular — sharp tile-to-tile boundaries instead of curvy Bezier blobs.
  const sandPalette = ["#e8c773", "#dcb960", "#e3c068", "#d4ae54", "#ecca7d"];
  const cellGroup = document.createElementNS(SVG_NS, "g");
  for (const c of v.cells) {
    const expanded = v.expandedPolygon(c.poly);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", v.straightClosedPath(expanded));
    path.setAttribute(
      "fill",
      sandPalette[Math.floor(rng() * sandPalette.length)],
    );
    cellGroup.append(path);
  }
  layers.shapes.append(cellGroup);

  // ── Cell-boundary cracks ─────────────────────────────────────────
  // Thin dark fissures along each cell edge.  Straight segments + miter
  // joins keep the visible kinks at every wavy-edge inflection point.
  const seenEdges = new Set<string>();
  let crackD = "";
  for (const c of v.cells) {
    const poly = c.poly;
    for (let index = 0; index < poly.length; index++) {
      const a = poly[index],
        b = poly[(index + 1) % poly.length];
      const k = v.edgeKey(a, b);
      if (seenEdges.has(k)) continue;
      seenEdges.add(k);
      if (v.onBorder(a, b)) continue;
      const pts = v.wavyEdgePoints(a, b);
      crackD += v.straightOpenPath(pts);
    }
  }
  const crack = document.createElementNS(SVG_NS, "path");
  crack.setAttribute("d", crackD);
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
    // Hard stop at recursion depth, too-short, or too-thin branches.
    // Wisp-sized branches (below MIN_BRANCH_W) are skipped entirely.
    if (depth > 3 || length < 0.5 || baseW < MIN_BRANCH_W) return;
    if (
      !Number.isFinite(baseX) ||
      !Number.isFinite(baseY) ||
      !Number.isFinite(directionX) ||
      !Number.isFinite(directionY) ||
      !Number.isFinite(length) ||
      !Number.isFinite(baseW)
    )
      return;

    const endX = baseX + directionX * length;
    const endY = baseY + directionY * length;
    const segs = Math.max(2, Math.min(5, Math.floor(length * 0.6) + 2));
    const localJog = innerJog * (0.4 + rng() * 0.8);
    const s = buildSpine(baseX, baseY, endX, endY, segs, localJog);
    if (!s) return;

    // Rejection: candidate may cross any pool segment EXCEPT the parent
    // segment it's attaching to (which it legitimately touches).
    if (polylineCrossesPool(s.pts, pool, attachSegIndex)) return;
    const branchStartIndex = recordPolyline(s.pts, pool);

    // Render: pts[0] is the BASE so reverse for ribbonPath (tip-first)
    const reversed = s.pts.toReversed();
    innerD += ribbonPath(reversed, baseW, 0);

    // ── Sub-branch decisions ─────────────────────────────────────
    const maxAttempts = 3 - depth;
    for (let att = 0; att < maxAttempts; att++) {
      const subProb = 0.4 * Math.pow(0.6, att) * Math.pow(0.7, depth);
      if (rng() >= subProb) continue;

      // Random position along this branch's spine.  Bias toward the
      // wider (base/attached) half so sub-branches stay credibly sized.
      const subT = 0.3 + rng() * 0.55;
      // Walk the ACTUAL jagged spine, not the start→end line
      const along = pointAlongPolyline(s.pts, subT);
      if (!along) continue;
      const subBaseX = along.x,
        subBaseY = along.y;
      const segOffset = along.segIndex; // which segment within this branch

      const sideSign = rng() < 0.5 ? -1 : 1;
      const angleFromPerp = (rng() - 0.4) * Math.PI * 0.75;
      const cosA = Math.cos(angleFromPerp);
      const sinA = Math.sin(angleFromPerp);
      // Use the LOCAL tangent of the spine at the attach point (not the
      // global branch direction) so the angle is relative to where the
      // spine actually goes locally.
      const ldx = along.directionX,
        ldy = along.directionY;
      const lpx = -ldy,
        lpy = ldx;
      const subDx = lpx * sideSign * cosA + ldx * sinA;
      const subDy = lpy * sideSign * cosA + ldy * sinA;
      const subLength = Math.hypot(subDx, subDy);
      if (subLength < 1e-6) continue;

      const lengthRoll = rng();
      const lengthFrac = 0.15 + Math.pow(lengthRoll, 1.8) * 0.65;
      const branchLength = length * lengthFrac;

      const localParentW = baseW * (1 - subT);
      const subBaseW = Math.min(localParentW, baseW * (0.55 + rng() * 0.25));

      growBranch(
        subBaseX,
        subBaseY,
        subDx / subLength,
        subDy / subLength,
        branchLength,
        subBaseW,
        depth + 1,
        pool,
        branchStartIndex + segOffset,
      ); // parent segment we're touching
    }
  }

  // ── Per-cell crack generation ────────────────────────────────────
  for (const c of v.cells) {
    if (c.poly.length < 3) continue;
    let cx = 0,
      cy = 0;
    for (const p of c.poly) {
      cx += p[0];
      cy += p[1];
    }
    cx /= c.poly.length;
    cy /= c.poly.length;

    // Variable count: 0-4 cracks per tile.  Distribution weighted
    // toward 1-2 cracks; sometimes 0 (~20% of cells stay un-cracked);
    // occasional 3-4 in larger cells.  All scaled by crackProb slider.
    //   roll < 0.20 → 0 cracks  (un-cracked tile)
    //   roll < 0.55 → 1 crack
    //   roll < 0.85 → 2 cracks
    //   roll < 0.97 → 3 cracks
    //   else        → 4 cracks
    let nCracks: number;
    const baseRoll = rng();
    // Apply crackProb: rolling crackProb<1 reduces toward 0; >1 increases
    const effectiveRoll = baseRoll / Math.max(0.001, crackProb);
    if (effectiveRoll < 0.2) nCracks = 0;
    else if (effectiveRoll < 0.55) nCracks = 1;
    else if (effectiveRoll < 0.85) nCracks = 2;
    else if (effectiveRoll < 0.97) nCracks = 3;
    else nCracks = 4;
    if (nCracks === 0) continue;

    // Pool of all crack segments laid down in THIS cell.  New
    // candidates are rejected if they'd cross any existing segment.
    const pool: CrackSeg[] = [];
    const usedVerts = new Set<number>();

    for (let k = 0; k < nCracks; k++) {
      // Pick a target vertex (boundary) — prefer unused, allow retry
      let vIndex: number,
        attempts = 0;
      do {
        vIndex = Math.floor(rng() * c.poly.length);
        attempts++;
      } while (usedVerts.has(vIndex) && attempts < c.poly.length * 2);
      // If all vertices used (very small polygon), skip extras
      if (usedVerts.has(vIndex)) continue;
      const target = c.poly[vIndex];

      const dxT = target[0] - cx,
        dyT = target[1] - cy;
      const distributionT = Math.hypot(dxT, dyT);
      if (distributionT < 0.5) continue;

      // Start somewhere along centroid→target line, biased toward centroid
      const startFrac = 0.05 + rng() * 0.2;
      const startX = cx + dxT * startFrac;
      const startY = cy + dyT * startFrac;

      // Build candidate spine
      const segs = Math.max(2, Math.round(innerSegs * (0.7 + rng() * 0.6)));
      // Per-crack jog varies — some are nearly straight, some wander
      const localJog = innerJog * (0.5 + rng() * 0.9);
      const s = buildSpine(
        startX,
        startY,
        target[0],
        target[1],
        segs,
        localJog,
      );
      if (!s) continue;

      // Reject if this candidate would cross any existing crack.
      // (No exception — main cracks don't attach to anything yet.)
      if (polylineCrossesPool(s.pts, pool)) continue;

      // Accept: mark vertex, record segments, draw ribbon
      usedVerts.add(vIndex);
      const mainStartIndex = recordPolyline(s.pts, pool);
      innerD += ribbonPath(s.pts, CRACK_BASE_W, 0);

      // ── Branches off this main crack ────────────────────────────
      // 0-2 attempts at first-level branches.  Each succeeds with
      // varying probability.  Branches attach at random points along
      // the ACTUAL JAGGED SPINE (not the start→end line) so the
      // connection visually lands on the parent crack.
      let firstSide = 0;
      for (let ba = 0; ba < 2; ba++) {
        const pBranch = ba === 0 ? 0.6 : 0.35;
        if (rng() >= pBranch) continue;

        // Random position along the main crack — walk the actual spine.
        // Bias toward the wider (cell-vertex) half so branches spawn
        // from a thick parent section and end up appropriately sized.
        const branchT = 0.4 + rng() * 0.45;
        const along = pointAlongPolyline(s.pts, branchT);
        if (!along) continue;
        const branchBaseX = along.x,
          branchBaseY = along.y;
        const segOffset = along.segIndex;

        // Side: first branch picks freely; second branch prefers opposite
        let sideSign: number;
        if (ba === 0) {
          sideSign = rng() < 0.5 ? -1 : 1;
          firstSide = sideSign;
        } else {
          sideSign = rng() < 0.7 ? -firstSide : firstSide;
        }
        // Angle relative to local spine tangent (not idealized direction)
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
        if (blen < 1e-6) continue;

        const lengthRoll = rng();
        const lengthFrac = 0.2 + Math.pow(lengthRoll, 1.7) * 0.55;
        const branchLength = s.length_ * lengthFrac;

        const localW = CRACK_BASE_W * branchT * (0.7 + rng() * 0.3);

        growBranch(
          branchBaseX,
          branchBaseY,
          bx / blen,
          by / blen,
          branchLength,
          localW,
          0,
          pool,
          mainStartIndex + segOffset,
        );
      }
    }
  }
  // Filled crack polygons rendered as a single path — no stroke.
  const innerCrack = document.createElementNS(SVG_NS, "path");
  innerCrack.setAttribute("d", innerD);
  innerCrack.setAttribute("fill", "#7a5a2a");
  innerCrack.setAttribute("stroke", "none");
  innerCrack.setAttribute("fill-rule", "nonzero");
  innerCrack.setAttribute("opacity", "1");
  layers.shapes.append(innerCrack);
}

import { random as rng } from "../util/rng.js";
import { poissonDisk } from "../util/poisson.js";

export type Point = [number, number];
export type Polygon = Point[];
export interface VoronoiCell {
  seed: Point;
  poly: Polygon;
}

export interface VoronoiToolkit {
  cells: VoronoiCell[];
  cellW: number;
  cellH: number;
  edgeKey: (a: Point, b: Point) => string;
  isCanonicalForward: (a: Point, b: Point) => boolean;
  expandedPolygon: (poly: Polygon) => Polygon;
  smoothClosedPath: (pts: Polygon) => string;
  smoothOpenPath: (pts: Polygon) => string;
  straightClosedPath: (pts: Polygon) => string;
  straightOpenPath: (pts: Polygon) => string;
  wavyEdgePoints: (a: Point, b: Point) => Polygon;
  onBorder: (a: Point, b: Point) => boolean;
}

// ── Voronoi-based magma rocks ──
// Generate `count` random seed points in a rect, compute their Voronoi
// cells (clipped to the rect), and draw each cell as a filled polygon with
// a randomized magma-palette fill.
//
// Voronoi via half-plane clipping: for each seed, start with the bounding
// rect and successively clip it against the perpendicular bisector of every
// OTHER seed.  Inefficient (O(n²) per cell, O(n³) total) but n is small
// (~25) so it's instant.
export function clipPolygonByHalfplane(
  poly: Polygon,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  sx: number,
  sy: number,
): Polygon {
  // Keep points on the same side of the line (ax,ay)-(bx,by) as (sx,sy).
  // Line normal: (-dy, dx) where d = b - a.
  const dx = bx - ax,
    dy = by - ay;
  // For a point p, sign = (p - a) · normal = (p.x - ax) * (-dy) + (p.y - ay) * dx
  function side(px: number, py: number): number {
    return (px - ax) * -dy + (py - ay) * dx;
  }
  const seedSide = side(sx, sy);
  if (Math.abs(seedSide) < 1e-9) return poly; // seed exactly on line; skip
  const out: Polygon = [];
  const keep = (s: number) => (seedSide > 0 ? s >= 0 : s <= 0);
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const sCur = side(cur[0], cur[1]);
    const sNxt = side(nxt[0], nxt[1]);
    const curIn = keep(sCur);
    const nxtIn = keep(sNxt);
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      // Compute intersection of segment cur→nxt with the line
      const t = sCur / (sCur - sNxt);
      out.push([
        cur[0] + t * (nxt[0] - cur[0]),
        cur[1] + t * (nxt[1] - cur[1]),
      ]);
    }
  }
  return out;
}

// Build Voronoi cells with shared wavy-edge utilities.  Returns the cells
// plus a small toolkit of helpers that all use the same edge-noise cache so
// adjacent cells share their wavy boundary, and any layer drawn along the
// edges (rocks, cracks, caustics) registers exactly with the cell shapes.
//
// `count`        — target number of cells
// `lloydIters`   — Lloyd-relaxation rounds (more = more uniform cells)
// `noiseAmp`     — perpendicular noise amplitude as fraction of edge length
export function voronoiCellsWithWavyEdges(
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
  lloydIters: number,
  noiseAmp: number,
): VoronoiToolkit {
  // 1. Seed distribution via Poisson-disk rejection sampling.
  const minDist = Math.sqrt((w * h) / count) * 0.55;
  let seeds: Point[] = poissonDisk(x, y, w, h, minDist, count, rng, 60);
  const cellW = Math.sqrt((w * h) / count);
  const cellH = cellW;

  const rect: Polygon = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];

  function buildCells(currentSeeds: Point[]): VoronoiCell[] {
    const out: VoronoiCell[] = [];
    for (let i = 0; i < currentSeeds.length; i++) {
      const [sx, sy] = currentSeeds[i];
      let cell: Polygon = [...rect];
      for (let j = 0; j < currentSeeds.length; j++) {
        if (i === j) continue;
        const [tx, ty] = currentSeeds[j];
        const mx = (sx + tx) / 2,
          my = (sy + ty) / 2;
        const px = mx - (ty - sy);
        const py = my + (tx - sx);
        cell = clipPolygonByHalfplane(cell, mx, my, px, py, sx, sy);
        if (cell.length < 3) break;
      }
      if (cell.length >= 3) out.push({ seed: [sx, sy], poly: cell });
    }
    return out;
  }

  // 2. Lloyd relaxation
  let cells = buildCells(seeds);
  for (let iter = 0; iter < lloydIters; iter++) {
    seeds = cells.map((c): Point => {
      let cx = 0,
        cy = 0;
      for (const [px, py] of c.poly) {
        cx += px;
        cy += py;
      }
      return [cx / c.poly.length, cy / c.poly.length];
    });
    cells = buildCells(seeds);
  }

  // 3. Per-vertex jitter via shared-coord map
  const JITTER = Math.min(cellW, cellH) * 0.18;
  const jitterMap = new Map<string, Point>();
  function jitterKey(p: Point): string {
    return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  }
  for (const c of cells) {
    for (const p of c.poly) {
      const k = jitterKey(p);
      if (!jitterMap.has(k)) {
        jitterMap.set(k, [
          p[0] + (rng() - 0.5) * JITTER,
          p[1] + (rng() - 0.5) * JITTER,
        ]);
      }
    }
  }
  for (const c of cells) {
    c.poly = c.poly.map((p) => jitterMap.get(jitterKey(p))!);
  }

  // 4. Edge-noise cache + helpers
  function edgeKey(a: Point, b: Point): string {
    const k1 = `${a[0].toFixed(2)},${a[1].toFixed(2)}`;
    const k2 = `${b[0].toFixed(2)},${b[1].toFixed(2)}`;
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  }
  function isCanonicalForward(a: Point, b: Point): boolean {
    const k1 = `${a[0].toFixed(2)},${a[1].toFixed(2)}`;
    const k2 = `${b[0].toFixed(2)},${b[1].toFixed(2)}`;
    return k1 < k2;
  }
  const edgeNoiseCache = new Map<string, Point[]>();
  function getEdgeNoise(a: Point, b: Point): Point[] {
    const k = edgeKey(a, b);
    if (edgeNoiseCache.has(k)) return edgeNoiseCache.get(k)!;
    const [p, q] = isCanonicalForward(a, b) ? [a, b] : [b, a];
    const dx = q[0] - p[0],
      dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.5) {
      edgeNoiseCache.set(k, []);
      return [];
    }
    const ux = dx / len,
      uy = dy / len;
    const px = -uy,
      py = ux;
    const amplitude = Math.min(len * noiseAmp, 1.4);
    const N = 4;
    const pts: Point[] = [];
    for (let i = 1; i <= N; i++) {
      const t = i / (N + 1);
      const baseX = p[0] + dx * t;
      const baseY = p[1] + dy * t;
      const env = Math.sin(t * Math.PI);
      const noise = (rng() - 0.5) * 1.6 + (rng() - 0.5) * 0.6;
      const offset = noise * amplitude * env;
      pts.push([baseX + px * offset, baseY + py * offset]);
    }
    edgeNoiseCache.set(k, pts);
    return pts;
  }

  function expandedPolygon(poly: Polygon): Polygon {
    const out: Polygon = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      out.push(a);
      const mids = getEdgeNoise(a, b);
      if (isCanonicalForward(a, b)) for (const p of mids) out.push(p);
      else for (let j = mids.length - 1; j >= 0; j--) out.push(mids[j]);
    }
    return out;
  }

  function smoothClosedPath(pts: Polygon): string {
    const n = pts.length;
    if (n < 3) return "";
    const startMid: Point = [
      (pts[n - 1][0] + pts[0][0]) / 2,
      (pts[n - 1][1] + pts[0][1]) / 2,
    ];
    let d = `M ${startMid[0]} ${startMid[1]} `;
    for (let i = 0; i < n; i++) {
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const mid: Point = [(cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2];
      d += `Q ${cur[0]} ${cur[1]} ${mid[0]} ${mid[1]} `;
    }
    d += "Z";
    return d;
  }

  function smoothOpenPath(pts: Polygon): string {
    const n = pts.length;
    if (n < 2) return "";
    if (n === 2)
      return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]} `;
    let d = `M ${pts[0][0]} ${pts[0][1]} `;
    for (let i = 1; i < n - 1; i++) {
      const cur = pts[i];
      const next = pts[i + 1];
      const mid: Point = [(cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2];
      d += `Q ${cur[0]} ${cur[1]} ${mid[0]} ${mid[1]} `;
    }
    d += `L ${pts[n - 1][0]} ${pts[n - 1][1]} `;
    return d;
  }

  // Straight (non-Bezier) variants — segments stay angular for crisper
  // dried-mud / jagged-rock looks where the Bezier smoothing would round
  // off the sharp kinks.
  function straightClosedPath(pts: Polygon): string {
    const n = pts.length;
    if (n < 3) return "";
    let d = `M ${pts[0][0]} ${pts[0][1]} `;
    for (let i = 1; i < n; i++) d += `L ${pts[i][0]} ${pts[i][1]} `;
    d += "Z";
    return d;
  }
  function straightOpenPath(pts: Polygon): string {
    const n = pts.length;
    if (n < 2) return "";
    let d = `M ${pts[0][0]} ${pts[0][1]} `;
    for (let i = 1; i < n; i++) d += `L ${pts[i][0]} ${pts[i][1]} `;
    return d;
  }

  function wavyEdgePoints(a: Point, b: Point): Polygon {
    const mids = getEdgeNoise(a, b);
    const ordered = isCanonicalForward(a, b) ? mids : mids.toReversed();
    return [a, ...ordered, b];
  }

  function onBorder(a: Point, b: Point): boolean {
    return (
      (Math.abs(a[0] - x) < 0.5 && Math.abs(b[0] - x) < 0.5) ||
      (Math.abs(a[0] - (x + w)) < 0.5 && Math.abs(b[0] - (x + w)) < 0.5) ||
      (Math.abs(a[1] - y) < 0.5 && Math.abs(b[1] - y) < 0.5) ||
      (Math.abs(a[1] - (y + h)) < 0.5 && Math.abs(b[1] - (y + h)) < 0.5)
    );
  }

  return {
    cells,
    cellW,
    cellH,
    edgeKey,
    isCanonicalForward,
    expandedPolygon,
    smoothClosedPath,
    smoothOpenPath,
    straightClosedPath,
    straightOpenPath,
    wavyEdgePoints,
    onBorder,
  };
}

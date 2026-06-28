// Butterfly geometry baked from two hand-drawn SVGs (a top-down view and a
// side profile).  Each SVG path is flattened to a polygon and ear-clipped into
// triangles once, then every placed butterfly transforms those triangles
// (scale, mirror, bank, translate) and recolors them: the two/four blue wing
// tones map onto a single random per-butterfly hue at descending brightness,
// the brown body/antennae stay brown.  Output is flat (x, y, r, g, b) vertices
// for the grass scene's solid-mesh (triangle-list) draw, so butterflies share
// the hill layering and atmospheric darkening of everything else.
//
// The SVG path order already encodes the z-order (top-down: body, antennae,
// then wings over them; side: far wings, body, then near wings over it), and
// triangles render in append order, so no extra layering work is needed.

type Point = [number, number];
type RGB = [number, number, number];

// Source palette shared by both SVGs.  `light` is the random wing hue itself;
// the darker tones are that hue scaled down; `body` is the fixed brown.
type Role = "light" | "med" | "dark" | "darkest" | "body";
function roleOf(fill: string): Role {
  switch (fill.toUpperCase()) {
    case "#5DA6FF": {
      return "light";
    }
    case "#1172E0": {
      return "med";
    }
    case "#0E4383": {
      return "dark";
    }
    case "#061B34": {
      return "darkest";
    }
    default: {
      return "body";
    }
  }
}
// Far-side wing darkening (the side view's back fore/hind wings).
const FAR_WING = 0.55;
// Per-wing brightness multiplier on the butterfly's hue.  Hindwings (med /
// darkest) reuse their forewing's color at `overlay` strength — a shadow that
// makes the forewing read as sitting on top — and the far side is dimmer still.
function wingFactor(role: Role, overlay: number): number {
  switch (role) {
    case "med": {
      return overlay;
    }
    case "dark": {
      return FAR_WING;
    }
    case "darkest": {
      return FAR_WING * overlay;
    }
    default: {
      return 1; // light (forewing); body handled separately
    }
  }
}

interface SvgPath {
  fill: string;
  d: string;
}

// ─── The two source drawings (viewBox-space path data) ───────────────
const TOP_VIEWBOX: SvgPath[] = [
  {
    fill: "#3A1B00",
    d: "M155.532 39C162.032 39.0001 163.032 41.5001 164.532 46C166.032 50.4999 161.532 52 161.532 56C165.532 67.9999 169.532 63.5001 167.532 82.5C165.532 101.5 159.532 116.5 159.532 122.5C159.532 128.5 161.532 155.499 155.532 155.5C149.532 155.5 151.532 128.5 151.532 122.5C151.532 116.5 145.532 101.5 143.532 82.5C141.532 63.5 145.532 68 149.532 56C149.532 52 145.032 50.5 146.532 46C148.032 41.5 149.032 39 155.532 39Z",
  },
  {
    fill: "#3A1B00",
    d: "M119 4.5C137 5.7 147.5 30 150.5 42L148.5 43.5C148 38.5 144.5 29 141 23.5C137.5 18 130 11 126 9C122 7 122.5 9.5 119 11C115.5 12.5 113 10 113 7.5C113 5 113 4.5 119 4.5Z",
  },
  {
    fill: "#3A1B00",
    d: "M191.5 4.5C173.5 5.7 163 30 160 42L162 43.5C162.5 38.5 166 29 169.5 23.5C173 18 180.5 11 184.5 9C188.5 7 188 9.5 191.5 11C195 12.5 197.5 10 197.5 7.5C197.5 5 197.5 4.5 191.5 4.5Z",
  },
  {
    fill: "#1172E0",
    d: "M58 101.5C67 80.0001 138 81 149 95.5C153.5 160 132 204.5 105.5 204.5C79 204.5 85.5 187 73 176C63 167.2 68.8333 158.333 73 155C58.5 156 64.5 139.5 63.5 131.5C62.5 123.5 49 123 58 101.5Z",
  },
  {
    fill: "#5DA6FF",
    d: "M4.33652 12.9401C45.5365 -25.8599 119.837 31.7734 151.837 65.4401C157.836 117.94 101.337 96.4401 83.8365 98.4401C66.3365 100.44 53.8365 95.9401 42.8365 65.4401C31.8365 34.9401 -14.1635 34.9401 4.33652 12.9401Z",
  },
  {
    fill: "#1172E0",
    d: "M253.281 101.5C244.281 80.0001 173.281 81 162.281 95.5C157.781 160 179.281 204.5 205.781 204.5C232.281 204.5 225.781 187 238.281 176C248.281 167.2 242.447 158.333 238.281 155C252.781 156 246.781 139.5 247.781 131.5C248.781 123.5 262.281 123 253.281 101.5Z",
  },
  {
    fill: "#5DA6FF",
    d: "M306.944 12.9401C265.744 -25.8599 191.444 31.7734 159.444 65.4401C153.444 117.94 209.944 96.4401 227.444 98.4401C244.944 100.44 257.444 95.9401 268.444 65.4401C279.444 34.9401 325.444 34.9401 306.944 12.9401Z",
  },
];

const SIDE_VIEWBOX: SvgPath[] = [
  {
    fill: "#061B34",
    d: "M142.448 115.768C165.108 121.225 175.443 191.476 162.882 204.647C99.9254 219.375 52.5663 205.246 48.3405 179.085C44.1147 152.924 62.4273 156.55 71.2933 142.456C78.386 131.181 88.0694 135.526 92.0245 139.108C88.7251 124.953 105.971 128.245 113.709 125.982C121.447 123.719 119.788 110.312 142.448 115.768Z",
  },
  {
    fill: "#0E4383",
    d: "M221.317 48.6694C266.191 83.1551 221.143 165.695 193.01 202.654C142.139 216.949 154.354 157.743 149.589 140.786C144.824 123.829 147.273 110.771 175.629 95.0486C203.984 79.3257 196.649 33.9143 221.317 48.6694Z",
  },
  {
    fill: "#3A1B00",
    d: "M233.056 183.586C235.5 189.609 233.559 191.476 229.953 194.557C226.347 197.639 223.265 194.033 219.559 195.537C209.943 203.755 215.616 205.769 197.258 211.059C178.9 216.348 162.745 216.427 157.185 218.683C151.625 220.938 127.357 232.942 125.102 227.382C122.848 221.822 148.618 213.525 154.177 211.269C159.737 209.014 171.381 197.815 188.236 188.819C205.09 179.823 202.424 185.222 215.048 184.417C218.754 182.913 218.453 178.18 223.186 177.878C227.92 177.576 230.613 177.563 233.056 183.586Z",
  },
  {
    fill: "#3A1B00",
    d: "M251.293 136.765C256.947 153.896 238.377 172.761 228.385 180.052L226.243 178.762C230.688 176.419 238.176 169.605 241.957 164.294C245.737 158.983 249.405 149.402 249.754 144.943C250.104 140.485 247.975 141.888 245.269 139.209C242.564 136.529 243.94 133.273 246.257 132.333C248.574 131.393 249.037 131.205 251.293 136.765Z",
  },
  {
    fill: "#1172E0",
    d: "M138.476 116.704C161.782 116.962 187.546 183.13 178.245 198.774C120.168 227.191 70.8496 223.997 60.8876 199.441C50.9255 174.885 69.5854 174.329 75.0794 158.611C79.4747 146.036 89.8839 148.108 94.5391 150.716C88.1615 137.656 105.707 137.013 112.744 133.079C119.781 129.145 115.17 116.447 138.476 116.704Z",
  },
  {
    fill: "#5DA6FF",
    d: "M200.366 33.685C251.809 57.277 226.334 147.793 207.167 190.102C160.773 215.398 159.456 154.96 151.024 139.495C142.592 124.031 142.063 110.756 166.191 89.0972C190.318 67.4383 173.025 24.8124 200.366 33.685Z",
  },
];

// Forewing span (mm) at sizeScale 1 — each variant is scaled so its forewing
// matches this, keeping the top and side butterflies a consistent size.
const TARGET_FOREWING_MM = 3.4;
// Extra scale applied to the side profile only.  The side view is more compact
// than the top view, so matching forewings alone leaves it reading a bit small;
// this nudges its overall size back toward the top view's.
export const SIDE_SCALE = 1.25;
// Cubic-Bézier flattening segments.  Also the resolution of the baked outline
// the shader measures distance to, so kept high enough that the margin/outline
// reads smooth even zoomed in.
const CURVE_SEGMENTS = 18;

// ─── SVG path → polygon ──────────────────────────────────────────────
function flattenCubic(
  out: Point[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): void {
  for (let k = 1; k <= CURVE_SEGMENTS; k++) {
    const t = k / CURVE_SEGMENTS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
}

// Parse an absolute-coordinate M/L/C/Z path into one closed polygon.  Both
// source SVGs use a single subpath per path, so this returns one ring.
function pathToPolygon(d: string): Point[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const pts: Point[] = [];
  let index = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  const number_ = (): number => Number.parseFloat(tokens[index++]);
  while (index < tokens.length) {
    if (/^[MLCZ]$/i.test(tokens[index])) {
      cmd = tokens[index].toUpperCase();
      index++;
    }
    switch (cmd) {
      case "M": {
        cx = number_();
        cy = number_();
        pts.push([cx, cy]);
        cmd = "L"; // implicit line-to for subsequent coordinate pairs

        break;
      }
      case "L": {
        cx = number_();
        cy = number_();
        pts.push([cx, cy]);

        break;
      }
      case "C": {
        const x1 = number_();
        const y1 = number_();
        const x2 = number_();
        const y2 = number_();
        const x3 = number_();
        const y3 = number_();
        flattenCubic(pts, cx, cy, x1, y1, x2, y2, x3, y3);
        cx = x3;
        cy = y3;

        break;
      }
      default: {
        // Z (or stray token): close — the fill is already implicitly closed.
        index++;
      }
    }
  }
  // Drop a trailing point that coincides with the start.
  const a = pts[0];
  const b = pts.at(-1);
  if (b && Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4) pts.pop();
  return pts;
}

// ─── Ear-clipping triangulation (simple polygons, no holes) ──────────
function signedArea(p: Point[]): number {
  let s = 0;
  for (let index = 0; index < p.length; index++) {
    const a = p[index];
    const b = p[(index + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
function pointInTri(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(p, a, b);
  const d2 = cross(p, b, c);
  const d3 = cross(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function orientCcw(polygon: Point[]): Point[] {
  return signedArea(polygon) < 0 ? polygon.toReversed() : [...polygon];
}

// Ear-clip a CCW polygon, returning triangle vertex INDICES into `poly`.  Index
// triples (rather than coordinates) let callers move each polygon vertex
// independently — needed for the constant-width inset offset.
function triangulateIndices(poly: Point[]): number[] {
  const index = poly.map((_, n) => n);
  const tris: number[] = [];
  let guard = 0;
  const limit = index.length * index.length + 16;
  while (index.length > 3 && guard++ < limit) {
    let clipped = false;
    for (let index_ = 0; index_ < index.length; index_++) {
      const ia = index[(index_ - 1 + index.length) % index.length];
      const ib = index[index_];
      const ic = index[(index_ + 1) % index.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(a, b, c) <= 0) continue; // reflex or collinear vertex
      let empty = true;
      for (const index__ of index) {
        if (index__ === ia || index__ === ib || index__ === ic) continue;
        if (pointInTri(poly[index__], a, b, c)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      tris.push(ia, ib, ic);
      index.splice(index_, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate remainder — stop rather than loop forever
  }
  if (index.length === 3) tris.push(index[0], index[1], index[2]);
  return tris;
}

// ─── Baked template (built once per variant) ─────────────────────────
interface TemplateGroup {
  role: Role;
  pattern: boolean; // wings carry the Voronoi membrane; body/back wings don't
  // CCW outline as flat [x,y, ...] in local mm (centered on the drawing's bbox,
  // scaled so the forewing matches across variants, SVG y-down orientation).
  poly: number[];
  // Triangle vertex indices into `poly`.
  tris: number[];
  centroid: [number, number]; // outline centroid (stretch direction reference)
  meanRadius: number; // mean vertex distance from centroid (sizes the outline band)
  // Range into BAKED_OUTLINES (set during baking) — the wing outline the shader
  // measures distance to for the margin/outline.  0/0 for unpatterned groups.
  polyStart: number;
  polyCount: number;
}
interface Template {
  groups: TemplateGroup[];
  // Stretch origin: the wing pattern elongates toward this point.  It's the
  // area-weighted centroid of the body paths — the spine center (top view) or
  // the body/thorax (side view).
  origin: [number, number];
}
function centroidOf(polygon: Point[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [px, py] of polygon) {
    sx += px;
    sy += py;
  }
  return [sx / polygon.length, sy / polygon.length];
}
function meanRadiusOf(polygon: Point[], c: [number, number]): number {
  let sum = 0;
  for (const [px, py] of polygon) sum += Math.hypot(px - c[0], py - c[1]);
  return sum / polygon.length;
}
function bboxMaxDim(poly: Point[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of poly) {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  return Math.max(maxX - minX, maxY - minY);
}
function buildTemplate(paths: SvgPath[]): Template {
  const raw = paths.map((p) => {
    const poly = orientCcw(pathToPolygon(p.d));
    const centroid = centroidOf(poly);
    return { role: roleOf(p.fill), poly, tris: triangulateIndices(poly), centroid };
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of raw) {
    for (const [px, py] of g.poly) {
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Scale by the forewing's size (not the overall bbox) so the wings — and so
  // the whole insect — read at a consistent size across the top and side
  // variants, rather than the side coming out oversized.
  let forewing = 0;
  for (const g of raw) if (g.role === "light") forewing = Math.max(forewing, bboxMaxDim(g.poly));
  const scale = TARGET_FOREWING_MM / (forewing || Math.max(maxX - minX, maxY - minY));
  const transform = ([x, y]: [number, number]): [number, number] => [
    (x - cx) * scale,
    (y - cy) * scale,
  ];

  // Stretch origin = area-weighted centroid of the body paths.
  let ox = 0;
  let oy = 0;
  let wsum = 0;
  for (const g of raw) {
    if (g.role !== "body") continue;
    const a = Math.abs(signedArea(g.poly));
    ox += g.centroid[0] * a;
    oy += g.centroid[1] * a;
    wsum += a;
  }
  const originRaw: [number, number] = wsum > 0 ? [ox / wsum, oy / wsum] : [cx, cy];

  return {
    origin: transform(originRaw),
    groups: raw.map((g) => ({
      role: g.role,
      pattern: hasPattern(g.role),
      poly: g.poly.flatMap(([x, y]) => [(x - cx) * scale, (y - cy) * scale]),
      tris: g.tris,
      centroid: transform(g.centroid),
      meanRadius: meanRadiusOf(g.poly, g.centroid) * scale,
      polyStart: 0,
      polyCount: 0,
    })),
  };
}

// ─── Baked outlines for the shader's exact edge distance ─────────────
// Both templates are built once; each patterned wing's outline is decimated and
// appended to a single flat array the shader bakes as a constant.  The shader
// loops these segments to get the exact distance from a fragment to the wing
// edge — a true, uniform-width margin/outline with no corner artifacts.
const topTemplate: Template = buildTemplate(TOP_VIEWBOX);
const sideTemplate: Template = buildTemplate(SIDE_VIEWBOX);
const BAKED_OUTLINES: number[] = [];
function bakeOutlines(template: Template): void {
  for (const g of template.groups) {
    if (!g.pattern) continue;
    const n = g.poly.length / 2;
    // Full outline resolution — the distance field (hence the margin/outline)
    // must stay smooth, not faceted, even zoomed in.
    g.polyStart = BAKED_OUTLINES.length / 2;
    for (let index = 0; index < n; index++) {
      BAKED_OUTLINES.push(g.poly[2 * index], g.poly[2 * index + 1]);
    }
    g.polyCount = BAKED_OUTLINES.length / 2 - g.polyStart;
  }
}
bakeOutlines(topTemplate);
bakeOutlines(sideTemplate);

// Full wingspan (mm) of a baked template at sizeScale 1 — the width of its
// local-mm bounding box across every group.
function templateWidth(template: Template): number {
  let min = Infinity;
  let max = -Infinity;
  for (const g of template.groups) {
    for (let index = 0; index < g.poly.length; index += 2) {
      min = Math.min(min, g.poly[index]);
      max = Math.max(max, g.poly[index]);
    }
  }
  return max - min;
}
// The butterfly's wingspan (mm) at sizeScale 1, used by the scene to keep
// butterflies at least one width apart.  The side profile is enlarged by
// SIDE_SCALE at emit, so take the larger of the two variants.
export const BUTTERFLY_WIDTH_MM = Math.max(
  templateWidth(topTemplate),
  templateWidth(sideTemplate) * SIDE_SCALE,
);

export interface ButterflyParameters {
  bx: number; // world position (mm) — the butterfly's center
  by: number;
  sizeScale: number; // flower convention: deeper hills → smaller
  tilt: number; // banking rotation (radians)
  side: boolean; // side profile vs top-down
  faceSign: number; // ±1, mirrors left/right
  base: RGB; // random wing hue
  spot: RGB; // second random hue for the Voronoi cell pattern
  bodyColor: RGB; // brown body/antennae
  darken: number; // atmospheric perspective multiplier
  seed: number; // de-correlates each butterfly's Voronoi field
  hindOverlay: number; // 0..1 shadow multiplier on hindwings
  sideForewingDeg: number; // side view near-forewing extra stretch rotation (degrees)
  topForewingDeg: number; // top view forewing extra stretch rotation (degrees, mirror-symmetric)
}

// Floats per butterfly vertex: x, y, base rgb (3), spot rgb (3), pattern flag,
// radial coord (mirrored local position, for the Voronoi domain) (2), seed,
// stretch direction (2), mean radius, baked-outline range (polyStart, polyCount)
// for the exact edge distance, and faceSign (to un-mirror for that distance).
export const BUTTERFLY_STRIDE = 18;

// ─── Wing shader (Voronoi membrane) ──────────────────────────────────
// Minimal uniform block — a banner origin/size in mm and an mm→NDC map.  Reads
// only the first 16 bytes, so it's compatible with the grass scene's larger
// shared uniform buffer.
const UNIFORM_DECL = /* wgsl */ `
struct Uniforms {
  bannerOrigin: vec2<f32>,
  bannerSize: vec2<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

fn mmToNdc(p: vec2<f32>) -> vec4<f32> {
  let nx = (p.x - u.bannerOrigin.x) / u.bannerSize.x * 2.0 - 1.0;
  let ny = 1.0 - (p.y - u.bannerOrigin.y) / u.bannerSize.y * 2.0;
  return vec4<f32>(nx, ny, 0.0, 1.0);
}
`;

// Tunable knobs for the wing pattern (the test page drives these live).
// `borderInset` and `outlineWidth` are geometry (handled in emitButterfly); the
// rest are shader.
interface VoronoiParameters {
  cellScale: number; // cells per mm of wing-local space (higher = smaller cells)
  spotThreshold: number; // 0..1; fraction (1 - t) of cells that take the spot hue
  veinWidth: number; // border distance over which the vein darkens out
  veinDarken: number; // multiplier for the vein color (lower = darker veins)
  borderInset: number; // base-color margin width (fraction of the wing's mean radius)
  outlineWidth: number; // vein outline ring width (fraction of the wing's mean radius)
  radialStretch: number; // ≥1; compresses the Voronoi radially → cells stretch toward the body
  cornerRound: number; // smooth-min strength on cell borders → rounded cell corners
  hindOverlay: number; // 0..1 shadow multiplier on hindwings (lower = forewing reads more on top)
  sideForewingDeg: number; // extra stretch rotation on the side view's near forewing
  topForewingDeg: number; // extra stretch rotation on the top view's forewings (mirror-symmetric)
}
export const DEFAULT_VORONOI: VoronoiParameters = {
  cellScale: 1.5,
  spotThreshold: 0.43,
  veinWidth: 0.045,
  veinDarken: 0.5,
  borderInset: 0.06,
  outlineWidth: 0.07,
  radialStretch: 1.85,
  cornerRound: 0.11,
  hindOverlay: 0.76,
  sideForewingDeg: 25,
  topForewingDeg: -25,
};

function wgslNumber(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : n.toString();
}

// Build the butterfly mesh shader.  Pre-tessellated SVG triangles (triangle-
// list); the patterned wings (flag 1) get a Voronoi membrane — a fraction of
// cells take the spot hue, the rest the base hue, with darkened veins along the
// borders — while the body and dark back wings (flag 0) stay flat.
function butterflyWgsl(p: VoronoiParameters = DEFAULT_VORONOI): string {
  return (
    UNIFORM_DECL +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read> verts: array<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) base: vec3<f32>,
  @location(1) spot: vec3<f32>,
  @location(2) patt: f32,
  @location(3) rad: vec2<f32>,
  @location(4) seed: f32,
  @location(5) wdir: vec2<f32>,
  @location(6) mr: f32,
  @location(7) polyStart: f32,
  @location(8) polyCount: f32,
  @location(9) faceSign: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let b = idx * ${String(BUTTERFLY_STRIDE)}u;
  var out: VsOut;
  out.pos = mmToNdc(vec2<f32>(verts[b], verts[b + 1u]));
  out.base = vec3<f32>(verts[b + 2u], verts[b + 3u], verts[b + 4u]);
  out.spot = vec3<f32>(verts[b + 5u], verts[b + 6u], verts[b + 7u]);
  out.patt = verts[b + 8u];
  out.rad = vec2<f32>(verts[b + 9u], verts[b + 10u]);
  out.seed = verts[b + 11u];
  out.wdir = vec2<f32>(verts[b + 12u], verts[b + 13u]);
  out.mr = verts[b + 14u];
  out.polyStart = verts[b + 15u];
  out.polyCount = verts[b + 16u];
  out.faceSign = verts[b + 17u];
  return out;
}

// Polynomial smooth-min — rounds the junctions where cell borders meet and the
// convex corners of the wing outline.
fn smin(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.0) { return min(a, b); }
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Baked wing outlines (local mm) + smoothed distance from a point to the wing's
// outline range [start, start+count).  The smooth-min over segments rounds the
// outline's own convex corners (e.g. the wing tip) by the same rnd strength.
${bakedOutlineDecl()}
fn segDist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}
fn outlineSegDist(p: vec2<f32>, start: u32, count: u32, i: u32) -> f32 {
  return segDist(p, OUTLINE[start + i], OUTLINE[start + ((i + 1u) % count)]);
}
fn distToOutline(p: vec2<f32>, start: u32, count: u32, rnd: f32) -> f32 {
  // Pass 1: exact nearest segment — straight and smoothly curved edges stay
  // crisp (no ripple).
  var best = 1e9;
  var bi = 0u;
  for (var i = 0u; i < count; i = i + 1u) {
    let dseg = outlineSegDist(p, start, count, i);
    if (dseg < best) { best = dseg; bi = i; }
  }
  // Pass 2: round only genuine corners.  Smooth-min the nearest segment with a
  // neighbour, but scale the strength by how sharp the join is — a smooth curve
  // (small turn) gets ~no rounding, so only real corners (e.g. the wing tip)
  // fillet.
  let li = (bi + count - 1u) % count;
  let ri = (bi + 1u) % count;
  let pa = OUTLINE[start + bi];
  let pb = OUTLINE[start + ri];
  let pl = OUTLINE[start + li];
  let pr = OUTLINE[start + ((ri + 1u) % count)];
  let dB = normalize(pb - pa);
  let dL = normalize(pa - pl);
  let dR = normalize(pr - pb);
  let sharpL = 1.0 - dot(dL, dB);
  let sharpR = 1.0 - dot(dB, dR);
  var d = best;
  d = smin(d, outlineSegDist(p, start, count, li), rnd * smoothstep(0.08, 0.45, sharpL));
  d = smin(d, outlineSegDist(p, start, count, ri), rnd * smoothstep(0.08, 0.45, sharpR));
  return d;
}

fn hash2(q: vec2<f32>) -> vec2<f32> {
  return fract(sin(vec2<f32>(dot(q, vec2<f32>(127.1, 311.7)), dot(q, vec2<f32>(269.5, 183.3)))) * 43758.5453);
}
fn hash1(q: vec2<f32>) -> f32 {
  return fract(sin(dot(q, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Voronoi returning (distance-to-nearest-border, cellId.x, cellId.y).  The
// border pass uses a smooth-min (strength rnd) so cell corners are rounded.
fn voronoi(p: vec2<f32>, rnd: f32) -> vec3<f32> {
  let n = floor(p);
  let f = fract(p);
  var mr = vec2<f32>(0.0);
  var mg = vec2<f32>(0.0);
  var md = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2<f32>(f32(i), f32(j));
      let o = hash2(n + g);
      let r = g + o - f;
      let d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  var me = 8.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let g = mg + vec2<f32>(f32(i), f32(j));
      let o = hash2(n + g);
      let r = g + o - f;
      let diff = mr - r;
      if (dot(diff, diff) > 0.0001) {
        me = smin(me, dot(0.5 * (mr + r), normalize(r - mr)), rnd);
      }
    }
  }
  return vec3<f32>(me, n + mg);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let vein = in.base * ${wgslNumber(p.veinDarken)};

  // Build the Voronoi sample point, compressing along the wing's stretch axis
  // (wdir) so cells elongate toward the body.  Computed for every fragment so
  // the fwidth() below stays in uniform control flow.
  let t = vec2<f32>(-in.wdir.y, in.wdir.x);
  let pr = dot(in.rad, in.wdir) / ${wgslNumber(p.radialStretch)};
  let pt = dot(in.rad, t);
  var sp = (in.wdir * pr + t * pt) * ${wgslNumber(p.cellScale)};
  sp = sp + vec2<f32>(in.seed, in.seed * 1.7);

  let vc = voronoi(sp, ${wgslNumber(p.cornerRound)});
  let cell = select(in.base, in.spot, hash1(vc.yz) > ${wgslNumber(p.spotThreshold)});

  // Exact distance from this fragment to the wing outline (un-mirror rad).  A
  // base-color margin of borderInset·mr hugs the edge, then a vein-colored
  // outline band of outlineWidth·mr, then the Voronoi interior — all true,
  // uniform-width distance bands, so corners stay clean.
  let ep = vec2<f32>(in.rad.x * in.faceSign, in.rad.y);
  // Outline-corner rounding uses the same cornerRound, converted from Voronoi
  // units to mm (the units of the outline distance).
  let de = distToOutline(ep, u32(in.polyStart), u32(in.polyCount), ${wgslNumber(p.cornerRound)} / ${wgslNumber(p.cellScale)});
  let wMargin = ${wgslNumber(p.borderInset)} * in.mr;
  let wOut = ${wgslNumber(p.outlineWidth)} * in.mr;

  // Ink = veins ∪ outline band, smooth-unioned so a vein fillets into the
  // outline (same rounding as cell corners).  Both in Voronoi-domain units.
  let dVein = vc.x - ${wgslNumber(p.veinWidth)};
  let dBand = max(wMargin - de, de - (wMargin + wOut)) * ${wgslNumber(p.cellScale)};
  let dInk = smin(dVein, dBand, ${wgslNumber(p.cornerRound)});
  let aaI = fwidth(dInk);
  let pattern = mix(vein, cell, smoothstep(-aaI, aaI, dInk));

  // Base-color margin (de < wMargin) → flat base; beyond → the pattern.
  let mEdge = (de - wMargin) * ${wgslNumber(p.cellScale)};
  let aaM = fwidth(mEdge);
  let wing = mix(in.base, pattern, smoothstep(-aaM, aaM, mEdge));

  // patt 0 = plain (body, back wings); 1 = patterned wing.
  var col = in.base;
  if (in.patt > 0.5) {
    col = wing;
  }
  return vec4<f32>(col, 1.0);
}
`
  );
}

// Bake the decimated outlines as a module-scope WGSL array the distance loop
// indexes at runtime.
function bakedOutlineDecl(): string {
  const n = BAKED_OUTLINES.length / 2;
  const pts: string[] = [];
  for (let index = 0; index < n; index++) {
    pts.push(
      `vec2<f32>(${wgslNumber(BAKED_OUTLINES[2 * index])}, ${wgslNumber(BAKED_OUTLINES[2 * index + 1])})`,
    );
  }
  return `var<private> OUTLINE: array<vec2<f32>, ${String(n)}> = array<vec2<f32>, ${String(n)}>(${pts.join(", ")});`;
}

// Default-parameter shader used by the grass scene.
export const BUTTERFLY_WGSL = butterflyWgsl();

// Only the bright near/upper wings get the Voronoi pattern; the dark back wings
// (side view) and the brown body stay flat.
function hasPattern(role: Role): boolean {
  return role === "light" || role === "med";
}

// Append one butterfly's triangles to `target` (BUTTERFLY_STRIDE floats per
// vertex).  Each wing is just its plain triangulation; the shader paints the
// base margin, vein-colored outline, and Voronoi membrane from the per-vertex
// data — the exact edge distance (to the baked outline range polyStart/Count)
// drives the margin/outline, and `rad` (local position, plus `faceSign` to
// un-mirror) drives the Voronoi.
export function emitButterfly(target: number[], p: ButterflyParameters): void {
  const { groups, origin } = p.side ? sideTemplate : topTemplate;
  const cosT = Math.cos(p.tilt);
  const sinT = Math.sin(p.tilt);
  const f = p.faceSign;

  for (const group of groups) {
    // Wing color: forewing hue × per-wing factor (hindwings reuse the forewing
    // color at `hindOverlay` strength).  The body stays brown.  Base and spot
    // scale together so the whole wing — cells and veins — shares the overlay.
    const factor = wingFactor(group.role, p.hindOverlay);
    const base: RGB =
      group.role === "body"
        ? [p.bodyColor[0] * p.darken, p.bodyColor[1] * p.darken, p.bodyColor[2] * p.darken]
        : [
            p.base[0] * factor * p.darken,
            p.base[1] * factor * p.darken,
            p.base[2] * factor * p.darken,
          ];
    const spot: RGB = [
      p.spot[0] * factor * p.darken,
      p.spot[1] * factor * p.darken,
      p.spot[2] * factor * p.darken,
    ];
    const poly = group.poly;
    const [gx, gy] = group.centroid;
    // Stretch axis: direction from the body origin to this wing's centroid, so
    // cells elongate toward the body.  The forewings get an extra rotation —
    // side: toward the facing direction; top: mirror-symmetric per side.
    let rx = gx - origin[0];
    let ry = gy - origin[1];
    if (group.role === "light") {
      const deg = p.side ? p.sideForewingDeg : Math.sign(rx) * p.topForewingDeg;
      const a = (deg * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      [rx, ry] = [rx * ca - ry * sa, rx * sa + ry * ca];
    }
    const ddx = rx * f; // mirror
    const ddy = ry;
    const dlen = Math.hypot(ddx, ddy) || 1;
    const wdx = ddx / dlen;
    const wdy = ddy / dlen;
    const mr = group.meanRadius;
    const patt = group.pattern ? 1 : 0;

    for (const index of group.tris) {
      const k = 2 * index;
      const lx = poly[k];
      const ly = poly[k + 1];
      const mx = lx * f; // mirror
      const wx = mx * p.sizeScale;
      const wy = ly * p.sizeScale;
      target.push(
        p.bx + wx * cosT - wy * sinT,
        p.by + wx * sinT + wy * cosT,
        base[0],
        base[1],
        base[2],
        spot[0],
        spot[1],
        spot[2],
        patt,
        mx, // radial coord: mirrored local position
        ly,
        p.seed,
        wdx,
        wdy,
        mr,
        group.polyStart,
        group.polyCount,
        f,
      );
    }
  }
}

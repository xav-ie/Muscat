import { layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { createPxCanvas, embedCanvasAsImage } from "../util/canvas-layer.js";
import { freshSineWarpPhases, sineWarpOffsets } from "../util/sine-warp.js";

// Hermite smoothstep — clamps `t` into [a, b] then maps to a cubic ease curve.
function smoothstep(a: number, b: number, t: number): number {
  let x = (t - a) / (b - a);
  if (x < 0) x = 0;
  else if (x > 1) x = 1;
  return x * x * (3 - 2 * x);
}

// Invoke `visit(xx, yy)` for each of the 9 cells in the 3x3 neighborhood
// around (0, 0). Centralizes the nested-loop shape used by the cell-finding
// and edge-distance passes.
function sweep3x3(visit: (xx: number, yy: number) => void): void {
  for (let yy = -1; yy <= 1; yy++) {
    for (let xx = -1; xx <= 1; xx++) visit(xx, yy);
  }
}

// `count` fresh phase offsets in [0, 2π), drawn from `rand`.
function freshPhases(count: number, rand: () => number): number[] {
  const phases: number[] = [];
  for (let index = 0; index < count; index++) phases.push(rand() * Math.PI * 2);
  return phases;
}

// Signed distance from the cell's seed offset (coX, coY) to the perpendicular
// bisector between it and the neighbor at (cox, coy). Returns `null` when the
// neighbor IS the seed (degenerate) so callers can skip it.
function distanceToBisector(
  cox: number,
  coy: number,
  coX: number,
  coY: number,
): number | undefined {
  const dx = cox - coX,
    dy = coy - coY;
  const dlen = Math.hypot(dx, dy);
  if (dlen < 1e-6) return undefined;
  const nx = dx / dlen,
    ny = dy / dlen;
  const midX = 0.5 * (coX + cox);
  const midY = 0.5 * (coY + coy);
  return midX * nx + midY * ny;
}

// Lava — implements the Voronoi `DistFromEdge` technique from Inigo Quilez
// / danielilett.com.  For each pixel:
//   1. Find closest control point (cell center) → distFromCenter.
//   2. Use Quilez's trick to compute distFromEdge: distance to nearest cell
//      boundary as a CONTINUOUS scalar field (no stroked lines, no vertex
//      seams).
//   3. Threshold distFromEdge with smoothstep → lava/rock mask.
//   4. Use distFromEdge as a heightmap: rocks rise up away from edges,
//      lava sits flat in the channels.  Compute a faux-normal from the
//      gradient and apply lambertian shading → rocks look craggly with
//      visible 3D form.
//   5. Lava channels: hot palette + extra brightness near the centerline.
// All baked to a canvas and embedded as SVG <image>.
export function magmaRocks(x: number, y: number, w: number, h: number): void {
  // Baked lava configuration (chosen via slider tuning).
  // cells 12, thickness 0.080, falloff 0.140, height 3.30,
  // flow 0.036, cragginess 0.060, edge round 0.000, wobble 0.060
  const cellDensityMmInv = 12 / Math.max(1, w); // 12 cells per banner width
  const thickness = 0.08;
  const thicknessFalloff = 0.14;
  const heightStrength = 3.3;
  const flowStrength = 0.036;
  const cragginess = 0.06;
  const edgeSmooth = 0 as number; // tuning knob — set >0 to enable smooth-min cell edges
  const wobble = 0.06;

  // Render resolution — 4 px / mm, same as water.
  const { canvas, context, img, data, W, H } = createPxCanvas(w, h);

  // Cell density expressed as cells per UV (UV is normalized 0..1 across W).
  // Use cells-per-mm * mm-per-W to land on a cells-per-UV value.
  const cellDensity = cellDensityMmInv * w;

  // randomVector — straight port of Quilez's HLSL.  Deterministic per cell
  // coordinate, so adjacent pixels in the same cell get the same control.
  const angleOffset = rng() * 1000; // global per-render randomness
  function randomVector(cellX: number, cellY: number, ang: number): [number, number] {
    // Same matrix multiply / sin / fract as the shader
    const m00 = 15.27,
      m01 = 47.63,
      m10 = 99.41,
      m11 = 89.98;
    let ux = cellX * m00 + cellY * m10;
    let uy = cellX * m01 + cellY * m11;
    ux = Math.sin(ux) * 46_839.32;
    uy = Math.sin(uy) * 46_839.32;
    ux = ux - Math.floor(ux);
    uy = uy - Math.floor(uy);
    const rx = Math.sin(uy * ang) * 0.5 + 0.5;
    const ry = Math.cos(ux * ang) * 0.5 + 0.5;
    return [rx, ry];
  }

  // Closest-cell phase: scan the 3x3 neighborhood and return the closest
  // seed's squared-distance result alongside its (coX, coY) offset.
  function findClosestSeed(
    cellX: number,
    cellY: number,
    posX: number,
    posY: number,
  ): { dCenter: number; coX: number; coY: number } {
    let dCenter = 8;
    let coX = 0;
    let coY = 0;
    sweep3x3((xx, yy) => {
      const rv = randomVector(cellX + xx, cellY + yy, angleOffset);
      const cox = xx - posX + rv[0];
      const coy = yy - posY + rv[1];
      const d = cox * cox + coy * coy;
      if (d < dCenter) {
        dCenter = d;
        coX = cox;
        coY = coy;
      }
    });
    return { dCenter: Math.sqrt(dCenter), coX, coY };
  }

  // Visit each non-degenerate bisector distance from the seed (coX, coY) to
  // its 3x3 neighbors. Centralizes the rv/distanceToBisector chain so the
  // hard-min and soft-min aggregations don't need their own copy.
  function sweepBisectorDistances(
    cellX: number,
    cellY: number,
    posX: number,
    posY: number,
    coX: number,
    coY: number,
    visit: (dToEdge: number) => void,
  ): void {
    sweep3x3((xx, yy) => {
      const rv = randomVector(cellX + xx, cellY + yy, angleOffset);
      const dToEdge = distanceToBisector(xx - posX + rv[0], yy - posY + rv[1], coX, coY);
      if (dToEdge !== undefined) visit(dToEdge);
    });
  }

  // Hard-min dEdge — original Quilez behavior. Bisector intersections form
  // sharp polygon vertices where 3+ cells meet.
  function distanceFromEdgeHard(
    cellX: number,
    cellY: number,
    posX: number,
    posY: number,
    coX: number,
    coY: number,
  ): number {
    let dEdge = 8;
    sweepBisectorDistances(cellX, cellY, posX, posY, coX, coY, (d) => {
      if (d < dEdge) dEdge = d;
    });
    return dEdge;
  }

  // Soft-min dEdge via log-sum-exp. d_smooth = -k * log(Σ exp(-d / k)) —
  // small k → close to hard min; bigger k → more rounding of polygon
  // corners into smooth curves.
  function distanceFromEdgeSoft(
    cellX: number,
    cellY: number,
    posX: number,
    posY: number,
    coX: number,
    coY: number,
    k: number,
  ): number {
    let sumExp = 0;
    sweepBisectorDistances(cellX, cellY, posX, posY, coX, coY, (d) => {
      sumExp += Math.exp(-d / k);
    });
    // Guard: if no valid neighbors contributed (all were the closest cell —
    // only happens at degenerate spots), fall back to the hard-min sentinel.
    return sumExp <= 0 ? 8 : -k * Math.log(sumExp);
  }

  // distFromEdge field. Returns { distFromCenter, distFromEdge }.
  function voronoiField(uvX: number, uvY: number): { dCenter: number; dEdge: number } {
    const sX = uvX * cellDensity,
      sY = uvY * cellDensity;
    const cellX = Math.floor(sX),
      cellY = Math.floor(sY);
    const posX = sX - cellX,
      posY = sY - cellY;
    const { dCenter, coX, coY } = findClosestSeed(cellX, cellY, posX, posY);
    const dEdge =
      edgeSmooth <= 0
        ? distanceFromEdgeHard(cellX, cellY, posX, posY, coX, coY)
        : distanceFromEdgeSoft(cellX, cellY, posX, posY, coX, coY, edgeSmooth);
    return { dCenter, dEdge };
  }

  // Flow / wiggle.  Higher-frequency UV octaves: lava channels acquire
  // small wiggles.
  const flowPhases = freshSineWarpPhases(rng);
  function flowUV(uvX: number, uvY: number): [number, number] {
    const [wx, wy] = sineWarpOffsets(uvX, uvY, flowStrength, flowPhases);
    return [uvX + wx, uvY + wy];
  }

  // Edge cragginess.  Unlike flow (which moves the cell field around),
  // cragginess perturbs the dEdge VALUE directly with a high-frequency
  // multi-octave noise.  Each edge crosses the threshold at a slightly
  // different position depending on the local noise value, so cell edges
  // become ragged & jagged rather than uniformly wobbly.
  // Phases randomized per render so the cragginess pattern doesn't repeat.
  const eph = freshPhases(8, rng);
  function craggyNoise(uvX: number, uvY: number): number {
    // 3 octaves of sin-product noise.  Each octave doubles the frequency
    // and halves the contribution.  Range roughly [-1, 1].
    const f1 = 14;
    const n1 =
      Math.sin(uvX * f1 + eph[0]) * Math.cos(uvY * f1 + eph[1]) * 1 +
      Math.sin(uvX * f1 * 2.1 + eph[2]) * Math.cos(uvY * f1 * 2.1 + eph[3]) * 0.5 +
      Math.sin(uvX * f1 * 4.3 + eph[4]) * Math.cos(uvY * f1 * 4.3 + eph[5]) * 0.25;
    return n1 * (1 / 1.75); // normalize so peak ~ ±1
  }

  // Wobble — the same perturb-dEdge-directly trick as cragginess, but at
  // MEDIUM frequency.  CRITICAL: noise wavelength must be SHORTER than a
  // cell edge length, otherwise the whole edge shifts uniformly along the
  // noise gradient (looks tilted, not wobbly).  Each cell edge is ~1 cell
  // long.  Frequency cellDensity * 6.0 → wavelength ~cell/6, so each edge
  // sees ~6 oscillations along its length → visible wavy bumps.
  // Two octaves at this scale and 2x for organic non-uniform waves.
  const wph = freshPhases(8, rng);
  const wf = cellDensity * 6;
  function wobbleNoise(uvX: number, uvY: number): number {
    const n =
      Math.sin(uvX * wf + wph[0]) * Math.cos(uvY * wf + wph[1]) * 1 +
      Math.sin(uvX * wf * 2 + wph[2]) * Math.cos(uvY * wf * 2 + wph[3]) * 0.5;
    return n * (1 / 1.5);
  }

  // Height compression: raise raw height to a power > 1.  This makes the
  // height field grow MORE STEEPLY with size, so large rocks get gradients
  // proportional to their size rather than getting drowned out by the
  // disproportionately steep gradients of small rocks.  The visual effect:
  // small rocks read less aggressively shaded; large rocks read more
  // dramatically shaded — both end up with similar shading dynamic range.
  const HEIGHT_POW = 1.5;
  function heightFunction(rawH: number): number {
    if (rawH <= 0) return 0;
    return Math.pow(rawH, HEIGHT_POW);
  }

  // Color mix helpers
  type RGB = [number, number, number];
  function lerp3(a: RGB, b: RGB, t: number): RGB {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // Color palettes
  const ROCK_HI: RGB = [0x6a, 0x5e, 0x52]; // lit rock crest
  const ROCK_MD: RGB = [0x35, 0x2c, 0x24]; // mid rock body
  const ROCK_LO: RGB = [0x10, 0x09, 0x06]; // deep shadow
  const LAVA_DEEP: RGB = [0xa5, 0x2a, 0x08]; // deep magma red
  const LAVA_MID: RGB = [0xe8, 0x52, 0x1f]; // bright orange
  const LAVA_HOT: RGB = [0xfc, 0xb9, 0x6a]; // hot yellow core
  // Light direction (in UV-space normal map convention).
  // Sun coming from upper-left so rocks have visible shading.
  const LX = -0.55,
    LY = -0.55,
    LZ = 0.62;
  const lLength = Math.hypot(LX, LY, LZ);
  const lx = LX / lLength,
    ly = LY / lLength,
    lz = LZ / lLength;

  // Rock color: two-band low→mid→hi gradient by heightNorm.
  function rockColor(heightNorm: number): RGB {
    return heightNorm < 0.5
      ? lerp3(ROCK_LO, ROCK_MD, heightNorm * 2)
      : lerp3(ROCK_MD, ROCK_HI, (heightNorm - 0.5) * 2);
  }

  // Lava color: hot at channel center, cooling toward edges (lavaCool ≈
  // dEdge / thickness).
  function lavaColor(lavaCool: number): RGB {
    return lavaCool < 0.4
      ? lerp3(LAVA_HOT, LAVA_MID, lavaCool / 0.4)
      : lerp3(LAVA_MID, LAVA_DEEP, (lavaCool - 0.4) / 0.6);
  }

  // Pre-compute distFromEdge for every pixel.  We need it for normal-map
  // gradient computation (sample neighbors) and for the lava/rock mask.
  // The dEdge value is perturbed by craggyNoise() (high freq, ragged edges)
  // and wobbleNoise() (low freq, smooth wavy bumps) — both silhouette AND
  // shading inherit the raggedness.
  function precomputeFieldArray(): Float32Array {
    const aspect = H / W;
    const out = new Float32Array(W * H);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const u0 = (px + 0.5) / W;
        const v0 = ((py + 0.5) / H) * aspect;
        const [u, v] = flowUV(u0, v0);
        const f = voronoiField(u, v);
        const perturbation = craggyNoise(u0, v0) * cragginess + wobbleNoise(u0, v0) * wobble;
        out[py * W + px] = f.dEdge + perturbation;
      }
    }
    return out;
  }
  const fieldArray = precomputeFieldArray();

  // Shade one pixel: combine rock-on-lava with normal-mapped shading.
  function shadePixel(px: number, py: number): [number, number, number] {
    const dEdge = fieldArray[py * W + px];
    const mask = smoothstep(thickness, thickness + thicknessFalloff, dEdge);
    const heightHere = heightFunction(Math.max(0, dEdge - thickness));

    // Normal via finite-difference on the height field (clamp at edges).
    const xL = Math.max(0, px - 1),
      xR = Math.min(W - 1, px + 1);
    const yT = Math.max(0, py - 1),
      yB = Math.min(H - 1, py + 1);
    const hL = heightFunction(Math.max(0, fieldArray[py * W + xL] - thickness));
    const hR = heightFunction(Math.max(0, fieldArray[py * W + xR] - thickness));
    const hT = heightFunction(Math.max(0, fieldArray[yT * W + px] - thickness));
    const hB = heightFunction(Math.max(0, fieldArray[yB * W + px] - thickness));
    const dzdx = (hR - hL) * heightStrength * cellDensity * 0.5;
    const dzdy = (hB - hT) * heightStrength * cellDensity * 0.5;
    const nx = -dzdx,
      ny = -dzdy,
      nz = 1;
    const nLength = Math.hypot(nx, ny, nz);
    const lambert = Math.max(0, (nx * lx + ny * ly + nz * lz) / nLength);
    const shading = 0.3 + 0.85 * lambert;

    const heightNorm = Math.min(1, heightHere * heightStrength * cellDensity);
    const rockBase = rockColor(heightNorm);
    const lavaBase = lavaColor(Math.min(1, dEdge / Math.max(0.001, thickness)));

    return [
      lavaBase[0] + (rockBase[0] * shading - lavaBase[0]) * mask,
      lavaBase[1] + (rockBase[1] * shading - lavaBase[1]) * mask,
      lavaBase[2] + (rockBase[2] * shading - lavaBase[2]) * mask,
    ];
  }

  function paintCanvas(): void {
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const [r, g, b] = shadePixel(px, py);
        const index = (py * W + px) * 4;
        data[index] = Math.max(0, Math.min(255, Math.trunc(r)));
        data[index + 1] = Math.max(0, Math.min(255, Math.trunc(g)));
        data[index + 2] = Math.max(0, Math.min(255, Math.trunc(b)));
        data[index + 3] = 255;
      }
    }
  }
  paintCanvas();
  context.putImageData(img, 0, 0);

  embedCanvasAsImage(layers.shapes, canvas, x, y, w, h);
}

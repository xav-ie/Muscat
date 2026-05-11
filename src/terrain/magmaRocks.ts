import { layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { embedCanvasAsImage } from "../util/canvasLayer.js";

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
  const edgeSmooth = 0.0;
  const wobble = 0.06;

  // Render resolution — 4 px / mm, same as water
  const PX_PER_MM = 4;
  const W = Math.max(1, Math.round(w * PX_PER_MM));
  const H = Math.max(1, Math.round(h * PX_PER_MM));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const data = img.data;

  // Cell density expressed as cells per UV (UV is normalized 0..1 across W).
  // Use cells-per-mm * mm-per-W to land on a cells-per-UV value.
  const cellDensity = cellDensityMmInv * w;

  // randomVector — straight port of Quilez's HLSL.  Deterministic per cell
  // coordinate, so adjacent pixels in the same cell get the same control.
  const angleOffset = rng() * 1000; // global per-render randomness
  function randomVector(
    cellX: number,
    cellY: number,
    ang: number,
  ): [number, number] {
    // Same matrix multiply / sin / fract as the shader
    const m00 = 15.27,
      m01 = 47.63,
      m10 = 99.41,
      m11 = 89.98;
    let ux = cellX * m00 + cellY * m10;
    let uy = cellX * m01 + cellY * m11;
    ux = Math.sin(ux) * 46839.32;
    uy = Math.sin(uy) * 46839.32;
    ux = ux - Math.floor(ux);
    uy = uy - Math.floor(uy);
    const rx = Math.sin(uy * ang) * 0.5 + 0.5;
    const ry = Math.cos(ux * ang) * 0.5 + 0.5;
    return [rx, ry];
  }

  // distFromEdge field.  Returns { distFromCenter, distFromEdge }.
  function voronoiField(
    uvX: number,
    uvY: number,
  ): { dCenter: number; dEdge: number } {
    const sX = uvX * cellDensity,
      sY = uvY * cellDensity;
    const cellX = Math.floor(sX),
      cellY = Math.floor(sY);
    const posX = sX - cellX,
      posY = sY - cellY;

    // Phase 1: closest cell point
    let dCenter = 8.0;
    let coX = 0,
      coY = 0;
    for (let yy = -1; yy <= 1; yy++) {
      for (let xx = -1; xx <= 1; xx++) {
        const rv = randomVector(cellX + xx, cellY + yy, angleOffset);
        const cox = xx - posX + rv[0];
        const coy = yy - posY + rv[1];
        const d = cox * cox + coy * coy;
        if (d < dCenter) {
          dCenter = d;
          coX = cox;
          coY = coy;
        }
      }
    }
    dCenter = Math.sqrt(dCenter);

    // Phase 2: distance to nearest cell boundary, using smooth-min instead
    // of hard min.  With hard min, dEdge is the distance to the closest
    // straight bisector line — bisector intersections form sharp polygon
    // vertices where 3+ cells meet.  With smooth-min (log-sum-exp), the
    // distances to ALL bisectors blend together near vertices, rounding
    // those sharp polygon corners into smooth curves.  edgeSmooth=0
    // collapses to the original hard min (fully polygonal); higher values
    // give increasingly rounded organic cell shapes.
    let dEdge: number;
    if (edgeSmooth <= 0) {
      // Hard min — original Quilez behavior
      dEdge = 8.0;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          const rv = randomVector(cellX + xx, cellY + yy, angleOffset);
          const cox = xx - posX + rv[0];
          const coy = yy - posY + rv[1];
          const dx = cox - coX,
            dy = coy - coY;
          const dlen = Math.hypot(dx, dy);
          if (dlen < 1e-6) continue;
          const nx = dx / dlen,
            ny = dy / dlen;
          const midX = 0.5 * (coX + cox);
          const midY = 0.5 * (coY + coy);
          const dToEdge = midX * nx + midY * ny;
          if (dToEdge < dEdge) dEdge = dToEdge;
        }
      }
    } else {
      // Soft min via log-sum-exp.  d_smooth = -k * log(Σ exp(-d / k))
      // — small k → close to hard min; bigger k → more rounding.
      const k = edgeSmooth;
      let sumExp = 0;
      for (let yy = -1; yy <= 1; yy++) {
        for (let xx = -1; xx <= 1; xx++) {
          const rv = randomVector(cellX + xx, cellY + yy, angleOffset);
          const cox = xx - posX + rv[0];
          const coy = yy - posY + rv[1];
          const dx = cox - coX,
            dy = coy - coY;
          const dlen = Math.hypot(dx, dy);
          if (dlen < 1e-6) continue;
          const nx = dx / dlen,
            ny = dy / dlen;
          const midX = 0.5 * (coX + cox);
          const midY = 0.5 * (coY + coy);
          const dToEdge = midX * nx + midY * ny;
          sumExp += Math.exp(-dToEdge / k);
        }
      }
      // Guard: if no valid neighbors contributed (all were the closest
      // cell — only happens at degenerate spots), fall back to the
      // closest-bisector hard-min equivalent.
      if (sumExp <= 0) {
        dEdge = 8.0;
      } else {
        dEdge = -k * Math.log(sumExp);
      }
    }
    return { dCenter, dEdge };
  }

  // Flow / wiggle.  Higher-frequency UV octaves: lava channels acquire
  // small wiggles.  Read from G.lavaFlow.
  const ph1x = rng() * Math.PI * 2;
  const ph1y = rng() * Math.PI * 2;
  const ph2x = rng() * Math.PI * 2;
  const ph2y = rng() * Math.PI * 2;
  function flowUV(uvX: number, uvY: number): [number, number] {
    const A1 = flowStrength;
    const A2 = A1 * 0.33;
    const wx =
      Math.sin(uvX * 8.0 + uvY * 6.0 + ph1x) * A1 +
      Math.sin(uvX * 21.0 - uvY * 11.0 + ph2x) * A2;
    const wy =
      Math.sin(uvY * 8.0 + uvX * 6.0 + ph1y) * A1 +
      Math.sin(uvY * 21.0 - uvX * 11.0 + ph2y) * A2;
    return [uvX + wx, uvY + wy];
  }

  // Edge cragginess.  Unlike flow (which moves the cell field around),
  // cragginess perturbs the dEdge VALUE directly with a high-frequency
  // multi-octave noise.  Each edge crosses the threshold at a slightly
  // different position depending on the local noise value, so cell edges
  // become ragged & jagged rather than uniformly wobbly.
  // Phases randomized per render so the cragginess pattern doesn't repeat.
  const eph: number[] = [];
  for (let i = 0; i < 8; i++) eph.push(rng() * Math.PI * 2);
  function craggyNoise(uvX: number, uvY: number): number {
    // 3 octaves of sin-product noise.  Each octave doubles the frequency
    // and halves the contribution.  Range roughly [-1, 1].
    const f1 = 14.0;
    const n1 =
      Math.sin(uvX * f1 + eph[0]) * Math.cos(uvY * f1 + eph[1]) * 1.0 +
      Math.sin(uvX * f1 * 2.1 + eph[2]) *
        Math.cos(uvY * f1 * 2.1 + eph[3]) *
        0.5 +
      Math.sin(uvX * f1 * 4.3 + eph[4]) *
        Math.cos(uvY * f1 * 4.3 + eph[5]) *
        0.25;
    return n1 * (1.0 / 1.75); // normalize so peak ~ ±1
  }

  // Wobble — the same perturb-dEdge-directly trick as cragginess, but at
  // MEDIUM frequency.  CRITICAL: noise wavelength must be SHORTER than a
  // cell edge length, otherwise the whole edge shifts uniformly along the
  // noise gradient (looks tilted, not wobbly).  Each cell edge is ~1 cell
  // long.  Frequency cellDensity * 6.0 → wavelength ~cell/6, so each edge
  // sees ~6 oscillations along its length → visible wavy bumps.
  // Two octaves at this scale and 2x for organic non-uniform waves.
  const wph: number[] = [];
  for (let i = 0; i < 8; i++) wph.push(rng() * Math.PI * 2);
  const wf = cellDensity * 6.0;
  function wobbleNoise(uvX: number, uvY: number): number {
    const n =
      Math.sin(uvX * wf + wph[0]) * Math.cos(uvY * wf + wph[1]) * 1.0 +
      Math.sin(uvX * wf * 2.0 + wph[2]) *
        Math.cos(uvY * wf * 2.0 + wph[3]) *
        0.5;
    return n * (1.0 / 1.5);
  }

  // Smoothstep helper
  function smoothstep(a: number, b: number, t: number): number {
    let x = (t - a) / (b - a);
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    return x * x * (3 - 2 * x);
  }

  // Height compression: raise raw height to a power > 1.  This makes the
  // height field grow MORE STEEPLY with size, so large rocks get gradients
  // proportional to their size rather than getting drowned out by the
  // disproportionately steep gradients of small rocks.  The visual effect:
  // small rocks read less aggressively shaded; large rocks read more
  // dramatically shaded — both end up with similar shading dynamic range.
  const HEIGHT_POW = 1.5;
  function heightFn(rawH: number): number {
    if (rawH <= 0) return 0;
    return Math.pow(rawH, HEIGHT_POW);
  }

  // Color mix helpers
  type RGB = [number, number, number];
  function lerp3(a: RGB, b: RGB, t: number): RGB {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
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
  const lLen = Math.hypot(LX, LY, LZ);
  const lx = LX / lLen,
    ly = LY / lLen,
    lz = LZ / lLen;

  // Pre-compute distFromEdge for every pixel.  We need it for normal-map
  // gradient computation (sample neighbors) and for the lava/rock mask.
  // The dEdge value is perturbed by craggyNoise(), which makes individual
  // cell edges ragged rather than smoothly curved — both the silhouette
  // (where mask transitions) AND the heightmap shading get the raggedness.
  const aspect = H / W;
  const fieldArr = new Float32Array(W * H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const u0 = (px + 0.5) / W;
      const v0 = ((py + 0.5) / H) * aspect;
      const [u, v] = flowUV(u0, v0);
      const f = voronoiField(u, v);
      // Perturb dEdge directly with two noises:
      //   * craggyNoise (high freq) → ragged jagged edge details
      //   * wobbleNoise (low freq, cellDensity-scale) → smooth wavy lines
      //     along edges (matches the desert's wobbly look)
      const perturbation =
        craggyNoise(u0, v0) * cragginess + wobbleNoise(u0, v0) * wobble;
      fieldArr[py * W + px] = f.dEdge + perturbation;
    }
  }

  // Render with normal-map shading
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dEdge = fieldArr[py * W + px];

      // Mask: 0 inside lava (dEdge near 0), 1 inside rock (dEdge > thickness).
      // Smoothstep over [thickness, thickness + falloff].
      const mask = smoothstep(thickness, thickness + thicknessFalloff, dEdge);

      // Heightmap: power-compressed (dEdge - thickness).  Rocks rise up,
      // lava sits flat, but small rocks don't dominate the shading.
      const heightHere = heightFn(Math.max(0, dEdge - thickness));

      // Compute normal via finite-difference on the height field.
      // dh/dx and dh/dy from neighbor heights (clamp at edges).
      const xL = Math.max(0, px - 1),
        xR = Math.min(W - 1, px + 1);
      const yT = Math.max(0, py - 1),
        yB = Math.min(H - 1, py + 1);
      const hL = heightFn(Math.max(0, fieldArr[py * W + xL] - thickness));
      const hR = heightFn(Math.max(0, fieldArr[py * W + xR] - thickness));
      const hT = heightFn(Math.max(0, fieldArr[yT * W + px] - thickness));
      const hB = heightFn(Math.max(0, fieldArr[yB * W + px] - thickness));
      // dz/dx ≈ (hR - hL) * heightStrength * cellDensity
      // (cellDensity scales the field gradient back into UV-screen space)
      const dzdx = (hR - hL) * heightStrength * cellDensity * 0.5;
      const dzdy = (hB - hT) * heightStrength * cellDensity * 0.5;
      // Normal = normalize((-dzdx, -dzdy, 1))
      const nx = -dzdx,
        ny = -dzdy,
        nz = 1;
      const nLen = Math.hypot(nx, ny, nz);
      const nxN = nx / nLen,
        nyN = ny / nLen,
        nzN = nz / nLen;
      // Lambertian
      let lambert = nxN * lx + nyN * ly + nzN * lz;
      if (lambert < 0) lambert = 0;
      // Ambient + diffuse
      const shading = 0.3 + 0.85 * lambert;

      // Rock color: dark at edge of cell (mask=0 fringes have shadow), bright
      // at peak.  Use heightHere normalized as a height factor.
      const heightNorm = Math.min(1, heightHere * heightStrength * cellDensity);
      // Two-band gradient: low → mid → hi by heightNorm.
      let rockBase: RGB;
      if (heightNorm < 0.5) {
        rockBase = lerp3(ROCK_LO, ROCK_MD, heightNorm * 2);
      } else {
        rockBase = lerp3(ROCK_MD, ROCK_HI, (heightNorm - 0.5) * 2);
      }
      // Apply shading
      const rockR = rockBase[0] * shading;
      const rockG = rockBase[1] * shading;
      const rockB = rockBase[2] * shading;

      // Lava color: hot at the center of channels (where dEdge is closest to
      // 0), cooling toward edges.  Use dEdge / thickness as cooling factor.
      const lavaCool = Math.min(1, dEdge / Math.max(0.001, thickness));
      let lavaBase: RGB;
      if (lavaCool < 0.4) {
        lavaBase = lerp3(LAVA_HOT, LAVA_MID, lavaCool / 0.4);
      } else {
        lavaBase = lerp3(LAVA_MID, LAVA_DEEP, (lavaCool - 0.4) / 0.6);
      }

      // Mix rock over lava using mask
      const r = lavaBase[0] + (rockR - lavaBase[0]) * mask;
      const g = lavaBase[1] + (rockG - lavaBase[1]) * mask;
      const b = lavaBase[2] + (rockB - lavaBase[2]) * mask;

      const idx = (py * W + px) * 4;
      data[idx] = Math.max(0, Math.min(255, r | 0));
      data[idx + 1] = Math.max(0, Math.min(255, g | 0));
      data[idx + 2] = Math.max(0, Math.min(255, b | 0));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  embedCanvasAsImage(layers.shapes!, canvas, x, y, w, h);
}

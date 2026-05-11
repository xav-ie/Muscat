import { SVG_NS, LINE_W, layers } from "../state.js";
import { random as rng } from "../util/rng.js";
import { jitterColor, mixColors } from "../util/color.js";
import { svgPath, svgRect } from "../svg/primitives.js";

type Point = [number, number];
interface Hill {
  pts: Point[];
  d: string;
  color: string;
}
interface FlowerHue {
  petal: string;
  center: string;
}
type CrestFn = (px: number) => number;

// One flower: a small dot with a few petals around it.  Rendered as a single
// filled circle (the bloom) with `petals` smaller circles around it.
export function flower(cx: number, cy: number, color: string): void {
  const petalR = 0.55;
  const ringR = 1.1;
  // 5 petal circles around a center
  for (let i = 0; i < 5; i++) {
    const a = i * ((Math.PI * 2) / 5);
    const px = cx + Math.cos(a) * ringR;
    const py = cy + Math.sin(a) * ringR;
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(px));
    c.setAttribute("cy", String(py));
    c.setAttribute("r", String(petalR));
    c.setAttribute("fill", color);
    layers.shapes!.append(c);
  }
  // Yellow center dot
  const center = document.createElementNS(SVG_NS, "circle");
  center.setAttribute("cx", String(cx));
  center.setAttribute("cy", String(cy));
  center.setAttribute("r", String(petalR * 0.85));
  center.setAttribute("fill", "#f4d65a");
  layers.shapes!.append(center);
}

// Composite grass scene: a few mounds with tufts cresting them, scattered
// flowers, and individual blades around.
export function grassScene(x: number, y: number, w: number, h: number): void {
  // Palette: hills go DARK in the back to LIGHT in the front.
  // Hill fill colors are now close to their blade colors so where
  // blades don't fully cover, the underlying ground harmonizes
  // instead of glowing through as a brighter green.
  const HILL_BACK = "#2e6118"; // darkest — closer to BLADE_BACK
  const HILL_MID = "#477f1f"; // mid — closer to BLADE_MID
  const HILL_FRONT = "#629f28"; // lightest — closer to BLADE_FRONT
  const BLADE_BACK = "#244e14";
  const BLADE_MID = "#356117";
  const BLADE_FRONT = "#4c7a1c";
  // Very dark backdrop behind all hills — the absolute back of the
  // scene, covered by leaves to suggest a deep forest beyond.
  const BACKDROP = "#143008";

  const flowerHues: FlowerHue[] = [
    { petal: "#e94f8a", center: "#f4d65a" }, // pink / yellow
    { petal: "#f0f0f0", center: "#f4d65a" }, // white daisy
    { petal: "#f4d65a", center: "#c08a1a" }, // yellow
    { petal: "#b075d6", center: "#f4d65a" }, // purple
    { petal: "#ee8c45", center: "#7a2e0c" }, // orange
  ];

  // Build a hill's filled polygon AND return its sampled crest points.
  // Doesn't append to shapesLayer yet — caller decides when to draw.
  function buildHill(
    crestFrac: number,
    ampFrac: number,
    phase: number,
    freqA: number,
    freqB: number,
    color: string,
  ): Hill {
    const samples = 80;
    const crestY = y + h * crestFrac;
    const amp = h * ampFrac;
    const pts: Point[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const px = x + t * w;
      const noise =
        Math.sin(t * Math.PI * freqA + phase) * 0.65 +
        Math.sin(t * Math.PI * freqB + phase * 1.7) * 0.35;
      const py = crestY - amp * noise;
      pts.push([px, py]);
    }
    let d = `M ${x} ${y + h} L ${pts[0][0]} ${pts[0][1]} `;
    for (let i = 1; i < pts.length; i++) d += `L ${pts[i][0]} ${pts[i][1]} `;
    d += `L ${x + w} ${y + h} Z`;
    return { pts, d, color };
  }

  function drawHill(hill: Hill): void {
    layers.shapes!.append(svgPath(hill.d, { fill: hill.color }));
  }

  // Sample y at any x along a hill's polyline.
  function crestYAt(crest: Point[], px: number): number {
    let lo = 0,
      hi = crest.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (crest[mid][0] <= px) lo = mid;
      else hi = mid;
    }
    const span = Math.max(1e-6, crest[hi][0] - crest[lo][0]);
    const t = (px - crest[lo][0]) / span;
    return crest[lo][1] + (crest[hi][1] - crest[lo][1]) * t;
  }

  // Return a function that takes x and returns y on this crest.
  // Useful when the "top" of a band is just the banner top (a constant
  // y), so we don't need a hill polygon to provide the lookup.
  function crestYFn(crest: Point[]): CrestFn {
    return (px: number) => crestYAt(crest, px);
  }

  // Plant tufts across a hill's visible band.  Top edge is this hill's
  // crest; bottom edge is either the next hill's crest or the banner
  // bottom.  Each BLADE picks a random color along the spectrum from
  // `darkColor` (typical blade tone) toward `lightColor` (the hill
  // base color) for tonal striation — most blades stay dark, some
  // catch "light" reading as the underlying hill showing through or
  // a sun-hit blade.
  //
  // X-range extends PAST the banner edges so the clipPath cuts the
  // blades cleanly instead of revealing a visible "base line" at the
  // banner border.
  function plantTufts(
    thisCrest: Point[],
    nextCrest: Point[] | null,
    count: number,
    darkColor: string,
    lightColor: string,
    minScale: number,
    maxScale: number,
  ): void {
    const edgeBleed = 4;
    const xMin = x - edgeBleed,
      xMax = x + w + edgeBleed;
    // Step 1: generate ALL tuft positions first, collecting (bx, by, scale)
    const tufts: { bx: number; by: number; scale: number }[] = [];
    for (let i = 0; i < count; i++) {
      const bx = xMin + rng() * (xMax - xMin);
      const xClamp = Math.max(x, Math.min(x + w, bx));
      const topY = crestYAt(thisCrest, xClamp);
      const botY = nextCrest ? crestYAt(nextCrest, xClamp) : y + h + edgeBleed;
      if (botY <= topY) continue;
      const by = topY + rng() * (botY - topY);
      const scale = minScale + rng() * (maxScale - minScale);
      tufts.push({ bx, by, scale });
    }
    // Step 2: sort by y ASCENDING so tufts higher on the hill (smaller y)
    // are drawn FIRST and tufts closer to the viewer (larger y) layer
    // on top — back-to-front within the hill.
    tufts.sort((a, b) => a.by - b.by);
    // Step 3: draw in sorted order
    for (const t of tufts) {
      grassTuftOnGround(t.bx, t.by, darkColor, lightColor, t.scale);
    }
  }

  // Build the three grass hills (no separate leaf-canopy hill — the
  // leaves now sit on a flat backdrop rectangle at the absolute back).
  const backHill = buildHill(0.4, 0.18, 0.6, 1.2, 3.1, HILL_BACK);
  const midHill = buildHill(0.55, 0.22, 2.1, 1.6, 4.3, HILL_MID);
  const frontHill = buildHill(0.72, 0.2, 0, 1.8, 5.7, HILL_FRONT);

  // ── DRAW BACK-TO-FRONT, INTERLEAVED ──────────────────────────────
  //
  // Layer 0 (VERY BACK): flat dark-green rectangle filling the entire
  // banner, then dense dark leaves on top of it.  The rectangle covers
  // edge-to-edge so no banner fill shows above the leaves.
  layers.shapes!.append(svgRect(x, y, w, h, BACKDROP));
  plantLeavesInBand(y, crestYFn(backHill.pts), "#1f3e10", "#2e5818", 6500);

  // Layer 1: back hill with DENSE grass blades.  Each blade randomly
  // mixes between BLADE_BACK and HILL_BACK for visible tonal striation
  // — some blades darker (shadowed), some lighter (sun-hit).
  drawHill(backHill);
  plantTufts(backHill.pts, midHill.pts, 3000, BLADE_BACK, HILL_BACK, 0.4, 0.6);

  // Layer 2: mid hill — DENSE grass with mid striation.
  drawHill(midHill);
  plantTufts(midHill.pts, frontHill.pts, 3800, BLADE_MID, HILL_MID, 0.6, 0.85);

  // Layer 3: front hill — DENSE grass with front striation.
  drawHill(frontHill);
  plantTufts(frontHill.pts, null, 8000, BLADE_FRONT, HILL_FRONT, 0.85, 1.2);

  // ── Flowers on the front hill (drawn last, on top of all foliage) ──
  const flowerCount = 11;
  const margin = 2;
  for (let i = 0; i < flowerCount; i++) {
    const t = (i + rng()) / flowerCount;
    const sampleIdx = Math.min(
      frontHill.pts.length - 1,
      Math.max(0, Math.floor(t * frontHill.pts.length)),
    );
    const [gx, gy] = frontHill.pts[sampleIdx];
    if (gx < x + margin + 3 || gx > x + w - margin - 3) continue;
    const stemH = 2.5 + rng() * 2;
    const headX = gx + (rng() - 0.5) * 0.6;
    const headY = gy - stemH;
    const hue = flowerHues[Math.floor(rng() * flowerHues.length)];
    drawFlower(gx, gy, headX, headY, hue);
  }

  // Plant a dense layer of overlapping leaves across a hill's visible
  // band.  Each leaf is a small rotated ellipse with slight color
  // jitter.  Mixes two base shades (darker + slightly-less-dark) so the
  // canopy reads as varied foliage with internal depth.
  // Plant leaves filling the band between topYFn(x) and botYFn(x).
  // Either argument can be a number (constant y) or a function (x → y).
  function plantLeavesInBand(
    topYArg: number | CrestFn,
    botYArg: number | CrestFn,
    darkColor: string,
    lightColor: string,
    leafCount: number,
  ): void {
    const edgeBleed = 4;
    const xMin = x - edgeBleed,
      xMax = x + w + edgeBleed;
    const topYFn: CrestFn =
      typeof topYArg === "function" ? topYArg : () => topYArg;
    const botYFn: CrestFn =
      typeof botYArg === "function" ? botYArg : () => botYArg;
    for (let i = 0; i < leafCount; i++) {
      const lx = xMin + rng() * (xMax - xMin);
      const xClamp = Math.max(x, Math.min(x + w, lx));
      const topY = topYFn(xClamp);
      const botY = botYFn(xClamp);
      if (botY <= topY) continue;
      const ly = topY + rng() * (botY - topY);
      const depthT = (ly - topY) / Math.max(0.001, botY - topY);
      const sizeScale = 0.6 + depthT * 0.6 + rng() * 0.4;
      const rx = 0.85 * sizeScale * (0.9 + rng() * 0.2);
      const ry = 0.4 * sizeScale * (0.9 + rng() * 0.2);
      const angle = rng() * 360;
      const base = rng() < 0.7 ? darkColor : lightColor;
      const color = jitterColor(base, 1.2);

      const el = document.createElementNS(SVG_NS, "ellipse");
      el.setAttribute("cx", String(lx));
      el.setAttribute("cy", String(ly));
      el.setAttribute("rx", String(rx));
      el.setAttribute("ry", String(ry));
      el.setAttribute("transform", `rotate(${angle} ${lx} ${ly})`);
      el.setAttribute("fill", color);
      layers.shapes!.append(el);
    }
  }
}

// Draw a single grass tuft of blades emerging from a ground point.
// Each blade picks a random color along the spectrum from `darkColor`
// (most common — typical blade tone) to `lightColor` (the hill's base
// color, less common — reads as sun-hit highlight or underlying ground
// peeking through).  Plus a tiny per-blade jitter on top.
export function grassTuftOnGround(
  gx: number,
  gy: number,
  darkColor: string,
  lightColor: string,
  scale = 1,
): void {
  const n = 3 + Math.floor(rng() * 3); // 3-5 blades
  const baseSpread = 1.4 * scale;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) / Math.max(1, n - 1);
    const bx = gx + t * baseSpread;
    const by = gy + 0.3 * scale;
    const heightBase = (3 + rng() * 2) * scale;
    const heightCurve = 1 - Math.abs(t) * 0.3;
    const height = heightBase * heightCurve;
    const leanAmount = t * (0.9 + rng() * 0.7) + (rng() - 0.5) * 0.4;
    const tipX = bx + leanAmount * scale;
    const tipY = by - height;
    const halfBase = 0.28 * scale;
    const ctrl1X = bx - halfBase + (tipX - (bx - halfBase)) * 0.4;
    const ctrl1Y = by + (tipY - by) * 0.5;
    const ctrl2X = bx + halfBase + (tipX - (bx + halfBase)) * 0.4;
    const ctrl2Y = by + (tipY - by) * 0.5;
    const d =
      `M ${bx - halfBase} ${by} ` +
      `Q ${ctrl1X} ${ctrl1Y} ${tipX} ${tipY} ` +
      `Q ${ctrl2X} ${ctrl2Y} ${bx + halfBase} ${by} ` +
      `Z`;
    // Tonal striation: mix between darkColor and lightColor with a
    // power-distributed t (skewed toward dark — most blades are
    // shadowed, some are sun-hit), then add small jitter.
    const mixT = Math.pow(rng(), 1.6); // skew toward 0 (dark)
    const baseColor = mixColors(darkColor, lightColor, mixT);
    layers.shapes!.append(svgPath(d, { fill: jitterColor(baseColor, 0.6) }));
  }
}

// Draw a flower: stem from (gx,gy) to (headX,headY), then a multi-petal
// bloom at the head.  Petals are short ellipses arranged in a ring with
// a center disc.
export function drawFlower(
  gx: number,
  gy: number,
  headX: number,
  headY: number,
  hue: FlowerHue,
): void {
  // 1. Stem — single quadratic curve so it leans slightly
  const stemCtrlX = (gx + headX) / 2 + (rng() - 0.5) * 0.5;
  const stemCtrlY = (gy + headY) / 2;
  const stemD = `M ${gx} ${gy} Q ${stemCtrlX} ${stemCtrlY} ${headX} ${headY}`;
  layers.shapes!.append(
    svgPath(stemD, {
      fill: "none",
      stroke: "#2a5e1a",
      strokeWidth: LINE_W * 0.7,
    }),
  );
  // 2. Petals — 6 oval petals around center
  const nPetals = 6;
  const petalRx = 0.55;
  const petalRy = 1.05;
  const ringR = 0.85;
  for (let i = 0; i < nPetals; i++) {
    const a = i * ((Math.PI * 2) / nPetals);
    const px = headX + Math.cos(a) * ringR;
    const py = headY + Math.sin(a) * ringR;
    const ellipse = document.createElementNS(SVG_NS, "ellipse");
    ellipse.setAttribute("cx", String(px));
    ellipse.setAttribute("cy", String(py));
    ellipse.setAttribute("rx", String(petalRx));
    ellipse.setAttribute("ry", String(petalRy));
    // Rotate the petal so its long axis points outward from the center
    const deg = (a * 180) / Math.PI + 90;
    ellipse.setAttribute("transform", `rotate(${deg} ${px} ${py})`);
    ellipse.setAttribute("fill", hue.petal);
    layers.shapes!.append(ellipse);
  }
  // 3. Center disc
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", String(headX));
  c.setAttribute("cy", String(headY));
  c.setAttribute("r", String(0.75));
  c.setAttribute("fill", hue.center);
  layers.shapes!.append(c);
}

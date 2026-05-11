import { SVG_NS, board, G, layers } from "../state.js";
import { KRANKY_B64 } from "../constants.js";

export function clear(): void {
  while (board.firstChild) board.firstChild.remove();
}

export function setupLayers(): void {
  // <defs> with the grain filter
  const defs = document.createElementNS(SVG_NS, "defs");
  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", "grain");
  // Buffer the filter region a bit so displaced edges don't get clipped
  filter.setAttribute("x", "-2%");
  filter.setAttribute("y", "-2%");
  filter.setAttribute("width", "104%");
  filter.setAttribute("height", "104%");

  // Fractal noise — feeds the displacement map.  baseFrequency is in cycles
  // per viewBox unit; our viewBox is in mm, so freq=1.0 ≈ 1mm wavelength.
  const turb = document.createElementNS(SVG_NS, "feTurbulence");
  turb.setAttribute("id", "grain-turb");
  turb.setAttribute("type", "fractalNoise");
  turb.setAttribute("baseFrequency", String(G.grainFreq));
  turb.setAttribute("numOctaves", "2");
  turb.setAttribute("seed", String(G.seed));
  turb.setAttribute("result", "noise");
  filter.append(turb);

  // Displace SourceGraphic by the noise.  scale is in viewBox units (mm).
  const disp = document.createElementNS(SVG_NS, "feDisplacementMap");
  disp.setAttribute("id", "grain-disp");
  disp.setAttribute("in", "SourceGraphic");
  disp.setAttribute("in2", "noise");
  disp.setAttribute("scale", String(G.grainScale));
  filter.append(disp);

  defs.append(filter);

  // Wood pattern for the castle door — vertical planks running floor-to-ceiling,
  // with HORIZONTAL joints between plank-ends staggered between adjacent planks.
  // Each plank is 6mm wide; joints fall every ~24mm vertically, with even-index
  // planks offset by 12mm from odd-index planks so seams don't line up across.
  const PLANK_W = 6;
  const TILE_W = PLANK_W * 2; // tile spans two planks
  const TILE_H = 24; // joint spacing
  const wood = document.createElementNS(SVG_NS, "pattern");
  wood.setAttribute("id", "wood");
  wood.setAttribute("patternUnits", "userSpaceOnUse");
  wood.setAttribute("width", String(TILE_W));
  wood.setAttribute("height", String(TILE_H));
  // Background plank color (covers full tile)
  const woodBg = document.createElementNS(SVG_NS, "rect");
  woodBg.setAttribute("width", String(TILE_W));
  woodBg.setAttribute("height", String(TILE_H));
  woodBg.setAttribute("fill", "#8b6f47");
  wood.append(woodBg);
  // NOTE: All plank dividers (vertical AND horizontal joints) used to live
  // here, but they suffered displacement-filter artifacts inside <pattern>
  // that made them look thinner than continuous explicit strokes.  Both are
  // now drawn explicitly per-door, outside the pattern.
  defs.append(wood);

  // Soft-blur filter — used on box-gradient overlays to smooth the corner
  // cross-hatch that arises when two semi-transparent linear gradients
  // intersect.
  const soft = document.createElementNS(SVG_NS, "filter");
  soft.setAttribute("id", "soften");
  soft.setAttribute("x", "-10%");
  soft.setAttribute("y", "-10%");
  soft.setAttribute("width", "120%");
  soft.setAttribute("height", "120%");
  const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("stdDeviation", "0.6");
  soft.append(blur);
  defs.append(soft);

  // Magma glow — used on the bright cracks between Voronoi rocks in the
  // lava banner.  A blurred copy of the source is composited under the
  // sharp original to give a halo of light around each line.
  const glow = document.createElementNS(SVG_NS, "filter");
  glow.setAttribute("id", "magma-glow");
  glow.setAttribute("x", "-20%");
  glow.setAttribute("y", "-20%");
  glow.setAttribute("width", "140%");
  glow.setAttribute("height", "140%");
  // Blur the source to create the halo
  const gblur = document.createElementNS(SVG_NS, "feGaussianBlur");
  gblur.setAttribute("in", "SourceGraphic");
  gblur.setAttribute("stdDeviation", "1.4");
  gblur.setAttribute("result", "blurred");
  glow.append(gblur);
  // Composite original sharp graphic on top of the blur
  const merge = document.createElementNS(SVG_NS, "feMerge");
  for (const reference of ["blurred", "blurred", "SourceGraphic"]) {
    const node = document.createElementNS(SVG_NS, "feMergeNode");
    node.setAttribute("in", reference);
    merge.append(node);
  }
  glow.append(merge);
  defs.append(glow);

  // Parchment paper filter — subtly textured paper background using
  // turbulence + diffuse lighting.  Applied to a colored rect spanning
  // the full board to give the paper a hand-aged feel: soft mottling,
  // tiny fiber bumps, slight darkening at edges.  All rendered at low
  // contrast so it sits behind everything without competing.
  const parch = document.createElementNS(SVG_NS, "filter");
  parch.setAttribute("id", "parchment");
  parch.setAttribute("x", "0%");
  parch.setAttribute("y", "0%");
  parch.setAttribute("width", "100%");
  parch.setAttribute("height", "100%");
  // 1. Mottling — low-frequency turbulence for big aged blotches.
  const pBig = document.createElementNS(SVG_NS, "feTurbulence");
  pBig.setAttribute("type", "fractalNoise");
  pBig.setAttribute("baseFrequency", "0.02"); // big slow blotches
  pBig.setAttribute("numOctaves", "3");
  pBig.setAttribute("seed", "7");
  pBig.setAttribute("result", "bigNoise");
  parch.append(pBig);
  // 2. Color it: take the source color and modulate it down a tiny bit
  //    where the noise is high (creates soft brown patches).
  const ctBig = document.createElementNS(SVG_NS, "feColorMatrix");
  ctBig.setAttribute("in", "bigNoise");
  ctBig.setAttribute("type", "matrix");
  // Increase contrast then map alpha so dark spots = stained patches
  ctBig.setAttribute(
    "values",
    "0 0 0 0 0.78 " + // R → constant 0.78 (brownish)
      "0 0 0 0 0.62 " + // G → 0.62
      "0 0 0 0 0.40 " + // B → 0.40
      "0 0 0 0.18 0",
  ); // A → 18% of source-alpha noise
  ctBig.setAttribute("result", "stains");
  parch.append(ctBig);
  // 3. Fine fiber noise — high frequency for paper texture.
  const pFine = document.createElementNS(SVG_NS, "feTurbulence");
  pFine.setAttribute("type", "fractalNoise");
  pFine.setAttribute("baseFrequency", "0.85"); // fiber density
  pFine.setAttribute("numOctaves", "2");
  pFine.setAttribute("seed", "13");
  pFine.setAttribute("result", "fineNoise");
  parch.append(pFine);
  // 4. Lighting: feDiffuseLighting with the fineNoise as the bump map
  //    gives the paper a tactile fiber texture.
  const lit = document.createElementNS(SVG_NS, "feDiffuseLighting");
  lit.setAttribute("in", "fineNoise");
  lit.setAttribute("lighting-color", "#fffbe6");
  lit.setAttribute("surfaceScale", "1.2");
  lit.setAttribute("diffuseConstant", "0.95");
  lit.setAttribute("result", "litFibers");
  const dl = document.createElementNS(SVG_NS, "feDistantLight");
  dl.setAttribute("azimuth", "45");
  dl.setAttribute("elevation", "60");
  lit.append(dl);
  parch.append(lit);
  // 5. Composite the lit fibers in over the source graphic (the paper
  //    color rect).  Use 'arithmetic' to multiply gently so fibers
  //    show as soft modulation, not opaque overlay.
  const compFiber = document.createElementNS(SVG_NS, "feComposite");
  compFiber.setAttribute("in", "litFibers");
  compFiber.setAttribute("in2", "SourceGraphic");
  compFiber.setAttribute("operator", "arithmetic");
  // result = k1*in*in2 + k2*in + k3*in2 + k4
  compFiber.setAttribute("k1", "0.45"); // multiplied combination
  compFiber.setAttribute("k2", "0");
  compFiber.setAttribute("k3", "0.65"); // mostly the paper
  compFiber.setAttribute("k4", "0");
  compFiber.setAttribute("result", "fibered");
  parch.append(compFiber);
  // 6. Composite the brown stains over the fibered paper.
  const compStains = document.createElementNS(SVG_NS, "feComposite");
  compStains.setAttribute("in", "stains");
  compStains.setAttribute("in2", "fibered");
  compStains.setAttribute("operator", "over");
  parch.append(compStains);
  defs.append(parch);

  // Printed-on-paper filter — applied to the colored icon squares (and
  // any other shapes that should feel printed onto the parchment rather
  // than floating above it).  Two effects:
  //   1. Multiply a subtle high-frequency turbulence over the source so
  //      paper fiber texture appears DARKENED into the color.
  //   2. Inset shadow at the edges via a blurred + compositionally
  //      subtracted offset of the source alpha — gives the shape a
  //      slightly pressed-into-paper appearance instead of floating.
  const ink = document.createElementNS(SVG_NS, "filter");
  ink.setAttribute("id", "printed-on-paper");
  // Filter region must extend slightly outside the source so blurs don't clip
  ink.setAttribute("x", "-5%");
  ink.setAttribute("y", "-5%");
  ink.setAttribute("width", "110%");
  ink.setAttribute("height", "110%");

  // 1a. Fine paper fiber turbulence
  const inkFiber = document.createElementNS(SVG_NS, "feTurbulence");
  inkFiber.setAttribute("type", "fractalNoise");
  inkFiber.setAttribute("baseFrequency", "0.70");
  inkFiber.setAttribute("numOctaves", "2");
  inkFiber.setAttribute("seed", "23");
  inkFiber.setAttribute("result", "inkNoise");
  ink.append(inkFiber);

  // 1b. Map the noise into a darkening alpha (only dark fiber spots show)
  const inkColor = document.createElementNS(SVG_NS, "feColorMatrix");
  inkColor.setAttribute("in", "inkNoise");
  inkColor.setAttribute("type", "matrix");
  // Turbulence outputs grayscale-ish RGB.  Map all channels to 0 (black)
  // and use the source noise as alpha at 40% opacity.
  inkColor.setAttribute(
    "values",
    "0 0 0 0 0 " + "0 0 0 0 0 " + "0 0 0 0 0 " + "0 0 0 0.40 0",
  );
  inkColor.setAttribute("result", "inkDarkSpots");
  ink.append(inkColor);

  // 1c. Mask the dark spots to the source shape only (composite operator='in')
  const inkMask = document.createElementNS(SVG_NS, "feComposite");
  inkMask.setAttribute("in", "inkDarkSpots");
  inkMask.setAttribute("in2", "SourceGraphic");
  inkMask.setAttribute("operator", "in");
  inkMask.setAttribute("result", "inkMasked");
  ink.append(inkMask);

  // 1d. Composite the masked dark spots OVER the source — this is the
  //     multiply-like effect: the source color stays mostly intact, with
  //     subtle darkening where fibers happen to be.
  const inkOver = document.createElementNS(SVG_NS, "feComposite");
  inkOver.setAttribute("in", "inkMasked");
  inkOver.setAttribute("in2", "SourceGraphic");
  inkOver.setAttribute("operator", "over");
  inkOver.setAttribute("result", "fibered");
  ink.append(inkOver);

  // 2. Inset edge shadow — gives the shape a pressed-into-paper feel.
  //    Blur the source alpha, invert/offset it, mask to source area, then
  //    composite over.
  const insetBlur = document.createElementNS(SVG_NS, "feGaussianBlur");
  insetBlur.setAttribute("in", "SourceAlpha");
  insetBlur.setAttribute("stdDeviation", "3.00");
  insetBlur.setAttribute("result", "insetBlur");
  ink.append(insetBlur);

  // Make the inset darken: take blurred alpha, invert via component
  // transfer so center→opaque becomes center→transparent and vice versa
  // (no wait, we want the OPPOSITE: at edges blur=0, at center blur=full).
  // Actually we want the EDGES darker and center clear, which is precisely
  // what (1 - blurAlpha) gives if we then compose 'in' against the source.
  const insetInv = document.createElementNS(SVG_NS, "feComponentTransfer");
  insetInv.setAttribute("in", "insetBlur");
  const ifa = document.createElementNS(SVG_NS, "feFuncA");
  ifa.setAttribute("type", "table");
  // Table: at alpha=0 → still 0 (outside doesn't matter, will be masked),
  // at alpha=1 → 0 (center is fully cleared, no inset darkening).  The
  // mid-alpha range (the BLURRED edge region) gets values between → this
  // is where the darkening lives.
  ifa.setAttribute("tableValues", "0 0.5 0");
  insetInv.append(ifa);
  insetInv.setAttribute("result", "insetEdgeAlpha");
  ink.append(insetInv);

  // Color the inset alpha black at 62% opacity
  const insetColor = document.createElementNS(SVG_NS, "feColorMatrix");
  insetColor.setAttribute("in", "insetEdgeAlpha");
  insetColor.setAttribute("type", "matrix");
  insetColor.setAttribute(
    "values",
    "0 0 0 0 0 " + "0 0 0 0 0 " + "0 0 0 0 0 " + "0 0 0 0.62 0",
  );
  insetColor.setAttribute("result", "insetDark");
  ink.append(insetColor);

  // Mask the inset darkening to the source area only
  const insetMask = document.createElementNS(SVG_NS, "feComposite");
  insetMask.setAttribute("in", "insetDark");
  insetMask.setAttribute("in2", "SourceGraphic");
  insetMask.setAttribute("operator", "in");
  insetMask.setAttribute("result", "insetMasked");
  ink.append(insetMask);

  // Final composite: inset over fibered
  const finalComp = document.createElementNS(SVG_NS, "feComposite");
  finalComp.setAttribute("in", "insetMasked");
  finalComp.setAttribute("in2", "fibered");
  finalComp.setAttribute("operator", "over");
  ink.append(finalComp);

  defs.append(ink);

  board.append(defs);

  // Parchment background layer — papyrus rect filtered to look like aged
  // hand-crafted paper.  Sits behind everything else.  Sibling of the
  // shapes layer so the grain filter on top doesn't double up on it.
  const parchLayer = document.createElementNS(SVG_NS, "g");
  parchLayer.setAttribute("filter", "url(#parchment)");
  const parchRect = document.createElementNS(SVG_NS, "rect");
  parchRect.setAttribute("x", "0");
  parchRect.setAttribute("y", "0");
  parchRect.setAttribute("width", "304.8");
  parchRect.setAttribute("height", "457.2");
  parchRect.setAttribute("fill", "#f5e8c4");
  parchLayer.append(parchRect);
  board.append(parchLayer);

  // Shapes layer (filtered) — drawn first so it sits behind the text.
  layers.shapes = document.createElementNS(SVG_NS, "g");
  layers.shapes.setAttribute("filter", "url(#grain)");
  board.append(layers.shapes);

  // Text layer (unfiltered) — drawn last so numbers sit on top.
  layers.text = document.createElementNS(SVG_NS, "g");
  board.append(layers.text);
}

// Inject a <style> with the Kranky @font-face inside the SVG itself.  Required
// for the PNG export — when the SVG is serialized and loaded via `new Image()`
// for canvas rasterization, only resources reachable from inside the SVG are
// loaded.  Embedding the font as a base64 data URL keeps the SVG self-contained.
export function ensureSvgFont(): void {
  const styleElement = document.createElementNS(SVG_NS, "style");
  styleElement.textContent = `
    @font-face {
      font-family: 'Kranky';
      font-style: normal;
      font-weight: 400;
      src: url(data:font/woff2;base64,${KRANKY_B64}) format('woff2');
    }
  `;
  board.append(styleElement);
}

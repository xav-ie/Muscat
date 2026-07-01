// Headless generator for a standalone "portrait" of the castle — used to build
// a small preview SVG (e.g. a portfolio icon) without the rest of the board.
//
// It runs the real `castle()` renderer against a jsdom document, then applies a
// caller-supplied recolour so Muscat stays palette-agnostic: the consumer maps
// the board's raw hex colours to whatever fills/strokes/classes it wants.
//
// Single-use per process: importing the board modules queries `#board` at load,
// so call `generatePreview` once and let the process exit.
import { JSDOM } from "jsdom";

/** Framing + `castle()` options for the preview. All optional; sensible
 *  preview defaults are applied (no windows, narrowed body, chunky bricks). */
interface PreviewCastleOptions {
  castleW?: number;
  castleH?: number;
  castleInset?: number;
  marginV?: number;
  windows?: boolean;
  bodyScale?: number;
  towerMerlons?: number;
  doorScale?: number;
  handleScale?: number;
  handleSpread?: number;
}

/** Recolour maps keyed by the board's raw hex colours. Everything defaults to
 *  empty (i.e. keep the board's realistic colours). */
interface PreviewRecolor {
  /** `fill="#hex"` → add this class, drop the fill. */
  fillClass?: Record<string, string>;
  /** `stroke="#hex"` → add this class, drop the stroke. */
  strokeClass?: Record<string, string>;
  /** `stroke="#hex"` → replace with this literal stroke colour. */
  strokeHex?: Record<string, string>;
  /** `stop-color="#hex"` → add this class, drop the stop-color. */
  stopClass?: Record<string, string>;
  /** `fill="#hex"` inside the `#wood` door pattern → add this class. */
  woodFill?: Record<string, string>;
}

export interface PreviewOptions {
  castle?: PreviewCastleOptions;
  recolor?: PreviewRecolor;
}

interface PreviewResult {
  svg: string;
  viewBox: string;
}

export async function generatePreview(options: PreviewOptions = {}): Promise<PreviewResult> {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <svg viewBox="0 0 304.8 457.2" xmlns="http://www.w3.org/2000/svg" id="board"></svg>
    </body></html>`,
    { pretendToBeVisual: true },
  );

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.performance = dom.window.performance;
  // Build-time esbuild `define` substitutions — stub them for the headless run.
  g.__ICONS__ = {};
  g.__KRANKY_B64__ = "";

  // Import AFTER globals are live (state.js queries #board at module load).
  const { board } = await import("./state.js");
  const { setupLayers } = await import("./svg/filters.js");
  const { castle } = await import("./components/castle.js");

  setupLayers();

  const c = options.castle ?? {};
  const W = 304.8;
  const castleInset = c.castleInset ?? 38;
  const castleX = castleInset;
  const castleW = c.castleW ?? W - castleInset * 2;
  const castleH = c.castleH ?? 95;
  const marginV = c.marginV ?? 9;
  const bodyScale = c.bodyScale ?? 0.32;
  const brickH = castleH * 0.045;
  const topMargin = 6 + brickH;

  castle(castleX, topMargin, castleW, castleH, {
    windows: c.windows ?? false,
    bodyScale,
    handleScale: c.handleScale ?? 1.6,
    handleSpread: c.handleSpread ?? 1.6,
    towerMerlons: c.towerMerlons ?? 2,
    doorScale: c.doorScale ?? 1.6,
  });

  // Actual castle extent after narrowing the wall (mirrors castle()'s math: the
  // door keeps its full width, only the flanking wall scales).
  const towerW = castleW * 0.13;
  const bodyWFull = castleW - towerW * 2;
  const doorW = bodyWFull * 0.28;
  const effectiveW = towerW * 2 + (doorW + (bodyWFull - doorW) * bodyScale);
  // Bounding box of the castle (towers reach full height).
  const merlonH = castleH * 0.045;
  const towerRows = Math.round(castleH / merlonH);
  const towerH = towerRows * merlonH;
  // Frame to a clean 2:1 viewBox (a 2:1 card + object-fit:cover). The narrowed
  // castle is taller than half its width, so size the box by HEIGHT (castle +
  // vertical margin), make it 2:1, then centre the castle horizontally.
  const vbH = towerH + marginV * 2;
  const vbW = vbH * 2;
  const vbY = topMargin - marginV;
  const vbX = castleX + effectiveW / 2 - vbW / 2;

  // The castle draws everything into the shapes layer (the <g filter="url(#grain)">).
  // Drop the parchment background layer, empty rasters layer, and text layer.
  const shapes = [...board.querySelectorAll<SVGGElement>(":scope > g")].find(
    (n) => n.getAttribute("filter") === "url(#grain)",
  );
  if (!shapes) throw new Error("preview: grain-filtered shapes layer not found");
  // Drop the hand-drawn grain displacement — too heavy for a small icon.
  shapes.removeAttribute("filter");

  // ── Recolour (caller-supplied; empty = keep the board's raw colours) ──
  const r = options.recolor ?? {};
  const fillClass = r.fillClass ?? {};
  const strokeClass = r.strokeClass ?? {};
  const strokeHex = r.strokeHex ?? {};
  const stopClass = r.stopClass ?? {};
  for (const element of shapes.querySelectorAll<SVGElement>("*")) {
    const fill = element.getAttribute("fill");
    if (fill && fillClass[fill]) {
      element.removeAttribute("fill");
      element.classList.add(fillClass[fill]);
    }
    const stroke = element.getAttribute("stroke");
    if (stroke && strokeClass[stroke]) {
      element.removeAttribute("stroke");
      element.classList.add(strokeClass[stroke]);
    } else if (stroke && strokeHex[stroke]) {
      element.setAttribute("stroke", strokeHex[stroke]);
    }
    const stop = element.getAttribute("stop-color");
    if (stop && stopClass[stop]) {
      element.removeAttribute("stop-color");
      element.classList.add(stopClass[stop]);
    }
  }

  // The door's wood pattern lives in the top-level <defs>, not the shapes layer.
  const woodFill = r.woodFill ?? {};
  const woodElement = board.querySelector("#wood");
  if (!woodElement) throw new Error("preview: #wood pattern not found");
  for (const rect of woodElement.querySelectorAll("rect")) {
    const fill = rect.getAttribute("fill");
    if (fill && woodFill[fill]) {
      rect.removeAttribute("fill");
      rect.setAttribute("class", woodFill[fill]);
    }
  }
  const wood = woodElement.outerHTML;

  const viewBox = [vbX, vbY, vbW, vbH].map(String).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
<defs>${wood}</defs>
${shapes.outerHTML}
</svg>
`;
  return { svg, viewBox };
}

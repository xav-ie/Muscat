import { SVG_NS, board, G } from "./state.js";
import { freshSeed } from "./util/rng.js";
import { get2dContext } from "./util/canvasLayer.js";
import { render } from "./render.js";

// Look up an element by CSS selector and verify its runtime type via the
// element constructor. Throws if the element is missing or the wrong tag.
// The `ctor` parameter constrains T so it isn't a phantom type parameter.
function $<T extends Element>(selector: string, ctor: new () => T): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`required element not found: ${selector}`);
  if (!(el instanceof ctor)) {
    throw new TypeError(
      `${selector} is not a ${ctor.name} (got ${el.constructor.name})`,
    );
  }
  return el;
}

// ─────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────
const seedBtn = $("#reseed", HTMLButtonElement);
const exportBtn = $("#export-png", HTMLButtonElement);
const gFreqEl = $("#grain-freq", HTMLInputElement);
const gScaleEl = $("#grain-scale", HTMLInputElement);
const gFreqVal = $("#grain-freq-val", HTMLElement);
const gScaleVal = $("#grain-scale-val", HTMLElement);

seedBtn.addEventListener("click", () => {
  G.seed = freshSeed();
  render();
});

function fmt(v: number): string {
  return v.toFixed(2);
}

// Grain sliders update the live filter attributes directly — cheap, doesn't
// re-shuffle the wobble, just retunes the noise displacement.
gFreqEl.addEventListener("input", () => {
  G.grainFreq = Number.parseFloat(gFreqEl.value);
  gFreqVal.textContent = fmt(G.grainFreq);
  document
    .querySelector("#grain-turb")
    ?.setAttribute("baseFrequency", String(G.grainFreq));
});
gScaleEl.addEventListener("input", () => {
  G.grainScale = Number.parseFloat(gScaleEl.value);
  gScaleVal.textContent = fmt(G.grainScale);
  document
    .querySelector("#grain-disp")
    ?.setAttribute("scale", String(G.grainScale));
});

// Export the SVG as a 12×18 inch PNG at the requested DPI.
// The SVG is rasterized through a <canvas>, which gives a print-ready bitmap.
async function exportPng(dpi = 300): Promise<void> {
  const widthIn = 12,
    heightIn = 18;
  const W = Math.round(widthIn * dpi);
  const H = Math.round(heightIn * dpi);

  // Make sure the embedded font has fully loaded before serializing
  await document.fonts.ready;

  // Clone the SVG so we can stamp explicit width/height without disturbing the
  // live one; the inline style + base64 font ride along automatically.
  const clone = board.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", `${widthIn}in`);
  clone.setAttribute("height", `${heightIn}in`);
  clone.setAttribute("xmlns", SVG_NS);

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  exportBtn.disabled = true;
  exportBtn.textContent = "rendering…";
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.addEventListener("load", () => {
        resolve();
      });
      img.addEventListener("error", () => {
        reject(new Error("SVG → image load failed"));
      });
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = get2dContext(canvas);
    ctx.fillStyle = "#f5e8c4"; // papyrus — matches the on-screen --paper
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
    const a = document.createElement("a");
    a.download = `board-12x18-${dpi}dpi.png`;
    a.href = URL.createObjectURL(pngBlob);
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    URL.revokeObjectURL(url);
    exportBtn.disabled = false;
    exportBtn.textContent = "export 12×18 png · 300dpi";
  }
}
exportBtn.addEventListener("click", () => {
  void exportPng(300);
});

render();

import { SVG_NS, board, G } from "./state.js";
import { svg } from "./svg/template.js";
import { freshSeed } from "./util/rng.js";
import { get2dContext } from "./util/canvas-layer.js";
import { render } from "./render.js";

// Look up an element by CSS selector and verify its runtime type via the
// element constructor. Throws if the element is missing or the wrong tag.
// The `ctor` parameter constrains T so it isn't a phantom type parameter.
function $<T extends Element>(selector: string, ctor: new () => T): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`required element not found: ${selector}`);
  if (!(element instanceof ctor)) {
    throw new TypeError(`${selector} is not a ${ctor.name} (got ${element.constructor.name})`);
  }
  return element;
}

// ─────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────
const seedButton = $("#reseed", HTMLButtonElement);
const exportButton = $("#export-png", HTMLButtonElement);

seedButton.addEventListener("click", () => {
  G.seed = freshSeed();
  void render();
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
  clone.setAttribute("width", svg`${widthIn}in`);
  clone.setAttribute("height", svg`${heightIn}in`);
  clone.setAttribute("xmlns", SVG_NS);

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  exportButton.disabled = true;
  exportButton.textContent = "rendering…";
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
    const context = get2dContext(canvas);
    context.fillStyle = "#f5e8c4"; // papyrus — matches the on-screen --paper
    context.fillRect(0, 0, W, H);
    context.drawImage(img, 0, 0, W, H);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error("canvas.toBlob returned null"));
      }, "image/png");
    });
    const a = document.createElement("a");
    a.download = svg`board-12x18-${dpi}dpi.png`;
    a.href = URL.createObjectURL(pngBlob);
    a.click();
    URL.revokeObjectURL(a.href);
  } finally {
    URL.revokeObjectURL(url);
    exportButton.disabled = false;
    exportButton.textContent = "🖼️ export 12×18 png · 300dpi";
  }
}
exportButton.addEventListener("click", () => {
  void exportPng(300);
});

void render();

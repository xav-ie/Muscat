import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(ROOT, "assets");
const TEMPLATE = resolve(ROOT, "board.template.html");
const OUT = resolve(ROOT, "dist", "board.html");

const ICON_FILES: Record<string, string> = {
  jester: "jesterhat.svg",
  lute: "lyre.svg",
  feather: "quill.svg",
  crystal: "crystalball.svg",
};

const b64 = (path: string) => readFileSync(path).toString("base64");

const icons = Object.fromEntries(
  Object.entries(ICON_FILES).map(([name, file]) => [name, b64(resolve(ASSETS, file))]),
);
const krankyB64 = b64(resolve(ASSETS, "kranky-latin-400-normal.woff2"));

const html = readFileSync(TEMPLATE, "utf8")
  .replaceAll("__ICONS__", JSON.stringify(icons))
  .replaceAll("__KRANKY_B64__", krankyB64);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${html.length.toLocaleString()} chars)`);

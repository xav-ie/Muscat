import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(ROOT, "assets");
const TEMPLATE = path.resolve(ROOT, "board.template.html");
const ENTRY = path.resolve(ROOT, "src", "main.ts");
const OUT = path.resolve(ROOT, "dist", "board.html");

const ICON_FILES: Record<string, string> = {
  jester: "jesterhat.svg",
  lute: "lyre.svg",
  feather: "quill.svg",
  crystal: "crystalball.svg",
};

// The Kranky display font comes from @fontsource/kranky rather than a
// checked-in binary — reproducible via package-lock, baked in below at build.
// Resolve through the package (respects `exports`/hoisting) instead of a
// hardcoded node_modules path.
const KRANKY_WOFF2 = fileURLToPath(
  import.meta.resolve("@fontsource/kranky/files/kranky-latin-400-normal.woff2"),
);

const b64 = (file: string) => readFileSync(file).toString("base64");

const icons = Object.fromEntries(
  Object.entries(ICON_FILES).map(([name, file]) => [name, b64(path.resolve(ASSETS, file))]),
);
const krankyB64 = b64(KRANKY_WOFF2);

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
  legalComments: "none",
  define: {
    __ICONS__: JSON.stringify(icons),
    __KRANKY_B64__: JSON.stringify(krankyB64),
  },
});
const script = result.outputFiles[0].text;

const html = readFileSync(TEMPLATE, "utf8")
  .replaceAll("__KRANKY_B64__", krankyB64)
  .replace("__SCRIPT__", script);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `wrote ${OUT} (${html.length.toLocaleString()} chars, script ${script.length.toLocaleString()})`,
);

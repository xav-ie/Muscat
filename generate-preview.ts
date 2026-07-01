// CLI wrapper around `generatePreview` — reads a JSON config (castle + recolour
// options) and writes the resulting SVG to stdout, so a consumer can do:
//
//   tsx generate-preview.ts preview.config.json > out.svg
//   nix run .#generate-preview -- preview.config.json > out.svg
//
// With no config path it emits the raw (un-recoloured) preview.
import { readFileSync } from "node:fs";
import { generatePreview, type PreviewOptions } from "./src/preview.js";

const configPath = process.argv[2];
const options: PreviewOptions = configPath
  ? (JSON.parse(readFileSync(configPath, "utf8")) as PreviewOptions)
  : {};

const { svg, viewBox } = await generatePreview(options);
process.stdout.write(svg);
process.stderr.write(`generate-preview: viewBox="${viewBox}" (${String(svg.length)} chars)\n`);

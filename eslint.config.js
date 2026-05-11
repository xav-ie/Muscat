import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginUnicorn from "eslint-plugin-unicorn";
import globals from "globals";

export default defineConfig(
  {
    ignores: ["dist/", "node_modules/"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintPluginUnicorn.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["build.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // SVG path generation is built on `${x} ${y}` interpolation — numbers
      // in template literals are intentional and pervasive.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      // Files use camelCase to match exported identifiers.
      "unicorn/filename-case": ["error", { case: "camelCase" }],
      // Prettier 3.x downcases hex literals (`0xFF` → `0xff`); align this rule
      // so they don't fight on every format pass.
      "unicorn/number-literal-case": [
        "error",
        { hexadecimalValue: "lowercase" },
      ],
      // Domain conventions: SVG/canvas drawing code uses short geometric
      // identifiers and math/graphics suffixes that read more naturally to
      // the people who write and maintain this code than fully-spelled
      // equivalents.
      "unicorn/prevent-abbreviations": [
        "error",
        {
          allowList: {
            // Single-letter coordinates and vectors
            x: true,
            y: true,
            w: true,
            h: true,
            r: true,
            cx: true,
            cy: true,
            dx: true,
            dy: true,
            mx: true,
            my: true,
            nx: true,
            ny: true,
            px: true,
            py: true,
            ux: true,
            uy: true,
            tx: true,
            ty: true,
            gx: true,
            gy: true,
            sx: true,
            sy: true,
            rx: true,
            ry: true,
            wx: true,
            wy: true,
            bx: true,
            by: true,
            ddx: true,
            ddy: true,
            // Pixel/buffer indexing in tight loops
            i: true,
            j: true,
            k: true,
            n: true,
            t: true,
            // Sine-warp phase offsets used in caustics/magma noise
            ph1x: true,
            ph1y: true,
            ph2x: true,
            ph2y: true,
          },
          // Disable replacements for abbreviations that appear as compound
          // suffixes/prefixes in identifiers throughout the drawing code
          // (e.g. `arrowDir`, `cumLen`, `vIdx`, `crestYFn`).
          replacements: {
            arg: false, // topYArg, botYArg
            arr: false, // fieldArr
            args: false,
            btn: false, // seedBtn, exportBtn
            cur: false, // cur, curIn (iterator state)
            ctx: false, // canvas 2D context — universal idiom
            dir: false, // arrowDir, dirX, dirY
            dirs: false, // arrowDirs (plural)
            dist: false, // minDist, minDistSq, distT (geometric distance)
            el: false, // bannerEl, styleEl, gFreqEl
            env: false, // envelope (sine envelope)
            fn: false, // heightFn, crestYFn, topYFn
            idx: false, // vIdx, sampleIdx, attachSegIdx
            len: false, // arrowLen, cumLen, segLen
            num: false, // numFontSize, numCols, numRows
            ref: false, // `for ref of merge` — SVG <feMergeNode in=…>
            rng: false, // random number generator
            src: false, // `for src of merge` — SVG filter inputs
            str: false, // dStr (path data string accumulator)
            val: false, // gFreqVal, gScaleVal
          },
        },
      ],
    },
  },
);

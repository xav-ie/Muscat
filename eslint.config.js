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
      // We use `!` deliberately on `layers.shapes!` etc. where the value is
      // guaranteed non-null during render but TS can't prove it. The type
      // system catches misuse; this rule would just generate noise.
      "@typescript-eslint/no-non-null-assertion": "off",

      // SVG/canvas drawing code uses short geometric names by convention
      // (cx, cy, dx, dy, rng, ctx, w, h, etc.) — they're domain-appropriate.
      "unicorn/prevent-abbreviations": "off",
      // `null` is a legitimate distinct value for "intentionally absent
      // initialized state" (e.g. `__tintRegistry: Map | null` reset between renders).
      "unicorn/no-null": "off",
      // Files use camelCase to match exported identifiers.
      "unicorn/filename-case": ["error", { case: "camelCase" }],
      // Pixel-loop and inner-helper patterns are deliberate; these rules
      // fight the procedural style of the drawing code.
      "unicorn/no-for-loop": "off",
      "unicorn/consistent-function-scoping": "off",
      // `getElementById` is fine for known DOM IDs and faster than querySelector.
      "unicorn/prefer-query-selector": "off",
      // Prettier 3.x downcases hex literals (`0xFF` → `0xff`); align this rule
      // so they don't fight on every format pass.
      "unicorn/number-literal-case": [
        "error",
        { hexadecimalValue: "lowercase" },
      ],
    },
  },
);

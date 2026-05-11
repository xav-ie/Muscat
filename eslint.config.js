import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default defineConfig(
  {
    ignores: ["dist/", "node_modules/"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
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
    },
  },
);

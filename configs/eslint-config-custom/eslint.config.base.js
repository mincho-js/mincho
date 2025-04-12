// @ts-check

import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // == Formatting =============================================================
  // @ts-ignore
  eslintPluginPrettierRecommended,
  eslintConfigPrettier,
  {
    rules: {
      "prettier/prettier": ["error", { endOfLine: "auto" }]
    }
  },

  // == Ignores ================================================================
  {
    ignores: [
      "dist/**",
      "_release/**",
      "node_modules/**",
      "coverage/**",
      "vite.config.ts.timestamp*.mjs",
      ".cache"
    ]
  }
);

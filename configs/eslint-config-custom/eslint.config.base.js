// @ts-check

import tseslint from "typescript-eslint";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  // == Formatting =============================================================
  eslintPluginPrettierRecommended,
  {
    rules: {
      "prettier/prettier": ["error", { endOfLine: "auto" }]
    }
  },

  // == Ignores ================================================================
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "vite.config.ts.timestamp*.mjs"]
  }
);

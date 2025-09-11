// @ts-check
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig(
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

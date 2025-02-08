// @ts-check

import { cwd } from "node:process";
import globals from "globals";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import baseConfig from "./eslint.config.base.js";

/** @typedef {import("typescript-eslint").InfiniteDepthConfigWithExtends} TSConfig */
/** @typedef {import("typescript-eslint").ConfigArray} ConfigArray */

/**
 * @export
 * @type {(userConfigs?: TSConfig) => ConfigArray}
 */
export function eslintConfig(userConfigs = []) {
  return tseslint.config(
    // == Typescript =============================================================
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    // ...tseslint.configs.recommendedTypeChecked,
    // ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          project: ["tsconfig.json"],
          tsconfigRootDir: cwd(),
          projectService: true,

          ecmaVersion: "latest",
          sourceType: "module",
          globals: {
            ...globals.nodeBuiltin,
            ...globals.es2025
          }
        }
      },
      rules: {
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            args: "all",
            argsIgnorePattern: "^_",
            caughtErrors: "all",
            caughtErrorsIgnorePattern: "^_",
            destructuredArrayIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            ignoreRestSiblings: true
          }
        ]
      }
    },

    // == Javascript =============================================================
    {
      files: ["*.js", "*.cjs", "*.mjs"],
      extends: [tseslint.configs.disableTypeChecked]
    },

    ...baseConfig,

    ...(Array.isArray(userConfigs) ? userConfigs : [userConfigs ?? {}])
  );
}

// @ts-check
/// <reference types="node" />

import { cwd } from "node:process";
import globals from "globals";
import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import baseConfig from "./eslint.config.base.js";

/** @typedef {import("typescript-eslint").InfiniteDepthConfigWithExtends} TSConfig */
/** @typedef {import("eslint").Linter.Config} Config */
/** @typedef {Config[]} ConfigArray */

/**
 * @export
 * @type {(userConfigs?: TSConfig) => ConfigArray}
 */
export function eslintConfig(userConfigs = []) {
  const normalizedUserConfigs = /** @type {ConfigArray} */ (
    Array.isArray(userConfigs) ? userConfigs : [userConfigs ?? {}]
  );

  return defineConfig(
    // == Typescript =============================================================
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    // ...tseslint.configs.recommendedTypeChecked,
    // ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
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

    ...normalizedUserConfigs
  );
}

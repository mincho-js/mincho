// @ts-check

import { cwd } from "node:process";
import globals from "globals";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import baseConfig from "./eslint.config.base.js";

export default tseslint.config(
  // == Typescript =============================================================
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // ...tseslint.configs.recommendedTypeChecked,
  // ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.node.json"],
        tsconfigRootDir: cwd(),
        EXPERIMENTAL_useProjectService: true,
        // EXPERIMENTAL_useProjectService: {
        //   // default is 8
        //   // https://typescript-eslint.io/packages/typescript-estree/
        //   maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 100
        // },

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
    files: ["*.js"],
    extends: [tseslint.configs.disableTypeChecked]
  },

  ...baseConfig
);

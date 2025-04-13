// @ts-check

import { cwd } from "node:process";
import globals from "globals";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";
import reactRefreshPlugin from "eslint-plugin-react-refresh";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["tsconfig.json"],
        tsconfigRootDir: cwd(),
        projectService: true,
      },
    },
  },
  {
    files: ["*.ts", "*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["tsconfig.json"],
        tsconfigRootDir: cwd(),
        projectService: true,
        ecmaFeatures: { jsx: true },
      },
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2020 },
    },
    plugins: {
      "react-refresh": reactRefreshPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["*.js", "*.cjs", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    ignores: ["dist/**"],
  },
);

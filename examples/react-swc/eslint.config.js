// @ts-check

import globals from "globals";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import tsParser from "@typescript-eslint/parser";
import reactRefreshPlugin from "eslint-plugin-react-refresh";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import { fixupPluginRules } from "@eslint/compat";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
      },
    },
  },
  {
    files: ["*.ts", "*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.node.json"],
        ecmaFeatures: { jsx: true },
      },
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2020 },
    },
    plugins: {
      "react-refresh": reactRefreshPlugin,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: error TS2345: Index signature for type 'string' is missing in type 'string[]'.ts
      "react-hooks": fixupPluginRules(reactHooksPlugin),
    },
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: error TS2322: type 'string' is not assignable to type 'RuleEntry | undefined'.ts(2322)
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    ignores: ["dist/**"],
  },
);

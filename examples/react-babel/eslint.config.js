import { resolve } from "node:path";
import { cwd } from "node:process";
import globals from 'globals'
import { defineConfig } from "eslint/config";
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import tsParser from "@typescript-eslint/parser";
import reactRefreshPlugin from 'eslint-plugin-react-refresh'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

const PACKAGE_ROOT = resolve(cwd());

export default defineConfig(
   eslint.configs.recommended,
   ...tseslint.configs.recommended,
  reactHooksPlugin.configs.flat.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: PACKAGE_ROOT,
        projectService: true,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["tsconfig.json"],
        tsconfigRootDir: cwd(),
        projectService: true,

        ecmaVersion: "latest",
        sourceType: "module",
        globals: { ...globals.browser, ...globals.es2020 },
      }
    },
    plugins: {
      'react-hooks': reactHooksPlugin,
      'react-refresh': reactRefreshPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
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
)

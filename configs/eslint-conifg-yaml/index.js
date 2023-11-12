const { defineConfig } = require('eslint-define-config');

module.exports = defineConfig({
  $schema: "https://json.schemastore.org/eslintrc.json",
  parser: "yaml-eslint-parser",
  parserOptions: {
    defaultYAMLVersion: "1.2"
  },
  extends: [
    "eslint:recommended",
    "plugin:yml/standard",
    "plugin:yml/prettier",
    "prettier",
    "plugin:prettier/recommended"
  ],
  rules: {
    "prettier/prettier": ["error", { "endOfLine": "auto" }]
  },
  env: {
    node: true
  },
  ignorePatterns: ["dist/**", "node_modules/**", "coverage/**"]
});

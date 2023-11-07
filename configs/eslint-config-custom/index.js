const { defineConfig } = require('eslint-define-config');

module.exports = defineConfig({
  $schema: "https://json.schemastore.org/eslintrc.json",
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: [
    "@typescript-eslint",
    "prettier"
  ],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
    "plugin:prettier/recommended"
  ],
  env: {
    node: true
  },
  ignorePatterns: ["dist/**", "node_modules/**", "coverage/**"]
});

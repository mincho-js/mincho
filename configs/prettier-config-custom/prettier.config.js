export default {
  $schema: "https://json.schemastore.org/prettierrc",
  tabWidth: 2,

  overrides: [
    {
      files: [
        "*.js",
        "*.cjs",
        "*.mjs",
        "*.ts",
        "*.cts",
        "*.mts",
        "*.jsx",
        "*.tsx"
      ],
      options: {
        trailingComma: "none",
        semi: true,
        bracketSpacing: true,
        arrowParens: "always"
      }
    }
  ]
};

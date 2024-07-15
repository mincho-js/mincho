// @ts-check

import tseslint from "typescript-eslint";
import yamlParser from "yaml-eslint-parser";
import eslintPluginYml from "eslint-plugin-yml";
import baseConfig from "./eslint.config.base.js";

export default tseslint.config(
  ...baseConfig,

  // == YAML ===================================================================
  ...eslintPluginYml.configs["flat/standard"],
  ...eslintPluginYml.configs["flat/prettier"],
  {
    files: ["*.yaml", "*.yml"],
    languageOptions: {
      parser: yamlParser,
      parserOptions: {
        defaultYAMLVersion: "1.2"
      }
    }
  }
);

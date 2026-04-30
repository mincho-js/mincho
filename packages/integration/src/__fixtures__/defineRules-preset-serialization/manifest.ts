import { fileURLToPath } from "node:url";

export const DEFINE_RULES_PRESET_SERIALIZATION_ROOT =
  "./__fixtures__/defineRules-preset-serialization" as const;

export function createDefineRulesPresetSerializationFixturePath(
  relativePath: string
): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const DEFINE_RULES_PRESET_SERIALIZATION_PATHS = {
  consumer: "consumer/src/index.css.ts",
  consumerOrder: "consumer-order/src/index.css.ts",
  multipleInstances: "preset-multiple-instances/src/index.css.ts",
  producerTransitive: "producer-transitive/src/index.css.ts",
  providerDistModule: "provider-module/dist/esm/index.mjs",
  providerRoot: "provider-module/src/index.ts",
  providerSidecarCss: "provider-module/dist/style.css",
  providerPreset: "provider-module/src/preset.css.ts",
  viteConsumerEntry: "vite-consumer/src/entry.ts",
  viteConsumerRoot: "vite-consumer"
} as const;

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES = [
  {
    caseId: "registry-direct-exported-owner",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "const presetOwner = defineRules({",
      "export const shared = presetOwner.css({"
    ],
    relativePath: "registry-direct-exported-owner/src/index.css.ts"
  },
  {
    caseId: "registry-exported-destructured",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "export const { css, preset } = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "registry-exported-destructured/src/index.css.ts"
  },
  {
    caseId: "registry-helper-wrapped-executed",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "function createPresetOwner() {",
      "return defineRules({",
      "const presetOwner = createPresetOwner();"
    ],
    relativePath: "registry-helper-wrapped-executed/src/index.css.ts"
  },
  {
    caseId: "registry-iife-executed",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "const presetOwner = (() => {",
      "return defineRules({",
      "export const { css, preset } = presetOwner;"
    ],
    relativePath: "registry-iife-executed/src/index.css.ts"
  },
  {
    caseId: "registry-nested-function-executed",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "function createNestedPresetOwner() {",
      "return defineRules({",
      "const presetOwner = createPresetOwner();"
    ],
    relativePath: "registry-nested-function-executed/src/index.css.ts"
  },
  {
    caseId: "registry-helper-invoked-twice",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 2,
    expectedSourceSnippets: [
      "function createPresetOwner(debugId: string) {",
      "const firstPresetOwner = createPresetOwner(\"first\");",
      "const secondPresetOwner = createPresetOwner(\"second\");"
    ],
    relativePath: "registry-helper-invoked-twice/src/index.css.ts"
  },
  {
    caseId: "registry-multiple-instances",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 2,
    expectedSourceSnippets: [
      "const primaryPresetOwner = defineRules({",
      "const secondaryPresetOwner = defineRules({",
      "export const secondaryShared = secondaryPresetOwner.css({"
    ],
    relativePath: "registry-multiple-instances/src/index.css.ts"
  },
  {
    caseId: "registry-imported-helper-executed",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "import { createPresetOwner } from \"./helper\";",
      "const presetOwner = createPresetOwner();",
      "export const shared = css({"
    ],
    relativePath: "registry-imported-helper-executed/src/index.css.ts"
  },
  {
    caseId: "registry-const-config-executed",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "const config = {",
      "export const { css, preset } = defineRules(config);",
      "export const shared = css({"
    ],
    relativePath: "registry-const-config-executed/src/index.css.ts"
  },
  {
    caseId: "registry-exported-factory-not-executed",
    expectedEvaluation: "not-serialized",
    expectedRegistryInstances: 0,
    expectedSourceSnippets: [
      "export function createPresetOwner() {",
      "return defineRules({",
      "export const factoryStatus = \"not-executed\";"
    ],
    relativePath: "registry-exported-factory-not-executed/src/index.css.ts"
  },
  {
    caseId: "registry-function-config-invalid",
    expectedEvaluation: "not-serialized",
    expectedRegistryInstances: 0,
    expectedSourceSnippets: [
      "color(value: string) {",
      "export const raw = invalidPresetOwner.css.raw({"
    ],
    relativePath: "registry-function-config-invalid/src/index.css.ts"
  }
] as const;

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_SUPPORTED_CASES =
  DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.filter(
    (fixtureCase) => fixtureCase.expectedEvaluation === "serialized"
  );

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_NON_SERIALIZED_CASES =
  DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.filter(
    (fixtureCase) => fixtureCase.expectedEvaluation === "not-serialized"
  );

export const DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES = [
  {
    caseId: "shape-1-local-owner-exported-members",
    expectedSourceSnippets: [
      "const presetOwner = defineRules({",
      "export const shared = presetOwner.css({"
    ],
    relativePath: "registry-direct-exported-owner/src/index.css.ts"
  },
  {
    caseId: "shape-2-exported-destructured-css-and-preset",
    expectedSourceSnippets: [
      "export const { css, preset } = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "registry-exported-destructured/src/index.css.ts"
  },
  {
    caseId: "shape-3-exported-owner-and-css",
    expectedSourceSnippets: [
      "export const preset = defineRules({",
      "export const { css } = preset;"
    ],
    relativePath: "preset-exported-owner-and-css/src/index.css.ts"
  },
  {
    caseId: "shape-4-exported-destructured-css-only",
    expectedSourceSnippets: [
      "export const { css } = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "preset-direct-css-only/src/index.css.ts"
  },
  {
    caseId: "shape-5-exported-aliased-css-only",
    expectedSourceSnippets: [
      "export const { css: atomicCss } = defineRules({",
      "export const shared = atomicCss({"
    ],
    relativePath: "preset-aliased-css-only/src/index.css.ts"
  }
] as const;

export const DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES = [
  {
    caseId: "unsupported-helper-wrapped",
    expectedSourceSnippets: [
      "function createPresetOwner() {",
      "return defineRules({",
      "const presetOwner = createPresetOwner();"
    ],
    requireObjectLiteralConfig: true,
    relativePath: "registry-helper-wrapped-executed/src/index.css.ts"
  },
  {
    caseId: "unsupported-non-top-level",
    expectedSourceSnippets: [
      "const presetOwner = (() => {",
      "return defineRules({",
      "export const { css, preset } = presetOwner;"
    ],
    requireObjectLiteralConfig: true,
    relativePath: "registry-iife-executed/src/index.css.ts"
  },
  {
    caseId: "unsupported-non-object-literal",
    expectedSourceSnippets: [
      "const config = {",
      "export const { css, preset } = defineRules(config);"
    ],
    requireObjectLiteralConfig: false,
    relativePath: "registry-const-config-executed/src/index.css.ts"
  }
] as const;

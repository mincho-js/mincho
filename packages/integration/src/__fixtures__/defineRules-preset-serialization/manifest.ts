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

interface DefineRulesPresetSerializationRegistryMatrixCase {
  caseId: string;
  expectedEvaluation: "serialized" | "not-serialized" | "invalid";
  expectedRegistryInstances: number;
  expectedSourceSnippets: readonly string[];
  relativePath: string;
}

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES: readonly DefineRulesPresetSerializationRegistryMatrixCase[] = [
  {
    caseId: "registry-direct-exported-owner",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "const presetOwner = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "support-matrix-local-owner-exported-members/src/index.css.ts"
  },
  {
    caseId: "registry-exported-destructured",
    expectedEvaluation: "serialized",
    expectedRegistryInstances: 1,
    expectedSourceSnippets: [
      "export const { css, preset } = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "support-matrix-exported-destructured/src/index.css.ts"
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
    relativePath: "negative-helper-wrapped/src/index.css.ts"
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
    relativePath: "negative-non-top-level/src/index.css.ts"
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
    relativePath: "negative-non-object-literal/src/index.css.ts"
  }
];

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_SUPPORTED_CASES =
  DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.filter(
    (fixtureCase) => fixtureCase.expectedEvaluation === "serialized"
  );

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_NON_SERIALIZED_CASES =
  DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.filter(
    (fixtureCase) => fixtureCase.expectedEvaluation === "not-serialized"
  );

export const DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_INVALID_CASES =
  DEFINE_RULES_PRESET_SERIALIZATION_REGISTRY_MATRIX_CASES.filter(
    (fixtureCase) => fixtureCase.expectedEvaluation === "invalid"
  );

export const DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES = [
  {
    caseId: "shape-1-exported-owner",
    expectedSourceSnippets: [
      "export const presetOwner = defineRules({",
      "export const shared = presetOwner.css({"
    ],
    relativePath: "support-matrix-exported-owner/src/index.css.ts"
  },
  {
    caseId: "shape-2-exported-destructured-css-and-preset",
    expectedSourceSnippets: [
      "export const { css, preset } = defineRules({",
      "export const shared = css({"
    ],
    relativePath: "support-matrix-exported-destructured/src/index.css.ts"
  },
  {
    caseId: "shape-3-exported-aliased-destructured-css-and-preset",
    expectedSourceSnippets: [
      "export const { css: sharedCss, preset: sharedPreset } = defineRules({",
      "export const shared = sharedCss({"
    ],
    relativePath: "support-matrix-exported-aliased-destructured/src/index.css.ts"
  },
  {
    caseId: "shape-4-local-owner-exported-members",
    expectedSourceSnippets: [
      "const presetOwner = defineRules({",
      "export const css = presetOwner.css;",
      "export const preset = presetOwner.preset;"
    ],
    relativePath: "support-matrix-local-owner-exported-members/src/index.css.ts"
  },
  {
    caseId: "shape-5-exported-owner-exported-destructured",
    expectedSourceSnippets: [
      "export const presetOwner = defineRules({",
      "export const { css, preset } = presetOwner;"
    ],
    relativePath: "support-matrix-exported-owner-exported-destructured/src/index.css.ts"
  },
  {
    caseId: "shape-6-local-destructured-export-list",
    expectedSourceSnippets: [
      "const { css, preset } = defineRules({",
      "export { css, preset };"
    ],
    relativePath: "support-matrix-local-destructured-export-list/src/index.css.ts"
  }
] as const;

export const DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES = [
  {
    caseId: "unsupported-helper-wrapped",
    expectedSourceSnippets: [
      "function createPresetOwner() {",
      "return defineRules({",
      "export const presetOwner = createPresetOwner();"
    ],
    requireObjectLiteralConfig: true,
    relativePath: "negative-helper-wrapped/src/index.css.ts"
  },
  {
    caseId: "unsupported-non-top-level",
    expectedSourceSnippets: [
      "export const presetOwner = (() => {",
      "return defineRules({",
      "export const { css, preset } = presetOwner;"
    ],
    requireObjectLiteralConfig: true,
    relativePath: "negative-non-top-level/src/index.css.ts"
  },
  {
    caseId: "unsupported-non-object-literal",
    expectedSourceSnippets: [
      "const config = {",
      "export const { css, preset } = defineRules(config);"
    ],
    requireObjectLiteralConfig: false,
    relativePath: "negative-non-object-literal/src/index.css.ts"
  }
] as const;

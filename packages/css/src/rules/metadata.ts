import type {
  ComplexPropDefinitions,
  PatternResult,
  PropTarget,
  RuntimeFn,
  VariantGroups
} from "./types.js";

const rulesConfig = /* @__PURE__ */ Symbol.for("@mincho-js/css/rulesConfig");

export function attachRulesConfig<
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(runtime: RuntimeFn<Variants, Props>, config: PatternResult<Variants, Props>) {
  Object.defineProperty(runtime, rulesConfig, { value: config });
}

export function getRulesConfig<
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(runtime: RuntimeFn<Variants, Props>): PatternResult<Variants, Props> {
  const config: unknown =
    typeof runtime === "function"
      ? Reflect.get(runtime, rulesConfig)
      : undefined;
  if (
    typeof config !== "object" ||
    config === null ||
    !("extension" in config) ||
    typeof config.extension !== "object" ||
    config.extension === null ||
    !("version" in config.extension) ||
    config.extension.version !== 1
  ) {
    throw new Error(
      "rules.extends() expected a rules() result with extension metadata; rebuild the parent with a version that supports rules.extends()."
    );
  }
  return config as PatternResult<Variants, Props>;
}

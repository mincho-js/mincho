import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import { mapVarProps } from "./mapVarProps.js";
import {
  createClassRuntimeFn,
  createCompiledClassRuntimeFn,
  type ClassRuntimeFeatures
} from "./createClassRuntimeFn.js";
import type {
  ClassRuntimeConfig,
  ComplexPropDefinitions,
  PatternResult,
  PropTarget,
  PropVars,
  RuntimeFn,
  VariantGroups
} from "./types.js";

/** Direct callers may mutate their configuration between calls. */
export const createRuntimeFn = <
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(
  config: PatternResult<Variants, Props>
): RuntimeFn<Variants, Props> => {
  const runtime = createClassRuntimeFn(config) as RuntimeFn<Variants, Props>;
  runtime.props = (input) => {
    const result: CSSRule = {};

    // Direct input getters may replace the table. Its accessor is observable
    // for every entry, after Object.entries has finished reading all values.
    for (const [name, value] of Object.entries(input)) {
      const variable = config.propVars[name as keyof PropVars<Props>];

      if (variable !== undefined) result[variable] = value as string;
    }

    return result;
  };

  return runtime;
};

/** The compiler serializes class data independently from variable mappings. */
/* @__NO_SIDE_EFFECTS__ */
export const createCompiledRuntimeFn = <
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(
  config: ClassRuntimeConfig<Variants>,
  propVars: PropVars<Props> | undefined,
  features?: CompiledRuntimeFeatures
): RuntimeFn<Variants, Props> => {
  const runtime = createCompiledClassRuntimeFn(config, features) as RuntimeFn<
    Variants,
    Props
  >;

  if (features?.props !== false)
    runtime.props = (input) => mapVarProps(propVars ?? {}, input) as CSSRule;

  return runtime;
};

export interface CompiledRuntimeFeatures extends ClassRuntimeFeatures {
  props?: boolean;
}

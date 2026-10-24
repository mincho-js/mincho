import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import type {
  ClassRuntimeConfig,
  ClassRuntimeFn,
  ComplexPropDefinitions,
  PropTarget,
  PropVars,
  RuntimeFn,
  VariantGroups,
  VariantObjectSelection,
  VariantSelection
} from "./types.js";
import {
  attachRuntimeProperties,
  type ClassRuntimeFeatures
} from "./runtimeProperties.js";
import { transformVariantSelection } from "./utils.js";
import { mapVarProps } from "./mapVarProps.js";
import type { CompiledRuntimeFeatures } from "./createRuntimeFn.js";

/** Compiler-only immutable recipes whose original runtime never enables its cache. */
/* @__NO_SIDE_EFFECTS__ */
export function createCompactClassRuntimeFn<Variants extends VariantGroups>(
  config: ClassRuntimeConfig<Variants>,
  features?: ClassRuntimeFeatures
): ClassRuntimeFn<Variants> {
  const names = Object.keys(config.variantClassNames);
  const checks = config.compoundVariants.map(([check]) => Object.keys(check));

  return attachRuntimeProperties(
    config,
    (options) => {
      // Spread reads all getters, including keys that do not select a variant.
      const selections: VariantObjectSelection<Variants> = {
        ...config.defaultVariants,
        ...transformVariantSelection<Variants>(
          options as VariantSelection<Variants>
        )
      };
      let result = config.defaultClassName;

      for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(selections, name)) continue;
        const selected = selections[name] ?? config.defaultVariants[name];
        if (selected == null) continue;
        const value = config.variantClassNames[name]?.[selected as string];
        if (value) result += " " + value;
      }

      for (let index = 0; index < checks.length; index++) {
        const [check, value] = config.compoundVariants[index];
        let matches = true;
        for (const name of checks[index])
          if (
            check[name] !== (selections[name] ?? config.defaultVariants[name])
          ) {
            matches = false;
            break;
          }
        if (matches) result += " " + value;
      }

      return result;
    },
    true,
    features
  );
}

/* @__NO_SIDE_EFFECTS__ */
export function createCompactRuntimeFn<
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(
  config: ClassRuntimeConfig<Variants>,
  propVars: PropVars<Props> | undefined,
  features?: CompiledRuntimeFeatures
): RuntimeFn<Variants, Props> {
  const runtime = createCompactClassRuntimeFn(config, features) as RuntimeFn<
    Variants,
    Props
  >;
  if (features?.props !== false)
    runtime.props = (input) => mapVarProps(propVars ?? {}, input) as CSSRule;
  return runtime;
}

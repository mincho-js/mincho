import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import type {
  PatternResult,
  RecipeClassNames,
  RuntimeFn,
  VariantGroups,
  VariantSelection,
  VariantObjectSelection,
  ComplexPropDefinitions,
  PropDefinitionOutput,
  PropTarget
} from "./types.js";
import { mapValues, transformVariantSelection } from "./utils.js";

const shouldApplyCompound = <Variants extends VariantGroups>(
  compoundCheck: VariantObjectSelection<Variants>,
  selections: VariantObjectSelection<Variants>,
  defaultVariants: VariantObjectSelection<Variants>
) => {
  for (const key of Object.keys(compoundCheck)) {
    if (compoundCheck[key] !== (selections[key] ?? defaultVariants[key])) {
      return false;
    }
  }

  return true;
};

export const createRuntimeFn = <
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
>(
  config: PatternResult<Variants, Props>
): RuntimeFn<Variants, Props> => {
  const runtimeFn: RuntimeFn<Variants, Props> = (options) => {
    let className = config.defaultClassName;

    const selections: VariantObjectSelection<Variants> = {
      ...config.defaultVariants,
      ...transformVariantSelection<Variants>(
        options as VariantSelection<Variants>
      )
    };
    for (const variantName in selections) {
      const variantSelection =
        selections[variantName] ?? config.defaultVariants[variantName];

      if (variantSelection != null) {
        let selection = variantSelection;

        if (typeof selection === "boolean") {
          // @ts-expect-error - Needed to convert boolean to string
          selection = selection === true ? "true" : "false";
        }

        const selectionClassName =
          config.variantClassNames[variantName]?.[
            selection as keyof (typeof config.variantClassNames)[typeof variantName]
          ];

        if (selectionClassName) {
          className += " " + selectionClassName;
        }
      }
    }

    for (const [compoundCheck, compoundClassName] of config.compoundVariants) {
      if (
        shouldApplyCompound(compoundCheck, selections, config.defaultVariants)
      ) {
        className += " " + compoundClassName;
      }
    }

    return className;
  };

  runtimeFn.props = (props) => {
    const result: CSSRule = {};
    for (const [propName, propValue] of Object.entries(props)) {
      const varName =
        config.propVars[propName as keyof PropDefinitionOutput<Props>];

      if (varName !== undefined) {
        result[varName] = propValue as string;
      }
    }
    return result;
  };

  runtimeFn.variants = () => Object.keys(config.variantClassNames);

  runtimeFn.classNames = {
    get base() {
      return config.defaultClassName.split(" ")[0];
    },

    get variants() {
      return mapValues(config.variantClassNames, (classNames) =>
        mapValues(classNames, (className) => className.split(" ")[0])
      ) as RecipeClassNames<Variants>["variants"];
    }
  };

  return runtimeFn;
};

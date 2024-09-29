import deepmerge from "@fastify/deepmerge";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { css, cssVariants } from "../index";
import type { ComplexCSSRule } from "@mincho-js/transform-to-vanilla";

import { createRuntimeFn } from "./createRuntimeFn";
import type {
  PatternOptions,
  PatternResult,
  RuntimeFn,
  VariantGroups,
  VariantDefinitions,
  ToggleVariantMap,
  VariantSelection,
  VariantObjectSelection,
  ConditionalVariants,
  Serializable
} from "./types";
import { mapValues, transformVariantSelection } from "./utils";

const mergeObject = deepmerge();

export function rules<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined
>(
  options: PatternOptions<Variants, ToggleVariants>,
  debugId?: string
): RuntimeFn<ConditionalVariants<Variants, ToggleVariants>> {
  const {
    toggles = {},
    variants = {},
    defaultVariants = {},
    compoundVariants = [],
    base,
    ...baseStyles
  } = options;

  let defaultClassName;

  if (!base || typeof base === "string") {
    const baseClassName = css(baseStyles);
    defaultClassName = base ? `${baseClassName} ${base}` : baseClassName;
  } else {
    defaultClassName = css(
      Array.isArray(base)
        ? [baseStyles, ...base]
        : mergeObject(baseStyles, base),
      debugId
    );
  }

  type PureVariants = Exclude<Variants, undefined>;
  type PureToggleVariants = Exclude<ToggleVariants, undefined>;
  type CombinedVariants = ConditionalVariants<PureVariants, PureToggleVariants>;
  const mergedVariants = mergeObject(
    variants,
    transformToggleVariants(toggles)
  ) as CombinedVariants;
  // @ts-expect-error - Temporarily ignoring the error as the PatternResult type is not fully defined
  const variantClassNames: PatternResult<CombinedVariants>["variantClassNames"] =
    mapValues(mergedVariants, (variantGroup, variantGroupName) =>
      cssVariants(
        variantGroup,
        (styleRule) =>
          typeof styleRule === "string"
            ? [styleRule]
            : (styleRule satisfies ComplexCSSRule),
        debugId
          ? `${debugId}_${String(variantGroupName)}`
          : String(variantGroupName)
      )
    );

  const compounds: Array<[VariantObjectSelection<CombinedVariants>, string]> =
    [];

  for (const { style: theStyle, variants } of compoundVariants) {
    compounds.push([
      transformVariantSelection<CombinedVariants>(
        variants as VariantSelection<CombinedVariants>
      ),
      typeof theStyle === "string"
        ? theStyle
        : css(theStyle, `${debugId}_compound_${compounds.length}`)
    ]);
  }

  const config: PatternResult<CombinedVariants> = {
    defaultClassName,
    variantClassNames,
    defaultVariants,
    compoundVariants: compounds
  };

  return addFunctionSerializer<
    RuntimeFn<ConditionalVariants<Variants, ToggleVariants>>
  >(
    createRuntimeFn(config) as RuntimeFn<
      ConditionalVariants<Variants, ToggleVariants>
    >,
    {
      importPath: "@mincho-js/css/rules/createRuntimeFn",
      importName: "createRuntimeFn",
      args: [config as Serializable]
    }
  );
}

function transformToggleVariants<ToggleVariants extends VariantDefinitions>(
  toggleVariants: ToggleVariants
): ToggleVariantMap<ToggleVariants> {
  const variants: Partial<ToggleVariantMap<ToggleVariants>> = {};

  for (const [variantsName, variantsStyle] of Object.entries(toggleVariants)) {
    // ts(2862) Error: Type 'Partial<ToggleVariantMap<ToggleVariants>>' is generic and can only be indexed for reading.
    // @ts-expect-error - Temporarily ignoring the error
    variants[variantsName] = {
      true: variantsStyle
    };
  }

  return variants as ToggleVariantMap<ToggleVariants>;
}

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
  VariantSelection
} from "./types";
import { mapValues } from "./utils";

const mergeObject = deepmerge();

export function rules<
  Variants extends VariantGroups,
  ToggleVariants extends VariantDefinitions
>(
  options: PatternOptions<Variants, ToggleVariants>,
  debugId?: string
): RuntimeFn<Variants & ToggleVariantMap<ToggleVariants>> {
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

  const mergedVariants = mergeObject(
    variants,
    transformToggleVariants(toggles)
  ) as Variants & ToggleVariantMap<ToggleVariants>;
  // @ts-expect-error - Temporarily ignoring the error as the PatternResult type is not fully defined
  const variantClassNames: PatternResult<
    Variants & ToggleVariantMap<ToggleVariants>
  >["variantClassNames"] = mapValues(
    mergedVariants,
    (variantGroup, variantGroupName) =>
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

  const compounds: Array<
    [VariantSelection<Variants & ToggleVariantMap<ToggleVariants>>, string]
  > = [];

  for (const { style: theStyle, variants } of compoundVariants) {
    compounds.push([
      variants,
      typeof theStyle === "string"
        ? theStyle
        : css(theStyle, `${debugId}_compound_${compounds.length}`)
    ]);
  }

  const config: PatternResult<ToggleVariantMap<ToggleVariants> & Variants> = {
    defaultClassName,
    variantClassNames,
    defaultVariants,
    compoundVariants: compounds
  };

  return addFunctionSerializer(createRuntimeFn(config), {
    importPath: "@mincho-js/css/rules/createRuntimeFn",
    importName: "createRuntimeFn",
    // @ts-expect-error - Mismatch between return type of createRuntimeFn and argument type of addFunctionSerializer
    args: [config]
  });
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

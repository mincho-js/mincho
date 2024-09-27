import deepmerge from "@fastify/deepmerge";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { css, cssVariants } from "../index";

import { createRuntimeFn } from "./createRuntimeFn";
import type {
  PatternOptions,
  PatternResult,
  RuntimeFn,
  VariantGroups,
  VariantSelection
} from "./types";
import { mapValues } from "./utils";

const mergeObject = deepmerge();

export function rules<Variants extends VariantGroups>(
  options: PatternOptions<Variants>,
  debugId?: string
): RuntimeFn<Variants> {
  const {
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

  // @ts-expect-error - Temporarily ignoring the error as the PatternResult type is not fully defined
  const variantClassNames: PatternResult<Variants>["variantClassNames"] =
    mapValues(variants, (variantGroup, variantGroupName) =>
      cssVariants(
        variantGroup,
        (styleRule) =>
          typeof styleRule === "string" ? [styleRule] : styleRule,
        debugId ? `${debugId}_${variantGroupName}` : variantGroupName
      )
    );

  const compounds: Array<[VariantSelection<Variants>, string]> = [];

  for (const { style: theStyle, variants } of compoundVariants) {
    compounds.push([
      variants,
      typeof theStyle === "string"
        ? theStyle
        : css(theStyle, `${debugId}_compound_${compounds.length}`)
    ]);
  }

  const config: PatternResult<Variants> = {
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

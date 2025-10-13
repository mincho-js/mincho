import deepmerge from "@fastify/deepmerge";
import { createVar, fallbackVar } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import type {
  ComplexCSSRule,
  CSSRule,
  PureCSSVarKey
} from "@mincho-js/transform-to-vanilla";

import { css } from "../css/index.js";
import { identifierName, getDebugName, getVarName } from "../utils.js";
import { createRuntimeFn } from "./createRuntimeFn.js";
import type {
  ComplexPropDefinitions,
  ConditionalVariants,
  PatternResult,
  RuntimeFn,
  VariantGroups,
  VariantDefinitions,
  VariantSelection,
  VariantObjectSelection,
  PropDefinition,
  PropDefinitionOutput,
  PropTarget,
  PropVars,
  Serializable,
  VariantStyle,
  RecipeStyleRule
} from "./types.js";
import {
  mapValues,
  transformToggleVariants,
  transformVariantSelection
} from "./utils.js";

// == Compat-specific Types ====================================================
/**
 * Vanilla Extract compatible CompoundVariant
 * Only supports variants-style (object-based) compound variants
 */
export interface CompatCompoundVariant<Variants extends VariantGroups> {
  variants: VariantSelection<Variants>;
  style: RecipeStyleRule;
}

/**
 * Vanilla Extract compatible PatternOptions
 * Only supports array-based compoundVariants
 */
export interface CompatPatternOptions<
  Variants extends VariantGroups | undefined,
  ToggleVariants extends VariantDefinitions | undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined
> extends CSSRule {
  base?: RecipeStyleRule;
  props?: Props;
  toggles?: ToggleVariants;
  variants?: Variants;
  defaultVariants?: VariantSelection<
    ConditionalVariants<Variants, ToggleVariants>
  >;
  compoundVariants?: Array<
    CompatCompoundVariant<ConditionalVariants<Variants, ToggleVariants>>
  >;
}

// == Recipe Impl ==============================================================
const mergeObject = deepmerge();

export function recipe<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  options: CompatPatternOptions<Variants, ToggleVariants, Props>,
  debugId?: string
): RuntimeFn<
  ConditionalVariants<Variants, ToggleVariants>,
  Exclude<Props, undefined>
> {
  const {
    toggles = {},
    variants = {},
    defaultVariants = {},
    compoundVariants = [],
    props = {},
    base,
    ...baseStyles
  } = options;

  type PureProps = Exclude<Props, undefined>;
  const propVars = {} as PropVars<PureProps>;
  const propStyles: CSSRule = {};
  if (Array.isArray(props)) {
    for (const prop of props) {
      if (typeof prop === "string") {
        const debugName = getDebugName(debugId, prop);
        const propVar = createVar(debugName);
        propVars[prop as keyof PropDefinitionOutput<PureProps>] =
          getVarName(propVar);
        setCSSProperty(propStyles, prop, propVar);
      } else {
        processPropObject(prop, propVars, propStyles, debugId);
      }
    }
  } else {
    processPropObject(props, propVars, propStyles, debugId);
  }

  let defaultClassName: string;
  if (!base || typeof base === "string") {
    const baseClassName = css([baseStyles, propStyles], debugId);
    defaultClassName = base ? `${baseClassName} ${base}` : baseClassName;
  } else {
    defaultClassName = css(
      Array.isArray(base)
        ? [baseStyles, ...base, propStyles]
        : [mergeObject(baseStyles, base), propStyles],
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
    mapValues(mergedVariants, (variantGroup, variantGroupName) => {
      // Transform variant values before passing to css.multiple
      const transformedVariants: Record<string | number, ComplexCSSRule> = {};
      for (const key in variantGroup) {
        const styleRule = variantGroup[key];
        transformedVariants[key] =
          typeof styleRule === "string"
            ? [styleRule]
            : (styleRule satisfies ComplexCSSRule);
      }

      return css.multiple(
        transformedVariants,
        getDebugName(debugId, String(variantGroupName))
      );
    });

  const compounds: Array<[VariantObjectSelection<CombinedVariants>, string]> =
    [];

  // Only process array-based compoundVariants (variants-style)
  for (const { style: theStyle, variants } of compoundVariants) {
    compounds.push([
      transformVariantSelection<CombinedVariants>(
        variants as VariantSelection<CombinedVariants>
      ),
      processCompoundStyle(theStyle, debugId, compounds.length)
    ]);
  }

  const config: PatternResult<CombinedVariants, PureProps> = {
    defaultClassName,
    variantClassNames,
    defaultVariants: transformVariantSelection(defaultVariants),
    compoundVariants: compounds,
    propVars
  };

  return addFunctionSerializer<
    RuntimeFn<ConditionalVariants<Variants, ToggleVariants>, PureProps>
  >(
    createRuntimeFn(config) as RuntimeFn<
      ConditionalVariants<Variants, ToggleVariants>,
      PureProps
    >,
    {
      importPath: "@mincho-js/css/rules/createRuntimeFn",
      importName: "createRuntimeFn",
      args: [config as Serializable]
    }
  );
}

// Helper function to safely set properties on a CSSRule
function setCSSProperty(
  styles: CSSRule,
  property: string,
  value: string
): void {
  // @ts-expect-error: Intentionally bypassing type checking for dynamic property assignment
  styles[property] = value;
}

function processPropObject<Target extends PropTarget>(
  props: PropDefinition<Target>,
  propVars: Record<string, PureCSSVarKey>,
  propStyles: CSSRule,
  debugId?: string
) {
  Object.entries(props).forEach(([propName, propValue]) => {
    const debugName = getDebugName(debugId, propName);
    const propVar = createVar(debugName);
    propVars[propName] = getVarName(propVar);

    const isBaseValue = propValue?.base !== undefined;
    propValue?.targets.forEach((target) => {
      setCSSProperty(
        propStyles,
        target,
        isBaseValue ? fallbackVar(propVar, `${propValue.base}`) : propVar
      );
    });
  });
}

function processCompoundStyle(
  style: RecipeStyleRule,
  debugId: string | undefined,
  index: number
): string {
  return typeof style === "string"
    ? style
    : css(style, getDebugName(debugId, `compound_${index}`));
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assert, expect } = import.meta.vitest;

  const debugId = "recipe";
  setFileScope("test-compat");

  describe.concurrent("recipe() - Compat API", () => {
    it("base style", () => {
      const result = recipe({ base: { color: "red" } }, debugId);

      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      expect(result()).toMatch(identifierName(debugId));
    });

    it("base flatten style", () => {
      const result = recipe({ color: "red" }, debugId);

      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(identifierName(debugId));
      expect(result.classNames.base).toMatch(identifierName(debugId));
      expect(result.classNames.variants).toEqual({});
      expect(result.variants()).toEqual([]);
    });

    it("variants", () => {
      const variants = {
        variants: {
          color: {
            brand: { color: "#FFFFA0" },
            accent: { color: "#FFE4B5" }
          } satisfies VariantStyle<"brand" | "accent">,
          size: {
            small: { padding: 12 },
            medium: { padding: 16 },
            large: { padding: 24 }
          } satisfies VariantStyle<"small" | "medium" | "large">,
          outlined: {
            true: { border: "1px solid black" },
            false: { border: "1px solid transparent" }
          } satisfies VariantStyle<"true" | "false">
        }
      } as const;
      const result = recipe(variants, debugId);

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(identifierName(debugId));
      expect(result.classNames.base).toMatch(identifierName(debugId));
      assert.hasAllKeys(result.classNames.variants, [
        "color",
        "size",
        "outlined"
      ]);
      expect(result.variants()).toEqual(["color", "size", "outlined"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.color, ["brand", "accent"]);
      expect(result.classNames.variants.color.brand).toMatch(
        identifierName(`${debugId}_color_brand`)
      );
      expect(result.classNames.variants.color.accent).toMatch(
        identifierName(`${debugId}_color_accent`)
      );

      assert.hasAllKeys(result.classNames.variants.size, [
        "small",
        "medium",
        "large"
      ]);
      expect(result.classNames.variants.size.small).toMatch(
        identifierName(`${debugId}_size_small`)
      );
      expect(result.classNames.variants.size.medium).toMatch(
        identifierName(`${debugId}_size_medium`)
      );
      expect(result.classNames.variants.size.large).toMatch(
        identifierName(`${debugId}_size_large`)
      );

      assert.hasAllKeys(result.classNames.variants.outlined, ["true", "false"]);
      expect(result.classNames.variants.outlined.true).toMatch(
        identifierName(`${debugId}_outlined_true`)
      );
      expect(result.classNames.variants.outlined.false).toMatch(
        identifierName(`${debugId}_outlined_false`)
      );

      // Compose variant className check
      expect(result()).toMatch(identifierName(debugId));
      expect(result({ color: "brand" })).toMatch(
        identifierName(debugId, `${debugId}_color_brand`)
      );
      expect(result({ size: "small" })).toMatch(
        identifierName(debugId, `${debugId}_size_small`)
      );
      expect(result({ outlined: true })).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );
      expect(result(["outlined"])).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );

      expect(result({ color: "brand", size: "small" })).toMatch(
        identifierName(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_size_small`
        )
      );
      expect(result({ size: "small", color: "brand" })).toMatch(
        identifierName(
          debugId,
          `${debugId}_size_small`,
          `${debugId}_color_brand`
        )
      );
      expect(result(["outlined", { color: "brand" }])).toMatch(
        identifierName(
          debugId,
          `${debugId}_outlined_true`,
          `${debugId}_color_brand`
        )
      );
      expect(result([{ color: "brand" }, "outlined"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_outlined_true`
        )
      );

      expect(result([{ color: "brand" }, { color: "accent" }])).toMatch(
        identifierName(debugId, `${debugId}_color_accent`)
      );
      expect(result(["outlined", { outlined: false }])).toMatch(
        identifierName(debugId, `${debugId}_outlined_false`)
      );
      expect(result(["outlined", { outlined: false }, "outlined"])).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );

      // Without debugId
      const resultWithoutDebugId = recipe(variants);
      expect(resultWithoutDebugId({ color: "brand" })).toMatch(
        identifierName(undefined, `color_brand`)
      );
      expect(resultWithoutDebugId({ size: "small" })).toMatch(
        identifierName(undefined, `size_small`)
      );
      expect(resultWithoutDebugId({ outlined: true })).toMatch(
        identifierName(undefined, `outlined_true`)
      );
      expect(resultWithoutDebugId(["outlined"])).toMatch(
        identifierName(undefined, `outlined_true`)
      );
    });

    it("toggle variants", () => {
      const result = recipe(
        {
          toggles: {
            disabled: { textDecoration: "line-through" },
            rounded: { borderRadius: 999 }
          }
        },
        debugId
      );

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(identifierName(debugId));
      expect(result.classNames.base).toMatch(identifierName(debugId));
      assert.hasAllKeys(result.classNames.variants, ["disabled", "rounded"]);
      expect(result.variants()).toEqual(["disabled", "rounded"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.disabled, ["true"]);
      expect(result.classNames.variants.disabled.true).toMatch(
        identifierName(`${debugId}_disabled_true`)
      );

      assert.hasAllKeys(result.classNames.variants.rounded, ["true"]);
      expect(result.classNames.variants.rounded.true).toMatch(
        identifierName(`${debugId}_rounded_true`)
      );

      // Compose variant className check
      expect(result()).toMatch(identifierName(debugId));
      expect(result({ disabled: true })).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result(["disabled"])).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result({ rounded: true })).toMatch(
        identifierName(debugId, `${debugId}_rounded_true`)
      );
      expect(result(["rounded"])).toMatch(
        identifierName(debugId, `${debugId}_rounded_true`)
      );

      expect(result(["disabled", "rounded"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded", "disabled"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_rounded_true`,
          `${debugId}_disabled_true`
        )
      );
    });

    it("defaultVariants", () => {
      const result = recipe(
        {
          defaultVariants: ["disabled"],
          toggles: {
            disabled: { textDecoration: "line-through" },
            rounded: { borderRadius: 999 }
          }
        },
        debugId
      );

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result.classNames.base).toMatch(identifierName(debugId));
      assert.hasAllKeys(result.classNames.variants, ["disabled", "rounded"]);
      expect(result.variants()).toEqual(["disabled", "rounded"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.disabled, ["true"]);
      expect(result.classNames.variants.disabled.true).toMatch(
        identifierName(`${debugId}_disabled_true`)
      );

      assert.hasAllKeys(result.classNames.variants.rounded, ["true"]);
      expect(result.classNames.variants.rounded.true).toMatch(
        identifierName(`${debugId}_rounded_true`)
      );

      // Compose variant className check
      expect(result()).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result({ disabled: true })).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result(["disabled"])).toMatch(
        identifierName(debugId, `${debugId}_disabled_true`)
      );
      expect(result({ rounded: true })).toMatch(
        identifierName(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );

      expect(result(["disabled", "rounded"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded", "disabled"])).toMatch(
        identifierName(
          debugId,
          // disabled: true already exist
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
    });

    it("compoundVariants - variants style (object)", () => {
      const result = recipe(
        {
          variants: {
            color: {
              brand: { color: "#FFFFA0" },
              accent: { color: "#FFE4B5" }
            },
            size: {
              small: { padding: 12 },
              medium: { padding: 16 },
              large: { padding: 24 }
            },
            outlined: {
              true: { border: "1px solid black" },
              false: { border: "1px solid transparent" }
            }
          },
          compoundVariants: [
            {
              variants: ["outlined", { color: "brand" }],
              style: {
                color: "red"
              }
            },
            {
              variants: {
                color: "brand",
                size: "medium",
                outlined: true
              },
              style: {
                color: "red"
              }
            }
          ]
        },
        debugId
      );

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(identifierName(debugId));
      expect(result.classNames.base).toMatch(identifierName(debugId));
      assert.hasAllKeys(result.classNames.variants, [
        "color",
        "size",
        "outlined"
      ]);
      expect(result.variants()).toEqual(["color", "size", "outlined"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.color, ["brand", "accent"]);
      expect(result.classNames.variants.color.brand).toMatch(
        identifierName(`${debugId}_color_brand`)
      );
      expect(result.classNames.variants.color.accent).toMatch(
        identifierName(`${debugId}_color_accent`)
      );

      assert.hasAllKeys(result.classNames.variants.size, [
        "small",
        "medium",
        "large"
      ]);
      expect(result.classNames.variants.size.small).toMatch(
        identifierName(`${debugId}_size_small`)
      );
      expect(result.classNames.variants.size.medium).toMatch(
        identifierName(`${debugId}_size_medium`)
      );
      expect(result.classNames.variants.size.large).toMatch(
        identifierName(`${debugId}_size_large`)
      );

      assert.hasAllKeys(result.classNames.variants.outlined, ["true", "false"]);
      expect(result.classNames.variants.outlined.true).toMatch(
        identifierName(`${debugId}_outlined_true`)
      );
      expect(result.classNames.variants.outlined.false).toMatch(
        identifierName(`${debugId}_outlined_false`)
      );

      // Compose variant className check
      expect(result()).toMatch(identifierName(debugId));
      expect(result({ color: "brand" })).toMatch(
        identifierName(debugId, `${debugId}_color_brand`)
      );
      expect(result({ size: "small" })).toMatch(
        identifierName(debugId, `${debugId}_size_small`)
      );
      expect(result({ outlined: true })).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );
      expect(result(["outlined"])).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );

      expect(result({ color: "brand", size: "small" })).toMatch(
        identifierName(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_size_small`
        )
      );
      expect(result({ size: "small", color: "brand" })).toMatch(
        identifierName(
          debugId,
          `${debugId}_size_small`,
          `${debugId}_color_brand`
        )
      );
      expect(result(["outlined", { color: "brand" }])).toMatch(
        identifierName(
          debugId,
          `${debugId}_outlined_true`,
          `${debugId}_color_brand`,
          // Compound
          `${debugId}_compound_0`
        )
      );
      expect(result([{ color: "brand" }, "outlined"])).toMatch(
        identifierName(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_outlined_true`,
          // Compound
          `${debugId}_compound_0`
        )
      );
      expect(result(["outlined", { color: "brand", size: "medium" }])).toMatch(
        identifierName(
          debugId,
          `${debugId}_outlined_true`,
          `${debugId}_color_brand`,
          `${debugId}_size_medium`,
          // Compound
          `${debugId}_compound_0`,
          `${debugId}_compound_1`
        )
      );

      expect(result([{ color: "brand" }, { color: "accent" }])).toMatch(
        identifierName(debugId, `${debugId}_color_accent`)
      );
      expect(result(["outlined", { outlined: false }])).toMatch(
        identifierName(debugId, `${debugId}_outlined_false`)
      );
      expect(result(["outlined", { outlined: false }, "outlined"])).toMatch(
        identifierName(debugId, `${debugId}_outlined_true`)
      );
    });

    it("compoundVariants - variants style (array)", () => {
      const result = recipe(
        {
          toggles: {
            outlined: { border: "1px solid" }
          },
          variants: {
            color: {
              brand: { color: "#FFFFA0" },
              accent: { color: "#FFE4B5" }
            }
          },
          compoundVariants: [
            {
              variants: ["outlined", { color: "brand" }],
              style: {
                color: "red"
              }
            }
          ]
        },
        debugId
      );

      expect(result(["outlined", { color: "brand" }])).toMatch(
        identifierName(
          debugId,
          `${debugId}_outlined_true`,
          `${debugId}_color_brand`,
          `${debugId}_compound_0`
        )
      );
    });

    it("Props", () => {
      const result1 = recipe(
        {
          props: ["color", "background"]
        },
        debugId
      );

      assert.isFunction(result1);
      assert.hasAllKeys(result1, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result1.classNames, ["base", "variants"]);
      assert.isFunction(result1.props);

      Object.entries(
        result1.props({
          color: "red"
        })
      ).forEach(([varName, propValue]) => {
        // Partial
        expect(propValue).toBe("red");
        expect(varName).toMatch(identifierName(`--${debugId}_color`));
      });
      Object.entries(
        result1.props({
          color: "red",
          background: "blue"
        })
      ).forEach(([varName, propValue]) => {
        // Fully
        expect(propValue).toBeOneOf(["red", "blue"]);

        if (propValue === "red") {
          expect(varName).toMatch(identifierName(`--${debugId}_color`));
        }
        if (propValue === "blue") {
          expect(varName).toMatch(identifierName(`--${debugId}_background`));
        }
      });
      Object.entries(
        result1.props({
          // @ts-expect-error Not valid property
          "something-else": "red"
        })
      ).forEach(([varName, propValue]) => {
        expect(varName).toBeUndefined();
        expect(propValue).toBeUndefined();
      });

      const result2 = recipe(
        {
          props: {
            rounded: { targets: ["borderRadius"] },
            size: { base: 0, targets: ["padding", "margin"] }
          }
        },
        debugId
      );
      Object.entries(
        result2.props({
          rounded: "999px",
          size: "2rem"
        })
      ).forEach(([varName, propValue]) => {
        // Fully
        expect(propValue).toBeOneOf(["999px", "2rem"]);

        if (propValue === "999px") {
          expect(varName).toMatch(identifierName(`--${debugId}_rounded`));
        }
        if (propValue === "2rem") {
          expect(varName).toMatch(identifierName(`--${debugId}_size`));
        }
      });

      const result3 = recipe(
        {
          props: [
            "color",
            "background",
            {
              rounded: { targets: ["borderRadius"] },
              size: { base: 0, targets: ["padding", "margin"] }
            }
          ]
        },
        debugId
      );
      Object.entries(
        result3.props({
          color: "red",
          background: "blue",
          rounded: "999px",
          size: "2rem"
        })
      ).forEach(([varName, propValue]) => {
        // Fully
        expect(propValue).toBeOneOf(["red", "blue", "999px", "2rem"]);

        if (propValue === "red") {
          expect(varName).toMatch(identifierName(`--${debugId}_color`));
        }
        if (propValue === "blue") {
          expect(varName).toMatch(identifierName(`--${debugId}_background`));
        }
        if (propValue === "999px") {
          expect(varName).toMatch(identifierName(`--${debugId}_rounded`));
        }
        if (propValue === "2rem") {
          expect(varName).toMatch(identifierName(`--${debugId}_size`));
        }
      });
    });
  });
}

import deepmerge from "@fastify/deepmerge";
import { createVar, fallbackVar } from "@vanilla-extract/css";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type {
  ComplexCSSRule,
  CSSRule,
  PureCSSVarKey
} from "@mincho-js/transform-to-vanilla";

import { css, cssVariants } from "../css/index.js";
import { className, getDebugName, getVarName } from "../utils.js";
import { createRuntimeFn } from "./createRuntimeFn.js";
import type {
  ComplexPropDefinitions,
  ConditionalVariants,
  PatternOptions,
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
  VariantStringMap,
  VariantStyle
} from "./types.js";
import {
  mapValues,
  transformToggleVariants,
  transformVariantSelection
} from "./utils.js";

const mergeObject = deepmerge();

// Helper function to safely set properties on a CSSRule
function setCSSProperty(
  styles: CSSRule,
  property: string,
  value: string
): void {
  // @ts-expect-error: Intentionally bypassing type checking for dynamic property assignment
  styles[property] = value;
}

/**
 * Creates a runtime CSS style function supporting variants, toggle variants, compound variants, and CSS property variables.
 *
 * @param options - Pattern options defining base styles, variants, toggles, compound variants, default variants, and props
 * @param debugId - Optional identifier used for debugging and naming generated classes and variables
 * @returns A runtime function that generates class names and CSS variable mappings based on selected variants and props
 */
export function rules<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  options: PatternOptions<Variants, ToggleVariants, Props>,
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
    mapValues(mergedVariants, (variantGroup, variantGroupName) =>
      cssVariants(
        variantGroup,
        (styleRule) =>
          typeof styleRule === "string"
            ? [styleRule]
            : (styleRule satisfies ComplexCSSRule),
        getDebugName(debugId, String(variantGroupName))
      )
    );

  const compounds: Array<[VariantObjectSelection<CombinedVariants>, string]> =
    [];

  if (typeof compoundVariants === "function") {
    const variantConditions = mapValues(
      mergedVariants,
      (variantGroup, variantName) =>
        mapValues(variantGroup, (_, optionKey) => ({
          [variantName]:
            optionKey === "true"
              ? true
              : optionKey === "false"
                ? false
                : optionKey
        }))
    ) as VariantStringMap<CombinedVariants>;

    const compoundRules = compoundVariants(variantConditions);
    compoundRules.forEach((rule, index) => {
      const variants = rule.condition.reduce((acc, condition) => {
        return {
          ...acc,
          ...condition
        };
      }, {});

      compounds.push([
        transformVariantSelection<CombinedVariants>(variants),
        processCompoundStyle(rule.style, debugId, index)
      ]);
    });
  } else {
    for (const { style: theStyle, variants } of compoundVariants) {
      compounds.push([
        transformVariantSelection<CombinedVariants>(
          variants as VariantSelection<CombinedVariants>
        ),
        processCompoundStyle(theStyle, debugId, compounds.length)
      ]);
    }
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

/**
 * Processes a prop definition object to generate CSS variables and assign them to specified CSS properties.
 *
 * For each prop, creates a CSS variable (optionally with a debug name), stores its key in `propVars`, and sets the variable as the value for each target CSS property in `propStyles`. If a base value is provided, uses it as a fallback.
 *
 * @param props - The prop definitions mapping prop names to their configuration
 * @param propVars - Object to store generated CSS variable keys for each prop
 * @param propStyles - CSS rule object to which the variables are assigned as property values
 * @param debugId - Optional identifier used for debugging and variable naming
 */
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
  style: ComplexCSSRule | string,
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

  const debugId = "myCSS";
  setFileScope("test");

  describe.concurrent("rules()", () => {
    it("base style", () => {
      const result = rules({ base: { color: "red" } }, debugId);

      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      expect(result.classNames.variants).toEqual({});
      expect(result.variants()).toEqual([]);
    });

    it("base flatten style", () => {
      const result = rules({ color: "red" }, debugId);

      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
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
      const result = rules(variants, debugId);

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      assert.hasAllKeys(result.classNames.variants, [
        "color",
        "size",
        "outlined"
      ]);
      expect(result.variants()).toEqual(["color", "size", "outlined"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.color, ["brand", "accent"]);
      expect(result.classNames.variants.color.brand).toMatch(
        className(`${debugId}_color_brand`)
      );
      expect(result.classNames.variants.color.accent).toMatch(
        className(`${debugId}_color_accent`)
      );

      assert.hasAllKeys(result.classNames.variants.size, [
        "small",
        "medium",
        "large"
      ]);
      expect(result.classNames.variants.size.small).toMatch(
        className(`${debugId}_size_small`)
      );
      expect(result.classNames.variants.size.medium).toMatch(
        className(`${debugId}_size_medium`)
      );
      expect(result.classNames.variants.size.large).toMatch(
        className(`${debugId}_size_large`)
      );

      assert.hasAllKeys(result.classNames.variants.outlined, ["true", "false"]);
      expect(result.classNames.variants.outlined.true).toMatch(
        className(`${debugId}_outlined_true`)
      );
      expect(result.classNames.variants.outlined.false).toMatch(
        className(`${debugId}_outlined_false`)
      );

      // Compose variant className check
      expect(result()).toMatch(className(debugId));
      expect(result({ color: "brand" })).toMatch(
        className(debugId, `${debugId}_color_brand`)
      );
      expect(result({ size: "small" })).toMatch(
        className(debugId, `${debugId}_size_small`)
      );
      expect(result({ outlined: true })).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );
      expect(result(["outlined"])).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );

      expect(result({ color: "brand", size: "small" })).toMatch(
        className(debugId, `${debugId}_color_brand`, `${debugId}_size_small`)
      );
      expect(result({ size: "small", color: "brand" })).toMatch(
        className(debugId, `${debugId}_size_small`, `${debugId}_color_brand`)
      );
      expect(result(["outlined", { color: "brand" }])).toMatch(
        className(debugId, `${debugId}_outlined_true`, `${debugId}_color_brand`)
      );
      expect(result([{ color: "brand" }, "outlined"])).toMatch(
        className(debugId, `${debugId}_color_brand`, `${debugId}_outlined_true`)
      );

      expect(result([{ color: "brand" }, { color: "accent" }])).toMatch(
        className(debugId, `${debugId}_color_accent`)
      );
      expect(result(["outlined", { outlined: false }])).toMatch(
        className(debugId, `${debugId}_outlined_false`)
      );
      expect(result(["outlined", { outlined: false }, "outlined"])).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );

      // Without debugId
      const resultWithoutDebugId = rules(variants);
      expect(resultWithoutDebugId({ color: "brand" })).toMatch(
        className(undefined, `color_brand`)
      );
      expect(resultWithoutDebugId({ size: "small" })).toMatch(
        className(undefined, `size_small`)
      );
      expect(resultWithoutDebugId({ outlined: true })).toMatch(
        className(undefined, `outlined_true`)
      );
      expect(resultWithoutDebugId(["outlined"])).toMatch(
        className(undefined, `outlined_true`)
      );
    });

    it("toggle variants", () => {
      const result = rules(
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

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      assert.hasAllKeys(result.classNames.variants, ["disabled", "rounded"]);
      expect(result.variants()).toEqual(["disabled", "rounded"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.disabled, ["true"]);
      expect(result.classNames.variants.disabled.true).toMatch(
        className(`${debugId}_disabled_true`)
      );

      assert.hasAllKeys(result.classNames.variants.rounded, ["true"]);
      expect(result.classNames.variants.rounded.true).toMatch(
        className(`${debugId}_rounded_true`)
      );

      // Compose variant className check
      expect(result()).toMatch(className(debugId));
      expect(result({ disabled: true })).toMatch(
        className(debugId, `${debugId}_disabled_true`)
      );
      expect(result(["disabled"])).toMatch(
        className(debugId, `${debugId}_disabled_true`)
      );
      expect(result({ rounded: true })).toMatch(
        className(debugId, `${debugId}_rounded_true`)
      );
      expect(result(["rounded"])).toMatch(
        className(debugId, `${debugId}_rounded_true`)
      );

      expect(result(["disabled", "rounded"])).toMatch(
        className(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded", "disabled"])).toMatch(
        className(
          debugId,
          `${debugId}_rounded_true`,
          `${debugId}_disabled_true`
        )
      );
    });

    it("defaultVariants", () => {
      const result = rules(
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

      expect(result()).toMatch(className(debugId, `${debugId}_disabled_true`));
      expect(result.classNames.base).toMatch(className(debugId));
      assert.hasAllKeys(result.classNames.variants, ["disabled", "rounded"]);
      expect(result.variants()).toEqual(["disabled", "rounded"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.disabled, ["true"]);
      expect(result.classNames.variants.disabled.true).toMatch(
        className(`${debugId}_disabled_true`)
      );

      assert.hasAllKeys(result.classNames.variants.rounded, ["true"]);
      expect(result.classNames.variants.rounded.true).toMatch(
        className(`${debugId}_rounded_true`)
      );

      // Compose variant className check
      expect(result()).toMatch(className(debugId, `${debugId}_disabled_true`));
      expect(result({ disabled: true })).toMatch(
        className(debugId, `${debugId}_disabled_true`)
      );
      expect(result(["disabled"])).toMatch(
        className(debugId, `${debugId}_disabled_true`)
      );
      expect(result({ rounded: true })).toMatch(
        className(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded"])).toMatch(
        className(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );

      expect(result(["disabled", "rounded"])).toMatch(
        className(
          debugId,
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
      expect(result(["rounded", "disabled"])).toMatch(
        className(
          debugId,
          // disabled: true already exist
          `${debugId}_disabled_true`,
          `${debugId}_rounded_true`
        )
      );
    });

    it("compoundVariants", () => {
      const result = rules(
        {
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
          ],
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
          }
        },
        debugId
      );

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);
      assert.isFunction(result.props);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      assert.hasAllKeys(result.classNames.variants, [
        "color",
        "size",
        "outlined"
      ]);
      expect(result.variants()).toEqual(["color", "size", "outlined"]);

      // Each variant className check
      assert.hasAllKeys(result.classNames.variants.color, ["brand", "accent"]);
      expect(result.classNames.variants.color.brand).toMatch(
        className(`${debugId}_color_brand`)
      );
      expect(result.classNames.variants.color.accent).toMatch(
        className(`${debugId}_color_accent`)
      );

      assert.hasAllKeys(result.classNames.variants.size, [
        "small",
        "medium",
        "large"
      ]);
      expect(result.classNames.variants.size.small).toMatch(
        className(`${debugId}_size_small`)
      );
      expect(result.classNames.variants.size.medium).toMatch(
        className(`${debugId}_size_medium`)
      );
      expect(result.classNames.variants.size.large).toMatch(
        className(`${debugId}_size_large`)
      );

      assert.hasAllKeys(result.classNames.variants.outlined, ["true", "false"]);
      expect(result.classNames.variants.outlined.true).toMatch(
        className(`${debugId}_outlined_true`)
      );
      expect(result.classNames.variants.outlined.false).toMatch(
        className(`${debugId}_outlined_false`)
      );

      // Compose variant className check
      expect(result()).toMatch(className(debugId));
      expect(result({ color: "brand" })).toMatch(
        className(debugId, `${debugId}_color_brand`)
      );
      expect(result({ size: "small" })).toMatch(
        className(debugId, `${debugId}_size_small`)
      );
      expect(result({ outlined: true })).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );
      expect(result(["outlined"])).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );

      expect(result({ color: "brand", size: "small" })).toMatch(
        className(debugId, `${debugId}_color_brand`, `${debugId}_size_small`)
      );
      expect(result({ size: "small", color: "brand" })).toMatch(
        className(debugId, `${debugId}_size_small`, `${debugId}_color_brand`)
      );
      expect(result(["outlined", { color: "brand" }])).toMatch(
        className(
          debugId,
          `${debugId}_outlined_true`,
          `${debugId}_color_brand`,
          // Compound
          `${debugId}_compound_0`
        )
      );
      expect(result([{ color: "brand" }, "outlined"])).toMatch(
        className(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_outlined_true`,
          // Compound
          `${debugId}_compound_0`
        )
      );
      expect(result(["outlined", { color: "brand", size: "medium" }])).toMatch(
        className(
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
        className(debugId, `${debugId}_color_accent`)
      );
      expect(result(["outlined", { outlined: false }])).toMatch(
        className(debugId, `${debugId}_outlined_false`)
      );
      expect(result(["outlined", { outlined: false }, "outlined"])).toMatch(
        className(debugId, `${debugId}_outlined_true`)
      );
    });

    it("function-based compoundVariants", () => {
      const variants = {
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
      } as const;

      // Test variant conditions generation
      const result = rules(
        {
          variants,
          compoundVariants: ({ color, size }) => {
            return [
              {
                condition: [color.brand, size.small],
                style: { fontSize: 16 }
              }
            ];
          }
        },
        debugId
      );

      // Test variant transformation
      expect(result({ color: "brand", size: "small" })).toMatch(
        className(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_size_small`,
          `${debugId}_compound_0`
        )
      );

      // Test multiple conditions
      const resultMultiple = rules(
        {
          variants,
          compoundVariants: ({ color, size, outlined }) => [
            {
              condition: [color.brand, size.small],
              style: { fontSize: 16 }
            },
            {
              condition: [color.accent, outlined.true],
              style: { opacity: 0.8 }
            }
          ]
        },
        debugId
      );

      // Test multiple compounds applying correctly
      expect(
        resultMultiple({ color: "brand", size: "small", outlined: true })
      ).toMatch(
        className(
          debugId,
          `${debugId}_color_brand`,
          `${debugId}_size_small`,
          `${debugId}_outlined_true`,
          `${debugId}_compound_0`
        )
      );

      // Test variant string to boolean conversion
      const resultBoolean = rules(
        {
          variants,
          compoundVariants: ({ outlined }) => [
            {
              condition: [outlined.true],
              style: { opacity: 0.8 }
            }
          ]
        },
        debugId
      );
      expect(resultBoolean({ outlined: true })).toMatch(
        className(debugId, `${debugId}_outlined_true`, `${debugId}_compound_0`)
      );

      // Test empty conditions
      const resultEmpty = rules(
        {
          variants,
          compoundVariants: () => []
        },
        debugId
      );
      expect(resultEmpty({ color: "brand" })).toMatch(
        className(debugId, `${debugId}_color_brand`)
      );
    });

    it("Props", () => {
      const result1 = rules(
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
        expect(varName).toMatch(className(`--${debugId}_color`));
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
          expect(varName).toMatch(className(`--${debugId}_color`));
        }
        if (propValue === "blue") {
          expect(varName).toMatch(className(`--${debugId}_background`));
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

      const result2 = rules(
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
          expect(varName).toMatch(className(`--${debugId}_rounded`));
        }
        if (propValue === "2rem") {
          expect(varName).toMatch(className(`--${debugId}_size`));
        }
      });

      const result3 = rules(
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
          expect(varName).toMatch(className(`--${debugId}_color`));
        }
        if (propValue === "blue") {
          expect(varName).toMatch(className(`--${debugId}_background`));
        }
        if (propValue === "999px") {
          expect(varName).toMatch(className(`--${debugId}_rounded`));
        }
        if (propValue === "2rem") {
          expect(varName).toMatch(className(`--${debugId}_size`));
        }
      });
    });
  });
}

import deepmerge from "@fastify/deepmerge";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type { ComplexCSSRule } from "@mincho-js/transform-to-vanilla";

import { css, cssVariants } from "../css";
import { className } from "../utils";
import { createRuntimeFn } from "./createRuntimeFn";
import type {
  PatternOptions,
  PatternResult,
  RuntimeFn,
  VariantGroups,
  VariantDefinitions,
  VariantSelection,
  VariantObjectSelection,
  ComplexPropDefinitions,
  PropTarget,
  ConditionalVariants,
  Serializable
} from "./types";
import {
  mapValues,
  transformVariantSelection,
  transformToggleVariants
} from "./utils";

const mergeObject = deepmerge();

export function rules<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  options: PatternOptions<Variants, ToggleVariants, Props>,
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

  let defaultClassName: string;
  if (!base || typeof base === "string") {
    const baseClassName = css(baseStyles, debugId);
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
    defaultVariants: transformVariantSelection(defaultVariants),
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
export const recipe = rules;

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
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      expect(result.classNames.variants).toEqual({});
      expect(result.variants()).toEqual([]);
    });

    it("base flatten style", () => {
      const result = rules({ color: "red" }, debugId);

      assert.isFunction(result);
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

      expect(result()).toMatch(className(debugId));
      expect(result.classNames.base).toMatch(className(debugId));
      expect(result.classNames.variants).toEqual({});
      expect(result.variants()).toEqual([]);
    });

    it("variants", () => {
      const result = rules(
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
          }
        },
        debugId
      );

      // Base check
      assert.isFunction(result);
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

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
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

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
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

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
      assert.hasAllKeys(result, ["variants", "classNames"]);
      assert.hasAllKeys(result.classNames, ["base", "variants"]);

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
  });
}

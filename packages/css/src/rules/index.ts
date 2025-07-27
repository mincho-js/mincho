import deepmerge from "@fastify/deepmerge";
import { createVar, fallbackVar } from "@vanilla-extract/css";
import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type {
  ComplexCSSRule,
  CSSRule,
  PureCSSVarKey
} from "@mincho-js/transform-to-vanilla";

import { css } from "../css/index.js";
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
  VariantStyle,
  RecipeStyleRule
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

export function rulesImpl<
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
      css.multiple(
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

// Improved type-safe transformations that preserve pattern structure
type RuntimeFnFromPatternOptions<Options> =
  Options extends PatternOptions<
    infer Variants extends VariantGroups | undefined,
    infer ToggleVariants extends VariantDefinitions | undefined,
    infer Props extends ComplexPropDefinitions<PropTarget> | undefined
  >
    ? RuntimeFn<
        ConditionalVariants<Variants, ToggleVariants>,
        Exclude<Props, undefined>
      >
    : never;

type TransformPatternMap<
  T extends Record<
    string | number,
    PatternOptions<
      VariantGroups | undefined,
      VariantDefinitions | undefined,
      ComplexPropDefinitions<PropTarget> | undefined
    >
  >
> = {
  [K in keyof T]: RuntimeFnFromPatternOptions<T[K]>;
};

type TransformDataMapping<
  Data extends Record<string | number, unknown>,
  MapData extends (
    value: Data[keyof Data],
    key: keyof Data
  ) => PatternOptions<
    VariantGroups | undefined,
    VariantDefinitions | undefined,
    ComplexPropDefinitions<PropTarget> | undefined
  >
> = {
  [K in keyof Data]: MapData extends (value: Data[K], key: K) => infer Options
    ? RuntimeFnFromPatternOptions<Options>
    : RuntimeFnFromPatternOptions<ReturnType<MapData>>;
};

export function rulesMultiple<
  PatternMap extends Record<
    string | number,
    PatternOptions<
      VariantGroups | undefined,
      VariantDefinitions | undefined,
      ComplexPropDefinitions<PropTarget> | undefined
    >
  >
>(patternMap: PatternMap, debugId?: string): TransformPatternMap<PatternMap>;
export function rulesMultiple<
  Data extends Record<string | number, unknown>,
  MapData extends (
    value: Data[keyof Data],
    key: keyof Data
  ) => PatternOptions<
    VariantGroups | undefined,
    VariantDefinitions | undefined,
    ComplexPropDefinitions<PropTarget> | undefined
  >
>(
  data: Data,
  mapData: MapData,
  debugId?: string
): TransformDataMapping<Data, MapData>;
export function rulesMultiple<
  PatternMap extends Record<
    string | number,
    PatternOptions<
      VariantGroups | undefined,
      VariantDefinitions | undefined,
      ComplexPropDefinitions<PropTarget> | undefined
    >
  >,
  Data extends Record<string | number, unknown>,
  MapData extends (
    value: unknown,
    key: string | number | symbol
  ) => PatternOptions<
    VariantGroups | undefined,
    VariantDefinitions | undefined,
    ComplexPropDefinitions<PropTarget> | undefined
  >
>(
  patternMapOrData: PatternMap | Data,
  mapDataOrDebugId?: MapData | string,
  debugId?: string
): TransformPatternMap<PatternMap> | TransformDataMapping<Data, MapData> {
  if (isMapDataFunction(mapDataOrDebugId)) {
    const data = patternMapOrData as Data;
    const mapData = mapDataOrDebugId;
    return processMultipleRules(data, mapData, debugId) as TransformDataMapping<
      Data,
      MapData
    >;
  } else {
    const patternMap = patternMapOrData as PatternMap;
    const debugId = mapDataOrDebugId;
    return processMultipleRules(
      patternMap,
      (pattern) => pattern,
      debugId
    ) as TransformPatternMap<PatternMap>;
  }
}

function isMapDataFunction<
  Data extends Record<string | number, unknown>,
  Key extends keyof Data,
  MapData extends (
    value: Data[Key],
    key: Key
  ) => PatternOptions<
    VariantGroups | undefined,
    VariantDefinitions | undefined,
    ComplexPropDefinitions<PropTarget> | undefined
  >
>(mapDataOrDebugId?: MapData | string): mapDataOrDebugId is MapData {
  return typeof mapDataOrDebugId === "function";
}
function processMultipleRules<
  T,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  items: Record<string | number, T>,
  transformItem: (
    value: T,
    key: string | number
  ) => PatternOptions<Variants, ToggleVariants, Props>,
  debugId?: string
): Record<
  string | number,
  RuntimeFn<
    ConditionalVariants<Variants, ToggleVariants>,
    Exclude<Props, undefined>
  >
> {
  const patternsMap: Record<
    string | number,
    RuntimeFn<
      ConditionalVariants<Variants, ToggleVariants>,
      Exclude<Props, undefined>
    >
  > = {};

  for (const key in items) {
    const pattern = transformItem(items[key], key);
    patternsMap[key] = rulesImpl(pattern, getDebugName(debugId, key));
  }

  return patternsMap;
}

function rulesRaw<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(options: PatternOptions<Variants, ToggleVariants, Props>) {
  return options;
}

export const rules = Object.assign(rulesImpl, {
  multiple: rulesMultiple,
  raw: rulesRaw
});

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
  const { describe, it, assert, expect, assertType } = import.meta.vitest;

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

  describe.concurrent("rules.raw()", () => {
    it("handles simple Rule properties", () => {
      const ruleObj1 = rules.raw({
        base: { color: "red" }
      });
      assertType<PatternOptions<undefined, undefined, undefined>>(ruleObj1);
      expect(ruleObj1).toStrictEqual({
        base: { color: "red" }
      });
      rules(ruleObj1); // Ensure it can be used with rules()

      const ruleObj2 = rules.raw({
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
      });
      assertType<
        PatternOptions<
          {
            color: {
              brand: { color: "#FFFFA0" };
              accent: { color: "#FFE4B5" };
            };
            size: {
              small: { padding: number };
              medium: { padding: number };
              large: { padding: number };
            };
            outlined: {
              true: { border: "1px solid black" };
              false: { border: "1px solid transparent" };
            };
          },
          undefined,
          undefined
        >
      >(ruleObj2);
      expect(ruleObj2).toStrictEqual({
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
      });
      rules(ruleObj2); // Ensure it can be used with rules()

      const ruleObj3 = rules.raw({
        toggles: {
          disabled: { textDecoration: "line-through" },
          rounded: { borderRadius: 999 }
        }
      });
      assertType<
        PatternOptions<
          undefined,
          {
            disabled: { textDecoration: "line-through" };
            rounded: { borderRadius: number };
          },
          undefined
        >
      >(ruleObj3);
      expect(ruleObj3).toStrictEqual({
        toggles: {
          disabled: { textDecoration: "line-through" },
          rounded: { borderRadius: 999 }
        }
      });
      rules(ruleObj3); // Ensure it can be used with rules()

      const ruleObj4 = rules.raw({
        props: [
          "color",
          "background",
          {
            rounded: { targets: ["borderRadius"] },
            size: { base: 0, targets: ["padding", "margin"] }
          }
        ]
      });
      assertType<
        PatternOptions<
          undefined,
          undefined,
          Array<
            | "color"
            | "background"
            | {
                rounded: { targets: Array<"borderRadius"> };
                size: { base: number; targets: Array<"padding" | "margin"> };
              }
          >
        >
      >(ruleObj4);
      expect(ruleObj4).toStrictEqual({
        props: [
          "color",
          "background",
          {
            rounded: { targets: ["borderRadius"] },
            size: { base: 0, targets: ["padding", "margin"] }
          }
        ]
      });
      rules(ruleObj4); // Ensure it can be used with rules()
    });
  });

  describe.concurrent("rules.multiple()", () => {
    it("Empty pattern map", () => {
      const result = rules.multiple({}, debugId);

      assert.isEmpty(result);
      expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it("Static pattern map", () => {
      const result = rules.multiple(
        {
          button: {
            base: { padding: 12 },
            variants: {
              variant: {
                primary: { background: "blue" },
                secondary: { background: "gray" }
              }
            }
          },
          input: {
            base: { padding: 8 },
            variants: {
              state: {
                error: { borderColor: "red" },
                success: { borderColor: "green" }
              }
            }
          }
        },
        debugId
      );

      assert.hasAllKeys(result, ["button", "input"]);

      // Each result should be a function (RuntimeFn)
      assert.isFunction(result.button);
      assert.isFunction(result.input);

      // Check button pattern
      assert.hasAllKeys(result.button, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.button.classNames, ["base", "variants"]);
      expect(result.button()).toMatch(className(`${debugId}_button`));
      expect(result.button.classNames.base).toMatch(
        className(`${debugId}_button`)
      );
      assert.hasAllKeys(result.button.classNames.variants, ["variant"]);
      assert.hasAllKeys(result.button.classNames.variants.variant, [
        "primary",
        "secondary"
      ]);

      // Check input pattern
      assert.hasAllKeys(result.input, ["props", "variants", "classNames"]);
      assert.hasAllKeys(result.input.classNames, ["base", "variants"]);
      expect(result.input()).toMatch(className(`${debugId}_input`));
      expect(result.input.classNames.base).toMatch(
        className(`${debugId}_input`)
      );
      assert.hasAllKeys(result.input.classNames.variants, ["state"]);
      assert.hasAllKeys(result.input.classNames.variants.state, [
        "error",
        "success"
      ]);

      // Test usage
      expect(result.button({ variant: "primary" })).toMatch(
        className(`${debugId}_button`, `${debugId}_button_variant_primary`)
      );
      expect(result.input({ state: "error" })).toMatch(
        className(`${debugId}_input`, `${debugId}_input_state_error`)
      );
    });

    it("Data mapping with theme variations", () => {
      const result = rules.multiple(
        {
          light: { bg: "#ffffff", text: "#000000" },
          dark: { bg: "#1a1a1a", text: "#ffffff" }
        },
        (colors, _themeName) => ({
          base: {
            backgroundColor: colors.bg,
            color: colors.text
          },
          variants: {
            emphasis: {
              subtle: { opacity: 0.7 },
              strong: { fontWeight: "bold" }
            }
          }
        }),
        debugId
      );

      assert.hasAllKeys(result, ["light", "dark"]);

      // Each result should be a function (RuntimeFn)
      assert.isFunction(result.light);
      assert.isFunction(result.dark);

      // Check light theme pattern
      assert.hasAllKeys(result.light, ["props", "variants", "classNames"]);
      expect(result.light()).toMatch(className(`${debugId}_light`));
      assert.hasAllKeys(result.light.classNames.variants, ["emphasis"]);
      assert.hasAllKeys(result.light.classNames.variants.emphasis, [
        "subtle",
        "strong"
      ]);

      // Check dark theme pattern
      assert.hasAllKeys(result.dark, ["props", "variants", "classNames"]);
      expect(result.dark()).toMatch(className(`${debugId}_dark`));
      assert.hasAllKeys(result.dark.classNames.variants, ["emphasis"]);
      assert.hasAllKeys(result.dark.classNames.variants.emphasis, [
        "subtle",
        "strong"
      ]);

      // Test usage
      expect(result.light({ emphasis: "strong" })).toMatch(
        className(`${debugId}_light`, `${debugId}_light_emphasis_strong`)
      );
      expect(result.dark({ emphasis: "subtle" })).toMatch(
        className(`${debugId}_dark`, `${debugId}_dark_emphasis_subtle`)
      );
    });

    it("Size system patterns", () => {
      const result = rules.multiple(
        { xs: 4, sm: 8, md: 16 },
        (spacing, _size) => ({
          variants: {
            direction: {
              all: { padding: spacing },
              horizontal: { paddingLeft: spacing, paddingRight: spacing }
            }
          }
        }),
        debugId
      );

      assert.hasAllKeys(result, ["xs", "sm", "md"]);

      // Each result should be a function (RuntimeFn)
      assert.isFunction(result.xs);
      assert.isFunction(result.sm);
      assert.isFunction(result.md);

      // Test usage
      expect(result.md({ direction: "horizontal" })).toMatch(
        className(`${debugId}_md`, `${debugId}_md_direction_horizontal`)
      );
    });
  });
}

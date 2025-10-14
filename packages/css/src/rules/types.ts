import type {
  PureCSSVarKey,
  ComplexCSSRule,
  CSSRule,
  ResolvedProperties,
  NonNullableString
} from "@mincho-js/transform-to-vanilla";
import type { Resolve } from "../types.js";
import type { CSSRuleWith } from "../css/types.js";

export type ResolveComplex<T> =
  T extends Array<infer U> ? Array<Resolve<U>> : Resolve<T>;
type RemoveUndefined<T> = T extends undefined ? never : T;
export type RemoveUndefinedFromIntersection<T> = {
  [K in keyof T]: RemoveUndefined<T[K]>;
}[keyof T];

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

type Primitive = string | number | boolean | null | undefined;
export type Serializable =
  | {
      [Key in string | number]: Primitive | Serializable;
    }
  | ReadonlyArray<Primitive | Serializable>;

export type RecipeStyleRule = ComplexCSSRule | string;

export type VariantStyle<
  VariantNames extends string,
  CssRule extends RecipeStyleRule = RecipeStyleRule
> = {
  [VariantName in VariantNames]: CssRule extends CSSRule
    ? CSSRuleWith<CssRule>
    : CssRule;
};

// Same of VariantMap but for fast type checking
export type VariantDefinitions = Record<string, RecipeStyleRule>;

type BooleanMap<T> = T extends "true" | "false" ? boolean : T;
export type ToggleVariantMap<ToggleVariants extends VariantDefinitions> = {
  [VariantGroup in keyof ToggleVariants]: {
    true: ToggleVariants[VariantGroup];
  };
};

export type VariantGroups = Record<string, VariantDefinitions>;
export type VariantObjectSelection<Variants extends VariantGroups> = {
  [VariantGroup in keyof Variants]?:
    | BooleanMap<keyof Variants[VariantGroup]>
    | undefined;
};
export type VariantToggleSelection<Variants extends VariantGroups> = {
  [VariantGroup in keyof Variants]: keyof Variants[VariantGroup] extends
    | "true"
    | "false"
    ? VariantGroup
    : never;
}[keyof Variants];
export type VariantSelection<Variants extends VariantGroups> =
  | VariantObjectSelection<Variants>
  | Array<VariantToggleSelection<Variants> | VariantObjectSelection<Variants>>;

export type VariantsClassNames<Variants extends VariantGroups> = {
  [P in keyof Variants]: {
    [PP in keyof Variants[P]]: string;
  };
};

export type PropTarget = keyof ResolvedProperties;

export type ComplexPropDefinitions<PropKeys extends PropTarget | undefined> =
  | PropDefinition<PropKeys>
  | Array<PropKeys | PropDefinition<PropKeys>>;
export type PropDefinition<PropKeys extends PropTarget | undefined> = {
  [Key in NonNullableString | PropTarget]?: {
    base?: ResolvedProperties[Exclude<PropKeys, undefined>];
    targets: PropKeys[];
  };
};

export type PropDefinitionOutput<
  T extends ComplexPropDefinitions<PropTarget | undefined>
> = UnionToIntersection<
  T extends unknown[]
    ? PropDefinitionOutputElement<T[number]>
    : PropDefinitionOutputElement<T>
>;
type PropDefinitionOutputElement<DefinitionElement> =
  DefinitionElement extends string
    ? HandlePropTarget<DefinitionElement>
    : DefinitionElement extends { [key: string]: unknown }
      ? HandlePropDefinition<DefinitionElement>
      : never;

type HandlePropTarget<PropKeys extends string> = PropKeys extends PropTarget
  ? { [Key in PropKeys]?: ResolvedProperties[Key] }
  : never;
type HandlePropDefinition<PropObject extends { [key: string]: unknown }> =
  UnionToIntersection<
    {
      [Key in keyof PropObject & string]: HandlePropDefinitionEntry<
        Key,
        PropObject[Key]
      >;
    }[keyof PropObject & string]
  >;
type HandlePropDefinitionEntry<
  Key extends string,
  PropValue
> = PropValue extends {
  targets: infer T;
}
  ? T extends unknown[]
    ? { [P in Key]?: ResolvedProperties[Extract<T[number], PropTarget>] }
    : never
  : never;

export type PropVars<
  Props extends ComplexPropDefinitions<PropTarget | undefined>
> = Record<keyof PropDefinitionOutput<Props>, PureCSSVarKey>;

export type PatternResult<
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
> = {
  defaultClassName: string;
  variantClassNames: VariantsClassNames<Variants>;
  defaultVariants: VariantObjectSelection<Variants>;
  compoundVariants: Array<[VariantObjectSelection<Variants>, string]>;
  propVars: PropVars<Props>;
};

export type Brand<K, T> = K & { __brand: T };
export type VariantStringMap<Variants extends VariantGroups> = {
  [VariantKey in keyof Variants]: {
    [VariantTarget in keyof Variants[VariantKey]]: Brand<
      Record<VariantKey, VariantTarget>,
      `${VariantKey & string}_${VariantTarget & string}`
    >;
  };
};
export type BrandValue<Variants extends VariantGroups> = {
  [VariantKey in keyof Variants]: VariantStringMap<Variants>[VariantKey][keyof Variants[VariantKey]];
}[keyof Variants];

export type CompoundVariant<Variants extends VariantGroups> = (
  variants: VariantStringMap<Variants>
) => Array<{
  condition: Array<BrandValue<Variants>>;
  style: RecipeStyleRule;
}>;

export type ConditionalVariants<
  Variants extends VariantGroups | undefined,
  ToggleVariants extends VariantDefinitions | undefined
> = Variants extends undefined
  ? ToggleVariants extends undefined
    ? never
    : ToggleVariantMap<Exclude<ToggleVariants, undefined>>
  : ToggleVariants extends undefined
    ? Variants
    : Resolve<Variants & ToggleVariantMap<Exclude<ToggleVariants, undefined>>>;

export interface PatternOptions<
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
  compoundVariants?: CompoundVariant<
    ConditionalVariants<Variants, ToggleVariants>
  >;
}

export interface RecipeClassNames<Variants extends VariantGroups> {
  base: string;
  variants: VariantsClassNames<Variants>;
}

export type RuntimeFn<
  Variants extends VariantGroups,
  Props extends ComplexPropDefinitions<PropTarget | undefined>
> = ((options?: ResolveComplex<VariantSelection<Variants>>) => string) & {
  props: (options: Resolve<PropDefinitionOutput<Props>>) => CSSRule;
  variants: () => (keyof Variants)[];
  classNames: RecipeClassNames<Variants>;
};

export type RulesVariants<
  RuleFn extends RuntimeFn<
    VariantGroups,
    ComplexPropDefinitions<PropTarget | undefined>
  >
> = ResolveComplex<Parameters<RuleFn>[0]>;

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  describe.concurrent("ConditionVariants Type Test", () => {
    it("Conditional Type", () => {
      assertType<
        ConditionalVariants<{ color: { primary: string } }, undefined>
      >({ color: { primary: "className" } });

      assertType<ConditionalVariants<undefined, { disabled: string }>>({
        disabled: { true: "className" }
      });

      assertType<
        ConditionalVariants<
          { color: { primary: string } },
          { disabled: string }
        >
      >({
        color: { primary: "className1" },
        disabled: { true: "className" }
      });
    });
  });

  describe.concurrent("VariantSelection Type Test", () => {
    type ExampleVariants = {
      size: {
        small: string;
        large: string;
      };
      color: {
        red: string;
        blue: string;
      };
    };
    function assertSelectedVariant(
      variants: VariantSelection<ExampleVariants>
    ) {
      assertType<VariantSelection<ExampleVariants>>(variants);
      return variants;
    }

    it("Valid VariantSelection Type", () => {
      assertSelectedVariant({
        size: "small",
        color: "red"
      });
    });

    it("Invalid VariantSelection Type", () => {
      assertSelectedVariant({
        // @ts-expect-error: selected variant value is not included in `size` key.
        size: "medium", // error occurred here
        color: "red"
      });
    });
  });

  describe.concurrent("RecipeClassNames Type Test", () => {
    function assertValidClassNames<Variants extends VariantGroups>(
      classNames: RecipeClassNames<Variants>
    ) {
      assertType(classNames);
      return classNames;
    }

    it("Valid ClassNames Type Check", () => {
      assertValidClassNames({
        base: "base-class",
        variants: {
          color: {
            brand: "color-brand-class",
            accent: "color-accent-class"
          },
          size: {
            small: "size-small-class",
            medium: "size-medium-class",
            large: "size-large-class"
          }
        }
      });
    });
  });

  describe.concurrent("RuntimeFn Type Test", () => {
    type TestVariantsType = {
      color: {
        brand: { color: string };
        accent: { color: string };
      };
      size: {
        small: { padding: number };
        medium: { padding: number };
        large: { padding: number };
      };
      outlined: {
        true: { border: string };
        false: { border: string };
      };
    };
    type TestPropsType = [
      "background",
      { corner: { targets: ["borderColor", "outlineColor"] } }
    ];

    it("RuntimeFn Type Check", () => {
      type ExpectedResultType = RuntimeFn<TestVariantsType, TestPropsType>;
      expectTypeOf<ExpectedResultType>().toBeFunction();
      expectTypeOf<ExpectedResultType["variants"]>().toBeFunction();
      expectTypeOf<ExpectedResultType["classNames"]>().toBeObject();

      const expectedResult = Object.assign(
        (_options?: ResolveComplex<VariantSelection<TestVariantsType>>) =>
          "my-class",
        {
          props: (_options: {
            background?: CSSRule["background"];
            corner?: CSSRule["borderColor"] & CSSRule["outlineColor"];
          }) => ({}) as CSSRule,
          variants: () =>
            ["color", "size", "outlined"] satisfies (keyof TestVariantsType)[],
          classNames: {
            base: "basic-class",
            variants: {
              color: {
                brand: "color-brand",
                accent: "color-accent"
              },
              size: {
                small: "size-small",
                medium: "size-medium",
                large: "size-large"
              },
              outlined: {
                true: "outlined-true",
                false: "outlined-false"
              }
            }
          } satisfies RecipeClassNames<TestVariantsType>
        }
      );
      assertType<ExpectedResultType>(expectedResult);
    });
  });

  describe.concurrent("Types related to Rules", () => {
    function assertValidOptions<
      Variants extends VariantGroups | undefined = undefined,
      ToggleVariants extends VariantDefinitions | undefined = undefined,
      Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
    >(options: PatternOptions<Variants, ToggleVariants, Props>) {
      assertType<PatternOptions<Variants, ToggleVariants, Props>>(options);
      return options;
    }

    it("Base Style PatternOptions", () => {
      // Flatten base style
      assertValidOptions({
        color: "red",
        backgroundColor: "gray",
        fontSize: 16
      });

      // Base style
      assertValidOptions({
        base: {
          color: "red",
          backgroundColor: "gray",
          fontSize: 16
        }
      });

      // Both
      assertValidOptions({
        color: "red",
        base: { backgroundColor: "gray", fontSize: 16 }
      });
    });

    it("Variant Style PatternOptions", () => {
      // Toggle style
      assertValidOptions({
        toggles: {
          disabled: { textDecoration: "line-through" },
          rounded: { borderRadius: 999 }
        }
      });

      // Variant style
      assertValidOptions({
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

      // Both
      assertValidOptions({
        toggles: {
          disabled: { textDecoration: "line-through" },
          rounded: { borderRadius: 999 }
        },
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
    });

    const toggleVariants = {
      disabled: { textDecoration: "line-through" },
      rounded: { borderRadius: 999 }
    } as const;
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

    it("Default Style PatternOptions", () => {
      // Toggle style
      assertValidOptions({
        defaultVariants: { disabled: true },
        toggles: toggleVariants
      });
      assertValidOptions({
        defaultVariants: ["disabled", { rounded: true }],
        toggles: toggleVariants
      });

      // Variant style
      assertValidOptions({
        defaultVariants: { color: "brand", outlined: true },
        variants
      });
      assertValidOptions({
        defaultVariants: ["outlined", { color: "brand" }],
        variants
      });

      // Both
      assertValidOptions({
        defaultVariants: {
          disabled: true,
          color: "brand",
          size: "medium",
          outlined: true
        },
        toggles: toggleVariants,
        variants
      });
      assertValidOptions({
        defaultVariants: [
          "disabled",
          "outlined",
          {
            color: "brand",
            size: "medium"
          }
        ],
        toggles: toggleVariants,
        variants
      });
    });

    it("Compound Style PatternOptions", () => {
      // Toggle style
      assertValidOptions({
        compoundVariants: ({ disabled, rounded }) => [
          {
            condition: [disabled.true, rounded.true],
            style: {
              color: "red"
            }
          }
        ],
        toggles: toggleVariants
      });

      // Variant style
      assertValidOptions({
        compoundVariants: ({ color, outlined }) => [
          {
            condition: [color.brand, outlined.true],
            style: {
              color: "red"
            }
          }
        ],
        variants
      });
      assertValidOptions({
        compoundVariants: ({ outlined, color }) => [
          {
            condition: [outlined.true, color.brand],
            style: {
              color: "red"
            }
          }
        ],
        variants
      });

      // Both
      assertValidOptions({
        compoundVariants: ({ disabled, color, size, outlined }) => [
          {
            condition: [disabled.true, color.brand, size.medium, outlined.true],
            style: {
              color: "red"
            }
          }
        ],
        toggles: toggleVariants,
        variants
      });
    });

    it("Props PatternOptions", () => {
      // Property Array
      assertValidOptions({
        props: ["color", "background"]
      });

      // Property object
      assertValidOptions({
        props: {
          size: { targets: ["padding", "margin"] }
        }
      });
      assertValidOptions({
        props: {
          size: { base: "3px", targets: ["padding", "margin"] }
        }
      });

      // Complex Props
      assertValidOptions({
        props: [
          "color",
          "background",
          { size: { targets: ["padding", "margin"] } }
        ]
      });
    });

    it("Complex Style PatternOptions", () => {
      assertValidOptions({
        backgroundColor: "gray",
        base: { color: "red", fontSize: 16 },

        toggles: toggleVariants,
        variants,

        defaultVariants: {
          size: "small"
        },
        compoundVariants: ({ color, size }) => [
          {
            condition: [color.brand, size.small],
            style: {
              fontSize: "16px"
            }
          }
        ]
      });
    });
  });
}

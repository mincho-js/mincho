import type {
  ComplexCSSRule,
  CSSRule,
  ResolvedProperties,
  NonNullableString
} from "@mincho-js/transform-to-vanilla";

type Resolve<T> = {
  [Key in keyof T]: T[Key];
} & {};
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

type RecipeStyleRule = ComplexCSSRule | string;

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

export type ComplexPropDefinition<PropKeys extends PropTarget | undefined> =
  | PropDefinition<PropKeys>
  | Array<PropKeys | PropDefinition<PropKeys>>;
export type PropDefinition<PropKeys extends PropTarget | undefined> =
  | PropDefinitionWithPropTarget<PropKeys>
  | PropDefinitionWithString<PropKeys>;

type PropDefinitionWithPropTarget<PropKeys extends PropTarget | undefined> = {
  [Key in Exclude<PropKeys, undefined>]?: {
    base: ResolvedProperties[Key];
  };
};
type PropDefinitionWithString<PropKeys extends PropTarget | undefined> = {
  [Key in NonNullableString]?:
    | {
        base?: ResolvedProperties[Exclude<PropKeys, undefined>];
        targets: PropKeys[];
      }
    | PropKeys[];
};

export type PropDefinitionOutput<
  T extends ComplexPropDefinition<PropTarget | undefined>
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
  ? { [Key in PropKeys]: ResolvedProperties[Key] }
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
    ? { [P in Key]: ResolvedProperties[Extract<T[number], PropTarget>] }
    : never
  : PropValue extends unknown[]
    ? { [P in Key]: ResolvedProperties[Extract<PropValue[number], PropTarget>] }
    : Key extends PropTarget
      ? { [P in Key]: ResolvedProperties[Key] }
      : never;

export type PatternResult<Variants extends VariantGroups> = {
  defaultClassName: string;
  variantClassNames: VariantsClassNames<Variants>;
  defaultVariants: VariantObjectSelection<Variants>;
  compoundVariants: Array<[VariantObjectSelection<Variants>, string]>;
};

export interface CompoundVariant<Variants extends VariantGroups> {
  variants: VariantSelection<Variants>;
  style: RecipeStyleRule;
}

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

export type PatternOptions<
  Variants extends VariantGroups | undefined,
  ToggleVariants extends VariantDefinitions | undefined,
  Props extends ComplexPropDefinition<PropTarget> | undefined
> = CSSRule & {
  base?: RecipeStyleRule;
  props?: Props;
  toggles?: ToggleVariants;
  variants?: Variants;
  defaultVariants?: VariantSelection<
    ConditionalVariants<Variants, ToggleVariants>
  >;
  compoundVariants?: Array<
    CompoundVariant<ConditionalVariants<Variants, ToggleVariants>>
  >;
};

export type RecipeClassNames<Variants extends VariantGroups> = {
  base: string;
  variants: VariantsClassNames<Variants>;
};

export type RuntimeFn<Variants extends VariantGroups> = ((
  options?: ResolveComplex<VariantSelection<Variants>>
) => string) & {
  variants: () => (keyof Variants)[];
  classNames: RecipeClassNames<Variants>;
};

export type RulesVariants<RuleFn extends RuntimeFn<VariantGroups>> =
  ResolveComplex<Parameters<RuleFn>[0]>;
export type RecipeVariants<RecipeFn extends RuntimeFn<VariantGroups>> =
  RulesVariants<RecipeFn>;

// == Tests ====================================================================
if (import.meta.vitest) {
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

  describe.concurrent("Compound Variants Type Test", () => {
    function assertCompoundVariants<Variants extends VariantGroups>(
      optionValue: CompoundVariant<Variants>
    ) {
      assertType(optionValue);
      return optionValue;
    }

    it("Valid CompoundVariant", () => {
      assertCompoundVariants({
        variants: {
          color: "brand",
          size: "small"
        },
        style: {
          fontSize: "16px"
        }
      });
    });

    it("Invalid CompoundVariant with default key", () => {
      assertCompoundVariants({
        // @ts-expect-error: selected variant key is not invalid
        variantss: {
          // ↑↑ error occurred here
          color: "brand",
          size: "small"
        },
        style: {
          fontSize: "16px"
        }
      });
    });
    it("Invalid CompoundVariant with style value", () => {
      assertCompoundVariants({
        variants: {
          color: "brand",
          size: "small"
        },
        style: {
          // @ts-expect-error: fonTsize does not exist in `ComplexCSSRule` Type
          fonTsize: "16px" // error occurred here
        }
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

    it("RuntimeFn Type Check", () => {
      type ExpectedResultType = RuntimeFn<TestVariantsType>;
      expectTypeOf<ExpectedResultType>().toBeFunction();
      expectTypeOf<ExpectedResultType["variants"]>().toBeFunction();
      expectTypeOf<ExpectedResultType["classNames"]>().toBeObject();

      const expectedResult = Object.assign(
        (_options?: ResolveComplex<VariantSelection<TestVariantsType>>) =>
          "my-class",
        {
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
      Props extends ComplexPropDefinition<PropTarget> | undefined = undefined
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
        compoundVariants: [
          {
            variants: {
              disabled: true,
              rounded: true
            },
            style: {
              color: "red"
            }
          }
        ],
        toggles: toggleVariants
      });
      assertValidOptions({
        compoundVariants: [
          {
            variants: ["disabled", "rounded"],
            style: {
              color: "red"
            }
          }
        ],
        toggles: toggleVariants
      });

      // Variant style
      assertValidOptions({
        compoundVariants: [
          {
            variants: {
              color: "brand",
              outlined: true
            },
            style: {
              color: "red"
            }
          }
        ],
        variants
      });
      assertValidOptions({
        compoundVariants: [
          {
            variants: ["outlined", { color: "brand" }],
            style: {
              color: "red"
            }
          }
        ],
        variants
      });

      // Both
      assertValidOptions({
        compoundVariants: [
          {
            variants: {
              disabled: true,
              color: "brand",
              size: "medium",
              outlined: true
            },
            style: {
              color: "red"
            }
          }
        ],
        toggles: toggleVariants,
        variants
      });
      assertValidOptions({
        compoundVariants: [
          {
            variants: [
              "disabled",
              "outlined",
              {
                color: "brand",
                size: "medium"
              }
            ],
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

      // Property with base value
      assertValidOptions({
        props: {
          background: { base: "red" }
        }
      });

      // Property with aliased
      assertValidOptions({
        props: {
          size: ["padding", "margin"]
        }
      });
      assertValidOptions({
        props: {
          size: { base: "3px", targets: ["padding", "margin"] }
        }
      });

      // Complex Props
      assertValidOptions({
        props: ["color", "background", { size: ["padding", "margin"] }]
      });
      assertValidOptions({
        props: [
          "color",
          {
            background: { base: "red" },
            contour: ["border", "outline"],
            size: { base: "3px", targets: ["padding", "margin"] }
          }
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
        compoundVariants: [
          {
            variants: {
              color: "brand",
              size: "small"
            },
            style: {
              fontSize: "16px"
            }
          }
        ]
      });
    });
  });
}

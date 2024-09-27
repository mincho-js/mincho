import type { ComplexCSSRule, CSSRule } from "@mincho-js/transform-to-vanilla";

type Resolve<T> = {
  [Key in keyof T]: T[Key];
} & {};
export type ResolveComplex<T> =
  T extends Array<infer U> ? Array<Resolve<U>> : Resolve<T>;
type RemoveUndefined<T> = T extends undefined ? never : T;
export type RemoveUndefinedFromIntersection<T> = {
  [K in keyof T]: RemoveUndefined<T[K]>;
}[keyof T];

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

export type PatternOptions<
  Variants extends VariantGroups,
  ToggleVariants extends VariantDefinitions
> = CSSRule & {
  base?: RecipeStyleRule;
  toggles?: ToggleVariants;
  variants?: Variants;
  defaultVariants?: VariantSelection<
    Variants & ToggleVariantMap<ToggleVariants>
  >;
  compoundVariants?: Array<
    CompoundVariant<Variants & ToggleVariantMap<ToggleVariants>>
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
  const { describe, it, assertType } = import.meta.vitest;

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

  describe.concurrent("Types related to Rules", () => {
    it("Valid PatternOptions", () => {
      function assertValidOptions<
        Variants extends VariantGroups,
        ToggleVariants extends VariantDefinitions
      >(options: PatternOptions<Variants, ToggleVariants>) {
        assertType<PatternOptions<Variants, ToggleVariants>>(options);
        return options;
      }

      assertValidOptions({
        backgroundColor: "gray",
        base: { color: "red", fontSize: 16 },

        toggles: {
          disabled: {
            textDecoration: "line-through"
          }
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
          }
        },

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

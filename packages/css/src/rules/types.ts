import type { ComplexCSSRule, CSSRule } from "@mincho-js/transform-to-vanilla";

type Resolve<T> = {
  [Key in keyof T]: T[Key];
} & {};

type RecipeStyleRule = ComplexCSSRule | string;

export type VariantDefinitions = Record<string, RecipeStyleRule>;

type BooleanMap<T> = T extends "true" | "false" ? boolean : T;

export type VariantGroups = Record<string, VariantDefinitions>;
export type VariantSelection<Variants extends VariantGroups> = {
  [VariantGroup in keyof Variants]?:
    | BooleanMap<keyof Variants[VariantGroup]>
    | undefined;
};

export type VariantsClassNames<Variants extends VariantGroups> = {
  [P in keyof Variants]: {
    [PP in keyof Variants[P]]: string;
  };
};

export type PatternResult<Variants extends VariantGroups> = {
  defaultClassName: string;
  variantClassNames: VariantsClassNames<Variants>;
  defaultVariants: VariantSelection<Variants>;
  compoundVariants: Array<[VariantSelection<Variants>, string]>;
};

export interface CompoundVariant<Variants extends VariantGroups> {
  variants: VariantSelection<Variants>;
  style: RecipeStyleRule;
}

export type PatternOptions<Variants extends VariantGroups> = CSSRule & {
  base?: RecipeStyleRule;
  variants?: Variants;
  defaultVariants?: VariantSelection<Variants>;
  compoundVariants?: Array<CompoundVariant<Variants>>;
};

export type RecipeClassNames<Variants extends VariantGroups> = {
  base: string;
  variants: VariantsClassNames<Variants>;
};

export type RuntimeFn<Variants extends VariantGroups> = ((
  options?: Resolve<VariantSelection<Variants>>
) => string) & {
  variants: () => (keyof Variants)[];
  classNames: RecipeClassNames<Variants>;
};

export type RulesVariants<RuleFn extends RuntimeFn<VariantGroups>> = Resolve<
  Parameters<RuleFn>[0]
>;
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
      function assertValidOptions<Variants extends VariantGroups>(
        options: PatternOptions<Variants>
      ) {
        assertType<PatternOptions<Variants>>(options);
        return options;
      }

      assertValidOptions({
        base: { color: "red", fontSize: 16 },

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

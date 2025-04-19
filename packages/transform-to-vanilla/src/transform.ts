import {
  transformStyle,
  initTransformContext,
  mergeVariantReference,
  type TransformContext
} from "./transform-object/index.js";
import type { ComplexStyleRule, StyleRule } from "@vanilla-extract/css";
import type {
  CSSRule,
  ComplexCSSRule,
  ComplexCSSItem,
  ClassNames
} from "./types/style-rule.js";

// == Interface ================================================================
export function transform(
  style: ComplexCSSRule,
  context = structuredClone(initTransformContext)
): ComplexStyleRule {
  if (Array.isArray(style)) {
    const contexts: TransformContext[] = [];
    const results = style.map((eachStyle) => {
      const styleValue =
        typeof eachStyle === "function" ? eachStyle() : eachStyle;

      if (isClassNames(styleValue)) {
        return styleValue;
      }

      const tempContext = structuredClone(context);
      const result = transformStyle(styleValue, tempContext);
      contexts.push(tempContext);
      return result;
    });
    contexts.forEach((eachContext) => {
      mergeVariantReference(context, eachContext);
    });

    return results;
  }
  return transformStyle(style, context);
}

// == Utils ====================================================================
function isClassNames(style: ComplexCSSItem): style is ClassNames {
  return typeof style === "string" || Array.isArray(style);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("transform", () => {
    it("Class Names", () => {
      const classNames = ["myClassName1", "myClassName2"];
      const resultClassNames = transform(classNames);
      expect(resultClassNames).toStrictEqual(classNames);

      const nestedClassNames = [
        "nestedClassName1",
        ["nestedClassName2", "nestedClassName3"],
        "nestedClassName4"
      ];
      const resultNestedClassNames = transform(nestedClassNames);
      expect(resultNestedClassNames).toStrictEqual(nestedClassNames);
    });

    it("Functions", () => {
      const classNameFunctions = [
        () => "myClassName1",
        (_arg: number) => "myClassName2",
        (size = 10) =>
          ({ padding: size, margin: size, border: "none" }) satisfies CSSRule
      ];
      const result = transform(classNameFunctions);
      expect(result).toStrictEqual([
        "myClassName1",
        "myClassName2",
        { padding: 10, margin: 10, border: "none" } satisfies CSSRule
      ]);
    });

    it("Style", () => {
      const style = {
        color: "red",
        borderRadius: 5
      };
      const result = transform(style);

      expect(result).toStrictEqual({
        color: "red",
        borderRadius: 5
      });
    });

    it("Style Array", () => {
      const style1 = {
        color: "red",
        borderRadius: 5
      };
      const style2 = {
        background: "blue"
      };
      const result = transform([style1, style2]);

      expect(result).toStrictEqual([style1, style2]);
    });

    it("Complex Array", () => {
      const classNames = ["myClassName1", "myClassName2"];
      const nestedClassNames = [
        "nestedClassName1",
        ["nestedClassName2", "nestedClassName3"],
        "nestedClassName4"
      ];
      const classNameFunctions = [
        () => "myClassName3",
        (_arg: number) => "myClassName4"
      ];
      const style1 = {
        color: "red",
        borderRadius: 5
      };
      const style2 = {
        background: "blue"
      };

      const result = transform([
        ...classNames,
        ...nestedClassNames,
        ...classNameFunctions,
        style1,
        style2
      ]);
      expect(result).toStrictEqual([
        ...classNames,
        ...nestedClassNames,
        "myClassName3",
        "myClassName4",
        style1,
        style2
      ]);
    });

    it("Variant Reference", async () => {
      const context = structuredClone(initTransformContext);
      const result = transform(
        {
          "&:hover:not(:active) %someVariant": {
            border: "2px solid red"
          },
          "nav li > &": {
            textDecoration: "underline"
          },
          selectors: {
            "a:nth-of-type(2) &": {
              opacity: 1
            }
          }
        },
        context
      );

      expect(result).toStrictEqual({
        selectors: {
          "nav li > &": {
            textDecoration: "underline"
          },
          "a:nth-of-type(2) &": {
            opacity: 1
          }
        }
      } as StyleRule);
      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) %someVariant": {
          border: "2px solid red"
        }
      } satisfies Record<string, StyleRule>);

      const { replaceVariantReference } = await import(
        "@/transform-object/variant-reference.js"
      );
      context.variantMap = {
        "%someVariant": ".myClass"
      };
      replaceVariantReference(context);

      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) .myClass": {
          border: "2px solid red"
        }
      } satisfies Record<string, StyleRule>);
    });

    it("Variant Reference with Array", async () => {
      const context = structuredClone(initTransformContext);
      const result = transform(
        [
          "myStyle",
          {
            "&:hover:not(:active) %someVariant": {
              border: "2px solid red"
            },
            "nav li > &": {
              textDecoration: "underline"
            },
            selectors: {
              "a:nth-of-type(2) &": {
                opacity: 1
              }
            }
          },
          {
            "@media (prefers-color-scheme: dark)": {
              "&:hover:not(:active) %someVariant": {
                "@supports (display: grid)": {
                  border: "2px solid blue"
                },
                "nav li > &": {
                  textDecoration: "underline"
                }
              }
            }
          }
        ],
        context
      );

      expect(result).toStrictEqual([
        "myStyle",
        {
          selectors: {
            "nav li > &": {
              textDecoration: "underline"
            },
            "a:nth-of-type(2) &": {
              opacity: 1
            }
          }
        } as StyleRule,
        {} as StyleRule
      ]);
      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) %someVariant": {
          border: "2px solid red",
          "@supports": {
            "(display: grid)": {
              "@media": {
                "(prefers-color-scheme: dark)": {
                  border: "2px solid blue"
                }
              }
            }
          }
        },
        "nav li > &:hover:not(:active) %someVariant": {
          "@media": {
            "(prefers-color-scheme: dark)": {
              textDecoration: "underline"
            }
          }
        }
      } satisfies Record<string, StyleRule>);

      const { replaceVariantReference } = await import(
        "@/transform-object/variant-reference.js"
      );
      context.variantMap = {
        "%someVariant": ".myClass"
      };
      replaceVariantReference(context);

      expect(context.variantReference).toStrictEqual({
        "&:hover:not(:active) .myClass": {
          border: "2px solid red",
          "@supports": {
            "(display: grid)": {
              "@media": {
                "(prefers-color-scheme: dark)": {
                  border: "2px solid blue"
                }
              }
            }
          }
        },
        "nav li > &:hover:not(:active) .myClass": {
          "@media": {
            "(prefers-color-scheme: dark)": {
              textDecoration: "underline"
            }
          }
        }
      } satisfies Record<string, StyleRule>);
    });
  });
}

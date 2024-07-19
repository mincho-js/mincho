import { transformStyle } from "./transform-object/index";
import type { ComplexStyleRule } from "@vanilla-extract/css";
import type {
  ComplexCSSRule,
  ComplexCSSItem,
  ClassNames
} from "./types/style-rule";

// == Interface ================================================================
export function transform(style: ComplexCSSRule): ComplexStyleRule {
  if (Array.isArray(style)) {
    return style.map((eachStyle) => {
      return isClassNames(eachStyle) ? eachStyle : transformStyle(eachStyle);
    });
  }
  return transformStyle(style);
}

// == Utils ====================================================================
function isClassNames(style: ComplexCSSItem): style is ClassNames {
  return typeof style === "string" || Array.isArray(style);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
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
      const style1 = {
        color: "red",
        borderRadius: 5
      };
      const style2 = {
        background: "blue"
      };

      expect([classNames, nestedClassNames, style1, style2]).toStrictEqual([
        classNames,
        nestedClassNames,
        style1,
        style2
      ]);
      expect([style1, nestedClassNames, classNames, style2]).toStrictEqual([
        style1,
        nestedClassNames,
        classNames,
        style2
      ]);
    });
  });
}

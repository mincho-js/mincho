import { initTransformContext } from "@/transform-object";
import type { TransformContext, CSSRuleExistValue } from "@/transform-object";

// == Interface ================================================================
const LITERAL_PROPERTY_REFERENCE_REGEX = /^@[\w\-_]+$/;
const PROPERTY_REFERENCE_REGEX = /\B@[\w\-_]+/g;

export function replacePropertyReference(
  valueStr: string,
  context: TransformContext
): string | CSSRuleExistValue | (string | CSSRuleExistValue)[] {
  if (LITERAL_PROPERTY_REFERENCE_REGEX.test(valueStr)) {
    return getReplacement(valueStr, context);
  }

  return valueStr.replace(PROPERTY_REFERENCE_REGEX, (matched: string) => {
    const result = getReplacement(matched, context);
    if (typeof result === "object") return JSON.stringify(result);
    return String(result);
  });
}

function getReplacement(
  reference: string,
  context: TransformContext
): string | CSSRuleExistValue | (string | CSSRuleExistValue)[] {
  const withoutPrefix = reference.substring(1);
  if (isPropertyKeyExist(withoutPrefix, context)) {
    const target = context.propertyReference[withoutPrefix];
    if (Array.isArray(target)) {
      return target.map((v) =>
        typeof v === "string" ? replacePropertyReference(v, context) : v
      );
    }
    return typeof target === "string"
      ? replacePropertyReference(target, context)
      : (target as CSSRuleExistValue);
  } else {
    throw new Error(`Property reference not found: ${reference}`);
  }
}

function isPropertyKeyExist(
  key: string,
  context: TransformContext
): key is keyof typeof context.propertyReference {
  return key in context.propertyReference;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("propertyReference", () => {
    it("Not used", () => {
      expect(
        replacePropertyReference("50px", {
          ...initTransformContext
        })
      ).toBe("50px");
    });

    it("No reference value", () => {
      expect(() =>
        replacePropertyReference("@width", {
          ...initTransformContext
        })
      ).toThrowError("Property reference not found: @width");
    });

    it("One reference value", () => {
      expect(
        replacePropertyReference("@width", {
          ...initTransformContext,
          propertyReference: {
            width: "50px"
          }
        })
      ).toBe("50px");
    });

    it("One reference with literal type", () => {
      // Number
      expect(
        replacePropertyReference("@width", {
          ...initTransformContext,
          propertyReference: {
            width: 10
          }
        })
      ).toBe(10);

      // Array
      expect(
        replacePropertyReference("@width", {
          ...initTransformContext,
          propertyReference: {
            width: [1, 2]
          }
        })
      ).toStrictEqual([1, 2]);
    });

    it("With complex string", () => {
      expect(
        replacePropertyReference("calc(@width / 2)", {
          ...initTransformContext,
          propertyReference: {
            width: "50px"
          }
        })
      ).toBe("calc(50px / 2)");
    });

    it("With multiple", () => {
      expect(
        replacePropertyReference("calc(@width + @height)", {
          ...initTransformContext,
          propertyReference: {
            width: "50px",
            height: "100px"
          }
        })
      ).toBe("calc(50px + 100px)");
    });

    it("With multiple, but not exist value", () => {
      expect(() =>
        replacePropertyReference("calc(@width + @height)", {
          ...initTransformContext,
          propertyReference: {
            width: "50px"
          }
        })
      ).toThrowError("Property reference not found: @height");

      expect(() =>
        replacePropertyReference("calc(@width + @height)", {
          ...initTransformContext,
          propertyReference: {
            height: "100px"
          }
        })
      ).toThrowError("Property reference not found: @width");
    });

    it("With recursive", () => {
      expect(
        replacePropertyReference("calc(@width + @height)", {
          ...initTransformContext,
          propertyReference: {
            width: "50px",
            height: "@width"
          }
        })
      ).toBe("calc(50px + 50px)");

      expect(
        replacePropertyReference("@height", {
          ...initTransformContext,
          propertyReference: {
            width: "50px",
            height: ["@width", "@width"]
          }
        })
      ).toStrictEqual(["50px", "50px"]);
    });
  });
}

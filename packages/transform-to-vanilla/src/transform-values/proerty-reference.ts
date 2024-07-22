import type { TransformContext } from "@/transform-object";

// == Interface ================================================================
const propertyReferenceRegex = /\B@[\w\-_]+/g;

export function replacePropertyReference(
  valueStr: string,
  context: TransformContext
) {
  return valueStr.replaceAll(propertyReferenceRegex, (matched: string) => {
    const withoutPrefix = matched.substring(1);
    if (isPropertyKeyExist(withoutPrefix, context)) {
      const target = context.propertyReference[withoutPrefix];
      return typeof target === "string"
        ? replacePropertyReference(target, context)
        : (target as string); // Can be number, undefined
    } else {
      throw new Error(`Property reference not found: ${matched}`);
    }
  });
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
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("propertyRefence", () => {
    const initTransformContext: TransformContext = {
      result: {},
      basedKey: "",
      parentSelector: "",
      parentAtRules: {
        "@media": "",
        "@supports": "",
        "@container": "",
        "@layer": ""
      },
      propertyReference: {}
    };

    it("Not used", () => {
      expect(
        replacePropertyReference("50px", {
          ...initTransformContext
        })
      ).toBe("50px");
    });

    it("No refence value", () => {
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
    });
  });
}

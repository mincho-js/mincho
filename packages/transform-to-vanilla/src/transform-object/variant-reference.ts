import {
  initTransformContext,
  type TransformContext,
  type StyleResult
} from "@/transform-object";

// == Interface ================================================================
const VARIANT_REFERENCE_REGEX = /\B%[\w\-_]+/g;

export function replaceVariantReference(context: TransformContext) {
  const replacedVariantReference: Record<string, StyleResult> = {};
  for (const [key, value] of Object.entries(context.variantReference)) {
    const replacedKey = replaceVariantReferenceKey(key, context);
    replacedVariantReference[replacedKey] = value;
  }
  context.variantReference = replacedVariantReference;
}

function replaceVariantReferenceKey(
  keyStr: string,
  context: TransformContext
): string {
  return keyStr.replace(VARIANT_REFERENCE_REGEX, (matched: string) => {
    if (matched in context.variantMap) {
      return context.variantMap[matched];
    }
    throw new Error(`Variant reference not found: ${matched}`);
  });
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("variantRefence", () => {
    it("Not used", () => {
      expect(
        replaceVariantReferenceKey("nav > &:hover", { ...initTransformContext })
      ).toBe("nav > &:hover");
    });

    it("No reference value", () => {
      expect(() =>
        replaceVariantReferenceKey("%someVariant", { ...initTransformContext })
      ).toThrowError("Variant reference not found: %someVariant");

      expect(() =>
        replaceVariantReferenceKey("%someVariant", {
          ...initTransformContext,
          variantMap: {
            "%someVariant2": ".some-variant"
          }
        })
      ).toThrowError("Variant reference not found: %someVariant");
    });

    it("One reference value", () => {
      expect(
        replaceVariantReferenceKey("%someVariant", {
          ...initTransformContext,
          variantMap: {
            "%someVariant": ".some-variant"
          }
        })
      ).toBe(".some-variant");
    });

    it("Complex reference value", () => {
      expect(
        replaceVariantReferenceKey("%someVariant:hover %otherVariant2 &", {
          ...initTransformContext,
          variantMap: {
            "%someVariant": ".some-variant",
            "%otherVariant2": ".other-variant"
          }
        })
      ).toBe(".some-variant:hover .other-variant &");
    });
  });
}

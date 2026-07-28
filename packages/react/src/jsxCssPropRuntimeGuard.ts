const missedTransformErrorMessage =
  "Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.";

export { missedTransformErrorMessage };

export function throwForOwnCssProp(props: unknown) {
  if (hasOwnCssProp(props)) {
    throw new Error(missedTransformErrorMessage);
  }
}

export function hasOwnCssProp(props: unknown): boolean {
  return (
    typeof props === "object" &&
    props !== null &&
    Object.prototype.hasOwnProperty.call(props, "css")
  );
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
const vitest = import.meta.vitest;

if (vitest) {
  const { describe, it, expect } = vitest;

  describe("JSX css prop runtime guard", () => {
    it("detects only own css props", () => {
      const inheritedCssProps = Object.assign(Object.create({ css: "base" }), {
        id: "root"
      });

      expect(hasOwnCssProp({ css: undefined })).toBe(true);
      expect(hasOwnCssProp(inheritedCssProps)).toBe(false);
      expect(hasOwnCssProp(null)).toBe(false);
      expect(hasOwnCssProp("base")).toBe(false);
    });

    it("does not require Object.hasOwn", () => {
      const objectHasOwnDescriptor = Object.getOwnPropertyDescriptor(
        Object,
        "hasOwn"
      );
      Reflect.deleteProperty(Object, "hasOwn");

      try {
        expect(hasOwnCssProp({ css: undefined })).toBe(true);
      } finally {
        if (objectHasOwnDescriptor) {
          Object.defineProperty(Object, "hasOwn", objectHasOwnDescriptor);
        }
      }
    });

    it("throws the missed transform diagnostic for own css props", () => {
      expect(() => throwForOwnCssProp({ css: "base" })).toThrow(
        missedTransformErrorMessage
      );
    });
  });
}

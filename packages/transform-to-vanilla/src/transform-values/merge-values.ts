// == Types ====================================================================
type FallbackValues = string[];
type MergeNeedValues = string[];
type MergeNeedFallbackValues = (string | FallbackValues)[];
type MergeNeedComplexValues = MergeNeedValues | MergeNeedFallbackValues;
type MergedValues = string | FallbackValues;

// == Interface ================================================================
export function mergeToComma(values: MergeNeedValues): string;
export function mergeToComma(values: MergeNeedFallbackValues): FallbackValues;
export function mergeToComma(values: MergeNeedComplexValues): MergedValues {
  const separator = ", ";
  if (isSingleArray(values)) {
    return values.join(separator);
  }

  return transformArray(values, separator);
}

export function mergeToSpace(values: MergeNeedValues): string;
export function mergeToSpace(values: MergeNeedFallbackValues): FallbackValues;
export function mergeToSpace(values: MergeNeedComplexValues): MergedValues {
  const separator = " ";
  if (isSingleArray(values)) {
    return values.join(separator);
  }

  return transformArray(values, separator);
}

// == Utils ====================================================================
function isSingleArray(
  values: MergeNeedComplexValues
): values is MergeNeedValues {
  return Array.isArray(values) && !values.some(Array.isArray);
}

interface MergeStackElement {
  index: number;
  string: string;
}
function transformArray(
  values: MergeNeedFallbackValues,
  joinMethod: ", " | " " = ", "
) {
  const result: FallbackValues = [];
  const stack: MergeStackElement[] = [{ index: 0, string: "" }];
  const valueLength = values.length;

  while (stack.length > 0) {
    const { index, string } = stack.pop() as MergeStackElement;

    if (index >= valueLength) {
      result.push(string);
      continue;
    }

    const currentElement = values[index];
    const nextIndex = index + 1;
    const separatedStr = `${string}${index === 0 ? "" : joinMethod}`;
    if (Array.isArray(currentElement)) {
      for (let i = currentElement.length - 1; i >= 0; i--) {
        stack.push({
          index: nextIndex,
          string: separatedStr + currentElement[i]
        });
      }
    } else {
      stack.push({
        index: nextIndex,
        string: separatedStr + currentElement
      });
    }
  }

  return result;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect, expectTypeOf } = import.meta.vitest;

  describe.concurrent("mergeToComma", () => {
    it("Merge with Single Array", () => {
      const sample = ["inset 0 0 10px #555", "0 0 20px black"];
      const result = mergeToComma(sample);

      expect(result).toBe("inset 0 0 10px #555, 0 0 20px black");
      expectTypeOf(result).toBeString();
    });

    it("Merge with a Multi-Values Fallback Array", () => {
      const sample = [
        "inset 0 0 10px #555",
        ["0 0 20px black", "0 0 20px rgba(0, 255, 0, 0.5)"]
      ];
      const result = mergeToComma(sample);

      expect(result).toStrictEqual([
        "inset 0 0 10px #555, 0 0 20px black",
        "inset 0 0 10px #555, 0 0 20px rgba(0, 255, 0, 0.5)"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });

    it("Merge with Fallback Groups", () => {
      const sample = [
        "inset 0 0 10px #555",
        ["0 0 20px black", "0 0 20px rgba(0, 255, 0, 0.5)"],
        ["0 0 40px rgba(255, 0, 0, 0.7) inset"]
      ];
      const result = mergeToComma(sample);

      expect(result).toStrictEqual([
        "inset 0 0 10px #555, 0 0 20px black, 0 0 40px rgba(255, 0, 0, 0.7) inset",
        "inset 0 0 10px #555, 0 0 20px rgba(0, 255, 0, 0.5), 0 0 40px rgba(255, 0, 0, 0.7) inset"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });

    it("Merge with only Fallback Groups", () => {
      const sample = [
        ["inset 0 0 10px #555", "0 0 20px black"],
        ["0 0 40px rgba(255, 0, 0, 0.7) inset", "0 0 20px rgba(0, 255, 0, 0.5)"]
      ];
      const result = mergeToComma(sample);

      expect(result).toStrictEqual([
        "inset 0 0 10px #555, 0 0 40px rgba(255, 0, 0, 0.7) inset",
        "inset 0 0 10px #555, 0 0 20px rgba(0, 255, 0, 0.5)",
        "0 0 20px black, 0 0 40px rgba(255, 0, 0, 0.7) inset",
        "0 0 20px black, 0 0 20px rgba(0, 255, 0, 0.5)"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });
  });

  describe.concurrent("mergeToSpace", () => {
    it("Merge with Single Array", () => {
      const sample = ["scale(2)", "rotate(28.64deg)"];
      const result = mergeToSpace(sample);

      expect(result).toBe("scale(2) rotate(28.64deg)");
      expectTypeOf(result).toBeString();
    });

    it("Merge with a Multi-Values Fallback Group", () => {
      const sample = ["scale(2)", ["rotate(28.64deg)", "rotate(0.5rad)"]];
      const result = mergeToSpace(sample);

      expect(result).toStrictEqual([
        "scale(2) rotate(28.64deg)",
        "scale(2) rotate(0.5rad)"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });

    it("Merge with Fallback Groups", () => {
      const sample = [
        "scale(2)",
        ["rotate(28.64deg)", "rotate(0.5rad)"],
        ["translate(120px, 50%)"]
      ];
      const result = mergeToSpace(sample);

      expect(result).toStrictEqual([
        "scale(2) rotate(28.64deg) translate(120px, 50%)",
        "scale(2) rotate(0.5rad) translate(120px, 50%)"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });

    it("Merge with only Fallback Groups", () => {
      const sample = [
        ["scale(2)", "skew(30deg, 20deg)"],
        ["rotate(28.64deg)", "rotate(0.5rad)"]
      ];
      const result = mergeToSpace(sample);

      expect(result).toStrictEqual([
        "scale(2) rotate(28.64deg)",
        "scale(2) rotate(0.5rad)",
        "skew(30deg, 20deg) rotate(28.64deg)",
        "skew(30deg, 20deg) rotate(0.5rad)"
      ]);
      expectTypeOf(result).toEqualTypeOf<FallbackValues>();
    });
  });
}

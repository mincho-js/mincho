// == Interface ================================================================
export function simplyImportant(value: string) {
  return value.endsWith("!")
    ? value.endsWith(" !")
      ? `${value}important`
      : `${value.substring(0, value.length - 1)} !important`
    : value;
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("simplyImportant", () => {
    it("No important", () => {
      expect(simplyImportant("red")).toBe("red");
    });

    it("! to End", () => {
      expect(simplyImportant("red!")).toBe("red !important");
    });

    it("! to End with space", () => {
      expect(simplyImportant("red !")).toBe("red !important");
    });
  });
}

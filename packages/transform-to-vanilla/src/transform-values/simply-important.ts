// == Interface ================================================================
export function simplyImportant(value: string) {
  return value.endsWith("!")
    ? value.endsWith(" !")
      ? `${value}important`
      : `${value.substring(0, value.length - 1)} !important`
    : value;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
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

    it("!important to End", () => {
      expect(simplyImportant("red !important")).toBe("red !important");
    });
  });
}

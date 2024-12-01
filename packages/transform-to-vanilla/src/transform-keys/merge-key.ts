// == Interface ================================================================
export function removeMergeSymbol(keyStr: string) {
  return keyStr.substring(0, keyStr.length - 1);
}

export function mergeKeyInfo(keyStr: string) {
  const isMergeToComma = keyStr.endsWith("$");
  const isMergeToSpace = keyStr.endsWith("_");

  return {
    isMergeToComma,
    isMergeToSpace,
    isMergeSymbol: isMergeToComma || isMergeToSpace
  };
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Remove Key Sign Symbol", () => {
    it("Has Sign Symbol to the end", () => {
      expect(removeMergeSymbol("boxShadow$")).toBe("boxShadow");
      expect(removeMergeSymbol("transform_")).toBe("transform");
    });
  });

  describe.concurrent("Get key info has merge symbol", () => {
    it("No Sign Symbol", () => {
      expect(mergeKeyInfo("boxShadow")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: false,
        isMergeSymbol: false
      });
    });
    it("Has Sign Symbol to the end", () => {
      expect(mergeKeyInfo("boxShadow$")).toStrictEqual({
        isMergeToComma: true,
        isMergeToSpace: false,
        isMergeSymbol: true
      });
      expect(mergeKeyInfo("transform_")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: true,
        isMergeSymbol: true
      });
    });
    it("Has Sign Symbol in the middle or at the first", () => {
      expect(mergeKeyInfo("box$Shadow")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: false,
        isMergeSymbol: false
      });
      expect(mergeKeyInfo("trans_form")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: false,
        isMergeSymbol: false
      });
      expect(mergeKeyInfo("$boxShadow")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: false,
        isMergeSymbol: false
      });
      expect(mergeKeyInfo("_transform")).toStrictEqual({
        isMergeToComma: false,
        isMergeToSpace: false,
        isMergeSymbol: false
      });
    });
  });
}

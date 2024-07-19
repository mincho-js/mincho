import { convertToCSSVar } from "../utils/string";

// == Interface ================================================================
export function isCSSVarKey(keyStr: string) {
  return keyStr.startsWith("$");
}

export function isPureCSSVarKey(keyStr: string) {
  return keyStr.startsWith("--");
}

export function isVarsKey(keyStr: string) {
  return keyStr === "vars";
}

export function replaceCSSVarKey(keyStr: string) {
  return convertToCSSVar(keyStr);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Replace CSS Var value", () => {
    it("Is css var key", () => {
      expect(isCSSVarKey("$myCssVariable")).toBeTruthy();
      expect(isPureCSSVarKey("--my-css-variable")).toBeTruthy();

      expect(isCSSVarKey("-my-css-variable")).toBeFalsy();
      expect(isPureCSSVarKey("-my-css-variable")).toBeFalsy();
      expect(isCSSVarKey("_hover")).toBeFalsy();
      expect(isPureCSSVarKey("_hover")).toBeFalsy();
    });

    it("Convert to css var", () => {
      expect(replaceCSSVarKey("$myCssVariable")).toBe("--my-css-variable");
      expect(replaceCSSVarKey("$my-css-variable")).toBe("--my-css-variable");
    });
  });
}

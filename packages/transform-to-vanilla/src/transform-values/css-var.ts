import { convertToCSSVar } from "../utils/string";

// == Interface ================================================================
const cssVarRegex = /\B\$[\w-_]+/g;
export function replaceCSSVar(value: string) {
  return value.replace(cssVarRegex, (matched) => {
    const cssVar = convertToCSSVar(matched);
    return `var(${cssVar})`;
  });
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Replace CSS Var value", () => {
    it("Convert to css var", () => {
      expect(replaceCSSVar("$myCssVariable")).toBe("var(--my-css-variable)");
      expect(replaceCSSVar("$red1")).toBe("var(--red1)");
      expect(replaceCSSVar("$red-2")).toBe("var(--red-2)");
      expect(replaceCSSVar("calc($myCssVariable - 10%)")).toBe(
        "calc(var(--my-css-variable) - 10%)"
      );
    });

    it("Not replace", () => {
      expect(replaceCSSVar("calc(100px - var(--my-var$))")).toBe(
        "calc(100px - var(--my-var$))"
      );
    });
  });
}

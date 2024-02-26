import { camelToKebab } from "../utils/string";

// == Interface ================================================================
const cssVarRegex = /\B\$\w+/g;
export function replaceCSSVar(value: string) {
  return value.replace(cssVarRegex, (matched) => {
    const without$ = matched.substring(1);
    const kebabCase = camelToKebab(without$);
    return `var(--${kebabCase})`;
  });
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Replace CSS Var value", () => {
    it("Convert to css var", () => {
      expect(replaceCSSVar("$myCssVariable")).toBe("var(--my-css-variable)");
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

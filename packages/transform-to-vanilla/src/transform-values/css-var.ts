import { convertToCSSVar } from "../utils/string";

// == Interface ================================================================
const cssVarRegex = /\B\$([\w-_]+)(?:\((.*?)\))?/g;
export function replaceCSSVar(value: string): string {
  return value.replace(cssVarRegex, (matched) => {
    const index = matched.indexOf("(");
    if (index === -1) {
      const cssVar = convertToCSSVar(matched);
      return `var(${cssVar})`;
    }
    const varPart = matched.substring(0, index);
    const fallbackPart = matched.substring(index + 1, matched.length - 1);

    const varConverted = convertToCSSVar(varPart);
    const fallbackConverted = replaceCSSVar(fallbackPart);
    return `var(${varConverted}, ${fallbackConverted})`;
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

    it("Convert to css fallback var", () => {
      expect(replaceCSSVar("$myCssVariable1($myCssVariable2)")).toBe(
        "var(--my-css-variable1, var(--my-css-variable2))"
      );
      expect(replaceCSSVar("$red1($red-2)")).toBe("var(--red1, var(--red-2))");
      expect(
        replaceCSSVar("$red-3(color-mix(in srgb, #34c9eb 20%, white))")
      ).toBe("var(--red-3, color-mix(in srgb, #34c9eb 20%, white))");
      expect(replaceCSSVar("calc($myCssVariable(auto) - 10%)")).toBe(
        "calc(var(--my-css-variable, auto) - 10%)"
      );
    });

    it.todo("Convet to nested css fallback var", () => {
      expect(
        replaceCSSVar("$myCssVariable1($myCssVariable2($myCssVariable3))")
      ).toBe(
        "var(--my-css-variable1, var(--my-css-variable2, var(var(--my-css-variable2))))"
      );
      expect(
        replaceCSSVar("calc($myCssVariable4($my-css-variable5(5px)) - 1px)")
      ).toBe(
        "calc(var(--my-css-variable4, var(--my-css-variable5, 5px)) - 1px)"
      );
    });

    it("Not replace", () => {
      expect(replaceCSSVar("calc(100px - var(--my-var$))")).toBe(
        "calc(100px - var(--my-var$))"
      );
    });
  });
}

import { convertToCSSVar } from "../utils/string";

// == Interface ================================================================
export function replaceCSSVar(input: string) {
  let parenLevel = 0;
  let isInVariable = false;
  const resultParts: string[] = [];
  const stack: CSSVarItem[] = [];

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "$") {
      stack.push({
        varPart: "$",
        fallbackPart: "",
        parenLevel
      });
      isInVariable = true;
    } else if (stack.length === 0) {
      resultParts.push(char);
    } else if (char === "(") {
      parenLevel += 1;
      if (isInVariable) {
        isInVariable = false;
        stack[stack.length - 1].parenLevel = parenLevel;
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
    } else if (char === ")") {
      if (stack[stack.length - 1].parenLevel === parenLevel) {
        if (stack.length > 1) {
          do {
            stackResolve(stack);
          } while (
            stack.length > 1 &&
            stack[stack.length - 1].parenLevel === parenLevel
          );
        } else {
          if (stack[stack.length - 1].varPart.length <= 1) {
            stack[stack.length - 1].fallbackPart += char;
          }
          resultParts.push(stackPop(stack));
        }
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
      parenLevel -= 1;
    } else if (isVarChar(char)) {
      if (isInVariable) {
        stack[stack.length - 1].varPart += char;
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
    } else {
      isInVariable = false;
      if (stack[stack.length - 1].fallbackPart.length > 0) {
        stack[stack.length - 1].fallbackPart += char;
      } else {
        resultParts.push(`${stackPop(stack)}${char}`);
      }
    }
  }

  if (stack.length > 0) {
    while (stack.length > 1) {
      stackResolve(stack);
    }
    resultParts.push(stackPop(stack));
  }

  return resultParts.join("");
}

// == Utils ====================================================================
interface CSSVarItem {
  varPart: string;
  fallbackPart: string;
  parenLevel: number;
}
function stackResolve(stack: CSSVarItem[]) {
  const { varPart, fallbackPart } = stack.pop() ?? {
    varPart: "",
    fallbackPart: ""
  };
  stack[stack.length - 1].fallbackPart += getVarValue(varPart, fallbackPart);
}
function stackPop(stack: CSSVarItem[]) {
  const { varPart, fallbackPart } = stack.pop() ?? {
    varPart: "",
    fallbackPart: ""
  };
  return getVarValue(varPart, fallbackPart);
}

function getVarValue(varPart: string, fallbackPart: string) {
  return varPart.length <= 1
    ? `${varPart}${fallbackPart}`
    : fallbackPart === ""
    ? `var(${convertToCSSVar(varPart)})`
    : `var(${convertToCSSVar(varPart)}, ${fallbackPart})`;
}

// Target
// [\w-] == [a-zA-Z0-9_-]
// ASCII: a-z(97~122), A-Z(65~90), 0-9(48~57), _(95), -(45)
function isVarChar(char: string) {
  const ascii = char.charCodeAt(0);
  return (
    ascii === 45 ||
    (ascii >= 48 && ascii <= 57) ||
    (ascii >= 65 && ascii <= 90) ||
    (ascii >= 97 && ascii <= 122) ||
    ascii === 95
  );
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

    it("Convet to nested css fallback var", () => {
      expect(
        replaceCSSVar("$myCssVariable1($myCssVariable2($myCssVariable3))")
      ).toBe(
        "var(--my-css-variable1, var(--my-css-variable2, var(--my-css-variable3)))"
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

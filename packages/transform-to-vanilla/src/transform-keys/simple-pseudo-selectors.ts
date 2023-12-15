import { NonNullableString } from "../types/string";
import { SimplePseudos } from "../types/simple-pseudo";

// == Type ================================================================
type PseudoSelectorsSign = `_${string}` | `__${string}`;
type InputKeyValue = NonNullableString | PseudoSelectorsSign;
type ReturnKeyValue = NonNullableString | SimplePseudos;

// == Interface ================================================================
export function replacePseudoSelectors(keyStr: InputKeyValue): ReturnKeyValue {
  const kebabKeyStr = keyStr.startsWith("_") ? camelToKebab(keyStr) : keyStr;

  return hasSinglePseudoSelector(kebabKeyStr)
    ? `:${kebabKeyStr.substring(1, kebabKeyStr.length)}`
    : hasDoublePseudoSelector(kebabKeyStr)
    ? `::${kebabKeyStr.substring(2, kebabKeyStr.length)}`
    : kebabKeyStr;
}

// == Utils ====================================================================
function camelToKebab(camelCase: InputKeyValue) {
  return camelCase.replace(/[A-Z]/g, "-$&").toLowerCase();
}
function hasSinglePseudoSelector(
  value: InputKeyValue
): value is PseudoSelectorsSign {
  return value.startsWith("_") && !value.startsWith("__");
}
function hasDoublePseudoSelector(
  value: InputKeyValue
): value is PseudoSelectorsSign {
  return value.startsWith("__");
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect, expectTypeOf } = import.meta.vitest;

  describe.concurrent("Replace Simple Pseudo Selectors Sign", () => {
    it("No Simple Pseudo", () => {
      expect(replacePseudoSelectors("after")).toBe("after");
      expect(replacePseudoSelectors("backgroundColor")).toBe("backgroundColor");
      expect(replacePseudoSelectors(".myClassName > &")).toBe(
        ".myClassName > &"
      );
      expect(replacePseudoSelectors("&:hover:not(:active)")).toBe(
        "&:hover:not(:active)"
      );
      expect(replacePseudoSelectors("@supports (display: grid)")).toBe(
        "@supports (display: grid)"
      );
    });
    it("Has Single or Double Simple Pseudo at the first", () => {
      const singleSimplePseudo = replacePseudoSelectors("_hover");
      expect(singleSimplePseudo).toBe(":hover");
      expectTypeOf(singleSimplePseudo).toEqualTypeOf<ReturnKeyValue>();

      const doubleSimplePseudo = replacePseudoSelectors("__before");
      expect(doubleSimplePseudo).toBe("::before");
      expectTypeOf(doubleSimplePseudo).toEqualTypeOf<ReturnKeyValue>();

      const doubleSimplePseudoWithCamel =
        replacePseudoSelectors("__firstOfType");
      expect(doubleSimplePseudoWithCamel).toBe("::first-of-type");
      expectTypeOf(doubleSimplePseudoWithCamel).toEqualTypeOf<ReturnKeyValue>();
    });
    it("Has Triple Simple Pseudo at the first", () => {
      const tripleSimplePseudo = replacePseudoSelectors("___active");
      expect(tripleSimplePseudo).toBe("::_active");
      expectTypeOf(tripleSimplePseudo).toEqualTypeOf<ReturnKeyValue>();
    });
    it("Has Simple Pseudo in the middle or at the end", () => {
      expect(replacePseudoSelectors("hover_")).toBe("hover_");
      expect(replacePseudoSelectors("ho_ver")).toBe("ho_ver");
      expect(replacePseudoSelectors("firstOfType_")).toBe("firstOfType_");
      expect(replacePseudoSelectors("first_OfType_")).toBe("first_OfType_");
      expect(replacePseudoSelectors("before__")).toBe("before__");
      expect(replacePseudoSelectors("be_fore__")).toBe("be_fore__");
    });
  });
}

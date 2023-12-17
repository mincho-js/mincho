import { NonNullableString } from "../types/string";
import { SimplePseudos, CamelPseudos } from "../types/simple-pseudo";

// == Type ================================================================
type PseudoSelectorsSign = `_${string}` | `__${string}`;
type InputKeyValue = NonNullableString | CamelPseudos;
type ReturnKeyValue = NonNullableString | SimplePseudos;

// == Interface ================================================================
export function replacePseudoSelectors(keyStr: CamelPseudos): SimplePseudos;
export function replacePseudoSelectors(
  keyStr: NonNullableString
): NonNullableString;
export function replacePseudoSelectors(keyStr: InputKeyValue): ReturnKeyValue {
  const kebabKeyStr = keyStr.startsWith("_") ? camelToKebab(keyStr) : keyStr;

  return hasSinglePseudoSelector(kebabKeyStr)
    ? `:${kebabKeyStr.substring(1, kebabKeyStr.length)}`
    : hasDoublePseudoSelector(kebabKeyStr)
    ? `::${kebabKeyStr.substring(2, kebabKeyStr.length)}`
    : kebabKeyStr;
}

// == Utils ====================================================================
const upperCaseRegex = /[A-Z]/g;
function camelToKebab(camelCase: InputKeyValue) {
  return camelCase.replace(upperCaseRegex, "-$&").toLowerCase();
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
      const after = replacePseudoSelectors("after");
      expect(after).toBe("after");
      expectTypeOf(after).toEqualTypeOf<NonNullableString>();

      const backgroundColor = replacePseudoSelectors("backgroundColor");
      expect(backgroundColor).toBe("backgroundColor");
      expectTypeOf(backgroundColor).toEqualTypeOf<NonNullableString>();

      const complexSelector = replacePseudoSelectors(".myClass-Name > &");
      expect(complexSelector).toBe(".myClass-Name > &");
      expectTypeOf(complexSelector).toEqualTypeOf<NonNullableString>();

      const otherComplexSelector = replacePseudoSelectors(
        "&:hover:not(:active)"
      );
      expect(otherComplexSelector).toBe("&:hover:not(:active)");
      expectTypeOf(otherComplexSelector).toEqualTypeOf<NonNullableString>();

      const atRules = replacePseudoSelectors("@supports (display: grid)");
      expect(atRules).toBe("@supports (display: grid)");
      expectTypeOf(atRules).toEqualTypeOf<NonNullableString>();
    });
    it("Has Single or Double Simple Pseudo at the first", () => {
      const singleSimplePseudo = replacePseudoSelectors("_hover");
      expect(singleSimplePseudo).toBe(":hover");
      expectTypeOf(singleSimplePseudo).toEqualTypeOf<SimplePseudos>();

      const doubleSimplePseudo = replacePseudoSelectors("__before");
      expect(doubleSimplePseudo).toBe("::before");
      expectTypeOf(doubleSimplePseudo).toEqualTypeOf<SimplePseudos>();

      const simplePseudoWithCamel = replacePseudoSelectors("_firstOfType");
      expect(simplePseudoWithCamel).toBe(":first-of-type");
      expectTypeOf(simplePseudoWithCamel).toEqualTypeOf<SimplePseudos>();

      const doubleSimplePseudoWithCamel =
        replacePseudoSelectors("__firstLetter");
      expect(doubleSimplePseudoWithCamel).toBe("::first-letter");
      expectTypeOf(doubleSimplePseudoWithCamel).toEqualTypeOf<SimplePseudos>();
    });
    it("Has Triple Simple Pseudo at the first", () => {
      const tripleSimplePseudo = replacePseudoSelectors("___active");
      expect(tripleSimplePseudo).toBe("::_active");
      expectTypeOf(tripleSimplePseudo).toEqualTypeOf<NonNullableString>();
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

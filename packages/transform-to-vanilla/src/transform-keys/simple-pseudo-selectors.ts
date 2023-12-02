// == Type ================================================================
type DefaultType = string & NonNullable<unknown>;
type PseudoSelectorsSign = `_${string}` | `__${string}`;
type ReplacedPseudoSelectorsSign = `:${string}` | `::${string}`;
type InputKeyValue = DefaultType | PseudoSelectorsSign;
type ReturnKeyValue = DefaultType | ReplacedPseudoSelectorsSign;

// == Interface ================================================================
export function replacePseudoSelectors(keyStr: InputKeyValue): ReturnKeyValue {
  const kebabKeyStr = camelToKebab(keyStr);

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
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Replace Simple Pseudo Selectors Sign", () => {
    it("No Simple Pseudo Selectors Sign", () => {
      expect(replacePseudoSelectors("after")).toBe("after");
    });
    it("Has Simple Pseudo Selectors Sign to the first", () => {
      expect(replacePseudoSelectors("_hover")).toBe(":hover");
      expect(replacePseudoSelectors("_firstOfType")).toBe(":first-of-type");
      expect(replacePseudoSelectors("__before")).toBe("::before");
      expect(replacePseudoSelectors("___before")).toBe("::_before");
    });
    it("Has Simple Pseudo Selectors Sign in the middle or at the end", () => {
      expect(replacePseudoSelectors("hover_")).toBe("hover_");
      expect(replacePseudoSelectors("ho_ver")).toBe("ho_ver");
      expect(replacePseudoSelectors("firstOfType_")).toBe("first-of-type_");
      expect(replacePseudoSelectors("first_OfType_")).toBe("first_-of-type_");
      expect(replacePseudoSelectors("before__")).toBe("before__");
      expect(replacePseudoSelectors("be_fore__")).toBe("be_fore__");
    });
  });
}

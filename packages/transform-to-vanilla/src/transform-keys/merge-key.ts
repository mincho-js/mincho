import { NonNullableString } from "../types/string";

// == Type ================================================================
type HasSignInString = `${NonNullableString}$` | `${NonNullableString}_`;
type InputKeyValue = NonNullableString | HasSignInString;

// == Interface ================================================================
export function removeSignSimbol(keyStr: InputKeyValue) {
  return hasSignSimbol(keyStr)
    ? keyStr.substring(0, keyStr.length - 1)
    : keyStr;
}

// == Utils ====================================================================
function hasSignSimbol(value: InputKeyValue): value is HasSignInString {
  return value.endsWith("$") || value.endsWith("_");
}

// == Tests ====================================================================
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Remove Key Sign Symbol", () => {
    it("No Sign Symbol", () => {
      expect(removeSignSimbol("boxShadow")).toBe("boxShadow");
    });
    it("Has Sign Symbol to the end", () => {
      expect(removeSignSimbol("boxShadow$")).toBe("boxShadow");
      expect(removeSignSimbol("transform_")).toBe("transform");
    });
    it("Has Sign Symbol in the middle or at the first", () => {
      expect(removeSignSimbol("box$Shadow")).toBe("box$Shadow");
      expect(removeSignSimbol("trans_form")).toBe("trans_form");
      expect(removeSignSimbol("$boxShadow")).toBe("$boxShadow");
      expect(removeSignSimbol("_transform")).toBe("_transform");
    });
  });
}

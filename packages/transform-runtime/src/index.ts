type VxValue = string | number | boolean | null | undefined;
const inheritanceBlockingFallback = "var(--c-, )";

export function vx(
  value: string | number,
  suffix?: string | null,
  numericOnly?: boolean
): string | number;
export function vx(
  value: boolean | null | undefined,
  suffix?: string | null,
  numericOnly?: boolean
): string;
export function vx(
  value: VxValue,
  suffix?: string | null,
  numericOnly?: boolean
): string | number;
export function vx(
  value: VxValue,
  suffix?: string | null,
  numericOnly = false
): string | number {
  if (value === null || value === undefined || typeof value === "boolean") {
    return inheritanceBlockingFallback;
  }

  if (suffix && (!numericOnly || typeof value === "number")) {
    return `${value}${suffix}`;
  }

  return value;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when compiling ESM.
const vitest = import.meta.vitest;

if (vitest) {
  const { describe, expect, it } = vitest;

  describe("vx", () => {
    it("blocks inherited custom properties when value is absent or boolean", () => {
      expect(vx(null)).toBe(inheritanceBlockingFallback);
      expect(vx(undefined)).toBe(inheritanceBlockingFallback);
      expect(vx(false)).toBe(inheritanceBlockingFallback);
      expect(vx(true)).toBe(inheritanceBlockingFallback);
    });

    it("preserves string and number values, including zero", () => {
      expect(vx("red")).toBe("red");
      expect(vx(8)).toBe(8);
      expect(vx(0)).toBe(0);
    });

    it("appends suffixes to defined string and number values", () => {
      expect(vx(8, "px")).toBe("8px");
      expect(vx(50, "%")).toBe("50%");
      expect(vx("1.5", "rem")).toBe("1.5rem");
      expect(vx(2, "x")).toBe("2x");
    });

    it("adds implicit units only to numbers and preserves missing values", () => {
      expect(vx(10, "px", true)).toBe("10px");
      expect(vx(0, "px", true)).toBe("0px");
      expect(vx(-2.5, "px", true)).toBe("-2.5px");
      expect(vx("2rem", "px", true)).toBe("2rem");
      expect(vx("auto", "px", true)).toBe("auto");
      expect(vx(null, "px", true)).toBe(inheritanceBlockingFallback);
    });
  });
}

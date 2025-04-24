import {
  type TransformContext,
  initTransformContext
} from "../transform-object/index.js";

export function isSelectorsKey(key: string) {
  return key === "selectors";
}

export function isComplexKey(key: string) {
  return key.includes("&");
}

export function isSimpleSelectorKey(key: string) {
  return key.startsWith("[") || key.startsWith(":");
}

export function nestedSelectorKey(key: string, context: TransformContext) {
  const parentSelectors = splitSelector(context.parentSelector);
  const result = [];

  const parentSelectorsLength = parentSelectors.length;
  for (let i = 0; i < parentSelectorsLength; i++) {
    const selector = parentSelectors[i].trim();
    const replacedKey = key.replaceAll("&", selector);
    result.push(replacedKey);
  }

  return result.join(", ");
}

function splitSelector(selector: string): string[] {
  if (!selector.includes(",")) {
    return [selector];
  }

  const result = [];
  let currentSelector = "";
  let parenLevel = 0;
  let bracketLevel = 0;

  const selectorLength = selector.length;
  for (let i = 0; i < selectorLength; i++) {
    const char = selector[i];

    switch (char) {
      case "(":
        parenLevel++;
        currentSelector += char;
        break;
      case ")":
        parenLevel--;
        currentSelector += char;
        break;
      case "[":
        bracketLevel++;
        currentSelector += char;
        break;
      case "]":
        bracketLevel--;
        currentSelector += char;
        break;
      case ",":
        if (parenLevel === 0 && bracketLevel === 0) {
          result.push(currentSelector);
          currentSelector = "";
        } else {
          currentSelector += char;
        }
        break;
      default:
        currentSelector += char;
        break;
    }
  }

  if (currentSelector.trim() !== "") {
    result.push(currentSelector);
  }

  return result;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("Is complex selector", () => {
    it("selectors", () => {
      expect(isSelectorsKey("selectors")).toBeTruthy();
    });

    it("complex selector", () => {
      expect(isComplexKey("&:hover:not(:active)")).toBeTruthy();
      expect(isComplexKey("nav li > &")).toBeTruthy();
    });

    it("Not complex selector", () => {
      expect(isComplexKey(":hover")).toBeFalsy();
    });

    it("Simple Selector", () => {
      expect(
        isSimpleSelectorKey(`[href^="https://"][href$=".org"]`)
      ).toBeTruthy();
      expect(isSimpleSelectorKey(":hover:active")).toBeTruthy();
    });

    it("Nested Selector", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &"
      };
      expect(nestedSelectorKey("&:hover", context)).toBe("nav li > &:hover");
      expect(nestedSelectorKey("&:hover:not(:active)", context)).toBe(
        "nav li > &:hover:not(:active)"
      );
      expect(nestedSelectorKey(":root[dir=rtl] &", context)).toBe(
        ":root[dir=rtl] nav li > &"
      );
    });

    it("Nested Selector with Commas", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: "nav li > &, .myClass > &[data-attr-value]"
      };
      expect(nestedSelectorKey("&:hover", context)).toBe(
        "nav li > &:hover, .myClass > &[data-attr-value]:hover"
      );
      expect(nestedSelectorKey("&:hover:not(:active)", context)).toBe(
        "nav li > &:hover:not(:active), .myClass > &[data-attr-value]:hover:not(:active)"
      );
      expect(nestedSelectorKey(":root[dir=rtl] &", context)).toBe(
        ":root[dir=rtl] nav li > &, :root[dir=rtl] .myClass > &[data-attr-value]"
      );
    });

    it("Complex Nested Selectors", () => {
      const context: TransformContext = {
        ...structuredClone(initTransformContext),
        parentSelector: `nav li > &:hover:not(:active, :disabled, [data-list="a, b, c"]), .myClass > &[data-attr-value]:where(:has(> :hover, + :focus), :active)`
      };
      expect(nestedSelectorKey("&::before", context)).toBe(
        `nav li > &:hover:not(:active, :disabled, [data-list="a, b, c"])::before, .myClass > &[data-attr-value]:where(:has(> :hover, + :focus), :active)::before`
      );
      expect(nestedSelectorKey(":root[dir=rtl] &", context)).toBe(
        `:root[dir=rtl] nav li > &:hover:not(:active, :disabled, [data-list="a, b, c"]), :root[dir=rtl] .myClass > &[data-attr-value]:where(:has(> :hover, + :focus), :active)`
      );
    });
  });
}

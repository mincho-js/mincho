import { createVar } from "@vanilla-extract/css";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import type { PureCSSVarKey } from "@mincho-js/transform-to-vanilla";

export function identifierName(...debugIds: Array<string | undefined>) {
  const hashRegex = "[_a-zA-Z0-9]+";
  const classStr = debugIds
    .map((id) => (id === undefined ? hashRegex : `${id}__${hashRegex}`))
    .join(" ");
  return new RegExp(`^${classStr}$`);
}

export function getDebugName(debugId: string | undefined, name: string) {
  return debugId ? `${debugId}_${name}` : name;
}

// Optimized version
// https://github.com/vanilla-extract-css/vanilla-extract/blob/master/packages/private/src/getVarName.ts
const VAR_PREFIX_LENGTH = "var(".length;
export function getVarName(variable: string): PureCSSVarKey {
  if (variable.startsWith("var(") && variable.endsWith(")")) {
    const inside = variable.slice(VAR_PREFIX_LENGTH, -1);
    const commaIndex = inside.indexOf(",");
    return (
      commaIndex === -1 ? inside : inside.slice(0, commaIndex)
    ) as PureCSSVarKey;
  }
  return variable as PureCSSVarKey;
}

export function camelToKebab(camelCase: string): string {
  return camelCase.replace(/[A-Z]/g, "-$&").toLowerCase();
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  setFileScope("test");

  describe("getVarName", () => {
    it("string", () => {
      expect(getVarName("--my-var-name")).toBe("--my-var-name");
      expect(getVarName("just string")).toBe("just string");
    });

    it("var string", () => {
      expect(getVarName("var(--my-var-name)")).toBe("--my-var-name");
      expect(getVarName("var(--myCss-var-name23)")).toBe("--myCss-var-name23");
    });

    it("fallback", () => {
      expect(getVarName("var(--my-var-name, 1px)")).toBe("--my-var-name");
      expect(getVarName("var(--myCss-var-name23, none)")).toBe(
        "--myCss-var-name23"
      );
    });

    it("createVar", () => {
      expect(getVarName(createVar("my-var-name"))).toMatch(
        identifierName(`--my-var-name`)
      );
      expect(getVarName(createVar("myCss-var-name23"))).toMatch(
        identifierName(`--myCss-var-name23`)
      );
    });
  });
}

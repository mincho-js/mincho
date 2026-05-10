export type DefineRulesConditionObject = {
  "@layer"?: string;
  "@supports"?: string;
  "@media"?: string;
  "@container"?: string;
  selector?: string;
};

export interface NormalizedCondition {
  layer: string | null;
  supports: string | null;
  media: string | null;
  container: string | null;
  selector: string;
}

export type DefineRulesCondition = string | DefineRulesConditionObject;

export type DefineRulesConditions = Record<string, DefineRulesCondition>;
export type ConditionAliasValue = string | DefineRulesConditionObject;
export type ConditionAliasMap = Record<`_${string}`, ConditionAliasValue>;

export type DefineRulesConditionAliasKey<
  Conditions extends DefineRulesConditions
> = `_${Extract<keyof Conditions, string>}`;

const CONDITION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const MEDIA_PREFIX_PATTERN = /^@media\s+/;
const ALLOWED_CONDITION_KEYS = new Set([
  "@layer",
  "@supports",
  "@media",
  "@container",
  "selector"
]);
const RESERVED_CONDITION_ALIASES = new Set([
  "_hover",
  "__before",
  "_media",
  "_supports",
  "_container",
  "_layer",
  "_selector",
  "_base"
]);

export function normalizeDefineRulesConditions(
  conditions: DefineRulesConditions | undefined
): ConditionAliasMap {
  if (conditions == null) {
    return {};
  }

  const normalized: ConditionAliasMap = {};

  for (const [name, value] of Object.entries(conditions)) {
    validateDefineRulesConditionName(name);
    normalized[`_${name}`] = normalizeDefineRulesConditionValue(value, name);
  }

  return normalized;
}

export function validateDefineRulesConditionName(name: string): void {
  const alias = `_${name}`;

  if (!CONDITION_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid defineRules condition name "${name}". Condition names must match ${CONDITION_NAME_PATTERN}.`
    );
  }

  if (RESERVED_CONDITION_ALIASES.has(alias)) {
    throw new Error(`Reserved defineRules condition alias "${alias}".`);
  }
}

export function normalizeDefineRulesConditionValue(
  value: DefineRulesCondition,
  name = "<condition>"
): ConditionAliasValue {
  if (typeof value === "string") {
    return normalizeMediaQuery(value);
  }

  if (!isPlainRecordObject(value)) {
    throw new Error(`Unsupported defineRules condition value for "${name}".`);
  }

  const condition: DefineRulesConditionObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!ALLOWED_CONDITION_KEYS.has(key)) {
      throw new Error(
        `Unsupported defineRules condition key "${key}" for "${name}".`
      );
    }

    if (typeof entry !== "string") {
      throw new Error(
        `Unsupported defineRules condition value at "${name}.${key}".`
      );
    }

    condition[key as keyof DefineRulesConditionObject] =
      key === "@media" ? normalizeMediaQuery(entry) : entry;
  }

  return condition;
}

function normalizeMediaQuery(query: string): string {
  return query.replace(MEDIA_PREFIX_PATTERN, "");
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  describe.concurrent("defineRules conditions", () => {
    it("normalizes base, string, prefixed string, and object condition configs", () => {
      expect(
        normalizeDefineRulesConditions({
          mobile: {},
          tablet: "screen and (min-width: 768px)",
          desktop: "@media screen and (min-width: 1024px)",
          grid: {
            "@supports": "(display: grid)",
            "@media": "@media screen and (min-width: 1280px)"
          }
        })
      ).toEqual({
        _mobile: {},
        _tablet: "screen and (min-width: 768px)",
        _desktop: "screen and (min-width: 1024px)",
        _grid: {
          "@supports": "(display: grid)",
          "@media": "screen and (min-width: 1280px)"
        }
      });
    });

    it("canonicalizes string and object media condition configs", () => {
      expect(
        normalizeDefineRulesConditionValue(
          "@media screen and (min-width: 768px)",
          "tablet"
        )
      ).toBe("screen and (min-width: 768px)");
      expect(
        normalizeDefineRulesConditionValue(
          {
            "@media": "@media screen and (min-width: 768px)"
          },
          "tablet"
        )
      ).toEqual({
        "@media": "screen and (min-width: 768px)"
      });
    });

    it("rejects invalid bare condition names", () => {
      expect(() => validateDefineRulesConditionName("_mobile")).toThrow(
        'Invalid defineRules condition name "_mobile"'
      );
      expect(() => validateDefineRulesConditionName("@mobile")).toThrow(
        'Invalid defineRules condition name "@mobile"'
      );
    });

    it("rejects reserved aliases", () => {
      expect(() => validateDefineRulesConditionName("hover")).toThrow(
        'Reserved defineRules condition alias "_hover"'
      );
      expect(() => validateDefineRulesConditionName("media")).toThrow(
        'Reserved defineRules condition alias "_media"'
      );
      expect(() => validateDefineRulesConditionName("base")).toThrow(
        'Reserved defineRules condition alias "_base"'
      );
    });

    it("rejects invalid condition object keys", () => {
      expect(() =>
        normalizeDefineRulesConditionValue(
          {
            unknown: "value"
          } as never,
          "mobile"
        )
      ).toThrow('Unsupported defineRules condition key "unknown"');
    });
  });
}

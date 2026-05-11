import {
  atRuleKeyInfo,
  atRuleKeyMerge,
  isRuleKey
} from "../transform-keys/at-rules.js";
import {
  isComplexKey,
  isSelectorsKey,
  isSimpleSelectorKey,
  nestedSelectorKey
} from "../transform-keys/complex-selectors.js";
import {
  isCSSVarKey,
  isPureCSSVarKey,
  isVarsKey,
  replaceCSSVarKey
} from "../transform-keys/css-var.js";
import {
  mergeKeyInfo,
  removeMergeSymbol
} from "../transform-keys/merge-key.js";
import {
  isSimplePseudoSelectorKey,
  replacePseudoSelectors
} from "../transform-keys/simple-pseudo-selectors.js";
import type { CSSRule } from "../types/style-rule.js";
import { isUppercase } from "../utils/string.js";
import type { AtRulesPrefix, TransformContext } from "./index.js";

export interface NormalizedCondition {
  layer: string | null;
  supports: string | null;
  media: string | null;
  container: string | null;
  selector: string;
}

export interface CollectedStyleDeclaration {
  condition: NormalizedCondition;
  property: string;
  value: unknown;
}

export type ConditionAliasValue =
  | string
  | {
      "@layer"?: string;
      "@supports"?: string;
      "@media"?: string;
      "@container"?: string;
      selector?: string;
    };
export type ConditionAliasMap = Record<`_${string}`, ConditionAliasValue>;

export interface CollectStyleDeclarationsOptions {
  conditions?: ConditionAliasMap;
}

type ConditionKey = Exclude<keyof NormalizedCondition, "selector">;

const defaultCondition = {
  layer: null,
  supports: null,
  media: null,
  container: null,
  selector: "&"
} satisfies NormalizedCondition;

const conditionAtRules = {
  layer: "@layer",
  supports: "@supports",
  media: "@media",
  container: "@container"
} as const satisfies Record<ConditionKey, AtRulesPrefix>;

export function collectStyleDeclarations(
  style: CSSRule,
  options: CollectStyleDeclarationsOptions = {}
): CollectedStyleDeclaration[] {
  const declarations: CollectedStyleDeclaration[] = [];

  collectStyle(style, defaultCondition, options.conditions ?? {}, declarations);

  return declarations;
}

function collectStyle(
  style: CSSRule,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  for (const [key, value] of Object.entries(style)) {
    if (isSelectorsKey(key)) {
      collectSelectors(value, condition, aliases, declarations);
    } else if (isComplexKey(key)) {
      collectStyleValue(
        value,
        composeSelectorCondition(condition, key),
        aliases,
        declarations
      );
    } else if (hasAlias(key, aliases)) {
      const aliasKey = key as `_${string}`;
      collectStyleValue(
        value,
        composeAliasCondition(condition, aliases[aliasKey]),
        aliases,
        declarations
      );
    } else if (isSimplePseudoSelectorKey(key)) {
      collectStyleValue(
        value,
        composeSelectorCondition(condition, `&${replacePseudoSelectors(key)}`),
        aliases,
        declarations
      );
    } else if (isSimpleSelectorKey(key)) {
      collectStyleValue(
        value,
        composeSelectorCondition(condition, `&${key}`),
        aliases,
        declarations
      );
    } else if (isVarsKey(key)) {
      collectVars(value, condition, declarations);
    } else if (isCSSVarKey(key)) {
      collectDeclaration(replaceCSSVarKey(key), value, condition, declarations);
    } else if (isPureCSSVarKey(key)) {
      collectDeclaration(key, value, condition, declarations);
    } else if (isRuleKey(key)) {
      collectAtRuleValue(key, value, condition, aliases, declarations);
    } else {
      collectPropertyValue(
        normalizePropertyName(key),
        value,
        condition,
        aliases,
        declarations
      );
    }
  }
}

function collectSelectors(
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  if (!isRecord(value)) {
    return;
  }

  for (const [selector, selectorStyle] of Object.entries(value)) {
    collectStyleValue(
      selectorStyle,
      composeSelectorCondition(condition, selector),
      aliases,
      declarations
    );
  }
}

function collectVars(
  value: unknown,
  condition: NormalizedCondition,
  declarations: CollectedStyleDeclaration[]
) {
  if (!isRecord(value)) {
    return;
  }

  for (const [key, varValue] of Object.entries(value)) {
    collectDeclaration(
      isCSSVarKey(key) ? replaceCSSVarKey(key) : key,
      varValue,
      condition,
      declarations
    );
  }
}

function collectStyleValue(
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  if (isRecord(value)) {
    collectStyle(value as CSSRule, condition, aliases, declarations);
  }
}

function collectAtRuleValue(
  key: string,
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[],
  property?: string
) {
  const { isToplevelRules, atRuleKey, atRuleNestedKey } = atRuleKeyInfo(key);

  if (isToplevelRules) {
    collectConditionValue(
      value,
      composeAtRuleCondition(condition, atRuleKey, atRuleNestedKey),
      aliases,
      declarations,
      property
    );
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [atRuleNestedKey, atRuleValue] of Object.entries(value)) {
    collectConditionValue(
      atRuleValue,
      composeAtRuleCondition(condition, atRuleKey, atRuleNestedKey),
      aliases,
      declarations,
      property
    );
  }
}

function collectConditionValue(
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[],
  property?: string
) {
  if (property) {
    collectPropertyValue(property, value, condition, aliases, declarations);
    return;
  }

  collectStyleValue(value, condition, aliases, declarations);
}

function collectPropertyValue(
  property: string,
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  if (isPropertyConditionMap(value, aliases)) {
    collectPropertyMap(property, value, condition, aliases, declarations);
    return;
  }

  collectDeclaration(property, value, condition, declarations);
}

function collectPropertyMap(
  property: string,
  value: Record<string, unknown>,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "base") {
      collectPropertyValue(
        property,
        nestedValue,
        condition,
        aliases,
        declarations
      );
    } else if (isUppercase(key)) {
      collectPropertyValue(
        `${property}${key}`,
        nestedValue,
        condition,
        aliases,
        declarations
      );
    } else if (hasAlias(key, aliases)) {
      const aliasKey = key as `_${string}`;
      collectPropertyValue(
        property,
        nestedValue,
        composeAliasCondition(condition, aliases[aliasKey]),
        aliases,
        declarations
      );
    } else if (isSelectorsKey(key)) {
      collectPropertySelectors(
        property,
        nestedValue,
        condition,
        aliases,
        declarations
      );
    } else if (isComplexKey(key)) {
      collectPropertyValue(
        property,
        nestedValue,
        composeSelectorCondition(condition, key),
        aliases,
        declarations
      );
    } else if (isSimplePseudoSelectorKey(key)) {
      collectPropertyValue(
        property,
        nestedValue,
        composeSelectorCondition(condition, `&${replacePseudoSelectors(key)}`),
        aliases,
        declarations
      );
    } else if (isSimpleSelectorKey(key)) {
      collectPropertyValue(
        property,
        nestedValue,
        composeSelectorCondition(condition, `&${key}`),
        aliases,
        declarations
      );
    } else if (isRuleKey(key)) {
      collectAtRuleValue(
        key,
        nestedValue,
        condition,
        aliases,
        declarations,
        property
      );
    } else {
      collectPropertyValue(
        normalizePropertyName(key),
        nestedValue,
        condition,
        aliases,
        declarations
      );
    }
  }
}

function collectPropertySelectors(
  property: string,
  value: unknown,
  condition: NormalizedCondition,
  aliases: ConditionAliasMap,
  declarations: CollectedStyleDeclaration[]
) {
  if (!isRecord(value)) {
    return;
  }

  for (const [selector, selectorValue] of Object.entries(value)) {
    collectPropertyValue(
      property,
      selectorValue,
      composeSelectorCondition(condition, selector),
      aliases,
      declarations
    );
  }
}

function collectDeclaration(
  property: string,
  value: unknown,
  condition: NormalizedCondition,
  declarations: CollectedStyleDeclaration[]
) {
  declarations.push({
    condition: cloneCondition(condition),
    property,
    value
  });
}

function isPropertyConditionMap(
  value: unknown,
  aliases: ConditionAliasMap
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.keys(value).some(
    (key) =>
      key === "base" ||
      isUppercase(key) ||
      hasAlias(key, aliases) ||
      isSelectorsKey(key) ||
      isComplexKey(key) ||
      isSimplePseudoSelectorKey(key) ||
      isSimpleSelectorKey(key) ||
      isRuleKey(key)
  );
}

function composeAliasCondition(
  condition: NormalizedCondition,
  alias: ConditionAliasValue
) {
  if (typeof alias === "string") {
    return composeCondition(condition, {
      media: normalizeMediaCondition(alias)
    });
  }

  return composeCondition(condition, normalizeAliasCondition(alias));
}

function normalizeMediaCondition(value: string | undefined) {
  if (value === undefined) {
    return value;
  }

  return value.startsWith("@media ") ? value.substring(7) : value;
}

function normalizeAliasCondition(
  alias: Exclude<ConditionAliasValue, string>
): Partial<NormalizedCondition> {
  return {
    layer: alias["@layer"],
    supports: alias["@supports"],
    media: normalizeMediaCondition(alias["@media"]),
    container: alias["@container"],
    selector: alias.selector
  };
}

function composeCondition(
  condition: NormalizedCondition,
  nextCondition: Partial<NormalizedCondition>
) {
  let result = cloneCondition(condition);

  for (const key of Object.keys(conditionAtRules) as ConditionKey[]) {
    const value = nextCondition[key];

    if (value !== undefined && value !== null) {
      result = composeAtRuleCondition(result, conditionAtRules[key], value);
    }
  }

  if (nextCondition.selector !== undefined && nextCondition.selector !== null) {
    result = composeSelectorCondition(result, nextCondition.selector);
  }

  return result;
}

function composeAtRuleCondition(
  condition: NormalizedCondition,
  atRuleKey: string,
  atRuleValue: string
) {
  const conditionKey = getConditionKey(atRuleKey);

  if (!conditionKey) {
    return cloneCondition(condition);
  }

  return {
    ...condition,
    [conditionKey]: atRuleKeyMerge(
      atRuleKey as AtRulesPrefix,
      condition[conditionKey] ?? "",
      atRuleValue
    )
  } satisfies NormalizedCondition;
}

function composeSelectorCondition(
  condition: NormalizedCondition,
  selector: string
) {
  const normalizedSelector = selector.includes("&") ? selector : `&${selector}`;
  const nextSelector =
    condition.selector === "&"
      ? normalizedSelector
      : nestedSelectorKey(normalizedSelector, {
          parentSelector: condition.selector
        } as TransformContext);

  return {
    ...condition,
    selector: nextSelector
  } satisfies NormalizedCondition;
}

function getConditionKey(atRuleKey: string): ConditionKey | null {
  switch (atRuleKey) {
    case "@layer":
      return "layer";
    case "@supports":
      return "supports";
    case "@media":
      return "media";
    case "@container":
      return "container";
    default:
      return null;
  }
}

function normalizePropertyName(key: string) {
  const { isMergeSymbol } = mergeKeyInfo(key);

  return replacePseudoSelectors(isMergeSymbol ? removeMergeSymbol(key) : key);
}

function cloneCondition(condition: NormalizedCondition) {
  return { ...condition } satisfies NormalizedCondition;
}

function hasAlias(
  key: string,
  aliases: ConditionAliasMap
): key is `_${string}` {
  return Object.prototype.hasOwnProperty.call(aliases, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, expectTypeOf } = import.meta.vitest;

  const baseCondition = {
    layer: null,
    supports: null,
    media: null,
    container: null,
    selector: "&"
  } satisfies NormalizedCondition;

  describe.concurrent("collectStyleDeclarations", () => {
    it("collects base declarations and configured aliases before pseudos", () => {
      expect(
        collectStyleDeclarations(
          {
            color: "black",
            _mobile: {
              color: "green"
            },
            _tablet: {
              color: "blue"
            },
            _desktop: {
              color: "purple"
            },
            _hover: {
              color: "orange"
            }
          } as unknown as CSSRule,
          {
            conditions: {
              _mobile: {},
              _tablet: "@media screen and (min-width: 768px)",
              _desktop: {
                "@media": "screen and (min-width: 1024px)"
              }
            }
          }
        )
      ).toStrictEqual([
        {
          condition: baseCondition,
          property: "color",
          value: "black"
        },
        {
          condition: baseCondition,
          property: "color",
          value: "green"
        },
        {
          condition: {
            ...baseCondition,
            media: "screen and (min-width: 768px)"
          },
          property: "color",
          value: "blue"
        },
        {
          condition: {
            ...baseCondition,
            media: "screen and (min-width: 1024px)"
          },
          property: "color",
          value: "purple"
        },
        {
          condition: {
            ...baseCondition,
            selector: "&:hover"
          },
          property: "color",
          value: "orange"
        }
      ] satisfies CollectedStyleDeclaration[]);
    });

    it("normalizes object media aliases with redundant @media prefix", () => {
      expect(
        collectStyleDeclarations(
          {
            _desktop: {
              color: "purple"
            }
          } as unknown as CSSRule,
          {
            conditions: {
              _desktop: {
                "@media": "@media screen and (min-width: 1024px)"
              }
            }
          }
        )
      ).toStrictEqual([
        {
          condition: {
            ...baseCondition,
            media: "screen and (min-width: 1024px)"
          },
          property: "color",
          value: "purple"
        }
      ] satisfies CollectedStyleDeclaration[]);
    });

    it("collects nested selector, media, and pseudo declarations", () => {
      expect(
        collectStyleDeclarations({
          "nav li > &": {
            "@media (prefers-color-scheme: dark)": {
              _hover: {
                background: "red"
              }
            }
          }
        })
      ).toStrictEqual([
        {
          condition: {
            ...baseCondition,
            media: "(prefers-color-scheme: dark)",
            selector: "nav li > &:hover"
          },
          property: "background",
          value: "red"
        }
      ] satisfies CollectedStyleDeclaration[]);
    });

    it("collects property-level condition maps in source order", () => {
      expect(
        collectStyleDeclarations(
          {
            background: {
              base: "red",
              _tablet: "blue",
              "@media (prefers-reduced-motion)": "green",
              Color: {
                base: "transparent",
                _hover: "yellow",
                _desktop: "black"
              }
            }
          },
          {
            conditions: {
              _tablet: "screen and (min-width: 768px)",
              _desktop: {
                "@media": "screen and (min-width: 1024px)"
              }
            }
          }
        )
      ).toStrictEqual([
        {
          condition: baseCondition,
          property: "background",
          value: "red"
        },
        {
          condition: {
            ...baseCondition,
            media: "screen and (min-width: 768px)"
          },
          property: "background",
          value: "blue"
        },
        {
          condition: {
            ...baseCondition,
            media: "(prefers-reduced-motion)"
          },
          property: "background",
          value: "green"
        },
        {
          condition: baseCondition,
          property: "backgroundColor",
          value: "transparent"
        },
        {
          condition: {
            ...baseCondition,
            selector: "&:hover"
          },
          property: "backgroundColor",
          value: "yellow"
        },
        {
          condition: {
            ...baseCondition,
            media: "screen and (min-width: 1024px)"
          },
          property: "backgroundColor",
          value: "black"
        }
      ] satisfies CollectedStyleDeclaration[]);
    });

    it("keeps unconfigured underscore keys as transform pseudos", async () => {
      const { transform } = await import("../transform.js");

      expect(
        transform({
          _mobile: {
            color: "red"
          }
        } as unknown as CSSRule)
      ).toStrictEqual({
        selectors: {
          "&:mobile": {
            color: "red"
          }
        }
      });
    });

    it("types condition aliases as underscore-prefixed public at-rule keys", () => {
      expectTypeOf({
        _tablet: "@media screen and (min-width: 768px)",
        _desktop: {
          "@media": "screen and (min-width: 1024px)"
        }
      }).toExtend<ConditionAliasMap>();

      expectTypeOf({
        _supportsGrid: {
          "@supports": "(display: grid)",
          selector: "&:focus"
        }
      }).toExtend<ConditionAliasMap>();

      const nonUnderscoreAlias = {
        // @ts-expect-error: public aliases must be underscore-prefixed.
        tablet: "screen and (min-width: 768px)"
      } satisfies ConditionAliasMap;

      const normalizedAlias = {
        _desktop: {
          // @ts-expect-error: public object aliases use at-rule keys, not normalized condition keys.
          media: "screen and (min-width: 1024px)"
        }
      } satisfies ConditionAliasMap;

      expect(nonUnderscoreAlias).toBeTypeOf("object");
      expect(normalizedAlias).toBeTypeOf("object");
    });
  });
}

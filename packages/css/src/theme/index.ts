import { generateIdentifier } from "@vanilla-extract/css";
import { registerClassName } from "@vanilla-extract/css/adapter";
import { getFileScope } from "@vanilla-extract/css/fileScope";
import type {
  GlobalCSSRule,
  CSSVarValue,
  PureCSSVarFunction,
  PureCSSVarKey
} from "@mincho-js/transform-to-vanilla";
import { globalCss } from "../css/index.js";
import { camelToKebab } from "../utils.js";
import type { Resolve } from "../types.js";
import type {
  Theme,
  ResolveTheme,
  ThemeValue,
  TokenValue,
  TokenDefinition,
  TokenPrimitiveValue,
  TokenUnitValue,
  TokenCompositeValue
} from "./types.js";

type WithOptionalLayer<T extends Theme> = T & {
  "@layer"?: string;
};

export function globalTheme<ThemeTokens extends Theme>(
  selector: string,
  tokens: WithOptionalLayer<ThemeTokens>
): Resolve<ResolveTheme<ThemeTokens>> {
  const { layerName, tokens: themeTokens } = extractLayerFromTokens(tokens);
  const { vars, resolvedTokens } = assignTokens(themeTokens);

  const rule: GlobalCSSRule =
    layerName != null
      ? {
          "@layer": {
            [layerName]: {
              vars
            }
          }
        }
      : {
          vars
        };

  globalCss(selector, rule);
  return resolvedTokens;
}

export function theme<ThemeTokens extends Theme>(
  tokens: WithOptionalLayer<ThemeTokens>,
  debugId?: string
): [string, Resolve<ResolveTheme<ThemeTokens>>] {
  const themeClassName = generateIdentifier(debugId);
  registerClassName(themeClassName, getFileScope());

  const resolvedTokens = globalTheme(themeClassName, tokens);

  return [themeClassName, resolvedTokens];
}

function extractLayerFromTokens<ThemeTokens extends Theme>(
  tokens: WithOptionalLayer<ThemeTokens>
): {
  layerName?: string;
  tokens: ThemeTokens;
} {
  if ("@layer" in tokens) {
    const { "@layer": layerName, ...rest } = tokens;

    return { layerName, tokens: rest as ThemeTokens };
  }

  return { tokens };
}

// === Assign Variables ========================================================
function assignTokensWithPrefix<ThemeTokens extends Theme>(
  tokens: ThemeTokens,
  prefix = ""
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
} {
  const vars: AssignedVars = {};
  const resolvedTokens = {} as ResolveTheme<ThemeTokens>;

  for (const [key, value] of Object.entries(tokens)) {
    const varPath = buildVarPath(prefix, key);

    if (isThemeValue(value)) {
      processThemeValue(key, value, varPath, vars, resolvedTokens);
    } else if (isNestedTheme(value)) {
      const { vars: nestedVars, resolvedTokens: nestedResolved } =
        assignTokensWithPrefix(value as Theme, varPath);

      // Merge nested vars directly (they already have correct prefixes)
      Object.assign(vars, nestedVars);
      (resolvedTokens as Record<string, unknown>)[key] = nestedResolved;
    }
  }

  return { vars, resolvedTokens };
}

function assignTokens<ThemeTokens extends Theme>(
  tokens: ThemeTokens
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
} {
  return assignTokensWithPrefix(tokens, "");
}

// === Type Guards =============================================================
function isPrimitive(value: unknown): value is TokenPrimitiveValue {
  const type = typeof value;
  return (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    value === undefined
  );
}

function isTokenUnitValue(value: unknown): value is TokenUnitValue {
  return (
    typeof value === "object" &&
    value != null &&
    "value" in value &&
    "unit" in value &&
    typeof value.value === "number" &&
    typeof value.unit === "string" &&
    Object.keys(value).length === 2
  );
}

function isTokenCompositeValue(value: unknown): value is TokenCompositeValue {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "resolved");
  return descriptor !== undefined && descriptor.get !== undefined;
}

function isTokenDefinition(value: unknown): value is TokenDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "$type" in value &&
    "$value" in value
  );
}

function isThemeValue(value: unknown): value is ThemeValue {
  if (isPrimitive(value)) return true;
  if (Array.isArray(value)) return true;
  if (isTokenUnitValue(value)) return true;
  if (isTokenCompositeValue(value)) return true;
  if (isTokenDefinition(value)) return true;
  return false;
}

function isNestedTheme(value: unknown): value is Theme {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (isTokenUnitValue(value)) return false;
  if (isTokenCompositeValue(value)) return false;
  if (isTokenDefinition(value)) return false;
  return true;
}

// === Path Utilities ==========================================================
function pathToCSSVar(path: string): PureCSSVarKey {
  return `--${path}` as PureCSSVarKey;
}

function pathToVarReference(path: string): PureCSSVarFunction {
  return `var(--${path})` as PureCSSVarFunction;
}

function buildVarPath(prefix: string, key: string): string {
  const kebabKey = camelToKebab(key);
  return prefix ? `${prefix}-${kebabKey}` : kebabKey;
}

// === Value Extraction ========================================================
function extractCSSValue(value: TokenValue): CSSVarValue {
  if (isPrimitive(value)) {
    return String(value) as CSSVarValue;
  }

  if (isTokenUnitValue(value)) {
    return `${value.value}${value.unit}` as CSSVarValue;
  }

  if (isTokenCompositeValue(value)) {
    return extractCSSValue(value.resolved);
  }

  // Handle arrays (shouldn't normally reach here, but for safety)
  if (Array.isArray(value)) {
    throw new Error(`Unexpected array in extractCSSValue`);
  }

  // If it's an object but not a recognized type, throw a descriptive error
  if (typeof value === "object" && value !== null) {
    throw new Error(
      `Unexpected object in extractCSSValue: ${JSON.stringify(value)}`
    );
  }

  throw new Error(`Unexpected value type in extractCSSValue: ${typeof value}`);
}

// === Theme Value Processing ==================================================
interface AssignedVars {
  [tokenName: string]: CSSVarValue;
}

function processThemeValue(
  key: string,
  value: ThemeValue,
  varPath: string,
  vars: AssignedVars,
  resolvedTokens: Record<string, unknown>
): void {
  // Handle TokenDefinition - unwrap and process $value
  if (isTokenDefinition(value)) {
    // The $value could be a nested Theme object or a ThemeValue
    const innerValue = value.$value;
    if (isThemeValue(innerValue)) {
      processThemeValue(key, innerValue, varPath, vars, resolvedTokens);
    } else if (isNestedTheme(innerValue)) {
      // It's a nested theme, process it recursively
      const { vars: nestedVars, resolvedTokens: nestedResolved } =
        assignTokensWithPrefix(innerValue as Theme, varPath);

      // Merge nested vars directly
      Object.assign(vars, nestedVars);
      resolvedTokens[key] = nestedResolved;
    }
    return;
  }

  // Handle arrays - create indexed variables
  if (Array.isArray(value)) {
    const resolvedArray: PureCSSVarFunction[] = [];

    value.forEach((item, index) => {
      const indexedPath = `${varPath}-${index}`;
      const cssVarName = pathToCSSVar(indexedPath);
      const varRef = pathToVarReference(indexedPath);

      vars[cssVarName] = extractCSSValue(item);
      resolvedArray.push(varRef);
    });

    resolvedTokens[key] = resolvedArray;
    return;
  }

  // Handle TokenComposedValue - process resolved and all properties
  if (isTokenCompositeValue(value)) {
    const resolvedComposite: Record<string, PureCSSVarFunction> = {};

    // Process 'resolved' property
    const resolvedCssVar = pathToCSSVar(varPath);
    vars[resolvedCssVar] = extractCSSValue(value.resolved);

    // Create getter for resolved property to match original structure
    Object.defineProperty(resolvedComposite, "resolved", {
      get() {
        return pathToVarReference(varPath);
      },
      enumerable: true,
      configurable: true
    });

    // Process other properties
    for (const [propKey, propValue] of Object.entries(value)) {
      if (propKey === "resolved") continue;

      const propPath = `${varPath}-${camelToKebab(propKey)}`;
      const propCssVar = pathToCSSVar(propPath);
      vars[propCssVar] = extractCSSValue(propValue as TokenValue);
      resolvedComposite[propKey] = pathToVarReference(propPath);
    }

    resolvedTokens[key] = resolvedComposite;
    return;
  }

  // Handle primitives and TokenUnitValue
  const cssVarName = pathToCSSVar(varPath);
  vars[cssVarName] = extractCSSValue(value as TokenValue);
  resolvedTokens[key] = pathToVarReference(varPath);
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, assertType } = import.meta.vitest;

  function composedValue<ComposedValue>(
    value: ComposedValue & ThisType<ComposedValue>
  ): ComposedValue {
    return value;
  }

  describe("assignTokens", () => {
    it("handles primitive values", () => {
      const result = assignTokens({
        color: "red",
        size: 16,
        enabled: true,
        nothing: undefined
      });

      expect(result.vars).toEqual({
        "--color": "red",
        "--size": "16",
        "--enabled": "true",
        "--nothing": "undefined"
      });

      expect(result.resolvedTokens).toEqual({
        color: "var(--color)",
        size: "var(--size)",
        enabled: "var(--enabled)",
        nothing: "var(--nothing)"
      });
    });

    it("converts camelCase to kebab-case", () => {
      const result = assignTokens({
        backgroundColor: "white",
        fontSize: "16px",
        lineHeight: 1.5
      });

      expect(result.vars).toEqual({
        "--background-color": "white",
        "--font-size": "16px",
        "--line-height": "1.5"
      });

      expect(result.resolvedTokens).toEqual({
        backgroundColor: "var(--background-color)",
        fontSize: "var(--font-size)",
        lineHeight: "var(--line-height)"
      });
    });

    it("handles arrays with indexing", () => {
      const result = assignTokens({
        space: [2, 4, 8, 16, 32]
      });

      expect(result.vars).toEqual({
        "--space-0": "2",
        "--space-1": "4",
        "--space-2": "8",
        "--space-3": "16",
        "--space-4": "32"
      });

      expect(result.resolvedTokens).toEqual({
        space: [
          "var(--space-0)",
          "var(--space-1)",
          "var(--space-2)",
          "var(--space-3)",
          "var(--space-4)"
        ]
      });
    });

    it("handles nested theme objects", () => {
      const result = assignTokens({
        color: {
          base: {
            red: "#ff0000",
            green: "#00ff00",
            blue: "#0000ff"
          },
          semantic: {
            primary: "#007bff",
            secondary: "#6c757d"
          }
        }
      });

      expect(result.vars).toEqual({
        "--color-base-red": "#ff0000",
        "--color-base-green": "#00ff00",
        "--color-base-blue": "#0000ff",
        "--color-semantic-primary": "#007bff",
        "--color-semantic-secondary": "#6c757d"
      });

      assertType<PureCSSVarFunction>(result.resolvedTokens.color.base.red);
      expect(result.resolvedTokens.color.base.red).toBe(
        "var(--color-base-red)"
      );
      expect(result.resolvedTokens.color.base.green).toBe(
        "var(--color-base-green)"
      );
      expect(result.resolvedTokens.color.base.blue).toBe(
        "var(--color-base-blue)"
      );
      expect(result.resolvedTokens.color.semantic.primary).toBe(
        "var(--color-semantic-primary)"
      );
      expect(result.resolvedTokens.color.semantic.secondary).toBe(
        "var(--color-semantic-secondary)"
      );
    });

    it("handles TokenUnitValue", () => {
      const result = assignTokens({
        spacing: { value: 1.5, unit: "rem" },
        borderWidth: { value: 2, unit: "px" }
      });

      expect(result.vars).toEqual({
        "--spacing": "1.5rem",
        "--border-width": "2px"
      });

      expect(result.resolvedTokens).toEqual({
        spacing: "var(--spacing)",
        borderWidth: "var(--border-width)"
      });
    });

    it("handles TokenDefinition", () => {
      const result = assignTokens({
        primary: {
          $type: "color",
          $value: "#0000ff",
          $description: "Primary brand color"
        },
        fontSize: {
          $type: "dimension",
          $value: { value: 16, unit: "px" }
        }
      });

      expect(result.vars).toEqual({
        "--primary": "#0000ff",
        "--font-size": "16px"
      });

      expect(result.resolvedTokens).toEqual({
        primary: "var(--primary)",
        fontSize: "var(--font-size)"
      });
    });

    it("handles TokenComposedValue with resolved getter", () => {
      const shadowValue = composedValue({
        get resolved() {
          return `${this.color} ${this.offsetX.value}${this.offsetX.unit} ${this.offsetY.value}${this.offsetY.unit} ${this.blur.value}${this.blur.unit}`;
        },
        color: "#00000080",
        offsetX: { value: 0.5, unit: "rem" },
        offsetY: { value: 0.5, unit: "rem" },
        blur: { value: 1.5, unit: "rem" }
      });

      const result = assignTokens({
        shadow: {
          light: shadowValue
        }
      });

      expect(result.vars["--shadow-light"]).toMatch(/^#00000080/);
      expect(result.vars["--shadow-light-color"]).toBe("#00000080");
      expect(result.vars["--shadow-light-offset-x"]).toBe("0.5rem");
      expect(result.vars["--shadow-light-offset-y"]).toBe("0.5rem");
      expect(result.vars["--shadow-light-blur"]).toBe("1.5rem");

      const resolvedShadow = result.resolvedTokens.shadow.light;
      expect(resolvedShadow.resolved).toBe("var(--shadow-light)");
      expect(resolvedShadow.color).toBe("var(--shadow-light-color)");
      expect(resolvedShadow.offsetX).toBe("var(--shadow-light-offset-x)");
      expect(resolvedShadow.offsetY).toBe("var(--shadow-light-offset-y)");
      expect(resolvedShadow.blur).toBe("var(--shadow-light-blur)");
    });

    it("handles complex nested structures with mixed types", () => {
      const result = assignTokens({
        typography: {
          heading: {
            sizes: [48, 36, 24, 20, 16],
            weight: { value: 700, unit: "" },
            family: "Helvetica, sans-serif"
          },
          body: {
            size: { value: 14, unit: "px" },
            lineHeight: 1.5
          }
        },
        colors: {
          $type: "color",
          $value: {
            primary: "#007bff",
            secondary: "#6c757d"
          }
        }
      });

      expect(result.vars["--typography-heading-sizes-0"]).toBe("48");
      expect(result.vars["--typography-heading-sizes-4"]).toBe("16");
      expect(result.vars["--typography-heading-weight"]).toBe("700");
      expect(result.vars["--typography-heading-family"]).toBe(
        "Helvetica, sans-serif"
      );
      expect(result.vars["--typography-body-size"]).toBe("14px");
      expect(result.vars["--typography-body-line-height"]).toBe("1.5");
      expect(result.vars["--colors-primary"]).toBe("#007bff");
      expect(result.vars["--colors-secondary"]).toBe("#6c757d");
    });
  });
}

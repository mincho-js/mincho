import {
  createVar,
  generateIdentifier,
  fallbackVar
} from "@vanilla-extract/css";
import { registerClassName } from "@vanilla-extract/css/adapter";
import { getFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import type {
  GlobalCSSRule,
  CSSVarValue,
  PureCSSVarFunction,
  PureCSSVarKey
} from "@mincho-js/transform-to-vanilla";
import { globalCss } from "../css/index.js";
import { identifierName, camelToKebab, getVarName } from "../utils.js";
import type { Resolve } from "../types.js";
import type {
  Theme,
  ResolveTheme,
  TokenValue,
  TokenDefinition,
  TokenPrimitiveValue,
  TokenDimensionValue,
  TokenCompositeValue,
  TokenFontFamilyValue,
  TokenDurationValue,
  TokenColorValue,
  TokenFontWeightValue
} from "./types.js";

// == Public API ==============================================================
type WithOptionalLayer<T extends Theme> = T & {
  "@layer"?: string;
};

interface ThemeSubFunctions {
  fallbackVar: typeof fallbackVar;
  raw(varReference: unknown): string;
  alias(varReference: unknown): string;
}

type ResolveThemeOutput<T extends Theme> = Resolve<ResolveTheme<T>>;
type ThemeTokensInput<ThemeTokens extends Theme> =
  WithOptionalLayer<ThemeTokens> &
    ThisType<ResolveThemeOutput<ThemeTokens> & ThemeSubFunctions>;

export function globalTheme<const ThemeTokens extends Theme>(
  selector: string,
  tokens: ThemeTokensInput<ThemeTokens>
): ResolveThemeOutput<ThemeTokens> {
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

export function theme<const ThemeTokens extends Theme>(
  tokens: ThemeTokensInput<ThemeTokens>,
  debugId?: string
): [string, ResolveThemeOutput<ThemeTokens>] {
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

// == Token Assignment Orchestration ===========================================
interface AssignedVars {
  [cssVarName: string]: CSSVarValue;
}
interface CSSVarMap {
  [varPath: string]: PureCSSVarKey;
}

function assignTokens<ThemeTokens extends Theme>(
  tokens: ThemeTokens
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
} {
  return assignTokensWithPrefix(tokens, "");
}

/**
 * Assigns CSS variables to theme tokens using a two-pass algorithm.
 * Pass 1 assigns variables to all tokens, Pass 2 resolves semantic token references.
 */
function assignTokensWithPrefix<ThemeTokens extends Theme>(
  tokens: ThemeTokens,
  prefix = ""
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
} {
  const vars: AssignedVars = {};
  const resolvedTokens = {} as ResolveTheme<ThemeTokens>;

  // Execute two-pass token resolution:
  // 1. Assign CSS variables to all tokens
  // 2. Resolve semantic token references
  const context: TokenProcessingContext = {
    prefix,
    path: [],
    parentPath: prefix,
    cssVarMap: {},
    aliasMap: new Set()
  };

  // Add utilities to the context for use in getters
  Object.defineProperty(resolvedTokens, "fallbackVar", {
    value: fallbackVar,
    enumerable: false,
    configurable: false,
    writable: false
  });

  // Add raw utility to extract actual values instead of var() references
  Object.defineProperty(resolvedTokens, "raw", {
    value: createRawExtractor(vars),
    enumerable: false,
    configurable: false,
    writable: false
  });

  // Add alias utility to create object references instead of CSS variables
  Object.defineProperty(resolvedTokens, "alias", {
    value: createAliasFunction(context),
    enumerable: false,
    configurable: false,
    writable: false
  });

  assignTokenVariables(tokens, vars, resolvedTokens, context);
  resolveSemanticTokens(tokens, vars, resolvedTokens, context);

  return { vars, resolvedTokens };
}

/**
 * Removes hash suffixes from CSS variable names and var() references
 */
function stripHash(str: string): string {
  // Remove hash suffix from CSS variable names and var() references
  return str.replace(/__[a-zA-Z0-9]+/g, "");
}

// == Two-Pass Token Resolution ===============================================
/**
 * Context object for token processing functions
 */
interface TokenProcessingContext {
  prefix: string; // Variable name prefix
  path: string[]; // Current path in object tree
  parentPath: string; // Current variable path
  cssVarMap: CSSVarMap; // Cache for CSS variable names
  aliasMap: Set<string>; // Track paths that should be aliases (not create CSS vars)
}

/**
 * Pass 1: Assigns CSS variables to all tokens and builds resolved structure.
 * Processes regular tokens immediately, creates placeholders for semantic tokens.
 */
function assignTokenVariables(
  themeNode: Record<string, unknown>,
  vars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  context: TokenProcessingContext
): void {
  const descriptors = Object.getOwnPropertyDescriptors(themeNode);

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const varPath = context.parentPath
      ? `${context.parentPath}-${camelToKebab(key)}`
      : camelToKebab(key);
    const cssVar = getCSSVarByPath(varPath, context);
    const varRef = getVarReference(varPath, context);
    const currentPath = [...context.path, key];

    // Handle getters (referencing tokens)
    if (typeof descriptor.get === "function") {
      // Store placeholder CSS variable reference for now
      setByPath(resolvedTokens, currentPath, varRef);
      continue;
    }

    const value = descriptor.value;

    // Handle TokenDefinition
    if (isTokenDefinition(value)) {
      // Check if $value is a structured value for the token type
      const tokenType = value.$type;
      const tokenValue = value.$value;

      if (isStructuredTokenValue(tokenType, tokenValue)) {
        // Process token definition as a single value
        const cssValue = extractTokenDefinitionValue(value);
        vars[cssVar] = cssValue;
        setByPath(resolvedTokens, currentPath, varRef);
      } else if (isNestedTheme(tokenValue)) {
        // For nested objects in token definitions, recurse into them
        setByPath(resolvedTokens, currentPath, {});
        assignTokenVariables(
          tokenValue as Record<string, unknown>,
          vars,
          resolvedTokens,
          {
            prefix: context.prefix,
            path: currentPath,
            parentPath: varPath,
            cssVarMap: context.cssVarMap,
            aliasMap: context.aliasMap
          }
        );
      } else {
        // Fallback for other types
        const cssValue = extractTokenDefinitionValue(value);
        vars[cssVar] = cssValue;
        setByPath(resolvedTokens, currentPath, varRef);
      }
      continue;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      const resolvedArray: PureCSSVarFunction[] = [];
      value.forEach((item, index) => {
        const indexedPath = `${varPath}-${index}`;
        const indexedCssVar = getCSSVarByPath(indexedPath, context);
        vars[indexedCssVar] = extractCSSValue(item);
        resolvedArray.push(getVarReference(indexedPath, context));
      });
      setByPath(resolvedTokens, currentPath, resolvedArray);
      continue;
    }

    // Handle TokenCompositeValue
    if (isTokenCompositeValue(value)) {
      const resolvedComposite: Record<string, PureCSSVarFunction> = {};

      // Process resolved property
      vars[cssVar] = extractCSSValue(value.resolved);

      // Create getter for resolved property
      Object.defineProperty(resolvedComposite, "resolved", {
        get() {
          return varRef;
        },
        enumerable: true,
        configurable: true
      });

      // Process other properties
      for (const [propKey, propValue] of Object.entries(value)) {
        if (propKey === "resolved") continue;

        const propPath = `${varPath}-${camelToKebab(propKey)}`;
        const propCssVar = getCSSVarByPath(propPath, context);
        vars[propCssVar] = extractCSSValue(propValue as TokenValue);
        resolvedComposite[propKey] = getVarReference(propPath, context);
      }

      setByPath(resolvedTokens, currentPath, resolvedComposite);
      continue;
    }

    // Handle nested objects
    if (isNestedTheme(value)) {
      setByPath(resolvedTokens, currentPath, {});
      assignTokenVariables(value, vars, resolvedTokens, {
        prefix: context.prefix,
        path: currentPath,
        parentPath: varPath,
        cssVarMap: context.cssVarMap,
        aliasMap: context.aliasMap
      });
      continue;
    }

    // Handle primitive values and TokenUnitValue
    const cssValue = extractCSSValue(value as TokenValue);
    vars[cssVar] = cssValue;
    setByPath(resolvedTokens, currentPath, varRef);
  }
}

/**
 * Pass 2: Resolves semantic token references using completed structure.
 * Evaluates getter functions with resolvedTokens as context to enable
 * semantic tokens to reference other tokens via CSS variables.
 */
function resolveSemanticTokens(
  themeNode: Record<string, unknown>,
  vars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  context: TokenProcessingContext
): void {
  const descriptors = Object.getOwnPropertyDescriptors(themeNode);

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const currentPath = [...context.path, key];
    const varPath = context.parentPath
      ? `${context.parentPath}-${camelToKebab(key)}`
      : camelToKebab(key);

    // Handle getters (semantic tokens)
    if (typeof descriptor.get === "function") {
      // Set the current path for alias() to access
      currentProcessingPath = currentPath;
      // Call getter with resolvedTokens as this context
      // This allows semantic tokens to reference other tokens
      const computedValue = descriptor.get.call(resolvedTokens);
      // Clear the current path after getter execution
      currentProcessingPath = [];

      // Check if this path is marked as an alias
      const currentPathStr = currentPath.join(".");

      if (context.aliasMap.has(currentPathStr)) {
        // Don't create a CSS variable for aliases
        // Just update resolvedTokens with the aliased reference (unhashed)
        const unhashedValue = stripHash(computedValue);
        setByPath(resolvedTokens, currentPath, unhashedValue);
      } else {
        // Normal flow: create CSS variable
        const cssVar = getCSSVarByPath(varPath, context);
        vars[cssVar] = computedValue;
        setByPath(resolvedTokens, currentPath, computedValue);
      }
      continue;
    }

    const value = descriptor.value;

    // Handle nested TokenDefinition with object $value
    if (
      isTokenDefinition(value) &&
      isPlainObject(value.$value) &&
      !Array.isArray(value.$value)
    ) {
      resolveSemanticTokens(
        value.$value as Record<string, unknown>,
        vars,
        resolvedTokens,
        {
          prefix: context.prefix,
          path: currentPath,
          parentPath: varPath,
          cssVarMap: context.cssVarMap,
          aliasMap: context.aliasMap
        }
      );
      continue;
    }

    // Recurse for nested objects (but not other types)
    if (isNestedTheme(value)) {
      resolveSemanticTokens(value, vars, resolvedTokens, {
        prefix: context.prefix,
        path: currentPath,
        parentPath: varPath,
        cssVarMap: context.cssVarMap,
        aliasMap: context.aliasMap
      });
    }
  }
}

// == Type Guards =============================================================
function isPrimitive(value: unknown): value is TokenPrimitiveValue {
  const type = typeof value;
  return (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    value === undefined
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isNestedTheme(value: unknown): value is Theme {
  if (!isPlainObject(value)) return false;
  if (Array.isArray(value)) return false;
  if (isTokenUnitValue(value)) return false;
  if (isTokenCompositeValue(value)) return false;
  if (isTokenDefinition(value)) return false;
  return true;
}

/**
 * Checks if a token type has a structured value that should be processed as a single unit
 * rather than recursed into as a nested object.
 */
function isStructuredTokenValue(
  tokenType: string,
  tokenValue: unknown
): boolean {
  return (
    ((tokenType === "dimension" || tokenType === "duration") &&
      isPlainObject(tokenValue) &&
      "value" in tokenValue &&
      "unit" in tokenValue) ||
    (tokenType === "cubicBezier" && Array.isArray(tokenValue)) ||
    (tokenType === "fontFamily" &&
      (typeof tokenValue === "string" || Array.isArray(tokenValue))) ||
    tokenType === "fontWeight" ||
    tokenType === "number" ||
    (tokenType === "color" &&
      (typeof tokenValue === "string" ||
        (isPlainObject(tokenValue) &&
          "colorSpace" in tokenValue &&
          "components" in tokenValue)))
  );
}

function isTokenUnitValue(value: unknown): value is TokenDimensionValue {
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

// === Path Utilities ==========================================================
/**
 * Gets a cached CSS variable name for the given path.
 * Creates and caches the CSS variable name if not already cached.
 */
function getCSSVarByPath(
  varPath: string,
  context: TokenProcessingContext
): PureCSSVarKey {
  if (!context.cssVarMap[varPath]) {
    const varValue = createVar(varPath);
    context.cssVarMap[varPath] = getVarName(varValue);
  }
  return context.cssVarMap[varPath];
}

/**
 * Gets a CSS variable reference using the cached variable name.
 * Ensures consistency between variable definitions and references.
 */
function getVarReference(
  varPath: string,
  context: TokenProcessingContext
): PureCSSVarFunction {
  const cssVar = getCSSVarByPath(varPath, context);
  return `var(${cssVar})` as PureCSSVarFunction;
}

function setByPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let target: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!isPlainObject(target[key])) {
      target[key] = {};
    }
    target = target[key] as Record<string, unknown>;
  }
  if (path.length > 0) {
    target[path[path.length - 1]] = value;
  }
}

/**
 * Creates a function that extracts raw CSS values from var() references.
 * Used to "hardcode" values instead of using CSS variable references.
 */
function createRawExtractor(vars: AssignedVars) {
  return function raw(varReference: unknown) {
    if (typeof varReference === "string") {
      // Use getVarName utility to extract the CSS variable name
      const varName = getVarName(varReference);
      // If it was a var() reference and we have the value, return it
      if (varName !== varReference && varName in vars) {
        return vars[varName];
      }
    }
    // If not a var reference or lookup failed, return as-is
    return varReference;
  };
}

/**
 * Creates a function that marks tokens as aliases.
 * Aliased tokens don't create their own CSS variables but reference existing ones.
 */
// Store the current processing path for alias() to access
let currentProcessingPath: string[] = [];

function createAliasFunction(context: TokenProcessingContext) {
  return function alias(varReference: unknown): string {
    // Mark the current processing path as an alias
    const currentPathStr = currentProcessingPath.join(".");

    context.aliasMap.add(currentPathStr);
    // Return the var reference unchanged
    return String(varReference);
  };
}

// == Token Value Extractors ==================================================
function extractFontFamilyValue(value: TokenFontFamilyValue): CSSVarValue {
  if (Array.isArray(value)) {
    return value.join(", ") as CSSVarValue;
  }
  return value as CSSVarValue;
}

function extractDurationValue(value: TokenDurationValue): CSSVarValue {
  return `${value.value}${value.unit}` as CSSVarValue;
}

function extractCubicBezierValue(
  value: [number, number, number, number]
): CSSVarValue {
  return `cubic-bezier(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]})` as CSSVarValue;
}

function extractColorValue(value: string | TokenColorValue): CSSVarValue {
  if (typeof value === "string") {
    return value as CSSVarValue;
  }

  // Complex color object handling
  // If hex fallback is provided, use it
  if (value.hex) {
    return value.hex as CSSVarValue;
  }

  // Otherwise, construct from color space and components
  // This is a simplified version - full implementation would need proper color space handling
  if (value.components && Array.isArray(value.components)) {
    const components = value.components.join(", ");
    const alpha = value.alpha !== undefined ? ` / ${value.alpha}` : "";
    return `${value.colorSpace}(${components}${alpha})` as CSSVarValue;
  }

  // Fallback for invalid color object
  return "#000000" as CSSVarValue;
}

function extractFontWeightValue(value: TokenFontWeightValue): CSSVarValue {
  // Map keywords to numeric values
  const weightMap: Record<string, number> = {
    thin: 100,
    hairline: 100,
    "extra-light": 200,
    "ultra-light": 200,
    light: 300,
    normal: 400,
    regular: 400,
    book: 400,
    medium: 500,
    "semi-bold": 600,
    "demi-bold": 600,
    bold: 700,
    "extra-bold": 800,
    "ultra-bold": 800,
    black: 900,
    heavy: 900,
    "extra-black": 950,
    "ultra-black": 950
  };

  if (typeof value === "number") {
    return String(value) as CSSVarValue;
  }

  return String(weightMap[value] || value) as CSSVarValue;
}

function extractNumberValue(value: number): CSSVarValue {
  return String(value) as CSSVarValue;
}

function extractTokenDefinitionValue(definition: TokenDefinition): CSSVarValue {
  const { $type, $value } = definition;

  switch ($type) {
    case "fontFamily":
      return extractFontFamilyValue($value as TokenFontFamilyValue);
    case "duration":
      return extractDurationValue($value as TokenDurationValue);
    case "cubicBezier":
      return extractCubicBezierValue(
        $value as [number, number, number, number]
      );
    case "color":
      return extractColorValue($value as string | TokenColorValue);
    case "fontWeight":
      return extractFontWeightValue($value as TokenFontWeightValue);
    case "number":
      return extractNumberValue($value as number);
    case "dimension":
      // TokenDimensionValue is already handled by existing logic
      return extractDurationValue($value as TokenDurationValue); // Same structure
    default:
      // For unknown token types, try to extract as primitive
      return extractCSSValue($value as TokenValue);
  }
}

function extractCSSValue(value: TokenValue): CSSVarValue {
  if (isPrimitive(value)) {
    return value as CSSVarValue;
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

// == Tests ===================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, assertType } = import.meta.vitest;

  const debugId = "myCSS";
  setFileScope("test");

  function composedValue<ComposedValue>(
    value: ComposedValue & ThisType<ComposedValue & ThemeSubFunctions>
  ): ComposedValue {
    return value;
  }

  // Test utility functions for handling hashed CSS variables

  function normalizeVars(vars: AssignedVars): AssignedVars {
    const normalized: AssignedVars = {};
    for (const [key, value] of Object.entries(vars)) {
      normalized[stripHash(key)] = value;
    }
    return normalized;
  }

  function normalizeResolvedTokens<T>(tokens: T): T {
    if (typeof tokens === "string") {
      return stripHash(tokens) as T;
    }
    if (Array.isArray(tokens)) {
      return tokens.map(normalizeResolvedTokens) as T;
    }
    if (tokens && typeof tokens === "object") {
      const normalized: T = {} as T;
      const source = tokens as Record<string, unknown>;
      const target = normalized as Record<string, unknown>;
      for (const [key, value] of Object.entries(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor?.get) {
          Object.defineProperty(target, key, {
            get: () => normalizeResolvedTokens(source[key]),
            enumerable: true,
            configurable: true
          });
        } else {
          target[key] = normalizeResolvedTokens(value);
        }
      }
      return normalized;
    }
    return tokens;
  }

  // Validate that CSS variables have proper hash format
  function validateHashFormat(vars: AssignedVars): void {
    for (const key of Object.keys(vars)) {
      expect(key).toMatch(/^--[a-zA-Z0-9-]+__[a-zA-Z0-9]+$/);
    }
  }

  describe.concurrent("assignTokens", () => {
    it("handles primitive values", () => {
      const result = assignTokens({
        color: "red",
        size: 16,
        enabled: true,
        nothing: undefined
      });

      // Validate hash format is correct
      validateHashFormat(result.vars);

      // Compare normalized values (without hashes)
      expect(normalizeVars(result.vars)).toEqual({
        "--color": "red",
        "--size": 16,
        "--enabled": true,
        "--nothing": undefined
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
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

      validateHashFormat(result.vars);

      expect(normalizeVars(result.vars)).toEqual({
        "--background-color": "white",
        "--font-size": "16px",
        "--line-height": 1.5
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        backgroundColor: "var(--background-color)",
        fontSize: "var(--font-size)",
        lineHeight: "var(--line-height)"
      });
    });

    it("handles arrays with indexing", () => {
      const result = assignTokens({
        space: [2, 4, 8, 16, 32]
      });

      validateHashFormat(result.vars);

      expect(normalizeVars(result.vars)).toEqual({
        "--space-0": 2,
        "--space-1": 4,
        "--space-2": 8,
        "--space-3": 16,
        "--space-4": 32
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
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

      validateHashFormat(result.vars);

      expect(normalizeVars(result.vars)).toEqual({
        "--color-base-red": "#ff0000",
        "--color-base-green": "#00ff00",
        "--color-base-blue": "#0000ff",
        "--color-semantic-primary": "#007bff",
        "--color-semantic-secondary": "#6c757d"
      });

      const normalizedTokens = normalizeResolvedTokens(result.resolvedTokens);
      assertType<PureCSSVarFunction>(result.resolvedTokens.color.base.red);
      expect(normalizedTokens.color.base.red).toBe("var(--color-base-red)");
      expect(normalizedTokens.color.base.green).toBe("var(--color-base-green)");
      expect(normalizedTokens.color.base.blue).toBe("var(--color-base-blue)");
      expect(normalizedTokens.color.semantic.primary).toBe(
        "var(--color-semantic-primary)"
      );
      expect(normalizedTokens.color.semantic.secondary).toBe(
        "var(--color-semantic-secondary)"
      );
    });

    it("handles semantic token references with getters", () => {
      const result = assignTokens(
        composedValue({
          color: {
            base: {
              red: "#ff0000",
              blue: "#0000ff"
            },
            semantic: {
              get primary(): string {
                return this.color.base.blue;
              },
              get danger(): string {
                return this.color.base.red;
              }
            }
          }
        })
      );

      validateHashFormat(result.vars);

      // CSS variables should be created for both base and semantic tokens
      // Note: Semantic tokens reference other tokens, so their values are var() references
      const normalizedVars = normalizeVars(result.vars);
      expect(normalizedVars["--color-base-red"]).toBe("#ff0000");
      expect(normalizedVars["--color-base-blue"]).toBe("#0000ff");
      // Semantic tokens contain var() references WITH hashes that need to be normalized
      expect(stripHash(normalizedVars["--color-semantic-primary"])).toBe(
        "var(--color-base-blue)"
      );
      expect(stripHash(normalizedVars["--color-semantic-danger"])).toBe(
        "var(--color-base-red)"
      );

      // Resolved tokens should all use var() references
      const normalizedTokens = normalizeResolvedTokens(result.resolvedTokens);
      expect(normalizedTokens.color.base.red).toBe("var(--color-base-red)");
      expect(normalizedTokens.color.base.blue).toBe("var(--color-base-blue)");
      expect(normalizedTokens.color.semantic.primary).toBe(
        "var(--color-base-blue)"
      );
      expect(normalizedTokens.color.semantic.danger).toBe(
        "var(--color-base-red)"
      );
    });

    it("handles fallbackVar in semantic tokens", () => {
      const result = assignTokens(
        composedValue({
          color: {
            base: {
              blue: "#0000ff",
              green: "#00ff00"
            },
            semantic: {
              get primary(): string {
                return this.fallbackVar(this.color.base.blue, "#007bff");
              },
              get secondary(): string {
                // Test fallback with an existing token
                return this.fallbackVar(this.color.base.green, "#6c757d");
              }
            }
          }
        })
      );

      validateHashFormat(result.vars);

      const normalizedVars = normalizeVars(result.vars);
      // The semantic tokens should contain var() with fallback
      expect(stripHash(normalizedVars["--color-semantic-primary"])).toBe(
        "var(--color-base-blue, #007bff)"
      );
      expect(stripHash(normalizedVars["--color-semantic-secondary"])).toBe(
        "var(--color-base-green, #6c757d)"
      );
    });

    it("handles alias references in semantic tokens", () => {
      const result = assignTokens(
        composedValue({
          color: {
            base: {
              blue: "#0000ff",
              red: "#ff0000"
            },
            semantic: {
              get primary(): string {
                // Use alias to reference without creating CSS var
                return this.alias(this.color.base.blue);
              },
              get danger(): string {
                // Another alias
                return this.alias(this.color.base.red);
              },
              get secondary(): string {
                // Normal reference (creates CSS var)
                return this.color.base.blue;
              }
            }
          }
        })
      );

      validateHashFormat(result.vars);

      const normalizedVars = normalizeVars(result.vars);
      // Base tokens should have CSS variables
      expect(normalizedVars["--color-base-blue"]).toBe("#0000ff");
      expect(normalizedVars["--color-base-red"]).toBe("#ff0000");

      // Aliased semantic tokens should NOT have CSS variables

      expect(normalizedVars["--color-semantic-primary"]).toBeUndefined();
      expect(normalizedVars["--color-semantic-danger"]).toBeUndefined();

      // Non-aliased semantic token should have CSS variable
      expect(stripHash(normalizedVars["--color-semantic-secondary"])).toBe(
        "var(--color-base-blue)"
      );

      // Resolved tokens should all use var() references
      const normalizedTokens = normalizeResolvedTokens(result.resolvedTokens);
      expect(normalizedTokens.color.semantic.primary).toBe(
        "var(--color-base-blue)"
      );
      expect(normalizedTokens.color.semantic.danger).toBe(
        "var(--color-base-red)"
      );
      expect(normalizedTokens.color.semantic.secondary).toBe(
        "var(--color-base-blue)"
      );
    });

    it("handles raw value extraction in semantic tokens", () => {
      const result = assignTokens(
        composedValue({
          color: {
            base: {
              blue: "#0000ff",
              red: "#ff0000"
            },
            semantic: {
              get primary(): string {
                // Use raw to get the actual value instead of var() reference
                return this.raw(this.color.base.blue);
              },
              get danger(): string {
                // Test raw with another token
                return this.raw(this.color.base.red);
              },
              get custom(): string {
                // Test raw with a non-var value
                return this.raw("#00ff00");
              }
            }
          },
          space: {
            base: [2, 4, 8, 16, 32, 64],
            semantic: {
              get small(): string {
                return this.raw(this.space.base[1]);
              },
              get medium(): string {
                return this.raw(this.space.base[3]);
              },
              get large(): string {
                return this.raw(this.space.base[5]);
              }
            }
          }
        })
      );

      validateHashFormat(result.vars);

      const normalizedVars = normalizeVars(result.vars);
      // The semantic tokens should contain the raw values, not var() references
      expect(normalizedVars["--color-semantic-primary"]).toBe("#0000ff");
      expect(normalizedVars["--color-semantic-danger"]).toBe("#ff0000");
      expect(normalizedVars["--color-semantic-custom"]).toBe("#00ff00");
      expect(normalizedVars["--space-semantic-small"]).toBe(4);
      expect(normalizedVars["--space-semantic-medium"]).toBe(16);
      expect(normalizedVars["--space-semantic-large"]).toBe(64);
    });

    it("handles TokenUnitValue", () => {
      const result = assignTokens({
        spacing: { value: 1.5, unit: "rem" },
        borderWidth: { value: 2, unit: "px" }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--spacing": "1.5rem",
        "--border-width": "2px"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
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

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--primary": "#0000ff",
        "--font-size": "16px"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        primary: "var(--primary)",
        fontSize: "var(--font-size)"
      });
    });

    it("handles fontFamily tokens", () => {
      const result = assignTokens({
        fontPrimary: {
          $type: "fontFamily",
          $value: ["Helvetica", "Arial", "sans-serif"]
        },
        fontSecondary: {
          $type: "fontFamily",
          $value: "Georgia, serif"
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--font-primary": "Helvetica, Arial, sans-serif",
        "--font-secondary": "Georgia, serif"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        fontPrimary: "var(--font-primary)",
        fontSecondary: "var(--font-secondary)"
      });
    });

    it("handles duration tokens", () => {
      const result = assignTokens({
        transitionFast: {
          $type: "duration",
          $value: { value: 200, unit: "ms" }
        },
        transitionSlow: {
          $type: "duration",
          $value: { value: 1, unit: "s" }
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--transition-fast": "200ms",
        "--transition-slow": "1s"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        transitionFast: "var(--transition-fast)",
        transitionSlow: "var(--transition-slow)"
      });
    });

    it("handles cubicBezier tokens", () => {
      const result = assignTokens({
        easingDefault: {
          $type: "cubicBezier",
          $value: [0.5, 0, 1, 1]
        },
        easingBounce: {
          $type: "cubicBezier",
          $value: [0.68, -0.55, 0.265, 1.55]
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--easing-default": "cubic-bezier(0.5, 0, 1, 1)",
        "--easing-bounce": "cubic-bezier(0.68, -0.55, 0.265, 1.55)"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        easingDefault: "var(--easing-default)",
        easingBounce: "var(--easing-bounce)"
      });
    });

    it("handles color tokens with string value", () => {
      const result = assignTokens({
        colorBrand: {
          $type: "color",
          $value: "#ff5500"
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--color-brand": "#ff5500"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        colorBrand: "var(--color-brand)"
      });
    });

    it("handles fontWeight tokens", () => {
      const result = assignTokens({
        weightNormal: {
          $type: "fontWeight",
          $value: "normal"
        },
        weightBold: {
          $type: "fontWeight",
          $value: "bold"
        },
        weightSemiBold: {
          $type: "fontWeight",
          $value: "semi-bold"
        },
        weightNumeric: {
          $type: "fontWeight",
          $value: 300
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--weight-normal": "400",
        "--weight-bold": "700",
        "--weight-semi-bold": "600",
        "--weight-numeric": "300"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        weightNormal: "var(--weight-normal)",
        weightBold: "var(--weight-bold)",
        weightSemiBold: "var(--weight-semi-bold)",
        weightNumeric: "var(--weight-numeric)"
      });
    });

    it("handles number tokens", () => {
      const result = assignTokens({
        lineHeightBase: {
          $type: "number",
          $value: 1.5
        },
        zIndexModal: {
          $type: "number",
          $value: 1000
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--line-height-base": "1.5",
        "--z-index-modal": "1000"
      });

      expect(normalizeResolvedTokens(result.resolvedTokens)).toEqual({
        lineHeightBase: "var(--line-height-base)",
        zIndexModal: "var(--z-index-modal)"
      });
    });

    it("handles mixed token types in a theme", () => {
      const result = assignTokens({
        typography: {
          fontFamily: {
            $type: "fontFamily",
            $value: ["Inter", "system-ui", "sans-serif"]
          },
          fontWeight: {
            $type: "fontWeight",
            $value: "medium"
          },
          lineHeight: {
            $type: "number",
            $value: 1.6
          }
        },
        animation: {
          duration: {
            $type: "duration",
            $value: { value: 300, unit: "ms" }
          },
          easing: {
            $type: "cubicBezier",
            $value: [0.4, 0, 0.2, 1]
          }
        }
      });

      validateHashFormat(result.vars);
      expect(normalizeVars(result.vars)).toEqual({
        "--typography-font-family": "Inter, system-ui, sans-serif",
        "--typography-font-weight": "500",
        "--typography-line-height": "1.6",
        "--animation-duration": "300ms",
        "--animation-easing": "cubic-bezier(0.4, 0, 0.2, 1)"
      });

      const normalized = normalizeResolvedTokens(result.resolvedTokens);
      expect(normalized.typography.fontFamily).toBe(
        "var(--typography-font-family)"
      );
      expect(normalized.typography.fontWeight).toBe(
        "var(--typography-font-weight)"
      );
      expect(normalized.typography.lineHeight).toBe(
        "var(--typography-line-height)"
      );
      expect(normalized.animation.duration).toBe("var(--animation-duration)");
      expect(normalized.animation.easing).toBe("var(--animation-easing)");
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

      validateHashFormat(result.vars);
      const normalized = normalizeVars(result.vars);

      expect(normalized["--shadow-light"]).toMatch(/^#00000080/);
      expect(normalized["--shadow-light-color"]).toBe("#00000080");
      expect(normalized["--shadow-light-offset-x"]).toBe("0.5rem");
      expect(normalized["--shadow-light-offset-y"]).toBe("0.5rem");
      expect(normalized["--shadow-light-blur"]).toBe("1.5rem");

      const resolvedShadow = normalizeResolvedTokens(result.resolvedTokens)
        .shadow.light;
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

      validateHashFormat(result.vars);
      const normalized = normalizeVars(result.vars);

      expect(normalized["--typography-heading-sizes-0"]).toBe(48);
      expect(normalized["--typography-heading-sizes-4"]).toBe(16);
      expect(normalized["--typography-heading-weight"]).toBe("700");
      expect(normalized["--typography-heading-family"]).toBe(
        "Helvetica, sans-serif"
      );
      expect(normalized["--typography-body-size"]).toBe("14px");
      expect(normalized["--typography-body-line-height"]).toBe(1.5);
      expect(normalized["--colors-primary"]).toBe("#007bff");
      expect(normalized["--colors-secondary"]).toBe("#6c757d");
    });
  });

  describe.concurrent("theme", () => {
    it("generates unique className with debugId", () => {
      const [className1] = theme({ color: "red" }, "theme1");
      const [className2] = theme({ color: "blue" }, "theme2");

      expect(className1).toMatch(identifierName("theme1"));
      expect(className2).toMatch(identifierName("theme2"));
      expect(className1).not.toBe(className2);
    });

    it("generates className without debugId", () => {
      const [className] = theme({ color: "red" });

      expect(className).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    });

    it("handles @layer in theme tokens", () => {
      const [className, themeVars] = theme(
        {
          "@layer": "tokens",
          color: {
            primary: "#007bff",
            secondary: "#6c757d"
          }
        },
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          primary: "var(--color-primary)",
          secondary: "var(--color-secondary)"
        }
      });
    });

    it("handles primitive token values", () => {
      const [className, themeVars] = theme({
        color: "red",
        size: 16,
        enabled: true,
        nothing: undefined
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: "var(--color)",
        size: "var(--size)",
        enabled: "var(--enabled)",
        nothing: "var(--nothing)"
      });
    });

    it("handles array tokens", () => {
      const [className, themeVars] = theme({
        space: [2, 4, 8, 16, 32],
        colors: ["#ff0000", "#00ff00", "#0000ff"]
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        space: [
          "var(--space-0)",
          "var(--space-1)",
          "var(--space-2)",
          "var(--space-3)",
          "var(--space-4)"
        ],
        colors: ["var(--colors-0)", "var(--colors-1)", "var(--colors-2)"]
      });
    });

    it("handles nested theme objects", () => {
      const [className, themeVars] = theme({
        typography: {
          heading: {
            fontSize: "24px",
            fontWeight: 700
          },
          body: {
            fontSize: "16px",
            fontWeight: 400
          }
        }
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.typography.heading.fontSize).toBe(
        "var(--typography-heading-font-size)"
      );
      expect(normalized.typography.heading.fontWeight).toBe(
        "var(--typography-heading-font-weight)"
      );
      expect(normalized.typography.body.fontSize).toBe(
        "var(--typography-body-font-size)"
      );
      expect(normalized.typography.body.fontWeight).toBe(
        "var(--typography-body-font-weight)"
      );
    });

    it("handles TokenDefinition with various types", () => {
      const [className, themeVars] = theme({
        color: {
          $type: "color",
          $value: "#ff5500"
        },
        font: {
          $type: "fontFamily",
          $value: ["Inter", "sans-serif"]
        },
        duration: {
          $type: "duration",
          $value: { value: 300, unit: "ms" }
        },
        easing: {
          $type: "cubicBezier",
          $value: [0.4, 0, 0.2, 1]
        }
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: "var(--color)",
        font: "var(--font)",
        duration: "var(--duration)",
        easing: "var(--easing)"
      });
    });

    it("handles semantic tokens with fallbackVar", () => {
      const [className, themeVars] = theme(
        composedValue({
          color: {
            base: {
              blue: "#0000ff"
            },
            semantic: {
              get primary(): string {
                return this.fallbackVar(this.color.base.blue, "#007bff");
              }
            }
          }
        }),
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          base: {
            blue: "var(--color-base-blue)"
          },
          semantic: {
            primary: "var(--color-base-blue, #007bff)"
          }
        }
      });
    });

    it("handles semantic tokens with alias", () => {
      const [className, themeVars] = theme(
        composedValue({
          color: {
            base: {
              blue: "#0000ff",
              red: "#ff0000"
            },
            semantic: {
              get primary(): string {
                return this.alias(this.color.base.blue);
              },
              get danger(): string {
                return this.alias(this.color.base.red);
              }
            }
          }
        }),
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.semantic.primary).toBe("var(--color-base-blue)");
      expect(normalized.color.semantic.danger).toBe("var(--color-base-red)");
    });

    it("handles semantic tokens with raw", () => {
      const [className, themeVars] = theme(
        composedValue({
          color: {
            base: {
              blue: "#0000ff",
              red: "#ff0000"
            },
            semantic: {
              get primary(): string {
                return this.raw(this.color.base.blue);
              },
              get danger(): string {
                return this.raw(this.color.base.red);
              }
            }
          }
        }),
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          base: {
            blue: "var(--color-base-blue)",
            red: "var(--color-base-red)"
          },
          semantic: {
            primary: "#0000ff",
            danger: "#ff0000"
          }
        }
      });
    });

    it("handles TokenCompositeValue", () => {
      const shadowValue = composedValue({
        get resolved() {
          return `${this.color} ${this.offsetX.value}${this.offsetX.unit} ${this.offsetY.value}${this.offsetY.unit}`;
        },
        color: "#00000080",
        offsetX: { value: 0.5, unit: "rem" },
        offsetY: { value: 0.5, unit: "rem" }
      });

      const [className, themeVars] = theme({
        shadow: shadowValue
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.shadow.resolved).toBe("var(--shadow)");
      expect(normalized.shadow.color).toBe("var(--shadow-color)");
      expect(normalized.shadow.offsetX).toBe("var(--shadow-offset-x)");
      expect(normalized.shadow.offsetY).toBe("var(--shadow-offset-y)");
    });

    it("handles TokenUnitValue", () => {
      const [className, themeVars] = theme({
        spacing: { value: 1.5, unit: "rem" },
        borderWidth: { value: 2, unit: "px" }
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        spacing: "var(--spacing)",
        borderWidth: "var(--border-width)"
      });
    });

    it("handles camelCase to kebab-case conversion", () => {
      const [className, themeVars] = theme({
        backgroundColor: "white",
        fontSize: "16px",
        lineHeight: 1.5
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        backgroundColor: "var(--background-color)",
        fontSize: "var(--font-size)",
        lineHeight: "var(--line-height)"
      });
    });

    it("handles deeply nested structures", () => {
      const [className, themeVars] = theme({
        design: {
          system: {
            color: {
              brand: {
                primary: "#007bff",
                secondary: "#6c757d"
              }
            }
          }
        }
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.design.system.color.brand.primary).toBe(
        "var(--design-system-color-brand-primary)"
      );
      expect(normalized.design.system.color.brand.secondary).toBe(
        "var(--design-system-color-brand-secondary)"
      );
    });

    it("handles mixed token types in single theme", () => {
      const [className, themeVars] = theme({
        primitives: {
          color: "red",
          size: 16
        },
        arrays: {
          space: [2, 4, 8]
        },
        definitions: {
          font: {
            $type: "fontFamily",
            $value: ["Inter", "sans-serif"]
          }
        },
        units: {
          spacing: { value: 1.5, unit: "rem" }
        }
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.primitives.color).toBe("var(--primitives-color)");
      expect(normalized.primitives.size).toBe("var(--primitives-size)");
      expect(normalized.arrays.space).toEqual([
        "var(--arrays-space-0)",
        "var(--arrays-space-1)",
        "var(--arrays-space-2)"
      ]);
      expect(normalized.definitions.font).toBe("var(--definitions-font)");
      expect(normalized.units.spacing).toBe("var(--units-spacing)");
    });

    it("handles complex semantic token references", () => {
      const [className, themeVars] = theme(
        composedValue({
          color: {
            base: {
              red: "#ff0000",
              blue: "#0000ff",
              green: "#00ff00"
            },
            semantic: {
              get primary(): string {
                return this.color.base.blue;
              },
              get danger(): string {
                return this.color.base.red;
              },
              get success(): string {
                return this.color.base.green;
              },
              get info(): string {
                return this.fallbackVar(this.color.semantic.primary, "#17a2b8");
              }
            }
          }
        }),
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.semantic.primary).toBe("var(--color-base-blue)");
      expect(normalized.color.semantic.danger).toBe("var(--color-base-red)");
      expect(normalized.color.semantic.success).toBe("var(--color-base-green)");
      expect(normalized.color.semantic.info).toBe(
        "var(--color-base-blue, #17a2b8)"
      );
    });

    it("handles fontWeight token types", () => {
      const [className, themeVars] = theme({
        weight: {
          normal: {
            $type: "fontWeight",
            $value: "normal"
          },
          bold: {
            $type: "fontWeight",
            $value: "bold"
          },
          semiBold: {
            $type: "fontWeight",
            $value: "semi-bold"
          },
          numeric: {
            $type: "fontWeight",
            $value: 300
          }
        }
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.weight.normal).toBe("var(--weight-normal)");
      expect(normalized.weight.bold).toBe("var(--weight-bold)");
      expect(normalized.weight.semiBold).toBe("var(--weight-semi-bold)");
      expect(normalized.weight.numeric).toBe("var(--weight-numeric)");
    });

    it("handles number token types", () => {
      const [className, themeVars] = theme({
        lineHeight: {
          $type: "number",
          $value: 1.5
        },
        zIndex: {
          $type: "number",
          $value: 1000
        }
      });

      expect(className).toBeDefined();
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        lineHeight: "var(--line-height)",
        zIndex: "var(--z-index)"
      });
    });

    it("handles color tokens with complex values", () => {
      const [className, themeVars] = theme({
        color: {
          simple: {
            $type: "color",
            $value: "#ff5500"
          },
          complex: {
            $type: "color",
            $value: {
              colorSpace: "srgb",
              components: [255, 85, 0],
              alpha: 0.8
            }
          }
        }
      });

      expect(className).toBeDefined();
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.simple).toBe("var(--color-simple)");
      expect(normalized.color.complex).toBe("var(--color-complex)");
    });

    it("handles complex color tokens and semantic references", () => {
      const [className, themeVars] = theme(
        {
          color: {
            base: {
              red: {
                $type: "color",
                $value: {
                  colorSpace: "srgb",
                  components: [255, 0, 0]
                }
              },
              green: "#00ff00",
              blue: "#0000ff"
            },
            semantic: {
              get primary(): string {
                return this.color.base.blue;
              },
              get error(): string {
                return this.color.base.red;
              }
            }
          },
          space: {
            base: [2, 4, 8, 16, 32, 64],
            semantic: {
              get small(): string {
                return this.space.base[1];
              },
              get medium(): string {
                return this.space.base[3];
              },
              get large(): string {
                return this.space.base[5];
              }
            }
          }
        },
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          base: {
            red: "var(--color-base-red)",
            green: "var(--color-base-green)",
            blue: "var(--color-base-blue)"
          },
          semantic: {
            primary: "var(--color-base-blue)",
            error: "var(--color-base-red)"
          }
        },
        space: {
          base: [
            "var(--space-base-0)",
            "var(--space-base-1)",
            "var(--space-base-2)",
            "var(--space-base-3)",
            "var(--space-base-4)",
            "var(--space-base-5)"
          ],
          semantic: {
            small: "var(--space-base-1)",
            medium: "var(--space-base-3)",
            large: "var(--space-base-5)"
          }
        }
      });
    });

    it("integrates with globalTheme correctly", () => {
      const [className, themeVars] = theme(
        {
          color: {
            primary: "#007bff"
          }
        },
        "testTheme"
      );

      expect(className).toMatch(identifierName("testTheme"));
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          primary: "var(--color-primary)"
        }
      });
    });

    it("handles empty theme object", () => {
      const [className, themeVars] = theme({});

      expect(className).toBeDefined();
      expect(themeVars).toEqual({});
    });
  });
}

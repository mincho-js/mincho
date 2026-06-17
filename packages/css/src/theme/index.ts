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

const THEME_CONTRACT_EXPECTED_ERROR =
  "Theme replacement expected ThemeContract as first argument";
const THEME_CONTRACT_REPLACEMENT_TOKENS_EXPECTED_ERROR =
  "Theme replacement expected replacement tokens when first argument is ThemeContract";

export type ThemeContract<T extends Theme = Theme> = {
  readonly vars: ResolveThemeOutput<T>;
  readonly values: Readonly<Record<string, CSSVarValue>>;
  readonly cssVarByPath: Readonly<CSSVarMap>;
};

export type ThemeResult<T extends Theme = Theme> = [
  className: string,
  vars: ResolveThemeOutput<T>,
  contract: ThemeContract<T>
];

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

function themeImpl<const ThemeTokens extends Theme>(
  tokens: ThemeTokensInput<ThemeTokens>,
  debugId?: string
): ThemeResult<ThemeTokens>;
function themeImpl<const ThemeTokens extends Theme>(
  contract: ThemeContract<ThemeTokens>,
  replacementTokens: ThemeTokensInput<ThemeTokens>,
  debugId?: string
): ThemeResult<ThemeTokens>;
function themeImpl<const ThemeTokens extends Theme>(
  tokensOrVars: unknown,
  debugIdOrReplacementTokens?: unknown,
  debugId?: unknown
): ThemeResult<ThemeTokens> {
  if (isThemeExtensionCall(debugIdOrReplacementTokens)) {
    if (debugId !== undefined && typeof debugId !== "string") {
      throw new Error("theme() extension debugId must be a string.");
    }

    assertThemeContract<ThemeTokens>(tokensOrVars);

    return createThemeResult(
      debugIdOrReplacementTokens as ThemeTokensInput<ThemeTokens>,
      debugId,
      (tokens) => assignReplacementTokensFromContract(tokensOrVars, tokens)
    );
  }

  if (isThemeContract(tokensOrVars)) {
    throw new Error(THEME_CONTRACT_REPLACEMENT_TOKENS_EXPECTED_ERROR);
  }

  if (
    debugIdOrReplacementTokens !== undefined &&
    typeof debugIdOrReplacementTokens !== "string"
  ) {
    throw new Error("theme() debugId must be a string.");
  }

  if (debugId !== undefined) {
    throw new Error("theme() direct mode does not accept a third argument.");
  }

  return createThemeResult(
    tokensOrVars as ThemeTokensInput<ThemeTokens>,
    debugIdOrReplacementTokens as string | undefined,
    assignTokens
  );
}

function themeWith<const ThemeTokens extends Theme>(): (
  tokens: ThemeTokensInput<ThemeTokens>,
  debugId?: string
) => ThemeResult<ThemeTokens> {
  return (tokens: ThemeTokensInput<ThemeTokens>, debugId?: string) =>
    themeImpl(tokens, debugId);
}

export const theme = Object.assign(themeImpl, { with: themeWith });

// == Theme Orchestration =====================================================
interface ThemeAssignmentResult<ThemeTokens extends Theme> {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
  cssVarMap: CSSVarMap;
}

function createThemeResult<const ThemeTokens extends Theme>(
  tokens: ThemeTokensInput<ThemeTokens>,
  debugId: string | undefined,
  assign: (tokens: ThemeTokens) => ThemeAssignmentResult<ThemeTokens>
): ThemeResult<ThemeTokens> {
  const themeClassName = generateIdentifier(debugId);
  registerClassName(themeClassName, getFileScope());

  const { layerName, tokens: themeTokens } = extractLayerFromTokens(tokens);
  const { vars, resolvedTokens, cssVarMap } = assign(themeTokens);
  const rule = createThemeRule(layerName, vars);
  const resolvedThemeTokens = resolvedTokens as ResolveThemeOutput<ThemeTokens>;
  const contract = createThemeContract<ThemeTokens>(
    resolvedThemeTokens,
    vars,
    cssVarMap
  );

  globalCss(themeClassName, rule);
  return [themeClassName, resolvedThemeTokens, contract];
}

function createThemeRule(
  layerName: string | undefined,
  vars: AssignedVars
): GlobalCSSRule {
  return layerName != null
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

// == Assignment State ========================================================
interface AssignedVars {
  [cssVarName: string]: CSSVarValue;
}
interface CSSVarMap {
  [varPath: string]: PureCSSVarKey;
}
interface ThemeAssignmentMetadata {
  cssVarMap: Readonly<CSSVarMap>;
  assignedVars: Readonly<Record<string, CSSVarValue>>;
}
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

function createThemeContract<const ThemeTokens extends Theme>(
  vars: ResolveThemeOutput<ThemeTokens>,
  values: Readonly<Record<string, CSSVarValue>>,
  cssVarByPath: Readonly<CSSVarMap>
): ThemeContract<ThemeTokens> {
  const contractValues = Object.freeze({ ...values }) as Readonly<
    Record<string, CSSVarValue>
  >;
  const contractCSSVarByPath = Object.freeze({
    ...cssVarByPath
  }) as Readonly<CSSVarMap>;

  return Object.freeze({
    vars,
    values: contractValues,
    cssVarByPath: contractCSSVarByPath
  }) as ThemeContract<ThemeTokens>;
}

function isThemeContract<ThemeTokens extends Theme = Theme>(
  value: unknown
): value is ThemeContract<ThemeTokens> {
  if (!isPlainObject(value)) return false;

  const contract = value as {
    readonly vars?: unknown;
    readonly values?: unknown;
    readonly cssVarByPath?: unknown;
  };

  return (
    "vars" in contract &&
    isPlainObject(contract.vars) &&
    isPlainObject(contract.values) &&
    isPlainObject(contract.cssVarByPath)
  );
}

function assertThemeContract<ThemeTokens extends Theme = Theme>(
  value: unknown
): asserts value is ThemeContract<ThemeTokens> {
  if (!isThemeContract<ThemeTokens>(value)) {
    throw new Error(THEME_CONTRACT_EXPECTED_ERROR);
  }
}

// == Direct Theme Assignment ================================================
function assignTokens<ThemeTokens extends Theme>(
  tokens: ThemeTokensInput<ThemeTokens>
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
  cssVarMap: CSSVarMap;
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
  cssVarMap: CSSVarMap;
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

  return {
    vars,
    resolvedTokens,
    cssVarMap: { ...context.cssVarMap }
  };
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
      const compositeDescriptors = Object.getOwnPropertyDescriptors(value);

      // Create getter for resolved property
      Object.defineProperty(resolvedComposite, "resolved", {
        get() {
          return varRef;
        },
        enumerable: true,
        configurable: true
      });

      // Process other properties
      for (const [propKey, propDescriptor] of Object.entries(
        compositeDescriptors
      )) {
        if (propKey === "resolved") continue;

        const propPath = `${varPath}-${camelToKebab(propKey)}`;
        const propCssVar = getCSSVarByPath(propPath, context);
        if (typeof propDescriptor.get === "function") {
          // Store placeholder reference; value will be resolved in pass 2
          resolvedComposite[propKey] = getVarReference(propPath, context);
          continue;
        }

        vars[propCssVar] = extractCSSValue(propDescriptor.value as TokenValue);
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
        // Just update resolvedTokens with the aliased reference
        setByPath(resolvedTokens, currentPath, computedValue);
      } else {
        // Normal flow: create CSS variable
        const cssVar = getCSSVarByPath(varPath, context);
        vars[cssVar] = computedValue;
        setByPath(resolvedTokens, currentPath, computedValue);
      }
      continue;
    }

    const value = descriptor.value;

    // Handle TokenCompositeValue resolved property computation
    if (isTokenCompositeValue(value)) {
      const compositeDescriptors = Object.getOwnPropertyDescriptors(value);
      const resolvedDescriptor = compositeDescriptors.resolved;

      if (resolvedDescriptor?.get) {
        const resolvedPath = [...currentPath, "resolved"];
        const evaluationContext = Object.create(resolvedTokens);

        for (const [propKey, propDescriptor] of Object.entries(
          compositeDescriptors
        )) {
          if (propKey === "resolved") continue;
          Object.defineProperty(evaluationContext, propKey, propDescriptor);
        }

        currentProcessingPath = resolvedPath;
        const computedValue = resolvedDescriptor.get.call(evaluationContext);
        currentProcessingPath = [];

        const resolvedPathKey = resolvedPath.join(".");

        if (context.aliasMap.has(resolvedPathKey)) {
          setByPath(resolvedTokens, resolvedPath, computedValue);
        } else {
          const cssVar = getCSSVarByPath(varPath, context);
          vars[cssVar] = extractCSSValue(computedValue as TokenValue);
        }
      }

      continue;
    }

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

// == Replacement Theme Assignment ============================================
function isThemeExtensionCall(
  value: unknown
): value is ThemeTokensInput<Theme> {
  return typeof value === "object" && value !== null;
}

function assignReplacementTokensFromContract<ThemeTokens extends Theme>(
  contract: ThemeContract<ThemeTokens>,
  replacementTokens: ThemeTokens
): {
  vars: AssignedVars;
  resolvedTokens: ResolveTheme<ThemeTokens>;
  cssVarMap: CSSVarMap;
} {
  const vars = contract.vars;
  const assignedVars: AssignedVars = {};
  const context: ReplacementProcessingContext = {
    prefix: "",
    path: [],
    parentPath: "",
    cssVarMap: { ...contract.cssVarByPath },
    aliasMap: new Set(),
    metadata: {
      cssVarMap: contract.cssVarByPath,
      assignedVars: contract.values
    }
  };
  const resolvedTokens = createReplacementResolvedTokens(
    vars,
    assignedVars,
    context
  );

  assignReplacementTokenVariables(
    vars,
    replacementTokens,
    assignedVars,
    resolvedTokens,
    context
  );
  resolveReplacementSemanticTokens(
    vars,
    replacementTokens,
    assignedVars,
    resolvedTokens,
    context
  );

  return {
    vars: assignedVars,
    resolvedTokens: resolvedTokens as ResolveTheme<ThemeTokens>,
    cssVarMap: { ...contract.cssVarByPath }
  };
}

interface ReplacementProcessingContext extends TokenProcessingContext {
  metadata: ThemeAssignmentMetadata;
}

function createReplacementResolvedTokens(
  vars: unknown,
  assignedVars: AssignedVars,
  context: ReplacementProcessingContext
): Record<string, unknown> {
  const resolvedTokens = cloneResolvedVars(vars);

  if (!isPlainObject(resolvedTokens) || Array.isArray(resolvedTokens)) {
    throw new Error(`Expected theme vars object at path "<root>".`);
  }

  Object.defineProperty(resolvedTokens, "fallbackVar", {
    value: fallbackVar,
    enumerable: false,
    configurable: false,
    writable: false
  });

  Object.defineProperty(resolvedTokens, "raw", {
    value: createRawExtractor(assignedVars),
    enumerable: false,
    configurable: false,
    writable: false
  });

  Object.defineProperty(resolvedTokens, "alias", {
    value: createAliasFunction(context),
    enumerable: false,
    configurable: false,
    writable: false
  });

  return resolvedTokens;
}

function cloneResolvedVars(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneResolvedVars);
  }

  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
      cloned[key] = cloneResolvedVars((value as Record<string, unknown>)[key]);
    }

    return cloned;
  }

  return value;
}

function assignReplacementTokenVariables(
  varsNode: unknown,
  replacementNode: unknown,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  context: ReplacementProcessingContext
): void {
  if (!isNestedTheme(replacementNode)) {
    throw new Error(
      `Unsupported replacement token at path "${formatTokenPath(context.path)}".`
    );
  }

  if (!isPlainObject(varsNode) || Array.isArray(varsNode)) {
    throw new Error(
      `Expected theme vars object at path "${formatTokenPath(context.path)}".`
    );
  }

  const varsRecord = varsNode as Record<string, unknown>;
  const replacementRecord = replacementNode as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(replacementRecord);

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const currentPath = [...context.path, key];
    if (!Object.prototype.hasOwnProperty.call(varsRecord, key)) {
      throw createThemeExtensionExtraReplacementError(currentPath);
    }

    if (typeof descriptor.get === "function") {
      continue;
    }

    assignReplacementTokenValue(
      varsRecord[key],
      descriptor.value,
      assignedVars,
      resolvedTokens,
      currentPath,
      context
    );
  }

  for (const key of Object.keys(varsRecord)) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw createThemeExtensionMissingReplacementError([...context.path, key]);
    }
  }
}

function assignReplacementTokenValue(
  varsNode: unknown,
  replacementNode: unknown,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  path: string[],
  context: ReplacementProcessingContext
): void {
  if (isSupportedReplacementLeaf(replacementNode)) {
    const cssVar = getReplacementCSSVar(varsNode, path, context);
    assignedVars[cssVar] = extractCSSValue(replacementNode);
    setByPath(resolvedTokens, path, varsNode);
    return;
  }

  if (Array.isArray(replacementNode)) {
    assignReplacementTokenArray(
      varsNode,
      replacementNode,
      assignedVars,
      resolvedTokens,
      path,
      context
    );
    return;
  }

  if (isTokenDefinition(replacementNode)) {
    assignReplacementTokenDefinition(
      varsNode,
      replacementNode,
      assignedVars,
      resolvedTokens,
      path,
      context
    );
    return;
  }

  if (isTokenCompositeValue(replacementNode)) {
    assignReplacementCompositeVariables(
      varsNode,
      replacementNode,
      assignedVars,
      resolvedTokens,
      path,
      context
    );
    return;
  }

  if (isNestedTheme(replacementNode)) {
    assignReplacementTokenVariables(
      varsNode,
      replacementNode,
      assignedVars,
      resolvedTokens,
      createReplacementChildContext(context, path)
    );
    return;
  }

  throw new Error(
    `Unsupported replacement token at path "${formatTokenPath(path)}".`
  );
}

function assignReplacementTokenArray(
  varsNode: unknown,
  replacementArray: unknown[],
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  path: string[],
  context: ReplacementProcessingContext
): void {
  if (!Array.isArray(varsNode)) {
    throw new Error(
      `Expected theme vars array at path "${formatTokenPath(path)}".`
    );
  }

  if (varsNode.length !== replacementArray.length) {
    throw createThemeExtensionArrayLengthMismatchError(path);
  }

  replacementArray.forEach((item, index) => {
    const currentPath = [...path, String(index)];
    const cssVar = getReplacementCSSVar(varsNode[index], currentPath, context);
    assignedVars[cssVar] = extractCSSValue(item as TokenValue);
  });
  setByPath(resolvedTokens, path, cloneResolvedVars(varsNode));
}

function assignReplacementTokenDefinition(
  varsNode: unknown,
  definition: TokenDefinition,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  path: string[],
  context: ReplacementProcessingContext
): void {
  const tokenValue = definition.$value;

  if (isStructuredTokenValue(definition.$type, tokenValue)) {
    const cssVar = getReplacementCSSVar(varsNode, path, context);
    assignedVars[cssVar] = extractTokenDefinitionValue(definition);
    setByPath(resolvedTokens, path, varsNode);
    return;
  }

  if (isNestedTheme(tokenValue)) {
    assignReplacementTokenVariables(
      varsNode,
      tokenValue,
      assignedVars,
      resolvedTokens,
      createReplacementChildContext(context, path)
    );
    return;
  }

  const cssVar = getReplacementCSSVar(varsNode, path, context);
  assignedVars[cssVar] = extractTokenDefinitionValue(definition);
  setByPath(resolvedTokens, path, varsNode);
}

function assignReplacementCompositeVariables(
  varsNode: unknown,
  replacementNode: TokenCompositeValue,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  path: string[],
  context: ReplacementProcessingContext
): void {
  if (!isPlainObject(varsNode) || Array.isArray(varsNode)) {
    throw new Error(
      `Expected theme vars object at path "${formatTokenPath(path)}".`
    );
  }

  const varsRecord = varsNode as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(replacementNode);

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "resolved") continue;

    const currentPath = [...path, key];
    if (!Object.prototype.hasOwnProperty.call(varsRecord, key)) {
      throw createThemeExtensionExtraReplacementError(currentPath);
    }

    if (typeof descriptor.get === "function") {
      continue;
    }

    const cssVar = getReplacementCSSVar(varsRecord[key], currentPath, context);
    assignedVars[cssVar] = extractCSSValue(descriptor.value as TokenValue);
    setByPath(resolvedTokens, currentPath, varsRecord[key]);
  }

  for (const key of Object.keys(varsRecord)) {
    if (key === "resolved") continue;

    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw createThemeExtensionMissingReplacementError([...path, key]);
    }
  }
}

function resolveReplacementSemanticTokens(
  varsNode: unknown,
  replacementNode: unknown,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  context: ReplacementProcessingContext
): void {
  if (isTokenDefinition(replacementNode)) {
    if (isNestedTheme(replacementNode.$value)) {
      resolveReplacementSemanticTokens(
        varsNode,
        replacementNode.$value,
        assignedVars,
        resolvedTokens,
        context
      );
    }
    return;
  }

  if (isTokenCompositeValue(replacementNode)) {
    resolveReplacementCompositeValue(
      varsNode,
      replacementNode,
      assignedVars,
      resolvedTokens,
      context.path,
      context
    );
    return;
  }

  if (!isNestedTheme(replacementNode)) {
    return;
  }

  if (!isPlainObject(varsNode) || Array.isArray(varsNode)) {
    throw new Error(
      `Expected theme vars object at path "${formatTokenPath(context.path)}".`
    );
  }

  const varsRecord = varsNode as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(replacementNode);

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const currentPath = [...context.path, key];
    const childVarsNode = varsRecord[key];

    if (typeof descriptor.get === "function") {
      const computedValue = callReplacementGetter(
        descriptor.get,
        resolvedTokens,
        currentPath
      );
      const currentPathKey = currentPath.join(".");

      if (context.aliasMap.has(currentPathKey)) {
        setByPath(resolvedTokens, currentPath, computedValue);
      } else {
        const cssVar = getReplacementCSSVar(
          childVarsNode,
          currentPath,
          context
        );
        assignedVars[cssVar] = computedValue as CSSVarValue;
        setByPath(resolvedTokens, currentPath, computedValue);
      }

      continue;
    }

    const value = descriptor.value;
    const childContext = createReplacementChildContext(context, currentPath);

    if (isTokenDefinition(value)) {
      if (isNestedTheme(value.$value)) {
        resolveReplacementSemanticTokens(
          childVarsNode,
          value.$value,
          assignedVars,
          resolvedTokens,
          childContext
        );
      }
      continue;
    }

    if (isTokenCompositeValue(value)) {
      resolveReplacementCompositeValue(
        childVarsNode,
        value,
        assignedVars,
        resolvedTokens,
        currentPath,
        context
      );
      continue;
    }

    if (isNestedTheme(value)) {
      resolveReplacementSemanticTokens(
        childVarsNode,
        value,
        assignedVars,
        resolvedTokens,
        childContext
      );
    }
  }
}

function resolveReplacementCompositeValue(
  varsNode: unknown,
  replacementNode: TokenCompositeValue,
  assignedVars: AssignedVars,
  resolvedTokens: Record<string, unknown>,
  path: string[],
  context: ReplacementProcessingContext
): void {
  const descriptors = Object.getOwnPropertyDescriptors(replacementNode);
  const resolvedDescriptor = descriptors.resolved;

  if (typeof resolvedDescriptor?.get !== "function") return;

  const evaluationContext = Object.create(resolvedTokens) as Record<
    string,
    unknown
  >;

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "resolved") continue;
    Object.defineProperty(evaluationContext, key, descriptor);
  }

  const resolvedPath = [...path, "resolved"];
  const computedValue = callReplacementGetter(
    resolvedDescriptor.get,
    evaluationContext,
    resolvedPath
  );
  const resolvedPathKey = resolvedPath.join(".");

  if (context.aliasMap.has(resolvedPathKey)) {
    setByPath(resolvedTokens, resolvedPath, computedValue);
    return;
  }

  const fallbackVarReference = isPlainObject(varsNode)
    ? (varsNode as Record<string, unknown>).resolved
    : varsNode;
  const cssVar = getReplacementCSSVar(fallbackVarReference, path, context);
  assignedVars[cssVar] = extractCSSValue(computedValue as TokenValue);
  setByPath(resolvedTokens, resolvedPath, `var(${cssVar})`);
}

function callReplacementGetter(
  getter: () => unknown,
  thisArg: unknown,
  path: string[]
): unknown {
  currentProcessingPath = path;
  try {
    return getter.call(thisArg);
  } finally {
    currentProcessingPath = [];
  }
}

function createReplacementChildContext(
  context: ReplacementProcessingContext,
  path: string[]
): ReplacementProcessingContext {
  return {
    prefix: context.prefix,
    path,
    parentPath: tokenPathToCSSVarPath(path),
    cssVarMap: context.cssVarMap,
    aliasMap: context.aliasMap,
    metadata: context.metadata
  };
}

function getReplacementCSSVar(
  varReference: unknown,
  path: string[],
  context: ReplacementProcessingContext
): PureCSSVarKey {
  const varPath = tokenPathToCSSVarPath(path);
  const metadataVar = context.metadata.cssVarMap[varPath];

  if (
    metadataVar !== undefined &&
    Object.prototype.hasOwnProperty.call(
      context.metadata.assignedVars,
      metadataVar
    )
  ) {
    return metadataVar;
  }

  return extractCSSVarFromVarReference(varReference, path);
}

// == Shared Theme Helpers ====================================================
function tokenPathToCSSVarPath(path: string[]): string {
  return path.map(camelToKebab).join("-");
}

function isSupportedReplacementLeaf(value: unknown): value is TokenValue {
  return isPrimitive(value) || isTokenUnitValue(value);
}

function extractCSSVarFromVarReference(
  varReference: unknown,
  path: string[]
): PureCSSVarKey {
  if (typeof varReference !== "string") {
    throw createThemeExtensionExpectedVarReferenceError(path);
  }

  const cssVar = getVarName(varReference);
  if (cssVar === varReference || !cssVar.startsWith("--")) {
    throw createThemeExtensionExpectedVarReferenceError(path);
  }

  return cssVar;
}

function formatTokenPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function createThemeExtensionMissingReplacementError(path: string[]): Error {
  return new Error(
    `Theme extension missing replacement token at "${formatTokenPath(path)}".`
  );
}

function createThemeExtensionExtraReplacementError(path: string[]): Error {
  return new Error(
    `Theme extension replacement token at "${formatTokenPath(path)}" does not exist in base vars.`
  );
}

function createThemeExtensionExpectedVarReferenceError(path: string[]): Error {
  return new Error(
    `Theme extension expected var() reference at "${formatTokenPath(path)}".`
  );
}

function createThemeExtensionArrayLengthMismatchError(path: string[]): Error {
  return new Error(
    `Theme extension array length mismatch at "${formatTokenPath(path)}".`
  );
}

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

// == Theme Tests =============================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, assertType, expectTypeOf, vi } = import.meta
    .vitest;

  const debugId = "myCSS";
  setFileScope("test");

  function compositeValue<CompositeValue>(
    value: CompositeValue & ThisType<CompositeValue & ThemeSubFunctions>
  ): CompositeValue {
    return value;
  }

  // Test utility functions for handling hashed CSS variables
  /**
   * Removes hash suffixes from CSS variable names and var() references
   */
  function stripHash(str: string): string {
    // Remove hash suffix from CSS variable names and var() references
    return str.replace(/__[a-zA-Z0-9]+/g, "");
  }
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

  function deepFreezeObject<T>(value: T): T {
    if (value && typeof value === "object") {
      const descriptors = Object.getOwnPropertyDescriptors(value);

      for (const descriptor of Object.values(descriptors)) {
        if ("value" in descriptor) {
          deepFreezeObject(descriptor.value);
        }
      }

      Object.freeze(value);
    }

    return value;
  }

  function expectThemeContractResult<const ThemeTokens extends Theme>(
    result: ThemeResult<ThemeTokens>
  ): ThemeContract<ThemeTokens> {
    const [, vars, contract] = result;

    expect(result).toHaveLength(3);
    expect(isThemeContract(contract)).toBe(true);
    expect(contract.vars).toBe(vars);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.values)).toBe(true);
    expect(Object.isFrozen(contract.cssVarByPath)).toBe(true);
    assertType<ThemeContract<ThemeTokens>>(contract);

    return contract;
  }

  function expectThemeVarsContract(
    vars: unknown,
    contract: ThemeContract
  ): void {
    expect(isThemeContract(contract)).toBe(true);
    expect(contract.vars).toBe(vars);
    expect(Object.keys(contract)).toEqual(["vars", "values", "cssVarByPath"]);
  }

  function callThemeExtensionForRuntimeError<ThemeTokens extends Theme>(
    contract: ThemeContract<ThemeTokens>,
    replacementTokens: unknown,
    debugId: string
  ): ThemeResult<ThemeTokens> {
    return theme(
      contract,
      replacementTokens as ThemeTokensInput<ThemeTokens>,
      debugId
    );
  }

  function callThemeForRuntimeError<ThemeTokens extends Theme>(
    tokensOrContract: unknown,
    debugIdOrReplacementTokens?: unknown,
    debugId?: unknown
  ): ThemeResult<ThemeTokens> {
    const callTheme = theme as unknown as (
      ...args: unknown[]
    ) => ThemeResult<ThemeTokens>;

    return callTheme(tokensOrContract, debugIdOrReplacementTokens, debugId);
  }

  // Validate that CSS variables have proper hash format
  const VAR_HASH_REGEX = /^--[a-zA-Z0-9-]+__[a-zA-Z0-9]+$/;
  function validateHashFormatForVar(vars: AssignedVars): void {
    for (const key of Object.keys(vars)) {
      expect(key).toMatch(VAR_HASH_REGEX);
    }
  }

  function validateHashFormatForResolved(resolved: object): void {
    const flattedTokens = flattenAndFilterResolvedTokens(resolved);
    for (const key of Object.keys(flattedTokens)) {
      const varName = getVarName(flattedTokens[key]);
      expect(varName).toMatch(VAR_HASH_REGEX);
    }
  }

  function flattenAndFilterResolvedTokens(
    tokens: object,
    prefix: string = "",
    result: Record<string, string> = {}
  ) {
    for (const [key, value] of Object.entries(tokens)) {
      const newKey = prefix ? `${prefix}-${key}` : key;

      if (typeof value === "object" && value !== null) {
        flattenAndFilterResolvedTokens(value, newKey, result);
      } else if (typeof value === "string" && value.startsWith("var(--")) {
        result[newKey] = value;
      }
    }

    return result;
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
      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
        compositeValue({
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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
        compositeValue({
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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
        compositeValue({
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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
        compositeValue({
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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
      const result = assignTokens({
        shadow: {
          light: {
            get resolved(): string {
              return `${this.shadow.light.color} ${this.shadow.light.offsetX} ${this.shadow.light.offsetY} ${this.shadow.light.blur}`;
            },
            color: "#00000080",
            offsetX: { value: 0.5, unit: "rem" },
            offsetY: { value: 0.5, unit: "rem" },
            blur: { value: 1.5, unit: "rem" }
          }
        }
      });

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

      const normalized = normalizeVars(result.vars);
      expect(stripHash(normalized["--shadow-light"])).toBe(
        "var(--shadow-light-color) var(--shadow-light-offset-x) var(--shadow-light-offset-y) var(--shadow-light-blur)"
      );
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

      validateHashFormatForVar(result.vars);
      validateHashFormatForResolved(result.resolvedTokens);

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
    it("creates structural ThemeContract metadata", () => {
      type ContractTheme = {
        color: { brand: string; accent: string };
      };
      const tokens = {
        color: { brand: "blue", accent: "cyan" }
      } satisfies ThemeTokensInput<ContractTheme>;
      const result = theme(tokens, "theme-contract-class");
      const [, vars, contract] = result;
      expectThemeContractResult(result);

      assertType<ThemeContract<ContractTheme>>(contract);
      assertType<ThemeResult<ContractTheme>>(result);
      assertType<PureCSSVarFunction>(contract.vars.color.brand);
      expectTypeOf(contract.values).toEqualTypeOf<
        Readonly<Record<string, CSSVarValue>>
      >();
      expectTypeOf(contract.cssVarByPath).toEqualTypeOf<Readonly<CSSVarMap>>();
      // @ts-expect-error: resolved vars are not full ThemeContract values.
      assertType<ThemeContract<ContractTheme>>(contract.vars);
      assertType<ThemeContract<ContractTheme>>({
        vars: contract.vars,
        values: contract.values,
        cssVarByPath: contract.cssVarByPath
      });

      expect(Object.keys(contract)).toEqual(["vars", "values", "cssVarByPath"]);
      expect(contract.vars).toBe(vars);
      expect(Object.isFrozen(contract.values)).toBe(true);
      expect(Object.isFrozen(contract.cssVarByPath)).toBe(true);
      expect(Object.getOwnPropertySymbols(contract)).toEqual([]);

      expect(contract.cssVarByPath["color-brand"]).toMatch(/^--color-brand__/);
      expect(
        Object.prototype.hasOwnProperty.call(
          contract.values,
          contract.cssVarByPath["color-brand"]
        )
      ).toBe(true);
      expect(normalizeVars(contract.values as AssignedVars)).toEqual({
        "--color-brand": "blue",
        "--color-accent": "cyan"
      });
    });

    it("rejects invalid ThemeContract replacement inputs", () => {
      type ContractTheme = { color: { brand: string } };
      const tokens = {
        color: { brand: "blue" }
      } satisfies ThemeTokensInput<ContractTheme>;
      const result = theme(tokens, "theme-invalid-contract-base");
      const [, vars, contract] = result;
      const replacementTokens = {
        color: { brand: "red" }
      } satisfies ThemeTokensInput<ContractTheme>;

      expectThemeContractResult(result);
      expect(isThemeContract(contract)).toBe(true);
      expect(isThemeContract({})).toBe(false);
      expect(() => assertThemeContract({})).toThrow(
        THEME_CONTRACT_EXPECTED_ERROR
      );
      expect(() => assertThemeContract(vars)).toThrow(
        THEME_CONTRACT_EXPECTED_ERROR
      );
      expect(() =>
        theme(
          {} as unknown as ThemeContract<ContractTheme>,
          replacementTokens,
          "theme-invalid-contract-object"
        )
      ).toThrow(THEME_CONTRACT_EXPECTED_ERROR);
      expect(() =>
        theme(
          vars as unknown as ThemeContract<ContractTheme>,
          replacementTokens,
          "theme-invalid-contract-vars"
        )
      ).toThrow(THEME_CONTRACT_EXPECTED_ERROR);
      expect(() =>
        callThemeForRuntimeError<ContractTheme>(vars, replacementTokens)
      ).toThrow(THEME_CONTRACT_EXPECTED_ERROR);
      expect(() =>
        theme(
          {
            vars: contract.vars,
            values: contract.values
          } as unknown as ThemeContract<ContractTheme>,
          replacementTokens,
          "theme-invalid-contract-incomplete"
        )
      ).toThrow(THEME_CONTRACT_EXPECTED_ERROR);
      expect(() =>
        theme(
          {
            vars: contract.vars,
            values: contract.values,
            cssVarByPath: contract.cssVarByPath
          },
          replacementTokens,
          "theme-structural-contract-object"
        )
      ).not.toThrow();
      expect(() => callThemeForRuntimeError<ContractTheme>(contract)).toThrow(
        THEME_CONTRACT_REPLACEMENT_TOKENS_EXPECTED_ERROR
      );
      expect(() =>
        callThemeForRuntimeError<ContractTheme>(
          contract,
          "theme-contract-with-debug"
        )
      ).toThrow(THEME_CONTRACT_REPLACEMENT_TOKENS_EXPECTED_ERROR);
    });

    it("exposes theme.with as a callable wrapper", () => {
      expect(typeof theme.with).toBe("function");

      const themeTokens = theme.with<{ color: string }>();
      const result = themeTokens({ color: "red" }, "theme-with");

      expect(Array.isArray(result)).toBe(true);
      expectThemeContractResult(result);
      expect(result[0]).toMatch(identifierName("theme-with"));
      validateHashFormatForResolved(result[1]);
    });

    it("delegates theme.with() directly to theme()", () => {
      const themeTokens = theme.with<{
        color: string;
        nested: { size: number };
      }>();
      const tokens = {
        color: "red",
        nested: { size: 12 }
      } as const;

      const wrapped = themeTokens(tokens, "theme1");
      const direct = theme(tokens, "theme1");

      expect(Array.isArray(wrapped)).toBe(true);
      expectThemeContractResult(wrapped);
      expectThemeContractResult(direct);
      expect(wrapped[0]).toMatch(identifierName("theme1"));
      expect(direct[0]).toMatch(identifierName("theme1"));
      expect(normalizeResolvedTokens(wrapped[1])).toEqual(
        normalizeResolvedTokens(direct[1])
      );
      expect(wrapped[2].vars).toBe(wrapped[1]);
      expect(direct[2].vars).toBe(direct[1]);
      validateHashFormatForResolved(wrapped[1]);
      validateHashFormatForResolved(direct[1]);
    });

    it("enforces theme.with() token contracts", () => {
      const myTheme = theme.with<{
        color: { brand: string };
        font: { body: string };
      }>();

      const [themeClass, vars, contract] = myTheme({
        color: { brand: "blue" },
        font: { body: "arial" }
      });

      assertType<string>(themeClass);
      assertType<PureCSSVarFunction>(vars.color.brand);
      assertType<PureCSSVarFunction>(vars.font.body);
      assertType<
        ThemeContract<{ color: { brand: string }; font: { body: string } }>
      >(contract);
      expect(isThemeContract(contract)).toBe(true);
      expect(contract.vars).toBe(vars);
      expectTypeOf<typeof vars.color.brand>().not.toBeAny();
      expectTypeOf<
        typeof vars.color.brand
      >().branded.toEqualTypeOf<PureCSSVarFunction>();
      expectTypeOf<typeof vars.color.brand>().not.toEqualTypeOf<
        PureCSSVarFunction[]
      >();
      expectTypeOf<typeof vars.font.body>().not.toBeAny();
      expectTypeOf<
        typeof vars.font.body
      >().branded.toEqualTypeOf<PureCSSVarFunction>();
      expectTypeOf<typeof vars.font.body>().not.toEqualTypeOf<
        PureCSSVarFunction[]
      >();

      // @ts-expect-error: font is required by the theme contract.
      myTheme({
        color: { brand: "blue" }
      });
      myTheme({
        color: {
          // @ts-expect-error: color.brand must be a string.
          brand: 123
        },
        font: { body: "arial" }
      });
      myTheme({
        color: { brand: "blue" },
        font: { body: "arial" },
        // @ts-expect-error: top-level keys outside the contract are not accepted.
        space: "4px"
      });
      myTheme({
        color: {
          brand: "blue",
          // @ts-expect-error: nested keys outside the contract are not accepted.
          accent: "red"
        },
        font: { body: "arial" }
      });
    });

    it("preserves @layer and semantic helpers through theme.with()", () => {
      const semanticTheme = theme.with<{
        color: {
          brand: string;
          semantic: { primary: string };
        };
        font: { body: string };
      }>();

      const [className, vars, contract] = semanticTheme(
        {
          "@layer": "tokens",
          color: {
            brand: "#0055ff",
            semantic: {
              get primary(): string {
                return this.fallbackVar(this.color.brand, "#0055ff");
              }
            }
          },
          font: { body: "Inter" }
        },
        "theme-with-layer"
      );

      assertType<PureCSSVarFunction>(vars.color.brand);
      assertType<PureCSSVarFunction>(vars.color.semantic.primary);
      assertType<PureCSSVarFunction>(vars.font.body);
      assertType<
        ThemeContract<{
          color: { brand: string; semantic: { primary: string } };
          font: { body: string };
        }>
      >(contract);
      expect(isThemeContract(contract)).toBe(true);
      expect(contract.vars).toBe(vars);
      expect(className).toMatch(identifierName("theme-with-layer"));
      validateHashFormatForResolved(vars);
      expect(normalizeResolvedTokens(vars)).toEqual({
        color: {
          brand: "var(--color-brand)",
          semantic: {
            primary: "var(--color-brand, #0055ff)"
          }
        },
        font: {
          body: "var(--font-body)"
        }
      });
    });

    it("preserves overload return types", () => {
      type ExpectedTheme = {
        colors: { brand: string };
        font: { body: string };
      };
      type ExpectedVars = {
        colors: { brand: PureCSSVarFunction };
        font: { body: PureCSSVarFunction };
      };
      type SingleTokenTheme = { color: string };
      type SingleTokenVars = { color: PureCSSVarFunction };
      const tokens: ThemeTokensInput<ExpectedTheme> = {
        colors: { brand: "blue" },
        font: { body: "arial" }
      };
      const direct = theme(tokens);

      assertType<ThemeResult<ExpectedTheme>>(direct);
      assertType<ExpectedVars>(direct[1]);
      expectTypeOf(direct).toEqualTypeOf<ThemeResult<ExpectedTheme>>();
      const directContract = expectThemeContractResult(direct);

      const directWithDebug = theme(tokens, "theme-overload-direct-debug");

      assertType<ThemeResult<ExpectedTheme>>(directWithDebug);
      assertType<ExpectedVars>(directWithDebug[1]);
      expectTypeOf(directWithDebug).toEqualTypeOf<ThemeResult<ExpectedTheme>>();
      expectThemeContractResult(directWithDebug);
      assertType<ThemeContract<ExpectedTheme>>(directContract);

      const replacementTokens: ThemeTokensInput<ExpectedTheme> = {
        colors: { brand: "red" },
        font: { body: "helvetica" }
      };
      const derived = theme(directContract, replacementTokens);

      assertType<ThemeResult<ExpectedTheme>>(derived);
      assertType<ExpectedVars>(derived[1]);
      expectTypeOf(derived).toEqualTypeOf<ThemeResult<ExpectedTheme>>();
      expectThemeContractResult(derived);

      const derivedWithDebug = theme(
        directContract,
        replacementTokens,
        "theme-overload-derived-debug"
      );

      assertType<ThemeResult<ExpectedTheme>>(derivedWithDebug);
      assertType<ExpectedVars>(derivedWithDebug[1]);
      expectTypeOf(derivedWithDebug).toEqualTypeOf<
        ThemeResult<ExpectedTheme>
      >();
      expectThemeContractResult(derivedWithDebug);
      expect(derivedWithDebug[0]).toMatch(
        identifierName("theme-overload-derived-debug")
      );

      const singleTokenTheme = theme.with<SingleTokenTheme>();
      const wrappedSingle = singleTokenTheme({ color: "blue" });
      const singleTokenContract = expectThemeContractResult(wrappedSingle);

      assertType<ThemeResult<SingleTokenTheme>>(wrappedSingle);
      assertType<SingleTokenVars>(wrappedSingle[1]);
      expectTypeOf(wrappedSingle).toEqualTypeOf<
        ThemeResult<SingleTokenTheme>
      >();
      assertType<ThemeContract<SingleTokenTheme>>(singleTokenContract);

      const typedTheme = theme.with<ExpectedTheme>();
      const wrapped = typedTheme(tokens);

      assertType<ThemeResult<ExpectedTheme>>(wrapped);
      assertType<ExpectedVars>(wrapped[1]);
      expectTypeOf(wrapped).toEqualTypeOf<ThemeResult<ExpectedTheme>>();
      expectThemeContractResult(wrapped);

      type StrictTheme = {
        color: { brand: string; accent: string };
        font: { body: string };
      };
      const strictTheme = theme.with<StrictTheme>();
      const strictTokens: ThemeTokensInput<StrictTheme> = {
        color: { brand: "blue", accent: "cyan" },
        font: { body: "arial" }
      };
      const strictResult = strictTheme(strictTokens);
      const [, strictVars, strictContract] = strictResult;
      expectThemeContractResult(strictResult);
      const strictReplacementTokens: ThemeTokensInput<StrictTheme> = {
        color: { brand: "red", accent: "orange" },
        font: { body: "helvetica" }
      };
      const strictDerived = theme<StrictTheme>(
        strictContract,
        strictReplacementTokens
      );

      assertType<ThemeResult<StrictTheme>>(strictDerived);
      expectTypeOf(strictDerived).toEqualTypeOf<ThemeResult<StrictTheme>>();
      expectThemeContractResult(strictDerived);

      const incompleteContract = {
        vars: strictVars,
        values: {}
      };
      const assertStrictReplacementTypeErrors = () => {
        // @ts-expect-error: replacement mode requires ThemeContract, not resolved vars.
        theme<StrictTheme>(strictVars, strictReplacementTokens);
        // @ts-expect-error: replacement mode requires full ThemeContract metadata.
        theme<StrictTheme>(incompleteContract, strictReplacementTokens);
        // @ts-expect-error: font branch is required by the replacement contract.
        theme<StrictTheme>(strictContract, {
          color: { brand: "red", accent: "orange" }
        });
        // @ts-expect-error: color.accent is required by the replacement contract.
        theme<StrictTheme>(strictContract, {
          color: { brand: "red" },
          font: { body: "helvetica" }
        });
        // @ts-expect-error: top-level replacement keys outside the contract are not accepted.
        theme<StrictTheme>(strictContract, {
          color: { brand: "red", accent: "orange" },
          font: { body: "helvetica" },
          space: "4px"
        });
        // @ts-expect-error: nested replacement keys outside the contract are not accepted.
        theme<StrictTheme>(strictContract, {
          color: { brand: "red", accent: "orange", neutral: "gray" },
          font: { body: "helvetica" }
        });
        // @ts-expect-error: color.brand must be a string in the strict replacement contract.
        theme<StrictTheme>(strictContract, {
          color: { brand: 123, accent: "orange" },
          font: { body: "helvetica" }
        });
        // @ts-expect-error: replacement-mode debugId must be a string.
        theme<StrictTheme>(strictContract, strictReplacementTokens, 123);
      };

      assertType<() => void>(assertStrictReplacementTypeErrors);
    });

    it("creates a derived theme class from existing vars", async () => {
      type UserTheme = {
        colors: { brand: string };
        font: { body: string };
      };
      const baseTokens: ThemeTokensInput<UserTheme> = {
        colors: { brand: "blue" },
        font: { body: "arial" }
      };
      const baseResult = theme(baseTokens, "theme-user-example");
      const [baseClassName, vars, contract] = baseResult;
      expectThemeContractResult(baseResult);
      const transformSpy = vi.spyOn(
        await import("@mincho-js/transform-to-vanilla"),
        "transform"
      );

      try {
        const derivedResult = theme(
          contract,
          {
            colors: { brand: "red" },
            font: { body: "helvetica" }
          },
          "theme-user-example-derived"
        );
        const [derivedClassName, nextVars, nextContract] = derivedResult;
        const thirdResult = theme(
          nextContract,
          {
            colors: { brand: "green" },
            font: { body: "system-ui" }
          },
          "theme-user-example-third"
        );
        const [thirdClassName, thirdVars, thirdContract] = thirdResult;
        const colorsBrandVar = getVarName(vars.colors.brand);
        const fontBodyVar = getVarName(vars.font.body);

        expectThemeContractResult(derivedResult);
        expectThemeContractResult(thirdResult);
        expect(typeof derivedClassName).toBe("string");
        expect(derivedClassName).toMatch(
          identifierName("theme-user-example-derived")
        );
        expect(thirdClassName).toMatch(
          identifierName("theme-user-example-third")
        );
        expect(derivedClassName).not.toBe(baseClassName);
        expect(thirdClassName).not.toBe(derivedClassName);
        expect(nextContract).not.toBe(contract);
        expect(thirdContract).not.toBe(nextContract);
        expect(nextVars.colors.brand).toBe(vars.colors.brand);
        expect(nextVars.font.body).toBe(vars.font.body);
        expect(thirdVars.colors.brand).toBe(vars.colors.brand);
        expect(thirdVars.font.body).toBe(vars.font.body);
        expect(stripHash(colorsBrandVar)).toBe("--colors-brand");
        expect(stripHash(fontBodyVar)).toBe("--font-body");

        const derivedTransformInput = transformSpy.mock.calls
          .map(
            ([input]) =>
              input as { selectors?: Record<string, { vars?: AssignedVars }> }
          )
          .find((input) => input.selectors?.[derivedClassName] !== undefined);
        const emittedVars =
          derivedTransformInput?.selectors?.[derivedClassName]?.vars;

        expect(emittedVars).toBeDefined();
        expect(normalizeVars(emittedVars as AssignedVars)).toEqual({
          [stripHash(colorsBrandVar)]: "red",
          [stripHash(fontBodyVar)]: "helvetica"
        });
      } finally {
        transformSpy.mockRestore();
      }
    });

    it("throws deterministic replacement mode errors", () => {
      type RuntimeErrorTheme = {
        color: { brand: string; semantic: { primary: string } };
        font: { body: string };
        space: number[];
      };
      const runtimeErrorTokens: ThemeTokensInput<RuntimeErrorTheme> =
        compositeValue({
          color: {
            brand: "blue",
            semantic: {
              get primary(): string {
                return this.alias(this.color.brand);
              }
            }
          },
          font: { body: "arial" },
          space: [1, 2]
        });
      const runtimeErrorResult = theme(runtimeErrorTokens, "theme-errors-base");
      const [, runtimeErrorVars, contract] = runtimeErrorResult;
      expectThemeContractResult(runtimeErrorResult);
      expectThemeVarsContract(runtimeErrorVars, contract);
      const missingNestedBranch = {
        color: { brand: "red" },
        font: { body: "helvetica" },
        space: [3, 4]
      };
      const extraTopLevelKey = {
        color: { brand: "red", semantic: { primary: "crimson" } },
        font: { body: "helvetica" },
        space: [3, 4],
        elevation: "high"
      };
      const extraNestedKey = {
        color: {
          brand: "red",
          semantic: { primary: "crimson" },
          accent: "pink"
        },
        font: { body: "helvetica" },
        space: [3, 4]
      };
      const arrayLengthMismatch = {
        color: { brand: "red", semantic: { primary: "crimson" } },
        font: { body: "helvetica" },
        space: [3]
      };

      expect(() =>
        callThemeExtensionForRuntimeError<RuntimeErrorTheme>(
          contract,
          missingNestedBranch,
          "theme-errors-missing-nested"
        )
      ).toThrow(
        'Theme extension missing replacement token at "color.semantic".'
      );
      expect(() =>
        callThemeExtensionForRuntimeError<RuntimeErrorTheme>(
          contract,
          extraTopLevelKey,
          "theme-errors-extra-top"
        )
      ).toThrow(
        'Theme extension replacement token at "elevation" does not exist in base vars.'
      );
      expect(() =>
        callThemeExtensionForRuntimeError<RuntimeErrorTheme>(
          contract,
          extraNestedKey,
          "theme-errors-extra-nested"
        )
      ).toThrow(
        'Theme extension replacement token at "color.accent" does not exist in base vars.'
      );
      expect(() =>
        callThemeExtensionForRuntimeError<RuntimeErrorTheme>(
          contract,
          arrayLengthMismatch,
          "theme-errors-array-length"
        )
      ).toThrow('Theme extension array length mismatch at "space".');

      Object.defineProperty(runtimeErrorVars.color.semantic, "primary", {
        value: "not-a-var-reference",
        enumerable: true,
        configurable: true
      });
      expect(() =>
        callThemeExtensionForRuntimeError<RuntimeErrorTheme>(
          contract,
          {
            color: { brand: "red", semantic: { primary: "crimson" } },
            font: { body: "helvetica" },
            space: [3, 4]
          },
          "theme-errors-invalid-var-reference"
        )
      ).toThrow(
        'Theme extension expected var() reference at "color.semantic.primary".'
      );
    });

    it("extends replacement mode to token forms and @layer", async () => {
      const baseTokens = compositeValue({
        scalar: "base-scalar",
        color: {
          brand: "#0000ff",
          definition: {
            $type: "color",
            $value: "#00ff00"
          },
          semantic: {
            get primary(): string {
              return this.color.brand;
            },
            get fallback(): string {
              return this.fallbackVar(this.color.brand, "#123456");
            },
            get rawBrand(): string {
              return this.raw(this.color.brand);
            },
            get aliasBrand(): string {
              return this.alias(this.color.brand);
            }
          }
        },
        space: {
          scale: [2, 4, 8],
          unit: { value: 1, unit: "rem" } as TokenDimensionValue
        },
        shadow: {
          card: compositeValue({
            get resolved(): string {
              const offsetX = `${this.offsetX.value}${this.offsetX.unit}`;
              const offsetY = `${this.offsetY.value}${this.offsetY.unit}`;
              const blur = `${this.blur.value}${this.blur.unit}`;
              return `${this.color} ${offsetX} ${offsetY} ${blur}`;
            },
            color: "#00000080",
            offsetX: { value: 1, unit: "px" },
            offsetY: { value: 2, unit: "px" },
            blur: { value: 4, unit: "px" }
          })
        }
      });
      const baseResult = theme(baseTokens, "theme-token-forms-base");
      const [, vars, contract] = baseResult;
      expectThemeContractResult(baseResult);
      const varsSnapshot = normalizeResolvedTokens(vars);
      const replacementTokens = compositeValue({
        scalar: "replacement-scalar",
        color: {
          brand: "#ff0000",
          definition: {
            $type: "color",
            $value: "#00aa00"
          },
          semantic: {
            get primary(): string {
              return this.color.brand;
            },
            get fallback(): string {
              return this.fallbackVar(this.color.brand, "#654321");
            },
            get rawBrand(): string {
              return this.raw(this.color.brand);
            },
            get aliasBrand(): string {
              return this.alias(this.color.brand);
            }
          }
        },
        space: {
          scale: [3, 6, 9],
          unit: { value: 2, unit: "rem" } as TokenDimensionValue
        },
        shadow: {
          card: compositeValue({
            get resolved(): string {
              const offsetX = `${this.offsetX.value}${this.offsetX.unit}`;
              const offsetY = `${this.offsetY.value}${this.offsetY.unit}`;
              const blur = `${this.blur.value}${this.blur.unit}`;
              return `${this.color} ${offsetX} ${offsetY} ${blur}`;
            },
            color: "#11111180",
            offsetX: { value: 2, unit: "px" },
            offsetY: { value: 4, unit: "px" },
            blur: { value: 8, unit: "px" }
          })
        }
      });
      const layeredReplacementTokens = {
        "@layer": "theme-replacements",
        ...replacementTokens
      } as ThemeTokensInput<typeof baseTokens>;
      const replacementPrimaryGetter = Object.getOwnPropertyDescriptor(
        replacementTokens.color.semantic,
        "primary"
      )?.get;
      deepFreezeObject(vars);
      deepFreezeObject(layeredReplacementTokens);
      const transformSpy = vi.spyOn(
        await import("@mincho-js/transform-to-vanilla"),
        "transform"
      );

      try {
        const derivedResult = theme(
          contract,
          layeredReplacementTokens,
          "theme-token-forms-derived"
        );
        const [derivedClassName, nextVars, nextContract] = derivedResult;
        expectThemeContractResult(derivedResult);
        expect(nextContract).not.toBe(contract);
        expect(nextVars.scalar).toBe(vars.scalar);
        expect(nextVars.color.brand).toBe(vars.color.brand);
        expect(nextVars.space.scale[0]).toBe(vars.space.scale[0]);
        expect(nextVars.shadow.card.color).toBe(vars.shadow.card.color);
        const normalizedNextVars = normalizeResolvedTokens(nextVars);
        expect(normalizedNextVars.shadow.card.resolved).toBe(
          "var(--shadow-card)"
        );
        type ThemeTransformInput = {
          selectors?: Record<
            string,
            {
              vars?: AssignedVars;
              "@layer"?: Record<string, { vars?: AssignedVars }>;
            }
          >;
        };
        const derivedTransformInput = transformSpy.mock.calls
          .map(([input]) => input as ThemeTransformInput)
          .find((input) => input.selectors?.[derivedClassName] !== undefined);
        const emittedLayerVars =
          derivedTransformInput?.selectors?.[derivedClassName]?.["@layer"]?.[
            "theme-replacements"
          ]?.vars;

        expect(emittedLayerVars).toBeDefined();
        const normalizedEmittedVars = normalizeVars(
          emittedLayerVars as AssignedVars
        );

        expect(normalizedEmittedVars[stripHash(getVarName(vars.scalar))]).toBe(
          "replacement-scalar"
        );
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.color.brand))]
        ).toBe("#ff0000");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.color.definition))]
        ).toBe("#00aa00");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.space.scale[0]))]
        ).toBe(3);
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.space.scale[1]))]
        ).toBe(6);
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.space.scale[2]))]
        ).toBe(9);
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.space.unit))]
        ).toBe("2rem");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.shadow.card.color))]
        ).toBe("#11111180");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.shadow.card.offsetX))]
        ).toBe("2px");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.shadow.card.offsetY))]
        ).toBe("4px");
        expect(
          normalizedEmittedVars[stripHash(getVarName(vars.shadow.card.blur))]
        ).toBe("8px");
        expect(
          stripHash(normalizedEmittedVars["--color-semantic-primary"] as string)
        ).toBe("var(--color-brand)");
        expect(
          stripHash(
            normalizedEmittedVars["--color-semantic-fallback"] as string
          )
        ).toBe("var(--color-brand, #654321)");
        expect(normalizedEmittedVars["--color-semantic-raw-brand"]).toBe(
          "#ff0000"
        );
        expect(
          normalizedEmittedVars["--color-semantic-alias-brand"]
        ).toBeUndefined();
        expect(normalizedEmittedVars["--shadow-card"]).toBe(
          "#11111180 2px 4px 8px"
        );
        expect(normalizeResolvedTokens(vars)).toEqual(varsSnapshot);
        expect(
          Object.getOwnPropertyDescriptor(
            replacementTokens.color.semantic,
            "primary"
          )?.get
        ).toBe(replacementPrimaryGetter);
      } finally {
        transformSpy.mockRestore();
      }
    });

    it("stores assignment metadata on the structural ThemeContract", () => {
      const result = theme(
        compositeValue({
          color: {
            brand: "#0000ff",
            semantic: {
              get rawBrand(): string {
                return this.raw(this.color.brand);
              }
            }
          }
        })
      );
      const [, vars, contract] = result;
      expectThemeContractResult(result);
      expectThemeVarsContract(vars, contract);
      const rawBrandVar = contract.cssVarByPath["color-semantic-raw-brand"];

      expect(Object.keys(contract)).toEqual(["vars", "values", "cssVarByPath"]);
      expect(Object.getOwnPropertySymbols(contract)).toEqual([]);
      expect(rawBrandVar).toMatch(/^--color-semantic-raw-brand__/);
      expect(contract.values[rawBrandVar]).toBe("#0000ff");
    });

    it("keeps direct theme() calls working", () => {
      const result = theme({ color: "red" }, "theme2");
      const [className, themeVars, contract] = result;

      expectThemeContractResult(result);
      assertType<ThemeContract<{ color: string }>>(contract);
      expect(className).toMatch(identifierName("theme2"));
      validateHashFormatForResolved(themeVars);
    });

    it("generates unique className with debugId", () => {
      const result1 = theme({ color: "red" }, "theme1");
      const result2 = theme({ color: "blue" }, "theme2");
      const [className1, themeVars1, contract1] = result1;
      const [className2, themeVars2, contract2] = result2;

      expectThemeContractResult(result1);
      expectThemeContractResult(result2);
      expectThemeVarsContract(themeVars1, contract1);
      expectThemeVarsContract(themeVars2, contract2);
      expect(className1).toMatch(identifierName("theme1"));
      expect(className2).toMatch(identifierName("theme2"));
      expect(className1).not.toBe(className2);

      validateHashFormatForResolved(themeVars1);
      validateHashFormatForResolved(themeVars2);
    });

    it("generates className without debugId", () => {
      const result = theme({ color: "red" });
      const [className, themeVars, contract] = result;

      expectThemeContractResult(result);
      expectThemeVarsContract(themeVars, contract);
      expect(className).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    });

    it("handles @layer in theme tokens", () => {
      const result = theme(
        {
          "@layer": "tokens",
          color: {
            primary: "#007bff",
            secondary: "#6c757d"
          }
        },
        debugId
      );
      const [className, themeVars, contract] = result;

      expectThemeContractResult(result);
      expectThemeVarsContract(themeVars, contract);
      expect(className).toMatch(identifierName(`${debugId}`));

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          primary: "var(--color-primary)",
          secondary: "var(--color-secondary)"
        }
      });
    });

    it("handles primitive token values", () => {
      const [className, themeVars, contract] = theme({
        color: "red",
        size: 16,
        enabled: true,
        nothing: undefined
      });

      expect(className).toBeDefined();
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: "var(--color)",
        size: "var(--size)",
        enabled: "var(--enabled)",
        nothing: "var(--nothing)"
      });
    });

    it("handles array tokens", () => {
      const [className, themeVars, contract] = theme({
        space: [2, 4, 8, 16, 32],
        colors: ["#ff0000", "#00ff00", "#0000ff"]
      });

      expect(className).toBeDefined();
      expectThemeVarsContract(themeVars, contract);
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
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
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
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: "var(--color)",
        font: "var(--font)",
        duration: "var(--duration)",
        easing: "var(--easing)"
      });
    });

    it("handles semantic tokens with fallbackVar", () => {
      const [className, themeVars, contract] = theme(
        compositeValue({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
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
      const [className, themeVars, contract] = theme(
        compositeValue({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.semantic.primary).toBe("var(--color-base-blue)");
      expect(normalized.color.semantic.danger).toBe("var(--color-base-red)");
    });

    it("handles semantic tokens with raw", () => {
      const [className, themeVars, contract] = theme(
        compositeValue({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
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
      const shadowValue = compositeValue({
        get resolved() {
          return `${this.color} ${this.offsetX.value}${this.offsetX.unit} ${this.offsetY.value}${this.offsetY.unit}`;
        },
        color: "#00000080",
        offsetX: { value: 0.5, unit: "rem" },
        offsetY: { value: 0.5, unit: "rem" }
      });

      const [className, themeVars, contract] = theme({
        shadow: shadowValue
      });

      expect(className).toBeDefined();
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.shadow.resolved).toBe("var(--shadow)");
      expect(normalized.shadow.color).toBe("var(--shadow-color)");
      expect(normalized.shadow.offsetX).toBe("var(--shadow-offset-x)");
      expect(normalized.shadow.offsetY).toBe("var(--shadow-offset-y)");
    });

    it("handles TokenUnitValue", () => {
      const [className, themeVars, contract] = theme({
        spacing: { value: 1.5, unit: "rem" },
        borderWidth: { value: 2, unit: "px" }
      });

      expect(className).toBeDefined();
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        spacing: "var(--spacing)",
        borderWidth: "var(--border-width)"
      });
    });

    it("handles camelCase to kebab-case conversion", () => {
      const [className, themeVars, contract] = theme({
        backgroundColor: "white",
        fontSize: "16px",
        lineHeight: 1.5
      });

      expect(className).toBeDefined();
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        backgroundColor: "var(--background-color)",
        fontSize: "var(--font-size)",
        lineHeight: "var(--line-height)"
      });
    });

    it("handles deeply nested structures", () => {
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.design.system.color.brand.primary).toBe(
        "var(--design-system-color-brand-primary)"
      );
      expect(normalized.design.system.color.brand.secondary).toBe(
        "var(--design-system-color-brand-secondary)"
      );
    });

    it("handles mixed token types in single theme", () => {
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
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
      const [className, themeVars, contract] = theme(
        compositeValue({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.semantic.primary).toBe("var(--color-base-blue)");
      expect(normalized.color.semantic.danger).toBe("var(--color-base-red)");
      expect(normalized.color.semantic.success).toBe("var(--color-base-green)");
      expect(normalized.color.semantic.info).toBe(
        "var(--color-base-blue, #17a2b8)"
      );
    });

    it("handles fontWeight token types", () => {
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.weight.normal).toBe("var(--weight-normal)");
      expect(normalized.weight.bold).toBe("var(--weight-bold)");
      expect(normalized.weight.semiBold).toBe("var(--weight-semi-bold)");
      expect(normalized.weight.numeric).toBe("var(--weight-numeric)");
    });

    it("handles number token types", () => {
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        lineHeight: "var(--line-height)",
        zIndex: "var(--z-index)"
      });
    });

    it("handles color tokens with complex values", () => {
      const [className, themeVars, contract] = theme({
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
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
      const normalized = normalizeResolvedTokens(themeVars);
      expect(normalized.color.simple).toBe("var(--color-simple)");
      expect(normalized.color.complex).toBe("var(--color-complex)");
    });

    it("handles complex color tokens and semantic references", () => {
      const [className, themeVars, contract] = theme(
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
          },
          shadow: {
            light: {
              get resolved(): string {
                return `${this.shadow.light.color} ${this.shadow.light.offsetX} ${this.shadow.light.offsetY} ${this.shadow.light.blur}`;
              },
              color: "#00000080",
              offsetX: { value: 0.5, unit: "rem" },
              offsetY: { value: 0.5, unit: "rem" },
              blur: { value: 1.5, unit: "rem" }
            }
          }
        },
        debugId
      );

      expect(className).toMatch(identifierName(`${debugId}`));
      expectThemeVarsContract(themeVars, contract);

      validateHashFormatForResolved(themeVars);
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
        },
        shadow: {
          light: {
            resolved: "var(--shadow-light)",
            color: "var(--shadow-light-color)",
            offsetX: "var(--shadow-light-offset-x)",
            offsetY: "var(--shadow-light-offset-y)",
            blur: "var(--shadow-light-blur)"
          }
        }
      });
    });

    it("integrates with globalTheme correctly", () => {
      const result = theme(
        {
          color: {
            primary: "#007bff"
          }
        },
        "testTheme"
      );
      const [className, themeVars, contract] = result;
      const globalThemeVars = globalTheme(".test-global-theme", {
        color: {
          primary: "#007bff"
        }
      });

      expectThemeContractResult(result);
      expectThemeVarsContract(themeVars, contract);
      expect(className).toMatch(identifierName("testTheme"));

      validateHashFormatForResolved(themeVars);
      expect(normalizeResolvedTokens(themeVars)).toEqual({
        color: {
          primary: "var(--color-primary)"
        }
      });
      expect(Array.isArray(globalThemeVars)).toBe(false);
      expect(normalizeResolvedTokens(globalThemeVars)).toEqual({
        color: {
          primary: "var(--color-primary)"
        }
      });
    });

    it("handles empty theme object", () => {
      const result = theme({});
      const [className, themeVars, contract] = result;

      expectThemeContractResult(result);
      expectThemeVarsContract(themeVars, contract);
      expect(className).toBeDefined();
      expect(themeVars).toEqual({});
    });
  });
}

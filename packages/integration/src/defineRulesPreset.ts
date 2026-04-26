import * as fs from "node:fs";
import { parseSync, transformFromAstSync, types as t } from "@babel/core";

const DEFINE_RULES_PRESET_PARSER_PLUGINS = [
  "jsx",
  "typescript",
  "importMeta",
  "dynamicImport",
  "topLevelAwait",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods"
] as const;
const DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX =
  "__MINCHO_DEFINE_RULES_SENTINEL__:";
const DEFINE_RULES_PRESET_CAPTURE_STACK = Symbol.for(
  "@mincho-js/css/defineRulesPresetCapture"
);

type DefineRulesPresetMap = Record<string, string>;
type Awaitable<Value> = Value | PromiseLike<Value>;
type DefineRulesPresetCaptureGlobal = typeof globalThis & {
  [DEFINE_RULES_PRESET_CAPTURE_STACK]?: DefineRulesPresetCaptureSession[];
};

export const DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR =
  "Failed to inject defineRules preset snapshots: captured/callsite mismatch";

let defineRulesPresetCaptureQueue: Promise<void> = Promise.resolve();

export interface DefineRulesPresetCaptureInstance {
  sentinelId: string;
  filePath: string;
  instanceIndex: number;
  getPresetSnapshot(): DefineRulesPresetMap;
}

export interface DefineRulesPresetCaptureSession {
  filePath: string;
  instances: DefineRulesPresetCaptureInstance[];
}

export interface DefineRulesPresetBuildArtifact {
  filePath: string;
  source: string;
}

export function runDefineRulesPresetCaptureStep<Result>(
  step: () => Awaitable<Result>
): Promise<Result> {
  const queuedStep = defineRulesPresetCaptureQueue
    .catch(() => undefined)
    .then(step);

  defineRulesPresetCaptureQueue = queuedStep.then(
    () => undefined,
    () => undefined
  );

  return queuedStep;
}

interface ParsedDefineRulesPresetArtifact {
  artifact: DefineRulesPresetBuildArtifact;
  ast: t.File;
  callsites: DefineRulesPresetBuildCallsite[];
  hasUnsupportedSentinelCallsite: boolean;
}

interface DefineRulesPresetBuildCallsite {
  callExpression: t.CallExpression;
  configExpression: t.ObjectExpression;
  filePath: string;
  sentinelId: string;
  instanceIndex: number;
}

function getCaptureStack(): DefineRulesPresetCaptureSession[] {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const captureStack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];

  if (captureStack != null) {
    return captureStack;
  }

  const nextCaptureStack: DefineRulesPresetCaptureSession[] = [];
  captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK] = nextCaptureStack;
  return nextCaptureStack;
}

function clearCaptureStackIfEmpty(): void {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const captureStack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];

  if (captureStack != null && captureStack.length === 0) {
    delete captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];
  }
}

function beginDefineRulesPresetCaptureSession(
  filePath: string
): DefineRulesPresetCaptureSession {
  const captureSession: DefineRulesPresetCaptureSession = {
    filePath,
    instances: []
  };

  getCaptureStack().push(captureSession);
  return captureSession;
}

function endDefineRulesPresetCaptureSession():
  | DefineRulesPresetCaptureSession
  | undefined {
  const captureGlobal = globalThis as DefineRulesPresetCaptureGlobal;
  const captureStack = captureGlobal[DEFINE_RULES_PRESET_CAPTURE_STACK];
  const captureSession = captureStack?.pop();

  clearCaptureStackIfEmpty();
  return captureSession;
}

function getDefineRulesPresetCaptureSentinelId(
  value: unknown
): string | undefined {
  if (
    typeof value !== "string" ||
    value.startsWith(DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX) === false
  ) {
    return undefined;
  }

  const sentinelId = value.slice(
    DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX.length
  );
  return sentinelId.length > 0 ? sentinelId : undefined;
}

function getDefineRulesPresetCallsiteKey(
  filePath: string,
  sentinelId: string
): string {
  return `${filePath}\u0000${sentinelId}`;
}

export async function captureDefineRulesPresetSession<Result>(
  filePath: string,
  evaluate: () => Awaitable<Result>
): Promise<{
  result: Result;
  captureSession: DefineRulesPresetCaptureSession | undefined;
}> {
  beginDefineRulesPresetCaptureSession(filePath);

  try {
    const result = await evaluate();
    return {
      result,
      captureSession: endDefineRulesPresetCaptureSession()
    };
  } catch (error) {
    endDefineRulesPresetCaptureSession();
    throw error;
  }
}

export function backfillDefineRulesPresetArtifacts(
  artifacts: readonly DefineRulesPresetBuildArtifact[],
  captureSession: DefineRulesPresetCaptureSession | undefined
): DefineRulesPresetBuildArtifact[] {
  const parsedArtifacts = artifacts.map(parseDefineRulesPresetArtifact);

  if (
    parsedArtifacts.some((artifact) => artifact.hasUnsupportedSentinelCallsite)
  ) {
    throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
  }

  const capturedInstances = captureSession?.instances ?? [];
  const callsites = parsedArtifacts.flatMap(({ artifact, callsites }) => {
    if (callsites.some((callsite) => callsite.filePath !== artifact.filePath)) {
      throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    }

    return callsites;
  });

  if (
    captureSession != null &&
    capturedInstances.some(
      (instance) => instance.filePath !== captureSession.filePath
    )
  ) {
    throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
  }

  if (capturedInstances.length === 0 && callsites.length === 0) {
    return artifacts.map((artifact) => ({
      ...artifact
    }));
  }

  if (capturedInstances.length !== callsites.length) {
    throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
  }

  const capturedByCallsiteKey = new Map<
    string,
    DefineRulesPresetCaptureInstance
  >();
  for (const instance of capturedInstances) {
    const callsiteKey = getDefineRulesPresetCallsiteKey(
      instance.filePath,
      instance.sentinelId
    );

    if (capturedByCallsiteKey.has(callsiteKey)) {
      throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    }

    capturedByCallsiteKey.set(callsiteKey, instance);
  }

  const callsiteByCallsiteKey = new Map<
    string,
    DefineRulesPresetBuildCallsite
  >();
  for (const callsite of callsites) {
    const callsiteKey = getDefineRulesPresetCallsiteKey(
      callsite.filePath,
      callsite.sentinelId
    );

    if (callsiteByCallsiteKey.has(callsiteKey)) {
      throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    }

    callsiteByCallsiteKey.set(callsiteKey, callsite);
  }

  for (const instance of capturedInstances) {
    const callsite = callsiteByCallsiteKey.get(
      getDefineRulesPresetCallsiteKey(instance.filePath, instance.sentinelId)
    );

    if (
      callsite == null ||
      callsite.filePath !== instance.filePath ||
      callsite.instanceIndex !== instance.instanceIndex
    ) {
      throw new Error(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    }

    upsertPresetProperty(
      callsite.configExpression,
      instance.getPresetSnapshot()
    );
    callsite.callExpression.arguments = [callsite.configExpression];
  }

  return parsedArtifacts.map(({ artifact, ast, callsites }) => {
    if (callsites.length === 0) {
      return {
        ...artifact
      };
    }

    return {
      ...artifact,
      source: printDefineRulesPresetArtifact(artifact, ast)
    };
  });
}

function parseDefineRulesPresetArtifact(
  artifact: DefineRulesPresetBuildArtifact
): ParsedDefineRulesPresetArtifact {
  const ast = parseDefineRulesPresetAst(artifact);
  const callsites: DefineRulesPresetBuildCallsite[] = [];
  let nextInstanceIndex = 0;
  let hasUnsupportedSentinelCallsite = false;

  walkAst(ast, (node, ancestors) => {
    if (!t.isCallExpression(node)) {
      return;
    }

    if (!isDefineRulesPresetCallee(node.callee)) {
      return;
    }

    const sentinelId = getSentinelIdFromArgument(node.arguments[1]);
    if (sentinelId == null) {
      return;
    }

    if (node.arguments.length !== 2) {
      hasUnsupportedSentinelCallsite = true;
      return;
    }

    const [configExpression] = node.arguments;
    if (!t.isObjectExpression(configExpression)) {
      hasUnsupportedSentinelCallsite = true;
      return;
    }

    if (!isSupportedDefineRulesPresetCallsite(node, ancestors)) {
      hasUnsupportedSentinelCallsite = true;
      return;
    }

    callsites.push({
      callExpression: node,
      configExpression,
      filePath: artifact.filePath,
      sentinelId,
      instanceIndex: nextInstanceIndex
    });
    nextInstanceIndex += 1;
  });

  return {
    artifact,
    ast,
    callsites,
    hasUnsupportedSentinelCallsite
  };
}

function isSupportedDefineRulesPresetCallsite(
  node: t.CallExpression,
  ancestors: readonly t.Node[]
): boolean {
  const parentNode = ancestors[ancestors.length - 1];
  if (!t.isVariableDeclarator(parentNode) || parentNode.init !== node) {
    return false;
  }

  const declarationNode = ancestors[ancestors.length - 2];
  if (!t.isVariableDeclaration(declarationNode)) {
    return false;
  }

  const scopeNode = ancestors[ancestors.length - 3];
  if (t.isProgram(scopeNode)) {
    return true;
  }

  const programNode = ancestors[ancestors.length - 4];
  return (
    t.isExportNamedDeclaration(scopeNode) &&
    scopeNode.declaration === declarationNode &&
    t.isProgram(programNode)
  );
}

function isDefineRulesPresetCallee(
  callee: t.CallExpression["callee"]
): boolean {
  return t.isIdentifier(callee, { name: "defineRules" });
}

function parseDefineRulesPresetAst(
  artifact: DefineRulesPresetBuildArtifact
): t.File {
  const ast = parseSync(artifact.source, {
    filename: artifact.filePath,
    sourceType: "unambiguous",
    configFile: false,
    parserOpts: {
      plugins: [...DEFINE_RULES_PRESET_PARSER_PLUGINS]
    }
  });

  if (ast == null) {
    throw new Error(`Failed to parse ${artifact.filePath}`);
  }

  return ast;
}

function printDefineRulesPresetArtifact(
  artifact: DefineRulesPresetBuildArtifact,
  ast: t.File
): string {
  const result = transformFromAstSync(ast, artifact.source, {
    filename: artifact.filePath,
    sourceType: "unambiguous",
    ast: false,
    code: true,
    babelrc: false,
    configFile: false,
    compact: false,
    comments: true,
    sourceMaps: false
  });

  if (result?.code == null) {
    throw new Error(`Failed to print ${artifact.filePath}`);
  }

  return result.code;
}

function walkAst(
  node: unknown,
  visit: (node: t.Node, ancestors: readonly t.Node[]) => void,
  ancestors: readonly t.Node[] = []
): void {
  if (Array.isArray(node)) {
    for (const childNode of node) {
      walkAst(childNode, visit, ancestors);
    }

    return;
  }

  if (!isBabelNode(node)) {
    return;
  }

  visit(node, ancestors);

  const nextAncestors = [...ancestors, node];
  const visitorKeys = t.VISITOR_KEYS[node.type] ?? [];
  for (const visitorKey of visitorKeys) {
    walkAst(
      (node as unknown as Record<string, unknown>)[visitorKey],
      visit,
      nextAncestors
    );
  }
}

function isBabelNode(node: unknown): node is t.Node {
  return (
    node != null &&
    typeof node === "object" &&
    "type" in node &&
    typeof (node as { type?: unknown }).type === "string"
  );
}

function getSentinelIdFromArgument(
  argument: t.CallExpression["arguments"][number] | undefined
): string | undefined {
  if (argument == null || !t.isExpression(argument)) {
    return undefined;
  }

  const value = getStringLiteralLikeValue(argument);
  if (value == null) {
    return undefined;
  }

  return getDefineRulesPresetCaptureSentinelId(value);
}

function getStringLiteralLikeValue(
  expression: t.Expression
): string | undefined {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (
    t.isTemplateLiteral(expression) &&
    expression.expressions.length === 0 &&
    expression.quasis.length === 1
  ) {
    return (
      expression.quasis[0]?.value.cooked ?? expression.quasis[0]?.value.raw
    );
  }

  return undefined;
}

function upsertPresetProperty(
  configExpression: t.ObjectExpression,
  presetMap: DefineRulesPresetMap
): void {
  const nextPresetProperty = t.objectProperty(
    t.identifier("presets"),
    createPresetObjectExpression(presetMap)
  );

  configExpression.properties = configExpression.properties.filter(
    (property) =>
      !t.isObjectProperty(property) || !isDirectPresetObjectProperty(property)
  );
  configExpression.properties.push(nextPresetProperty);
}

function createPresetObjectExpression(
  presetMap: DefineRulesPresetMap
): t.ObjectExpression {
  return t.objectExpression(
    Object.entries(presetMap).map(([cacheKey, className]) =>
      t.objectProperty(t.stringLiteral(cacheKey), t.stringLiteral(className))
    )
  );
}

function isDirectPresetObjectProperty(property: t.ObjectProperty): boolean {
  return getObjectPropertyName(property) === "presets";
}

function getObjectPropertyName(property: t.ObjectProperty): string | undefined {
  const propertyKey = property.key;

  if (t.isIdentifier(propertyKey)) {
    return property.computed ? undefined : propertyKey.name;
  }

  if (t.isStringLiteral(propertyKey)) {
    return propertyKey.value;
  }

  if (
    t.isTemplateLiteral(propertyKey) &&
    propertyKey.expressions.length === 0 &&
    propertyKey.quasis.length === 1
  ) {
    return (
      propertyKey.quasis[0]?.value.cooked ?? propertyKey.quasis[0]?.value.raw
    );
  }

  return undefined;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, afterEach, beforeAll, vi } = import.meta.vitest;

  type TestDefineRulesResult = {
    css: {
      (args: unknown): string;
      raw(args: unknown): unknown;
    };
    preset: DefineRulesPresetMap;
  };

  let defineRules: (config: Record<string, unknown>) => TestDefineRulesResult;
  let setFileScope: (filePath: string) => void;

  beforeAll(async () => {
    const [cssModule, fileScopeModule, manifest] = await Promise.all([
      import("@mincho-js/css"),
      import("@vanilla-extract/css/fileScope"),
      loadDefineRulesPresetSerializationManifest()
    ]);

    defineRules = cssModule.defineRules as unknown as (
      config: Record<string, unknown>
    ) => TestDefineRulesResult;
    setFileScope = fileScopeModule.setFileScope;
    setFileScope("test");
    initializeDefineRulesPresetSerializationFixtures(manifest);
  });

  afterEach(() => {
    for (;;) {
      const leakedSession = endDefineRulesPresetCaptureSession();
      if (leakedSession == null) {
        break;
      }

      // Keep draining any leaked sessions so each test starts clean.
    }
  });

  function defineRulesWithCapture(
    config: Record<string, unknown>,
    sentinelId: string
  ): TestDefineRulesResult {
    return Reflect.apply(
      defineRules as unknown as (...args: unknown[]) => TestDefineRulesResult,
      undefined,
      [config, `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${sentinelId}`]
    );
  }

  function createDeferred<Value>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });

    return {
      promise,
      resolve,
      reject
    };
  }

  function extractPresetMapsFromArtifactSource(
    source: string
  ): DefineRulesPresetMap[] {
    const ast = parseDefineRulesPresetAst({
      filePath: "/virtual/output.js",
      source
    });
    const presetMaps: DefineRulesPresetMap[] = [];

    walkAst(ast, (node) => {
      if (!t.isCallExpression(node)) {
        return;
      }

      if (node.arguments.length !== 1) {
        return;
      }

      const [configExpression] = node.arguments;
      if (!t.isObjectExpression(configExpression)) {
        return;
      }

      const presetProperty = configExpression.properties.find(
        (property): property is t.ObjectProperty =>
          t.isObjectProperty(property) &&
          property.computed === false &&
          getObjectPropertyName(property) === "presets"
      );
      if (
        presetProperty == null ||
        !t.isObjectExpression(presetProperty.value)
      ) {
        return;
      }

      presetMaps.push(objectExpressionToPresetMap(presetProperty.value));
    });

    return presetMaps;
  }

  function extractPresetMapFromArtifactSource(
    source: string
  ): DefineRulesPresetMap {
    const [presetMap] = extractPresetMapsFromArtifactSource(source);

    if (presetMap == null) {
      throw new Error(
        "Failed to extract a backfilled preset map from rewritten output"
      );
    }

    return presetMap;
  }

  function extractDefineRulesArgumentLengths(source: string): number[] {
    const ast = parseDefineRulesPresetAst({
      filePath: "/virtual/output.js",
      source
    });
    const argumentLengths: number[] = [];

    walkAst(ast, (node) => {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "defineRules" })
      ) {
        argumentLengths.push(node.arguments.length);
      }
    });

    return argumentLengths;
  }

  function extractDefineRulesConfigExpressionsFromArtifactSource(
    source: string
  ): t.ObjectExpression[] {
    const ast = parseDefineRulesPresetAst({
      filePath: "/virtual/output.js",
      source
    });
    const configExpressions: t.ObjectExpression[] = [];

    walkAst(ast, (node) => {
      if (
        !t.isCallExpression(node) ||
        !t.isIdentifier(node.callee, { name: "defineRules" })
      ) {
        return;
      }

      const [configExpression] = node.arguments;
      if (t.isObjectExpression(configExpression)) {
        configExpressions.push(configExpression);
      }
    });

    return configExpressions;
  }

  function extractGeneratedPresetMapFromConfigExpression(
    configExpression: t.ObjectExpression
  ): DefineRulesPresetMap {
    const directPresetProperties = configExpression.properties.filter(
      (property): property is t.ObjectProperty =>
        t.isObjectProperty(property) && isDirectPresetObjectProperty(property)
    );

    expect(directPresetProperties).toHaveLength(1);
    const [presetProperty] = directPresetProperties;
    if (presetProperty == null) {
      throw new Error("Expected one generated presets property");
    }

    expect(
      configExpression.properties[configExpression.properties.length - 1]
    ).toBe(presetProperty);
    if (!t.isObjectExpression(presetProperty.value)) {
      throw new Error("Expected generated presets property to be an object");
    }

    return objectExpressionToPresetMap(presetProperty.value);
  }

  function hasComputedPropertyWithIdentifierKey(
    configExpression: t.ObjectExpression,
    propertyName: string
  ): boolean {
    return configExpression.properties.some(
      (property) =>
        t.isObjectProperty(property) &&
        property.computed &&
        t.isIdentifier(property.key, { name: propertyName })
    );
  }

  function expectRuntimeReuseWithPresetOverrides(
    injectedPresetMap: DefineRulesPresetMap,
    expectedClassName: string
  ): void {
    const stalePresetMap = {
      stale: "stale_class"
    };
    const spreadWithPreset = {
      presets: stalePresetMap
    };
    const dynamicPresetKey: string = "presets";
    const consumer = defineRules({
      ...spreadWithPreset,
      [dynamicPresetKey]: stalePresetMap,
      properties: {
        color: true,
        display: true
      },
      presets: injectedPresetMap
    });

    expect(
      consumer.css({
        color: "rebeccapurple",
        display: "flex"
      })
    ).toBe(expectedClassName);
    expect(Object.keys(consumer.preset)).toHaveLength(
      Object.keys(injectedPresetMap).length
    );
    expect(consumer.preset).not.toHaveProperty("stale");
  }

  function extractExportedVariableInitFromArtifactSource(
    source: string,
    exportName: string
  ): t.Expression {
    const ast = parseDefineRulesPresetAst({
      filePath: "/virtual/output.js",
      source
    });
    let exportedInit: t.Expression | undefined;

    walkAst(ast, (node, ancestors) => {
      if (
        exportedInit != null ||
        !t.isVariableDeclarator(node) ||
        !t.isIdentifier(node.id, { name: exportName })
      ) {
        return;
      }

      const declarationNode = ancestors[ancestors.length - 1];
      const exportNode = ancestors[ancestors.length - 2];
      if (
        !t.isVariableDeclaration(declarationNode) ||
        !t.isExportNamedDeclaration(exportNode)
      ) {
        return;
      }

      if (!t.isExpression(node.init)) {
        throw new Error(`Expected export ${exportName} to have an expression`);
      }

      exportedInit = node.init;
    });

    if (exportedInit == null) {
      throw new Error(`Failed to locate exported variable ${exportName}`);
    }

    return exportedInit;
  }

  function extractExportedStringValueFromArtifactSource(
    source: string,
    exportName: string
  ): string {
    const exportedInit = extractExportedVariableInitFromArtifactSource(
      source,
      exportName
    );

    if (!t.isStringLiteral(exportedInit)) {
      throw new Error(`Expected export ${exportName} to be a string literal`);
    }

    return exportedInit.value;
  }

  function hasCssCallWithStringProperty(
    source: string,
    propertyName: string,
    propertyValue: string
  ): boolean {
    const ast = parseDefineRulesPresetAst({
      filePath: "/virtual/output.js",
      source
    });
    let foundCall = false;

    walkAst(ast, (node) => {
      if (
        foundCall ||
        !t.isCallExpression(node) ||
        !t.isIdentifier(node.callee, { name: "css" })
      ) {
        return;
      }

      const [configExpression] = node.arguments;
      if (!t.isObjectExpression(configExpression)) {
        return;
      }

      const matchedProperty = configExpression.properties.find(
        (property): property is t.ObjectProperty =>
          t.isObjectProperty(property) &&
          property.computed === false &&
          getObjectPropertyName(property) === propertyName &&
          t.isStringLiteral(property.value) &&
          property.value.value === propertyValue
      );
      foundCall = matchedProperty != null;
    });

    return foundCall;
  }

  function objectExpressionToPresetMap(
    objectExpression: t.ObjectExpression
  ): DefineRulesPresetMap {
    const presetMap: DefineRulesPresetMap = {};

    for (const property of objectExpression.properties) {
      if (!t.isObjectProperty(property) || property.computed) {
        throw new Error("Backfilled preset map must be a plain object literal");
      }

      const propertyName = getObjectPropertyName(property);
      if (propertyName == null || !t.isStringLiteral(property.value)) {
        throw new Error(
          "Backfilled preset map must contain raw string entries only"
        );
      }

      presetMap[propertyName] = property.value.value;
    }

    return presetMap;
  }

  type DefineRulesPresetSerializationCase = {
    caseId: string;
    expectedSourceSnippets: readonly string[];
    relativePath: string;
    requireObjectLiteralConfig?: boolean;
  };

  type DefineRulesPresetSerializationFixtureCase =
    DefineRulesPresetSerializationCase & {
      fixturePath: string;
    };

  type DefineRulesPresetSerializationPaths = {
    consumer: string;
    consumerOrder: string;
    multipleInstances: string;
    producerTransitive: string;
    providerPreset: string;
    providerRoot: string;
  };

  type DefineRulesPresetSerializationManifest = {
    DEFINE_RULES_PRESET_SERIALIZATION_PATHS: DefineRulesPresetSerializationPaths;
    DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES: readonly DefineRulesPresetSerializationCase[];
    createDefineRulesPresetSerializationFixturePath: (
      relativePath: string
    ) => string;
  };

  let consumerFixturePath: string;
  let createDefineRulesPresetSerializationFixturePath!: (
    relativePath: string
  ) => string;
  let consumerOrderFixturePath: string;
  let multipleInstancesFixturePath: string;
  let providerFixturePath: string;
  let providerRootFixturePath: string;
  let supportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];
  let transitiveFixturePath: string;
  let unsupportedFixtureMatrixCases: DefineRulesPresetSerializationFixtureCase[] =
    [];

  function getDefineRulesPresetSerializationManifestUrl(): string {
    return new URL(
      "./__fixtures__/defineRules-preset-serialization/manifest.ts",
      import.meta.url
    ).href;
  }

  async function loadDefineRulesPresetSerializationManifest(): Promise<DefineRulesPresetSerializationManifest> {
    return (await import(
      getDefineRulesPresetSerializationManifestUrl()
    )) as DefineRulesPresetSerializationManifest;
  }

  function createFixtureMatrixCases(
    fixtureCases: readonly DefineRulesPresetSerializationCase[],
    createFixturePath: (relativePath: string) => string
  ): DefineRulesPresetSerializationFixtureCase[] {
    return fixtureCases.map((fixtureCase) => ({
      ...fixtureCase,
      fixturePath: createFixturePath(fixtureCase.relativePath)
    }));
  }

  function initializeDefineRulesPresetSerializationFixtures(
    manifest: DefineRulesPresetSerializationManifest
  ): void {
    const {
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS,
      DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES,
      DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES,
      createDefineRulesPresetSerializationFixturePath: createFixturePath
    } = manifest;

    createDefineRulesPresetSerializationFixturePath = createFixturePath;
    providerRootFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerRoot
    );
    providerFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.providerPreset
    );
    consumerFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.consumer
    );
    transitiveFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.producerTransitive
    );
    consumerOrderFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.consumerOrder
    );
    multipleInstancesFixturePath = createFixturePath(
      DEFINE_RULES_PRESET_SERIALIZATION_PATHS.multipleInstances
    );
    supportedFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_SUPPORTED_MATRIX_CASES,
      createFixturePath
    );
    unsupportedFixtureMatrixCases = createFixtureMatrixCases(
      DEFINE_RULES_PRESET_SERIALIZATION_UNSUPPORTED_MATRIX_CASES,
      createFixturePath
    );
  }

  function readFixtureSource(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  function normalizeFixtureSourceWhitespace(source: string): string {
    return source.replace(/\s+/g, " ").trim();
  }

  function expectSourceToContainSnippet(source: string, snippet: string): void {
    expect(normalizeFixtureSourceWhitespace(source)).toContain(
      normalizeFixtureSourceWhitespace(snippet)
    );
  }

  function injectDefineRulesPresetSentinels(
    source: string,
    sentinelIds: readonly string[],
    options: {
      requireObjectLiteralConfig?: boolean;
    } = {}
  ): string {
    const { requireObjectLiteralConfig = true } = options;
    const artifact = {
      filePath: "/virtual/fixture.ts",
      source
    } satisfies DefineRulesPresetBuildArtifact;
    const ast = parseDefineRulesPresetAst(artifact);
    let nextSentinelIndex = 0;

    walkAst(ast, (node) => {
      if (
        !t.isCallExpression(node) ||
        nextSentinelIndex >= sentinelIds.length
      ) {
        return;
      }

      if (!t.isIdentifier(node.callee, { name: "defineRules" })) {
        return;
      }

      if (node.arguments.length !== 1) {
        return;
      }

      const [configExpression] = node.arguments;
      if (
        configExpression == null ||
        !t.isExpression(configExpression) ||
        (requireObjectLiteralConfig && !t.isObjectExpression(configExpression))
      ) {
        return;
      }

      node.arguments = [
        configExpression,
        t.stringLiteral(
          `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}${sentinelIds[nextSentinelIndex]}`
        )
      ];
      nextSentinelIndex += 1;
    });

    if (nextSentinelIndex !== sentinelIds.length) {
      throw new Error(
        "Failed to inject fixture sentinel args into every defineRules call"
      );
    }

    return printDefineRulesPresetArtifact(artifact, ast);
  }

  function createFixtureBuildSource(
    filePath: string,
    ...sentinelIds: string[]
  ): string {
    return injectDefineRulesPresetSentinels(
      readFixtureSource(filePath),
      sentinelIds
    );
  }

  async function buildAndProcessFixtureSource(
    filePath: string,
    source: string
  ): Promise<{
    outputSource: string;
    emittedCss: string;
  }> {
    const [{ compile }, { processVanillaFile }] = await Promise.all([
      import("./compile.js"),
      import("@vanilla-extract/integration")
    ]);
    const emittedCssSources: string[] = [];
    const compiled = await compile({
      filePath,
      contents: source,
      originalPath: filePath,
      resolverCache: new Map()
    });
    const outputSource = await processVanillaFile({
      source: compiled.source,
      filePath,
      identOption: "debug",
      serializeVirtualCssPath: ({ fileName, source: cssSource }) => {
        emittedCssSources.push(cssSource);
        return `import "${fileName}";`;
      }
    });

    return {
      outputSource,
      emittedCss: emittedCssSources.join("\n")
    };
  }

  function createUnsupportedFixtureBuildSource(
    filePath: string,
    sentinelId: string,
    requireObjectLiteralConfig: boolean
  ): string {
    return injectDefineRulesPresetSentinels(
      readFixtureSource(filePath),
      [sentinelId],
      {
        requireObjectLiteralConfig
      }
    );
  }

  async function captureAndBackfillFixture(
    fixturePath: string,
    sentinelId: string,
    buildSource: string
  ): Promise<{
    result: {
      presetOwner: TestDefineRulesResult;
      shared: string;
    };
    captureSession: DefineRulesPresetCaptureSession | undefined;
    rewrittenArtifact: DefineRulesPresetBuildArtifact | undefined;
  }> {
    const { result, captureSession } = await captureDefineRulesPresetSession(
      fixturePath,
      () => {
        const presetOwner = defineRulesWithCapture(
          {
            debugId: sentinelId,
            properties: {
              color: true,
              display: true
            }
          },
          sentinelId
        );

        return {
          presetOwner,
          shared: presetOwner.css({
            color: "rebeccapurple",
            display: "flex"
          })
        };
      }
    );

    const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
      [
        {
          filePath: fixturePath,
          source: buildSource
        }
      ],
      captureSession
    );

    return {
      result,
      captureSession,
      rewrittenArtifact
    };
  }

  function createMismatchCaptureSession(
    filePath: string,
    sentinelId: string
  ): DefineRulesPresetCaptureSession {
    return {
      filePath,
      instances: [
        {
          sentinelId,
          filePath,
          instanceIndex: 0,
          getPresetSnapshot: () => ({
            [sentinelId]: `${sentinelId}_class`
          })
        }
      ]
    };
  }

  describe("defineRules shared build artifact serialization", () => {
    it.skip("serializes exported css with the class literal it already emitted", async () => {
      const sharedArtifactFixturePath =
        createDefineRulesPresetSerializationFixturePath(
          "shared-artifact/src/index.css.ts"
        );
      const sharedArtifactFixtureSource = `
        import { defineRules } from "@mincho-js/css";

        export const { css } = defineRules({ properties: { background: true } });
        export const fillBlue = css({ background: "blue" });
      `;

      expectSourceToContainSnippet(
        sharedArtifactFixtureSource,
        "export const { css } = defineRules({ properties: { background: true } });"
      );
      expectSourceToContainSnippet(
        sharedArtifactFixtureSource,
        'export const fillBlue = css({ background: "blue" });'
      );

      const { outputSource, emittedCss } = await buildAndProcessFixtureSource(
        sharedArtifactFixturePath,
        sharedArtifactFixtureSource
      );
      const fillBlueClassName = extractExportedStringValueFromArtifactSource(
        outputSource,
        "fillBlue"
      );
      const fillBlueInit = extractExportedVariableInitFromArtifactSource(
        outputSource,
        "fillBlue"
      );
      const serializedPresetMaps =
        extractPresetMapsFromArtifactSource(outputSource);
      const [serializedPresetMap] = serializedPresetMaps;

      expect(t.isCallExpression(fillBlueInit)).toBe(false);
      expect(fillBlueClassName.split(/\s+/)).toHaveLength(1);
      expect(
        hasCssCallWithStringProperty(outputSource, "background", "blue")
      ).toBe(false);
      expect(serializedPresetMaps).toHaveLength(1);
      if (serializedPresetMap == null) {
        throw new Error("Expected serialized css to include a preset map");
      }

      expect(
        Object.keys(serializedPresetMap).every(
          (key) => key.startsWith("fragment_") === false
        )
      ).toBe(true);
      expect(Object.values(serializedPresetMap)).toContain(fillBlueClassName);

      const { createDefineRulesCssRuntime } =
        await import("@mincho-js/css/defineRules/createDefineRulesCssRuntime");
      const exportedCss = createDefineRulesCssRuntime({
        properties: {
          background: true
        },
        presets: serializedPresetMap
      });
      expect(exportedCss({ background: "blue" })).toBe(fillBlueClassName);

      const reusablePresetOwner = defineRules({
        properties: {
          background: true
        },
        presets: serializedPresetMap
      });
      const seededEntryCount = Object.keys(reusablePresetOwner.preset).length;
      expect(reusablePresetOwner.css({ background: "blue" })).toBe(
        fillBlueClassName
      );
      expect(Object.keys(reusablePresetOwner.preset)).toHaveLength(
        seededEntryCount
      );

      expect(emittedCss.match(/\bbackground:\s*blue;?/g) ?? []).toHaveLength(1);
    });
  });

  // The CSS package no longer exposes the legacy sentinel/capture module. These
  // tests intentionally stay visible until the registry integration migration
  // replaces this legacy backfill coverage.
  describe.skip("defineRules preset backfill", () => {
    it("defineRules preset capture sessions are queued and clean up after failures", async () => {
      const firstGate = createDeferred<void>();
      const processOrder: string[] = [];

      const firstCapturePromise = runDefineRulesPresetCaptureStep(async () => {
        processOrder.push("start:first");
        const captureResult = await captureDefineRulesPresetSession(
          "/virtual/first.css.ts",
          async () => {
            await firstGate.promise;
            const presetOwner = defineRulesWithCapture(
              {
                properties: {
                  color: true
                }
              },
              "first"
            );
            const shared = presetOwner.css({
              color: "red"
            });

            return {
              presetOwner,
              shared
            };
          }
        );
        processOrder.push("end:first");
        return captureResult;
      });
      const secondCapturePromise = runDefineRulesPresetCaptureStep(async () => {
        processOrder.push("start:second");
        const captureResult = await captureDefineRulesPresetSession(
          "/virtual/second.css.ts",
          () => {
            const presetOwner = defineRulesWithCapture(
              {
                properties: {
                  display: true
                }
              },
              "second"
            );
            const shared = presetOwner.css({
              display: "flex"
            });

            return {
              presetOwner,
              shared
            };
          }
        );
        processOrder.push("end:second");
        return captureResult;
      });

      await vi.waitFor(() => {
        expect(processOrder).toEqual(["start:first"]);
      });

      firstGate.resolve();
      const [firstCapture, secondCapture] = await Promise.all([
        firstCapturePromise,
        secondCapturePromise
      ]);

      expect(processOrder).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second"
      ]);
      expect(
        firstCapture.captureSession?.instances.map(
          ({ sentinelId }) => sentinelId
        )
      ).toEqual(["first"]);
      expect(
        secondCapture.captureSession?.instances.map(
          ({ sentinelId }) => sentinelId
        )
      ).toEqual(["second"]);
      expect(
        Object.values(
          firstCapture.captureSession?.instances[0]?.getPresetSnapshot() ?? {}
        )
      ).toContain(firstCapture.result.shared);
      expect(
        Object.values(
          secondCapture.captureSession?.instances[0]?.getPresetSnapshot() ?? {}
        )
      ).toContain(secondCapture.result.shared);
      expect(firstCapture.result.presetOwner.preset).not.toEqual(
        secondCapture.result.presetOwner.preset
      );

      await expect(
        runDefineRulesPresetCaptureStep(async () => {
          await captureDefineRulesPresetSession(
            "/virtual/failing.css.ts",
            () => {
              defineRulesWithCapture(
                {
                  properties: {
                    color: true
                  }
                },
                "failing"
              );
              throw new Error("queued failure");
            }
          );
        })
      ).rejects.toThrow("queued failure");

      const recoveredCapture = await runDefineRulesPresetCaptureStep(() =>
        captureDefineRulesPresetSession("/virtual/recovered.css.ts", () => {
          const presetOwner = defineRulesWithCapture(
            {
              properties: {
                margin: true
              }
            },
            "recovered"
          );
          const shared = presetOwner.css({
            margin: 4
          });

          return {
            presetOwner,
            shared
          };
        })
      );

      expect(
        recoveredCapture.captureSession?.instances.map(
          ({ sentinelId }) => sentinelId
        )
      ).toEqual(["recovered"]);
      expect(
        Object.values(
          recoveredCapture.captureSession?.instances[0]?.getPresetSnapshot() ??
            {}
        )
      ).toContain(recoveredCapture.result.shared);
    });

    it("backfills provider snapshots for downstream consumer reuse", async () => {
      const providerRootFixtureSource = readFixtureSource(
        providerRootFixturePath
      );
      const providerFixtureSource = readFixtureSource(providerFixturePath);

      expect(providerRootFixtureSource).toContain(
        'export { css, preset, sharedCss, sharedPreset } from "./preset.css.ts";'
      );
      expect(providerFixtureSource).toContain(
        "export const sharedPreset = defineRules"
      );
      expect(providerFixtureSource).toContain(
        "export const preset = sharedPreset;"
      );
      expect(providerFixtureSource).toContain("export const css = sharedCss;");
      expect(
        providerFixturePath.endsWith("provider-module/src/preset.css.ts")
      ).toBe(true);
      expect(consumerFixturePath.endsWith("consumer/src/index.css.ts")).toBe(
        true
      );
      const providerBuildSource = createFixtureBuildSource(
        providerFixturePath,
        "provider"
      );

      const { result, captureSession } = await captureDefineRulesPresetSession(
        providerFixturePath,
        () => {
          const provider = defineRulesWithCapture(
            {
              debugId: "provider-module",
              properties: {
                color: true,
                display: true
              }
            },
            "provider"
          );

          const shared = provider.css({
            color: "rebeccapurple",
            display: "flex"
          });

          return {
            provider,
            shared
          };
        }
      );

      expect(captureSession?.instances).toHaveLength(1);
      expect(captureSession?.instances[0]?.filePath).toBe(providerFixturePath);

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: providerFixturePath,
            source: providerBuildSource
          }
        ],
        captureSession
      );

      expect(rewrittenArtifact?.source).toContain("presets");
      expect(rewrittenArtifact?.source).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );

      const injectedPresetMap = extractPresetMapFromArtifactSource(
        rewrittenArtifact!.source
      );

      expect(
        extractDefineRulesArgumentLengths(rewrittenArtifact!.source)
      ).toEqual([1]);
      expect(injectedPresetMap).toEqual(result.provider.preset);

      const consumer = defineRules({
        debugId: "consumer",
        presets: injectedPresetMap,
        properties: {
          color: true,
          display: true,
          padding: true,
          margin: true
        }
      });
      const reusedShared = consumer.css({
        color: "rebeccapurple",
        display: "flex"
      });

      const seededEntryCount = Object.keys(injectedPresetMap).length;
      expect(reusedShared).toBe(result.shared);
      expect(Object.keys(consumer.preset)).toHaveLength(seededEntryCount);

      consumer.css({
        padding: 13,
        margin: 11
      });

      expect(Object.keys(consumer.preset).length).toBeGreaterThan(
        seededEntryCount
      );
      expect(consumer.preset).toEqual(
        expect.objectContaining(injectedPresetMap)
      );
    });

    it("ignores sentinel-shaped args on non-defineRules callees", () => {
      const fixturePath = "/virtual/false-sentinel.css.ts";
      const captureSession = createMismatchCaptureSession(
        fixturePath,
        "provider"
      );
      const buildSource = `
        import { defineRules } from "@mincho-js/css";

        export const provider = defineRules(
          {
            properties: {
              color: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider"
        );
        export const ignored = notDefineRules(
          {},
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}ignored"
        );
      `;

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: fixturePath,
            source: buildSource
          }
        ],
        captureSession
      );
      const rewrittenSource = rewrittenArtifact?.source ?? "";

      expect(rewrittenSource).toContain("notDefineRules");
      expect(rewrittenSource).toContain(
        `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}ignored`
      );
      expect(extractDefineRulesArgumentLengths(rewrittenSource)).toEqual([1]);
      expect(extractPresetMapFromArtifactSource(rewrittenSource)).toEqual({
        provider: "provider_class"
      });
    });

    it("backfills defineRules presets after spreads without being overwritten", async () => {
      const fixturePath = "/virtual/spread-order.css.ts";
      const createCapturedPreset = (sentinelId: string) => {
        const presetOwner = defineRulesWithCapture(
          {
            debugId: sentinelId,
            properties: {
              color: true,
              display: true
            }
          },
          sentinelId
        );
        const shared = presetOwner.css({
          color: "rebeccapurple",
          display: "flex"
        });

        return {
          presetOwner,
          shared
        };
      };
      const { result, captureSession } = await captureDefineRulesPresetSession(
        fixturePath,
        () => ({
          absent: createCapturedPreset("absent"),
          beforeSpread: createCapturedPreset("before-spread"),
          afterSpread: createCapturedPreset("after-spread"),
          dynamicComputed: createCapturedPreset("dynamic-computed")
        })
      );
      const buildSource = `
        import { defineRules } from "@mincho-js/css";

        const stalePreset = { stale: "stale_class" };
        const spreadWithPreset = { presets: stalePreset };
        const dynamicPresetKey = "presets";

        export const absent = defineRules(
          {
            properties: {
              color: true,
              display: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}absent"
        );

        export const beforeSpread = defineRules(
          {
            presets: stalePreset,
            ...spreadWithPreset,
            properties: {
              color: true,
              display: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}before-spread"
        );

        export const afterSpread = defineRules(
          {
            ...spreadWithPreset,
            presets: stalePreset,
            properties: {
              color: true,
              display: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}after-spread"
        );

        export const dynamicComputed = defineRules(
          {
            ...spreadWithPreset,
            [dynamicPresetKey]: stalePreset,
            properties: {
              color: true,
              display: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}dynamic-computed"
        );
      `;

      expect(
        captureSession?.instances.map(({ sentinelId }) => sentinelId)
      ).toEqual([
        "absent",
        "before-spread",
        "after-spread",
        "dynamic-computed"
      ]);

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: fixturePath,
            source: buildSource
          }
        ],
        captureSession
      );
      const rewrittenSource = rewrittenArtifact?.source ?? "";

      expect(rewrittenSource).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
      expect(extractDefineRulesArgumentLengths(rewrittenSource)).toEqual([
        1, 1, 1, 1
      ]);
      const configExpressions =
        extractDefineRulesConfigExpressionsFromArtifactSource(rewrittenSource);
      expect(configExpressions).toHaveLength(4);
      const [
        absentConfig,
        beforeSpreadConfig,
        afterSpreadConfig,
        dynamicConfig
      ] = configExpressions;
      if (
        absentConfig == null ||
        beforeSpreadConfig == null ||
        afterSpreadConfig == null ||
        dynamicConfig == null
      ) {
        throw new Error(
          "Expected every defineRules call to keep an object config"
        );
      }

      const injectedPresetMaps = configExpressions.map((configExpression) =>
        extractGeneratedPresetMapFromConfigExpression(configExpression)
      );

      expect(injectedPresetMaps).toEqual([
        result.absent.presetOwner.preset,
        result.beforeSpread.presetOwner.preset,
        result.afterSpread.presetOwner.preset,
        result.dynamicComputed.presetOwner.preset
      ]);
      expect(
        hasComputedPropertyWithIdentifierKey(dynamicConfig, "dynamicPresetKey")
      ).toBe(true);
      expectRuntimeReuseWithPresetOverrides(
        injectedPresetMaps[1]!,
        result.beforeSpread.shared
      );
      expectRuntimeReuseWithPresetOverrides(
        injectedPresetMaps[2]!,
        result.afterSpread.shared
      );
      expectRuntimeReuseWithPresetOverrides(
        injectedPresetMaps[3]!,
        result.dynamicComputed.shared
      );
    });

    it("backfills defineRules presets with duplicate preset keys deterministically", async () => {
      const fixturePath = "/virtual/duplicate-presets.css.ts";
      const { result, captureSession } = await captureDefineRulesPresetSession(
        fixturePath,
        () => {
          const presetOwner = defineRulesWithCapture(
            {
              debugId: "duplicate-presets",
              properties: {
                color: true,
                display: true
              }
            },
            "duplicate-presets"
          );
          const shared = presetOwner.css({
            color: "rebeccapurple",
            display: "flex"
          });

          return {
            presetOwner,
            shared
          };
        }
      );
      const buildSource = `
        import { defineRules } from "@mincho-js/css";

        const stalePreset = { stale: "stale_class" };

        export const duplicatePresets = defineRules(
          {
            presets: stalePreset,
            "presets": stalePreset,
            ["presets"]: stalePreset,
            [\`presets\`]: stalePreset,
            properties: {
              color: true,
              display: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}duplicate-presets"
        );
      `;

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: fixturePath,
            source: buildSource
          }
        ],
        captureSession
      );
      const rewrittenSource = rewrittenArtifact?.source ?? "";

      expect(rewrittenSource).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
      expect(extractDefineRulesArgumentLengths(rewrittenSource)).toEqual([1]);
      const [configExpression] =
        extractDefineRulesConfigExpressionsFromArtifactSource(rewrittenSource);
      if (configExpression == null) {
        throw new Error("Expected rewritten duplicate preset callsite");
      }
      const injectedPresetMap =
        extractGeneratedPresetMapFromConfigExpression(configExpression);

      expect(injectedPresetMap).toEqual(result.presetOwner.preset);
      expectRuntimeReuseWithPresetOverrides(injectedPresetMap, result.shared);
    });

    it("keeps root css fixture reuse tied to the explicit css asset import contract", () => {
      const consumerFixtureSource = readFixtureSource(consumerFixturePath);

      expect(consumerFixtureSource).toContain(
        'import "__DEFINE_RULES_PRESET_SPECIFIER__/shared-component.css";'
      );
      expect(consumerFixtureSource).toContain(
        '} from "__DEFINE_RULES_PRESET_SPECIFIER__";'
      );
      expect(consumerFixtureSource).toContain("  css,");
      expect(consumerFixtureSource).toContain("export { importedShared };");
    });

    it("backfills flattened transitive producer snapshots", async () => {
      const transitiveFixtureSource = readFixtureSource(transitiveFixturePath);

      expect(transitiveFixtureSource).toContain(
        'import { preset as rootPreset } from "__DEFINE_RULES_PRESET_SPECIFIER__";'
      );
      const transitiveBuildSource = createFixtureBuildSource(
        transitiveFixturePath,
        "transitive"
      );
      const provider = defineRules({
        debugId: "provider",
        properties: {
          color: true,
          display: true
        }
      });
      const providerShared = provider.css({
        color: "rebeccapurple",
        display: "flex"
      });
      const importedPreset = {
        ...provider.preset
      };

      const { result, captureSession } = await captureDefineRulesPresetSession(
        transitiveFixturePath,
        () => {
          const producer = defineRulesWithCapture(
            {
              presets: importedPreset,
              properties: {
                color: true,
                display: true,
                padding: true,
                margin: true
              }
            },
            "transitive"
          );
          const shared = producer.css({
            color: "rebeccapurple",
            display: "flex"
          });

          producer.css({
            padding: 13,
            margin: 11
          });

          return {
            producer,
            shared
          };
        }
      );

      expect(result.shared).toBe(providerShared);

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: transitiveFixturePath,
            source: transitiveBuildSource
          }
        ],
        captureSession
      );

      expect(rewrittenArtifact?.source).toContain("presets");
      expect(rewrittenArtifact?.source).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );

      const injectedPresetMap = extractPresetMapFromArtifactSource(
        rewrittenArtifact!.source
      );

      expect(injectedPresetMap).toEqual(result.producer.preset);
      expect(injectedPresetMap).toEqual(
        expect.objectContaining(importedPreset)
      );
      expect(Object.keys(injectedPresetMap).length).toBeGreaterThan(
        Object.keys(importedPreset).length
      );
    });

    it("keeps consumer-order fixture reuse deterministic for canonical-equivalent fragments", async () => {
      const consumerOrderFixtureSource = readFixtureSource(
        consumerOrderFixturePath
      );

      expect(consumerOrderFixtureSource).toContain(
        'import { preset as primaryRootPreset } from "__DEFINE_RULES_PRESET_SPECIFIER__";'
      );
      expect(consumerOrderFixtureSource).toContain(
        'import { preset as secondaryRootPreset } from "__DEFINE_RULES_PRESET_SECONDARY_SPECIFIER__";'
      );
      const consumerOrderBuildSource = createFixtureBuildSource(
        consumerOrderFixturePath,
        "consumer-order"
      );
      const primary = defineRules({
        debugId: "primary",
        properties: {
          color: true,
          display: true
        }
      });
      const secondary = defineRules({
        debugId: "secondary",
        properties: {
          color: true
        }
      });
      const shared = primary.css({
        color: "rebeccapurple",
        display: "flex"
      });
      const overlap = secondary.css({
        color: "tomato"
      });
      const importedPreset = {
        ...primary.preset,
        ...secondary.preset
      };

      const { result, captureSession } = await captureDefineRulesPresetSession(
        consumerOrderFixturePath,
        () => {
          const consumer = defineRulesWithCapture(
            {
              presets: importedPreset,
              properties: {
                color: true,
                display: true,
                padding: true,
                margin: true
              }
            },
            "consumer-order"
          );
          const seededEntryCount = Object.keys(consumer.preset).length;
          const overlapPrimaryFirst = consumer.css([
            {
              color: "rebeccapurple",
              display: "flex"
            },
            {
              padding: 13
            },
            {
              color: "tomato"
            }
          ]);
          const entryCountAfterFirstOverlap = Object.keys(
            consumer.preset
          ).length;
          const overlapSecondaryFirst = consumer.css([
            {
              color: "rebeccapurple",
              display: "flex"
            },
            {
              color: "tomato"
            },
            {
              padding: 13
            }
          ]);
          const entryCountAfterSecondOverlap = Object.keys(
            consumer.preset
          ).length;
          const overlapConsumerOnly = consumer.css({
            padding: 13,
            margin: 11
          });

          return {
            consumer,
            shared,
            overlap,
            seededEntryCount,
            entryCountAfterFirstOverlap,
            entryCountAfterSecondOverlap,
            overlapPrimaryFirst,
            overlapSecondaryFirst,
            overlapConsumerOnly
          };
        }
      );

      const overlapPrimaryFirstClasses = result.overlapPrimaryFirst.split(" ");
      const overlapSecondaryFirstClasses =
        result.overlapSecondaryFirst.split(" ");
      const sharedClasses = result.shared.split(" ");
      const preservedSharedClass = overlapPrimaryFirstClasses.find(
        (className) => sharedClasses.includes(className)
      );
      const paddingClass = overlapPrimaryFirstClasses.find(
        (className) =>
          className !== preservedSharedClass && className !== result.overlap
      );

      expect(overlapPrimaryFirstClasses).toHaveLength(3);
      expect(overlapSecondaryFirstClasses).toHaveLength(3);
      expect(preservedSharedClass).toBeDefined();
      expect(paddingClass).toBeDefined();

      if (preservedSharedClass == null || paddingClass == null) {
        throw new Error("Expected shared and padding classes to be preserved");
      }

      const canonicalOverlapClasses = [
        preservedSharedClass,
        paddingClass,
        result.overlap
      ].sort();

      expect(overlapPrimaryFirstClasses).toEqual(canonicalOverlapClasses);
      expect(overlapSecondaryFirstClasses).toEqual(canonicalOverlapClasses);
      expect(sharedClasses).not.toContain(result.overlap);
      expect(result.entryCountAfterFirstOverlap).toBe(
        result.seededEntryCount + 1
      );
      expect(result.entryCountAfterSecondOverlap).toBe(
        result.entryCountAfterFirstOverlap
      );
      expect(Object.keys(result.consumer.preset)).toHaveLength(
        result.seededEntryCount + 2
      );

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: consumerOrderFixturePath,
            source: consumerOrderBuildSource
          }
        ],
        captureSession
      );

      expect(rewrittenArtifact?.source).toContain("presets");
      expect(rewrittenArtifact?.source).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );

      const injectedPresetMap = extractPresetMapFromArtifactSource(
        rewrittenArtifact!.source
      );

      expect(injectedPresetMap).toEqual(result.consumer.preset);
      expect(injectedPresetMap).toEqual(
        expect.objectContaining(importedPreset)
      );
    });

    it("backfills isolated raw preset maps for multiple fixture instances", async () => {
      const multipleInstancesBuildSource = createFixtureBuildSource(
        multipleInstancesFixturePath,
        "primary",
        "secondary"
      );

      const { result, captureSession } = await captureDefineRulesPresetSession(
        multipleInstancesFixturePath,
        () => {
          const preset = defineRulesWithCapture(
            {
              properties: {
                color: true,
                display: true
              }
            },
            "primary"
          );
          const presetSecondary = defineRulesWithCapture(
            {
              properties: {
                padding: true,
                margin: true
              }
            },
            "secondary"
          );

          return {
            preset,
            presetSecondary,
            shared: preset.css({
              color: "rebeccapurple",
              display: "flex"
            }),
            secondaryShared: presetSecondary.css({
              padding: 17,
              margin: 7
            })
          };
        }
      );

      expect(
        captureSession?.instances.map(({ sentinelId }) => sentinelId)
      ).toEqual(["primary", "secondary"]);

      const [rewrittenArtifact] = backfillDefineRulesPresetArtifacts(
        [
          {
            filePath: multipleInstancesFixturePath,
            source: multipleInstancesBuildSource
          }
        ],
        captureSession
      );

      const injectedPresetMaps = extractPresetMapsFromArtifactSource(
        rewrittenArtifact!.source
      );

      expect(rewrittenArtifact?.source).not.toContain(
        DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
      );
      expect(
        extractDefineRulesArgumentLengths(rewrittenArtifact!.source)
      ).toEqual([1, 1]);
      expect(injectedPresetMaps).toEqual([
        result.preset.preset,
        result.presetSecondary.preset
      ]);
      expect(injectedPresetMaps[0]).not.toEqual(injectedPresetMaps[1]);

      const consumer = defineRules({
        presets: injectedPresetMaps[0],
        properties: {
          color: true,
          display: true
        }
      });
      const consumerSecondary = defineRules({
        presets: injectedPresetMaps[1],
        properties: {
          padding: true,
          margin: true
        }
      });

      expect(
        consumer.css({
          color: "rebeccapurple",
          display: "flex"
        })
      ).toBe(result.shared);
      expect(Object.keys(consumer.preset)).toHaveLength(
        Object.keys(injectedPresetMaps[0]!).length
      );
      expect(
        consumerSecondary.css({
          padding: 17,
          margin: 7
        })
      ).toBe(result.secondaryShared);
      expect(Object.keys(consumerSecondary.preset)).toHaveLength(
        Object.keys(injectedPresetMaps[1]!).length
      );
    });

    it("backfills supported fixture matrix cases through the real build-support path", async () => {
      for (const fixtureCase of supportedFixtureMatrixCases) {
        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const buildSource = createFixtureBuildSource(
          fixtureCase.fixturePath,
          fixtureCase.caseId
        );
        const { result, captureSession, rewrittenArtifact } =
          await captureAndBackfillFixture(
            fixtureCase.fixturePath,
            fixtureCase.caseId,
            buildSource
          );

        expect(captureSession?.instances).toHaveLength(1);
        expect(captureSession?.instances[0]?.filePath).toBe(
          fixtureCase.fixturePath
        );
        expect(rewrittenArtifact?.source).toContain("presets");
        expect(rewrittenArtifact?.source).not.toContain(
          DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX
        );
        expect(
          extractDefineRulesArgumentLengths(rewrittenArtifact!.source)
        ).toEqual([1]);

        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(
            rewrittenArtifact?.source ?? "",
            expectedSourceSnippet
          );
        }

        const injectedPresetMap = extractPresetMapFromArtifactSource(
          rewrittenArtifact!.source
        );

        expect(injectedPresetMap).toEqual(result.presetOwner.preset);

        const consumer = defineRules({
          presets: injectedPresetMap,
          properties: {
            color: true,
            display: true
          }
        });

        expect(
          consumer.css({
            color: "rebeccapurple",
            display: "flex"
          })
        ).toBe(result.shared);
      }
    });

    it("throws the locked mismatch error for unsupported fixture matrix cases", () => {
      for (const fixtureCase of unsupportedFixtureMatrixCases) {
        const fixtureSource = readFixtureSource(fixtureCase.fixturePath);
        for (const expectedSourceSnippet of fixtureCase.expectedSourceSnippets) {
          expectSourceToContainSnippet(fixtureSource, expectedSourceSnippet);
        }

        const buildSource = createUnsupportedFixtureBuildSource(
          fixtureCase.fixturePath,
          fixtureCase.caseId,
          Boolean(fixtureCase.requireObjectLiteralConfig ?? true)
        );

        expect(() =>
          backfillDefineRulesPresetArtifacts(
            [
              {
                filePath: fixtureCase.fixturePath,
                source: buildSource
              }
            ],
            createMismatchCaptureSession(
              fixtureCase.fixturePath,
              fixtureCase.caseId
            )
          )
        ).toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
      }
    });

    it("throws the locked mismatch error when captured and rewritten callsites diverge", () => {
      const providerBuildSource = createFixtureBuildSource(
        providerFixturePath,
        "provider"
      );
      const mismatchedSession: DefineRulesPresetCaptureSession = {
        filePath: providerFixturePath,
        instances: [
          {
            sentinelId: "provider",
            filePath: providerFixturePath,
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              provider: "provider_class"
            })
          }
        ]
      };

      expect(() =>
        backfillDefineRulesPresetArtifacts(
          [
            {
              filePath: providerFixturePath,
              source: providerBuildSource.replace(
                `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider`,
                `${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}other`
              )
            }
          ],
          mismatchedSession
        )
      ).toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    });

    it("throws the locked mismatch error when captured and rewritten file paths diverge", () => {
      const capturedFixturePath = "/virtual/captured.css.ts";
      const rewrittenFixturePath = "/virtual/rewritten.css.ts";
      const buildSource = `
        import { defineRules } from "@mincho-js/css";

        export const provider = defineRules(
          {
            properties: {
              color: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider"
        );
      `;

      expect(() =>
        backfillDefineRulesPresetArtifacts(
          [
            {
              filePath: rewrittenFixturePath,
              source: buildSource
            }
          ],
          createMismatchCaptureSession(capturedFixturePath, "provider")
        )
      ).toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);

      const inconsistentCaptureSession: DefineRulesPresetCaptureSession = {
        filePath: capturedFixturePath,
        instances: [
          {
            sentinelId: "provider",
            filePath: rewrittenFixturePath,
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              provider: "provider_class"
            })
          }
        ]
      };

      expect(() =>
        backfillDefineRulesPresetArtifacts(
          [
            {
              filePath: rewrittenFixturePath,
              source: buildSource
            }
          ],
          inconsistentCaptureSession
        )
      ).toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    });

    it("throws the locked mismatch error for unsupported sentinel-tagged callsites", () => {
      const unsupportedSentinelSource = `
        import { defineRules } from "@mincho-js/css";

        export const preset = defineRules(
          {
            properties: {
              color: true
            }
          },
          "${DEFINE_RULES_PRESET_CAPTURE_SENTINEL_PREFIX}provider",
          "leaked-second-arg"
        );
      `;
      const mismatchedSession: DefineRulesPresetCaptureSession = {
        filePath: "/virtual/unsupported.js",
        instances: [
          {
            sentinelId: "provider",
            filePath: "/virtual/unsupported.js",
            instanceIndex: 0,
            getPresetSnapshot: () => ({
              provider: "provider_class"
            })
          }
        ]
      };

      expect(() =>
        backfillDefineRulesPresetArtifacts(
          [
            {
              filePath: "/virtual/unsupported.js",
              source: unsupportedSentinelSource
            }
          ],
          mismatchedSession
        )
      ).toThrow(DEFINE_RULES_PRESET_BACKFILL_MISMATCH_ERROR);
    });
  });
}

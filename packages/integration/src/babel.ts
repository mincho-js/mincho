import { driveModuleGraph } from "./moduleGraph.js";
import { executeTransform } from "./compilationExecution.js";
import { cachedTransform } from "./transformCache.js";
import type { CompilationCache } from "./compilationCache.js";
import {
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { jsxSyntaxPluginPath, typescriptPresetPath } from "./babelPreset.js";
import {
  type BabelFileResult,
  type NodePath,
  type TransformOptions,
  loadPartialConfigAsync,
  parseAsync,
  traverse,
  types as t,
  transformFromAstAsync,
  transformAsync
} from "@babel/core";
import {
  type InternalImportedStaticCssEvalModuleRecord as ImportedStaticCssEvalModuleRecord,
  type MinchoStaticCssEvalMetadata,
  type MinchoBabelFileMetadata,
  type PluginOptions,
  type MinchoCompilationMetadata,
  type InternalRuntimeCandidates,
  type InternalPreparedExtractCalls,
  internalCollectRuntimeCandidates,
  internalGetStaticCssEvalLiteralRequireImportPath,
  internalHasConfiguredGeneratorOverride,
  internalParseModuleProgram,
  internalNormalizeTypeScriptCommonJs,
  minchoBabelPlugin,
  minchoStyledComponentPlugin,
  InternalExtractCallsError,
  internalAnalyzePureFunctions,
  internalJsxCssPropExtractCalls
} from "@mincho-js/babel";
import {
  applyInferredCommonJsSourceType,
  inferCommonJsSourceType,
  transformCommonJsToEsm
} from "./commonJs.js";
import {
  prepareExtractCalls,
  retainRuntimeSourceDependencies
} from "./extractCalls.js";
import {
  createEmptyStaticCssEvalMetadata,
  createObservingStaticCssEvalProvider,
  createStaticCssEvalTransformResult,
  getStaticCssEvalMetadata,
  mergeStaticCssEvalMetadata
} from "./staticCssEvalMetadata.js";
import { createStaticCssEvalPrepass } from "./staticCssEvalPrepass.js";
import {
  MinchoProjectEngine,
  type StaticEvalProjectEngine,
  type StaticEvalProjectEngineGeneratedArtifact
} from "./staticCssEvalProjectEngine.js";

type MaybePromise<T> = T | Promise<T>;

type StaticCssEvalMetadataDependency =
  MinchoStaticCssEvalMetadata["dependencies"][number];

type StaticCssEvalMetadataDiagnostic =
  MinchoStaticCssEvalMetadata["diagnostics"][number];

type StaticCssEvalMetadataCacheKey =
  MinchoStaticCssEvalMetadata["cacheKeys"][number];

export type StaticCssEvalResolverKind =
  | "source-provider"
  | "filesystem"
  | "vite"
  | "esbuild"
  | "test"
  | (string & {});

export interface StaticCssEvalSourceIdentity {
  sourceHash?: string;
  version?: string | number;
}

export const STATIC_CSS_EVAL_SOURCE_KINDS = [
  "project-source",
  "package-source",
  "provider-virtual",
  "static-data",
  "external-no-source",
  "unresolved",
  "unsupported-source-shape"
] as const;

export type StaticCssEvalSourceKind =
  (typeof STATIC_CSS_EVAL_SOURCE_KINDS)[number];

export const STATIC_CSS_EVAL_SOURCE_ORIGINS = [
  "project",
  "package",
  "provider",
  "data",
  "external",
  "unresolved",
  "unsupported"
] as const;

export type StaticCssEvalSourceOrigin =
  (typeof STATIC_CSS_EVAL_SOURCE_ORIGINS)[number];

export type StaticCssEvalSourceUnsupportedReason = NonNullable<
  StaticCssEvalMetadataDependency["unsupportedReason"]
>;

// Integration supplies bundler-aware identity/source freshness; Babel static
// eval remains the only owner of css value and symbol provenance.
export interface StaticCssEvalSourceResolution {
  /** @internal Host module identity, including transform queries, for consumers. */
  consumerRuntimeId?: string;
  /**
   * Legacy alias. When newer fields are absent, this is treated as the
   * resolved file, canonical module id, and normalized load key.
   */
  id?: string;

  /** File path used by Babel/static eval diagnostics, dependency files, and cache keys. */
  resolvedFile?: string;

  /** Bundler graph id that should be preserved for callers, even when it differs from the file path. */
  canonicalModuleId?: string;

  /** Adapter runtime import for a CommonJS package, separate from its analysis source. */
  commonJsRuntimeId?: string;

  /** Stable provider load/cache key; integration passes this value back to `load()`. */
  normalizedPathKey?: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;

  /** Source identity from the bundler; loaded source identity takes precedence. */
  sourceIdentity?: StaticCssEvalSourceIdentity;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];

  /** Identifies which resolver produced this source for downstream cache/debug consumers. */
  resolverKind?: StaticCssEvalResolverKind;
}

export interface StaticCssEvalLoadedSource {
  /** @internal Produced by the current compiler's CSS evaluation, never source annotations. */
  symbolicTokens?: import("./symbolicTokens.js").SymbolicTokenArtifact;

  /** Preferred loaded module text. */
  sourceText?: string;

  /** Legacy alias for `sourceText`. */
  source?: string;
  resolvedFile?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];
  resolverKind?: StaticCssEvalResolverKind;
}

/** @internal Async owner/dependency source provider for bundler prepasses. */
export interface StaticCssEvalSourceProvider {
  resolve(
    importerId: string,
    importPath: string,
    options?: { kind: "import" | "require" }
  ): MaybePromise<StaticCssEvalSourceResolution | null>;

  load(id: string): MaybePromise<StaticCssEvalLoadedSource | null>;

  /** @internal Observed separately so CSS value edits can preserve reference analysis. */
  tokenReference?(
    id: string,
    name?: string,
    value?: string
  ): MaybePromise<{ value: string; identity: string } | null>;
}

/** @internal An AST-observed edge, not a filename-only intrinsic assertion. */
export type IntrinsicEffectRequest =
  | { purpose: "commonjs-runtime-order"; targetId: string }
  | {
      /** Existing eligible runtime view, for intrinsic observation only. */
      purpose: "intrinsic-runtime";
    }
  | {
      purpose: "intrinsic-effects";
      importerId: string;
      specifier: string;
      resolutionMode: "import" | "require";
      attributes: "none";
    }
  | {
      /** Additional native owner view for vetoes, not final-host equivalence. */
      purpose: "intrinsic-owner";
      sourceHash: string;
    };

/** @internal The consumer surface observed from the host's existing transform. */
export type ConsumerRuntimeSource =
  | {
      source: string;
      sourceHash: string;
      version: string;
      eagerRuntimeModuleIds?: readonly string[];
      intrinsicEffects?: never;
      /** Trusted host callback bound to exact final bytes and current generation.
       * Only pattern-realm observation; not map/Math/value/purity authority. */
      validatesPatternIntrinsicEffects?: (view: {
        source: string;
        sourceHash: string;
        version: string;
      }) => boolean;
      watchFiles: readonly string[];
      /** Physical authoring owner when the host id denotes a generated module. */
      authoringId?: string;
    }
  | {
      source?: never;
      /** Trusted host-native initialization receipt; never export/call/purity evidence.
       * CSS-module mapping exports may exist, but are not authorized by this tag. */
      intrinsicEffects?: {
        kind: "native-css";
        loader: "css" | "local-css";
        sourceHash: string;
        version: string;
      };
      watchFiles: readonly string[];
      authoringId?: string;
    };

export interface StaticCssEvalPrepassResult {
  dependencyFiles: string[];
  ownerToDependencies: ReadonlyMap<string, string[]>;
  dependencyToOwners: ReadonlyMap<string, string[]>;
  resolvedModuleCache: ReadonlyMap<string, ImportedStaticCssEvalModuleRecord>;
  resolvedDependencies: StaticCssEvalResolvedDependency[];
}

export interface StaticCssEvalResolvedDependency {
  importerId: string;
  specifier: string;
  resolvedFile: string;
  canonicalModuleId: string;
  normalizedPathKey: string;
  resolverKind: StaticCssEvalResolverKind;
  loaded: boolean;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];
}

export interface StaticCssEvalTransformResult
  extends StaticCssEvalPrepassResult, MinchoStaticCssEvalMetadata {}

export class BabelTransformError extends Error {
  readonly file: string;
  readonly staticCssEval?: StaticCssEvalTransformResult;
  override cause: unknown;

  constructor(
    file: string,
    cause: unknown,
    staticCssEval?: StaticCssEvalTransformResult
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BabelTransformError";
    this.file = file;
    this.cause = cause;
    this.staticCssEval = staticCssEval;
  }
}

/** Only remove an unchanged whole import after the sole configured generator.
 * Keep source coordinates (and its authoritative source map) unchanged. */
async function reconcileEmittedEsmImports(
  code: string,
  filename: string,
  parserPlugins: NonNullable<TransformOptions["parserOpts"]>["plugins"],
  cleanup: NonNullable<MinchoBabelFileMetadata["minchoOptionalEsmImports"]>
): Promise<string> {
  let ast: t.File | null;
  try {
    ast = await parseAsync(code, {
      filename,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      parserOpts: { plugins: parserPlugins }
    });
  } catch {
    return code;
  }
  if (!ast) return code;
  const requestKey = (node: t.Statement) => {
    const importing = t.isImportDeclaration(node);
    if (
      !importing &&
      !t.isExportNamedDeclaration(node) &&
      !t.isExportAllDeclaration(node)
    )
      return;
    if (
      !node.source ||
      (importing
        ? node.importKind === "type" ||
          node.importKind === "typeof" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (item) =>
                t.isImportSpecifier(item) &&
                (item.importKind === "type" || item.importKind === "typeof")
            ))
        : node.exportKind === "type" ||
          (t.isExportNamedDeclaration(node) &&
            node.specifiers.length > 0 &&
            node.specifiers.every(
              (item) => t.isExportSpecifier(item) && item.exportKind === "type"
            )))
    )
      return;
    return JSON.stringify([
      node.source.value,
      importing ? (node.phase ?? null) : null,
      (node.attributes ?? node.assertions ?? [])
        .map(({ key, value }) =>
          JSON.stringify([
            t.isIdentifier(key) ? key.name : key.value,
            value.value
          ])
        )
        .sort()
    ]);
  };
  const orderedRequests = (body: readonly t.Statement[]) =>
    body.map(requestKey).filter((key) => key !== undefined);
  // The generator may add or move an actual static dependency which can
  // reach this package. If startup order changed, preserve the first request
  // rather than inferring the changed dependency's behavior from its name.
  const staged = orderedRequests(cleanup.requests);
  const emitted = orderedRequests(ast.program.body);
  if (
    staged.length !== emitted.length ||
    staged.some((request, index) => request !== emitted[index])
  )
    return code;

  const comments = ast.comments ?? [];
  const ranges: { start: number; end: number }[] = [];
  traverse(ast, {
    Program(program) {
      const imports = program
        .get("body")
        .filter((path) => path.isImportDeclaration());
      for (const site of cleanup.sites) {
        const matches = imports.filter((path) =>
          t.isNodesEquivalent(path.node, site)
        );
        if (matches.length !== 1) continue;
        const { node } = matches[0]!;
        const { start, end } = node;
        if (
          start == null ||
          end == null ||
          comments.some(
            (comment) =>
              comment.start != null &&
              comment.end != null &&
              comment.start < end &&
              comment.end > start
          ) ||
          node.specifiers.some((specifier) => {
            const binding = program.scope.getBinding(specifier.local.name);
            return (
              !binding?.constant ||
              binding.path.node !== specifier ||
              binding.referenced
            );
          })
        )
          continue;
        ranges.push({ start, end });
      }
      program.stop();
    }
  });
  for (const { start, end } of ranges.sort((a, b) => b.start - a.start))
    code =
      code.slice(0, start) +
      // Keep the statement boundary as well as the generator's UTF-16 offsets:
      // blanking alone could join an ASI-sensitive preceding expression.
      ";" +
      code.slice(start + 1, end).replace(/[^\r\n\u2028\u2029]/g, " ") +
      code.slice(end);
  return code;
}

export type BabelOptions = Omit<
  TransformOptions,
  | "ast"
  | "filename"
  | "root"
  | "sourceFileName"
  | "sourceMaps"
  | "inputSourceMap"
> & {
  /** @internal Environment-owned memory cache. */
  compilationCache?: CompilationCache;

  /** @internal Resolver environment identity, separate from module source. */
  compilationContext?: string;
  diagnostics?: boolean;

  /** @internal Vite dist-chunk private-resource proof, independent of JS folding. */
  privateRecipes?: boolean;
  extractCalls?: PluginOptions["extractCalls"];
  jsxCssProp?: PluginOptions["jsxCssProp"];
  bundleSize?: PluginOptions["bundleSize"];
  optimize?: PluginOptions["optimize"];
  experimental?: PluginOptions["experimental"];
  staticCssEvalProvider?: PluginOptions["staticCssEvalProvider"];

  /** @internal Async source provider used to prepare imported css eval data. */
  staticCssEvalSourceProvider?: StaticCssEvalSourceProvider;
  /**
   * @internal Undefined leaves an ordinary source module unchanged. An owned
   * but unavailable runtime surface retains its watches and remains unknown.
   * Worker requests and transform-cache observations preserve this separate
   * purpose and revalidate the host's actual source identity.
   */
  consumerRuntimeSource?: (
    id: string,
    request?: IntrinsicEffectRequest
  ) => MaybePromise<ConsumerRuntimeSource | undefined>;
  staticCssEvalProjectEngine?: StaticEvalProjectEngine;
};

export type BabelTransformResult = {
  /** @internal Effective owner syntax reused by extracted dependency compilation. */
  readonly parserPlugins?: NonNullable<BabelOptions["parserOpts"]>["plugins"];
  /** @internal Original use graph; never emitted to the application. */
  privateRecipeUses?: readonly import("./vanillaCssIr.js").PrivateRecipeUse[];
  privateResourceReferences?: readonly string[];

  /** @internal Shared bound across synchronous cx baking and async class tables. */
  classStringBudget?: { units: number; entries: number };

  /** @internal Statically inspected helper exports; runtime imports retain file dependencies. */
  readonly semanticDemands?: readonly {
    file: string;
    name: string | null;
    members: readonly string[];
  }[];

  /** @internal Optional-pass eligibility collected from the final extraction AST. */
  readonly runtimeCandidates?: InternalRuntimeCandidates;
  readonly diagnostics?: MinchoCompilationMetadata;
  commonJsTransformed?: boolean;
  runtimeOptimized?: boolean;
  code: string;
  readonly map?: BabelFileResult["map"];
  readonly jsxCssPropTransformed?: boolean;
  result: [string, string];
  readonly staticCssEval?: StaticCssEvalTransformResult;
};

export interface BabelTransformSourceOptions {
  /** @internal Vite browser and SSR modules require an ESM surface. */
  commonJsToEsm?: boolean;
  /** @internal This host's runtime source can include live, process-local observations. */
  keepRuntimeSourceInProcess?: boolean;
  filename: string;

  /** Project root used to resolve root-relative extractCalls registrations. */
  root?: string;
  source: string;
  loader?: "js" | "jsx" | "ts" | "tsx";
  babel?: BabelOptions;
  sourceMaps?: boolean;
  inputSourceMap?: TransformOptions["inputSourceMap"];
}

export async function babelTransform(
  path: string,
  babel: BabelOptions = {}
): Promise<BabelTransformResult> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    babel.staticCssEvalProjectEngine?.refreshFile({ fileId: path });

    throw new BabelTransformError(path, error);
  }

  return babelTransformSource({ filename: path, source, babel });
}

/** Destructuring and flattened array spreads consume the native iteration contract. */
function hasLocalPattern(
  program?: ReturnType<typeof internalParseModuleProgram>
) {
  let found = false;
  program?.traverse({
    "ArrayPattern|ObjectPattern"(path) {
      found = true;
      path.stop();
    },
    SpreadElement(path) {
      if (!path.parentPath.isArrayExpression()) return;
      found = true;
      path.stop();
    }
  });
  return found;
}

function mergeIntrinsicObservations(
  prepared: InternalPreparedExtractCalls | undefined,
  environment: Pick<
    InternalPreparedExtractCalls,
    "mathIntrinsics" | "arrayMapIntrinsics"
  >,
  dependencies: readonly string[]
): InternalPreparedExtractCalls {
  const base: InternalPreparedExtractCalls = prepared ?? {
    imports: {},
    localBindings: [],
    protectedFunctions: [],
    dependencies: [],
    fingerprint: ""
  };
  const combine = <
    T extends { intact: boolean; revision: number; fingerprint: string }
  >(
    previous: T | undefined,
    observed: T | undefined
  ): T | undefined =>
    observed
      ? {
          ...observed,
          intact: observed.intact && previous?.intact !== false,
          revision: observed.revision + (previous?.revision ?? 0),
          fingerprint: JSON.stringify([
            previous?.fingerprint ?? null,
            observed.fingerprint
          ])
        }
      : previous;
  const math = combine(base.mathIntrinsics, environment.mathIntrinsics);
  const mathIntrinsics = math
    ? {
        ...math,
        bindIntact: math.bindIntact && base.mathIntrinsics?.bindIntact !== false
      }
    : undefined;
  const array = combine(
    base.arrayMapIntrinsics,
    environment.arrayMapIntrinsics
  );
  const patternFlag = (key: "iterationIntact" | "prototypeAbsenceIntact") =>
    (base.arrayMapIntrinsics?.[key] ??
      base.arrayMapIntrinsics?.intact ??
      true) &&
    (environment.arrayMapIntrinsics?.[key] ??
      environment.arrayMapIntrinsics?.intact ??
      true);
  const prototypeKeys = (
    snapshot: InternalPreparedExtractCalls["arrayMapIntrinsics"]
  ): readonly string[] | null => {
    if (snapshot?.prototypeMutationKeys !== undefined)
      return snapshot.prototypeMutationKeys;
    return (snapshot?.prototypeAbsenceIntact ?? snapshot?.intact) !== false
      ? []
      : null;
  };
  const previousKeys = prototypeKeys(base.arrayMapIntrinsics);
  const observedKeys = prototypeKeys(environment.arrayMapIntrinsics);
  const arrayMapIntrinsics = array
    ? {
        ...array,
        iterationIntact: patternFlag("iterationIntact"),
        prototypeAbsenceIntact: patternFlag("prototypeAbsenceIntact"),
        prototypeMutationKeys:
          previousKeys === null || observedKeys === null
            ? null
            : [...new Set([...previousKeys, ...observedKeys])].sort()
      }
    : undefined;
  // Artifact names contain semantic authority only, never host paths or AST hashes.
  const semantic = [
    mathIntrinsics?.intact !== false,
    mathIntrinsics?.bindIntact !== false,
    arrayMapIntrinsics?.intact !== false,
    (arrayMapIntrinsics?.iterationIntact ?? arrayMapIntrinsics?.intact) !==
      false,
    (arrayMapIntrinsics?.prototypeAbsenceIntact ??
      arrayMapIntrinsics?.intact) !== false
  ];
  return {
    ...base,
    mathIntrinsics,
    arrayMapIntrinsics,
    dependencies: [...new Set([...base.dependencies, ...dependencies])].sort(),
    fingerprint:
      semantic.every(Boolean) &&
      (arrayMapIntrinsics === undefined ||
        arrayMapIntrinsics.prototypeMutationKeys?.length === 0)
        ? base.fingerprint
        : JSON.stringify([
            base.fingerprint,
            [
              "jsx-pattern-intrinsics",
              ...semantic,
              arrayMapIntrinsics?.prototypeMutationKeys
            ]
          ])
  };
}

export async function babelTransformSource(
  options: BabelTransformSourceOptions
): Promise<BabelTransformResult> {
  // Discover receipts after configured parsing, but before cache/worker
  // observation. Custom Babel configurations run inline without transform
  // caching, so cache validation still uses the caller's parser options.
  const runtimeParserOptions = { plugins: options.babel?.parserOpts?.plugins };
  if (options.babel?.consumerRuntimeSource)
    options = {
      ...options,
      babel: {
        ...options.babel,
        consumerRuntimeSource: retainRuntimeSourceDependencies(
          options.babel.consumerRuntimeSource,
          options.babel.staticCssEvalSourceProvider,
          options.babel.compilationCache?.parser,
          () => runtimeParserOptions.plugins
        )
      }
    };

  const cache = options.babel?.compilationCache;

  const transform = (
    input: BabelTransformSourceOptions,
    reuseSourceAst = false
  ) =>
    executeTransform(input, () =>
      transformSourceUncached(input, reuseSourceAst, runtimeParserOptions)
    );

  return cache
    ? cachedTransform(cache, options, transform)
    : transform(options);
}

/** @internal Worker entry; bundler callers must use babelTransformSource. */
export async function transformSourceUncached(
  {
    filename: path,
    root = process.cwd(),
    commonJsToEsm = false,
    source,
    loader = inferScriptLoader(path),
    babel = {},
    sourceMaps = false,
    inputSourceMap
  }: BabelTransformSourceOptions,
  reuseSourceAst = false,
  runtimeParserOptions?: {
    plugins: NonNullable<BabelOptions["parserOpts"]>["plugins"];
  }
): Promise<BabelTransformResult> {
  const {
    compilationCache,
    compilationContext: _compilationContext,
    privateRecipes: _privateRecipes,
    diagnostics,
    extractCalls: configuredExtractCalls,
    jsxCssProp = false,
    optimize,
    bundleSize,
    experimental,
    staticCssEvalProvider,
    staticCssEvalSourceProvider,
    consumerRuntimeSource,
    staticCssEvalProjectEngine,
    ...babelCoreOptions
  } = babel;

  const extractCalls = internalJsxCssPropExtractCalls(
    jsxCssProp,
    configuredExtractCalls
  );

  const projectEngine = staticCssEvalProjectEngine;
  const sourceLoads = new Map<
    string,
    ReturnType<StaticCssEvalSourceProvider["load"]>
  >();

  const sourceResolutions = new Map<
    string,
    ReturnType<StaticCssEvalSourceProvider["resolve"]>
  >();

  const sourceProvider: StaticCssEvalSourceProvider | undefined =
    staticCssEvalSourceProvider && {
      resolve: (importerId, specifier, options) => {
        const key = JSON.stringify([
          importerId,
          specifier,
          options?.kind ?? "import"
        ]);

        if (!sourceResolutions.has(key))
          sourceResolutions.set(
            key,
            measureCompilationPhase("source-resolve", async () =>
              staticCssEvalSourceProvider.resolve(
                importerId,
                specifier,
                options
              )
            )
          );

        return sourceResolutions.get(key)!;
      },

      load: (id) => {
        if (id === path)
          return {
            sourceText: source,
            sourceHash: createHash("sha256").update(source).digest("hex")
          };
        if (!sourceLoads.has(id))
          sourceLoads.set(
            id,
            measureCompilationPhase("source-load", async () =>
              staticCssEvalSourceProvider.load(id)
            )
          );

        return sourceLoads.get(id)!;
      }
    };

  const prepassSourceProvider =
    projectEngine && sourceProvider
      ? projectEngine.getBabelStaticEvalProvider(path, sourceProvider)
      : sourceProvider;

  let staticCssEvalPrepass:
    Awaited<ReturnType<typeof createStaticCssEvalPrepass>> | undefined;

  const observedStaticCssEvalMetadata = createEmptyStaticCssEvalMetadata();
  const extractCallsDependencies = new Set<string>();
  const options: PluginOptions = {
    ...(commonJsToEsm ? { stageCommonJsRuntimeRequests: true } : {}),
    stageEsmGeneratorImports: true,
    result: ["", ""],
    diagnostics,
    jsxCssProp,
    experimental,
    bundleSize,
    ...(extractCalls !== undefined ? { extractCalls } : {}),
    ...(optimize ? { optimize } : {})
  };

  let result: BabelFileResult;
  let commonJsTransformed = false;
  let stagedWithGenerator = false;
  let observedGeneratorOverride = false;
  const optionalCommonJsSites = (metadata: unknown) =>
    (metadata as Pick<MinchoBabelFileMetadata, "minchoOptionalCommonJsSites">)
      ?.minchoOptionalCommonJsSites;
  let preparedProgram:
    ReturnType<typeof internalParseModuleProgram> | undefined;
  let preparedWithBabel = false;
  let configuredAst: t.File | undefined;
  let preparedSyntax: t.Program | undefined;
  const importExportSurface = (program: t.Program): t.Statement[] => {
    const surface: t.Statement[] = [];
    for (const statement of program.body) {
      // Whole type declarations have no runtime edge. Unlike an erased
      // inline TypeScript re-export, an inline import can retain side effects.
      if (
        t.isImportDeclaration(statement) ||
        t.isTSImportEqualsDeclaration(statement)
      ) {
        if (statement.importKind !== "type") surface.push(statement);
        continue;
      }

      if (t.isExportAllDeclaration(statement)) {
        if (statement.exportKind !== "type") surface.push(statement);
        continue;
      }

      if (t.isExportNamedDeclaration(statement)) {
        if (statement.exportKind === "type") continue;
        if (statement.source != null) {
          // This loader installs the TS transform in the actual Babel pass.
          // A syntax-only parser option is not proof of specifier erasure.
          if (
            (loader === "ts" || loader === "tsx") &&
            statement.specifiers.length > 0
          ) {
            const specifiers = statement.specifiers.filter(
              (specifier) =>
                !t.isExportSpecifier(specifier) ||
                specifier.exportKind !== "type"
            );
            if (!specifiers.length) continue;
            if (specifiers.length !== statement.specifiers.length) {
              surface.push({ ...statement, specifiers });
              continue;
            }
          }
          surface.push(statement);
          continue;
        }
        // A local value export can select a same-file extractCalls binding
        // without changing any imported module or executable initializer.
        if (
          extractCalls !== undefined &&
          statement.specifiers.some(
            (specifier) =>
              t.isExportSpecifier(specifier) && specifier.exportKind !== "type"
          )
        )
          surface.push(statement);
        continue;
      }

      if (t.isTSExportAssignment(statement)) surface.push(statement);
    }
    return surface;
  };
  const scopedProgram = (program: t.Program) => {
    // Babel pre hooks can mutate binding declarations on the AST without
    // updating the live scope. Read a fresh, separate scope for this check.
    let snapshot: t.Program;
    try {
      // Local extraction identities include the parser's exact source ranges,
      // which Babel's cloneNode does not keep. Copy the Program only, not the
      // parser's File tokens or its live scope.
      snapshot = structuredClone(program);
    } catch {
      // Custom AST metadata can forbid a structural clone. Keep Babel's
      // scope-only fallback; unproved source locations will still deopt.
      snapshot = t.cloneNode(program);
    }
    let current: NodePath<t.Program> | undefined;
    traverse(t.file(snapshot), {
      Program(path) {
        current = path;
        path.stop();
      }
    });
    return current;
  };
  const requireSurface = (program: NodePath<t.Program>) => {
    const specifiers: string[] = [];
    program.traverse({
      CallExpression(call) {
        const specifier = internalGetStaticCssEvalLiteralRequireImportPath(
          call.node,
          call.scope
        );
        if (specifier?.startsWith("./") || specifier?.startsWith("../"))
          specifiers.push(specifier);
      }
    });
    return specifiers;
  };
  const sameSpecifiers = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  let preparedRequires: string[] | undefined;
  let refreshedConfiguration:
    | {
        program: t.Program;
        specifiers: string[];
        prepass:
          Awaited<ReturnType<typeof createStaticCssEvalPrepass>> | undefined;
        extraction: InternalPreparedExtractCalls | undefined;
      }
    | undefined;
  const canRefreshConfiguredValues = Boolean(
    jsxCssProp && prepassSourceProvider && !staticCssEvalProvider
  );
  // Registered factories use their own graph, regardless of how JSX values
  // are supplied.
  const canPrepareConfiguredChanges =
    canRefreshConfiguredValues ||
    (extractCalls !== undefined && prepassSourceProvider !== undefined);
  let hasConfiguredChanges = Boolean(
    babelCoreOptions.plugins?.length ||
    babelCoreOptions.presets?.length ||
    babelCoreOptions.configFile ||
    babelCoreOptions.babelrc === true ||
    babelCoreOptions.extends
  );
  const sameNodes = (left: readonly t.Node[], right: readonly t.Node[]) =>
    left.length === right.length &&
    left.every((node, index) => t.isNodesEquivalent(node, right[index]!));
  let parserPlugins = babelCoreOptions.parserOpts?.plugins;

  const prepareCalls = (
    registrations: NonNullable<typeof extractCalls>,
    program: NodePath<t.Program> | undefined
  ) =>
    prepareExtractCalls(
      {
        extractCalls: registrations,
        root,
        filename: path,
        source,
        program,
        parserCache: compilationCache?.parser,
        parserPlugins,
        jsx: loader === "jsx" || loader === "tsx"
      },
      prepassSourceProvider,
      consumerRuntimeSource
    );

  const hasTypeScriptCommonJsSyntax = (program: t.Program) =>
    program.body.some(
      (node) =>
        t.isTSImportEqualsDeclaration(node) || t.isTSExportAssignment(node)
    );
  type ConfiguredPreFile = NonNullable<
    Parameters<typeof internalNormalizeTypeScriptCommonJs>[1]
  > & { path: NodePath<t.Program> };

  async function refreshConfiguredInputs(file: ConfiguredPreFile) {
    const program = file.path;
    if (
      !configuredAst ||
      !preparedSyntax ||
      !preparedRequires ||
      !prepassSourceProvider
    )
      return;

    const importExportsChanged = !sameNodes(
      importExportSurface(preparedSyntax),
      importExportSurface(program.node)
    );
    // Observe exactly the syntax in the host's final pre hook, without
    // invoking the caller's Babel pipeline a second time.
    const current = scopedProgram(program.node);
    if (!current) return;
    const specifiers = requireSurface(current);
    if (!importExportsChanged && sameSpecifiers(preparedRequires, specifiers))
      return;
    // The first Program visitor applies the same inference to the live AST.
    // Verify the fully inferred snapshot, not a pre-inference sourceType.
    if (babelCoreOptions.sourceType === undefined)
      applyInferredCommonJsSourceType(current);
    // Preserve the authored snapshot for the final freshness check. Prepare
    // using the same TypeScript CommonJS surface as the initial analysis.
    let analysis = current;
    if (hasTypeScriptCommonJsSyntax(current.node)) {
      const normalized = scopedProgram(current.node);
      if (!normalized) return;
      internalNormalizeTypeScriptCommonJs(normalized, file);
      analysis = normalized;
    }
    const prepass = canRefreshConfiguredValues
      ? await measureCompilationPhase("static-prepass", () =>
          createStaticCssEvalPrepass(
            path,
            prepassSourceProvider,
            compilationCache?.parser,
            analysis,
            "values",
            parserPlugins,
            undefined,
            hasLocalPattern(analysis) ? { consumerRuntimeSource } : undefined
          )
        )
      : undefined;
    let extraction: InternalPreparedExtractCalls | undefined;
    if (extractCalls !== undefined) {
      try {
        extraction = await prepareCalls(extractCalls, analysis);
      } catch (error) {
        if (!(error instanceof InternalExtractCallsError)) throw error;
        for (const file of error.dependencies)
          extractCallsDependencies.add(file);
      }
    }

    for (const file of staticCssEvalPrepass?.result.dependencyFiles ?? [])
      extractCallsDependencies.add(file);
    for (const file of prepass?.result.dependencyFiles ?? [])
      extractCallsDependencies.add(file);
    for (const file of extraction?.dependencies ?? [])
      extractCallsDependencies.add(file);

    // Neither result is usable until the Program visitor confirms this is
    // still the exact post-hook tree that both analyses observed.
    refreshedConfiguration = {
      program: current.node,
      specifiers,
      prepass,
      extraction
    };
  }

  try {
    const collectRuntimeCandidates =
      optimize?.runtimeCodegen === true ||
      optimize?.staticRecipes !== false ||
      optimize?.styledComponents !== false;
    let transformOptions: TransformOptions = {
      sourceType: "unambiguous",
      ...babelCoreOptions,
      filename: path,
      plugins: [
        ...(babelCoreOptions.sourceType === undefined
          ? [inferCommonJsSourceType()]
          : []),
        ...(loader === "jsx" || loader === "tsx" ? [jsxSyntaxPluginPath] : []),
        ...(Array.isArray(babelCoreOptions.plugins)
          ? babelCoreOptions.plugins
          : []),
        {
          visitor: {
            Program(program: NodePath<t.Program>) {
              if (!preparedSyntax) return;

              // A prepared fold can read local syntax as well as imported
              // bindings. Compare the executed Program, not only its edges.
              if (
                options.preparedPureFunctions &&
                (!sameNodes(preparedSyntax.body, program.node.body) ||
                  !sameNodes(
                    preparedSyntax.directives,
                    program.node.directives
                  ))
              )
                options.preparedPureFunctions = {
                  replacements: [],
                  dependencies: options.preparedPureFunctions.dependencies,
                  diagnostics: []
                };

              if (!configuredAst) return;
              const importExportsChanged = !sameNodes(
                importExportSurface(preparedSyntax),
                importExportSurface(program.node)
              );
              const current = preparedRequires
                ? scopedProgram(program.node)
                : undefined;
              const currentRequires = current ? requireSurface(current) : [];
              const requiresChanged =
                preparedRequires !== undefined &&
                !sameSpecifiers(preparedRequires, currentRequires);
              if (!importExportsChanged && !requiresChanged) return;
              const refreshed =
                refreshedConfiguration &&
                sameSpecifiers(
                  refreshedConfiguration.specifiers,
                  currentRequires
                ) &&
                t.isNodesEquivalent(
                  refreshedConfiguration.program,
                  program.node
                )
                  ? refreshedConfiguration
                  : undefined;
              if (!staticCssEvalProvider) {
                if (refreshed?.prepass) {
                  staticCssEvalPrepass = refreshed.prepass;
                  options.staticCssEvalProvider =
                    createObservingStaticCssEvalProvider(
                      refreshed.prepass.provider,
                      observedStaticCssEvalMetadata
                    );
                  observedStaticCssEvalMetadata.diagnostics.push(
                    ...refreshed.prepass.diagnostics
                  );
                } else delete options.staticCssEvalProvider;
              }
              const veto = {
                intact: false,
                revision: 0,
                fingerprint: "configured-import-export-changed"
              };
              options.preparedExtractCalls = mergeIntrinsicObservations(
                refreshed?.extraction,
                {
                  arrayMapIntrinsics: { ...veto, prototypeMutationKeys: null },
                  mathIntrinsics: { ...veto, bindIntact: false }
                },
                options.preparedExtractCalls?.dependencies ?? []
              );
            }
          }
        },
        minchoStyledComponentPlugin(),
        [minchoBabelPlugin(), options],
        {
          parserOverride(
            _source: string,
            options: NonNullable<TransformOptions["parserOpts"]>
          ) {
            parserPlugins = options.plugins;
            if (runtimeParserOptions)
              runtimeParserOptions.plugins = parserPlugins;
            return undefined;
          }
        }
      ],
      presets: [
        ...(Array.isArray(babelCoreOptions.presets)
          ? babelCoreOptions.presets
          : []),
        ...(loader === "ts" || loader === "tsx"
          ? [
              [
                typescriptPresetPath,
                { allExtensions: true, isTSX: loader === "tsx" }
              ] satisfies NonNullable<TransformOptions["presets"]>[number]
            ]
          : [])
      ],
      sourceMaps,
      ast: collectRuntimeCandidates || commonJsToEsm,
      ...(inputSourceMap !== undefined ? { inputSourceMap } : {})
    };

    const parseConfiguredProgram = async () => {
      let configuredOptions = transformOptions;
      // Observe the final parser options after every preset/plugin has run
      // manipulateOptions, without overriding parsing or running visitors.
      const ast = await parseAsync(source, {
        ...transformOptions,
        plugins: [
          ...transformOptions.plugins!,
          {
            manipulateOptions(options: TransformOptions) {
              configuredOptions = options;
            }
          }
        ]
      });

      if (!ast) return false;

      configuredAst = ast;
      observedGeneratorOverride =
        internalHasConfiguredGeneratorOverride(configuredOptions);

      // Babel has already expanded the first-pass plugin list for this file.
      // Use its real pre hooks, including from auto-discovered configuration,
      // without reloading the configuration or executing any author hooks.
      if (canPrepareConfiguredChanges && !hasConfiguredChanges)
        hasConfiguredChanges =
          configuredOptions.plugins?.some(
            (plugin) =>
              typeof plugin === "object" &&
              plugin !== null &&
              "pre" in plugin &&
              typeof plugin.pre === "function"
          ) ?? false;

      let analysisAst = ast;
      if (hasTypeScriptCommonJsSyntax(ast.program)) {
        try {
          // Keep source offsets for analysis. Parser tokens can hold functions
          // and only the original File needs them for Babel's hooks and emit.
          const { tokens: _tokens, ...preparationFile } = ast;
          analysisAst = structuredClone(preparationFile);
        } catch {
          analysisAst = ast;
        }
      }

      traverse(analysisAst, {
        Program(program) {
          if (analysisAst !== ast)
            internalNormalizeTypeScriptCommonJs(program, {
              opts: configuredOptions,
              ast: analysisAst
            });
          preparedProgram = program;
          preparedWithBabel = true;
          program.stop();
        }
      });

      return true;
    };

    // Imported static data may need preset syntax even when the owner parses
    // without it. Prepare the configured AST once and reuse its parser options
    // across extraction and value analysis before running transform visitors.
    if (
      prepassSourceProvider &&
      (jsxCssProp || (extractCalls !== undefined && consumerRuntimeSource))
    )
      await parseConfiguredProgram();

    if (
      !preparedProgram &&
      optimize?.pureFunctions !== false &&
      /@(?:mincho-js|vanilla-extract)\/|\bcss\b/.test(source)
    ) {
      try {
        preparedProgram = internalParseModuleProgram(
          path,
          source,
          loader === "jsx" || loader === "tsx",
          compilationCache?.parser,
          parserPlugins
        );
      } catch {
        // The optional pre-pass must defer syntax errors to configured Babel.
        preparedProgram = undefined;
      }
    }

    if (extractCalls !== undefined) {
      if (!preparedProgram) {
        try {
          preparedProgram = internalParseModuleProgram(
            path,
            source,
            loader === "jsx" || loader === "tsx",
            compilationCache?.parser,
            parserPlugins
          );
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;

          if (!(await parseConfiguredProgram())) throw error;
        }
      }

      try {
        options.preparedExtractCalls = await prepareCalls(
          extractCalls,
          preparedProgram
        );
      } catch (error) {
        // A dependency can need configured syntax even when the owner does not.
        if (
          preparedWithBabel ||
          !(error instanceof InternalExtractCallsError) ||
          !(error.cause instanceof SyntaxError) ||
          !(await parseConfiguredProgram())
        )
          throw error;

        options.preparedExtractCalls = await prepareCalls(
          extractCalls,
          preparedProgram
        );
      }

      for (const file of options.preparedExtractCalls.dependencies)
        extractCallsDependencies.add(file);
    }

    staticCssEvalPrepass =
      jsxCssProp && prepassSourceProvider
        ? await measureCompilationPhase("static-prepass", () =>
            createStaticCssEvalPrepass(
              path,
              prepassSourceProvider,
              compilationCache?.parser,
              preparedProgram,
              "values",
              parserPlugins,
              undefined,
              hasLocalPattern(preparedProgram)
                ? { consumerRuntimeSource }
                : undefined
            )
          )
        : undefined;

    if (staticCssEvalPrepass?.intrinsicEnvironment) {
      options.preparedExtractCalls = mergeIntrinsicObservations(
        options.preparedExtractCalls,
        staticCssEvalPrepass.intrinsicEnvironment,
        staticCssEvalPrepass.result.dependencyFiles
      );
      for (const file of options.preparedExtractCalls.dependencies)
        extractCallsDependencies.add(file);
    }

    observedStaticCssEvalMetadata.diagnostics.push(
      ...(staticCssEvalPrepass?.diagnostics ?? [])
    );

    if (preparedProgram && optimize?.pureFunctions !== false) {
      options.preparedPureFunctions = await measureCompilationPhase(
        "pure-functions",
        () =>
          driveModuleGraph(
            internalAnalyzePureFunctions({
              nativeArrayIteration:
                options.preparedExtractCalls?.arrayMapIntrinsics
                  ?.iterationIntact ??
                options.preparedExtractCalls?.arrayMapIntrinsics?.intact,
              program: preparedProgram,
              filename: path,
              source,
              jsxCssProp: Boolean(jsxCssProp),
              parserCache: compilationCache?.parser,
              parserPlugins
            }),
            prepassSourceProvider,
            extractCallsDependencies
          )
      );

      for (const file of options.preparedPureFunctions.dependencies)
        extractCallsDependencies.add(file);

      recordCompilationDiagnostic("pure-functions-result", {
        folded: options.preparedPureFunctions.replacements.length,
        deopt: options.preparedPureFunctions.diagnostics.filter(
          (item) => item.result === "deopt"
        ).length
      });
    }

    const preparedProvider =
      staticCssEvalProvider ?? staticCssEvalPrepass?.provider;

    if (preparedProvider) {
      options.staticCssEvalProvider = createObservingStaticCssEvalProvider(
        preparedProvider,
        observedStaticCssEvalMetadata
      );
    }

    const rawSyntax = configuredAst?.program ?? preparedProgram?.node;
    // transformFromAst clones its input by default; if the caller disables
    // that behavior, keep an independent reference for the freshness check.
    preparedSyntax =
      rawSyntax && transformOptions.cloneInputAst === false
        ? t.cloneNode(rawSyntax)
        : rawSyntax;

    let resolvedAuthorConfig:
      Awaited<ReturnType<typeof loadPartialConfigAsync>> | undefined;
    if (
      canPrepareConfiguredChanges &&
      hasConfiguredChanges &&
      configuredAst &&
      preparedSyntax
    ) {
      const prepared = scopedProgram(preparedSyntax);
      if (prepared) {
        preparedRequires = requireSurface(prepared);
        // Resolve the final pass once. Babel's partial ConfigItems retain
        // file and explicit preset order while disabling further discovery.
        // With all items in one list, reverse preset expansion places this
        // hook after the effective direct and preset-provided pre hooks.
        const configured = await loadPartialConfigAsync(transformOptions);
        resolvedAuthorConfig = configured;
        if (configured) {
          transformOptions = {
            ...configured.options,
            presets: [
              () => ({
                plugins: [
                  {
                    pre(file: ConfiguredPreFile) {
                      return refreshConfiguredInputs(file);
                    },
                    visitor: {}
                  }
                ]
              }),
              ...(configured.options.presets ?? [])
            ]
          };
        }
      }
    }

    if (
      commonJsToEsm &&
      (hasConfiguredChanges || observedGeneratorOverride || !configuredAst)
    ) {
      const configured =
        resolvedAuthorConfig ??
        (await loadPartialConfigAsync(transformOptions));
      if (
        configured &&
        (hasConfiguredChanges ||
          observedGeneratorOverride ||
          configured.hasFilesystemConfig() ||
          // Programmatic env/overrides can add effective items without
          // supplying a top-level plugin or enabling a config file.
          (configured.options.plugins?.length ?? 0) >
            (transformOptions.plugins?.length ?? 0) ||
          (configured.options.presets?.length ?? 0) >
            (transformOptions.presets?.length ?? 0))
      ) {
        // Create only our own final pass separately: the author's resolved
        // presets retain their pass layout, and this post runs after all of
        // their visitors and posts. Only record the effective generator here;
        // its output and map are authoritative, including any new readers.
        const tailOptions: TransformOptions & { passPerPreset: true } = {
          babelrc: false,
          configFile: false,
          passPerPreset: true,
          presets: [
            () => ({
              plugins: [
                {
                  post(file: { metadata: unknown; opts: TransformOptions }) {
                    const sites = optionalCommonJsSites(file.metadata);
                    stagedWithGenerator =
                      !!sites?.length &&
                      internalHasConfiguredGeneratorOverride(file.opts);
                  },
                  visitor: {}
                }
              ]
            })
          ]
        };
        const tail = await loadPartialConfigAsync(tailOptions);
        const preset = tail?.options.presets?.[0];
        if (preset) {
          const authored = resolvedAuthorConfig
            ? transformOptions
            : configured.options;
          transformOptions = {
            ...authored,
            presets: [...(authored.presets ?? []), preset]
          };
        }
      }
    }

    const transformed = await measureCompilationPhase("babel", () =>
      preparedProgram &&
      (preparedWithBabel ||
        (reuseSourceAst &&
          !babelCoreOptions.parserOpts &&
          (!babelCoreOptions.sourceType ||
            babelCoreOptions.sourceType === "unambiguous")))
        ? transformFromAstAsync(
            configuredAst ?? (preparedProgram.parent as t.File),
            source,
            transformOptions
          )
        : transformAsync(source, transformOptions)
    );
    if (!transformed || transformed.code == null) {
      throw new Error(`Failed to transform ${path}`);
    }

    result = transformed;

    if (commonJsToEsm) {
      const optionalSites = optionalCommonJsSites(transformed.metadata);
      // This AST still uses author-input coordinates. Babel exposes the
      // effective upstream map (including a consumed inline comment) through
      // its generator options, rather than the first-pass output map.
      const upstreamInputMap = (
        transformed as BabelFileResult & {
          options?: {
            generatorOpts?: {
              inputSourceMap?: TransformOptions["inputSourceMap"];
            };
          };
        }
      ).options?.generatorOpts?.inputSourceMap;
      const normalized = await transformCommonJsToEsm({
        filename: path,
        source: transformed.code,
        cache: compilationCache,
        collectRuntimeCandidates,
        ...(transformed.ast && optionalSites?.length
          ? {
              stagedSites: {
                ast: transformed.ast,
                originalSource: source,
                originalMap:
                  upstreamInputMap ?? transformOptions.inputSourceMap,
                sites: optionalSites,
                runtimeSource: consumerRuntimeSource,
                reconcileGeneratedCode: stagedWithGenerator
              }
            }
          : {}),
        provider: prepassSourceProvider,
        dependencies: extractCallsDependencies,
        sidecar: options.result[0],
        sourceMaps,
        parserPlugins,
        inputSourceMap: transformed.map ?? undefined
      });

      if (normalized) {
        result = { ...normalized, metadata: transformed.metadata };
        commonJsTransformed = true;
      }
    }

    const esmSites = (
      transformed.metadata as MinchoBabelFileMetadata | undefined
    )?.minchoOptionalEsmImports;
    if (!commonJsTransformed && esmSites?.sites.length) {
      const cleaned = await reconcileEmittedEsmImports(
        transformed.code,
        path,
        parserPlugins,
        esmSites
      );
      if (cleaned !== transformed.code) result = { ...result, code: cleaned };
    }
  } catch (error) {
    if (error instanceof InternalExtractCallsError)
      for (const file of error.dependencies) extractCallsDependencies.add(file);

    const staticCssEval = createStaticCssEvalTransformResult(
      staticCssEvalPrepass?.result,
      observedStaticCssEvalMetadata,
      [...extractCallsDependencies]
    );

    projectEngine?.refreshFile({
      fileId: path,
      ...(staticCssEval ? { result: staticCssEval } : {}),
      preserveProviderRecords: true
    });

    throw new BabelTransformError(path, error, staticCssEval);
  }

  const staticCssEvalMetadata = mergeStaticCssEvalMetadata(
    getStaticCssEvalMetadata(result.metadata),
    observedStaticCssEvalMetadata
  );

  const staticCssEval = createStaticCssEvalTransformResult(
    staticCssEvalPrepass?.result,
    staticCssEvalMetadata,
    [...extractCallsDependencies]
  );

  projectEngine?.refreshFile({
    fileId: path,
    ...(staticCssEval ? { result: staticCssEval } : {}),
    generatedArtifacts: createStaticCssEvalGeneratedArtifacts(
      path,
      options.result
    ),
    preserveProviderRecords: true
  });

  const compilation = (
    result.metadata as { minchoCompilation?: MinchoCompilationMetadata }
  )?.minchoCompilation;

  if (compilation) recordCompilationDiagnostic("extraction", compilation);

  const classStringBudget = (
    result.metadata as
      | { minchoClassStringBudget?: { units: number; entries: number } }
      | undefined
  )?.minchoClassStringBudget;

  for (const [key, phase] of [
    ["minchoCssBooleanGates", "css-boolean-gates-result"],
    ["minchoClassStrategies", "compiler-class-strategies-result"]
  ] as const) {
    const detail = (result.metadata as Record<string, unknown> | undefined)?.[
      key
    ];

    if (detail) recordCompilationDiagnostic(phase, detail);
  }

  if (staticCssEval)
    recordCompilationDiagnostic("static-evaluation", {
      dependencies: staticCssEval.dependencies,
      diagnostics: staticCssEval.diagnostics
    });

  return {
    ...(parserPlugins ? { parserPlugins: [...parserPlugins] } : {}),
    ...(result.ast?.type === "File"
      ? { runtimeCandidates: internalCollectRuntimeCandidates(result.ast) }
      : {}),
    ...(compilation ? { diagnostics: compilation } : {}),
    ...(classStringBudget ? { classStringBudget } : {}),
    result: options.result,
    semanticDemands: options.preparedPureFunctions?.exportDemands,
    code: result.code!,
    ...(sourceMaps ? { map: result.map } : {}),
    jsxCssPropTransformed: options.jsxCssPropTransformed === true,
    ...(commonJsTransformed ? { commonJsTransformed: true } : {}),
    ...(staticCssEval ? { staticCssEval } : {})
  };
}

function inferScriptLoader(
  filename: string
): NonNullable<BabelTransformSourceOptions["loader"]> {
  switch (extname(filename).toLowerCase()) {
    case ".jsx":
      return "jsx";
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    default:
      return "js";
  }
}

function createStaticCssEvalGeneratedArtifacts(
  ownerFile: string,
  [artifactFile, source]: readonly [string, string]
): StaticEvalProjectEngineGeneratedArtifact[] {
  return artifactFile && source
    ? [{ ownerFile, artifactFile, source, kind: "sidecar-css-ts" }]
    : [];
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, expect, it } = import.meta.vitest;

  let fixtureIndex = 0;
  const fixtureRoots: string[] = [];

  async function createBabelFixture(source: string, label: string) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;

    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `mincho-babel-css-prop-${fixtureIndex}-${label}`
    );

    const fixturePath = path.join(fixtureRoot, `${label}.tsx`);

    fixtureRoots.push(fixtureRoot);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(fixturePath, source, "utf8");

    return fixturePath;
  }

  async function createBabelFixtureFiles<
    FixtureFiles extends Record<string, string>
  >(files: FixtureFiles, label: string) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;

    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `mincho-babel-css-prop-${fixtureIndex}-${label}`
    );

    const filePaths = {} as Record<keyof FixtureFiles, string>;

    fixtureRoots.push(fixtureRoot);

    for (const fileName of Object.keys(files) as Array<keyof FixtureFiles>) {
      const fixturePath = path.join(fixtureRoot, String(fileName));
      filePaths[fileName] = fixturePath;
      await fs.mkdir(path.dirname(fixturePath), { recursive: true });
      await fs.writeFile(fixturePath, files[fileName], "utf8");
    }

    return { fixtureRoot, filePaths };
  }

  afterEach(async () => {
    const fs = await import("node:fs/promises");

    await Promise.all(
      fixtureRoots
        .splice(0)
        .map((fixtureRoot) =>
          fs.rm(fixtureRoot, { recursive: true, force: true })
        )
    );
  });

  function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function createTestSourceIdentity(
    sourceText: string
  ): StaticCssEvalSourceIdentity {
    const colorTag = sourceText.includes('color: "blue"')
      ? "blue"
      : sourceText.includes('color: "red"')
        ? "red"
        : "source";

    return { sourceHash: `test:${sourceText.length}:${colorTag}` };
  }

  function createFileBackedStaticCssEvalSourceProvider(options: {
    resolutions: Record<string, string>;
    resolverKind?: StaticCssEvalResolverKind;
  }): StaticCssEvalSourceProvider {
    return {
      resolve(importerId, importPath) {
        const resolvedFile =
          options.resolutions[`${importerId}\0${importPath}`];

        if (!resolvedFile) {
          return null;
        }

        return {
          resolvedFile,
          canonicalModuleId: `test:${resolvedFile}`,
          normalizedPathKey: resolvedFile,
          resolverKind: options.resolverKind ?? "test"
        };
      },

      async load(id) {
        const fs = await import("node:fs/promises");

        try {
          const sourceText = await fs.readFile(id, "utf8");

          return {
            sourceText,
            sourceIdentity: createTestSourceIdentity(sourceText),
            resolverKind: options.resolverKind ?? "test"
          };
        } catch {
          return null;
        }
      }
    };
  }

  it.each([
    [false, "const[size]=[4];"],
    [true, "const[size]=[4];"],
    [false, "const values=[...[4]];const size=values[0];"],
    [true, "const values=[...[4]];const size=values[0];"]
  ] as const)(
    "checks native owner iteration before imported pure helper folding: %s %s",
    async (mutated: boolean, declaration: string) => {
      const source = `import {getStyles} from "./theme.ts";export const Box=()=>{${declaration}return <div css={getStyles(size)}/>};`;
      const { filePaths: files } = await createBabelFixtureFiles(
        {
          "owner.tsx": source,
          "theme.ts": "export function getStyles(size){return {padding:size}}",
          "jsx-runtime.js": mutated
            ? "Array.prototype[Symbol.iterator]=function*(){yield 9};"
            : "export const jsx=()=>null;"
        },
        `pure-iteration-${mutated}`
      );
      const run = () =>
        babelTransform(files["owner.tsx"], {
          jsxCssProp: true,
          staticCssEvalSourceProvider:
            createFileBackedStaticCssEvalSourceProvider({
              resolutions: {
                [`${files["owner.tsx"]}\0./theme.ts`]: files["theme.ts"],
                [`${files["owner.tsx"]}\0./jsx-runtime.js`]:
                  files["jsx-runtime.js"]
              }
            }),
          consumerRuntimeSource: async (id, request) => {
            if (request?.purpose === "intrinsic-owner")
              return {
                source: 'import "./jsx-runtime.js";' + source,
                sourceHash: `native-${mutated}`,
                version: "native-v1",
                watchFiles: [files["owner.tsx"]]
              };
            if (
              id === files["jsx-runtime.js"] &&
              request?.purpose === "intrinsic-runtime"
            ) {
              const fs = await import("node:fs/promises");
              return {
                source: await fs.readFile(id, "utf8"),
                sourceHash: `runtime-${mutated}`,
                version: "runtime-v1",
                watchFiles: [id]
              };
            }
            return undefined;
          }
        });
      if (mutated)
        await expect(run()).rejects.toThrow(/Cannot|Configured|Unsupported/);
      else expect((await run()).result[1]).toMatch(/padding:\s*4/);
    }
  );

  type StaticCssEvalProvider = NonNullable<
    PluginOptions["staticCssEvalProvider"]
  >;

  type StaticCssEvalProviderResult = ReturnType<
    StaticCssEvalProvider["getResolvedCssValue"]
  >;

  type StaticCssEvalProviderQuery = Parameters<
    StaticCssEvalProvider["getResolvedCssValue"]
  >[0];

  type StaticCssEvalValue = Extract<
    StaticCssEvalProviderResult,
    { kind: "resolved" }
  >["value"];

  function createResolvedStaticCssEvalProvider(
    values: Record<string, StaticCssEvalValue>
  ): StaticCssEvalProvider {
    return {
      getResolvedCssValue(query): StaticCssEvalProviderResult {
        const key = query.memberPath?.length
          ? `${query.bindingName}.${query.memberPath.join(".")}`
          : (query.bindingName ?? "");

        const value = values[key];

        if (value === undefined) {
          return { kind: "not-candidate" };
        }

        return {
          kind: "resolved",
          value,
          dependencies: ["/provider/styles.ts"]
        };
      }
    };
  }

  function createUnsupportedReexportStaticCssEvalProvider(): StaticCssEvalProvider {
    return {
      getResolvedCssValue(query): StaticCssEvalProviderResult {
        return {
          kind: "error",
          diagnostic: {
            code: "unsupported-source",
            message:
              'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax',
            reason: "reexport-or-barrel",
            owner: {
              file: query.importerId,
              start: query.expressionStart,
              end: query.expressionEnd
            },
            dependency: { file: "/provider/barrel.ts" },
            importPath: "./barrel",
            exportName: "button",
            memberPath: query.memberPath ?? [],
            importChain: [query.importerId, "/provider/barrel.ts#button"]
          },
          dependencies: ["/provider/barrel.ts"]
        };
      }
    };
  }

  interface FakeStaticCssEvalSourceProviderCalls {
    resolved: Array<{ importerId: string; importPath: string }>;
    loaded: string[];
  }

  function createFakeStaticCssEvalSourceProvider(options: {
    sources: Record<string, string>;
    resolutions: Record<string, string>;
  }): {
    provider: StaticCssEvalSourceProvider;
    calls: FakeStaticCssEvalSourceProviderCalls;
  } {
    const calls: FakeStaticCssEvalSourceProviderCalls = {
      resolved: [],
      loaded: []
    };

    return {
      calls,
      provider: {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });

          const resolvedId =
            options.resolutions[`${importerId}\0${importPath}`];

          return resolvedId ? { id: resolvedId } : null;
        },

        load(id) {
          calls.loaded.push(id);

          if (!Object.prototype.hasOwnProperty.call(options.sources, id)) {
            return null;
          }

          return { source: options.sources[id] ?? "" };
        }
      }
    };
  }

  describe("babelTransform", () => {
    it.each([false, true])(
      "observes side-effect-only JSX intrinsic mutations without registered calls (explicit: %s)",
      async (explicit: boolean) => {
        const filename = "/jsx-intrinsics/entry.tsx";
        const dependency = "/jsx-intrinsics/reset.ts";
        const source = `import './reset'; const [value=4]=[4];
          export const App=()=> <div css={{color:'red'}}>{value}</div>;`;
        for (const changed of [false, true]) {
          const { provider, calls } = createFakeStaticCssEvalSourceProvider({
            sources: {
              [dependency]: changed
                ? "Array.prototype[Symbol.iterator]=function*(){yield undefined};"
                : "export const marker=1;"
            },
            resolutions: { [`${filename}\0./reset`]: dependency }
          });
          let observed: InternalPreparedExtractCalls | undefined;
          const result = await babelTransformSource({
            filename,
            source,
            babel: {
              jsxCssProp: true,
              ...(explicit ? { extractCalls: {} } : {}),
              staticCssEvalSourceProvider: provider,
              configFile: false,
              babelrc: false,
              plugins: [
                () => ({
                  visitor: {
                    Program: {
                      exit(path: import("@babel/core").NodePath<t.Program>) {
                        observed = (
                          path.scope as typeof path.scope & {
                            minchoData?: {
                              extractCalls?: InternalPreparedExtractCalls;
                            };
                          }
                        ).minchoData?.extractCalls;
                      }
                    }
                  }
                })
              ]
            }
          });
          expect(result.result[1]).toMatch(/color: ["']red["']/);
          expect(result.staticCssEval?.dependencyFiles).toContain(dependency);
          expect(calls.loaded).toContain(dependency);
          expect(observed?.arrayMapIntrinsics?.intact).toBe(!changed);
          expect(observed?.imports).toEqual({});
          expect(observed?.localBindings).toEqual([]);
        }
      }
    );

    it("merges JSX intrinsic observations without granting call registrations", () => {
      const environment = {
        mathIntrinsics: {
          intact: true,
          bindIntact: true,
          revision: 1,
          fingerprint: "host-a"
        },
        arrayMapIntrinsics: { intact: true, revision: 1, fingerprint: "host-a" }
      };
      const normal = mergeIntrinsicObservations(undefined, environment, [
        "/dep.ts"
      ]);
      expect(normal.imports).toEqual({});
      expect(normal.localBindings).toEqual([]);
      expect(normal.protectedFunctions).toEqual([]);
      expect(normal.dependencies).toEqual(["/dep.ts"]);
      expect(normal.fingerprint).toBe("");
      const mutation = mergeIntrinsicObservations(
        normal,
        {
          ...environment,
          arrayMapIntrinsics: {
            ...environment.arrayMapIntrinsics,
            intact: false,
            fingerprint: "host-b"
          }
        },
        ["/runtime.ts"]
      );
      const repeated = mergeIntrinsicObservations(mutation, environment, []);
      expect(repeated.arrayMapIntrinsics?.intact).toBe(false);
      expect(repeated.dependencies).toEqual(["/dep.ts", "/runtime.ts"]);
      expect(repeated.fingerprint).not.toContain("host-");
      expect(repeated.arrayMapIntrinsics?.fingerprint).toContain("host-b");
    });

    it("ANDs each pattern operation without borrowing the map/includes veto", () => {
      const environment = {
        arrayMapIntrinsics: {
          intact: false,
          iterationIntact: true,
          prototypeAbsenceIntact: false,
          revision: 1,
          fingerprint: "operations"
        }
      };
      const first = mergeIntrinsicObservations(undefined, environment, []);
      expect(first.arrayMapIntrinsics?.intact).toBe(false);
      expect(first.arrayMapIntrinsics?.iterationIntact).toBe(true);
      expect(first.arrayMapIntrinsics?.prototypeAbsenceIntact).toBe(false);
      const revoked = mergeIntrinsicObservations(
        first,
        {
          arrayMapIntrinsics: {
            ...environment.arrayMapIntrinsics,
            iterationIntact: false,
            prototypeAbsenceIntact: true
          }
        },
        []
      );
      expect(revoked.arrayMapIntrinsics?.iterationIntact).toBe(false);
      expect(revoked.arrayMapIntrinsics?.prototypeAbsenceIntact).toBe(false);
      expect(revoked.fingerprint).not.toBe(first.fingerprint);
      const legacyFalse = mergeIntrinsicObservations(
        undefined,
        {
          arrayMapIntrinsics: {
            intact: false,
            revision: 1,
            fingerprint: "legacy"
          }
        },
        []
      );
      const unchanged = mergeIntrinsicObservations(
        legacyFalse,
        environment,
        []
      );
      expect(unchanged.arrayMapIntrinsics?.iterationIntact).toBe(false);
    });

    it("unions exact prototype keys and preserves unknown and legacy vetoes", () => {
      const snapshot = {
        intact: false,
        iterationIntact: true,
        prototypeAbsenceIntact: false,
        prototypeMutationKeys: ["name"],
        revision: 1,
        fingerprint: "keys"
      };
      const first = mergeIntrinsicObservations(
        undefined,
        { arrayMapIntrinsics: snapshot },
        []
      );
      const union = mergeIntrinsicObservations(
        first,
        {
          arrayMapIntrinsics: {
            ...snapshot,
            prototypeMutationKeys: ["size", "name"]
          }
        },
        []
      );
      expect(union.arrayMapIntrinsics?.prototypeMutationKeys).toEqual([
        "name",
        "size"
      ]);
      expect(union.fingerprint).not.toBe(first.fingerprint);
      const unknown = mergeIntrinsicObservations(
        first,
        { arrayMapIntrinsics: { ...snapshot, prototypeMutationKeys: null } },
        []
      );
      expect(unknown.arrayMapIntrinsics?.prototypeMutationKeys).toBeNull();
      const legacy = mergeIntrinsicObservations(
        first,
        {
          arrayMapIntrinsics: {
            intact: false,
            revision: 1,
            fingerprint: "legacy"
          }
        },
        []
      );
      expect(legacy.arrayMapIntrinsics?.prototypeMutationKeys).toBeNull();
    });

    it("preserves explicit extraction authority while ANDing intrinsic snapshots", () => {
      const prepared: InternalPreparedExtractCalls = {
        imports: { "./build": ["make"] },
        localBindings: ["make"],
        protectedFunctions: [{ start: 1, end: 5 }],
        dependencies: ["/build.ts"],
        fingerprint: "registered-semantics",
        mathIntrinsics: {
          intact: false,
          bindIntact: false,
          revision: 2,
          fingerprint: "original"
        },
        arrayMapIntrinsics: {
          intact: true,
          revision: 2,
          fingerprint: "original"
        }
      };
      const result = mergeIntrinsicObservations(
        prepared,
        {
          mathIntrinsics: {
            intact: true,
            bindIntact: true,
            revision: 1,
            fingerprint: "observed"
          },
          arrayMapIntrinsics: {
            intact: false,
            revision: 1,
            fingerprint: "observed"
          }
        },
        ["/reset.ts"]
      );
      expect(result.imports).toBe(prepared.imports);
      expect(result.localBindings).toBe(prepared.localBindings);
      expect(result.protectedFunctions).toBe(prepared.protectedFunctions);
      expect(result.mathIntrinsics?.intact).toBe(false);
      expect(result.mathIntrinsics?.bindIntact).toBe(false);
      expect(result.arrayMapIntrinsics?.intact).toBe(false);
      expect(result.dependencies).toEqual(["/build.ts", "/reset.ts"]);
      expect(result.fingerprint).toContain("registered-semantics");
    });

    it("resolves its TypeScript preset outside the consumer cwd", async () => {
      const fs = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const fixtureRoot = await fs.mkdtemp(
        join(tmpdir(), "mincho-preset-consumer-")
      );

      fixtureRoots.push(fixtureRoot);

      const fixturePath = join(fixtureRoot, "entry.ts");
      await fs.writeFile(
        fixturePath,
        "export const value: number = 42;",
        "utf8"
      );

      const transformed = await babelTransform(fixturePath, {
        cwd: fixtureRoot,
        babelrc: false,
        configFile: false
      });

      expect(transformed.code).toContain("export const value = 42;");
    });

    it("does not start a prepass for a project engine without a source provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div css={{ color: "red" }} />;
          }
        `,
        "css-prop-engine-without-provider"
      );

      const engine = new MinchoProjectEngine();

      await expect(
        babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalProjectEngine: engine
        })
      ).resolves.toMatchObject({ jsxCssPropTransformed: true });
    });

    it("refreshes the project engine when a transform fails without static css eval", async () => {
      const fixturePath = await createBabelFixture(
        "const broken =",
        "transform-failure-without-static-css-eval"
      );

      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: fixturePath,
        result: { dependencyFiles: ["/stale-dependency.ts"] },
        generatedArtifacts: [
          {
            ownerFile: fixturePath,
            artifactFile: "stale.css.ts",
            source: "stale",
            kind: "sidecar-css-ts"
          }
        ]
      });

      const provider = engine.getBabelStaticEvalProvider(fixturePath);
      await provider.resolve(fixturePath, "./current-dependency");

      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          staticCssEvalProjectEngine: engine
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for failed transform");
      }

      expect(thrownError.staticCssEval).toBeUndefined();
      expect(engine.getFileResult(fixturePath)).toMatchObject({
        dependencyFiles: [],
        generatedArtifacts: [],
        providerSnapshot: [expect.objectContaining({ kind: "resolve" })]
      });
    });

    it("leaves output unchanged when defineRules cx optimization is inactive", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { defineRules } from "@mincho-js/css";

          const { css, cx } = defineRules({
            properties: { color: true }
          });
          const idleClass = css({ color: "blue" });
          const activeClass = css({ color: "red" });

          export function button(active: boolean) {
            return cx(idleClass, active && activeClass);
          }
        `,
        "define-rules-cx-optimize-option"
      );

      const omitted = await babelTransform(fixturePath);
      const emptyOptimize = await babelTransform(fixturePath, { optimize: {} });
      const disabledOptimize = await babelTransform(fixturePath, {
        optimize: { defineRulesCxConditions: false }
      });

      const enabledOptimize = await babelTransform(fixturePath, {
        jsxCssProp: false,
        optimize: { defineRulesCxConditions: true }
      });

      expect(emptyOptimize.result).toEqual(omitted.result);
      expect(emptyOptimize.code).toBe(omitted.code);
      expect(disabledOptimize.result).toEqual(omitted.result);
      expect(disabledOptimize.code).toBe(omitted.code);
      expect(enabledOptimize.result).toEqual(omitted.result);
      expect(enabledOptimize.code).toContain("const _minchoDefineRulesCx = [");
      expect(enabledOptimize.code).toContain("return _minchoDefineRulesCx[");
    });

    it("extracts css prop generated css calls into sidecar output", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div className="base" css={{ color: "red" }} />;
          }
        `,
        "css-prop-sidecar"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarSource).toContain("@mincho-js/css");
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
      );
      expect(exportedDeclarations).toHaveLength(1);
      expect(sidecarSource).not.toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*cx\(/s
      );

      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);

      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);

      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css\/classname";/.exec(
          code
        );

      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const classNameMergeMatch =
        /className=\{([A-Za-z_$][\w$]*)\("base", ([A-Za-z_$][\w$]*)\)\}/.exec(
          code
        );

      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(classNameMergeMatch).not.toBeNull();
      expect(classNameMergeMatch?.[1]).toBe(cxIdentifier);
      expect(sidecarRuntimeNames).toContain(classNameMergeMatch?.[2]);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={{");
      expect(code).not.toContain('color: "red"');
    });

    it("emits dynamic declaration leaves as merged inline style vars", async () => {
      const fixturePath = await createBabelFixture(
        `
          type Props = {
            readonly color: string;
            readonly gap: number;
            readonly style?: { readonly opacity?: number };
          };

          function App(props: Props) {
            return <div className="base" style={props.style} css={{ color: props.color, marginTop: \`\${props.gap}px\` }} />;
          }
        `,
        "dynamic-css-var-style"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [sidecarFile, sidecarSource] = result;

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(code).not.toContain(" css=");
      expect(code).toContain('from "@mincho-js/transform-runtime"');
      expect(code).toMatch(
        /className=\{[A-Za-z_$][\w$]*\("base", [A-Za-z_$][\w$]*\)\}/
      );
      expect(code).toMatch(
        /style=\{\{\s*\.\.\.props\.style,\s*\[[A-Za-z_$][\w$]*\]: [A-Za-z_$][\w$]*\(props\.color, "px", true\),\s*\[[A-Za-z_$][\w$]*\]: [A-Za-z_$][\w$]*\(props\.gap, "px"\)\s*\}\}/s
      );
      expect(sidecarSource).toMatch(/[A-Za-z_$][\w$]*\("color"\)/);
      expect(sidecarSource).toMatch(/[A-Za-z_$][\w$]*\("marginTop"\)/);
      expect(sidecarSource).toMatch(/[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/);
      expect(sidecarSource).toMatch(
        /[A-Za-z_$][\w$]*\(\{\s*color: [A-Za-z_$][\w$]*,\s*marginTop: [A-Za-z_$][\w$]*\s*\}\)/s
      );
    });

    it("merges pre and post spread className around explicit css output", async () => {
      const fixturePath = await createBabelFixture(
        `
          const preProps = { className: "pre", css: "ignored-pre", id: "root" };
          const postProps = { className: "post", css: "ignored-post", title: "done" };

          function App() {
            return <div {...preProps} css={{ color: "red" }} {...postProps} />;
          }
        `,
        "pre-post-spread-merge"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [, sidecarSource] = result;

      expect(code).not.toContain(" css=");
      expect(code).toContain("const _minchoPreProps = {");
      expect(code).toContain("const _minchoPostProps = {");
      expect(code).toMatch(
        /<div \{\.\.\._minchoPreRest\} \{\.\.\._minchoPostRest\} className=\{[A-Za-z_$][\w$]*\(_minchoPreClassName, _minchoCssClassName, _minchoPostClassName\)\} \/>/
      );
      expect(sidecarSource).toContain('color: "red"');
    });

    it("folds pure call-valued leaves and spread calls in css prop rules", async () => {
      const fixturePath = await createBabelFixture(
        `
          function makeRule(color = "red") {
            return { color };
          }

          function makeColor() {
            return "blue";
          }

          function App() {
            return <>
              <div css={makeRule("red")} />
              <div css={{ color: makeColor() }} />
              <div css={{ ...makeRule("green") }} />
            </>;
          }
        `,
        "css-prop-sidecar-build-time-calls"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [, sidecarSource] = result;

      expect(code).not.toContain(" css=");
      expect(code).not.toMatch(/\bcss\(/);
      expect(code).not.toContain("_cx(makeRule");
      expect(code).not.toContain("_cx(makeColor");

      for (const color of ["red", "blue", "green"])
        expect(sidecarSource).toContain(`color: "${color}"`);

      expect(sidecarSource).not.toContain("makeRule");
      expect(sidecarSource).not.toContain("makeColor");
    });

    it("preserves direct object and class-value css props without a static source provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { css } from "@mincho-js/css";

          const styleA = css({ color: "blue" });
          const condition = true;

          function App() {
            return <>
              <div className="base" css={{ color: "red" }} />
              <div css={styleA} />
              <div css={condition ? "active" : "inactive"} />
            </>;
          }
        `,
        "css-prop-provider-absence"
      );

      const transformed = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const { result, code } = transformed;
      const [, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(transformed.staticCssEval).toBeUndefined();
      expect(exportedDeclarations).toHaveLength(2);
      expect(sidecarSource).toContain('color: "blue"');
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx("base",');
      expect(code).toContain("className={_cx(styleA)}");
      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
    });

    it("keeps class-value css props on the cx path without double wrapping", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { css } from "@mincho-js/css";

          const styleA = css({ color: "blue" });
          const condition = true;
          const flag = false;
          const providedClass = "provided";
          const maybeClass = null;

          function getClassName() {
            return "call-class";
          }

          function App() {
            return <>
              <div className="base" css={{ color: "red" }} />
              <div css={styleA} />
              <div css="literal-class" />
              <div css={condition ? "active" : "inactive"} />
              <div css={flag && "active"} />
              <div css={providedClass || "fallback"} />
              <div css={maybeClass ?? "fallback"} />
              <div css={["call-base", getClassName()]} />
            </>;
          }
        `,
        "css-prop-v2-classification"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];
      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css\/classname";/.exec(
          code
        );

      const cxIdentifier = cxImportMatch?.[1] ?? "cx";

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(exportedDeclarations).toHaveLength(2);
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "blue"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "red"\s*\}\);/s
      );
      expect(sidecarSource).not.toMatch(/\bcss\(styleA\)/);
      expect(sidecarSource).not.toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*cx\(/s
      );
      expect(cxImportMatch).not.toBeNull();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={styleA}");
      expect(code).not.toContain("css(styleA)");
      expect(code).not.toContain("_css(styleA)");
      expect(code).toMatch(
        new RegExp(`className=\\{${escapeRegExp(cxIdentifier)}\\(styleA\\)\\}`)
      );
      expect(code).toContain('className="literal-class"');
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'condition ? "active" : "inactive"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'flag && "active"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'providedClass || "fallback"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'maybeClass ?? "fallback"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            '"call-base", getClassName()'
          )}\\)\\}`
        )
      );
    });

    it("recognizes aliased @mincho-js/css cx calls as class values", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { cx as classNames } from "@mincho-js/css";

          const active = true;

          function App() {
            return <div css={classNames("base", active && "active")} />;
          }
        `,
        "css-prop-cx-alias"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [, sidecarSource] = result;

      expect(sidecarSource).not.toContain("classNames(");
      expect(code).toContain('classNames("base", active && "active")');
    });

    it("does not treat unrelated local cx helpers as class-value escapes", async () => {
      const fixturePath = await createBabelFixture(
        `
          const cx = (value) => value;

          function App() {
            return <div css={cx({ color: "red" })} />;
          }
        `,
        "css-prop-local-cx"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [, sidecarSource] = result;

      expect(sidecarSource).toContain('color: "red"');
      expect(sidecarSource).not.toContain("cx({");
      expect(code).not.toContain(" css=");
    });

    it("resolves imported named, aliased, default, and nested static css props through a provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button as buttonStyle, aliasStyle, styles } from "./styles";
          import defaultObject from "./default-object";
          import defaultConst from "./default-const";

          function App() {
            return <>
              <div css={buttonStyle} />
              <div css={aliasStyle} />
              <div css={defaultObject} />
              <div css={defaultConst} />
              <div css={styles.button.primary} />
            </>;
          }
        `,
        "css-prop-imported-static-values"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          buttonStyle: { color: "red" },
          aliasStyle: { color: "blue" },
          defaultObject: { color: "green" },
          defaultConst: { color: "orange" },
          "styles.button.primary": { color: "purple" }
        })
      });

      const [, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(exportedDeclarations).toHaveLength(5);
      expect(sidecarSource).toContain('color: "red"');
      expect(sidecarSource).toContain('color: "blue"');
      expect(sidecarSource).toContain('color: "green"');
      expect(sidecarSource).toContain('color: "orange"');
      expect(sidecarSource).toContain('color: "purple"');
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(buttonStyle)");
      expect(code).not.toContain("_cx(aliasStyle)");
      expect(code).not.toContain("_cx(defaultObject)");
      expect(code).not.toContain("_cx(defaultConst)");
      expect(code).not.toContain("_cx(styles.button.primary)");
    });

    it("partial evaluator leaves reachable imports on the static css eval provider contract", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button, tokens } from "./styles";

          function App() {
            return <>
              <div css={button} />
              <div css={tokens.button.primary} />
            </>;
          }
        `,
        "css-prop-partial-evaluator-provider-boundary"
      );

      const queries: StaticCssEvalProviderQuery[] = [];
      const provider = createResolvedStaticCssEvalProvider({
        button: { color: "red" },
        "tokens.button.primary": { color: "purple" }
      });

      const observingProvider: StaticCssEvalProvider = {
        getResolvedCssValue(query): StaticCssEvalProviderResult {
          queries.push(query);

          return provider.getResolvedCssValue(query);
        }
      };

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalProvider: observingProvider
      });

      const queryKeys = queries.map(({ bindingName, memberPath }) =>
        memberPath?.length
          ? `${bindingName}.${memberPath.join(".")}`
          : bindingName
      );

      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "purple"');
      expect(code).not.toContain(" css=");
      expect(queryKeys).toEqual(
        expect.arrayContaining(["button", "tokens.button.primary"])
      );
    });

    it("static css eval metadata dedupes dependency diagnostics and resolved module ids", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button } from "./styles";

          function App() {
            return <>
              <div css={button} />
              <span css={button} />
            </>;
          }
        `,
        "css-prop-metadata-dedupe"
      );

      const dependency = {
        file: "/provider/styles.ts",
        kind: "imported",
        importer: fixturePath,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: true
      } satisfies StaticCssEvalMetadataDependency;

      const diagnostic = {
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        code: "unsupported-source",
        message: "test static css eval metadata diagnostic",
        reason: "reexport-or-barrel",
        owner: { file: fixturePath, start: 0, end: 1 },
        dependency: { file: dependency.file },
        importPath: "./styles",
        exportName: "button",
        memberPath: [],
        importChain: [fixturePath, dependency.file]
      } satisfies StaticCssEvalMetadataDiagnostic;

      const cacheKey = {
        importerFile: fixturePath,
        resolvedFile: dependency.file,
        resolvedId: dependency.file,
        exportName: "button",
        memberPath: [],
        sourceHash: "test:metadata-dedupe",
        pluginOptionsVersion: "test-plugin-options",
        resolverOptionsVersion: "test-resolver-options",
        staticEvalSupportVersion: "test-static-eval"
      } satisfies StaticCssEvalMetadataCacheKey;

      const packageCacheKey = {
        ...cacheKey,
        canonicalModuleId: "pkg:@scope/styles",
        normalizedPathKey: "pkg:@scope/styles?condition=import",
        sourceKind: "package-source",
        sourceOrigin: "package",
        watchFiles: ["/project/.pnp.cjs"],
        parserVersion: "test-parser-v1",
        parserOptions: {
          plugins: ["jsx", "typescript"],
          sourceType: "module",
          jsx: true,
          typescript: true
        }
      } satisfies StaticCssEvalMetadataCacheKey;

      const cacheKeys = [cacheKey, packageCacheKey] as const;
      let cacheKeyIndex = 0;
      const provider: StaticCssEvalProvider = {
        getResolvedCssValue(): StaticCssEvalProviderResult {
          const currentCacheKey = cacheKeys[cacheKeyIndex] ?? packageCacheKey;
          cacheKeyIndex += 1;

          return {
            kind: "resolved",
            value: { color: "red" },
            dependencies: [dependency, { ...dependency }],
            diagnostics: [diagnostic, { ...diagnostic }],
            cacheKey: currentCacheKey
          } as unknown as StaticCssEvalProviderResult;
        }
      };

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(button)");
      expect(
        staticCssEval?.dependencies.filter(
          (item) => item.file === dependency.file && item.kind === "imported"
        )
      ).toHaveLength(1);
      expect(
        staticCssEval?.diagnostics.filter((item) => item.id === diagnostic.id)
      ).toHaveLength(1);
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining(cacheKey),
          expect.objectContaining(packageCacheKey)
        ])
      );
      expect(staticCssEval?.cacheKeys).toHaveLength(2);
      expect(
        staticCssEval?.resolvedModuleIds.filter(
          (moduleId) => moduleId === dependency.file
        )
      ).toHaveLength(1);
    });

    it("tracks execution imports without emitting their unused CSS", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./styles";
        import { unused } from "./unused";

        const value = unused;

        function App() {
          return <>
            <div css={button} />
            <span>{value}</span>
          </>;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-reachable-import"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const unusedId = path.join(fixtureRoot, "unused.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: `export const button = { color: "red" } as const;`,
          [unusedId]: `export const unused = { color: "blue" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId,
          [`${fixturePath}\0./unused`]: unusedId
        }
      });

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./styles" },
        { importerId: fixturePath, importPath: "./unused" }
      ]);
      expect(calls.loaded).toEqual([stylesId, unusedId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(sidecarSource).not.toContain('color: "blue"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId, unusedId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        stylesId,
        unusedId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(unusedId)).toBe(true);
    });

    it("prepass tracks literal operands and execution imports for mutation checks", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { direct } from "./direct";
        import { button } from "./styles";
        import { tokens } from "./tokens";
        import { unused } from "./unused";

        const localButton = { ...direct, background: tokens.accent };
        const unusedValue = unused;

        function App() {
          return <>
            <div css={{ ...localButton, ...button.text }} />
            <span>{unusedValue}</span>
          </>;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-prepass-reachable-spread-identifier"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const directId = path.join(fixtureRoot, "direct.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const tokensId = path.join(fixtureRoot, "tokens.ts");
      const unusedId = path.join(fixtureRoot, "unused.ts");
      const baseId = path.join(fixtureRoot, "base.ts");
      const paletteId = path.join(fixtureRoot, "palette.ts");
      const ignoredId = path.join(fixtureRoot, "ignored.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [directId]: `export const direct = { marginTop: 1 } as const;`,
          [stylesId]: `
            import { base } from "./base";
            import { palette } from "./palette";
            import { ignored } from "./ignored";

            const unusedStyle = ignored;

            export const button = {
              text: { ...base, color: palette.primary },
              ignored
            } as const;
          `,
          [tokensId]: `export const tokens = { accent: "gold" } as const;`,
          [unusedId]: `export const unused = { color: "blue" } as const;`,
          [baseId]: `export const base = { padding: 4 } as const;`,
          [paletteId]: `export const palette = { primary: "red" } as const;`,
          [ignoredId]: `export const ignored = { color: "orange" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./direct`]: directId,
          [`${fixturePath}\0./styles`]: stylesId,
          [`${fixturePath}\0./tokens`]: tokensId,
          [`${fixturePath}\0./unused`]: unusedId,
          [`${stylesId}\0./base`]: baseId,
          [`${stylesId}\0./palette`]: paletteId,
          [`${stylesId}\0./ignored`]: ignoredId
        }
      });

      const { staticCssEval } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./direct" },
        { importerId: fixturePath, importPath: "./tokens" },
        { importerId: fixturePath, importPath: "./styles" },
        { importerId: stylesId, importPath: "./base" },
        { importerId: stylesId, importPath: "./palette" },
        { importerId: stylesId, importPath: "./ignored" },
        { importerId: fixturePath, importPath: "./unused" }
      ]);
      expect(calls.loaded).toEqual([
        directId,
        tokensId,
        stylesId,
        baseId,
        paletteId,
        ignoredId,
        unusedId
      ]);
      expect(staticCssEval?.dependencyFiles).toEqual([
        directId,
        tokensId,
        stylesId,
        baseId,
        paletteId,
        ignoredId,
        unusedId
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(unusedId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(ignoredId)).toBe(true);
    });

    it("prepass loads package data virtual and CommonJS static operands", async () => {
      const ownerSource = `
        import { packageButton } from "@scope/styles";
        import { dataButton } from "@scope/styles/tokens.json";
        import { virtualButton } from "virtual:mincho/styles";

        const cjsStyles = require("./styles.cjs");

        function App() {
          return <div css={{
            ...packageButton,
            color: dataButton.color,
            background: virtualButton.background,
            borderColor: cjsStyles.colors.border
          }} />;
        }
      `;

      const ownerId = await createBabelFixture(
        ownerSource,
        "css-prop-prepass-package-data-virtual-commonjs"
      );

      const packageId = "pkg:@scope/styles/index.ts";
      const packageLoadId = `${packageId}?condition=import`;
      const dataId = "pkg:@scope/styles/tokens.json?import";
      const virtualId = "\0virtual:mincho/styles";
      const cjsId = "/project/src/styles.cjs";
      const calls: FakeStaticCssEvalSourceProviderCalls = {
        resolved: [],
        loaded: []
      };

      const resolutions = new Map<string, StaticCssEvalSourceResolution>([
        [
          `${ownerId}\0@scope/styles`,
          {
            resolvedFile: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0@scope/styles/tokens.json`,
          {
            resolvedFile: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0virtual:mincho/styles`,
          {
            resolvedFile: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0./styles.cjs`,
          {
            resolvedFile: cjsId,
            canonicalModuleId: cjsId,
            normalizedPathKey: cjsId,
            resolverKind: "test"
          }
        ]
      ]);

      const loadedSources = new Map<string, StaticCssEvalLoadedSource>([
        [ownerId, { source: ownerSource }],
        [
          packageLoadId,
          {
            sourceText: `export const packageButton = { padding: 8 } as const;`,
            sourceKind: "package-source",
            sourceIdentity: { sourceHash: "package-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          dataId,
          {
            sourceText: JSON.stringify({ dataButton: { color: "green" } }),
            sourceKind: "static-data",
            sourceIdentity: { sourceHash: "data-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          virtualId,
          {
            sourceText: `export const virtualButton = { background: "blue" } as const;`,
            sourceKind: "provider-virtual",
            sourceIdentity: { sourceHash: "virtual-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          cjsId,
          {
            sourceText: `exports.colors = { border: "black" };`,
            resolverKind: "test"
          }
        ]
      ]);

      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });

          return resolutions.get(`${importerId}\0${importPath}`) ?? null;
        },

        load(id) {
          calls.loaded.push(id);

          return loadedSources.get(id) ?? null;
        }
      };

      const { staticCssEval } = await babelTransform(ownerId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(calls.resolved).toEqual([
        { importerId: ownerId, importPath: "@scope/styles" },
        { importerId: ownerId, importPath: "@scope/styles/tokens.json" },
        { importerId: ownerId, importPath: "virtual:mincho/styles" },
        { importerId: ownerId, importPath: "./styles.cjs" }
      ]);
      expect(calls.loaded).toEqual([packageLoadId, dataId, virtualId, cjsId]);
      expect(staticCssEval?.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: cjsId,
            sourceKind: "project-source",
            sourceOrigin: "project",
            loaded: true
          })
        ])
      );
    });

    it("cache invalidation follows transitive spread operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `import { base } from "./base"; export const button = { ...base } as const;`;
      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "base.ts": redBaseSource
        },
        "css-prop-prepass-transitive-spread-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const baseId = filePaths["base.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./base`]: baseId
        }
      });

      const firstPrepass = await createStaticCssEvalPrepass(
        componentId,
        provider
      );

      await fs.writeFile(baseId, blueBaseSource, "utf8");

      const secondPrepass = await createStaticCssEvalPrepass(
        componentId,
        provider
      );

      expect(firstPrepass.result.dependencyFiles).toEqual([stylesId, baseId]);
      expect(secondPrepass.result.dependencyFiles).toEqual([stylesId, baseId]);
      expect(firstPrepass.result.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerId: stylesId,
            specifier: "./base",
            resolvedFile: baseId,
            loaded: true,
            sourceIdentity: createTestSourceIdentity(redBaseSource)
          })
        ])
      );
      expect(secondPrepass.result.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerId: stylesId,
            specifier: "./base",
            resolvedFile: baseId,
            loaded: true,
            sourceIdentity: createTestSourceIdentity(blueBaseSource)
          })
        ])
      );
      expect(
        firstPrepass.result.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondPrepass.result.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows computed key operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `import { colorKey } from "./keys"; export const button = { [colorKey]: "red" } as const;`;
      const colorKeySource = `export const colorKey = "color" as const;`;
      const backgroundKeySource = `export const colorKey = "background" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "keys.ts": colorKeySource
        },
        "css-prop-computed-key-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const keysId = filePaths["keys.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./keys`]: keysId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(keysId, backgroundKeySource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('background: "red"');
      expect(secondTransform.result[1]).toContain('background: "red"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        keysId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        keysId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(colorKeySource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(backgroundKeySource).sourceHash);
    });

    it("partial evaluator cache invalidation recomputes helper object spread and computed key outputs", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `
        import { base } from "./base";
        import { propertyKey } from "./keys";

        const helper = { ...base, [propertyKey]: "solid" } as const;
        export const button = { ...helper } as const;
      `;

      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const borderKeySource = `export const propertyKey = "borderColor" as const;`;
      const backgroundKeySource = `export const propertyKey = "background" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "base.ts": redBaseSource,
          "keys.ts": borderKeySource
        },
        "css-prop-partial-evaluator-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const baseId = filePaths["base.ts"];
      const keysId = filePaths["keys.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./base`]: baseId,
          [`${stylesId}\0./keys`]: keysId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(baseId, blueBaseSource, "utf8");
      await fs.writeFile(keysId, backgroundKeySource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).toContain('borderColor: "solid"');
      expect(firstTransform.result[1]).not.toContain('background: "solid"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('background: "solid"');
      expect(secondTransform.result[1]).not.toContain('borderColor: "solid"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        baseId,
        keysId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        baseId,
        keysId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(redBaseSource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(blueBaseSource).sourceHash);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(borderKeySource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(backgroundKeySource).sourceHash);
    });

    it("cache invalidation tracks factory helper identity and execution imports", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { makeButton } from "./factory";

        function App() {
          return <div css={makeButton()} />;
        }
      `;

      const factorySource = `
        import { base } from "./base";
        import { propertyKey } from "./keys";
        import { unused } from "./unused";

        const ignored = unused;

        export function makeButton() {
          return { ...base, [propertyKey]: "solid" } as const;
        }
      `;

      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const keySource = `export const propertyKey = "borderColor" as const;`;
      const unusedSource = `export const unused = { color: "orange" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "factory.ts": factorySource,
          "base.ts": redBaseSource,
          "keys.ts": keySource,
          "unused.ts": unusedSource
        },
        "css-prop-sidecar-factory-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const factoryId = filePaths["factory.ts"];
      const baseId = filePaths["base.ts"];
      const keysId = filePaths["keys.ts"];
      const unusedId = filePaths["unused.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./factory`]: factoryId,
          [`${factoryId}\0./base`]: baseId,
          [`${factoryId}\0./keys`]: keysId,
          [`${factoryId}\0./unused`]: unusedId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(baseId, blueBaseSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain("makeButton()");
      expect(secondTransform.result[1]).toContain("makeButton()");
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        factoryId,
        baseId,
        keysId,
        unusedId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        factoryId,
        baseId,
        keysId,
        unusedId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedModuleCache.has(unusedId)
      ).toBe(true);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(redBaseSource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(blueBaseSource).sourceHash);
    });

    it("routes vite and esbuild style static css eval adapters through the project engine", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `import { token } from "./tokens"; export const button = { color: token } as const;`;
      const tokenSource = `export const token = "red" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "tokens.ts": tokenSource
        },
        "css-prop-project-engine-adapter-routes"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const tokensId = filePaths["tokens.ts"];
      const engine = new MinchoProjectEngine();

      const createAdapterProvider = (resolverKind: StaticCssEvalResolverKind) =>
        createFileBackedStaticCssEvalSourceProvider({
          resolverKind,
          resolutions: {
            [`${componentId}\0./styles`]: stylesId,
            [`${stylesId}\0./tokens`]: tokensId
          }
        });

      const viteTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalProjectEngine: engine,
        staticCssEvalSourceProvider: createAdapterProvider("vite")
      });

      const viteFileResult = engine.getFileResult(componentId);
      const invalidatedOwners = engine.invalidateByDependency(tokensId);
      const invalidatedFileResult = engine.getFileResult(componentId);
      const esbuildTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalProjectEngine: engine,
        staticCssEvalSourceProvider: createAdapterProvider("esbuild")
      });

      const esbuildFileResult = engine.getFileResult(componentId);

      expect(viteTransform.result[1]).toContain('color: "red"');
      expect(viteFileResult?.dependencyFiles).toEqual(
        expect.arrayContaining([stylesId, tokensId])
      );
      expect(viteFileResult?.generatedArtifacts).toHaveLength(1);
      expect(viteFileResult?.cacheKeys.length).toBeGreaterThan(0);
      expect(
        viteFileResult?.providerSnapshot.map((record) => record.kind)
      ).toEqual(expect.arrayContaining(["load", "resolve"]));
      expect(
        viteFileResult?.providerSnapshot.some(
          (record) => record.result?.resolverKind === "vite"
        )
      ).toBe(true);
      expect(invalidatedOwners).toEqual([componentId]);
      expect(invalidatedFileResult?.generatedArtifacts).toEqual([]);
      expect(esbuildTransform.result[1]).toContain('color: "red"');
      expect(esbuildFileResult?.invalidated).toBe(false);
      expect(esbuildFileResult?.generatedArtifacts).toHaveLength(1);
      expect(
        esbuildFileResult?.providerSnapshot.some(
          (record) => record.result?.resolverKind === "esbuild"
        )
      ).toBe(true);
    });

    it("cache invalidation follows template interpolation operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource =
        'import { brand } from "./brand"; export const button = { color: `${brand}` } as const;';

      const redBrandSource = `export const brand = "red" as const;`;
      const blueBrandSource = `export const brand = "blue" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "brand.ts": redBrandSource
        },
        "css-prop-template-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const brandId = filePaths["brand.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./brand`]: brandId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(brandId, blueBrandSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        brandId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        brandId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === brandId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === brandId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows optional member target source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `import { palette } from "./palette"; export const button = { color: palette?.primary } as const;`;
      const redPaletteSource = `export const palette = { primary: "red" } as const;`;
      const bluePaletteSource = `export const palette = { primary: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "palette.ts": redPaletteSource
        },
        "css-prop-optional-member-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const paletteId = filePaths["palette.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./palette`]: paletteId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(paletteId, bluePaletteSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        paletteId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        paletteId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === paletteId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === paletteId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows const CommonJS require path source and target changes", async () => {
      const fs = await import("node:fs/promises");
      const redComponentSource = `
        const cjsPath = "./red-styles";
        const styles = require(cjsPath);

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const blueComponentSource = `
        const cjsPath = "./blue-styles";
        const styles = require(cjsPath);

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const redStylesSource = `exports.button = { color: "red" };`;
      const orangeStylesSource = `exports.button = { color: "orange" };`;
      const blueStylesSource = `exports.button = { color: "blue" };`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": redComponentSource,
          "red-styles.cjs": redStylesSource,
          "blue-styles.cjs": blueStylesSource
        },
        "css-prop-cjs-const-path-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const redStylesId = filePaths["red-styles.cjs"];
      const blueStylesId = filePaths["blue-styles.cjs"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./red-styles`]: redStylesId,
          [`${componentId}\0./blue-styles`]: blueStylesId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(redStylesId, orangeStylesSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(componentId, blueComponentSource, "utf8");

      const thirdTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(secondTransform.result[1]).toContain('color: "orange"');
      expect(thirdTransform.result[1]).toContain('color: "blue"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        redStylesId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        redStylesId
      ]);
      expect(thirdTransform.staticCssEval?.dependencyFiles).toEqual([
        blueStylesId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies[0]?.sourceIdentity
          ?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies[0]?.sourceIdentity
          ?.sourceHash
      );
      expect(
        thirdTransform.staticCssEval?.resolvedDependencies[0]
      ).toMatchObject({
        specifier: "./blue-styles",
        resolvedFile: blueStylesId,
        loaded: true
      });
    });

    it("static css eval metadata preserves dependency files resolved dependencies cache keys and source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const redStylesSource = `export const button = { color: "red" } as const;`;
      const blueStylesSource = `export const button = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": redStylesSource
        },
        "css-prop-imported-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      await fs.writeFile(stylesId, blueStylesSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId
      ]);
      expect(firstTransform.staticCssEval?.cacheKeys[0]?.sourceHash).toBe(
        createTestSourceIdentity(redStylesSource).sourceHash
      );
      expect(secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash).toBe(
        createTestSourceIdentity(blueStylesSource).sourceHash
      );
      expect(firstTransform.staticCssEval?.cacheKeys[0]?.sourceHash).not.toBe(
        secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash
      );
      expect(secondTransform.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(blueStylesSource)
        })
      ]);
      expect(secondTransform.staticCssEval?.resolvedModuleIds).toContain(
        stylesId
      );
    });

    it("static css eval cache keys include source provider package data and virtual identity metadata", async () => {
      const componentSource = `
        import { button } from "@scope/styles";
        import { token } from "@scope/styles/tokens.json";
        import { virtualButton } from "virtual:mincho/styles";

        function App() {
          return <>
            <div css={button} />
            <div css={token} />
            <div css={virtualButton} />
          </>;
        }
      `;

      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource
        },
        "css-prop-source-provider-cache-metadata"
      );

      const componentId = filePaths["component.tsx"];
      const packageId = "pkg:@scope/styles/index.ts";
      const packageLoadId = `${packageId}?condition=import`;
      const dataId = "pkg:@scope/styles/tokens.json?import";
      const virtualId = "\0virtual:mincho/styles";
      const pnpWatchFile = "/project/.pnp.cjs";
      const dataWatchFile = "/project/node_modules/@scope/styles/tokens.json";
      const resolutions = new Map<string, StaticCssEvalSourceResolution>([
        [
          `${componentId}\0@scope/styles`,
          {
            resolvedFile: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            sourceIdentity: { version: "package-resolution-v1" },
            watchFiles: [pnpWatchFile],
            resolverKind: "test"
          }
        ],
        [
          `${componentId}\0@scope/styles/tokens.json`,
          {
            resolvedFile: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            watchFiles: [dataWatchFile],
            resolverKind: "test"
          }
        ],
        [
          `${componentId}\0virtual:mincho/styles`,
          {
            resolvedFile: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            sourceIdentity: { version: "virtual-resolution-v1" },
            resolverKind: "test"
          }
        ]
      ]);

      const loadedSources = new Map<string, StaticCssEvalLoadedSource>([
        [componentId, { source: componentSource }],
        [
          packageLoadId,
          {
            sourceText: `export const button = { color: "red" } as const;`,
            sourceKind: "package-source",
            sourceIdentity: { sourceHash: "package-source-v1" },
            watchFiles: [pnpWatchFile],
            resolverKind: "test"
          }
        ],
        [
          dataId,
          {
            sourceText: JSON.stringify({ token: { color: "green" } }),
            sourceKind: "static-data",
            sourceIdentity: { sourceHash: "data-source-v1" },
            watchFiles: [dataWatchFile],
            resolverKind: "test"
          }
        ],
        [
          virtualId,
          {
            sourceText: `export const virtualButton = { color: "blue" } as const;`,
            sourceKind: "provider-virtual",
            sourceIdentity: {
              sourceHash: "virtual-source-v1",
              version: "virtual-loaded-v1"
            },
            resolverKind: "test"
          }
        ]
      ]);

      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          return resolutions.get(`${importerId}\0${importPath}`) ?? null;
        },

        load(id) {
          return loadedSources.get(id) ?? null;
        }
      };

      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('color: "blue"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            resolvedId: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            sourceHash: "package-source-v1",
            sourceVersion: "package-resolution-v1",
            watchFiles: [pnpWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            resolvedId: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            sourceHash: "data-source-v1",
            watchFiles: [dataWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            resolvedId: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            sourceHash: "virtual-source-v1",
            sourceVersion: "virtual-loaded-v1"
          })
        ])
      );
      expect(staticCssEval?.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            sourceKind: "package-source",
            sourceIdentity: expect.objectContaining({
              sourceHash: "package-source-v1"
            }),
            resolverKind: "test",
            watchFiles: [pnpWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            sourceKind: "static-data",
            sourceIdentity: expect.objectContaining({
              sourceHash: "data-source-v1"
            }),
            resolverKind: "test",
            watchFiles: [dataWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            sourceKind: "provider-virtual",
            sourceIdentity: {
              sourceHash: "virtual-source-v1",
              version: "virtual-loaded-v1"
            },
            resolverKind: "test"
          })
        ])
      );
    });

    it("resolves CommonJS require css prop metadata through the async source-provider prepass", async () => {
      const componentSource = `
        const styles = require("./styles");

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const stylesSource = `exports.button = { color: "red" };`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.cjs": stylesSource
        },
        "css-prop-cjs-require-metadata"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.cjs"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(styles.button)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(componentId)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        componentId
      ]);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(stylesSource)
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({
          file: stylesId,
          kind: "imported",
          importer: componentId,
          specifier: "./styles",
          exportName: "button",
          memberPath: [],
          inspected: true,
          contributed: true,
          sourceHash: createTestSourceIdentity(stylesSource).sourceHash,
          resolverKind: "test"
        })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: [],
        sourceHash: createTestSourceIdentity(stylesSource).sourceHash
      });
      expect(staticCssEval?.diagnostics).toEqual([]);
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("dedupes CommonJS unsupported diagnostics observed during transform", async () => {
      const componentSource = `
        const source = "./" + "styles";
        const styles = require(source);

        function App() {
          return <>
            <div css={styles.button} />
            <span css={styles.button} />
          </>;
        }
      `;

      const componentId = await createBabelFixture(
        componentSource,
        "css-prop-cjs-diagnostic-dedupe"
      );

      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {}
      });

      let thrownError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for dynamic CJS require");
      }

      expect(
        thrownError.staticCssEval?.diagnostics.filter(
          (diagnostic) =>
            diagnostic.id === "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        )
      ).toHaveLength(1);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([]);
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([]);
    });

    it("does not reuse a negative dependency unresolved export result after imported source content changes", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const missingExportStylesSource = `export const card = { color: "red" } as const;`;
      const fixedStylesSource = `export const button = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": missingExportStylesSource
        },
        "css-prop-imported-unresolved-cache-invalidation"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      let firstError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        firstError = error;
      }

      expect(firstError).toBeInstanceOf(BabelTransformError);

      const transformError = firstError as BabelTransformError;
      const firstStaticCssEval = transformError.staticCssEval;

      expect(firstStaticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        owner: { file: componentId },
        dependency: { file: stylesId },
        importPath: "./styles",
        exportName: "button"
      });
      expect(firstStaticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        sourceHash: createTestSourceIdentity(missingExportStylesSource)
          .sourceHash
      });

      await fs.writeFile(stylesId, fixedStylesSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(secondTransform.code).not.toContain("_cx(button)");
      expect(secondTransform.staticCssEval?.diagnostics).toEqual([]);
      expect(secondTransform.staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        sourceHash: createTestSourceIdentity(fixedStylesSource).sourceHash
      });
      expect(firstStaticCssEval?.cacheKeys[0]?.sourceHash).not.toBe(
        secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash
      );
      expect(secondTransform.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          normalizedPathKey: stylesId,
          loaded: true,
          sourceIdentity: createTestSourceIdentity(fixedStylesSource)
        })
      ]);
    });

    it("BabelTransformError preserves static css eval metadata and deterministic imported failure context", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `export const card = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-imported-failure-context"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      let thrownError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      const transformError = thrownError as BabelTransformError;
      const staticCssEval = transformError.staticCssEval;
      const diagnostic = staticCssEval?.diagnostics[0];

      expect(transformError.file).toBe(componentId);
      expect(transformError.message).toContain(
        "Cannot statically evaluate css prop value"
      );
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(stylesSource)
        })
      ]);
      expect(staticCssEval?.dependencies[0]).toMatchObject({
        file: stylesId,
        kind: "imported",
        importer: componentId,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: false
      });
      expect(diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        owner: { file: componentId },
        dependency: { file: stylesId },
        importPath: "./styles",
        exportName: "button",
        memberPath: []
      });
      expect(diagnostic?.importChain).toEqual([
        componentId,
        `${stylesId}#button`,
        stylesId
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: [],
        sourceHash: createTestSourceIdentity(stylesSource).sourceHash
      });
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("reports prepared unsupported static-data reasons in transform diagnostics", async () => {
      const cases = [
        {
          label: "wasm-init",
          importPath: "@scope/styles/icon.wasm?init",
          resolvedId: "pkg:@scope/styles/icon.wasm?init",
          sourceText: `export default function init() {}`,
          unsupportedReason: "runtime-wasm-init"
        },
        {
          label: "invalid-json",
          importPath: "@scope/styles/broken.json",
          resolvedId: "pkg:@scope/styles/broken.json?import",
          sourceText: `{ "button": `,
          unsupportedReason: "invalid-json-data"
        }
      ] as const;

      for (const testCase of cases) {
        const componentSource = `
          import unsupported from "${testCase.importPath}";

          function App() {
            return <div css={unsupported} />;
          }
        `;

        const componentId = await createBabelFixture(
          componentSource,
          `css-prop-static-data-${testCase.label}`
        );

        const provider: StaticCssEvalSourceProvider = {
          resolve(importerId, importPath) {
            if (
              importerId !== componentId ||
              importPath !== testCase.importPath
            ) {
              return null;
            }

            return {
              resolvedFile: testCase.resolvedId,
              canonicalModuleId: testCase.resolvedId,
              normalizedPathKey: testCase.resolvedId,
              sourceKind: "static-data",
              resolverKind: "test"
            };
          },

          load(id) {
            if (id === componentId) {
              return { sourceText: componentSource, resolverKind: "test" };
            }

            if (id === testCase.resolvedId) {
              return {
                sourceText: testCase.sourceText,
                sourceKind: "static-data",
                sourceIdentity: {
                  sourceHash: createTestSourceIdentity(testCase.sourceText)
                    .sourceHash,
                  version: testCase.label
                },
                resolverKind: "test"
              };
            }

            return null;
          }
        };

        let thrownError: unknown;

        try {
          await babelTransform(componentId, {
            jsxCssProp: true,
            staticCssEvalSourceProvider: provider
          });
        } catch (error) {
          thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(BabelTransformError);

        if (!(thrownError instanceof BabelTransformError)) {
          throw new Error(
            "Expected BabelTransformError for static data source"
          );
        }

        expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: testCase.unsupportedReason,
          dependency: { file: testCase.resolvedId },
          importPath: testCase.importPath,
          exportName: "default"
        });
        expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
          expect.objectContaining({
            resolvedFile: testCase.resolvedId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: testCase.unsupportedReason,
            sourceIdentity: {
              sourceHash: createTestSourceIdentity(testCase.sourceText)
                .sourceHash,
              version: testCase.label
            },
            resolverKind: "test",
            loaded: true
          })
        ]);
      }
    });

    it("keeps provider-declared unsupported reexport sources fail-closed without filesystem traversal", async () => {
      const componentSource = `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `;

      const barrelSource = `export { button } from "./styles";`;
      const stylesSource = `export const button = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "barrel.ts": barrelSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-unsupported-barrel-no-fallback"
      );

      const componentId = filePaths["component.tsx"];
      const barrelId = filePaths["barrel.ts"];
      const stylesId = filePaths["styles.ts"];
      const loadedIds: string[] = [];
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          if (importerId !== componentId || importPath !== "./barrel") {
            return null;
          }

          return {
            resolvedFile: barrelId,
            canonicalModuleId: `test:${barrelId}`,
            normalizedPathKey: barrelId,
            sourceKind: "unsupported-source-shape",
            unsupportedReason: "reexport-or-barrel",
            resolverKind: "test"
          };
        },

        load(id) {
          loadedIds.push(id);

          if (id === componentId) {
            return { sourceText: componentSource, resolverKind: "test" };
          }

          if (id === barrelId) {
            return {
              sourceText: barrelSource,
              sourceKind: "unsupported-source-shape",
              unsupportedReason: "reexport-or-barrel",
              resolverKind: "test"
            };
          }

          if (id === stylesId) {
            return { sourceText: stylesSource, resolverKind: "test" };
          }

          return null;
        }
      };

      let thrownError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for unsupported barrel");
      }

      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
        reason: "reexport-or-barrel",
        dependency: { file: barrelId },
        importPath: "./barrel",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./barrel",
          resolvedFile: barrelId,
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "reexport-or-barrel",
          resolverKind: "test",
          loaded: true
        })
      ]);
      expect(loadedIds).not.toContain(stylesId);
    });

    it("keeps unresolved provider imports fail-closed even when the imported file exists", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const stylesSource = `export const button = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-unresolved-no-fallback"
      );

      const componentId = filePaths["component.tsx"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {}
      });

      let thrownError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for unresolved import");
      }

      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        dependency: { file: "./styles" },
        importPath: "./styles",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([]);
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: "./styles",
          canonicalModuleId: "unresolved:./styles",
          normalizedPathKey: "unresolved:./styles",
          resolverKind: "source-provider",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
      expect(thrownError.staticCssEval?.dependencies[0]).toMatchObject({
        file: "./styles",
        kind: "imported",
        importer: componentId,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: false
      });
    });

    it("resolves direct named reexports from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-reexport-fallback"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export { button } from "./styles";`,
          [stylesId]: `export const button = { color: "red" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./styles`]: stylesId
        }
      });

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([barrelId, stylesId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.dependencyFiles).toEqual([barrelId, stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(barrelId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({ file: barrelId, kind: "reexported" }),
        expect.objectContaining({ file: stylesId, kind: "reexported" })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: fixturePath,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: []
      });
      expect(staticCssEval?.resolvedModuleIds).toEqual(
        expect.arrayContaining([barrelId, stylesId])
      );
    });

    it("excludes failed dependency parses from async prepass caches", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-parse-failure"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: `export const button = ;`
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId
        }
      });

      const prepass = await createStaticCssEvalPrepass(fixturePath, provider);
      const resolution = prepass.provider.getResolvedCssValue({
        importerId: fixturePath,
        expressionStart: 0,
        expressionEnd: "button".length,
        bindingName: "button"
      });

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, stylesId]);
      expect(prepass.result.dependencyFiles).toEqual([stylesId]);
      expect(prepass.result.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(prepass.result.resolvedModuleCache.has(stylesId)).toBe(false);
      expect(resolution.kind).toBe("error");

      if (resolution.kind !== "error") {
        throw new Error("Expected failed dependency resolution");
      }

      expect(resolution.dependencies).toMatchObject([
        {
          file: stylesId,
          inspected: true,
          contributed: false,
          sourceKind: "unsupported-source-shape",
          unsupportedReason: "unsupported-source-shape"
        }
      ]);
      expect(resolution.diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
        code: "unsupported-source",
        reason: "unsupported-source-shape",
        dependency: { file: stylesId }
      });
    });

    it("resolves namespace members from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./styles";

        function App() {
          return <div css={styles.button.primary} />;
        }
      `;

      const stylesSource = `export const button = { primary: { color: "red" } } as const;`;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-namespace-member"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: stylesSource
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId
        }
      });

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([stylesId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(styles.button.primary)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({
          file: stylesId,
          kind: "namespace-member",
          importer: fixturePath,
          specifier: "./styles",
          exportName: "button",
          memberPath: ["primary"],
          inspected: true,
          contributed: true
        })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: fixturePath,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: ["primary"]
      });
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("resolves imported static-shape spreads computed keys and member paths from the async source-provider prepass", async () => {
      const componentSource = `
        import { button, card } from "./styles";

        function App() {
          return <>
            <div css={button.primary} />
            <section css={card} />
          </>;
        }
      `;

      const stylesSource = `
        const backgroundKey = "backgroundColor";
        const base = { color: "red" } as const;
        const hover = { _hover: { color: "blue" } } as const;
        const row = [{ display: "flex" }] as const;
        const spacing = { gap: "8px" } as const;

        export const button = {
          primary: [
            ...row,
            { ...base, [backgroundKey]: "white" },
            { ...hover },
            spacing
          ]
        } as const;

        export const card = {
          ...base,
          [backgroundKey]: "black",
          ...hover
        } as const;
      `;

      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-static-shape-spreads"
      );

      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [sidecarFile, sidecarSource] = result;

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(code).toMatch(
        new RegExp(`import \\{ [^}]+ \\} from "${escapeRegExp(sidecarFile)}";`)
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(button.primary)");
      expect(code).not.toContain("_cx(card)");
      expect(sidecarSource).toContain('display: "flex"');
      expect(sidecarSource).toContain('gap: "8px"');
      expect(sidecarSource).toContain('backgroundColor: "white"');
      expect(sidecarSource).toContain('backgroundColor: "black"');
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(componentId)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        componentId
      ]);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(stylesSource)
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stylesId,
            kind: "imported",
            importer: componentId,
            specifier: "./styles",
            exportName: "button",
            memberPath: ["primary"],
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: stylesId,
            kind: "imported",
            importer: componentId,
            specifier: "./styles",
            exportName: "card",
            memberPath: [],
            inspected: true,
            contributed: true
          })
        ])
      );
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerFile: componentId,
            resolvedFile: stylesId,
            resolvedId: stylesId,
            exportName: "button",
            memberPath: ["primary"],
            sourceHash: createTestSourceIdentity(stylesSource).sourceHash
          }),
          expect.objectContaining({
            importerFile: componentId,
            resolvedFile: stylesId,
            resolvedId: stylesId,
            exportName: "card",
            memberPath: [],
            sourceHash: createTestSourceIdentity(stylesSource).sourceHash
          })
        ])
      );
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("loads export-star namespace members from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button.primary} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-export-star-namespace-member"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./styles";`,
          [stylesId]: `export const button = { primary: { color: "red" } } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./styles`]: stylesId
        }
      });

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([barrelId, stylesId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(styles.button.primary)");
      expect(staticCssEval?.dependencyFiles).toEqual([barrelId, stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(barrelId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
      expect(staticCssEval?.resolvedModuleIds).toEqual(
        expect.arrayContaining([barrelId, stylesId])
      );
    });

    it("loads whole namespace export-star graphs with explicit default reexports from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-whole-namespace-export-star-default"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const resetId = path.join(fixtureRoot, "reset.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `
            export { default } from "./reset";
            export * from "./styles";
          `,
          [resetId]: `export default { margin: 0 } as const;`,
          [stylesId]: `export const button = { color: "red" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./reset`]: resetId,
          [`${barrelId}\0./styles`]: stylesId
        }
      });

      const { result: staticCssEval } = await createStaticCssEvalPrepass(
        fixturePath,
        provider
      );

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./reset" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId, resetId, stylesId]);
      expect(staticCssEval.dependencyFiles).toEqual([
        barrelId,
        resetId,
        stylesId
      ]);
      expect(staticCssEval.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        resetId,
        stylesId
      ]);
      expect(staticCssEval.dependencyToOwners.get(resetId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval.resolvedModuleCache.has(resetId)).toBe(true);
      expect(staticCssEval.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./reset",
          resolvedFile: resetId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
    });

    it("watches default-only reexport execution without adding it to a star namespace", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-star-only-default-exclusion"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const defaultBarrelId = path.join(fixtureRoot, "defaultBarrel.ts");
      const defaultLeafId = path.join(fixtureRoot, "defaultLeaf.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./defaultBarrel";`,
          [defaultBarrelId]: `
            export { default } from "./defaultLeaf";
            export const button = { color: "red" } as const;
          `,
          [defaultLeafId]: `export default { color: "blue" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./defaultBarrel`]: defaultBarrelId,
          [`${defaultBarrelId}\0./defaultLeaf`]: defaultLeafId
        }
      });

      const { result: staticCssEval, provider: evaluator } =
        await createStaticCssEvalPrepass(fixturePath, provider);

      const namespace = evaluator.getResolvedCssValue({
        importerId: fixturePath,
        expressionStart: 0,
        expressionEnd: 6,
        bindingName: "styles",
        memberPath: []
      });
      expect(namespace).toMatchObject({
        kind: "resolved",
        value: { button: { color: "red" } }
      });
      if (namespace.kind === "resolved")
        expect(namespace.value).not.toHaveProperty("default");
      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./defaultBarrel" },
        { importerId: defaultBarrelId, importPath: "./defaultLeaf" }
      ]);
      expect(calls.loaded).toEqual([
        fixturePath,
        barrelId,
        defaultBarrelId,
        defaultLeafId
      ]);
      expect(staticCssEval.dependencyFiles).toEqual([
        barrelId,
        defaultBarrelId,
        defaultLeafId
      ]);
      expect(staticCssEval.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        defaultBarrelId,
        defaultLeafId
      ]);
      expect(staticCssEval.resolvedModuleCache.has(defaultBarrelId)).toBe(true);
      expect(staticCssEval.resolvedModuleCache.has(defaultLeafId)).toBe(true);
    });

    it("bounds export-star cycles in namespace async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-export-star-cycle"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const loopId = path.join(fixtureRoot, "loop.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./loop";`,
          [loopId]: `export * from "./barrel";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./loop`]: loopId,
          [`${loopId}\0./barrel`]: barrelId
        }
      });

      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for export-star cycle");
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./loop" },
        { importerId: loopId, importPath: "./barrel" }
      ]);
      expect(calls.loaded).toEqual([barrelId, loopId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([
        barrelId,
        loopId
      ]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
        owner: { file: fixturePath }
      });
    });

    it("keeps unresolved export-star namespace prepass failures bounded", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-unresolved-export-star"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./missing";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId
        }
      });

      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error(
          "Expected BabelTransformError for unresolved export-star"
        );
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./missing" }
      ]);
      expect(calls.loaded).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        owner: { file: fixturePath },
        dependency: { file: "./missing" },
        importPath: "./missing",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./missing",
          resolvedFile: "./missing",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
    });

    it("keeps package boundary export-star namespace prepass failures bounded", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;

      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-package-boundary-export-star"
      );

      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "@scope/styles";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId
        }
      });

      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error(
          "Expected BabelTransformError for package boundary export-star"
        );
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "@scope/styles" }
      ]);
      expect(calls.loaded).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        owner: { file: fixturePath },
        dependency: { file: "@scope/styles" },
        importPath: "@scope/styles",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "@scope/styles",
          resolvedFile: "@scope/styles",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
    });

    it("preserves whole-expression and scalar reexport runtime fallbacks", async () => {
      const wholeExpressionPath = await createBabelFixture(
        `
          import { button } from "./barrel";

          function App() {
            return <div css={button} />;
          }
        `,
        "css-prop-reexport-whole-expression"
      );

      const provider = createUnsupportedReexportStaticCssEvalProvider();
      const { result, code, staticCssEval } = await babelTransform(
        wholeExpressionPath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: provider
        }
      );

      expect(staticCssEval?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported-source",
            reason: "reexport-or-barrel",
            importPath: "./barrel",
            exportName: "button",
            dependency: { file: "/provider/barrel.ts" }
          })
        ])
      );

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(button)}");

      const staticRulePath = await createBabelFixture(
        `
          import { button } from "./barrel";

          function App() {
            return <div css={{ color: button }} />;
          }
        `,
        "css-prop-reexport-static-rule"
      );

      const scalar = await babelTransform(staticRulePath, {
        jsxCssProp: true,
        staticCssEvalProvider: provider
      });
      expect(scalar.code).toContain('import { button } from "./barrel"');
      expect(scalar.code).toMatch(/\(button(?:,|\))/);
      expect(scalar.result[1]).toContain("color:");
      expect(scalar.staticCssEval?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported-source",
            reason: "reexport-or-barrel",
            importPath: "./barrel",
            exportName: "button"
          })
        ])
      );
    });

    it("lowers representative logical css rule branches", async () => {
      const fixturePath = await createBabelFixture(
        `
          const andClass = "and-class";

          function App(providedClass: string, maybeClass: string | null) {
            return <>
              <div css={providedClass || { color: "red" }} />
              <div css={maybeClass ?? [{ color: "green" }]} />
              <div css={{ color: "blue" } || unreachableClass} />
              <div css={{ color: "yellow" } && andClass} />
              <div css={{ color: "purple" } && { color: "orange" }} />
            </>;
          }
        `,
        "css-prop-logical-rule-branches"
      );

      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });

      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];
      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);

      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);

      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css\/classname";/.exec(
          code
        );

      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const rightOrClassNameMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(providedClass \\|\\| ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);

      const rightNullishClassNameMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(maybeClass \\?\\? ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);

      const generatedOnlyClassNameMatches = [
        ...code.matchAll(/className=\{([A-Za-z_$][\w$]*)\}/g)
      ];

      const orangeCssMatches = [...sidecarSource.matchAll(/color: "orange"/g)];

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(exportedDeclarations).toHaveLength(4);
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "red"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\[\{\s*color: "green"\s*\}\]\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "blue"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "orange"\s*\}\);/s
      );
      expect(orangeCssMatches).toHaveLength(1);
      expect(code).not.toContain(" css=");
      expect(rightOrClassNameMatch).not.toBeNull();
      expect(rightNullishClassNameMatch).not.toBeNull();
      expect(sidecarRuntimeNames).toContain(rightOrClassNameMatch?.[1]);
      expect(sidecarRuntimeNames).toContain(rightNullishClassNameMatch?.[1]);
      expect(
        generatedOnlyClassNameMatches.some(([, className]) =>
          sidecarRuntimeNames.includes(className)
        )
      ).toBe(true);
      expect(
        generatedOnlyClassNameMatches.filter(([, className]) =>
          sidecarRuntimeNames.includes(className)
        )
      ).toHaveLength(2);
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(andClass\\)\\}`
        )
      );
      expect(`${code}\n${sidecarSource}`).not.toContain("unreachableClass");
      expect(`${code}\n${sidecarSource}`).not.toContain('color: "yellow"');
      expect(`${code}\n${sidecarSource}`).not.toContain('color: "purple"');
    });

    it("lowers representative recursive css prop branches", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { styles } from "./styles";

          const condition = true;
          const flag = false;
          const styleA = "style-a";

          function App() {
            return <>
              <div css={condition ? flag ? { color: "red" } : { color: "blue" } : styleA} />
              <div css={condition && flag && { color: "green" }} />
              <div css={{ color: "yellow" } && (condition && { color: "orange" })} />
              <div css={["base", ["nested", condition && { color: "purple" }]]} />
              <div css={condition ? styles.red : { color: "black" }} />
            </>;
          }
        `,
        "css-prop-recursive-branches"
      );

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            "styles.red": { color: "magenta" }
          })
        }
      );

      const [sidecarFile, sidecarSource] = result;
      const output = `${code}\n${sidecarSource}`;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];
      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);

      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);

      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css\/classname";/.exec(
          code
        );

      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const nestedConditionalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition \\? flag \\? ([A-Za-z_$][\\w$]*) : ([A-Za-z_$][\\w$]*) : styleA\\)\\}`
      ).exec(code);

      const chainedLogicalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition && flag && ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);

      const staticLeftLogicalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition && ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);

      const nestedArrayMatch = new RegExp(
        `className=\\{${escapeRegExp(cxIdentifier)}\\("base", ${escapeRegExp(
          cxIdentifier
        )}\\("nested", condition && ([A-Za-z_$][\\w$]*)\\)\\)\\}`
      ).exec(code);

      const providerBranchMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition \\? styles\\.red : ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);

      const generatedClassNames = [
        ...(nestedConditionalMatch?.slice(1) ?? []),
        chainedLogicalMatch?.[1],
        staticLeftLogicalMatch?.[1],
        nestedArrayMatch?.[1],
        providerBranchMatch?.[1]
      ].filter(
        (className): className is string => typeof className === "string"
      );

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarSource).toContain("@mincho-js/css");
      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(exportedDeclarations).toHaveLength(6);
      expect(generatedClassNames).toHaveLength(6);
      expect(new Set(generatedClassNames)).toHaveLength(6);

      for (const color of [
        "red",
        "blue",
        "green",
        "orange",
        "purple",
        "black"
      ]) {
        expect(sidecarSource).toContain(`color: "${color}"`);
      }

      for (const className of generatedClassNames) {
        expect(sidecarRuntimeNames).toContain(className);
      }

      expect(nestedConditionalMatch).not.toBeNull();
      expect(chainedLogicalMatch).not.toBeNull();
      expect(staticLeftLogicalMatch).not.toBeNull();
      expect(nestedArrayMatch).not.toBeNull();
      expect(providerBranchMatch).not.toBeNull();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={{");
      expect(code).not.toContain("css:");
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("_css(condition &&");
      expect(output).not.toContain("css(condition ?");
      expect(output).not.toContain("css(condition &&");
      expect(output).not.toContain('color: "yellow"');
      expect(output).not.toContain('color: "magenta"');
      expect(staticCssEval?.dependencies ?? []).toEqual([]);
      expect(staticCssEval?.resolvedModuleIds ?? []).toEqual([]);
    });

    it("leaves jsx css prop lowering disabled by default", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div className="base" css={{ color: "red" }} />;
          }
        `,
        "css-prop-disabled-default"
      );

      const { result, code } = await babelTransform(fixturePath);

      expect(result[1]).toBe("");
      expect(code).toContain('className="base"');
      expect(code).toContain("css={{");
      expect(code).toContain('color: "red"');
      expect(code).not.toContain("extracted_");
    });
  });
}

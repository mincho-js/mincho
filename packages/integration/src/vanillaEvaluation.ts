import {
  findCssScopeOrigin,
  resolveCssScopeOrigin,
  hasCssScopeRuntimeAcquisition,
  isCssScopeRuntimeFactoryName,
  snapshotCssScopeOrigins,
  validateCssScopeRuntimeOrigins,
  validateCssScopeRuntimeReceipts,
  createCssScopeRuntimeSession,
  type SerializedCssScopeRuntime,
  type CssScopeOrigin
} from "./fileScopeRuntime.js";
import { measureBundleBytes } from "./bundleSize.js";
import type { CompilerClassCandidate } from "@mincho-js/css/defineRules/registry";
/**
 * CSS adapter protocol adapted from @vanilla-extract/integration, MIT.
 * Copyright (c) 2021 SEEK. See THIRD_PARTY_NOTICES.md in this package.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Script, compileFunction, createContext, type Context } from "node:vm";
import { cachedDataVersionTag } from "node:v8";
import type { Adapter, FileScope } from "@vanilla-extract/css";
import * as adapter from "@vanilla-extract/css/adapter";
import * as fileScopeApi from "@vanilla-extract/css/fileScope";
import { transformCss } from "@vanilla-extract/css/transformCss";
import {
  processVanillaFile,
  serializeCss,
  serializeVanillaModule
} from "@vanilla-extract/integration";
import {
  currentCompilationExecution,
  type CompilationExecution
} from "./compilationExecution.js";
import {
  proveReusableEvaluation,
  proveCssScopeOwnership
} from "./evaluationProof.js";
import {
  executeStaticStyleProgram,
  readStaticStyleProgram,
  staticStyleModules,
  type StaticStyleProgram
} from "./staticStyles.js";
import {
  cacheDigest,
  configurationFiles,
  fingerprintFiles,
  unchangedFiles
} from "./compilationInputs.js";
import {
  compilerTokenReferences,
  replayCompilerTokenReferences
} from "@mincho-js/css/defineRules/registry";
import type { CompilerStyleResources } from "@mincho-js/css/defineRules/registry";
import {
  recordCompilationDiagnostic,
  measureCompilationPhase
} from "./diagnostics.js";
import {
  annotateVanillaCssArtifacts,
  collectSelectorCompositions,
  isolateVanillaCssArtifact,
  generateVanillaCss,
  type VanillaCssArtifact
} from "./vanillaCssIr.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: Rollup rewrites import.meta.url in CommonJS output.
const ownRequire = createRequire(import.meta.url);
const originalNodeEnv = process.env.NODE_ENV;
let compatible: boolean | undefined;

function compatibleAdapters(): boolean {
  if (compatible !== undefined) return compatible;

  try {
    const directory = dirname(
      dirname(ownRequire.resolve("@vanilla-extract/integration"))
    );

    const version = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8")
    ).version;
    const cssVersion = JSON.parse(
      readFileSync(
        ownRequire.resolve("@vanilla-extract/css/package.json"),
        "utf8"
      )
    ).version;
    compatible =
      (version === "8.0.10" || version === "8.0.11") &&
      (cssVersion === "1.20.1" || cssVersion === "1.21.3");
  } catch {
    compatible = false;
  }

  return compatible;
}

function sharesEvaluationAdapters(require: NodeRequire): boolean {
  return [
    "@vanilla-extract/css/adapter",
    "@vanilla-extract/css/fileScope"
  ].every((name) => require.resolve(name) === ownRequire.resolve(name));
}

/** Owned evaluation and replay require the compiler's adapter copy.
 * Only ordinary CSS text may decline ownership and run upstream instead.
 */
export function registeredEvaluationRequire(
  filePath: string,
  allowUpstreamText = false
): NodeRequire | undefined {
  const require = createRequire(resolve(filePath));
  try {
    if (sharesEvaluationAdapters(require)) return require;
  } catch (cause) {
    if (allowUpstreamText) return undefined;
    throw new Error(
      "Cannot resolve the compiler's vanilla-extract adapter for registered CSS evaluation",
      { cause }
    );
  }
  if (allowUpstreamText) return undefined;
  throw new Error(
    "Registered CSS evaluation requires the compiler's vanilla-extract adapter and fileScope instance"
  );
}

// This fixed script inventories standard VM globals; no authored code is inserted.
const standardVmGlobals = new Set<string>(
  new Script("Object.getOwnPropertyNames(globalThis)").runInNewContext()
);
const cssScopeBridge = "__mincho_internal_css_scope_bridge__";
function bindCssScopeFactory(context: Context, name: string, factory: unknown) {
  // This bootstrap executes before any authored code. Its only variable text
  // is the sealed compiler identifier, checked again at this syntax boundary.
  if (!isCssScopeRuntimeFactoryName(name))
    throw new Error("Invalid compiler CSS scope runtime factory identifier");
  Object.defineProperty(context, cssScopeBridge, {
    value: factory,
    configurable: true
  });
  try {
    new Script(
      "const " + name + " = __mincho_internal_css_scope_bridge__;"
    ).runInContext(context);
  } finally {
    Reflect.deleteProperty(context, cssScopeBridge);
  }
  if (Object.hasOwn(context, cssScopeBridge))
    throw new Error("Could not remove compiler CSS scope bootstrap bridge");
}
function freshNodeContext(
  require: NodeRequire,
  exports: object,
  module: object
): Context {
  // Match eval's includeGlobals behavior without exposing the private capability.
  const sandbox: Record<string, unknown> = Object.assign({}, global);
  for (const name of Object.getOwnPropertyNames(global))
    if (!standardVmGlobals.has(name)) sandbox[name] = Reflect.get(global, name);
  Object.assign(sandbox, { console, process, require, exports, module });
  sandbox.global = sandbox;
  return createContext(sandbox);
}

interface Prepared {
  bytes: number;
  reusable: boolean;
  cachedData?: Buffer;
}

class EvaluationPool {
  private context?: Context;
  private readonly entries = new Map<string, Prepared>();
  private bytes = 0;
  private leased = false;

  constructor(private readonly execution: CompilationExecution) {
    execution.onClose(() => {
      this.context = undefined;
      this.entries.clear();
      this.bytes = 0;
      pools.delete(execution);
    });
  }

  async prepare(
    source: string,
    filename: string,
    cssScopeOrigins?: readonly CssScopeOrigin[]
  ): Promise<Prepared> {
    const registration = validateCssScopeRuntimeOrigins(
      source,
      cssScopeOrigins
    );
    const factoryName = registration?.factoryName;
    const key = `script:${cacheDigest(JSON.stringify([filename, source, registration?.key, factoryName, cachedDataVersionTag(), registration ? "registered-script-v1" : "compile-function-fixed-params-v1"]))}`;
    const previous = this.entries.get(key);

    if (previous) {
      this.entries.delete(key);
      this.entries.set(key, previous);
      recordCompilationDiagnostic("vm-script-hit");

      return previous;
    }

    const proof = await measureCompilationPhase("vm-proof", async () =>
      proveReusableEvaluation(
        source,
        this.execution.cacheEnabled
          ? this.execution.compilationCache?.parser
          : undefined,
        { cssScopeOrigins: cssScopeOrigins ?? [] }
      )
    );

    const prepared: Prepared = {
      reusable: !!proof,
      bytes: Buffer.byteLength(source)
    };

    if (proof) {
      prepared.cachedData = await measureCompilationPhase(
        "vm-compile",
        async () => {
          const generate = () =>
            registration
              ? new Script(source, { filename }).createCachedData()
              : compileFunction(source, ["exports", "require", "module"], {
                  filename,
                  parsingContext: createContext({}),
                  produceCachedData: true
                }).cachedData!;
          const cache = this.execution.compilationCache;
          if (!cache) return generate();
          return cache.run(key, async () => {
            const value = generate();
            return {
              value,
              bytes: value.length,
              dependencies: [],
              manifest: { fingerprints: [] },
              valid: async () => true
            };
          });
        }
      );
    }

    if (this.execution.cacheEnabled && prepared.bytes <= 64 * 1024 * 1024) {
      this.entries.set(key, prepared);
      this.bytes += prepared.bytes;

      while (this.entries.size > 512 || this.bytes > 64 * 1024 * 1024) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes;
        this.entries.delete(oldest);
      }
    }

    return prepared;
  }

  async lease<T>(
    operation: (context: Context) => Promise<T>,
    fresh: () => Promise<T>
  ): Promise<T> {
    if (this.leased) {
      recordCompilationDiagnostic("vm-context-bypass", {
        reason: "concurrent-evaluation"
      });

      return fresh();
    }

    this.leased = true;

    try {
      const reused = !!this.context;
      this.context ??= await measureCompilationPhase(
        "vm-context-create",
        async () => createContext({})
      );
      recordCompilationDiagnostic(
        reused ? "vm-context-reuse" : "vm-context-new"
      );

      return await operation(this.context);
    } catch (error) {
      this.context = undefined;

      throw error;
    } finally {
      this.leased = false;
    }
  }
}

const pools = new WeakMap<CompilationExecution, EvaluationPool>();

type VirtualCssSerializer = NonNullable<
  Parameters<typeof processVanillaFile>[0]["serializeVirtualCssPath"]
>;
export type VanillaOptions = Omit<
  Parameters<typeof processVanillaFile>[0],
  "serializeVirtualCssPath"
> & {
  serializeVirtualCssPath?: (
    args: Parameters<VirtualCssSerializer>[0] & { readonly origin?: string }
  ) => ReturnType<VirtualCssSerializer>;
  /** Internal build adapter: return a JS marker import, without serializing CSS. */
  serializeCssArtifact?: (
    artifact: VanillaCssArtifact
  ) => string | Promise<string>;
  cssSourceFile?: string;
  cssSourceRoot?: string;
  /** Required for emitted CSS artifacts: pass compile().cssScopeOrigins.
   * Physical asset origins only; this does not grant evaluation authority. */
  cssScopeOrigins?: readonly CssScopeOrigin[];
  staticStyles?: boolean;
  symbolicTokens?: boolean;
  staticScopedCx?: boolean;
};

export interface SerializedVanillaEvaluation {
  readonly cssScopeRuntime?: SerializedCssScopeRuntime;
  readonly tokenReferences?: readonly string[];
  readonly artifacts?: readonly VanillaCssArtifact[];
  readonly css: readonly {
    fileName: string;
    origin?: string;
    fileScope: FileScope;
    source: string;
  }[];
  readonly exports: string;
}

export interface EvaluationCapture {
  beforeSerialize(): void;

  complete(value: SerializedVanillaEvaluation): void;
}

export function evaluationEnvironment(): unknown {
  return [originalNodeEnv, process.env.NODE_ENV, compatibleAdapters()];
}

function joinEvaluation(imports: readonly string[], exports: string): string {
  return [...imports, ...(exports ? [exports] : [])].join("\n");
}

function sameScopeOrigin(
  entry: CssScopeOrigin,
  scope: FileScope,
  origin: string
): boolean {
  return (
    entry.origin === origin &&
    entry.fileScope.filePath === scope.filePath &&
    (entry.fileScope.packageName || undefined) ===
      (scope.packageName || undefined)
  );
}

export async function serializeDefaultCssImport(
  fileName: string,
  source: string,
  mapSpecifier?: (specifier: string) => string
) {
  const cssId = `${fileName}?source=${await serializeCss(source)}`;
  const specifier = mapSpecifier ? mapSpecifier(cssId) : cssId;
  // Match upstream bytes for ordinary names; encode the entire specifier
  // otherwise, including names that need an apostrophe or backslash escaped.
  const simple =
    !/[^ -~]/.test(specifier) &&
    !specifier.includes("'") &&
    !specifier.includes("\\");
  return simple
    ? `import '${specifier}';`
    : `import ${JSON.stringify(specifier)};`;
}

export async function replayVanillaEvaluation(
  options: VanillaOptions,
  value: SerializedVanillaEvaluation
): Promise<string> {
  options = {
    ...options,
    cssScopeOrigins: snapshotCssScopeOrigins(options.cssScopeOrigins)
  };
  // Validate and publish the same records even across asynchronous callbacks.
  value = structuredClone(value);
  const runtimeRegistration = validateCssScopeRuntimeOrigins(
    options.source,
    options.cssScopeOrigins
  );
  if (runtimeRegistration) registeredEvaluationRequire(options.filePath);
  const receiptOrigins = runtimeRegistration
    ? validateCssScopeRuntimeReceipts(
        runtimeRegistration,
        value.cssScopeRuntime
      )
    : undefined;
  if (
    !runtimeRegistration &&
    (value.cssScopeRuntime ||
      (value.artifacts?.length &&
        hasCssScopeRuntimeAcquisition(options.source)))
  )
    throw new Error(
      "Missing CSS scope provenance: compiler runtime registration is required"
    );
  if (receiptOrigins)
    for (const css of value.css)
      if (
        css.origin !== undefined &&
        !receiptOrigins.some((entry) =>
          sameScopeOrigin(entry, css.fileScope, css.origin!)
        )
      )
        throw new Error("Mismatched cached CSS text origin");
  if (receiptOrigins)
    for (const artifact of value.artifacts ?? [])
      if (
        !receiptOrigins.some((entry) =>
          sameScopeOrigin(entry, artifact.fileScope, artifact.origin)
        )
      )
        throw new Error("Mismatched cached CSS artifact origin");
  if (options.symbolicTokens && value.tokenReferences)
    replayCompilerTokenReferences(value.tokenReferences);

  const imports: string[] = [];

  if (value.artifacts) {
    if (!options.serializeCssArtifact)
      throw new Error("Mincho CSS IR cache requires a chunk CSS collector");

    for (const artifact of value.artifacts)
      imports.push(
        await options.serializeCssArtifact(structuredClone(artifact))
      );
  }

  for (const css of value.css)
    imports.push(
      options.serializeVirtualCssPath
        ? await options.serializeVirtualCssPath(structuredClone(css))
        : await serializeDefaultCssImport(css.fileName, css.source)
    );

  return joinEvaluation(imports, value.exports);
}

/** Measure the same CSS and class payload for fresh, pooled and static evaluation. */
function compilerClassCost(filePath: string) {
  return (
    candidates: readonly CompilerClassCandidate[],
    metric: "raw" | "gzip" | "brotli"
  ): readonly number[] => {
    const costs = candidates.map((candidate) => {
      const css = generateVanillaCss({
        origin: filePath,
        fileScope: { filePath, packageName: "mincho-cost" },
        localClassNames: candidate.rules.map((rule) => rule.className),
        composedClassLists: [],
        usedCompositions: [],
        cssObjs: candidate.rules.map((rule) => ({
          type: "local",
          selector: rule.className,
          rule: rule.style as import("@vanilla-extract/css").StyleRule
        }))
      });
      return (
        measureBundleBytes(css)[metric] +
        measureBundleBytes(JSON.stringify(candidate.className))[metric]
      );
    });
    recordCompilationDiagnostic("bundle-size-class-strategy", {
      estimate: true,
      metric,
      original: costs[0],
      candidate: costs[1],
      applied: costs[1]! < costs[0]!
    });
    return costs;
  };
}

/** Evaluate through Vanilla Extract's public CommonJS module and CSS-text ABI. */
export function processVanillaCssText(
  options: Parameters<typeof processVanillaFile>[0]
): Promise<string> {
  const resourceRegistry = ownRequire(
    "@mincho-js/css/defineRules/registry"
  ) as {
    beginCompilerClassCost?: (
      cost: ReturnType<typeof compilerClassCost>
    ) => void;
    endCompilerClassCost?: () => void;
  };
  resourceRegistry.beginCompilerClassCost?.(
    compilerClassCost(options.filePath)
  );

  try {
    // Upstream evaluates synchronously before awaiting CSS serialization.
    // Release the shared callback before another evaluation can start.
    return processVanillaFile(options);
  } finally {
    resourceRegistry.endCompilerClassCost?.();
  }
}

export function processVanillaWithExecution(
  options: VanillaOptions
): Promise<string>;

export function processVanillaWithExecution<T>(
  options: VanillaOptions,
  consume: (source: string) => T | Promise<T>,
  capture?: EvaluationCapture
): Promise<T>;

export async function processVanillaWithExecution(
  options: VanillaOptions,
  consume: (source: string) => unknown = (source) => source,
  capture?: EvaluationCapture
): Promise<unknown> {
  options = {
    ...options,
    cssScopeOrigins: snapshotCssScopeOrigins(options.cssScopeOrigins)
  };
  const runtimeRegistration = validateCssScopeRuntimeOrigins(
    options.source,
    options.cssScopeOrigins
  );
  const registeredRequire =
    runtimeRegistration &&
    registeredEvaluationRequire(
      options.filePath,
      !options.serializeCssArtifact
    );
  if (options.serializeCssArtifact && !compatibleAdapters())
    throw new Error(
      "Mincho dist-chunk requires the validated @vanilla-extract/integration 8.0.10/8.0.11 and @vanilla-extract/css 1.20.1/1.21.3 adapters"
    );

  const fresh = async () => {
    // Unknown adapter versions or a different adapter copy retain upstream
    // CSS-text evaluation. Compiler
    // proxies already fall back to the public fileScope API without a lexical
    // capability. This path issues no origin receipts and bypasses our VM pool.
    if (
      options.serializeCssArtifact ||
      (registeredRequire && compatibleAdapters())
    )
      return consume(
        await evaluateVanilla(
          options,
          undefined,
          undefined,
          registeredRequire ?? createRequire(resolve(options.filePath)),
          capture
        )
      );

    let nativeOptions = options;
    const runtimeOwnership =
      registeredRequire && options.serializeVirtualCssPath
        ? proveCssScopeOwnership(options.source, {
            cssScopeOrigins: options.cssScopeOrigins ?? []
          })
        : undefined;
    const staticProgram =
      !runtimeRegistration &&
      options.staticStyles &&
      options.serializeVirtualCssPath
        ? readStaticStyleProgram(options.source)
        : undefined;
    const matchesStaticScope = (scope: FileScope) =>
      staticProgram !== undefined &&
      scope.filePath === staticProgram.scope.filePath &&
      (scope.packageName || undefined) ===
        (staticProgram.scope.packageName || undefined);
    const staticModules =
      staticProgram &&
      options.cssScopeOrigins?.some(
        ({ fileScope, runtime }) => !runtime && matchesStaticScope(fileScope)
      )
        ? staticStyleModules(staticProgram, options.filePath)
        : undefined;
    const ownership =
      runtimeOwnership ??
      (staticModules
        ? {
            modules: staticModules,
            cssScopeOrigins: options.cssScopeOrigins ?? []
          }
        : undefined);
    if (ownership && options.serializeVirtualCssPath) {
      const source = options.source;
      const serialize = options.serializeVirtualCssPath;
      const require = createRequire(resolve(options.filePath));
      let verify: (() => Promise<void>) | undefined;
      try {
        // Same public authoring APIs as the closed evaluator language. This
        // proves the upstream program's scope ownership, not adapter purity or
        // cache reuse, and assumes those APIs preserve the active file scope.
        const names = [
          ...new Set([
            ...ownership.modules,
            "@vanilla-extract/css/adapter",
            "@vanilla-extract/css/fileScope"
          ])
        ];
        const resolutions = new Map(
          names.map((name) => [name, require.resolve(name)])
        );
        for (const [name, path] of resolutions)
          if (ownRequire.resolve(name) !== path)
            throw new Error("Different upstream API instance");
        const directories = [
          ...new Set([...resolutions.values()].map(dirname))
        ];
        const siblings = (
          await Promise.all(
            directories.map(async (directory) =>
              (await readdir(directory))
                .filter((name) => /\.[cm]?js$/.test(name))
                .map((name) => join(directory, name))
            )
          )
        ).flat();
        const dependencies = new Set([
          ...resolutions.values(),
          ...directories,
          ...siblings,
          ...configurationFiles([options.filePath, ...resolutions.values()])
        ]);
        // Include already loaded transitive library implementations; never load
        // a module merely to collect provenance or alter Node's module cache.
        const visited = new Set<NodeJS.Module>();
        const visit = (module: NodeJS.Module | undefined) => {
          if (!module || visited.has(module)) return;
          visited.add(module);
          dependencies.add(module.filename);
          module.children.forEach(visit);
        };
        for (const path of resolutions.values())
          require.cache[path]?.children.forEach(visit);
        const fingerprints = await fingerprintFiles(dependencies);
        verify = async () => {
          if (
            options.source !== source ||
            (runtimeOwnership &&
              validateCssScopeRuntimeOrigins(source, options.cssScopeOrigins)
                ?.key !== runtimeOwnership.registrationKey) ||
            (staticProgram &&
              !staticStyleModules(staticProgram, options.filePath)) ||
            [...resolutions].some(
              ([name, path]) =>
                require.resolve(name) !== path ||
                ownRequire.resolve(name) !== path
            ) ||
            !(await unchangedFiles(fingerprints))
          )
            throw new Error(
              "CSS scope ownership inputs changed during upstream evaluation"
            );
        };
        await verify();
      } catch {
        // Missing/incompatible evidence retains the ordinary origin-free text
        // path; it cannot create an artifact or invent a physical base directory.
        verify = undefined;
      }
      if (verify) {
        const validate = verify;
        let validated: Promise<void> | undefined;
        nativeOptions = {
          ...options,
          serializeVirtualCssPath: async (args) => {
            // Upstream calls the serializer after synchronous evaluation.
            // Validate once before any serializer can mutate output directories.
            await (validated ??= validate());
            if (runtimeOwnership) {
              const origin = resolveCssScopeOrigin(
                args.fileScope,
                ownership.cssScopeOrigins
              );
              return serialize({ ...args, origin });
            }

            // The exact static program emits one scope. A mismatched upstream
            // callback cannot claim its origin, even with caller metadata.
            if (!matchesStaticScope(args.fileScope)) return serialize(args);
            const origin = findCssScopeOrigin(
              args.fileScope,
              ownership.cssScopeOrigins
            );
            return serialize(origin ? { ...args, origin } : args);
          }
        };
      }
    }

    return consume(await processVanillaCssText(nativeOptions));
  };

  const execution = currentCompilationExecution();

  if (
    options.staticStyles &&
    !runtimeRegistration &&
    execution?.evaluation !== "fresh" &&
    compatibleAdapters()
  ) {
    const program = readStaticStyleProgram(options.source);

    if (program && staticStyleModules(program, options.filePath)) {
      recordCompilationDiagnostic("static-styles-evaluate", { avoided: "vm" });

      return consume(
        await evaluateVanilla(
          options,
          undefined,
          undefined,
          createRequire(resolve(options.filePath)),
          capture,
          program
        )
      );
    }

    recordCompilationDiagnostic("evaluation-fallback", {
      reason: program ? "incompatible-static-modules" : "nonliteral-program",
      target: "vm"
    });
  }

  if (
    !execution ||
    !execution.cacheEnabled ||
    execution.evaluation === "fresh" ||
    !compatibleAdapters() ||
    (runtimeRegistration && !registeredRequire)
  )
    return fresh();

  if (fileScopeApi.hasFileScope()) {
    recordCompilationDiagnostic("vm-context-bypass", {
      reason: "active-file-scope"
    });

    return fresh();
  }

  let pool = pools.get(execution);

  if (!pool) pools.set(execution, (pool = new EvaluationPool(execution)));

  const prepared = await pool.prepare(
    options.source,
    options.filePath,
    options.cssScopeOrigins
  );

  if (!prepared.reusable || !prepared.cachedData) {
    recordCompilationDiagnostic("vm-context-bypass", {
      reason: "unproved-program"
    });

    return fresh();
  }

  const require = registeredRequire ?? createRequire(resolve(options.filePath));

  // Legacy unregistered execution can still use its existing fallback.
  try {
    if (!registeredRequire && !sharesEvaluationAdapters(require))
      return fresh();
  } catch {
    recordCompilationDiagnostic("vm-context-bypass", {
      reason: "protocol-unavailable"
    });

    return fresh();
  }

  // Registered scripts retain context-independent bytecode only. Each request
  // gets a fresh global and lexical environment, even on a cache hit.
  if (runtimeRegistration)
    return consume(
      await evaluateVanilla(
        options,
        prepared.cachedData,
        undefined,
        require,
        capture
      )
    );

  // Artifact collection belongs to the lease, so validation errors discard it.
  return pool.lease(
    async (context) =>
      consume(
        await evaluateVanilla(
          options,
          prepared.cachedData!,
          context,
          require,
          capture
        )
      ),
    fresh
  );
}

async function evaluateVanilla(
  {
    source: program,
    filePath,
    outputCss = true,
    identOption = process.env.NODE_ENV === "production" ? "short" : "debug",
    serializeVirtualCssPath,
    serializeCssArtifact,
    cssScopeOrigins,
    symbolicTokens = false
  }: VanillaOptions,
  cachedData: Buffer | undefined,
  context: Context | undefined,
  require: NodeRequire,
  capture?: EvaluationCapture,
  staticProgram?: StaticStyleProgram
): Promise<string> {
  // Preserve the emitting producer and lossless scope tuple at append time.
  // Merely opening another scope must not change ownership of existing rules.
  const cssByScope = new Map<
    string,
    {
      fileScope: FileScope;
      origin?: string;
      attributed: boolean;
      rules: Parameters<Adapter["appendCss"]>[0][];
    }
  >();
  const readScopeData = (
    scope: FileScope,
    allowMissingPackage = false
  ): FileScope => {
    const file = Object.getOwnPropertyDescriptor(scope, "filePath");
    const pkg = Object.getOwnPropertyDescriptor(scope, "packageName");
    if (
      !file ||
      !("value" in file) ||
      typeof file.value !== "string" ||
      (pkg
        ? !("value" in pkg) ||
          (pkg.value !== undefined && typeof pkg.value !== "string")
        : !allowMissingPackage || "packageName" in scope)
    )
      throw new Error(
        "Missing CSS scope provenance: invalid runtime scope instance fields"
      );
    return { filePath: file.value, packageName: pkg?.value };
  };
  const attestedScopeInstances = new WeakMap<
    object,
    { fileScope: FileScope; origin: string }
  >();
  const emittingOrigins = new Map<string, string>();
  const classNames = new Set<string>();
  const compositions: Parameters<Adapter["registerComposition"]>[0][] = [];
  const used = new Set<string>();
  const cssAdapter: Adapter = {
    appendCss(css, scope) {
      if (!outputCss) return;
      if (css.type === "keyframes")
        resourceRegistry.recordCompilerKeyframeRule?.(css.name);

      let keyScope = scope;
      let attributed = true;
      let emittingOrigin: string | undefined;
      if (runtimeRegistration) {
        assertScopeProtocol();
        const instance = attestedScopeInstances.get(scope);
        const data = readScopeData(scope, !instance);
        attributed =
          !!instance &&
          scopeProtocol.hasFileScope() &&
          scopeProtocol.getFileScope() === scope &&
          instance.fileScope.filePath === data.filePath &&
          instance.fileScope.packageName === data.packageName;
        keyScope = attributed ? instance!.fileScope : data;
        emittingOrigin = attributed ? instance!.origin : undefined;
        if (!attributed && serializeCssArtifact)
          throw new Error(
            "Missing CSS scope provenance: unattributed runtime scope instance"
          );
      }
      // Never read mutable/accessor-backed scope fields again after validation.
      const fileScope = {
        filePath: keyScope.filePath,
        packageName: keyScope.packageName || undefined
      };
      const tuple = JSON.stringify([fileScope.filePath, fileScope.packageName]);
      if (emittingOrigin !== undefined) {
        const previous = emittingOrigins.get(tuple);
        if (previous !== undefined && previous !== emittingOrigin)
          throw new Error(
            `Ambiguous CSS file scope "${fileScope.filePath}": multiple emitting producers`
          );
        emittingOrigins.set(tuple, emittingOrigin);
      }
      // Keep source order for a logical scope. Unknown emissions revoke its
      // physical origin; splitting by attribution would reorder the cascade.
      const key = tuple;
      const bucket = cssByScope.get(key) ?? {
        fileScope,
        origin: emittingOrigin,
        attributed,
        rules: []
      };
      if (!attributed) {
        bucket.attributed = false;
        bucket.origin = undefined;
      }
      bucket.rules.push(css);
      cssByScope.set(key, bucket);
    },

    registerClassName(name) {
      resourceRegistry.recordCompilerClass?.(name);
      classNames.add(name);
    },

    registerComposition(composition) {
      compositions.push(composition);
    },

    markCompositionUsed(name) {
      used.add(name);
    },

    onEndFileScope() {},

    getIdentOption: () => identOption
  };

  const nodeEnv = process.env.NODE_ENV;
  const evaluationAdapter =
    require("@vanilla-extract/css/adapter") as typeof adapter;

  const evaluationScope =
    require("@vanilla-extract/css/fileScope") as typeof fileScopeApi;

  const scopeProtocol = Object.freeze({
    setFileScope: evaluationScope.setFileScope,
    getFileScope: evaluationScope.getFileScope,
    hasFileScope: evaluationScope.hasFileScope,
    endFileScope: evaluationScope.endFileScope
  });
  const protocolDescriptors = Object.keys(scopeProtocol).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(evaluationScope, name)] as const
  );
  const assertScopeProtocol = () => {
    // Descriptor reads do not invoke an attacker-installed getter that merely
    // returns the original function while adding new observable effects.
    for (const [name, expected] of protocolDescriptors) {
      const actual = Object.getOwnPropertyDescriptor(evaluationScope, name);
      if (
        !actual ||
        !expected ||
        (
          [
            "value",
            "get",
            "set",
            "writable",
            "enumerable",
            "configurable"
          ] as const
        ).some((field) => actual[field] !== expected[field])
      )
        throw new Error("Changed compiler CSS scope runtime protocol");
    }
  };
  const baselineScope = scopeProtocol.hasFileScope()
    ? scopeProtocol.getFileScope()
    : undefined;
  const observedScopeInstances = new WeakSet<object>();
  const runtimeRegistration = validateCssScopeRuntimeOrigins(
    program,
    cssScopeOrigins
  );
  const runtimeSession =
    runtimeRegistration && createCssScopeRuntimeSession(runtimeRegistration);
  let scopeDepth = 0;
  let readingRegisteredExports = false;
  const restoreRegisteredScope = () => {
    // Restore the actual protocol stack to the original instance, not its tuple.
    while (
      scopeProtocol.hasFileScope() &&
      scopeProtocol.getFileScope() !== baselineScope
    )
      scopeProtocol.endFileScope();
    scopeDepth = 0;
    return Boolean(baselineScope && !scopeProtocol.hasFileScope());
  };
  const readRegisteredExports = <T>(read: () => T): T => {
    // Synchronous export reads may use the public scope protocol, without
    // recording producer evidence or reinstating the adapter or capture.
    readingRegisteredExports = true;
    let result: T;
    let removedEnclosingScope: boolean;
    try {
      result = read();
    } finally {
      readingRegisteredExports = false;
      removedEnclosingScope = restoreRegisteredScope();
    }
    if (removedEnclosingScope)
      throw new Error("CSS scope runtime removed its enclosing scope");
    return result;
  };
  const makeScopeFacade = (id?: string) => ({
    ...evaluationScope,
    setFileScope(...args: Parameters<typeof fileScopeApi.setFileScope>) {
      if (!runtimeRegistration) {
        evaluationScope.setFileScope(...args);
        scopeDepth++;
        return;
      }
      if (!readingRegisteredExports) runtimeSession!.assertActive();
      assertScopeProtocol();
      const protocol = scopeProtocol;
      const previous = protocol.hasFileScope()
        ? protocol.getFileScope()
        : undefined;
      protocol.setFileScope(...args);
      const scope = protocol.getFileScope();
      if (
        runtimeRegistration &&
        (scope === previous || observedScopeInstances.has(scope))
      )
        throw new Error("Stale compiler CSS scope runtime scope instance");
      observedScopeInstances.add(scope);
      scopeDepth++;
      // Record only after a successful genuine scope push, not a reused object.
      if (id && !readingRegisteredExports) {
        const data = readScopeData(scope);
        runtimeSession!.record(id, data);
        attestedScopeInstances.set(scope, {
          fileScope: data,
          origin: runtimeRegistration.origins.get(id)!
        });
      }
    },
    endFileScope() {
      if (scopeDepth <= 0) throw new Error("Unbalanced Mincho file scope");
      if (runtimeRegistration) {
        if (!readingRegisteredExports) runtimeSession!.assertActive();
        assertScopeProtocol();
      }
      try {
        (runtimeRegistration ? scopeProtocol : evaluationScope).endFileScope();
      } finally {
        scopeDepth--;
      }
    }
  });
  const producerFacades = new Map<string, ReturnType<typeof makeScopeFacade>>();
  const runtimeFactory = (id: string) => {
    if (!runtimeRegistration?.origins.has(id))
      throw new Error("Unknown compiler CSS scope runtime capability");
    let facade = producerFacades.get(id);
    if (!facade) {
      const rejectMutation = () => {
        throw new Error("Cannot mutate compiler CSS scope runtime facade");
      };
      facade = new Proxy(Object.freeze(makeScopeFacade(id)), {
        set: rejectMutation,
        defineProperty: rejectMutation,
        deleteProperty: rejectMutation,
        setPrototypeOf: rejectMutation,
        preventExtensions: rejectMutation
      });
      producerFacades.set(id, facade);
    }
    return facade;
  };
  // Public CommonJS acquisitions share a module object for this evaluation,
  // without receiving the compiler-issued producer facade or its authority.
  let publicScopeFacade: ReturnType<typeof makeScopeFacade> | undefined;
  const scopedRequire = Object.assign(
    (name: string) =>
      name === "@vanilla-extract/css/fileScope"
        ? (publicScopeFacade ??= makeScopeFacade())
        : require(name),
    require
  );

  const resourceRegistry = ownRequire(
    "@mincho-js/css/defineRules/registry"
  ) as {
    beginCompilerResourceCapture?: () => Set<string>;
    endCompilerResourceCapture?: () => void;
    beginCompilerStyleCapture?: () => CompilerStyleResources;
    endCompilerStyleCapture?: () => void;
    recordCompilerClass?: (name: string) => void;
    recordCompilerKeyframeRule?: (name: string) => void;
    beginCompilerClassCost?: (
      cost: (
        candidates: readonly CompilerClassCandidate[],
        metric: "raw" | "gzip" | "brotli"
      ) => readonly number[]
    ) => void;
    endCompilerClassCost?: () => void;
  };

  let generatedVariables: Set<string> | undefined;
  let generatedResources: CompilerStyleResources | undefined;
  const exports = {};
  const module = {
    exports,
    filename: filePath,
    id: filePath,
    require: scopedRequire
  };
  let registeredExports = module.exports;

  try {
    await measureCompilationPhase(
      staticProgram ? "static-styles-execute" : "vm-evaluate",
      async () => {
        let removedEnclosingScope = false;
        let registeredRealm: ReturnType<typeof freshNodeContext> | undefined;
        try {
          if (originalNodeEnv !== undefined)
            process.env.NODE_ENV = originalNodeEnv;
          else if (runtimeRegistration && !serializeCssArtifact)
            // Upstream assigns its captured value to process.env, which
            // converts undefined into a string on real Node processes.
            process.env.NODE_ENV = "undefined";
          else delete process.env.NODE_ENV;

          evaluationAdapter.setAdapter(cssAdapter);

          try {
            resourceRegistry.beginCompilerClassCost?.(
              compilerClassCost(filePath)
            );

            if (
              serializeCssArtifact &&
              resourceRegistry.beginCompilerStyleCapture &&
              resourceRegistry.endCompilerStyleCapture
            )
              generatedResources = resourceRegistry.beginCompilerStyleCapture();

            if (
              serializeCssArtifact &&
              resourceRegistry.beginCompilerResourceCapture &&
              resourceRegistry.endCompilerResourceCapture
            )
              generatedVariables =
                resourceRegistry.beginCompilerResourceCapture();

            if (staticProgram) {
              module.exports = executeStaticStyleProgram(
                staticProgram,
                scopedRequire
              );
            } else if (runtimeRegistration) {
              // Match eval's parent identity metadata without exposing its
              // host Module (and its require/cache) to the authored script.
              ownRequire("eval");
              const parent =
                ownRequire.cache[ownRequire.resolve("eval")]?.parent;
              Object.defineProperty(module, "parent", {
                value: parent
                  ? Object.freeze({
                      id: parent.id,
                      filename: parent.filename,
                      path: parent.path,
                      loaded: parent.loaded
                    })
                  : parent,
                enumerable: true,
                configurable: true,
                writable: true
              });
              const script = new Script(program, {
                filename: filePath,
                cachedData
              });
              if (script.cachedDataRejected)
                recordCompilationDiagnostic("vm-cached-data-rejected");
              const realm = freshNodeContext(scopedRequire, exports, module);
              if (cachedData) recordCompilationDiagnostic("vm-context-new");
              bindCssScopeFactory(
                realm,
                runtimeRegistration.factoryName,
                runtimeFactory
              );
              script.runInContext(realm);
              registeredRealm = realm;
            } else if (!cachedData || !context) {
              const evalCode = ownRequire("eval") as (
                source: string,
                filename: string,
                scope: object,
                globals: boolean
              ) => object;
              module.exports = evalCode(
                program,
                filePath,
                { console, process, require: scopedRequire },
                true
              );
            } else {
              // The legacy unregistered evaluator keeps its existing lease.
              const evaluate = compileFunction(
                program,
                ["exports", "require", "module"],
                { filename: filePath, parsingContext: context, cachedData }
              );
              if (evaluate.cachedDataRejected)
                recordCompilationDiagnostic("vm-cached-data-rejected");
              evaluate(exports, scopedRequire, module);
            }
          } finally {
            // Revoke compiler capabilities synchronously, including on failure.
            // No queued Promise callback may push a scope after evaluation.
            runtimeSession?.close(true);
            try {
              if (runtimeRegistration) {
                // A raw acquisition can bypass our depth counter.
                removedEnclosingScope = restoreRegisteredScope();
              } else {
                while (scopeDepth > 0) {
                  scopeDepth--;
                  evaluationScope.endFileScope();
                }
              }
            } finally {
              try {
                if (generatedVariables)
                  resourceRegistry.endCompilerResourceCapture!();
              } finally {
                try {
                  if (generatedResources)
                    resourceRegistry.endCompilerStyleCapture!();
                } finally {
                  try {
                    resourceRegistry.endCompilerClassCost?.();
                  } finally {
                    evaluationAdapter.removeAdapter();
                  }
                }
              }
            }
          }
          if (removedEnclosingScope)
            throw new Error("CSS scope runtime removed its enclosing scope");
          // Like upstream eval, read the resulting realm module once after
          // adapter teardown, while the evaluation NODE_ENV is still active.
          const realm = registeredRealm;
          if (realm)
            registeredExports = readRegisteredExports(
              () => (realm.module as typeof module).exports
            );
        } finally {
          if (nodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = nodeEnv;
        }
      }
    );
  } catch (error) {
    runtimeSession?.close(false);
    throw error;
  }
  runtimeSession?.close(true);
  const observedRuntime = runtimeSession?.snapshot();
  // Publication receipts describe actual contributors, not every opened scope.
  // Empty sibling scopes cannot authorize a different origin during replay.
  const contributingScopes = new Set(
    [...cssByScope.values()].flatMap((bucket) =>
      bucket.origin === undefined
        ? []
        : [
            JSON.stringify([
              bucket.origin,
              bucket.fileScope.filePath,
              bucket.fileScope.packageName || undefined
            ])
          ]
    )
  );
  const cssScopeRuntime = observedRuntime && {
    ...observedRuntime,
    receipts: observedRuntime.receipts.filter((receipt) =>
      contributingScopes.has(
        JSON.stringify([
          receipt.origin,
          receipt.fileScope.filePath,
          receipt.fileScope.packageName || undefined
        ])
      )
    )
  };
  const receiptOrigins = runtimeRegistration
    ? validateCssScopeRuntimeReceipts(runtimeRegistration, cssScopeRuntime)
    : undefined;

  if (
    serializeCssArtifact &&
    cssByScope.size &&
    !runtimeRegistration &&
    hasCssScopeRuntimeAcquisition(program)
  )
    throw new Error(
      "Missing CSS scope provenance: compiler runtime registration is required"
    );

  capture?.beforeSerialize();

  const cssImports: string[] = [];
  const serializedCss: SerializedVanillaEvaluation["css"][number][] = [];
  // Package/file scope strings do not uniquely identify physical producers.
  // Even an owner-shaped scope may come from another instance of that package.
  const origin = (scope: FileScope) =>
    resolveCssScopeOrigin(scope, receiptOrigins ?? cssScopeOrigins ?? []);

  let artifacts: VanillaCssArtifact[] | undefined = serializeCssArtifact
    ? [...cssByScope.values()].map((bucket) =>
        structuredClone({
          origin: bucket.origin ?? origin(bucket.fileScope),
          fileScope: bucket.fileScope,
          cssObjs: bucket.rules,
          localClassNames: [...classNames],
          composedClassLists: compositions,
          usedCompositions: [...used]
        })
      )
    : undefined;

  if (artifacts) {
    collectSelectorCompositions(artifacts, used);
    artifacts = artifacts.map((artifact) =>
      isolateVanillaCssArtifact({ ...artifact, usedCompositions: [...used] })
    );
  }

  const serializeExports = () => {
    const unused = compositions
      .filter(({ identifier }) => !used.has(identifier))
      .map(({ identifier }) => identifier);

    const serialize = () =>
      serializeVanillaModule(
        [],
        runtimeRegistration ? registeredExports : module.exports,
        unused.length ? new RegExp(`(${unused.join("|")})\\s`, "g") : null
      );
    return runtimeRegistration ? readRegisteredExports(serialize) : serialize();
  };

  let exportsSource = artifacts ? serializeExports() : undefined;

  if (artifacts) {
    annotateVanillaCssArtifacts(
      artifacts,
      [exportsSource!],
      [...(generatedVariables ?? [])],
      generatedResources
    );

    for (const artifact of artifacts) {
      cssImports.push(await serializeCssArtifact!(structuredClone(artifact)));
    }
  }

  const textBuckets = serializeCssArtifact
    ? []
    : [...cssByScope.values()].map((bucket) => ({
        bucket,
        cssOrigin: bucket.attributed
          ? (bucket.origin ??
            findCssScopeOrigin(
              bucket.fileScope,
              receiptOrigins ?? cssScopeOrigins ?? []
            ))
          : undefined
      }));
  for (const { bucket, cssOrigin } of textBuckets) {
    const cssObjs = bucket.rules;

    const fileScope = bucket.fileScope;
    let source: string;
    adapter.setAdapter(cssAdapter);

    try {
      source = transformCss({
        localClassNames: [...classNames],
        composedClassLists: compositions,
        cssObjs
      }).join("\n");
    } finally {
      adapter.removeAdapter();
    }

    const fileName = `${fileScope.filePath}.vanilla.css`;
    if (capture)
      serializedCss.push({
        fileName,
        ...(cssOrigin ? { origin: cssOrigin } : {}),
        fileScope: structuredClone(fileScope),
        source
      });

    cssImports.push(
      serializeVirtualCssPath
        ? await serializeVirtualCssPath({
            fileName,
            fileScope,
            source,
            ...(cssOrigin ? { origin: cssOrigin } : {})
          })
        : await serializeDefaultCssImport(fileName, source)
    );
  }

  exportsSource ??= serializeExports();
  capture?.complete({
    ...(cssScopeRuntime ? { cssScopeRuntime } : {}),
    css: serializedCss,
    artifacts,
    exports: exportsSource,
    ...(symbolicTokens ? { tokenReferences: compilerTokenReferences() } : {})
  });

  return joinEvaluation(cssImports, exportsSource);
}

/**
 * CSS adapter protocol adapted from @vanilla-extract/integration, MIT.
 * Copyright (c) 2021 SEEK. See THIRD_PARTY_NOTICES.md in this package.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Script, createContext, type Context } from "node:vm";
import { cachedDataVersionTag } from "node:v8";
import type { Adapter, FileScope } from "@vanilla-extract/css";
import * as adapter from "@vanilla-extract/css/adapter";
import * as fileScopeApi from "@vanilla-extract/css/fileScope";
import { transformCss } from "@vanilla-extract/css/transformCss";
import {
  parseFileScope,
  getPackageInfo,
  processVanillaFile,
  serializeCss,
  serializeVanillaModule,
  stringifyFileScope
} from "@vanilla-extract/integration";
import {
  currentCompilationExecution,
  type CompilationExecution
} from "./compilationExecution.js";
import { proveReusableEvaluation } from "./evaluationProof.js";
import {
  executeStaticStyleProgram,
  readStaticStyleProgram,
  staticStyleModules,
  type StaticStyleProgram
} from "./staticStyles.js";
import { cacheDigest } from "./compilationInputs.js";
import {
  recordCompilationDiagnostic,
  measureCompilationPhase
} from "./diagnostics.js";
import {
  annotateVanillaCssArtifacts,
  collectSelectorCompositions,
  isolateVanillaCssArtifact,
  type VanillaCssArtifact
} from "./vanillaCssIr.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: Rollup rewrites import.meta.url in CommonJS output.
const ownRequire = createRequire(import.meta.url);
const originalNodeEnv = process.env.NODE_ENV;
let compatible: boolean | undefined;

function compatibleIntegration(): boolean {
  if (compatible !== undefined) return compatible;

  try {
    const directory = dirname(
      dirname(ownRequire.resolve("@vanilla-extract/integration"))
    );

    const version = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8")
    ).version;
    compatible = version === "8.0.10" || version === "8.0.11";
  } catch {
    compatible = false;
  }

  return compatible;
}

interface Prepared {
  bytes: number;
  reusable: boolean;
  script?: Script;
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

  async prepare(source: string, filename: string): Promise<Prepared> {
    const key = `script:${cacheDigest(JSON.stringify([filename, source, cachedDataVersionTag(), "module-wrapper-v1"]))}`;
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
          : undefined
      )
    );

    const prepared: Prepared = {
      reusable: !!proof,
      bytes: Buffer.byteLength(source)
    };

    if (proof) {
      const wrapped = `(function (exports, require, module) {\n${source}\n})`;
      prepared.script = await measureCompilationPhase(
        "vm-compile",
        async () => {
          const cache = this.execution.compilationCache;
          if (!cache) return new Script(wrapped, { filename, lineOffset: -1 });

          let script: Script | undefined;
          const cached = await cache.run(key, async () => {
            script = new Script(wrapped, { filename, lineOffset: -1 });

            const value = script.createCachedData();

            return {
              value,
              bytes: value.length,
              dependencies: [],
              manifest: { fingerprints: [] },

              valid: async () => true
            };
          });

          script ??= new Script(wrapped, {
            filename,
            lineOffset: -1,
            cachedData: cached
          });

          if (script.cachedDataRejected)
            recordCompilationDiagnostic("vm-cached-data-rejected");

          return script;
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

export type VanillaOptions = Parameters<typeof processVanillaFile>[0] & {
  /** Internal build adapter: return a JS marker import, without serializing CSS. */
  serializeCssArtifact?: (
    artifact: VanillaCssArtifact
  ) => string | Promise<string>;
  cssSourceFile?: string;
  cssSourceRoot?: string;
  staticStyles?: boolean;
};

export interface SerializedVanillaEvaluation {
  readonly artifacts?: readonly VanillaCssArtifact[];
  readonly css: readonly {
    fileName: string;
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
  return [originalNodeEnv, process.env.NODE_ENV, compatibleIntegration()];
}

function joinEvaluation(imports: readonly string[], exports: string): string {
  return [...imports, ...(exports ? [exports] : [])].join("\n");
}

export async function replayVanillaEvaluation(
  options: VanillaOptions,
  value: SerializedVanillaEvaluation
): Promise<string> {
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
        : `import '${css.fileName}?source=${await serializeCss(css.source)}';`
    );

  return joinEvaluation(imports, value.exports);
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
  if (options.serializeCssArtifact && !compatibleIntegration())
    throw new Error(
      "Mincho dist-chunk requires @vanilla-extract/integration 8.0.10 and @vanilla-extract/css 1.20.1"
    );

  const fresh = async () =>
    consume(
      options.serializeCssArtifact
        ? await evaluateVanilla(
            options,
            undefined,
            undefined,
            createRequire(resolve(options.filePath)),
            capture
          )
        : await processVanillaFile(options)
    );

  const execution = currentCompilationExecution();

  if (
    options.staticStyles &&
    execution?.evaluation !== "fresh" &&
    compatibleIntegration()
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
  }

  if (
    !execution ||
    !execution.cacheEnabled ||
    execution.evaluation === "fresh" ||
    !compatibleIntegration()
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

  const prepared = await pool.prepare(options.source, options.filePath);

  if (!prepared.reusable || !prepared.script) {
    recordCompilationDiagnostic("vm-context-bypass", {
      reason: "unproved-program"
    });

    return fresh();
  }

  const require = createRequire(resolve(options.filePath));

  // Adapter/fileScope identity must agree with the compiler's host modules.
  try {
    for (const name of [
      "@vanilla-extract/css/adapter",
      "@vanilla-extract/css/fileScope"
    ])
      if (require.resolve(name) !== ownRequire.resolve(name)) return fresh();
  } catch {
    recordCompilationDiagnostic("vm-context-bypass", {
      reason: "protocol-unavailable"
    });

    return fresh();
  }

  // Artifact collection belongs to the lease, so validation errors discard it.
  return pool.lease(
    async (context) =>
      consume(
        await evaluateVanilla(
          options,
          prepared.script!,
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
    cssSourceFile = filePath,
    cssSourceRoot = process.cwd()
  }: VanillaOptions,
  script: Script | undefined,
  context: Context | undefined,
  require: NodeRequire,
  capture?: EvaluationCapture,
  staticProgram?: StaticStyleProgram
): Promise<string> {
  const cssByScope = new Map<string, Parameters<Adapter["appendCss"]>[0][]>();
  const classNames = new Set<string>();
  const compositions: Parameters<Adapter["registerComposition"]>[0][] = [];
  const used = new Set<string>();
  const cssAdapter: Adapter = {
    appendCss(css, scope) {
      if (!outputCss) return;

      const key = stringifyFileScope(scope);
      const rules = cssByScope.get(key) ?? [];
      rules.push(css);
      cssByScope.set(key, rules);
    },

    registerClassName(name) {
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

  let scopeDepth = 0;
  const scopedRequire = Object.assign(
    (name: string) =>
      name === "@vanilla-extract/css/fileScope"
        ? {
            ...evaluationScope,

            setFileScope(
              ...args: Parameters<typeof fileScopeApi.setFileScope>
            ) {
              evaluationScope.setFileScope(...args);
              scopeDepth++;
            },

            endFileScope() {
              if (scopeDepth <= 0)
                throw new Error("Unbalanced Mincho file scope");

              try {
                evaluationScope.endFileScope();
              } finally {
                scopeDepth--;
              }
            }
          }
        : require(name),
    require
  );

  const resourceRegistry = (
    serializeCssArtifact
      ? ownRequire("@mincho-js/css/defineRules/registry")
      : {}
  ) as {
    beginCompilerResourceCapture?: () => Set<string>;
    endCompilerResourceCapture?: () => void;
  };

  let generatedVariables: Set<string> | undefined;
  const exports = {};
  const module = {
    exports,
    filename: filePath,
    id: filePath,
    require: scopedRequire
  };

  await measureCompilationPhase(
    staticProgram ? "static-styles-execute" : "vm-evaluate",
    async () => {
      try {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;

        evaluationAdapter.setAdapter(cssAdapter);

        try {
          if (
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
          } else if (!script || !context) {
            // Match upstream's fresh eval sandbox, including Node globals and
            // CommonJS exports, while retaining balanced adapter/scope cleanup.
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
            const evaluate = script.runInContext(context) as (
              exports: object,
              require: typeof scopedRequire,
              module: object
            ) => void;

            evaluate(exports, scopedRequire, module);
          }
        } finally {
          try {
            while (scopeDepth > 0) {
              scopeDepth--;
              evaluationScope.endFileScope();
            }
          } finally {
            try {
              if (generatedVariables)
                resourceRegistry.endCompilerResourceCapture!();
            } finally {
              evaluationAdapter.removeAdapter();
            }
          }
        }
      } finally {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
      }
    }
  );

  capture?.beforeSerialize();

  const cssImports: string[] = [];
  const serializedCss: SerializedVanillaEvaluation["css"][number][] = [];
  const sourcePackage = serializeCssArtifact
    ? getPackageInfo(dirname(cssSourceFile))
    : undefined;

  const origin = (scope: FileScope) =>
    sourcePackage &&
    scope.packageName === sourcePackage.name &&
    scope.filePath ===
      relative(sourcePackage.dirname, cssSourceFile).replace(/\\/g, "/")
      ? cssSourceFile
      : resolve(cssSourceRoot, scope.filePath);

  let artifacts: VanillaCssArtifact[] | undefined = serializeCssArtifact
    ? [...cssByScope].map(([key, cssObjs]) =>
        structuredClone({
          origin: origin(parseFileScope(key)),
          fileScope: parseFileScope(key),
          cssObjs,
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

    return serializeVanillaModule(
      [],
      module.exports,
      unused.length ? new RegExp(`(${unused.join("|")})\\s`, "g") : null
    );
  };

  let exportsSource = artifacts ? serializeExports() : undefined;

  if (artifacts) {
    annotateVanillaCssArtifacts(
      artifacts,
      [exportsSource!],
      [...(generatedVariables ?? [])]
    );

    for (const artifact of artifacts) {
      cssImports.push(await serializeCssArtifact!(structuredClone(artifact)));
    }
  }

  for (const [key, cssObjs] of cssByScope) {
    if (serializeCssArtifact) break;

    const fileScope: FileScope = parseFileScope(key);
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
        fileScope: structuredClone(fileScope),
        source
      });

    cssImports.push(
      serializeVirtualCssPath
        ? await serializeVirtualCssPath({ fileName, fileScope, source })
        : `import '${fileName}?source=${await serializeCss(source)}';`
    );
  }

  exportsSource ??= serializeExports();
  capture?.complete({ css: serializedCss, artifacts, exports: exportsSource });

  return joinEvaluation(cssImports, exportsSource);
}

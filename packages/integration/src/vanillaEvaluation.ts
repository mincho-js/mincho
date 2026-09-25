/**
 * CSS adapter protocol adapted from @vanilla-extract/integration, MIT.
 * Copyright (c) 2021 SEEK. See THIRD_PARTY_NOTICES.md in this package.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Script, createContext, type Context } from "node:vm";
import { cachedDataVersionTag } from "node:v8";
import type { Adapter, FileScope } from "@vanilla-extract/css";
import * as adapter from "@vanilla-extract/css/adapter";
import * as fileScopeApi from "@vanilla-extract/css/fileScope";
import { transformCss } from "@vanilla-extract/css/transformCss";
import {
  parseFileScope,
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
import { cacheDigest } from "./compilationInputs.js";
import {
  recordCompilationDiagnostic,
  measureCompilationPhase
} from "./diagnostics.js";

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

type VanillaOptions = Parameters<typeof processVanillaFile>[0];

export interface SerializedVanillaEvaluation {
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
  const fresh = async () => consume(await processVanillaFile(options));

  const execution = currentCompilationExecution();
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
    filePath,
    outputCss = true,
    identOption = process.env.NODE_ENV === "production" ? "short" : "debug",
    serializeVirtualCssPath
  }: Parameters<typeof processVanillaFile>[0],
  script: Script,
  context: Context,
  require: NodeRequire,
  capture?: EvaluationCapture
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
  let scopeDepth = 0;

  const scopedRequire = (name: string) =>
    name === "@vanilla-extract/css/fileScope"
      ? {
          ...fileScopeApi,
          setFileScope(...args: Parameters<typeof fileScopeApi.setFileScope>) {
            fileScopeApi.setFileScope(...args);
            scopeDepth++;
          },

          endFileScope() {
            if (scopeDepth <= 0)
              throw new Error("Unbalanced Mincho file scope");

            try {
              fileScopeApi.endFileScope();
            } finally {
              scopeDepth--;
            }
          }
        }
      : require(name);

  const exports = {};
  const module = {
    exports,
    filename: filePath,
    id: filePath,
    require: scopedRequire
  };

  await measureCompilationPhase("vm-evaluate", async () => {
    try {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;

      adapter.setAdapter(cssAdapter);

      try {
        const evaluate = script.runInContext(context) as (
          exports: object,
          require: typeof scopedRequire,
          module: object
        ) => void;

        evaluate(exports, scopedRequire, module);
      } finally {
        try {
          while (scopeDepth > 0) {
            scopeDepth--;
            fileScopeApi.endFileScope();
          }
        } finally {
          adapter.removeAdapter();
        }
      }
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  capture?.beforeSerialize();

  const cssImports: string[] = [];
  const serializedCss: SerializedVanillaEvaluation["css"][number][] = [];

  for (const [key, cssObjs] of cssByScope) {
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

  const unused = compositions
    .filter(({ identifier }) => !used.has(identifier))
    .map(({ identifier }) => identifier);

  const exportsSource = serializeVanillaModule(
    [],
    module.exports,
    unused.length ? new RegExp(`(${unused.join("|")})\\s`, "g") : null
  );

  capture?.complete({ css: serializedCss, exports: exportsSource });

  return joinEvaluation(cssImports, exportsSource);
}

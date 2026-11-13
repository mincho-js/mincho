import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import defaultEsbuild, {
  type BuildOptions,
  type Metafile,
  type OnResolveArgs,
  type Plugin,
  type ResolveResult
} from "esbuild";
import type { CompileOptions } from "./compile.js";
import { canonicalFilePath } from "./canonicalPath.js";
import {
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";
import { internalStripStaticCssEvalRequestQuery } from "./staticCssEvalUtils.js";

interface ResolutionRequest {
  specifier: string;
  importer: string;
  namespace: string;
  resolveDir: string;
  kind: OnResolveArgs["kind"];
  with: Record<string, string>;
}

interface ResolutionIdentity {
  path: string;
  namespace: string;
  suffix: string;
  external: boolean;
  sideEffects: boolean;
  physicalPath: string | null;
}

export interface CompileResolutionManifest {
  readonly version: 1;
  readonly records: readonly {
    readonly request: ResolutionRequest;
    readonly result: ResolutionIdentity;
  }[];
}

/** Compilation and proof replay must use the same native resolver settings. */
export function compilationResolutionOptions(
  options: CompileOptions
): BuildOptions {
  return {
    absWorkingDir: options.cwd ?? process.cwd(),
    platform: "node",
    external: [
      "@vanilla-extract",
      "@mincho-js/css",
      ...(options.externals ?? [])
    ],
    alias: options.alias,
    loader: options.loader
  };
}

export function resolvedImportPlugin(options: CompileOptions): Plugin[] {
  const mappings = options.resolvedImports;
  if (!mappings) return [];
  return [
    {
      name: "mincho:resolved-imports",
      setup(build) {
        build.onResolve({ filter: /.*/ }, async ({ path, importer }) =>
          importer === options.filePath && Object.hasOwn(mappings, path)
            ? { path: await canonicalFilePath(mappings[path]!) }
            : undefined
        );
      }
    }
  ];
}

async function resolutionIdentity(
  result: ResolveResult
): Promise<ResolutionIdentity | undefined> {
  if (
    result.errors.length ||
    (!result.external &&
      (result.namespace !== "file" || !isAbsolute(result.path)))
  )
    return;
  return {
    path: result.path,
    namespace: result.namespace,
    suffix: result.suffix,
    external: result.external,
    sideEffects: result.sideEffects,
    physicalPath: result.external ? null : await realpath(result.path)
  };
}

export function createCompileResolutionObserver(options: CompileOptions) {
  const resolving = {};
  const records = new Map<
    string,
    CompileResolutionManifest["records"][number]
  >();
  let unknown = false;
  let started = false;
  const context = compilationResolutionOptions(options);
  const contextKeys = [
    ...Object.keys(context),
    "conditions",
    "mainFields",
    "nodePaths",
    "packages",
    "preserveSymlinks",
    "resolveExtensions",
    "tsconfig",
    "tsconfigRaw"
  ] as const;
  const signature = (value: BuildOptions) =>
    JSON.stringify(contextKeys.map((key) => value[key as keyof BuildOptions]));
  const expectedContext = signature(context);
  const plugin: Plugin = {
    name: "mincho:compile-resolution-proof",
    setup(build) {
      build.onStart(() => {
        started = true;
        if (signature(build.initialOptions) !== expectedContext) unknown = true;
      });
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolving || unknown) return;
        if (args.pluginData != null || !["file", ""].includes(args.namespace)) {
          unknown = true;
          return;
        }
        const request: ResolutionRequest = {
          specifier: args.path,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          with: Object.fromEntries(
            Object.entries(args.with).sort(([a], [b]) => a.localeCompare(b))
          )
        };
        const { specifier, ...resolveOptions } = request;
        const resolved = await build.resolve(specifier, {
          ...resolveOptions,
          pluginData: resolving
        });
        let identity: ResolutionIdentity | undefined;
        try {
          identity = await resolutionIdentity(resolved);
        } catch {
          /* Keep native resolution/error behavior. */
        }
        if (
          !identity ||
          (resolved.pluginData != null && resolved.pluginData !== resolving)
        ) {
          unknown = true;
          return;
        }
        const key = JSON.stringify(request);
        const previous = records.get(key);
        if (
          previous &&
          JSON.stringify(previous.result) !== JSON.stringify(identity)
        )
          unknown = true;
        records.set(key, { request, result: identity });
        return { ...resolved, pluginData: undefined };
      });
    }
  };
  return {
    plugin,
    /** Only the native resolver and our exact host mappings have replay semantics. */
    observePlugin(candidate: Plugin): Plugin {
      return {
        ...candidate,
        setup(build) {
          return candidate.setup({
            ...build,
            onResolve(config, callback) {
              unknown = true;
              return build.onResolve(config, callback);
            }
          });
        }
      };
    },
    finish(metafile?: Metafile): CompileResolutionManifest | undefined {
      if (!started || unknown || !metafile) return;
      const cwd = options.cwd ?? process.cwd();
      const synthetic = new Set([
        resolve(options.filePath),
        resolve(cwd, basename(options.filePath))
      ]);
      const observed = new Set(
        [...records.values()].flatMap(({ result }) =>
          result.external ? [] : [result.path, result.physicalPath!]
        )
      );
      const edgeKey = (importer: string, target: string, kind: string) =>
        JSON.stringify([importer, target, kind]);
      const observedEdges = new Set(
        [...records.values()].flatMap(({ request, result }) => {
          const importer = resolve(
            cwd,
            internalStripStaticCssEvalRequestQuery(request.importer)
          );
          const targets = result.external
            ? [result.path]
            : [result.path, result.physicalPath!].map((path) =>
                resolve(cwd, internalStripStaticCssEvalRequestQuery(path))
              );
          return targets.map((target) =>
            edgeKey(importer, target, request.kind)
          );
        })
      );
      // Glob modules and custom virtual inputs can hide future resolution edges.
      // A proof with an unobserved input is incomplete, even if all old files match.
      for (const [file, input] of Object.entries(metafile.inputs)) {
        const path = resolve(cwd, internalStripStaticCssEvalRequestQuery(file));
        if (!synthetic.has(path) && !observed.has(path)) return;
        // Empty globs have no dispatcher input, but their synthesized import
        // still appears here. Every resolution edge needs a native observation.
        for (const imported of input.imports) {
          // Lowered syntax imports esbuild's own runtime helpers without using
          // the resolver. They have no filesystem or package lookup to replay.
          if (
            imported.path === "<runtime>" &&
            imported.kind === "import-statement" &&
            imported.external &&
            imported.original === undefined
          )
            continue;
          const target = imported.external
            ? imported.path
            : resolve(
                cwd,
                internalStripStaticCssEvalRequestQuery(imported.path)
              );
          if (!observedEdges.has(edgeKey(path, target, imported.kind))) return;
        }
      }
      return {
        version: 1,
        records: [...records]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, record]) => record)
      };
    }
  };
}

/** Re-run the native resolver, including its unsuccessful higher-priority lookups. */
export async function validateCompileResolutions(
  options: CompileOptions,
  manifest: CompileResolutionManifest | undefined
): Promise<boolean> {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.records))
    return false;
  if (!manifest.records.length) return true;
  const esbuild = options.esbuild ?? defaultEsbuild;
  if (typeof esbuild.context !== "function") return false;
  return measureCompilationPhase("compile-resolution-validate", async () => {
    let valid = true;
    const context = await esbuild.context({
      ...compilationResolutionOptions(options),
      stdin: {
        contents: "",
        sourcefile: basename(options.filePath),
        resolveDir: dirname(options.filePath)
      },
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [
        ...resolvedImportPlugin(options),
        {
          name: "mincho:compile-resolution-validation",
          setup(build) {
            build.onStart(async () => {
              await Promise.all(
                manifest.records.map(async ({ request, result }) => {
                  const { specifier, ...resolveOptions } = request;
                  const current = await resolutionIdentity(
                    await build.resolve(specifier, resolveOptions)
                  );
                  if (JSON.stringify(current) !== JSON.stringify(result))
                    valid = false;
                })
              );
            });
          }
        }
      ]
    });
    try {
      await context.rebuild();
    } finally {
      await context.dispose();
    }
    recordCompilationDiagnostic("compile-resolution-probes", {
      count: manifest.records.length,
      valid
    });
    return valid;
  });
}

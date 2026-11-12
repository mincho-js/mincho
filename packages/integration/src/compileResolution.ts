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

// Foundation and activation share the same native receipt; only activation
// exposes the optional host alias and resolved-import inputs.
type ResolverOptions = Pick<
  CompileOptions,
  "cwd" | "esbuild" | "externals" | "filePath" | "loader"
> & {
  alias?: BuildOptions["alias"];
  resolvedImports?: Readonly<Record<string, string>>;
};

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
  options: ResolverOptions
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

export function resolvedImportPlugin(options: ResolverOptions): Plugin[] {
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

export function createCompileResolutionObserver(options: ResolverOptions) {
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
        // Continue native resolution: ResolveResult does not carry all the
        // parser settings (such as dependency tsconfig JSX options).
        return undefined;
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
      const metafilePhysicalPath = (path: string) => {
        const exact = resolve(cwd, path);
        // esbuild's file-namespace receipt can identify a literal ? or #.
        // Strip a host request suffix only when the exact path isn't observed.
        return observed.has(exact) || synthetic.has(exact)
          ? exact
          : resolve(cwd, internalStripStaticCssEvalRequestQuery(path));
      };
      const edgeKey = (
        importer: string,
        target: string,
        kind: string,
        external: boolean,
        attributes?: Record<string, string>
      ) =>
        JSON.stringify([
          importer,
          target,
          kind,
          external,
          Object.entries(attributes ?? {}).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        ]);
      const observedEdges = new Map<string, Set<string>>();
      for (const { request, result } of records.values()) {
        const importer = metafilePhysicalPath(request.importer);
        const targets = result.external
          ? [result.path]
          : [result.path, result.physicalPath!].map(metafilePhysicalPath);
        for (const target of targets) {
          const key = edgeKey(
            importer,
            target,
            request.kind,
            result.external,
            request.with
          );
          let specifiers = observedEdges.get(key);
          if (!specifiers) observedEdges.set(key, (specifiers = new Set()));
          specifiers.add(request.specifier);
        }
      }
      // Glob modules and custom virtual inputs can hide future resolution edges.
      // A proof with an unobserved input is incomplete, even if all old files match.
      for (const [file, input] of Object.entries(metafile.inputs)) {
        const path = metafilePhysicalPath(file);
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
            : metafilePhysicalPath(imported.path);
          const observed = observedEdges.get(
            edgeKey(
              path,
              target,
              imported.kind,
              imported.external === true,
              imported.with
            )
          );
          // Native external entries may omit the original specifier; native
          // file edges must expose the original requested edge.
          if (
            !observed ||
            (imported.original === undefined
              ? !imported.external
              : !observed.has(imported.original))
          )
            return;
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
  options: ResolverOptions,
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

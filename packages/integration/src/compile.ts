import { CompilationInputs } from "./compilationInputs.js";
import { getVerifiedFileScopeRequire } from "./fileScopeNamespace.js";
import {
  scopedFileScopeRuntime,
  CSS_SCOPE_RUNTIME_PREFIX,
  issueCssScopeRuntimeOrigins,
  type CssScopeOrigin
} from "./fileScopeRuntime.js";
import { canonicalFilePath } from "./canonicalPath.js";
import {
  measureCompilationPhase,
  recordCompilationDiagnostic
} from "./diagnostics.js";
import {
  currentCompilationExecution,
  executeScopedTransform
} from "./compilationExecution.js";
import { createStaticStyleSource } from "./staticStyles.js";
import {
  prepareEvaluationDependencyGraph,
  type EvaluationDependencyGraph
} from "./evaluationDependencyGraph.js";
import { cacheDigest } from "./compilationCache.js";
import type { CompilationCache } from "./compilationCache.js";
import {
  cachedCompile,
  isNativeCompileScriptReader,
  type CompileCacheBridge
} from "./compileCache.js";
import {
  compilationResolutionOptions,
  createCompileResolutionObserver,
  resolvedImportPlugin
} from "./compileResolution.js";
import {
  parseSync,
  traverse,
  types as t,
  transformSync,
  type NodePath,
  type TransformOptions
} from "@babel/core";
import {
  minchoStyledComponentPlugin,
  internalIsRuntimeSourceReference
} from "@mincho-js/babel";
import { addFileScope } from "@vanilla-extract/integration";
import defaultEsbuild, {
  type BuildOptions,
  type OnResolveArgs,
  type OnResolveResult,
  type Plugin,
  type PluginBuild
} from "esbuild";
import * as fs from "node:fs";
import { AsyncResource } from "node:async_hooks";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { jsxSyntaxPluginPath, typescriptPresetPath } from "./babelPreset.js";
import { effectiveLoader, isScriptLoader } from "./scriptLoaders.js";
import { internalStripStaticCssEvalRequestQuery } from "./staticCssEvalUtils.js";

export interface CompileOptions {
  /** @internal Environment-owned compilation cache and native asset replay. */
  cache?: CompilationCache;
  cacheBridge?: CompileCacheBridge;
  dependencyGraph?: boolean;
  staticStyles?: boolean;
  esbuild?: PluginBuild["esbuild"];
  filePath: string;
  contents: string;
  cwd?: string;
  externals?: Array<string>;
  loader?: BuildOptions["loader"];
  alias?: BuildOptions["alias"];
  /** Host-resolved exact entry imports; dependencies keep local resolution. */
  resolvedImports?: Readonly<Record<string, string>>;
  plugins?: BuildOptions["plugins"];
  parserPlugins?: NonNullable<TransformOptions["parserOpts"]>["plugins"];

  /** Transaction-owned input reader used by multi-pass build integrations. */
  readFile?: (path: string) => Promise<string>;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  /** @internal Transaction-owned manifest bytes and observed absence. */
  readPackageFile?: (path: string) => Promise<string | undefined>;
  resolverCache: Map<string, string>;
  originalPath: string;
}

// Scope paths are logical identifiers, never a way to recover physical files.
// Encode segments reversibly so out-of-root producers cannot become traversal
// paths or collide with literal percent-escaped directory names.
function logicalScopePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath)
    .split(sep)
    .map((segment) =>
      segment === "." || segment === ".."
        ? segment.replaceAll(".", "%2E")
        : encodeURIComponent(segment)
    )
    .join("/");
}

function addLogicalFileScope(
  options: Parameters<typeof addFileScope>[0]
): string {
  return addFileScope({
    ...options,
    filePath: resolve(
      options.rootPath,
      logicalScopePath(options.rootPath, options.filePath)
    )
  });
}

function addScopedSource(options: Parameters<typeof addFileScope>[0]): string {
  const source = addLogicalFileScope(options);

  // File scopes stack, but vanilla-extract's reference counter resets at every
  // scope boundary. Restore the parent's counter without hoisting its requires.
  // The public API has no setter, so restoration costs one increment per prior
  // parent identifier. Closure locals add no bindings to the caller's source.

  // Upgrade standard generated boilerplate even when the source arrived scoped.
  // Custom scope wrappers with renamed bindings are not rewritten.
  return source
    .replace(
      /^import \{ setFileScope, endFileScope \} from "@vanilla-extract\/css\/fileScope";/,
      `const { setFileScope, endFileScope } = ${scopedFileScopeRuntime};`
    )
    .replace(
      /^const __vanilla_filescope__ = require\("@vanilla-extract\/css\/fileScope"\);/,
      `const __vanilla_filescope__ = ${scopedFileScopeRuntime};`
    );
}

const scopedSourceInputs = new WeakMap<
  Map<string, string>,
  Map<string, string>
>();

function getScopedSourceWithCache({
  contents,
  originalPath,
  packageName,
  rootPath,
  resolverCache
}: {
  contents: string;
  originalPath: string;
  packageName: string;
  rootPath: string;
  resolverCache: Map<string, string>;
}) {
  const inputs =
    scopedSourceInputs.get(resolverCache) ?? new Map<string, string>();

  scopedSourceInputs.set(resolverCache, inputs);

  const fingerprint = cacheDigest(
    JSON.stringify([contents, packageName, rootPath])
  );
  if (
    resolverCache.has(originalPath) &&
    inputs.get(originalPath) === fingerprint
  ) {
    return resolverCache.get(originalPath)!;
  }

  const source = addScopedSource({
    source: contents,
    filePath: originalPath,
    rootPath,
    packageName
  });

  resolverCache.set(originalPath, source);
  inputs.set(originalPath, fingerprint);

  return source;
}

export interface ScopedDependencyOptions {
  contents: string;
  filePath: string;
  /** Physical scope producer; filePath still controls Babel configuration. */
  physicalFilePath?: string;
  loader: "js" | "jsx" | "ts" | "tsx";
  packageName: string;
  rootPath: string;
  parserPlugins?: CompileOptions["parserPlugins"];
}

export interface ScopedDependencyResult {
  source: string;
  cssScopeOrigins: CssScopeOrigin[];
}

export function transformScopedDependencySource(
  input: ScopedDependencyOptions
): string {
  return transformScopedDependency(input).source;
}

export function transformScopedDependency({
  contents,
  filePath,
  physicalFilePath,
  loader,
  packageName,
  rootPath,
  parserPlugins
}: ScopedDependencyOptions) {
  const source = addScopedSource({
    source: contents,
    filePath: physicalFilePath ?? filePath,
    rootPath,
    packageName
  });

  const transformed = transformSync(source, {
    filename: filePath,
    ...(parserPlugins ? { parserOpts: { plugins: [...parserPlugins] } } : {}),
    plugins: [
      ...(loader === "jsx" || loader === "tsx" ? [jsxSyntaxPluginPath] : []),
      minchoStyledComponentPlugin()
    ],
    presets:
      loader === "ts" || loader === "tsx"
        ? [
            [
              typescriptPresetPath,
              { allExtensions: true, isTSX: loader === "tsx" }
            ]
          ]
        : [],
    sourceMaps: false,
    ast: true
  })!;
  const cssScopeOrigins: CssScopeOrigin[] = [];
  try {
    recordTransformedCssScopes(
      cssScopeOrigins,
      transformed.ast as t.File,
      filePath,
      physicalFilePath
    );
  } catch {
    /* Runtime receipts, not these compatibility hints, establish artifact origins. */
  }
  return { source: transformed.code!, cssScopeOrigins };
}

// Ownership searches skip non-files; ordinary input reads retain their errors.
function isAbsentPackageManifest(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

function packageManifestName(contents: string | undefined) {
  if (contents === undefined) return;
  const manifest = JSON.parse(contents.replace(/^\uFEFF/, "")) as {
    name?: unknown;
  };
  return typeof manifest.name === "string" && manifest.name
    ? manifest.name
    : undefined;
}

// Package boundaries can change during a dev-server process. Do not use
// vanilla-extract's process-global directory/require cache for ownership.
export function currentPackageInfo(directory: string, watchFiles: Set<string>) {
  const start = resolve(directory);
  let current = start;
  while (true) {
    const path = join(current, "package.json");
    watchFiles.add(path);
    let contents: string | undefined;
    try {
      contents = fs.readFileSync(path, "utf8");
    } catch (error) {
      if (!isAbsentPackageManifest(error)) throw error;
    }
    const name = packageManifestName(contents);
    if (name) return { name, path, dirname: current };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Couldn't find parent package.json with a name field from '${start}'`
  );
}

async function snapshotPackageInfo(
  directory: string,
  watchFiles: Set<string>,
  readPackageFile?: CompileOptions["readPackageFile"]
) {
  if (!readPackageFile) return currentPackageInfo(directory, watchFiles);
  const start = resolve(directory);
  let current = start;
  while (true) {
    const path = join(current, "package.json");
    watchFiles.add(path);
    let contents: string | undefined;
    try {
      contents = await readPackageFile(path);
    } catch (error) {
      if (!isAbsentPackageManifest(error)) throw error;
    }
    const name = packageManifestName(contents);
    if (name) return { name, path, dirname: current };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Couldn't find parent package.json with a name field from '${start}'`
  );
}

function physicalSourcePath(filePath: string): string {
  const path = resolve(filePath);
  try {
    return fs.realpathSync(path);
  } catch {
    // A caller's declared file-namespace source need not exist on disk.
    return path;
  }
}

function createCompileSourceSelection(readFile?: CompileOptions["readFile"]) {
  const paths = new Map<string, string>();
  const assertSame = (file: string, previous: string, current: string) => {
    if (previous !== current)
      throw new Error(
        `Mincho source producer changed during compilation: ${file}`
      );
  };
  const register = (file: string, physical: string) => {
    const key = resolve(file);
    const previous = paths.get(key);
    if (previous !== undefined) assertSame(file, previous, physical);
    paths.set(key, physical);
  };
  return {
    get: (file: string) => paths.get(resolve(file)),
    entries: () => paths.entries(),
    before: physicalSourcePath,
    after(file: string, physical: string) {
      assertSame(file, physical, physicalSourcePath(file));
      register(file, physical);
    },
    async read(file: string) {
      const physical = physicalSourcePath(file);
      // A native read uses the selected physical path. A caller reader keeps
      // its agreed input path but cannot change the physical selection.
      const contents = readFile
        ? await readFile(
            isNativeCompileScriptReader(readFile) ? physical : file
          )
        : await fs.promises.readFile(physical, "utf8");
      if (readFile) assertSame(file, physical, physicalSourcePath(file));
      register(file, physical);
      return contents;
    }
  };
}

function recordCssScopeOrigin(
  origins: CssScopeOrigin[],
  filePath: string,
  rootPath: string,
  packageName: string,
  origin: string
) {
  origins.push({
    fileScope: {
      filePath: logicalScopePath(rootPath, filePath),
      packageName
    },
    origin
  });
}

// Published bundles can contain several preserved vanilla-extract scopes.
// Their logical paths are identifiers, not files to resolve: the exact module
// read by the host is the physical producer for every declared scope here.
function recordDeclaredCssScopes(
  origins: CssScopeOrigin[],
  contents: string,
  filePath: string,
  rootPath: string,
  packageName: string,
  origin: string,
  parserPlugins?: CompileOptions["parserPlugins"],
  loader: ScopedDependencyOptions["loader"] = "tsx"
) {
  const api = "@vanilla-extract/css/fileScope";
  if (!contents.includes(api)) return;
  const scoped = addLogicalFileScope({
    source: contents,
    filePath,
    rootPath,
    packageName
  });
  const plugins = [...(parserPlugins ?? [])];
  const hasPlugin = (name: string) =>
    plugins.some(
      (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name
    );
  if (
    (loader === "ts" || loader === "tsx") &&
    !hasPlugin("typescript") &&
    !hasPlugin("flow")
  )
    plugins.push("typescript");
  if ((loader === "jsx" || loader === "tsx") && !hasPlugin("jsx"))
    plugins.push("jsx");
  const program = parseSync(scoped, {
    filename: filePath,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins }
  });
  if (!program)
    throw new Error(`Cannot inspect CSS file scopes in ${filePath}`);
  recordTransformedCssScopes(origins, program, filePath, origin);
}

function recordTransformedCssScopes(
  origins: CssScopeOrigin[],
  program: t.File,
  filePath: string,
  origin = physicalSourcePath(filePath)
) {
  const api = "@vanilla-extract/css/fileScope";
  const fail = () => {
    throw new Error(
      `Cannot establish CSS scope provenance in ${filePath}: fileScope API must use immutable bindings and direct calls with literal scope arguments.`
    );
  };
  const isRequire = (path: NodePath<t.Node>): boolean =>
    path.isCallExpression() &&
    path.get("callee").isIdentifier({ name: "require" }) &&
    !path.scope.getBinding("require") &&
    path.node.arguments.length === 1 &&
    t.isStringLiteral(path.node.arguments[0], { value: api });
  const namespaceSource = (path: NodePath<t.Node>): boolean =>
    !!getVerifiedFileScopeRequire(path);
  const sourceBinding = (
    path: NodePath<t.Node>
  ): "namespace" | "set" | undefined => {
    if (isRequire(path)) return "namespace";
    if (!path.isIdentifier()) return;
    const binding = path.scope.getBinding(path.node.name);
    if (!binding || !internalIsRuntimeSourceReference(binding.path)) return;
    const declaration = binding.path;
    let kind: "namespace" | "set" | undefined;
    if (
      declaration.isImportNamespaceSpecifier() &&
      declaration.parentPath.isImportDeclaration() &&
      declaration.parentPath.node.source.value === api
    )
      kind = "namespace";
    if (
      declaration.isImportSpecifier() &&
      declaration.parentPath.isImportDeclaration() &&
      declaration.parentPath.node.source.value === api &&
      t.isIdentifier(declaration.node.imported, { name: "setFileScope" })
    )
      kind = "set";
    if (
      declaration.isVariableDeclarator() &&
      namespaceSource(declaration.get("init") as NodePath<t.Node>)
    ) {
      if (t.isIdentifier(declaration.node.id)) kind = "namespace";
      else if (
        t.isObjectPattern(declaration.node.id) &&
        declaration.node.id.properties.some(
          (property) =>
            t.isObjectProperty(property) &&
            !property.computed &&
            t.isIdentifier(property.key, { name: "setFileScope" }) &&
            t.isIdentifier(property.value, { name: path.node.name })
        )
      )
        kind = "set";
    }
    if (kind && !binding.constant) fail();
    return kind;
  };
  const callOf = (
    path: NodePath<t.Node>
  ): NodePath<t.CallExpression> | undefined => {
    let target = path;
    if (
      target.parentPath?.isSequenceExpression() &&
      target.parentPath.node.expressions.at(-1) === target.node &&
      target.parentPath.node.expressions
        .slice(0, -1)
        .every((item) => t.isNumericLiteral(item, { value: 0 }))
    )
      target = target.parentPath;
    return target.parentPath?.isCallExpression() &&
      target.parentPath.node.callee === target.node
      ? target.parentPath
      : undefined;
  };
  const record = (path: NodePath<t.Node>) => {
    const call = callOf(path);
    if (
      !call ||
      call.node.arguments.length < 1 ||
      call.node.arguments.length > 2 ||
      !t.isStringLiteral(call.node.arguments[0]) ||
      (call.node.arguments[1] && !t.isStringLiteral(call.node.arguments[1]))
    )
      return fail();
    origins.push({
      fileScope: {
        filePath: call.node.arguments[0].value,
        ...(t.isStringLiteral(call.node.arguments[1])
          ? { packageName: call.node.arguments[1].value || undefined }
          : {})
      },
      origin
    });
  };
  traverse(program, {
    ReferencedIdentifier(path) {
      if (!internalIsRuntimeSourceReference(path)) return;
      const kind = sourceBinding(path);
      if (kind === "set") record(path);
      if (kind === "namespace") {
        const parent = path.parentPath;
        if (
          !parent.isMemberExpression() ||
          parent.node.object !== path.node ||
          parent.node.computed ||
          !t.isIdentifier(parent.node.property)
        )
          return fail();
        if (parent.node.property.name === "setFileScope") record(parent);
        else if (
          ![
            "endFileScope",
            "hasFileScope",
            "getFileScope",
            "getAndIncrementRefCounter"
          ].includes(parent.node.property.name) ||
          !callOf(parent)
        )
          fail();
      }
    },
    CallExpression(path) {
      if (!internalIsRuntimeSourceReference(path) || !isRequire(path)) return;
      if (path.parentPath.isVariableDeclarator()) return;
      if (
        path.parentPath.isCallExpression() &&
        namespaceSource(path.parentPath)
      )
        return;
      const parent = path.parentPath;
      if (
        parent.isMemberExpression() &&
        !parent.node.computed &&
        t.isIdentifier(parent.node.property, { name: "setFileScope" })
      )
        record(parent);
      else fail();
    }
  });
}

async function scopedDependencyOptions(
  contents: string,
  filePath: string,
  physicalFilePath: string,
  loader: ScopedDependencyOptions["loader"],
  fallbackRootPath: string,
  entryPackage: { dirname: string; name: string },
  packageWatchFiles: Set<string>,
  cssScopeOrigins: CssScopeOrigin[],
  parserPlugins?: CompileOptions["parserPlugins"],
  readPackageFile?: CompileOptions["readPackageFile"]
): Promise<ScopedDependencyOptions> {
  const directory = dirname(physicalFilePath);
  let packageInfo: ReturnType<typeof currentPackageInfo>;

  try {
    packageInfo = await snapshotPackageInfo(
      directory,
      packageWatchFiles,
      readPackageFile
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !==
        `Couldn't find parent package.json with a name field from '${directory}'`
    ) {
      throw error;
    }

    // Generated dependencies may have no owning package. Retain their original
    // path in the build scope; do not disguise an escaping preset producer path.
    packageInfo = {
      ...(await snapshotPackageInfo(
        fallbackRootPath,
        packageWatchFiles,
        readPackageFile
      )),
      dirname: fallbackRootPath
    };
  }

  // All generated scopes under an emitted package name share one base.
  // An independently installed copy with the entry's name must not use
  // a second base, which could give its files the entry's logical scopes.
  const rootPath =
    packageInfo.name === entryPackage.name
      ? entryPackage.dirname
      : fallbackRootPath;
  recordCssScopeOrigin(
    cssScopeOrigins,
    physicalFilePath,
    rootPath,
    packageInfo.name,
    physicalFilePath
  );
  return {
    contents,
    filePath,
    physicalFilePath,
    loader,
    rootPath,
    packageName: packageInfo.name,
    parserPlugins
  };
}

function createScopedOnLoadPlugin(
  entryPackage: { dirname: string; name: string },
  loaders: BuildOptions["loader"] = {},
  sources: ReturnType<typeof createCompileSourceSelection>,
  readFileBytes?: (path: string) => Promise<Uint8Array>,
  graph?: () => EvaluationDependencyGraph | undefined,
  packageWatchFiles = new Set<string>(),
  cssScopeOrigins: CssScopeOrigin[] = [],
  parserPlugins?: CompileOptions["parserPlugins"],
  readPackageFile?: CompileOptions["readPackageFile"],
  observeAuthorSource: (source: string) => void = () => {}
) {
  return {
    name: "mincho:custom-extract-scope",

    setup(build: PluginBuild) {
      build.onLoad(
        { filter: /.*/, namespace: "file" },
        AsyncResource.bind(async (args: { path: string }) => {
          const loader = effectiveLoader(args.path, loaders);

          if (!isScriptLoader(loader)) {
            const nativeLoader = loader;
            if (readFileBytes && nativeLoader)
              return {
                contents: await readFileBytes(args.path),
                loader: nativeLoader,
                resolveDir: dirname(args.path)
              };

            return undefined;
          }

          const prepared = graph?.()?.sources.get(args.path);

          if (prepared !== undefined) {
            observeAuthorSource(prepared);
            recordCompilationDiagnostic("dependency-graph-scope-skip", {
              file: args.path
            });

            return {
              contents: prepared,
              loader,
              resolveDir: dirname(args.path)
            };
          }

          const contents = await sources.read(args.path);
          const physical = sources.get(args.path)!;
          observeAuthorSource(contents);

          const input = await scopedDependencyOptions(
            contents,
            args.path,
            physical,
            loader,
            build.initialOptions.absWorkingDir!,
            entryPackage,
            packageWatchFiles,
            cssScopeOrigins,
            parserPlugins,
            readPackageFile
          );

          const transformed = await executeScopedTransform(input, () =>
            transformScopedDependency(input)
          );
          observeAuthorSource(transformed.source);
          cssScopeOrigins.push(...transformed.cssScopeOrigins);
          return {
            contents: transformed.source,
            loader,
            resolveDir: dirname(args.path)
          };
        })
      );
    }
  };
}

function scopeLoadedDependencies(
  plugin: Plugin,
  entryPackage: { dirname: string; name: string },
  sources: ReturnType<typeof createCompileSourceSelection>,
  packageWatchFiles: Set<string>,
  cssScopeOrigins: CssScopeOrigin[],
  parserPlugins?: CompileOptions["parserPlugins"],
  readPackageFile?: CompileOptions["readPackageFile"],
  observeAuthorSource: (source: string) => void = () => {},
  onResolveRegistered: () => void = () => {},
  observeResolved: (
    args: OnResolveArgs,
    result: OnResolveResult | null | undefined
  ) => OnResolveResult | null | undefined = (_args, result) => result
): Plugin {
  return {
    ...plugin,
    setup(build) {
      return plugin.setup({
        ...build,
        onResolve(options, callback) {
          onResolveRegistered();
          return build.onResolve(options, async (args) =>
            observeResolved(args, await callback(args))
          );
        },
        onLoad(options, callback) {
          build.onLoad(
            options,
            AsyncResource.bind(async (args) => {
              const physical =
                args.namespace === "file"
                  ? sources.before(args.path)
                  : undefined;
              const result = await callback(args);
              if (result?.contents === undefined || result.errors?.length) {
                return result;
              }

              // esbuild defaults plugin-provided contents to JS, regardless of
              // the extension's configured loader.
              const loader = result.loader ?? "js";
              if (!isScriptLoader(loader)) {
                return result;
              }

              observeAuthorSource(
                typeof result.contents === "string"
                  ? result.contents
                  : Buffer.from(result.contents).toString("utf8")
              );
              // Hygiene covers every caller-provided script namespace; only
              // physical files participate in package/scope transformation.
              if (physical === undefined) return result;
              sources.after(args.path, physical);
              const input = await scopedDependencyOptions(
                typeof result.contents === "string"
                  ? result.contents
                  : Buffer.from(result.contents).toString("utf8"),
                args.path,
                physical,
                loader,
                build.initialOptions.absWorkingDir!,
                entryPackage,
                packageWatchFiles,
                cssScopeOrigins,
                parserPlugins,
                readPackageFile
              );

              const transformed = await executeScopedTransform(input, () =>
                transformScopedDependency(input)
              );
              observeAuthorSource(transformed.source);
              cssScopeOrigins.push(...transformed.cssScopeOrigins);
              return {
                ...result,
                contents: transformed.source
              };
            })
          );
        }
      });
    }
  };
}

function assertSingleChildCompilationOutput(
  outputFiles?: Array<{ text: string }>
) {
  if (!outputFiles || outputFiles.length !== 1) {
    throw new Error("Invalid child compilation result");
  }

  return outputFiles[0].text;
}

function getWatchFiles(
  cwd: string,
  metafile?: { inputs?: Record<string, unknown> },
  physicalScopes: ReadonlySet<string> = new Set()
) {
  return [
    ...new Set(
      Object.keys(metafile?.inputs || {}).map((filePath) => {
        const exact = resolve(cwd, filePath);
        return physicalScopes.has(exact)
          ? exact
          : resolve(cwd, internalStripStaticCssEvalRequestQuery(filePath));
      })
    )
  ];
}

/** Retain cssScopeOrigins alongside source and pass it to CSS evaluation.
 * It identifies physical asset producers, not executable source authority. */
export async function compile(options: CompileOptions) {
  // Resolve before cache lookup so retargeted workspace symlinks cannot reuse
  // results whose old canonical dependencies still exist unchanged.
  const [cwd, filePath, originalPath] = await Promise.all([
    canonicalFilePath(options.cwd ?? process.cwd()),
    canonicalFilePath(options.filePath),
    canonicalFilePath(options.originalPath ?? options.filePath)
  ]);
  options = { ...options, cwd, filePath, originalPath };
  // Ownership is a request snapshot even when no compilation cache is used.
  // A host-supplied reader already defines its own snapshot boundary.
  const inputs =
    !options.cache && !options.readPackageFile
      ? new CompilationInputs()
      : undefined;
  let result;
  try {
    result = await (options.cache
      ? cachedCompile(options, compileUncached)
      : compileUncached(
          inputs
            ? {
                ...options,
                async readPackageFile(file) {
                  const bytes = await inputs.readOptionalFile(file);
                  return bytes === undefined
                    ? undefined
                    : Buffer.from(bytes).toString("utf8");
                }
              }
            : options
        ));
    if (inputs) {
      const changed = await inputs.validate();
      if (changed.files.length)
        throw new Error(
          "Mincho inputs changed during compilation: " +
            changed.files.join(", ")
        );
    }
  } finally {
    inputs?.close();
  }
  const { source, watchFiles, cssScopeOrigins } = result;
  return {
    source,
    watchFiles,
    cssScopeOrigins: issueCssScopeRuntimeOrigins(source, cssScopeOrigins)
  };
}

async function compileUncached(options: CompileOptions) {
  const {
    esbuild = defaultEsbuild,
    filePath,
    contents,
    cwd = process.cwd(),
    loader,
    alias,
    resolvedImports,
    plugins = [],
    parserPlugins,
    cache,
    cacheBridge,
    dependencyGraph = false,
    staticStyles = false,
    readFile,
    readFileBytes,
    readPackageFile,
    resolverCache = new Map(),
    originalPath
  } = options;
  const packageWatchFiles = new Set<string>();
  const cssScopeOrigins: CssScopeOrigin[] = [];
  const sourcePackageInfo = await snapshotPackageInfo(
    dirname(originalPath),
    packageWatchFiles,
    readPackageFile
  );
  // compile() pinned this path before reading the package manifest. The
  // supplied entry text belongs to that producer, not a later link target.
  const entryOrigin = originalPath;
  recordCssScopeOrigin(
    cssScopeOrigins,
    originalPath,
    sourcePackageInfo.dirname,
    sourcePackageInfo.name,
    entryOrigin
  );
  try {
    recordDeclaredCssScopes(
      cssScopeOrigins,
      contents,
      originalPath,
      sourcePackageInfo.dirname,
      sourcePackageInfo.name,
      entryOrigin,
      parserPlugins
    );
  } catch {
    /* Exact runtime producer receipts replace unsupported static hints. */
  }
  const trustedPlugins =
    !plugins.length ||
    (plugins.length === 1 && plugins[0] === cacheBridge?.plugin);

  if (
    staticStyles &&
    !alias &&
    !resolvedImports &&
    currentCompilationExecution()?.evaluation !== "fresh" &&
    trustedPlugins
  ) {
    const direct = createStaticStyleSource({
      contents,
      originalPath,
      filePath,
      scopeFilePath: logicalScopePath(sourcePackageInfo.dirname, originalPath),
      packageName: sourcePackageInfo.name,
      rootPath: sourcePackageInfo.dirname
    });

    if (direct) {
      recordCompilationDiagnostic("static-styles-compile", {
        avoided: "esbuild"
      });

      return {
        source: direct,
        cssScopeOrigins,
        watchFiles: [...packageWatchFiles],
        resolutions: { version: 1 as const, records: [] }
      };
    }

    recordCompilationDiagnostic("static-styles-bypass", {
      reason: "unproved-literal-program"
    });
  }

  // Stable before bundling, including inline source-map sourcesContent. Authority
  // comes from the source-bound compiler seal, not identifier entropy.
  const factoryName =
    "__mincho_css_scope_factory_" +
    cacheDigest(
      JSON.stringify([filePath, originalPath ?? filePath, contents])
    ).slice(0, 48);
  const observeAuthorSource = (source: string) => {
    // Reserve decoded ASCII spelling too: esbuild can decode escaped identifiers
    // even on paths that do not pass through the configured Babel transform.
    const decoded = source.replace(
      /\\u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]+)\})/g,
      (escape, fixed: string | undefined, braced: string | undefined) => {
        const point = Number.parseInt(fixed ?? braced!, 16);
        return point < 128 ? String.fromCharCode(point) : escape;
      }
    );
    if (decoded.includes(factoryName))
      throw new Error(
        "Compiler CSS scope capability identifier collides with author source"
      );
  };
  observeAuthorSource(contents);
  const sources = createCompileSourceSelection(readFile);
  const runtimeOrigins = new Map<string, string>();
  const runtimeNamespace = "mincho-css-scope-proxy";
  let hasCallerResolvers = false;
  const resolveRuntimeApi = (args: OnResolveArgs) => {
    // A resolution-only query uses the native external edge. Let the normal
    // resolution observer record it without creating an executable facade.
    if (args.kind === "require-resolve") return;
    // Unowned virtual modules retain the public API, but receive no producer
    // facade or artifact authority. Evaluation enforces provenance on emitted CSS.
    if (!args.importer || (args.namespace && args.namespace !== "file"))
      return { path: args.path, external: true };
    const origin =
      resolve(args.importer) === resolve(filePath)
        ? entryOrigin
        : sources.get(args.importer);
    if (origin === undefined) return { path: args.path, external: true };
    const id = CSS_SCOPE_RUNTIME_PREFIX + cacheDigest(origin);
    runtimeOrigins.set(id, origin);
    return { path: id, namespace: runtimeNamespace, external: false };
  };
  const runtimeFallbackPlugin: Plugin = {
    name: "mincho:css-scope-runtime-fallback",
    setup(build) {
      build.onResolve(
        { filter: /^@vanilla-extract\/css\/fileScope$/ },
        resolveRuntimeApi
      );
    }
  };
  const runtimePlugin: Plugin = {
    name: "mincho:css-scope-runtime",
    setup(build) {
      build.onResolve({ filter: /^mincho:css-scope-runtime:/ }, () => ({
        errors: [
          {
            text: "Private CSS scope runtime modules cannot be imported by author source"
          }
        ]
      }));
      build.onResolve(
        { filter: /^@vanilla-extract\/css\/fileScope$/ },
        (args) => {
          if (args.namespace === runtimeNamespace)
            return { path: args.path, external: true };
          if (hasCallerResolvers) return;
          return resolveRuntimeApi(args);
        }
      );
      build.onLoad(
        { filter: /.*/, namespace: runtimeNamespace },
        ({ path: id }) => ({
          loader: "js",
          contents: `const original = require("@vanilla-extract/css/fileScope");
          module.exports=typeof ${factoryName} === "function" ? ${factoryName}(${JSON.stringify(id)}) : original;`
        })
      );
    }
  };
  let graph: EvaluationDependencyGraph | undefined;
  const resolution = cache
    ? createCompileResolutionObserver(options)
    : undefined;
  const source = getScopedSourceWithCache({
    contents,
    originalPath,
    packageName: sourcePackageInfo.name,
    rootPath: sourcePackageInfo.dirname,
    resolverCache
  });

  const result = await measureCompilationPhase("esbuild", () =>
    esbuild.build({
      ...compilationResolutionOptions(options),
      stdin: {
        contents: source,
        loader: "tsx",
        resolveDir: dirname(filePath),
        sourcefile: basename(filePath)
      },
      metafile: true,
      bundle: true,
      // Decorators accepted by Babel must be lowered before VM evaluation.
      supported: { decorators: false },
      write: false,
      plugins: [
        runtimePlugin,
        ...(resolution ? [resolution.plugin] : []),
        ...resolvedImportPlugin(options),
        ...plugins.map((plugin) => {
          const scoped = scopeLoadedDependencies(
            plugin,
            sourcePackageInfo,
            sources,
            packageWatchFiles,
            cssScopeOrigins,
            parserPlugins,
            readPackageFile,
            observeAuthorSource,
            () => {
              hasCallerResolvers = true;
            },
            (args, result) => {
              // Respect the caller's chosen edge. Only an unchanged official
              // API external gets the producer facade; redirects remain opaque.
              if (
                args.path !== "@vanilla-extract/css/fileScope" ||
                args.kind === "require-resolve" ||
                !args.importer ||
                (args.namespace && args.namespace !== "file") ||
                !result?.external ||
                (result.path !== undefined &&
                  result.path !== "" &&
                  result.path !== args.path) ||
                (result.namespace && result.namespace !== "file") ||
                result.suffix ||
                result.errors?.length
              )
                return result;
              return { ...result, ...resolveRuntimeApi(args) };
            }
          );
          return resolution ? resolution.observePlugin(scoped) : scoped;
        }),
        ...(dependencyGraph && trustedPlugins
          ? [
              {
                name: "mincho:evaluation-dependency-graph",

                setup(build: PluginBuild) {
                  build.onStart(
                    AsyncResource.bind(async () => {
                      graph = await prepareEvaluationDependencyGraph({
                        // The runtime counter wrapper adds a compiler-owned
                        // require. Prove user dependencies against the standard
                        // scope scaffold while compiling the full wrapper above.
                        source: addLogicalFileScope({
                          source: contents,
                          filePath: originalPath,
                          rootPath: sourcePackageInfo.dirname,
                          packageName: sourcePackageInfo.name
                        }),
                        filePath,
                        cwd,
                        build,
                        readFile: sources.read,
                        parser: cache?.parser,

                        loaderForFile: (file) => effectiveLoader(file, loader)
                      });
                    })
                  );
                }
              }
            ]
          : []),
        runtimeFallbackPlugin,
        createScopedOnLoadPlugin(
          sourcePackageInfo,
          loader,
          sources,
          readFileBytes,
          () => graph,
          packageWatchFiles,
          cssScopeOrigins,
          parserPlugins,
          readPackageFile,
          observeAuthorSource
        )
      ]
    })
  );

  const compiledSource = assertSingleChildCompilationOutput(result.outputFiles);

  // Only compiler-generated unbound typeof/call sites receive the lexical capability.
  // Scan legacy ESM assertions when a caller explicitly emits that syntax.
  const program = parseSync(compiledSource, {
    babelrc: false,
    configFile: false,
    sourceType: "unambiguous",
    parserOpts: {
      allowReturnOutsideFunction: true,
      plugins: ["jsx", "decorators", "deprecatedImportAssert"]
    }
  })!;
  const seenIds = new Set<string>();
  traverse(program, {
    ReferencedIdentifier(path) {
      if (path.node.name !== factoryName) return;
      if (path.scope.getBinding(factoryName))
        throw new Error("Shadowed compiler CSS scope capability");
      const parent = path.parentPath;
      if (
        parent.isUnaryExpression({ operator: "typeof" }) &&
        parent.node.argument === path.node
      )
        return;
      if (
        parent.isCallExpression() &&
        parent.node.callee === path.node &&
        parent.node.arguments.length === 1 &&
        t.isStringLiteral(parent.node.arguments[0]) &&
        runtimeOrigins.has(parent.node.arguments[0].value)
      ) {
        seenIds.add(parent.node.arguments[0].value);
        return;
      }
      throw new Error("Invalid compiler CSS scope capability site");
    }
  });
  // Every newly compiled producer is runtime-only, even if its official API
  // acquisition was dynamic or tree-shaken. Missing calls cannot fall back to
  // old static scope hints to authorize artifacts.
  for (const entry of cssScopeOrigins)
    runtimeOrigins.set(
      CSS_SCOPE_RUNTIME_PREFIX + cacheDigest(entry.origin),
      entry.origin
    );
  const hintsByOrigin = new Map<string, CssScopeOrigin[]>();
  for (const entry of cssScopeOrigins) {
    const hints = hintsByOrigin.get(entry.origin) ?? [];
    hints.push(entry);
    hintsByOrigin.set(entry.origin, hints);
  }
  for (const [id, origin] of runtimeOrigins) {
    const existing = hintsByOrigin.get(origin);
    if (existing?.length)
      for (const entry of existing)
        Object.assign(entry, { runtime: { id, sourceHash: "", factoryName } });
    else
      cssScopeOrigins.push({
        fileScope: { filePath: origin },
        origin,
        runtime: { id, sourceHash: "", factoryName }
      });
  }

  // These exact virtual inputs/edges were created above, not resolved from user
  // imports. Keep every physical and unknown virtual edge in the cache proof.
  const generatedInputs = new Set(
    [...runtimeOrigins.keys()].map((id) => runtimeNamespace + ":" + id)
  );
  const authorMetafile = result.metafile && {
    ...result.metafile,
    inputs: Object.fromEntries(
      Object.entries(result.metafile.inputs)
        .filter(([id]) => !generatedInputs.has(id))
        .map(([id, input]) => [
          id,
          {
            ...input,
            imports: input.imports.filter(
              (edge) => !generatedInputs.has(edge.path)
            )
          }
        ])
    )
  };

  const selectedSources = [...sources.entries()];
  const graphFiles = getWatchFiles(
    cwd,
    authorMetafile,
    new Set([
      ...selectedSources.flat(),
      ...cssScopeOrigins.map(({ origin }) => origin)
    ])
  );
  const graphPaths = new Set(graphFiles);
  // A preliminary load is not a published input. Extend the native watch
  // list only for selected files that the actual build reported loading.
  const pinnedFiles = selectedSources.flatMap(([pathname, physical]) =>
    graphPaths.has(pathname) && pathname !== physical ? [physical] : []
  );
  return {
    source: compiledSource,
    cssScopeOrigins: [
      ...new Map(
        cssScopeOrigins.map((entry) => [JSON.stringify(entry), entry])
      ).values()
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ),
    resolutions: resolution?.finish(authorMetafile),
    watchFiles: [
      ...new Set([
        ...graphFiles,
        ...pinnedFiles,
        ...packageWatchFiles,
        ...(graph?.watchFiles ?? [])
      ])
    ]
  };
}

// @ts-expect-error error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, expect, it, vi } = import.meta.vitest;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createChildEsbuildStub(
    options: {
      metafileInputs?: Record<string, unknown>;
      outputFiles?: Array<{ text: string }>;
      onLoadPath?: string;
    } = {}
  ) {
    const buildCalls: Array<BuildOptions> = [];

    const esbuild = {
      async build(buildOptions: BuildOptions) {
        buildCalls.push(buildOptions);

        const onLoadHandlers: Array<{
          callback: (args: { path: string }) => Promise<{ contents: string }>;
        }> = [];

        const pluginBuild = {
          initialOptions: {
            absWorkingDir: buildOptions.absWorkingDir
          },

          onResolve() {},
          onLoad(
            _options: { namespace?: string },
            callback: (args: { path: string }) => Promise<{ contents: string }>
          ) {
            if (_options.namespace === "file")
              onLoadHandlers.push({ callback });
          }
        };

        for (const plugin of buildOptions.plugins ?? []) {
          plugin.setup(pluginBuild as unknown as PluginBuild);
        }

        if (onLoadHandlers[0]) {
          await onLoadHandlers[0].callback({
            path:
              options.onLoadPath ?? join(process.cwd(), "scoped-dependency.tsx")
          });
        }

        return {
          outputFiles: options.outputFiles ?? [
            { text: buildOptions.stdin!.contents! }
          ],
          metafile: {
            inputs: Object.fromEntries(
              Object.entries(options.metafileInputs ?? {}).map(
                ([id, input]) => [id, { imports: [], ...(input as object) }]
              )
            )
          }
        };
      }
    };

    return {
      buildCalls,
      esbuild: esbuild as unknown as PluginBuild["esbuild"]
    };
  }

  describe("compile", () => {
    it("compile refreshes changed resolver inputs and returns watch files", async () => {
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        'export const child = "ok";'
      );

      const { buildCalls, esbuild } = createChildEsbuildStub({
        metafileInputs: {
          "src/dependency.tsx": {},
          "src/dependency.tsx?url#asset": {},
          "nested/child.ts": {},
          [resolve(process.cwd(), "nested/child.ts")]: {}
        }
      });

      const resolverCache = new Map<string, string>();
      const cwd = process.cwd();
      const originalPath = `${cwd}/source.css.ts`;

      const first = await compile({
        esbuild,
        filePath: `${cwd}/child.tsx`,
        contents: "export const one = 1;",
        cwd,
        resolverCache,
        originalPath
      });

      const second = await compile({
        esbuild,
        filePath: `${cwd}/child.tsx`,
        contents: "export const two = 2;",
        cwd,
        resolverCache,
        originalPath
      });

      expect(buildCalls).toHaveLength(2);
      expect(buildCalls[0]!.stdin!.contents).not.toBe(
        buildCalls[1]!.stdin!.contents
      );
      expect(first.source).not.toBe(second.source);
      expect(resolverCache.get(originalPath)).toBe(second.source);
      expect(first.watchFiles).toEqual([
        join(cwd, "src/dependency.tsx"),
        join(cwd, "nested/child.ts"),
        join(cwd, "package.json")
      ]);
    });

    it.each(["dependency.component", "dependency.custom.ts"])(
      "uses the configured loader for scoped %s dependencies",
      async (name: string) => {
        vi.spyOn(fs.promises, "readFile").mockResolvedValue(
          "export const child = <div />;"
        );

        const cwd = process.cwd();
        const { esbuild } = createChildEsbuildStub({
          onLoadPath: join(cwd, name)
        });

        const compiled = await compile({
          esbuild,
          filePath: join(cwd, "child.tsx"),
          originalPath: join(cwd, "source.css.ts"),
          contents: "export const value = 1;",
          resolverCache: new Map(),
          loader: { ".component": "jsx", ".custom.ts": "jsx" }
        });

        expect(compiled.source).toContain("export const value = 1;");
      }
    );

    it("compile throws Invalid child compilation result", async () => {
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        'export const child = "ok";'
      );

      const { esbuild } = createChildEsbuildStub({
        outputFiles: []
      });

      const cwd = process.cwd();

      await expect(
        compile({
          esbuild,
          filePath: `${cwd}/child.tsx`,
          contents: "export const value = 1;",
          cwd,
          resolverCache: new Map(),
          originalPath: `${cwd}/source.css.ts`
        })
      ).rejects.toThrow("Invalid child compilation result");
    });
  });
}

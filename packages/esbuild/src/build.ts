import * as esbuild from "esbuild";
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import remappingImport, { type SourceMapInput } from "@ampproject/remapping";
import { fileURLToPath } from "node:url";
import { publishOutputs } from "./publish.js";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageGraph
} from "@mincho-js/integration";
import {
  minchoEsbuildPlugins,
  type MinchoEsbuildPluginOptions
} from "./index.js";
import {
  BuildInputSnapshot,
  effectiveLoader,
  observeLoad,
  setBuildTransaction,
  type BuildPhase,
  type BuildTransaction
} from "./buildInputSnapshot.js";

type Remapper = (
  maps: SourceMapInput[],
  loader: () => null
) => { toString(): string };

// This package exports a callable CommonJS value. NodeNext's two declaration
// modes disagree on whether its default import is the function or a namespace.
function getRemapper(value: unknown): Remapper {
  if (typeof value === "function") return value as Remapper;
  if (
    value &&
    typeof value === "object" &&
    "default" in value &&
    typeof value.default === "function"
  )
    return value.default as Remapper;

  throw new Error("Invalid remapping module export");
}

const remapping = getRemapper(remappingImport);

export interface BuildWithMinchoOptions extends Omit<
  esbuild.BuildOptions,
  "plugins"
> {
  mincho?: MinchoEsbuildPluginOptions;

  /** Return fresh plugins. Analysis must have no publishing side effects. */
  plugins?: (phase: BuildPhase) => esbuild.Plugin[];
}

interface Pass {
  result: esbuild.BuildResult & {
    metafile: esbuild.Metafile;
    outputFiles: esbuild.OutputFile[];
  };
  transaction: BuildTransaction;
  cwd: string;
}

/** Native two-pass, one-shot build. Neither pass publishes unvalidated outputs. */
export async function buildWithMincho(
  options: BuildWithMinchoOptions
): Promise<esbuild.BuildResult> {
  const { mincho, plugins, ...nativeOptions } = options;
  if (
    nativeOptions.write !== false &&
    !nativeOptions.outdir &&
    !nativeOptions.outfile
  )
    throw new Error(
      "buildWithMincho requires outdir or outfile when write is enabled."
    );
  if (nativeOptions.bundle === false)
    throw new Error("buildWithMincho requires bundle: true.");

  const snapshot = new BuildInputSnapshot();
  const cwd = nativeOptions.absWorkingDir ?? process.cwd();

  if (nativeOptions.tsconfig)
    await snapshot.trackConfiguration(resolve(cwd, nativeOptions.tsconfig));

  const run = async (
    phase: BuildPhase,
    preludes: Map<string, string[]>
  ): Promise<Pass> => {
    const transaction: BuildTransaction = {
      phase,
      snapshot,
      graphs: new Map(),
      styles: new Map()
    };

    const observer = createObserver(transaction, preludes, nativeOptions);
    const result = await esbuild.build({
      ...structuredClone(nativeOptions),
      bundle: true,
      write: false,
      metafile: true,
      plugins: [
        {
          name: "mincho-transaction",

          setup(build) {
            setBuildTransaction(build.initialOptions, transaction);
          }
        },
        ...[...(plugins?.(phase) ?? []), ...minchoEsbuildPlugins(mincho)].map(
          observer.wrap
        ),
        observer.fallback
      ]
    });

    return { result, transaction, cwd: observer.getWorkingDirectory() };
  };

  const analyzed = await run("analyze", new Map());
  const preludes = planPreludes(analyzed, analyzed.cwd);
  const emitted = await run("emit", preludes);
  assertSameGraphs(analyzed.transaction.graphs, emitted.transaction.graphs);
  assertSameNativeInputs(analyzed.result.metafile, emitted.result.metafile);

  const emittedPlan = planPreludes(emitted, emitted.cwd);

  for (const [id, ordered] of preludes) {
    if (JSON.stringify(emittedPlan.get(id)) !== JSON.stringify(ordered))
      throw new Error(`Mincho CSS graph changed between passes: ${id}`);
  }

  await snapshot.validate();

  if (nativeOptions.write !== false) {
    if (!nativeOptions.allowOverwrite) {
      const inputs = new Set(
        Object.keys(emitted.result.metafile.inputs).map((input) =>
          fileIdentity(input, emitted.cwd)
        )
      );

      for (const output of emitted.result.outputFiles) {
        if (inputs.has(output.path))
          throw new Error(
            `Refusing to overwrite input file ${output.path}. Set allowOverwrite explicitly to permit this.`
          );
      }
    }

    await publishOutputs(emitted.result.outputFiles);
  }

  return {
    ...emitted.result,
    ...(nativeOptions.metafile ? {} : { metafile: undefined }),
    ...(nativeOptions.write === false ? {} : { outputFiles: undefined })
  };
}

function planPreludes(pass: Pass, cwd: string): Map<string, string[]> {
  const { metafile } = pass.result;
  const result = new Map<string, string[]>();

  for (const output of Object.values(metafile.outputs)) {
    if (!output.entryPoint || !output.cssBundle) continue;

    const cssOutput = metafile.outputs[output.cssBundle];
    if (!cssOutput)
      throw new Error(
        `Mincho analysis is missing CSS output ${output.cssBundle}`
      );

    const reachable = new Set<string>();
    const pending = [output.entryPoint];

    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;

      reachable.add(id);

      // esbuild includes dynamic descendants in the entry CSS bundle as well.
      for (const dependency of [
        ...(metafile.inputs[id]?.imports ?? [])
      ].reverse())
        if (!dependency.external) pending.push(dependency.path);
    }

    const graphs: DefineRulesPackageGraph[] = [];

    for (const input of reachable) {
      const graph = pass.transaction.graphs.get(fileIdentity(input, cwd));

      if (graph) graphs.push(graph);
    }

    if (!graphs.length) continue;

    const ordered = getDefineRulesPackageStyleSpecifiers(
      mergeDefineRulesPackageGraphs(graphs)
    );

    // Every prelude import must already belong to this native CSS output. This
    // deliberately rejects unresolved/opaque ownership instead of adding CSS.
    const cssInputs = new Set(
      Object.keys(cssOutput.inputs).map((input) => fileIdentity(input, cwd))
    );

    const managedCss = new Map<string, string>();

    for (const specifier of ordered) {
      const identities = pass.transaction.styles.get(specifier);
      const owned = [...(identities ?? [])].filter((identity) =>
        cssInputs.has(identity)
      );
      if (owned.length !== 1) {
        throw new Error(
          `Mincho cannot establish CSS ownership of ${specifier} in ${output.cssBundle}`
        );
      }

      managedCss.set(owned[0]!, specifier);
    }

    assertPackageLocalCss(metafile, managedCss, cwd);

    if (ordered.length)
      result.set(fileIdentity(output.entryPoint, cwd), ordered);
  }

  return result;
}

function assertPackageLocalCss(
  metafile: esbuild.Metafile,
  managedCss: Map<string, string>,
  cwd: string
): void {
  const inputs = new Map(
    Object.entries(metafile.inputs).map(([id, input]) => [
      fileIdentity(id, cwd),
      input
    ])
  );

  for (const [origin, specifier] of managedCss) {
    const pending = [origin];
    const visited = new Set<string>();

    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;

      visited.add(id);

      for (const dependency of inputs.get(id)?.imports ?? []) {
        if (dependency.external || dependency.kind !== "import-rule") continue;

        const target = fileIdentity(dependency.path, cwd);
        const targetSpecifier = managedCss.get(target);
        if (target !== origin && targetSpecifier)
          throw new Error(
            `Mincho package CSS must contain local styles only: ${specifier} imports ${targetSpecifier} through CSS @import. Connect ancestor styles through JavaScript imports instead.`
          );

        pending.push(target);
      }
    }
  }
}

function fileIdentity(input: string, cwd: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

function assertSameGraphs(
  left: Map<string, DefineRulesPackageGraph>,
  right: Map<string, DefineRulesPackageGraph>
): void {
  if (left.size !== right.size)
    throw new Error("Mincho registry inputs changed between passes.");

  for (const [id, graph] of left)
    if (JSON.stringify(graph) !== JSON.stringify(right.get(id)))
      throw new Error(`Mincho package graph changed between passes: ${id}`);
}

function assertSameNativeInputs(
  left: esbuild.Metafile,
  right: esbuild.Metafile
): void {
  const leftInputs = Object.keys(left.inputs).sort();
  const rightInputs = Object.keys(right.inputs).sort();
  if (JSON.stringify(leftInputs) !== JSON.stringify(rightInputs))
    throw new Error(
      "Mincho resolved inputs changed between passes. Rebuild with stable inputs."
    );
}

function createObserver(
  transaction: BuildTransaction,
  preludes: Map<string, string[]>,
  options: esbuild.BuildOptions
) {
  let resolvedOptions = options;
  const injectedImports = new Set<string>();
  const nativeResolution = Symbol("mincho-native-resolution");

  const load = async (
    args: esbuild.OnLoadArgs,
    result: esbuild.OnLoadResult | null | undefined
  ): Promise<esbuild.OnLoadResult | null | undefined> => {
    if (!result || result.contents === undefined) return result;

    for (const path of result.watchFiles ?? [])
      await transaction.snapshot.trackConfiguration(path);

    if (args.namespace === "file") {
      await transaction.snapshot.trackConfiguration(args.path);
      await transaction.snapshot.trackConfigurationAncestors(args.path);
    }

    observeLoad(transaction, args, result);

    const prelude = preludes.get(
      fileIdentity(
        `${args.namespace !== "file" ? `${args.namespace}:` : ""}${args.path}${args.suffix}`,
        resolvedOptions.absWorkingDir ?? process.cwd()
      )
    );

    for (const specifier of prelude ?? [])
      injectedImports.add(
        JSON.stringify([args.namespace, args.path, specifier])
      );

    const loader = result.loader ?? "js";

    if (!["js", "jsx", "ts", "tsx"].includes(loader)) {
      if (!prelude?.length) return result;

      throw new Error(
        `Mincho CSS prelude needs a JavaScript entry: ${args.path}`
      );
    }

    const source =
      typeof result.contents === "string"
        ? result.contents
        : new TextDecoder().decode(result.contents);
    if (!prelude?.length && !source.includes("sourceMappingURL")) return result;

    const ast = parse(source, {
      sourceType: "unambiguous",
      plugins: [
        "decorators-legacy",
        "decoratorAutoAccessors",
        ...(loader === "ts" || loader === "tsx" ? ["typescript" as const] : []),
        ...(loader === "jsx" || loader === "tsx" ? ["jsx" as const] : [])
      ]
    });

    let originalMapInput: SourceMapInput | undefined;
    const sourceMapComment = (ast.comments ?? [])
      .map(
        (comment) =>
          /^\s*[#@]\s*sourceMappingURL=(\S+)\s*$/.exec(comment.value)?.[1]
      )
      .filter((value): value is string => value !== undefined)
      .at(-1);

    if (sourceMapComment) {
      let originalMap: string;
      let mapDirectory = result.resolveDir ?? dirname(args.path);

      if (sourceMapComment.startsWith("data:")) {
        const comma = sourceMapComment.indexOf(",");
        if (comma < 0)
          throw new Error(`Invalid inline source map in ${args.path}`);

        originalMap = sourceMapComment.slice(0, comma).endsWith(";base64")
          ? Buffer.from(sourceMapComment.slice(comma + 1), "base64").toString(
              "utf8"
            )
          : decodeURIComponent(sourceMapComment.slice(comma + 1));
      } else {
        const mapPath = sourceMapComment.startsWith("file:")
          ? fileURLToPath(sourceMapComment)
          : resolve(
              result.resolveDir ?? dirname(args.path),
              decodeURIComponent(sourceMapComment)
            );

        mapDirectory = dirname(mapPath);
        originalMap = (await transaction.snapshot.readFile(mapPath)).toString(
          "utf8"
        );
      }

      const parsed = JSON.parse(originalMap) as SourceMapInput & {
        sourceRoot?: string;
      };

      if (!parsed.sourceRoot || !/^[a-z]+:\/\//i.test(parsed.sourceRoot))
        parsed.sourceRoot = resolve(mapDirectory, parsed.sourceRoot ?? "");

      originalMapInput = parsed;
    }

    if (!prelude?.length) return result;

    const insertion =
      ast.program.directives.at(-1)?.end ??
      ast.program.interpreter?.end ??
      (source.charCodeAt(0) === 0xfeff ? 1 : 0);

    const edited = new MagicString(source);
    edited.appendLeft(
      insertion,
      `\n${prelude.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`
    );

    const generatedMap = edited.generateMap({
      hires: true,
      source: args.path,
      includeContent: true
    });

    const map = originalMapInput
      ? remapping(
          [
            JSON.parse(generatedMap.toString()) as SourceMapInput,
            originalMapInput
          ],
          () => null
        ).toString()
      : generatedMap.toString();

    return {
      ...result,
      contents: `${edited.toString()}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}\n`
    };
  };

  const observeResolution = (
    args: esbuild.OnResolveArgs,
    result: esbuild.OnResolveResult | null | undefined
  ): void => {
    if (!result?.path && !result?.external) return;

    if (args.path.endsWith("/style.css") && result.path && !result.external) {
      const identities = transaction.styles.get(args.path) ?? new Set<string>();
      const namespace = result.namespace ?? "file";
      identities.add(
        fileIdentity(
          `${namespace && namespace !== "file" ? `${namespace}:` : ""}${result.path}${result.suffix ?? ""}`,
          resolvedOptions.absWorkingDir ?? process.cwd()
        )
      );
      transaction.styles.set(args.path, identities);
    }

    const key = JSON.stringify([
      args.namespace,
      args.importer,
      args.path,
      args.kind,
      args.resolveDir,
      args.with
    ]);
    if (
      injectedImports.has(
        JSON.stringify([args.namespace, args.importer, args.path])
      ) &&
      !transaction.snapshot.hasObservation(`resolve:${key}`)
    )
      return;

    transaction.snapshot.observe(
      transaction.phase,
      `resolve:${key}`,
      JSON.stringify([
        result.path,
        result.namespace ?? "file",
        result.suffix ?? "",
        result.external ?? false,
        result.sideEffects
      ])
    );
  };

  const wrap = (plugin: esbuild.Plugin): esbuild.Plugin => ({
    name: plugin.name,

    setup(build) {
      return plugin.setup({
        ...build,

        onLoad(filter, callback) {
          build.onLoad(filter, async (args) =>
            load(args, await callback(args))
          );
        },

        onResolve(filter, callback) {
          build.onResolve(filter, async (args) => {
            const result = await callback(args);
            observeResolution(args, result);

            return result;
          });
        }
      });
    }
  });

  const fallback: esbuild.Plugin = {
    name: "mincho-input-snapshot",

    async setup(build) {
      resolvedOptions = build.initialOptions;

      if (resolvedOptions.tsconfig)
        await transaction.snapshot.trackConfiguration(
          resolve(
            resolvedOptions.absWorkingDir ?? process.cwd(),
            resolvedOptions.tsconfig
          )
        );

      if (
        build.initialOptions.write !== false ||
        build.initialOptions.metafile !== true ||
        build.initialOptions.bundle !== true
      ) {
        throw new Error(
          "buildWithMincho plugins must preserve write:false, metafile:true and bundle:true."
        );
      }

      const observedOptions = { ...build.initialOptions };
      delete observedOptions.plugins;
      transaction.snapshot.observe(
        transaction.phase,
        "build-options",
        JSON.stringify(observedOptions)
      );
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.[nativeResolution]) return;

        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { ...args.pluginData, [nativeResolution]: true },
          with: args.with
        });

        observeResolution(args, result);

        return result;
      });
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const loader = effectiveLoader(args.path, build.initialOptions.loader);
        if (!loader)
          throw new Error(
            `Mincho cannot snapshot the native loader for ${args.path}. Configure a loader or a plugin.`
          );

        return load(args, {
          contents: await transaction.snapshot.readFile(args.path),
          loader,
          resolveDir: dirname(args.path)
        });
      });
    }
  };

  return {
    wrap,
    fallback,

    getWorkingDirectory: () => resolvedOptions.absWorkingDir ?? process.cwd()
  };
}

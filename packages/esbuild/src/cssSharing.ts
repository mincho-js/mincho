import {
  internalIsShareableCss,
  internalPlanCssChunkSharing,
  internalResolveCssChunkSharingOptions,
  type MinchoCssChunkSharingOptions
} from "@mincho-js/integration";
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  cssReplayResolutionKey,
  type BuildTransaction,
  type CssReplayInput
} from "./buildInputSnapshot.js";

export interface MinchoCssManifest {
  version: 1;

  /** Output paths are relative to the build output directory. */
  entries: Record<string, { css: string[]; fallbackCssBundle: string }>;
}

type NativeResult = esbuild.BuildResult & {
  metafile: esbuild.Metafile;
  outputFiles: esbuild.OutputFile[];
};

const slash = (path: string) => path.split(sep).join("/");

const identity = (path: string, cwd: string) =>
  isAbsolute(path) ? path : resolve(cwd, path);

function loadIdentity(
  namespace: string,
  path: string,
  suffix: string,
  cwd: string
) {
  return identity(
    `${namespace !== "file" ? `${namespace}:` : ""}${path}${suffix}`,
    cwd
  );
}

/** Recompile captured native CSS only; user plugins are never run a third time. */
export async function emitSharedCss(
  result: NativeResult,
  transaction: BuildTransaction,
  nativeOptions: esbuild.BuildOptions,
  cwd: string,
  option?: MinchoCssChunkSharingOptions,
  emitFallbackManifest = true
): Promise<MinchoCssManifest | undefined> {
  const options = internalResolveCssChunkSharingOptions(option);
  const replay = transaction.cssReplay;

  if (!options || !replay) {
    transaction.cssSharingDiagnostics?.record({
      applied: false,
      reason: "disabled"
    });

    return;
  }

  if (!nativeOptions.outdir && !nativeOptions.outfile)
    throw new Error(
      "cssChunkSharing requires an output directory or output file."
    );

  const outdir = resolve(
    cwd,
    nativeOptions.outdir ?? dirname(nativeOptions.outfile!)
  );

  const manifest: MinchoCssManifest = { version: 1, entries: {} };
  const modules = new Map<string, { bytes: number; shareable: boolean }>();
  const inputsById = new Map(
    Object.entries(result.metafile.inputs).map(([id, input]) => [
      identity(id, cwd),
      input
    ])
  );

  const canReplay = (id: string, visited = new Set<string>()): boolean => {
    if (visited.has(id)) return true;

    visited.add(id);

    const input = replay.inputs.get(id);
    if (!input?.replayable) return false;

    if (input.result.loader === "css") {
      const source =
        typeof input.result.contents === "string"
          ? input.result.contents
          : new TextDecoder().decode(input.result.contents);

      // esbuild reads linked source maps internally, outside plugin onLoad.
      // Avoid an unobserved third-pass filesystem input; inline maps are safe.
      if (/\/\*[#@]\s*sourceMappingURL\s*=\s*(?!data:)[^\s*]/.test(source))
        return false;
    }

    for (const dependency of inputsById.get(id)?.imports ?? []) {
      if (
        !dependency.external &&
        !canReplay(identity(dependency.path, cwd), visited)
      )
        return false;
    }

    return true;
  };

  for (const [id, input] of replay.inputs) {
    if (input.result.loader !== "css") continue;

    const source =
      typeof input.result.contents === "string"
        ? input.result.contents
        : new TextDecoder().decode(input.result.contents);

    modules.set(id, {
      bytes: Buffer.byteLength(source),
      shareable: canReplay(id) && internalIsShareableCss(source)
    });
  }

  const boundaries: { id: string; modules: string[] }[] = [];
  const eligible = new Set<string>();
  const skippedBoundaries: string[] = [];

  for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
    if (!output.entryPoint || !output.cssBundle) continue;

    const id = slash(relative(outdir, identity(outputPath, cwd)));
    const fallbackCssBundle = slash(
      relative(outdir, identity(output.cssBundle, cwd))
    );

    manifest.entries[id] = { css: [fallbackCssBundle], fallbackCssBundle };

    const cssOutput = result.metafile.outputs[output.cssBundle];
    if (!cssOutput) continue;

    // Metafile output inputs retain the native concatenation order. Preserve
    // opaque modules as barriers, rather than silently skipping their position.
    const ordered = Object.keys(cssOutput.inputs).map((input) =>
      identity(input, cwd)
    );

    boundaries.push({ id, modules: ordered });

    if (
      ordered.every((moduleId) => {
        const input = replay.inputs.get(moduleId);

        return (
          input?.result.loader === "css" &&
          canReplay(moduleId) &&
          !(inputsById.get(moduleId)?.imports ?? []).some(
            (dependency) => dependency.kind === "import-rule"
          )
        );
      })
    )
      eligible.add(id);
    else {
      skippedBoundaries.push(id);

      if (emitFallbackManifest)
        result.warnings.push({
          id: "mincho-css-sharing",
          pluginName: "mincho",
          text: `CSS sharing skipped for ${id}: CSS imports or custom/unknown plugin provenance cannot be replayed as ordered whole modules.`,
          location: null,
          notes: [],
          detail: undefined
        });
    }
  }

  const groups = internalPlanCssChunkSharing(
    boundaries,
    modules,
    options,
    (id) => slash(relative(cwd, id))
  ).filter(
    (group) =>
      !nativeOptions.banner?.css &&
      !nativeOptions.footer?.css &&
      group.boundaries.every((id) => eligible.has(id))
  );

  transaction.cssSharingDiagnostics?.record({
    applied: groups.length > 0,
    reason: groups.length ? "ordered-prefix" : "no-eligible-prefix",
    thresholds: options,
    boundaries: boundaries.length,
    replayableBoundaries: eligible.size,
    skippedBoundaries,
    cssBannerOrFooter: Boolean(
      nativeOptions.banner?.css || nativeOptions.footer?.css
    ),
    groups: groups.map(({ name, boundaries, savedBytes }) => ({
      name,
      boundaries,
      estimatedSourceBytesSaved: savedBytes
    }))
  });

  // Automatic production sharing must not add unused files for native layouts.
  // Explicit callers retain the v1 fallback manifest even without a candidate.
  if (!groups.length && !emitFallbackManifest) return;

  if (groups.length) {
    const entries = new Map<string, readonly string[]>();
    const entryNames = new Map<string, string>();

    for (const group of groups) {
      entries.set(group.name, group.modules);

      for (const id of group.boundaries) {
        const boundary = boundaries.find((item) => item.id === id)!;
        const remainingModules = boundary.modules.slice(group.modules.length);
        if (!remainingModules.length) continue;

        const name = `mincho-private-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
        entries.set(name, remainingModules);
        entryNames.set(id, name);
      }
    }

    const subbuild = await esbuild.build({
      ...cssBuildOptions(nativeOptions),
      absWorkingDir: cwd,
      bundle: true,
      write: false,
      metafile: true,
      outdir,
      entryNames: "mincho-css/[name]-[hash]",
      entryPoints: Object.fromEntries(
        [...entries.keys()].map((name) => [name, `mincho-css-entry:${name}`])
      ),
      plugins: [
        {
          name: "mincho-css-replay",

          setup(build) {
            build.onResolve({ filter: /^mincho-css-entry:/ }, (args) => ({
              path: args.path.slice("mincho-css-entry:".length),
              namespace: "mincho-css-entry"
            }));
            build.onLoad(
              { filter: /.*/, namespace: "mincho-css-entry" },
              (args) => ({
                contents: entries
                  .get(args.path)!
                  .map(
                    (id) =>
                      `@import ${JSON.stringify(`mincho-css-input:${id}`)};`
                  )
                  .join("\n"),
                loader: "css"
              })
            );
            build.onResolve({ filter: /^mincho-css-input:/ }, (args) => {
              const id = args.path.slice("mincho-css-input:".length);
              const input = replay.inputs.get(id);
              if (!input?.replayable)
                throw new Error(`Missing captured CSS input: ${id}`);

              return {
                path: input.args.path,
                namespace: input.args.namespace,
                suffix: input.args.suffix
              };
            });
            build.onResolve({ filter: /.*/ }, (args) => {
              const captured = replay.resolutions.get(
                cssReplayResolutionKey(
                  args.namespace,
                  args.importer,
                  args.path,
                  args.kind
                )
              );
              if (!captured)
                throw new Error(
                  `CSS replay has no captured resolution for ${args.path} from ${args.importer}.`
                );

              // Only native resolution results are replayed. In particular no
              // pluginData callback or fresh filesystem resolution is permitted.
              return {
                path: captured.path,
                namespace: captured.namespace,
                external: captured.external,
                suffix: captured.suffix,
                sideEffects: captured.sideEffects
              };
            });
            build.onLoad({ filter: /.*/ }, (args) => {
              const input = replay.inputs.get(
                loadIdentity(args.namespace, args.path, args.suffix, cwd)
              );
              if (!input?.replayable)
                throw new Error(
                  `CSS replay has no captured native input for ${args.path}.`
                );

              return replayLoad(input);
            });
          }
        }
      ]
    });

    const names = new Map<string, string>();

    for (const [path, output] of Object.entries(subbuild.metafile.outputs)) {
      if (!output.entryPoint) continue;

      const name = output.entryPoint.slice("mincho-css-entry:".length);
      names.set(name, slash(relative(outdir, identity(path, cwd))));
    }

    for (const group of groups) {
      const shared = names.get(group.name);
      if (!shared)
        throw new Error(`Missing shared CSS output for ${group.name}.`);

      for (const id of group.boundaries) {
        const privateName = entryNames.get(id);

        if (!privateName) {
          manifest.entries[id]!.css = [shared];

          continue;
        }

        const privateCss = names.get(privateName);
        if (!privateCss)
          throw new Error(`Missing private CSS output for ${id}.`);

        manifest.entries[id]!.css = [shared, privateCss];
      }
    }

    mergeOutputs(result, subbuild.outputFiles, subbuild.metafile);
    result.warnings.push(...subbuild.warnings);
  }

  const path = resolve(outdir, "mincho-css-manifest.json");
  const contents = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  mergeOutputs(result, [
    {
      path,
      contents,
      hash: createHash("sha256").update(contents).digest("hex"),

      get text() {
        return new TextDecoder().decode(contents);
      }
    }
  ]);
  result.metafile.outputs[slash(relative(cwd, path))] = {
    bytes: contents.byteLength,
    inputs: {},
    imports: [],
    exports: []
  };

  return manifest;
}

function replayLoad(input: CssReplayInput): esbuild.OnLoadResult {
  return {
    contents: input.result.contents,
    loader: input.result.loader,
    resolveDir: input.result.resolveDir
  };
}

function cssBuildOptions(options: esbuild.BuildOptions): esbuild.BuildOptions {
  // Copy only native CSS/code-generation settings. JS plugins, injection,
  // banners and aliases have already done their work in the captured passes.
  return {
    target: options.target,
    supported: options.supported,
    minify: options.minify,
    minifyWhitespace: options.minifyWhitespace,
    minifyIdentifiers: options.minifyIdentifiers,
    minifySyntax: options.minifySyntax,
    charset: options.charset,
    legalComments: options.legalComments,
    sourcemap: options.sourcemap,
    sourcesContent: options.sourcesContent,
    sourceRoot: options.sourceRoot,
    assetNames: options.assetNames,
    publicPath: options.publicPath,
    outExtension: options.outExtension,
    banner: options.banner?.css ? { css: options.banner.css } : undefined,
    footer: options.footer?.css ? { css: options.footer.css } : undefined,
    logLevel: options.logLevel,
    logLimit: options.logLimit,
    logOverride: options.logOverride
  };
}

function mergeOutputs(
  result: NativeResult,
  files: esbuild.OutputFile[],
  metafile?: esbuild.Metafile
) {
  const existing = new Map(result.outputFiles.map((file) => [file.path, file]));

  for (const file of files) {
    const previous = existing.get(file.path);

    if (previous) {
      if (!Buffer.from(previous.contents).equals(Buffer.from(file.contents)))
        throw new Error(`CSS sharing output collides with ${file.path}.`);
    } else {
      existing.set(file.path, file);
      result.outputFiles.push(file);
    }
  }

  if (metafile) {
    Object.assign(result.metafile.inputs, metafile.inputs);
    Object.assign(result.metafile.outputs, metafile.outputs);
  }
}

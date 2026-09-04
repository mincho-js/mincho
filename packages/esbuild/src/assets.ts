import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BuildOptions,
  BuildResult,
  Metafile,
  OnResolveResult,
  OutputFile,
  Plugin,
  PluginBuild
} from "esbuild";

type EntryLayout = {
  outbase: string;
  outputDirectories: string[];
};

type Asset = {
  path: string;
  suffix: string;
  url: string;
  outputFiles: OutputFile[];
  metafile: Metafile;
};

/** The native file/dataurl loader owns URL encoding, asset hashing and naming. */
export class EsbuildAssets {
  private readonly cache = new Map<string, Promise<Asset>>();
  private readonly urls = new Map<string, Asset>();
  private readonly cwd: string;
  private readonly requestedMetafile: boolean;
  private layout?: Promise<EntryLayout>;

  constructor(private readonly build: PluginBuild) {
    this.cwd = build.initialOptions.absWorkingDir ?? process.cwd();
    this.requestedMetafile = build.initialOptions.metafile === true;

    // Needed even with write:true to detect collisions with native outputs.
    build.initialOptions.metafile = true;
  }

  beginBuild(): void {
    this.cache.clear();
    this.urls.clear();
    this.layout = undefined;
  }

  async load(path: string, suffix: string): Promise<string> {
    const options = this.build.initialOptions;
    const loader = getAssetLoader(path, options);
    const contents = await fs.readFile(path);
    const digest = createHash("sha256").update(contents).digest("hex");
    const layout = await (this.layout ??= this.getEntryLayout());
    const outbase = layout.outbase;
    const outdir = getOutputDirectory(options, this.cwd, loader);
    const helperDirectory = layout.outputDirectories[0] ?? outdir;
    const key = JSON.stringify([
      "file",
      path,
      suffix,
      loader,
      digest,
      outdir,
      outbase,
      layout.outputDirectories,
      options.assetNames,
      options.publicPath
    ]);

    let pending = this.cache.get(key);

    if (!pending) {
      pending = (async () => {
        const input = { path, suffix, contents, loader, outdir, outbase };
        const asset = await this.buildAsset({ ...input, helperDirectory });

        if (loader === "file" && !options.publicPath) {
          for (const directory of layout.outputDirectories.slice(1)) {
            const variant = await this.buildAsset({
              ...input,
              helperDirectory: directory
            });
            if (variant.url !== asset.url) {
              throw new Error(
                `Static asset URL ${path}${suffix} depends on the output directory ` +
                  `(${JSON.stringify(asset.url)} or ${JSON.stringify(variant.url)}). ` +
                  "Set esbuild publicPath or use a dataurl loader."
              );
            }
          }
        }

        return asset;
      })();
      this.cache.set(key, pending);
    }

    const asset = await pending;
    this.urls.set(asset.url, asset);

    return asset.url;
  }

  resolveCssUrl(url: string): OnResolveResult | undefined {
    const asset = this.urls.get(url);

    // Resolving the original asset lets esbuild calculate URLs relative to the
    // actual CSS output (including code splitting and nested entry names).
    return asset
      ? { path: asset.path, suffix: asset.suffix, namespace: "file" }
      : undefined;
  }

  /** Supply native asset values to the isolated ordinary css() evaluation. */
  getCompileLoaders(): BuildOptions["loader"] {
    const entries = Object.entries(this.build.initialOptions.loader ?? {});

    // esbuild validates file loaders before running onLoad. The bridge below
    // supplies JS modules and owns their assets, so the isolated evaluation
    // must not ask esbuild to emit a second output file.
    return Object.fromEntries(
      entries.filter(([, loader]) => loader !== "file" && loader !== "dataurl")
    );
  }

  createCompilePlugin(watchFiles: Set<string>): Plugin {
    return {
      name: "mincho-static-assets",

      setup: (build) => {
        build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          const query = new URLSearchParams(
            args.suffix.split("#", 1)[0]?.slice(1)
          );

          const loader = findAssetLoader(args.path, this.build.initialOptions);
          if (!query.has("raw") && !query.has("url") && !loader) return;

          const value =
            query.has("raw") && !query.has("url")
              ? await fs.readFile(args.path, "utf8")
              : await this.load(args.path, args.suffix);

          watchFiles.add(args.path);

          return {
            contents: `export default ${JSON.stringify(value)};`,
            loader: "js",
            watchFiles: [args.path]
          };
        });
      }
    };
  }

  async finishBuild(result: BuildResult): Promise<void> {
    try {
      if (result.errors.length > 0) return;

      const assets = await Promise.all(this.cache.values());
      const nativeFiles = new Map(
        result.outputFiles?.map((file) => [resolve(file.path), file]) ?? []
      );

      const extraFiles = new Map<string, OutputFile>();
      const metafile = result.metafile;
      const nativePaths = new Set(
        Object.keys(metafile?.outputs ?? {}).map((path) =>
          resolve(this.cwd, path)
        )
      );

      for (const asset of assets) {
        for (const file of asset.outputFiles) {
          const path = resolve(file.path);
          const existing = nativeFiles.get(path) ?? extraFiles.get(path);

          if (existing) {
            assertSameOutput(path, existing.contents, file.contents);
          } else if (nativePaths.has(path)) {
            assertSameOutput(path, await fs.readFile(path), file.contents);
          } else {
            extraFiles.set(path, file);
          }
        }
      }

      // Validate every collision before publishing any additional file.
      if (this.build.initialOptions.write === false) {
        result.outputFiles ??= [];
        result.outputFiles.push(
          ...[...extraFiles.values()].sort(compareOutputPaths)
        );
      } else {
        await Promise.all(
          [...extraFiles.values()].map(async (file) => {
            await fs.mkdir(dirname(file.path), { recursive: true });
            await fs.writeFile(file.path, file.contents);
          })
        );
      }

      if (metafile) {
        for (const asset of assets) mergeMetafile(metafile, asset.metafile);
      }
    } finally {
      if (!this.requestedMetafile) delete result.metafile;
    }
  }

  private async getEntryLayout(): Promise<EntryLayout> {
    const options = this.build.initialOptions;
    const entries = getEntryPoints(options);
    if (entries.length === 0 && !options.stdin) {
      return {
        outbase: resolve(this.cwd, options.outbase ?? "."),
        outputDirectories: []
      };
    }

    // Ask esbuild to expand entry globs and apply entryNames/outfile. Empty
    // entry sources avoid executing or compiling the user's dependency graph.
    // This also works on the package's Node 20 baseline without fs.glob().
    const entryContents = options.splitting
      ? 'export const load = () => import("mincho:layout-chunk");'
      : "export {};";

    const ownerBuild = this.build;
    const probe = await this.build.esbuild.build({
      absWorkingDir: this.cwd,
      entryPoints: options.entryPoints,
      stdin: options.stdin
        ? { ...options.stdin, contents: entryContents, loader: "js" }
        : undefined,
      outdir: options.outdir,
      outfile: options.outfile,
      outbase: options.outbase,
      entryNames: options.entryNames,
      chunkNames: options.chunkNames,
      splitting: options.splitting,
      outExtension: options.outExtension,
      resolveExtensions: options.resolveExtensions,
      tsconfig: options.tsconfig,
      tsconfigRaw: options.tsconfigRaw,
      alias: options.alias,
      platform: options.platform,
      conditions: options.conditions,
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      logLevel: "silent",
      plugins: [
        {
          name: "mincho-entry-layout",

          setup(build) {
            build.onResolve({ filter: /^mincho:layout-chunk$/ }, () => ({
              path: "dynamic",
              namespace: "mincho-layout-chunk"
            }));
            build.onResolve({ filter: /.*/ }, async (args) => {
              if (args.kind !== "entry-point") return;

              return ownerBuild.resolve(args.path, {
                kind: "entry-point",
                namespace: args.namespace,
                resolveDir: args.resolveDir
              });
            });
            build.onLoad({ filter: /.*/ }, (args) => ({
              contents:
                args.namespace === "mincho-layout-chunk"
                  ? "export const value = 42;"
                  : entryContents,
              loader: "js"
            }));
          }
        }
      ]
    });

    const entryOutputs = Object.entries(probe.metafile.outputs).filter(
      ([, output]) =>
        output.entryPoint !== undefined &&
        output.entryPoint !== "mincho-layout-chunk:dynamic"
    );

    const directories = entryOutputs.map(([, output]) =>
      output.entryPoint === "<stdin>"
        ? (options.stdin?.resolveDir ?? this.cwd)
        : dirname(resolve(this.cwd, output.entryPoint!))
    );

    return {
      outbase: options.outbase
        ? resolve(this.cwd, options.outbase)
        : commonDirectory(directories, this.cwd),
      outputDirectories: [
        ...new Set(
          Object.keys(probe.metafile.outputs).map((path) =>
            dirname(resolve(this.cwd, path))
          )
        )
      ]
    };
  }

  private async buildAsset({
    path,
    suffix,
    contents,
    loader,
    outdir,
    outbase,
    helperDirectory
  }: {
    path: string;
    suffix: string;
    contents: Uint8Array;
    loader: "file" | "dataurl";
    outdir: string;
    outbase: string;
    helperDirectory: string;
  }): Promise<Asset> {
    const options = this.build.initialOptions;
    const result = await this.build.esbuild.build({
      absWorkingDir: this.cwd,
      entryPoints: [
        {
          in: "mincho:asset-helper",
          out: relative(
            outdir,
            resolve(helperDirectory, "__mincho_asset_helper")
          )
        }
      ],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      outdir,
      outbase,
      entryNames: "[dir]/[name]-[hash]",
      assetNames: options.assetNames,
      publicPath: options.publicPath,
      logLevel: "silent",
      plugins: [
        {
          name: "mincho-native-asset",

          setup(build) {
            build.onResolve({ filter: /^mincho:asset-helper$/ }, () => ({
              path: "entry",
              namespace: "mincho-asset-helper"
            }));
            build.onLoad(
              { filter: /.*/, namespace: "mincho-asset-helper" },
              () => ({
                contents: 'export { default } from "mincho:asset";',
                loader: "js"
              })
            );
            build.onResolve({ filter: /^mincho:asset$/ }, () => ({
              path,
              suffix,
              namespace: "file"
            }));
            build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
              if (args.path !== path) return;

              return { contents, loader };
            });
          }
        }
      ]
    });

    const metafile = result.metafile;
    const helperPaths = new Set(
      Object.entries(metafile.outputs)
        .filter(([, output]) => output.entryPoint !== undefined)
        .map(([path]) => resolve(this.cwd, path))
    );

    const helper = result.outputFiles.find((file) =>
      helperPaths.has(resolve(file.path))
    );
    if (!helper) throw new Error(`Missing native asset helper for ${path}`);

    const url = readDefaultStringExport(helper.text);
    const outputFiles = result.outputFiles.filter(
      (file) => !helperPaths.has(resolve(file.path))
    );

    for (const output of Object.keys(metafile.outputs)) {
      if (helperPaths.has(resolve(this.cwd, output)))
        delete metafile.outputs[output];
    }

    delete metafile.inputs["mincho-asset-helper:entry"];

    return { path, suffix, url, outputFiles, metafile };
  }
}

function getAssetLoader(
  path: string,
  options: BuildOptions
): "file" | "dataurl" {
  const loader = findAssetLoader(path, options);
  if (!loader) {
    throw new Error(
      `Static ?url import ${path} requires an esbuild file or dataurl loader.`
    );
  }

  return loader;
}

function findAssetLoader(
  path: string,
  options: BuildOptions
): "file" | "dataurl" | undefined {
  const extension = Object.keys(options.loader ?? {})
    .sort((a, b) => b.length - a.length)
    .find((extension) => path.endsWith(extension));

  const loader = extension ? options.loader?.[extension] : undefined;

  return loader === "file" || loader === "dataurl" ? loader : undefined;
}

function getOutputDirectory(
  options: BuildOptions,
  cwd: string,
  loader: "file" | "dataurl"
): string {
  if (options.outdir) return resolve(cwd, options.outdir);
  if (options.outfile) return dirname(resolve(cwd, options.outfile));

  // esbuild itself rejects a file loader without an output directory.
  if (loader === "file") {
    throw new Error(
      "Static ?url file imports require esbuild outdir or outfile."
    );
  }

  return cwd;
}

function getEntryPoints(options: BuildOptions): string[] {
  const entries = options.entryPoints;
  if (!entries) return [];

  return Array.isArray(entries)
    ? entries.map((entry) => (typeof entry === "string" ? entry : entry.in))
    : Object.values(entries);
}

function commonDirectory(directories: string[], fallback: string): string {
  let common = directories[0] ?? fallback;

  for (const directory of directories.slice(1)) {
    while (true) {
      const path = relative(common, directory);
      if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
        break;

      const parent = dirname(common);
      if (parent === common) return fallback;

      common = parent;
    }
  }

  return common;
}

function readDefaultStringExport(source: string): string {
  const ast = parse(source, { sourceType: "module" });
  const strings = new Map<string, string>();

  for (const statement of ast.program.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.init?.type === "StringLiteral"
        ) {
          strings.set(declaration.id.name, declaration.init.value);
        }
      }
    }

    if (statement.type === "ExportDefaultDeclaration") {
      if (statement.declaration.type === "StringLiteral")
        return statement.declaration.value;

      if (statement.declaration.type === "Identifier") {
        const value = strings.get(statement.declaration.name);
        if (value !== undefined) return value;
      }
    }

    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier") continue;

        const exported =
          specifier.exported.type === "Identifier"
            ? specifier.exported.name
            : specifier.exported.value;

        if (exported === "default") {
          const value = strings.get(specifier.local.name);
          if (value !== undefined) return value;
        }
      }
    }
  }

  throw new Error("The native asset loader did not export a string constant.");
}

function assertSameOutput(
  path: string,
  left: Uint8Array,
  right: Uint8Array
): void {
  if (!Buffer.from(left).equals(right)) {
    throw new Error(`Conflicting esbuild asset output: ${path}`);
  }
}

function compareOutputPaths(a: OutputFile, b: OutputFile): number {
  return a.path.localeCompare(b.path);
}

function mergeMetafile(target: Metafile, source: Metafile): void {
  Object.assign(target.inputs, source.inputs);

  for (const [path, output] of Object.entries(source.outputs)) {
    const existing = target.outputs[path];

    if (existing) Object.assign(existing.inputs, output.inputs);
    else target.outputs[path] = output;
  }
}

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Plugin } from "esbuild";
import type { CompileOptions } from "./compile.js";
import {
  cacheDigest,
  configurationFiles,
  fingerprintFiles,
  unchangedFiles,
  hasExternalBabelConfiguration
} from "./compilationCache.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";

export interface CompileCacheBridge {
  readonly plugin: Plugin;
  readonly key: string;

  capture(): {
    readonly files: readonly { path: string; digest: string }[];
    readonly data: unknown;
  };

  restore(data: unknown): Promise<boolean>;
}

type Compiled = { source: string; watchFiles: string[] };

/** Cache compilation only. CSS execution and registry publication remain per generation. */
export async function cachedCompile(
  options: CompileOptions,
  compile: (options: CompileOptions) => Promise<Compiled>
): Promise<Compiled> {
  const { cache, cacheBridge, plugins = [] } = options;

  if (
    !cache ||
    (plugins.length > 0 &&
      (plugins.length !== 1 || plugins[0] !== cacheBridge?.plugin))
  ) {
    if (cache)
      recordCompilationDiagnostic("cache-bypass", {
        reason: "opaque-compile-plugin"
      });

    return compile(options);
  }

  let configurations: Map<string, string | null>;

  try {
    configurations = await fingerprintFiles(
      configurationFiles([
        options.originalPath,
        // Scoped dependency transforms also load Babel's root configuration.
        join(process.cwd(), "babel.config.js")
      ])
    );
  } catch {
    return compile(options);
  }

  if (await hasExternalBabelConfiguration(configurations))
    return compile(options);

  const cwd = options.cwd ?? process.cwd();
  const key = `compile:${cacheDigest(
    JSON.stringify([
      options.originalPath,
      options.filePath,
      options.contents,
      cwd,
      options.externals,
      options.loader,
      cacheBridge?.key,
      process.env.NODE_ENV,
      process.env.BABEL_ENV
    ])
  )}`;

  const result = await cache.run(key, async () => {
    const observed = new Map<string, string | null>();
    let cacheable = true;

    const observe = async (file: string, bytes: string | Uint8Array) => {
      const digest = cacheDigest(bytes);

      if (observed.has(file) && observed.get(file) !== digest)
        cacheable = false;

      observed.set(file, digest);

      const missing = configurationFiles([file]).filter(
        (path) => !configurations.has(path)
      );

      try {
        for (const [path, value] of await fingerprintFiles(missing))
          configurations.set(path, value);
      } catch {
        cacheable = false;
      }
    };

    const readText = async (file: string) => {
      const text = await (options.readFile?.(file) ?? readFile(file, "utf8"));
      await observe(file, text);

      return text;
    };

    const readBytes = async (file: string) => {
      const bytes = await (options.readFileBytes?.(file) ?? readFile(file));
      await observe(file, bytes);

      return bytes;
    };

    const compiled = await compile({
      ...options,
      readFile: readText,
      readFileBytes: readBytes
    });

    const bridge = cacheBridge?.capture();

    for (const file of bridge?.files ?? [])
      observed.set(file.path, file.digest);

    const synthetic = new Set([
      resolve(options.filePath),
      resolve(cwd, basename(options.filePath))
    ]);

    for (const dependency of compiled.watchFiles)
      if (!synthetic.has(dependency) && !observed.has(dependency))
        cacheable = false;

    const fingerprints = new Map([...configurations, ...observed]);

    try {
      if (!(await unchangedFiles(fingerprints))) cacheable = false;
    } catch {
      cacheable = false;
    }

    // A source transform supplied by an external Babel configuration can read
    // arbitrary inputs. Its execution is deliberately not memoized.
    if (await hasExternalBabelConfiguration(configurations)) cacheable = false;

    const watches = [...configurations]
      .filter(
        ([file, value]) =>
          value !== null &&
          !value.startsWith("directory:") &&
          file.startsWith(cwd + "/")
      )
      .map(([file]) => file);

    const value = {
      source: compiled.source,
      watchFiles: [
        ...new Set([
          ...compiled.watchFiles,
          ...watches,
          ...(bridge?.files.map((file) => file.path) ?? [])
        ])
      ],
      bridge: bridge?.data
    };

    return {
      value,
      dependencies: [options.originalPath, ...fingerprints.keys()],
      bytes: cacheable ? Buffer.byteLength(JSON.stringify(value)) : Infinity,

      valid: () => unchangedFiles(fingerprints)
    };
  });

  if (cacheBridge && !(await cacheBridge.restore(result.bridge))) {
    cache.invalidate(options.originalPath);

    return compile(options);
  }

  return { source: result.source, watchFiles: [...result.watchFiles] };
}

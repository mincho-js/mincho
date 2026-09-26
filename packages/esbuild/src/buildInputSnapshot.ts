import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { BuildOptions, Loader, OnLoadArgs, OnLoadResult } from "esbuild";
import {
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageGraph
} from "@mincho-js/integration";

export type BuildPhase = "analyze" | "emit";

/** One transaction only: no pending reads or failed promises survive a build. */
export class BuildInputSnapshot {
  private readonly files = new Map<string, Promise<Buffer>>();
  private readonly observations = new Map<string, string>();
  private readonly observedInEmit = new Set<string>();
  private readonly configurations = new Map<string, Promise<Buffer | null>>();
  private readonly configurationDirectories = new Set<string>();

  async trackConfiguration(path: string): Promise<void> {
    if (this.files.has(path)) return;

    if (!this.configurations.has(path)) {
      this.configurations.set(
        path,
        readFile(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;

          throw error;
        })
      );
    }

    await this.configurations.get(path);
  }

  async trackConfigurationAncestors(path: string): Promise<void> {
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      if (this.configurationDirectories.has(directory)) break;

      this.configurationDirectories.add(directory);
      await Promise.all(
        ["package.json", "tsconfig.json", ".pnp.cjs", ".pnp.data.json"].map(
          (name) => this.trackConfiguration(join(directory, name))
        )
      );

      if (dirname(directory) === directory) break;
    }
  }

  hasObservation(key: string): boolean {
    return this.observations.has(key);
  }

  readFile(path: string): Promise<Buffer> {
    let contents = this.files.get(path);

    if (!contents) {
      contents = this.trackConfigurationAncestors(path).then(() =>
        readFile(path)
      );
      this.files.set(path, contents);
    }

    return contents;
  }

  observe(phase: BuildPhase, key: string, contents: string | Uint8Array): void {
    const digest = createHash("sha256").update(contents).digest("hex");
    const previous = this.observations.get(key);

    if (phase === "analyze") {
      if (previous !== undefined && previous !== digest) {
        throw new Error(`Mincho build input changed during analysis: ${key}`);
      }

      this.observations.set(key, digest);
    } else {
      if (previous !== digest) {
        throw new Error(
          `Mincho build input changed between passes: ${key}. Rebuild with stable inputs.`
        );
      }

      this.observedInEmit.add(key);
    }
  }

  async validate(): Promise<void> {
    for (const [path, pending] of this.configurations) {
      const original = await pending;
      const current = await readFile(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;

          throw error;
        }
      );
      if (
        original === null
          ? current !== null
          : current === null || !original.equals(current)
      ) {
        throw new Error(
          `Mincho build configuration changed between passes: ${path}. Rebuild with stable inputs.`
        );
      }
    }

    for (const [path, pending] of this.files) {
      const original = await pending;
      const current = await readFile(path);
      if (!original.equals(current)) {
        throw new Error(
          `Mincho build input changed between passes: ${path}. Rebuild with stable inputs.`
        );
      }
    }

    for (const key of this.observations.keys()) {
      if (!this.observedInEmit.has(key)) {
        throw new Error(
          `Mincho build input disappeared between passes: ${key}`
        );
      }
    }
  }
}

export interface BuildTransaction {
  phase: BuildPhase;
  snapshot: BuildInputSnapshot;
  graphs: Map<string, DefineRulesPackageGraph>;
  styles: Map<string, Set<string>>;
  graphParts?: Map<string, Map<string, DefineRulesPackageGraph>>;
}

export function recordPackageGraph(
  transaction: BuildTransaction,
  owner: string,
  part: string,
  graph: DefineRulesPackageGraph
): void {
  const allParts = (transaction.graphParts ??= new Map());
  const parts =
    allParts.get(owner) ?? new Map<string, DefineRulesPackageGraph>();

  const previous = parts.get(part);
  if (previous && JSON.stringify(previous) !== JSON.stringify(graph))
    throw new Error(
      `Mincho registry graph changed within one pass: ${owner} (${part})`
    );

  parts.set(part, graph);
  allParts.set(owner, parts);
  transaction.graphs.set(
    owner,
    mergeDefineRulesPackageGraphs(
      [...parts]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, value]) => value)
    )
  );
}

const transactions = new WeakMap<BuildOptions, BuildTransaction>();

export const setBuildTransaction = (
  options: BuildOptions,
  transaction: BuildTransaction
): void => {
  transactions.set(options, transaction);
};

export const getBuildTransaction = (
  options: BuildOptions
): BuildTransaction | undefined => transactions.get(options);

export function inputKey(args: OnLoadArgs): string {
  return JSON.stringify([args.namespace, args.path, args.suffix, args.with]);
}

export function effectiveLoader(
  path: string,
  loaders: BuildOptions["loader"]
): Loader | undefined {
  const configured = Object.keys(loaders ?? {})
    .sort((a, b) => b.length - a.length)
    .find((extension) => path.endsWith(extension));
  if (configured) return loaders![configured];

  const defaults: Record<string, Loader> = {
    ".js": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".jsx": "jsx",
    ".ts": "ts",
    ".mts": "ts",
    ".cts": "ts",
    ".tsx": "tsx",
    ".css": "css",
    ".json": "json"
  };

  return defaults[extname(path)];
}

export function observeLoad(
  transaction: BuildTransaction,
  args: OnLoadArgs,
  result: OnLoadResult
): void {
  if (result.contents === undefined) return;

  transaction.snapshot.observe(
    transaction.phase,
    `load-options:${inputKey(args)}`,
    JSON.stringify([
      result.loader ?? "js",
      result.resolveDir ?? "",
      [...(result.watchFiles ?? [])].sort(),
      [...(result.watchDirs ?? [])].sort()
    ])
  );
  transaction.snapshot.observe(
    transaction.phase,
    `load:${inputKey(args)}:${result.loader ?? "js"}`,
    result.contents
  );
}

import { createHash } from "node:crypto";
import {
  internalAnalyzeExtractCalls,
  internalCanonicalExtractCallsFile,
  InternalSourceAstCache,
  type InternalPreparedExtractCalls
} from "@mincho-js/babel";
import type { BabelOptions, StaticCssEvalSourceProvider } from "./babel.js";
import { driveModuleGraph } from "./moduleGraph.js";
import { createStaticCssEvalPrepass } from "./staticCssEvalPrepass.js";

/** Compose the complete host receipt before worker dispatch or cache observation. */
export function retainRuntimeSourceDependencies(
  runtimeSource: NonNullable<BabelOptions["consumerRuntimeSource"]>,
  provider?: StaticCssEvalSourceProvider,
  parserCache?: Parameters<
    typeof internalAnalyzeExtractCalls
  >[0]["parserCache"],
  parserPlugins?:
    | NonNullable<BabelOptions["parserOpts"]>["plugins"]
    | (() => NonNullable<BabelOptions["parserOpts"]>["plugins"])
): NonNullable<BabelOptions["consumerRuntimeSource"]> {
  const runtimeDependencies = new Map<
    string,
    Promise<{ complete: boolean; watchFiles: string[]; version: string }>
  >();
  const retainAuthoringDependencies = async (id: string) => {
    const existing = runtimeDependencies.get(id);
    if (existing) return existing;
    const discovery = (async () => {
      const retained = new Set<string>([id]);
      const observations: unknown[] = [];
      const result = (complete: boolean) => ({
        complete,
        watchFiles: [...retained].sort(),
        version: createHash("sha256")
          .update(JSON.stringify(observations))
          .digest("hex")
      });
      if (!provider) return result(false);

      try {
        const dependencies = await createStaticCssEvalPrepass(
          id,
          {
            ...provider,
            async resolve(...args) {
              const resolved = await provider.resolve(...args);
              observations.push(["resolve", args, resolved]);
              for (const file of resolved?.watchFiles ?? []) retained.add(file);

              return resolved;
            },
            async load(moduleId) {
              retained.add(moduleId);
              const loaded = await provider.load(moduleId);
              observations.push(["load", moduleId, loaded]);
              for (const file of loaded?.watchFiles ?? []) retained.add(file);

              return loaded;
            }
          },
          parserCache,
          undefined,
          "execution-dependencies",
          typeof parserPlugins === "function" ? parserPlugins() : parserPlugins
        );
        for (const file of dependencies.result.dependencyFiles)
          retained.add(file);

        return result(dependencies.executionDependenciesComplete === true);
      } catch {
        // Retain observed watches even when source discovery cannot complete.
        // An unavailable receipt is never a persistent negative cache entry.
        return {
          complete: false,
          watchFiles: [...retained].sort(),
          version: ""
        };
      }
    })();
    runtimeDependencies.set(id, discovery);

    return discovery;
  };

  return async (id) => {
    const runtime = await runtimeSource(id);
    if (runtime === undefined) return undefined;
    const dependencies = await retainAuthoringDependencies(
      runtime.authoringId ?? id
    );
    const watchFiles = [
      ...new Set([...runtime.watchFiles, ...dependencies.watchFiles])
    ].sort();

    if (!dependencies.complete || runtime.source === undefined)
      return { watchFiles };

    return {
      ...runtime,
      watchFiles,
      // Source-policy, virtual-source and resolver changes are also inputs,
      // even when all physical watched files remain byte-identical.
      version: JSON.stringify([runtime.version, dependencies.version])
    };
  };
}

export async function prepareExtractCalls(
  options: Parameters<typeof internalAnalyzeExtractCalls>[0],
  provider?: StaticCssEvalSourceProvider,
  runtimeSource?: BabelOptions["consumerRuntimeSource"]
): Promise<InternalPreparedExtractCalls> {
  const watchFiles = new Set<string>();
  const analysis = internalAnalyzeExtractCalls({
    ...options,
    filename: internalCanonicalExtractCallsFile(options.filename)
  });
  const prepared = await driveModuleGraph(
    analysis,
    provider,
    watchFiles,
    undefined,
    runtimeSource
  );

  return {
    ...prepared,
    dependencies: [...new Set([...prepared.dependencies, ...watchFiles])].sort()
  };
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore import.meta is removed from the CommonJS build.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore import.meta is removed from the CommonJS build.
  const { expect, it } = import.meta.vitest;
  const source = 'export const theme = "compiled";';
  const runtime = () => ({
    source,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    version: "host-context",
    watchFiles: ["/host-input.ts"]
  });

  it.each([
    'const load = process.getBuiltinModule("module").createRequire(import.meta.url); export const theme = load("./tokens.cjs").theme;',
    'export const theme = await import("node:module").then(({ createRequire }) => createRequire(import.meta.url)("./tokens.cjs").theme);',
    'export const theme = await import("node:module").finally(() => {}).then(({ createRequire }) => createRequire(import.meta.url)("./tokens.cjs").theme);'
  ])(
    "withholds an erased runtime receipt for an opaque loader: %s",
    async (source: string) => {
      const provider: StaticCssEvalSourceProvider = {
        resolve: () => null,
        load: () => ({ source })
      };
      expect(
        await retainRuntimeSourceDependencies(
          runtime,
          provider
        )("/theme.css.ts")
      ).toEqual({
        watchFiles: ["/host-input.ts", "/theme.css.ts"]
      });
    }
  );

  it("retains configured syntax in owners and dependencies without reusing incompatible parses", async () => {
    const cache = new InternalSourceAstCache();
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => ({ id: "/tokens.ts" }),
      load: (id) => ({
        source:
          id === "/theme.css.ts"
            ? 'import "./tokens.ts"; @sealed class Theme {}'
            : '@sealed class Tokens {} export const tokens = <const>{ color: "red" };'
      })
    };
    const configured = await retainRuntimeSourceDependencies(
      runtime,
      provider,
      cache,
      ["jsx", ["decorators", { decoratorsBeforeExport: true }]]
    )("/theme.css.ts");
    expect(configured?.source).toBe(source);
    expect(configured?.watchFiles).toContain("/tokens.ts");
    const unconfigured = await retainRuntimeSourceDependencies(
      runtime,
      provider,
      cache
    )("/theme.css.ts");
    expect(unconfigured?.source).toBeUndefined();
  });

  it.each([
    ['const specifier = "./tokens.cjs"; require(specifier);', true],
    ["const specifier = `./tokens.cjs`; require(specifier);", true],
    ["require(getSpecifier());", false],
    [
      'let specifier = "./tokens.cjs"; specifier = getSpecifier(); require(specifier);',
      false
    ]
  ] as const)(
    "tracks CommonJS execution dependencies: %s",
    async (owner: string, complete: boolean) => {
      const resolutions: unknown[] = [];
      const provider: StaticCssEvalSourceProvider = {
        resolve: (importer, specifier, options) => {
          resolutions.push([importer, specifier, options?.kind]);
          return { id: specifier.replace(".", "") };
        },
        load: (id) => ({
          source:
            id === "/theme.css.ts"
              ? owner
              : id === "/tokens.cjs"
                ? 'const path = "./colors.cjs"; module.exports = require(path);'
                : 'module.exports = { color: "red" };'
        })
      };
      const receipt = await retainRuntimeSourceDependencies(
        runtime,
        provider
      )("/theme.css.ts");
      expect(receipt?.source !== undefined).toBe(complete);
      if (complete) {
        expect(receipt?.watchFiles).toEqual([
          "/colors.cjs",
          "/host-input.ts",
          "/theme.css.ts",
          "/tokens.cjs"
        ]);
        expect(resolutions).toEqual([
          ["/theme.css.ts", "./tokens.cjs", "require"],
          ["/tokens.cjs", "./colors.cjs", "require"]
        ]);
      }
    }
  );

  it.each([
    ['await import("./tokens.ts");', true],
    ['void import("./tokens.ts");', true],
    ["import(getSpecifier());", false]
  ] as const)(
    "tracks dynamic import execution dependencies: %s",
    async (owner: string, complete: boolean) => {
      const provider: StaticCssEvalSourceProvider = {
        resolve: (_, specifier) => ({ id: specifier.replace(".", "") }),
        load: (id) => ({
          source: id === "/theme.css.ts" ? owner : 'export const color = "red";'
        })
      };
      const receipt = await retainRuntimeSourceDependencies(
        runtime,
        provider
      )("/theme.css.ts");
      expect(receipt?.source !== undefined).toBe(complete);
      if (complete) expect(receipt?.watchFiles).toContain("/tokens.ts");
    }
  );

  it("withholds runtime facts when the owner source policy is unsupported", async () => {
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => null,
      load: () => ({
        source: "export {};",
        sourceKind: "unsupported-source-shape",
        sourceOrigin: "unsupported",
        watchFiles: ["/owner-policy.ts"]
      })
    };
    expect(
      await retainRuntimeSourceDependencies(runtime, provider)("/theme.css.ts")
    ).toEqual({
      watchFiles: ["/host-input.ts", "/owner-policy.ts", "/theme.css.ts"]
    });
  });

  it.each(["unresolved", "missing", "unsupported", "invalid"] as const)(
    "withholds runtime facts for a %s transitive authoring source",
    async (failure: string) => {
      const provider: StaticCssEvalSourceProvider = {
        resolve: () =>
          failure === "unresolved" ? null : { id: "/tokens.foo" },
        load: (id) =>
          id === "/theme.css.ts"
            ? {
                source:
                  'import "./tokens.foo"; export const theme = createTheme();'
              }
            : failure === "missing"
              ? null
              : failure === "unsupported"
                ? {
                    source: 'import "./unseen.ts";',
                    sourceKind: "unsupported-source-shape",
                    sourceOrigin: "unsupported"
                  }
                : { source: "export const =", watchFiles: ["/tokens-input.ts"] }
      };
      const receipt = await retainRuntimeSourceDependencies(
        runtime,
        provider
      )("/theme.css.ts");

      expect(receipt?.source).toBeUndefined();
      expect(receipt?.watchFiles).toContain("/host-input.ts");
      expect(receipt?.watchFiles).toContain("/theme.css.ts");
      if (failure !== "unresolved")
        expect(receipt?.watchFiles).toContain("/tokens.foo");
      if (failure === "invalid")
        expect(receipt?.watchFiles).toContain("/tokens-input.ts");
    }
  );

  it("retains the host-declared external boundary", async () => {
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => ({
        id: "node:fs",
        sourceKind: "external-no-source",
        sourceOrigin: "external"
      }),
      load: (id) =>
        id === "/theme.css.ts"
          ? { source: 'import "node:fs"; export const theme = createTheme();' }
          : null
    };
    expect(
      await retainRuntimeSourceDependencies(runtime, provider)("/theme.css.ts")
    ).toMatchObject({ source });
  });

  it("binds erased virtual authoring sources to the final runtime version", async () => {
    let version = 1;
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => ({
        id: "virtual:tokens",
        sourceKind: "provider-virtual",
        sourceOrigin: "provider"
      }),
      load: (id) =>
        id === "/theme.css.ts"
          ? {
              source:
                'import "virtual:tokens"; export const theme = createTheme();'
            }
          : { source: `export const token = ${version};`, version }
    };
    const first = await retainRuntimeSourceDependencies(
      runtime,
      provider
    )("/theme.css.ts");
    version++;
    const second = await retainRuntimeSourceDependencies(
      runtime,
      provider
    )("/theme.css.ts");

    expect(first?.source).toBe(source);
    expect(second?.source).toBe(source);
    if (first?.source === undefined || second?.source === undefined)
      throw new Error("Expected completed runtime receipts");
    expect(second.version).not.toBe(first.version);
    expect(second.watchFiles).toEqual(first.watchFiles);
  });
}

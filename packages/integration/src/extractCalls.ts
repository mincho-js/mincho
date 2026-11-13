import { hasNativeCssIntrinsicEffects } from "./staticCssEvalSource.js";
import { createHash } from "node:crypto";
import {
  internalAnalyzeExtractCalls,
  internalCanonicalExtractCallsFile,
  InternalSourceAstCache,
  type InternalPreparedExtractCalls
} from "@mincho-js/babel";
import type { BabelOptions, StaticCssEvalSourceProvider } from "./babel.js";
import { driveModuleGraph } from "./moduleGraph.js";
import {
  createStaticCssEvalPrepass,
  StaticCssEvalExecutionRecordCache
} from "./staticCssEvalPrepass.js";

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
  const executionRecords = new StaticCssEvalExecutionRecordCache();
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
          typeof parserPlugins === "function" ? parserPlugins() : parserPlugins,
          executionRecords
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

  return async (id, request) => {
    const runtime = await (request === undefined
      ? runtimeSource(id)
      : runtimeSource(id, request));
    if (runtime === undefined) return undefined;
    // The host has proved a native non-JS terminal. Parsing its CSS as script
    // cannot strengthen that effect-only witness and must not erase it.
    if (hasNativeCssIntrinsicEffects(runtime)) return runtime;
    // Effect-only views carry no value/recipe authority. The intrinsic prepass
    // independently follows raw/runtime edges and records their identities and
    // watches; rewalking every authoring closure here is redundant. Inputs of
    // a virtual authoringId absent from emitted edges remain the host's watch/
    // version responsibility, just like any other erased transform input.
    if (
      request?.purpose === "intrinsic-effects" ||
      request?.purpose === "intrinsic-owner" ||
      request?.purpose === "intrinsic-runtime"
    )
      return runtime;
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
    "intrinsic-owner",
    "intrinsic-effects",
    "intrinsic-runtime"
  ] as const)(
    "preserves %s views without granting ordinary runtime authority",
    async (
      purpose: "intrinsic-owner" | "intrinsic-effects" | "intrinsic-runtime"
    ) => {
      let loads = 0;
      const provider: StaticCssEvalSourceProvider = {
        resolve: () => null,
        load: () => {
          loads++;
          return {
            source: "require(unknownSpecifier);",
            watchFiles: ["/policy.ts"],
            version: "policy-1"
          };
        }
      };
      const request =
        purpose === "intrinsic-owner"
          ? { purpose, sourceHash: "owner-source" }
          : purpose === "intrinsic-runtime"
            ? { purpose }
            : {
                purpose,
                importerId: "/owner.ts",
                specifier: "./theme.css.ts",
                resolutionMode: "import" as const,
                attributes: "none" as const
              };
      let available = true;
      const retained = retainRuntimeSourceDependencies(
        () => (available ? runtime() : { watchFiles: ["/host-input.ts"] }),
        provider
      );
      const effect = await retained("/theme.css.ts", request);
      expect(effect?.source).toBe(source);
      expect(effect).toEqual(runtime());
      expect(loads).toBe(0);
      expect(await retained("/theme.css.ts")).toEqual({
        watchFiles: ["/host-input.ts", "/policy.ts", "/theme.css.ts"]
      });
      expect(loads).toBeGreaterThan(0);
      available = false;
      expect(await retained("/theme.css.ts", request)).toEqual({
        watchFiles: effect?.watchFiles
      });
    }
  );

  it("keeps erased virtual authoring inputs in the host effect receipt", async () => {
    const loaded: string[] = [];
    const host = {
      ...runtime(),
      authoringId: "/virtual/source",
      watchFiles: ["/hidden-input.json"],
      version: "host-generation-1"
    };
    const retained = retainRuntimeSourceDependencies(() => host, {
      resolve: () => null,
      load: (id) => {
        loaded.push(id);
        return { source: "require(opaque);" };
      }
    });
    expect(
      await retained("/emitted.js", { purpose: "intrinsic-runtime" })
    ).toBe(host);
    expect(loaded).toEqual([]);
    expect(await retained("/emitted.js")).toEqual({
      watchFiles: ["/hidden-input.json", "/virtual/source"]
    });
    expect(loaded).toEqual(["/virtual/source"]);
  });

  it.each([
    'const load = globalThis.process.getBuiltinModule("module").createRequire(import.meta.url); export const theme = load("./tokens.cjs").theme;',
    'export const theme = process.mainModule.require("./tokens.cjs").theme;',
    'const { mainModule } = process; export const theme = mainModule.require("./tokens.cjs").theme;',
    'import { _load } from "node:module"; export const theme = _load("./tokens.cjs").theme;',
    'import { Module } from "node:module"; export const theme = Module.prototype.require.call(owner, "./tokens.cjs").theme;',
    'import { _cache } from "node:module"; export const theme = _cache[id].require("./tokens.cjs").theme;',
    'export const theme = module.constructor._load("./tokens.cjs").theme;',
    'export const theme = module.parent.require("./tokens.cjs").theme;',
    'export const theme = module.children[0].require("./tokens.cjs").theme;',
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

  it.each([
    'const styleKey = Symbol.for("@mincho-js/compiler-style-resources/v2"); const styleState = globalThis; export function capture(value) { (styleState[styleKey] ??= []).push(value); }',
    'const captureKey = Symbol.for("@mincho-js/compiler-resources/v1"); const state = globalThis; export function end() { const captures = state[captureKey]; if (!captures?.length) delete state[captureKey]; }'
  ])(
    "retains portable global shim and Symbol registry receipts: %s",
    async (authoring: string) => {
      const result = await retainRuntimeSourceDependencies(runtime, {
        resolve: () => null,
        load: () => ({ source: authoring })
      })("/theme.css.ts");
      expect(result?.source).toBe(source);
      expect(result?.watchFiles).toEqual(["/host-input.ts", "/theme.css.ts"]);
    }
  );

  it.each([
    {
      name: "default",
      host: "export default globalThis;",
      entry: 'import host from "./host.js"; EFFECT',
      complete: false,
      barrel: null
    },
    {
      name: "named alias",
      host: "const handle = globalThis; export { handle as host };",
      entry: 'import { host } from "./host.js"; EFFECT',
      complete: false,
      barrel: null
    },
    {
      name: "namespace",
      host: "export const host = globalThis;",
      entry: 'import * as ns from "./host.js"; const host = ns.host; EFFECT',
      complete: false,
      barrel: null
    },
    {
      name: "namespace destructuring",
      host: "export const host = globalThis;",
      entry: 'import * as ns from "./host.js"; const {host} = ns; EFFECT',
      complete: false,
      barrel: null
    },
    {
      name: "re-export",
      host: "export default globalThis;",
      entry: 'import {host} from "./barrel.js"; EFFECT',
      complete: false,
      barrel: 'export {default as host} from "./host.js";'
    },
    {
      name: "star re-export",
      host: "export const host = globalThis;",
      entry: 'import {host} from "./barrel.js"; EFFECT',
      complete: false,
      barrel: 'export * from "./host.js";'
    },
    {
      name: "cyclic re-export",
      host: 'export * from "./barrel.js"; export const host = globalThis;',
      entry: 'import {host} from "./barrel.js"; EFFECT',
      complete: false,
      barrel: 'export * from "./host.js";'
    },
    {
      name: "safe observation",
      host: "export const host = globalThis;",
      entry:
        'import {host} from "./host.js"; export const theme=host.process.env.NODE_ENV;',
      complete: true,
      barrel: null
    },
    {
      name: "safe commonjsHelpers",
      host: "export var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {}; export function getDefaultExportFromCjs(x) { return x && x.__esModule ? x.default : x; }",
      entry:
        'import {getDefaultExportFromCjs} from "./host.js"; export const theme=getDefaultExportFromCjs({default:"red"});',
      complete: true,
      barrel: null
    },
    {
      name: "public re-export",
      host: "export const host = globalThis;",
      entry: 'export {host} from "./host.js";',
      complete: false,
      barrel: null
    },
    {
      name: "opaque call",
      host: "export const host = globalThis;",
      entry: 'import {host} from "./host.js"; consume(host);',
      complete: false,
      barrel: null
    },
    {
      name: "dynamic import",
      host: "export const host = globalThis;",
      entry: 'const {host}=await import("./host.js"); EFFECT',
      complete: false,
      barrel: null
    },
    {
      name: "CommonJS consumer",
      host: "export const host = globalThis;",
      entry: 'const {host}=require("./host.js"); EFFECT',
      complete: false,
      barrel: null
    }
  ])(
    "tracks exported global handles before issuing receipts: $name",
    async ({
      host,
      entry,
      barrel,
      complete
    }: {
      host: string;
      entry: string;
      barrel: string | null;
      complete: boolean;
    }) => {
      const sources: Record<string, string> = {
        "/entry.js": entry.replace(
          "EFFECT",
          'export const theme = host.process.getBuiltinModule("module").createRequire(import.meta.url)("./tokens.cjs").theme;'
        ),
        "/host.js": host,
        ...(barrel ? { "/barrel.js": barrel } : {})
      };
      const result = await retainRuntimeSourceDependencies(runtime, {
        resolve: (_importer, specifier) => ({
          id: specifier.replace("./", "/")
        }),
        load: (id) =>
          sources[id] === undefined ? null : { source: sources[id] }
      })("/entry.js");
      expect(result?.source).toBe(complete ? source : undefined);
      expect(result?.watchFiles).toContain("/host.js");
      if (barrel) expect(result?.watchFiles).toContain("/barrel.js");
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
  it("reuses discovery syntax within one request without reusing graph receipts", async () => {
    const parses = new Map<string, number>();
    class CountingParser extends InternalSourceAstCache {
      override parse(input: Parameters<InternalSourceAstCache["parse"]>[0]) {
        parses.set(
          input.resolvedFile,
          (parses.get(input.resolvedFile) ?? 0) + 1
        );
        return super.parse(input);
      }
    }
    const loads: string[] = [];
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => ({ id: "/shared.js" }),
      load(id) {
        loads.push(id);
        return {
          source:
            id === "/shared.js"
              ? "export const host = globalThis;"
              : id === "/safe.js"
                ? 'import "./shared.js"; export const value = 1;'
                : 'import {host} from "./shared.js"; consume(host);'
        };
      }
    };
    const parser = new CountingParser();
    const retain = retainRuntimeSourceDependencies(runtime, provider, parser);
    expect((await retain("/safe.js"))?.source).toBe(source);
    expect((await retain("/opaque.js"))?.source).toBeUndefined();
    expect(parses.get("/shared.js")).toBe(1);
    expect(loads.filter((id) => id === "/shared.js")).toHaveLength(2);
    await retainRuntimeSourceDependencies(
      runtime,
      provider,
      parser
    )("/safe.js");
    expect(parses.get("/shared.js")).toBe(2);
  });

  it("rechecks changed source and resolver policy despite identical provider hashes", async () => {
    let changed = false;
    const provider: StaticCssEvalSourceProvider = {
      resolve: () => ({
        id: "/shared.js",
        resolverKind: changed ? "changed" : "initial"
      }),
      load: (id) => ({
        sourceHash: "unchanged-provider-hash",
        version: 1,
        source:
          id === "/shared.js"
            ? changed
              ? 'process.mainModule.require("./hidden.js");'
              : "export const value = 1;"
            : 'import "./shared.js";'
      })
    };
    const retain = retainRuntimeSourceDependencies(runtime, provider);
    expect((await retain("/first.js"))?.source).toBe(source);
    changed = true;
    expect((await retain("/second.js"))?.source).toBeUndefined();
  });

  it("keys request-local syntax by every loaded identity and parser configuration", () => {
    let parses = 0;
    class CountingParser extends InternalSourceAstCache {
      override parse(input: Parameters<InternalSourceAstCache["parse"]>[0]) {
        parses++;
        return super.parse(input);
      }
    }
    const parser = new CountingParser();
    const cache = new StaticCssEvalExecutionRecordCache();
    const base = { id: "/shared.js", source: "export const value = 1;" };
    cache.get(base, parser);
    cache.get(base, parser);
    expect(parses).toBe(1);
    for (const identity of [
      { source: "export const value = 2;" },
      { version: 2 },
      { sourceHash: "new" },
      { canonicalModuleId: "canonical" },
      { normalizedPathKey: "normalized" },
      { resolvedFile: "/other.js" },
      { realpath: "/real.js" },
      { sourceKind: "provider-virtual" as const },
      { sourceOrigin: "provider" as const },
      { resolverKind: "changed" },
      { watchFiles: ["/policy.json"] }
    ])
      cache.get({ ...base, ...identity }, parser);
    cache.get(base, parser, ["jsx"]);
    expect(parses).toBe(13);
  });
}

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  internalCanonicalExtractCallsFile,
  internalCreateModuleGraph,
  internalResolveExtractCallsFile,
  InternalExtractCallsError,
  type InternalModuleGraphFlow
} from "@mincho-js/babel";
import type {
  BabelOptions,
  ConsumerRuntimeSource,
  StaticCssEvalSourceProvider
} from "./babel.js";

/** Drive the same lexical graph with bundler I/O while retaining failed dependency watches. */
export async function driveModuleGraph<T>(
  analysis: InternalModuleGraphFlow<T>,
  provider?: StaticCssEvalSourceProvider,
  watchFiles = new Set<string>(),
  observe?: {
    resolve(importer: string, source: string, id: string): void;
    load(id: string, source: string): void;
  },
  runtimeSource?: BabelOptions["consumerRuntimeSource"]
): Promise<T> {
  const loadKeys = new Map<string, string | null>();
  const identity = (id: string, purpose?: "consumer-runtime") =>
    JSON.stringify([purpose ?? "authoring", id]);
  let step = analysis.next();

  while (!step.done) {
    const request = step.value;

    try {
      let value:
        | string
        | null
        | Extract<ConsumerRuntimeSource, { source: string }>
        | { kind: "conflicting-resolution"; id: string };

      if (request.kind === "resolve") {
        if (provider) {
          const resolved = await provider.resolve(
            request.importer,
            request.source,
            { kind: request.mode ?? "import" }
          );
          for (const file of resolved?.watchFiles ?? []) watchFiles.add(file);

          value =
            (request.purpose === "consumer-runtime"
              ? (resolved?.consumerRuntimeId ??
                resolved?.normalizedPathKey ??
                resolved?.canonicalModuleId)
              : undefined) ??
            resolved?.realpath ??
            resolved?.resolvedFile ??
            resolved?.id ??
            resolved?.canonicalModuleId ??
            null;

          if (value) {
            const loadKey =
              (request.purpose === "consumer-runtime"
                ? resolved?.consumerRuntimeId
                : undefined) ??
              resolved?.normalizedPathKey ??
              resolved?.id ??
              resolved?.canonicalModuleId ??
              value;

            if (request.purpose !== "consumer-runtime" && isAbsolute(value))
              value = internalCanonicalExtractCallsFile(value);

            const key = identity(value, request.purpose);
            // A canonical authoring file can have several host query variants.
            // Never silently select whichever resolution happened last.
            loadKeys.set(
              key,
              loadKeys.has(key) && loadKeys.get(key) !== loadKey
                ? null
                : loadKey
            );
            if (loadKeys.get(key) === null)
              value = { kind: "conflicting-resolution", id: value };
          }
        } else {
          value = internalResolveExtractCallsFile(
            request.importer,
            request.source
          );
        }
      } else if (request.kind === "token-reference") {
        const loadKey = loadKeys.get(identity(request.id));
        const result =
          loadKey === null
            ? null
            : await provider?.tokenReference?.(
                loadKey ?? request.id,
                request.name,
                request.value
              );

        watchFiles.add(request.id);
        value = result?.value ?? null;
      } else {
        const loadKey = loadKeys.get(identity(request.id, request.purpose));
        if (loadKey === null) {
          if (isAbsolute(request.id)) watchFiles.add(request.id);
          step = analysis.next(null);
          continue;
        }
        const runtime =
          request.purpose === "consumer-runtime"
            ? await runtimeSource?.(loadKey ?? request.id)
            : undefined;

        for (const file of runtime?.watchFiles ?? []) watchFiles.add(file);

        if (runtime !== undefined) {
          if (isAbsolute(request.id)) watchFiles.add(request.id);
          if (runtime.source === undefined) {
            step = analysis.next({ kind: "unavailable-runtime" });
          } else {
            observe?.load(request.id, runtime.source);
            step = analysis.next(runtime);
          }
          continue;
        }

        if (request.runtimeOnly) {
          step = analysis.next(null);
          continue;
        }

        const loaded = provider
          ? await provider.load(loadKey ?? request.id)
          : null;

        for (const file of loaded?.watchFiles ?? []) watchFiles.add(file);

        value = provider
          ? (loaded?.sourceText ?? loaded?.source ?? null)
          : await readFile(request.id, "utf8");
      }

      if (typeof value === "string") {
        if (request.kind === "resolve")
          observe?.resolve(request.importer, request.source, value);
        else if (request.kind === "load") observe?.load(request.id, value);
      }
      step = analysis.next(value);
    } catch (error) {
      try {
        step = analysis.throw(error);
      } catch (failure) {
        if (failure instanceof InternalExtractCallsError)
          throw new InternalExtractCallsError(
            failure.message,
            [...failure.dependencies, ...watchFiles],
            { cause: failure.cause }
          );

        throw failure;
      }
    }
  }

  return step.value;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore import.meta is removed from the CommonJS build.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore import.meta is removed from the CommonJS build.
  const { expect, it, vi } = import.meta.vitest;

  function* loadSurface(
    purpose?: "consumer-runtime"
  ): InternalModuleGraphFlow<unknown> {
    const id = yield {
      kind: "resolve",
      importer: "/app.ts",
      source: "./theme.css.ts?theme=dark",
      mode: "require",
      purpose
    };
    if (typeof id !== "string") throw new Error("Expected resolved module");

    return yield { kind: "load", id, purpose };
  }

  const provider = () => ({
    resolve: vi.fn(() => ({
      realpath: "/theme.css.ts",
      normalizedPathKey: "/theme.css.ts?theme=dark",
      watchFiles: ["/theme.css.ts"]
    })),
    load: vi.fn(() => ({ source: "export const theme = createTheme();" }))
  });

  it("keeps authoring text separate from the observed host runtime surface", async () => {
    const raw = provider();
    const record = {
      source: 'export const theme = "dark_class";',
      sourceHash: "host-source-hash",
      version: "client:dark:1",
      watchFiles: ["/theme.css.ts", "/tokens.ts"]
    };
    const runtime = vi.fn(() => record);
    const watches = new Set<string>();

    expect(
      await driveModuleGraph(loadSurface(), raw, watches, undefined, runtime)
    ).toBe("export const theme = createTheme();");
    expect(runtime).not.toHaveBeenCalled();
    expect(
      await driveModuleGraph(
        loadSurface("consumer-runtime"),
        raw,
        watches,
        undefined,
        runtime
      )
    ).toBe(record);
    expect(runtime).toHaveBeenCalledWith("/theme.css.ts?theme=dark");
    expect(watches).toContain("/tokens.ts");
    expect(raw.load).toHaveBeenCalledTimes(1);
  });

  it("retains failed runtime dependency watches without substituting authoring text", async () => {
    const raw = provider();
    const watches = new Set<string>();
    const result = await driveModuleGraph(
      loadSurface("consumer-runtime"),
      raw,
      watches,
      undefined,
      () => ({ watchFiles: ["/missing-token.ts"] })
    );

    expect(result).toEqual({ kind: "unavailable-runtime" });
    expect(raw.load).not.toHaveBeenCalled();
    expect(watches).toContain("/missing-token.ts");
  });

  it.each(["/project/node_modules/helper/index.js", "\0host:helper"])(
    "preserves owned unavailable runtime facts at external graph boundaries: %s",
    async (id: string) => {
      const graph = internalCreateModuleGraph({
        loadPurpose: "consumer-runtime"
      });
      const raw = {
        resolve: () => ({ id }),
        load: vi.fn(() => ({ source: "export const alias = {};" }))
      };
      const runtime = vi.fn(() => ({ watchFiles: ["/host-input.ts"] }));
      const watches = new Set<string>();
      const result = await driveModuleGraph(
        graph.objectExportOrigins(id),
        raw,
        watches,
        undefined,
        runtime
      );
      expect(result.unknownExports).toEqual(["[]"]);
      expect(
        await driveModuleGraph(
          graph.objectExportOrigins(id),
          raw,
          watches,
          undefined,
          runtime
        )
      ).toEqual(result);
      expect(runtime).toHaveBeenCalledOnce();
      expect(raw.load).not.toHaveBeenCalled();
      expect(watches).toContain("/host-input.ts");
    }
  );

  it("rechecks host ownership and source on each analysis", async () => {
    const raw = provider();
    const runtime = vi
      .fn<NonNullable<BabelOptions["consumerRuntimeSource"]>>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ watchFiles: ["/tokens.ts"] })
      .mockReturnValueOnce({
        source: 'export const theme = "updated";',
        sourceHash: "updated-source-hash",
        version: "client:dark:2",
        watchFiles: ["/theme.css.ts", "/tokens.ts"]
      });

    const run = () =>
      driveModuleGraph(
        loadSurface("consumer-runtime"),
        raw,
        new Set(),
        undefined,
        runtime
      );
    expect(await run()).toBe("export const theme = createTheme();");
    expect(await run()).toEqual({ kind: "unavailable-runtime" });
    expect(await run()).toMatchObject({
      source: 'export const theme = "updated";',
      version: "client:dark:2"
    });
    expect(runtime).toHaveBeenCalledTimes(3);
  });

  it("does not let consumer resolution overwrite the raw provider load key", async () => {
    const raw = {
      resolve: (_importer: string, source: string) => ({
        realpath: "/module.ts",
        normalizedPathKey: `/module.ts?${source}`
      }),
      load: vi.fn((id: string) => ({ source: id }))
    };
    function* analysis(): InternalModuleGraphFlow<unknown[]> {
      yield { kind: "resolve", importer: "/app.ts", source: "authoring" };
      yield {
        kind: "resolve",
        importer: "/app.ts",
        source: "runtime",
        purpose: "consumer-runtime"
      };
      const authoring = yield { kind: "load", id: "/module.ts" };
      const runtime = yield {
        kind: "load",
        id: "/module.ts?runtime",
        purpose: "consumer-runtime"
      };

      return [authoring, runtime];
    }

    expect(await driveModuleGraph(analysis(), raw)).toEqual([
      "/module.ts?authoring",
      "/module.ts?runtime"
    ]);
  });

  it("fails closed when a canonical raw identity has conflicting host load keys", async () => {
    const raw = {
      resolve: (_importer: string, source: string) => ({
        realpath: "/module.ts",
        normalizedPathKey: `/module.ts?${source}`
      }),
      load: vi.fn(() => ({ source: "ambiguous" }))
    };
    function* analysis(): InternalModuleGraphFlow<unknown> {
      yield {
        kind: "resolve",
        importer: "/app.ts",
        source: "a",
        mode: "import"
      };
      yield {
        kind: "resolve",
        importer: "/app.ts",
        source: "b",
        mode: "require"
      };

      return yield { kind: "load", id: "/module.ts" };
    }

    expect(await driveModuleGraph(analysis(), raw)).toBeNull();
    expect(raw.load).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checks host identity after the canonical module is cached (conflict: %s)",
    async (conflict: boolean) => {
      const graph = internalCreateModuleGraph();
      const raw = {
        resolve: (_importer: string, source: string) => ({
          realpath: "/module.ts",
          normalizedPathKey: `/module.ts?${conflict ? source : "shared"}`
        }),
        load: vi.fn((id: string) => ({
          source: id === "/app.ts" ? "export {};" : "export const value = {};"
        }))
      };
      function* analysis(): InternalModuleGraphFlow<unknown[]> {
        const owner = yield* graph.load("/app.ts");
        const first = yield* graph.importTarget(owner, "a", "value", new Set());
        const second = yield* graph.importTarget(
          owner,
          "b",
          "value",
          new Set()
        );
        return [first, second];
      }

      const result = driveModuleGraph(analysis(), raw);
      if (conflict)
        await expect(result).rejects.toThrow(
          "Conflicting host module variants"
        );
      else {
        const [first, second] = await result;
        expect(first).toEqual(second);
        expect(raw.load).toHaveBeenCalledTimes(2);
      }
    }
  );

  it("keeps an unavailable local runtime import unknown while authoring loads fail", async () => {
    const raw = {
      resolve: () => ({ id: "/dependency.ts" }),
      load: vi.fn((id: string) =>
        id === "/app.ts" ? { source: "export {};" } : null
      )
    };
    const watches = new Set<string>();
    function* analysis(
      purpose?: "consumer-runtime"
    ): InternalModuleGraphFlow<unknown> {
      const graph = internalCreateModuleGraph({ loadPurpose: purpose });
      const owner = yield* graph.load("/app.ts");
      return yield* graph.importTarget(
        owner,
        "./dependency.ts",
        "value",
        new Set()
      );
    }
    const runtime = (id: string) =>
      id === "/dependency.ts"
        ? { watchFiles: ["/missing-token.ts"] }
        : undefined;

    await expect(
      driveModuleGraph(
        analysis("consumer-runtime"),
        raw,
        watches,
        undefined,
        runtime
      )
    ).resolves.toEqual({
      external: true,
      source: "./dependency.ts",
      name: "value",
      mode: "import"
    });
    expect(watches).toContain("/missing-token.ts");
    await expect(driveModuleGraph(analysis(), raw)).rejects.toThrow(
      "Cannot load /dependency.ts"
    );
  });

  it.each([false, true])(
    "preserves emitted behavior for a local runtime receipt (complete: %s)",
    async (complete: boolean) => {
      const { createHash } = await import("node:crypto");
      const { transformSync } = await import("esbuild");
      const { babelTransformSource } = await import("./babel.js");
      const source = `import { system } from './factory.ts';
        import { alias } from './helper.ts';
        alias.css = () => 'blue';
        export const color = system.css();`;
      const sources: Record<string, string> = {
        "/project/entry.ts": source,
        "/project/factory.ts": "export const system = { css: () => 'red' };",
        "/project/helper.ts": complete
          ? "export const alias = { css: () => 'independent' };"
          : "export { system as alias } from './factory.ts';"
      };
      const transformed = await babelTransformSource({
        filename: "/project/entry.ts",
        root: "/project",
        source,
        babel: {
          optimize: { pureFunctions: false },
          extractCalls: { "./factory.ts": ["system.css"] },
          staticCssEvalSourceProvider: {
            resolve: (_importer, specifier) => ({
              id: specifier.replace("./", "/project/")
            }),
            load: (id) =>
              sources[id] === undefined ? null : { source: sources[id] }
          },
          consumerRuntimeSource: (id) =>
            id !== "/project/helper.ts"
              ? undefined
              : complete
                ? {
                    source: sources[id]!,
                    sourceHash: createHash("sha256")
                      .update(sources[id]!)
                      .digest("hex"),
                    version: "complete:1",
                    watchFiles: ["/project/helper.ts"]
                  }
                : { watchFiles: ["/project/helper.ts", "/missing-token.ts"] }
        }
      });
      const execute = (files: Record<string, string>) => {
        const cache = new Map<string, { exports: Record<string, unknown> }>();
        const load = (specifier: string): Record<string, unknown> => {
          const id = specifier.replace("./", "/project/");
          const existing = cache.get(id);
          if (existing) return existing.exports;
          const module = { exports: {} as Record<string, unknown> };
          cache.set(id, module);
          const { code } = transformSync(files[id]!, { format: "cjs" });
          new Function("require", "exports", "module", code)(
            load,
            module.exports,
            module
          );
          return module.exports;
        };
        return load("/project/entry.ts");
      };

      expect(
        execute({
          ...sources,
          "/project/entry.ts": transformed.code,
          [transformed.result[0].replace("./", "/project/")]:
            transformed.result[1]
        })
      ).toEqual(execute(sources));
      expect(transformed.result[1].includes("system.css")).toBe(complete);
      if (!complete)
        expect(transformed.staticCssEval?.dependencyFiles).toContain(
          "/missing-token.ts"
        );
    }
  );

  it("fails closed when a canonical token identity has conflicting host load keys", async () => {
    const raw = {
      resolve: (_importer: string, source: string) => ({
        realpath: "/module.ts",
        normalizedPathKey: `/module.ts?${source}`
      }),
      load: vi.fn(() => ({ source: "ambiguous" })),
      tokenReference: vi.fn(() => ({
        value: "bare-token",
        identity: "fixture-token"
      }))
    };
    function* analysis(): InternalModuleGraphFlow<unknown> {
      yield {
        kind: "resolve",
        importer: "/app.ts",
        source: "a",
        mode: "import"
      };
      yield {
        kind: "resolve",
        importer: "/app.ts",
        source: "b",
        mode: "require"
      };

      return yield {
        kind: "token-reference",
        id: "/module.ts",
        name: "tokens",
        value: "red"
      };
    }

    expect(await driveModuleGraph(analysis(), raw)).toBeNull();
    expect(raw.load).not.toHaveBeenCalled();
    expect(raw.tokenReference).not.toHaveBeenCalled();
  });

  it("requires a host receipt for an opaque module id before reading raw source", async () => {
    const id = "\0host:styles?theme=dark";
    const raw = provider();
    function* analysis(): InternalModuleGraphFlow<unknown> {
      return yield {
        kind: "load",
        id,
        purpose: "consumer-runtime",
        runtimeOnly: true
      };
    }
    expect(
      await driveModuleGraph(
        analysis(),
        raw,
        new Set(),
        undefined,
        () => undefined
      )
    ).toBeNull();
    expect(raw.load).not.toHaveBeenCalled();
    const receipt = {
      source: "export const styles = 'compiled';",
      sourceHash: "test-receipt",
      version: "client:dark",
      watchFiles: ["/styles.ts"]
    };
    expect(
      await driveModuleGraph(
        analysis(),
        raw,
        new Set(),
        undefined,
        () => receipt
      )
    ).toBe(receipt);
    expect(raw.load).not.toHaveBeenCalled();
  });
}

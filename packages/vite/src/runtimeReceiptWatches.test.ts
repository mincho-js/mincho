import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BabelOptions } from "@mincho-js/integration";
import { build, createServer, type InlineConfig } from "vite";
import { expect, it, vi } from "vitest";
import { minchoVitePlugin } from "./index.js";

const receipts = vi.hoisted(
  () =>
    new Map<
      string,
      Awaited<ReturnType<NonNullable<BabelOptions["consumerRuntimeSource"]>>>
    >()
);

vi.mock("@mincho-js/integration", async (original) => {
  const integration = await original<typeof import("@mincho-js/integration")>();
  return {
    ...integration,
    internalCanSkipMinchoTransform: async () => false,
    async babelTransformSource(
      options: Parameters<typeof integration.babelTransformSource>[0]
    ) {
      if (options.source.includes("receipt-owner")) {
        receipts.set(
          options.filename,
          await options.babel?.consumerRuntimeSource?.(
            options.filename.replace("owner-", "runtime-")
          )
        );
      }
      return { code: options.source, result: ["", ""] };
    }
  };
});

it.each(["client", "ssr", "build"])(
  "retains %s runtime host watches for erased imports with module scope where available",
  async (environmentName) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".cache/runtime-watches-"));
    for (const name of ["a", "b"]) {
      for (const [file, source] of Object.entries({
        [`owner-${name}.ts`]: "/* receipt-owner */ export const owner = true;",
        [`runtime-${name}.ts`]: `import "./erased-${name}.ts"; export const value = "authoring";`,
        [`leaf-${name}.ts`]: "export const leaf = true;",
        [`erased-${name}.ts`]: "export const erased = true;",
        [`load-${name}.txt`]: "load input",
        [`transform-${name}.txt`]: "transform input",
        [`leaf-${name}.txt`]: "leaf input"
      }))
        await writeFile(join(root, file), source);
    }

    const config: InlineConfig = {
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: "module-watch-inputs",
          enforce: "pre",
          async load(id) {
            const name = ["a", "b"].find(
              (name) => id === join(root, `runtime-${name}.ts`)
            );
            if (!name) return;
            this.addWatchFile(join(root, `load-${name}.txt`));
            return readFile(id, "utf8");
          },
          transform(_source, id) {
            for (const name of ["a", "b"]) {
              if (id === join(root, `leaf-${name}.ts`))
                this.addWatchFile(join(root, `leaf-${name}.txt`));
              if (id !== join(root, `runtime-${name}.ts`)) continue;
              this.addWatchFile(join(root, `erased-${name}.ts`));
              this.addWatchFile(join(root, `transform-${name}.txt`));
              return `import "./leaf-${name}.ts"; export const value = "host-${name}";`;
            }
          }
        },
        minchoVitePlugin({ cache: false, execution: { workers: 0 } })
      ]
    };
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      if (environmentName === "build") {
        await build({
          ...config,
          build: {
            write: false,
            minify: false,
            rollupOptions: { input: join(root, "owner-a.ts") }
          }
        });
      } else {
        server = await createServer(config);
        const environment = server.environments[environmentName]!;
        await Promise.all(
          ["a", "b"].map((name) =>
            environment.transformRequest(join(root, `leaf-${name}.ts`))
          )
        );
        await environment.transformRequest(join(root, "owner-b.ts"));
        await environment.transformRequest(join(root, "owner-a.ts"));
      }

      const receipt = receipts.get(join(root, "owner-a.ts"));
      expect(receipt?.source).toContain('"host-a"');
      expect(receipt?.source).not.toContain("erased-a");
      const directWatches = [
        "runtime-a.ts",
        "load-a.txt",
        "transform-a.txt",
        "erased-a.ts"
      ].map((file) => join(root, file));
      if (environmentName === "build") {
        // Rollup only exposes the complete build watch set, including inputs
        // erased by load/transform. Keep that conservative receipt intact.
        expect(receipt?.watchFiles).toEqual(
          expect.arrayContaining(directWatches)
        );
      } else {
        expect(receipt?.watchFiles).toEqual(
          [
            ...directWatches,
            join(root, "leaf-a.ts"),
            join(root, "leaf-a.txt")
          ].sort()
        );
      }
    } finally {
      await server?.close();
      receipts.clear();
      await rm(root, { recursive: true, force: true });
    }
  }
);

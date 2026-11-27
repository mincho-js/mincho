import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import { minchoVitePlugin } from "./index.js";

const coordination = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return {
    arrivals: 0,
    ready: { promise, resolve },
    receipts: [] as Array<
      { source?: string; watchFiles: readonly string[] } | undefined
    >
  };
});

vi.mock("@mincho-js/integration", async (original) => {
  const integration = await original<typeof import("@mincho-js/integration")>();
  return {
    ...integration,
    internalCanSkipMinchoTransform: async () => false,
    async babelTransformSource(
      options: Parameters<typeof integration.babelTransformSource>[0]
    ) {
      if (!options.source.includes("controlled-preparation"))
        return integration.babelTransformSource(options);
      if (++coordination.arrivals === 2) coordination.ready.resolve();
      await coordination.ready.promise;
      const peer = join(
        options.filename,
        "..",
        options.filename.endsWith("a.tsx") ? "b.tsx" : "a.tsx"
      );
      coordination.receipts.push(
        await options.babel?.consumerRuntimeSource?.(peer)
      );
      return {
        code: options.source.replace("generated-", "completed-runtime-"),
        jsxCssPropTransformed: true,
        result: ["", ""]
      };
    }
  };
});

it("finishes independent reciprocal runtime requests without publishing partial peer source", async () => {
  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".cache/preparation-cycle-"));
  const ids = [join(root, "a.tsx"), join(root, "b.tsx")];
  for (const [index, id] of ids.entries())
    await writeFile(
      id,
      `/*controlled-preparation*/ export const recipe = () => "generated-${index}";`
    );
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
    plugins: [
      minchoVitePlugin({
        jsxCssProp: true,
        cache: false,
        execution: { workers: 0 }
      })
    ]
  });
  try {
    const results = await Promise.all(
      ids.map((id) => server.environments.client.transformRequest(id))
    );
    expect(results.map((result) => result?.code)).toEqual([
      expect.stringContaining('"completed-runtime-0"'),
      expect.stringContaining('"completed-runtime-1"')
    ]);
    expect(coordination.arrivals).toBe(2);
    expect(
      coordination.receipts.some((receipt) => receipt?.source === undefined)
    ).toBe(true);
    expect(
      coordination.receipts.some((receipt) =>
        receipt?.source?.includes("completed-runtime-")
      )
    ).toBe(true);
    for (const receipt of coordination.receipts) {
      expect(receipt?.watchFiles.some((file) => ids.includes(file))).toBe(true);
      if (receipt?.source !== undefined) {
        expect(receipt.source).toContain("completed-runtime-");
        expect(receipt.source).not.toContain("generated-");
      }
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

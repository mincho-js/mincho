import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { minchoEsbuildPlugins } from "./plugin.js";

const coordination = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { arrivals: 0, ready: { promise, resolve } };
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
      try {
        await options.babel?.consumerRuntimeSource?.(peer);
      } catch {
        // An analyzer may decline a proof, but the host must still report the
        // preparation cycle instead of publishing incomplete generated code.
      }
      return { code: options.source, result: ["", ""] };
    }
  };
});

it("reports reciprocal waits between independently started host transformations", async () => {
  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".cache/preparation-cycle-"));
  try {
    await writeFile(
      join(root, "entry.tsx"),
      'export * from "./a"; export * from "./b";'
    );
    await writeFile(
      join(root, "a.tsx"),
      '/*controlled-preparation*/ export const a = "a";'
    );
    await writeFile(
      join(root, "b.tsx"),
      '/*controlled-preparation*/ export const b = "b";'
    );
    await expect(
      build({
        absWorkingDir: root,
        entryPoints: ["entry.tsx"],
        outdir: "out",
        bundle: true,
        write: false,
        logLevel: "silent",
        plugins: minchoEsbuildPlugins({
          jsxCssProp: true,
          cache: false,
          execution: { workers: 0 }
        })
      })
    ).rejects.toThrow(
      /Circular script preparation: .*\.tsx -> .*\.tsx -> .*\.tsx/
    );
    expect(coordination.arrivals).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

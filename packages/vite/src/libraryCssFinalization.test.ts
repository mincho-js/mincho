import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Rollup } from "vite";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { afterEach, describe, expect, it } from "vitest";
import { minchoVitePlugin } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const cache = join(process.cwd(), ".cache");
  await mkdir(cache, { recursive: true });

  const root = await mkdtemp(join(cache, "css-finalization-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    '{"name":"css-finalization-fixture","type":"module"}'
  );
  await writeFile(
    join(root, "entry.js"),
    'import "./style.css";\nexport const marker = "CSS_FINALIZATION_MARKER";\n'
  );
  await writeFile(join(root, "style.css"), ".fixture { color: red; }");

  return root;
}

async function compile(
  root: string,
  format: "es" | "cjs",
  cssCodeSplit: boolean,
  prefix = "alpha"
) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      minchoVitePlugin({
        libraryCss: cssCodeSplit
          ? undefined
          : { fileName: `${prefix}-style.css` }
      })
    ],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      sourcemap: true,
      cssCodeSplit,
      lib: { entry: join(root, "entry.js"), formats: [format] },
      rollupOptions: {
        output: {
          entryFileNames: "entry-[hash].js",
          chunkFileNames: "chunk-[hash].js",
          assetFileNames: cssCodeSplit
            ? `${prefix}-[hash][extname]`
            : `${prefix}-style[extname]`
        }
      }
    }
  });

  return (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
}

// Native CSS linking must complete before Rollup hashes and composes source maps.
// Unsplit CSS has an explicit fixed output name; split CSS keeps native hashes.
describe("library CSS native-finalization release gate (U1)", () => {
  for (const format of ["es", "cjs"] as const) {
    for (const split of [false, true]) {
      it(`${format}, split=${split}: includes emitted CSS references in the JS content hash`, async () => {
        const root = await fixture();
        const first = await compile(root, format, split, "alpha");
        const second = await compile(root, format, split, "beta");
        const a = first.output.find(
          (output): output is Rollup.OutputChunk =>
            output.type === "chunk" && output.isEntry
        )!;

        const b = second.output.find(
          (output): output is Rollup.OutputChunk =>
            output.type === "chunk" && output.isEntry
        )!;

        expect(a.code).toContain("alpha-");
        expect(b.code).toContain("beta-");
        expect(a.code).not.toBe(b.code);
        expect(a.fileName).not.toBe(b.fileName);
      });

      it(`${format}, split=${split}: keeps the entry source map aligned after CSS linking`, async () => {
        const root = await fixture();
        const output = await compile(root, format, split);
        const entry = output.output.find(
          (item): item is Rollup.OutputChunk =>
            item.type === "chunk" && item.isEntry
        )!;

        const index = entry.code.indexOf('"CSS_FINALIZATION_MARKER"');

        expect(index).toBeGreaterThan(0);

        const before = entry.code.slice(0, index).split("\n");
        const position = originalPositionFor(
          new TraceMap(entry.map!.toString()),
          {
            line: before.length,
            column: before.at(-1)!.length
          }
        );

        expect(position.source).toMatch(/entry\.js$/);
        expect(position.line).toBe(2);
        expect(position.column).toBe(22);
      });
    }
  }

  it("connects a lazy library entry to its own split stylesheet", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "entry.js"),
      'export const load = () => import("./lazy.js");'
    );
    await writeFile(
      join(root, "lazy.js"),
      'import "./style.css"; export const lazy = 1;'
    );

    const output = await compile(root, "es", true);
    const lazy = output.output.find(
      (item): item is Rollup.OutputChunk =>
        item.type === "chunk" && item.isDynamicEntry
    )!;

    const css = output.output.find(
      (item) => item.type === "asset" && item.fileName.endsWith(".css")
    )!;

    expect(lazy).toBeDefined();
    expect(css).toBeDefined();
    expect(lazy.code).toContain(css.fileName);
  });
});

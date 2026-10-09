import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build, resolveConfig, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { minchoVitePlugin, type MinchoVitePluginOptions } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(extracted = false) {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "css-consumer-"));
  roots.push(root);

  const files = {
    "library/package.json": JSON.stringify({
      name: "css-consumer-ui",
      type: "module",
      sideEffects: ["**/*.css"]
    }),
    "library/index.js":
      'export { button } from "./button.js"; export { modal } from "./modal.js";',
    "library/shared.js": 'import "./shared.css"; export const base = "shared";',
    "library/shared.css": ".shared { color: red; }",
    "library/pure.css": ".pure { padding: 4px; }",
    "library/button.js": extracted
      ? 'import { css } from "@mincho-js/css"; export const button = css({ borderColor: "blue" });'
      : 'import { base } from "./shared.js"; import "./pure.css"; import "./button.css"; export const button = base + " button pure";',
    "library/modal.js": extracted
      ? 'import { css } from "@mincho-js/css"; export const modal = css({ borderColor: "green" });'
      : 'import { base } from "./shared.js"; import "./pure.css"; import "./modal.css"; export const modal = base + " modal pure";',
    "library/button.css": ".button { color: blue; }",
    "library/modal.css": ".modal { color: green; }"
  };

  for (const [file, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  }

  return root;
}

async function producer(
  root: string,
  format: "es" | "cjs" = "es",
  options?: MinchoVitePluginOptions
) {
  const lib = join(root, "library");
  const result = await build({
    root: lib,
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin({ cache: false, ...options })],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      sourcemap: true,
      lib: {
        entry: Object.fromEntries(
          ["index", "button", "modal"].map((name) => [
            name,
            join(lib, `${name}.js`)
          ])
        ),
        formats: [format]
      },

      // Exercise native removal of a pure CSS shared chunk as well as a shared
      // executable chunk. Neither stylesheet may disappear at finalization.
      rollupOptions: {
        output: {
          manualChunks: (id) => (id.endsWith("/pure.css") ? "pure" : undefined),

          entryFileNames: `[name].${format === "es" ? "mjs" : "cjs"}`,
          chunkFileNames: `chunks/[name]-[hash].${format === "es" ? "mjs" : "cjs"}`,
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      }
    }
  });

  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rollup.RollupOutput;

  for (const item of output.output) {
    const path = join(lib, "dist", item.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.type === "chunk" ? item.code : item.source);
  }

  return output;
}

async function consumer(root: string, entry: string) {
  await writeFile(
    join(root, "app.js"),
    `import { button } from "./library/dist/${entry}"; console.log(button);`
  );

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      cssMinify: false,

      // Fixtures live outside node_modules; published CJS is handled by Vite's
      // native CommonJS plugin, without requiring Mincho in the consumer.
      commonjsOptions: { include: [/\.cjs$/, /node_modules/] },
      rollupOptions: { input: join(root, "app.js") }
    }
  });

  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rollup.RollupOutput;

  return output.output
    .filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String((item as Rollup.OutputAsset).source))
    .join("\n");
}

describe("published library CSS ownership", () => {
  it("defaults only production multi-entry libraries to splitting and honors explicit layout choices", async () => {
    const root = await fixture();
    const cases: {
      options?: MinchoVitePluginOptions;
      cssCodeSplit?: boolean;
      expected: boolean;
    }[] = [
      { expected: true },
      { options: { optimizationMode: "development" }, expected: false },
      { options: { libraryCss: { mode: "entry" } }, expected: false },
      { options: { libraryCss: { fileName: "style.css" } }, expected: false },
      { cssCodeSplit: false, expected: false },
      {
        options: { optimizationMode: "development" },
        cssCodeSplit: true,
        expected: true
      }
    ];

    for (const item of cases) {
      const config = await resolveConfig(
        {
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [minchoVitePlugin({ cache: false, ...item.options })],
          build: {
            ...(item.cssCodeSplit === undefined
              ? {}
              : { cssCodeSplit: item.cssCodeSplit }),
            lib: {
              entry: {
                button: join(root, "library/button.js"),
                modal: join(root, "library/modal.js")
              },
              formats: ["es", "cjs"]
            }
          }
        },
        "build"
      );

      expect(config.build.cssCodeSplit).toBe(item.expected);
    }
  });

  it("keeps ESM named imports as small as subpaths, including shared CSS-only chunks", async () => {
    const root = await fixture();
    const output = await producer(root);
    const barrel = output.output.find(
      (item) => item.fileName === "index.mjs"
    ) as Rollup.OutputChunk;

    expect(barrel.code).not.toMatch(/import ["'][^"']+\.css/);

    const named = await consumer(root, "index.mjs");

    expect(named).toEqual(await consumer(root, "button.mjs"));
    expect(named).toContain(".button");
    expect(named).toContain(".pure");
    expect(named).toContain(".shared");
    expect(named).not.toContain(".modal");
    expect(named.indexOf(".shared")).toBeLessThan(named.indexOf(".button"));
    expect(named.match(/\.shared\s*\{/g)).toHaveLength(1);
  });

  it("retains CJS subpath styles and dependency order", async () => {
    const root = await fixture();
    await producer(root, "cjs");

    const css = await consumer(root, "button.cjs");

    expect(css).toContain(".pure");
    expect(css).toContain(".button");
    expect(css).not.toContain(".modal");
    expect(css.indexOf(".shared")).toBeLessThan(css.indexOf(".button"));
  });

  it("assigns extracted Mincho CSS to its component instead of the barrel", async () => {
    const root = await fixture(true);
    await producer(root);

    const css = await consumer(root, "index.mjs");

    expect(css).toContain("border-color: blue");
    expect(css).not.toContain("border-color: green");
    expect(css).toEqual(await consumer(root, "button.mjs"));
  });

  it("preserves explicitly selected entry aggregation", async () => {
    const root = await fixture();

    // Entry mode preserves Vite's unsplit default, with the fixed asset contract.
    const lib = join(root, "library");
    const result = await build({
      root: lib,
      configFile: false,
      logLevel: "silent",
      plugins: [
        minchoVitePlugin({
          cache: false,
          libraryCss: { mode: "entry", fileName: "style.css" }
        })
      ],
      build: {
        write: false,
        lib: {
          entry: {
            index: join(lib, "index.js"),
            button: join(lib, "button.js")
          },
          formats: ["es"],
          cssFileName: "style"
        }
      }
    });

    const output = (
      Array.isArray(result) ? result[0] : result
    ) as Rollup.RollupOutput;

    expect(
      output.output
        .filter((item) => item.fileName.endsWith(".css"))
        .map((item) => item.fileName)
    ).toEqual(["style.css"]);

    for (const item of output.output)
      if (item.type === "chunk" && item.isEntry)
        expect(item.code).toContain('import "./style.css"');
  });
});

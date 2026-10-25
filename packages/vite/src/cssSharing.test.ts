import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import * as vite from "vite";
import { build, type Plugin, type Rollup, type ResolvedConfig } from "vite";
import { minchoVitePlugins, type MinchoVitePluginOptions } from "./index.js";
import { createCssSharing } from "./cssSharing.js";

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();
  return {
    ...actual,
    normalizePath: vi.fn(actual.normalizePath),
    transformWithEsbuild: vi.fn(actual.transformWithEsbuild)
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, resolve: vi.fn(actual.resolve) };
});

const roots: string[] = [];

async function fixture(shared = ".shared { color: red; }") {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "css-sharing-"));
  roots.push(root);

  for (const [name, contents] of Object.entries({
    "a.html": '<script type="module" src="/a.js"></script>',
    "b.html": '<script type="module" src="/b.js"></script>',
    "a.js": 'import "./shared.css"; import "./a.css"; console.log("a");',
    "b.js": 'import "./shared.css"; import "./b.css"; console.log("b");',
    "shared.css": shared,
    "a.css": ".shared { color: blue; }",
    "b.css": ".shared { color: green; }"
  }))
    await writeFile(join(root, name), contents);

  return root;
}

afterEach(async () => {
  vi.mocked(resolve).mockReset();
  vi.mocked(vite.normalizePath).mockReset();
  vi.mocked(vite.transformWithEsbuild).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function costBuild(root: string, options: MinchoVitePluginOptions) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: minchoVitePlugins(options),
    build: {
      write: false,
      minify: true,
      rollupOptions: {
        input: { a: join(root, "a.html"), b: join(root, "b.html") }
      }
    }
  });
  return (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
}

it("checks compressed cold costs before emitting shared chunks", async () => {
  const root = await fixture(".shared { color: red; }".repeat(200));
  for (const cost of [undefined, { maxInitialIncreaseBytes: 0 }]) {
    const output = await costBuild(root, {
      appCss: { sharing: { minBytes: 0, cost } }
    });
    expect(
      output.output.some((item) => item.fileName.includes("mincho-shared"))
    ).toBe(!cost);
  }
});

it.each([
  "direct",
  "wrapped",
  "other-entry-first",
  "alias",
  "eager",
  "unreachable",
  "windows"
])("resolves compressed cost scenario routes (%s)", async (mode) => {
  const root = mode === "windows" ? "C:/project" : "/project";
  if (mode === "windows") {
    vi.mocked(resolve).mockImplementation(win32.resolve);
    vi.mocked(vite.normalizePath).mockImplementation((id) =>
      id.replace(/\\/g, "/")
    );
  }
  const id = (file: string) => `${root}/${file}`;
  const reports: unknown[] = [];
  const routeEntry = mode === "alias" ? "a" : "a.js";
  const sharing = createCssSharing(
    {
      minBytes: 0,
      cost: { scenarios: [{ entry: "index.html", routes: ["a", "b"] }] }
    },
    (detail) => reports.push(detail),
    [
      { id: "a", entry: routeEntry },
      { id: "b", entry: "b.js" }
    ],
    { metric: "raw" }
  );
  sharing.configure({
    command: "build",
    root,
    css: {},
    plugins: [],
    build: { cssCodeSplit: true, cssMinify: false, rollupOptions: {} }
  } as unknown as ResolvedConfig);
  sharing.begin();
  sharing.record(
    id("shared.css"),
    ".shared { color: red; }".repeat(200),
    false
  );
  const graph = new Map<string, Rollup.ModuleInfo>();
  const add = (
    file: string,
    imported: string[] = [],
    dynamic: string[] = [],
    entry = false
  ) => {
    graph.set(id(file), {
      id: id(file),
      isEntry: entry,
      isExternal: false,
      isIncluded: true,
      importedIds: imported.map(id),
      dynamicallyImportedIds: dynamic.map(id),
      dynamicImporters: []
    } as unknown as Rollup.ModuleInfo);
  };
  if (mode === "other-entry-first") {
    add("other.html", [], ["other-shell.js"], true);
    add("other-shell.js", ["a.js"]);
  }
  const direct = mode === "direct" || mode === "windows";
  add(
    "index.html",
    mode === "eager" ? ["a.js"] : [],
    mode === "unreachable" || mode === "eager"
      ? ["b-shell.js"]
      : direct
        ? ["a.js", "b.js"]
        : ["a-shell.js", "b-shell.js"],
    true
  );
  if (mode === "unreachable") add("other.html", [], ["a-shell.js"], true);
  add("a-shell.js", ["a.js"]);
  add("b-shell.js", ["b.js"]);
  add("a.js", ["shared.css"]);
  add("b.js", ["shared.css"]);
  add("shared.css");
  for (const info of graph.values())
    for (const target of info.dynamicallyImportedIds) {
      const dependency = graph.get(target)!;
      graph.set(target, {
        ...dependency,
        dynamicImporters: [...dependency.dynamicImporters, info.id]
      });
    }
  const result = sharing.plan({
    getModuleIds: () => graph.keys(),
    getModuleInfo: (moduleId) => graph.get(moduleId) ?? null,
    getWatchFiles: () => [],
    warn: () => {},
    resolve: async (source) =>
      source === id("a")
        ? ({ id: id("a.js"), external: false } as Rollup.ResolvedId)
        : null
  });
  if (mode === "unreachable")
    await expect(result).rejects.toThrow("Unreachable CSS cost route: a");
  else {
    await expect(result).resolves.toBeUndefined();
    expect(reports).toContainEqual(
      expect.objectContaining({ phase: "compressed-cost", metric: "raw" })
    );
  }
});

it("builds compressed cost scenarios for routes inside dynamic shells", async () => {
  const root = await fixture(".shared { color: red; }".repeat(200));
  for (const [file, source] of Object.entries({
    "a.html": '<script type="module" src="/main.js"></script>',
    "main.js":
      'globalThis.a=()=>import("./a-shell.js");globalThis.b=()=>import("./b-shell.js");',
    "a-shell.js": 'export { route } from "./a.js";',
    "b-shell.js": 'export { route } from "./b.js";',
    "a.js": 'import "./shared.css"; import "./a.css"; export const route="a";',
    "b.js": 'import "./shared.css"; import "./b.css"; export const route="b";'
  }))
    await writeFile(join(root, file), source);
  const result = await costBuild(root, {
    bundleSize: { metric: "raw" },
    diagnostics: { json: "costs.json" },
    appCss: {
      routes: [
        { id: "a", entry: "a.js" },
        { id: "b", entry: "b.js" }
      ],
      sharing: {
        minBytes: 0,
        cost: { scenarios: [{ entry: "a.html", routes: ["a", "b"] }] }
      }
    }
  });
  expect(
    result.output.some(
      (item) => item.type === "asset" && item.fileName.endsWith(".css")
    )
  ).toBe(true);
  const report = JSON.parse(await readFile(join(root, "costs.json"), "utf8"));
  expect(
    report.builds.flatMap((value: { events: unknown[] }) => value.events)
  ).toContainEqual(
    expect.objectContaining({
      phase: "css-sharing",
      detail: expect.objectContaining({
        phase: "compressed-cost",
        metric: "raw",
        estimate: true
      })
    })
  );
});

it.each([undefined, "raw"] as const)(
  "resolves CSS sharing metrics with Babel fallback and root precedence (%s)",
  async (metric) => {
    const root = await fixture(".shared { color: red; }".repeat(200));
    await costBuild(root, {
      babel: { bundleSize: { metric: "gzip" } },
      bundleSize: metric && { metric },
      diagnostics: { json: "costs.json" },
      appCss: { sharing: { minBytes: 0, cost: { maxInitialIncreaseBytes: 0 } } }
    });
    const report = JSON.parse(await readFile(join(root, "costs.json"), "utf8"));
    const decisions = report.builds
      .flatMap(
        (b: {
          events: {
            phase: string;
            detail?: { phase?: string; metric?: string };
          }[];
        }) => b.events
      )
      .filter(
        (event: { phase: string; detail?: { phase?: string } }) =>
          event.phase === "css-sharing" &&
          event.detail?.phase === "compressed-cost"
      );
    expect(decisions.length).toBeGreaterThan(0);
    for (const event of decisions)
      expect(event.detail.metric).toBe(metric ?? "gzip");
  }
);

it.each([false, true])(
  "measures only live CSS and tolerates unavailable cost transforms (failure: %s)",
  async (failure) => {
    const reports: unknown[] = [];
    const sharing = createCssSharing(
      { minBytes: 0, cost: { maxInitialIncreaseBytes: 0 } },
      (detail) => reports.push(detail)
    );
    sharing.configure({
      command: "build",
      root: process.cwd(),
      css: {},
      plugins: [],
      build: { cssCodeSplit: true, cssMinify: true, rollupOptions: {} }
    } as unknown as ResolvedConfig);
    sharing.begin();
    sharing.record("/shared.css", ".shared{color:red}", false);
    sharing.record("/removed.scss", ".removed{color:blue}", false);
    const transform = vi.mocked(vite.transformWithEsbuild);
    if (failure)
      transform.mockRejectedValueOnce(new Error("measurement unavailable"));
    const ids = ["/a.js", "/b.js", "/shared.css"];
    await expect(
      sharing.plan({
        getModuleIds: () => ids.values(),
        getModuleInfo: (id) =>
          ({
            id,
            isEntry: id.endsWith(".js"),
            isExternal: false,
            importedIds: id.endsWith(".js") ? ["/shared.css"] : [],
            dynamicallyImportedIds: [],
            dynamicImporters: []
          }) as unknown as Rollup.ModuleInfo,
        getWatchFiles: () => [],
        warn: () => {},
        resolve: async () => null
      })
    ).resolves.toBeUndefined();
    expect(transform.mock.calls.map((call) => call[1])).toEqual([
      "/shared.css.css"
    ]);
    expect(reports).toContainEqual(
      expect.objectContaining(
        failure
          ? {
              applied: false,
              phase: "compressed-cost",
              reason: "css-cost-measurement-failed"
            }
          : { applied: false, phase: "compressed-cost", metric: "brotli" }
      )
    );
    expect(sharing.outputOptions({ format: "es" })).toBeNull();
  }
);

async function compile(
  root: string,
  customChunks = false,
  plugins: Plugin[] = []
) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      ...plugins,
      ...minchoVitePlugins({
        cache: false,
        experimental: { cssChunkSharing: { minBytes: 0 } }
      })
    ],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      assetsInlineLimit: 0,
      sourcemap: true,
      manifest: true,
      rollupOptions: {
        input: { a: join(root, "a.html"), b: join(root, "b.html") },
        output: customChunks
          ? { manualChunks: { custom: [join(root, "shared.css")] } }
          : undefined
      }
    }
  });

  return (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
}

describe("Vite native CSS sharing", () => {
  it("keeps shared CSS filenames stable across checkout roots", async () => {
    const sharedFiles: string[] = [];

    for (const root of [await fixture(), await fixture()]) {
      const result = await compile(root);
      const shared = result.output.find(
        (item) =>
          item.type === "asset" &&
          item.fileName.includes("mincho-shared-") &&
          item.fileName.endsWith(".css")
      );

      expect(shared).toBeDefined();
      sharedFiles.push(shared!.fileName);
    }

    expect(sharedFiles[0]).toBe(sharedFiles[1]);
  });

  it("accepts proven script-only filters but rejects opaque vite-prefixed transforms", async () => {
    const root = await fixture();

    for (const filtered of [false, true]) {
      const result = await compile(root, false, [
        {
          name: "vite:custom-transform",
          transform: filtered
            ? { filter: { id: /\.[jt]sx?$/ }, handler: () => null }
            : () => null
        }
      ]);

      expect(
        result.output.some((item) => item.fileName.includes("mincho-shared-"))
      ).toBe(filtered);
    }
  });

  it("keeps native HTML and manifest CSS order shared then private", async () => {
    const root = await fixture();
    const result = await compile(root);
    const shared = result.output.find(
      (item) =>
        item.type === "asset" &&
        item.fileName.includes("mincho-shared-") &&
        item.fileName.endsWith(".css")
    );

    expect(shared).toBeDefined();

    const manifestAsset = result.output.find(
      (item) => item.type === "asset" && item.fileName.endsWith("manifest.json")
    ) as Rollup.OutputAsset;

    const manifest = JSON.parse(String(manifestAsset.source));

    for (const name of ["a", "b"]) {
      const entry = manifest[`${name}.html`];

      expect(entry.css[0]).toBe(shared!.fileName);
      expect(entry.css).toHaveLength(2);

      const html = result.output.find(
        (item) => item.type === "asset" && item.fileName === `${name}.html`
      ) as Rollup.OutputAsset;

      expect(String(html.source).indexOf(entry.css[0])).toBeLessThan(
        String(html.source).indexOf(entry.css[1])
      );
      expect(
        result.output.some((item) => item.fileName === `${entry.file}.map`)
      ).toBe(true);
    }

    expect(
      result.output
        .filter((item) => item.type === "chunk")
        .some((chunk) => chunk.fileName.includes("mincho-shared-"))
    ).toBe(false);
  });

  it("uses native content hashes when shared CSS changes", async () => {
    const root = await fixture();
    const first = await compile(root);
    await writeFile(join(root, "shared.css"), ".shared { color: purple; }");

    const second = await compile(root);

    const name = (result: Rollup.RollupOutput) =>
      result.output.find(
        (item) =>
          item.type === "asset" &&
          item.fileName.includes("mincho-shared-") &&
          item.fileName.endsWith(".css")
      )!.fileName;

    expect(name(first)).not.toBe(name(second));
  });

  it("keeps native URL asset references in the shared stylesheet", async () => {
    const root = await fixture(
      '.shared { background-image: url("./image.svg"); }'
    );

    await writeFile(
      join(root, "image.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    );

    const result = await compile(root);
    const shared = result.output.find(
      (item) =>
        item.type === "asset" &&
        item.fileName.includes("mincho-shared-") &&
        item.fileName.endsWith(".css")
    ) as Rollup.OutputAsset;

    const image = result.output.find((item) => item.fileName.endsWith(".svg"))!;

    expect(shared).toBeDefined();
    expect(image).toBeDefined();
    expect(String(shared.source)).toContain(`/${image.fileName}`);
  });

  it("shares extracted Mincho CSS using native chunks", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "shared.ts"),
      'import { css } from "@mincho-js/css"; export const shared = css({ color: "red" });'
    );

    for (const name of ["a", "b"])
      await writeFile(
        join(root, `${name}.js`),
        `import { shared } from "./shared.ts"; import "./${name}.css"; console.log(shared);`
      );

    const result = await compile(root);
    const shared = result.output.find(
      (item) =>
        item.type === "asset" &&
        item.fileName.includes("mincho-shared-") &&
        item.fileName.endsWith(".css")
    ) as Rollup.OutputAsset;

    expect(shared).toBeDefined();
    expect(String(shared.source)).toContain("color: red");
  });

  it("keeps shared CSS ahead of private CSS for lazy native boundaries", async () => {
    const root = await fixture();

    for (const name of ["a", "b"]) {
      await writeFile(
        join(root, `${name}.js`),
        `export const load = () => import("./${name}-lazy.js"); console.log(load);`
      );
      await writeFile(
        join(root, `${name}-lazy.js`),
        `import "./shared.css"; import "./${name}.css"; export const loaded = ${JSON.stringify(name)};`
      );
    }

    const result = await compile(root);
    const manifestAsset = result.output.find(
      (item) => item.type === "asset" && item.fileName.endsWith("manifest.json")
    ) as Rollup.OutputAsset;

    const manifest = JSON.parse(String(manifestAsset.source));

    for (const name of ["a", "b"]) {
      const lazy = manifest[`${name}-lazy.js`];

      expect(lazy.css).toHaveLength(2);
      expect(lazy.css[0]).toContain("mincho-shared-");
      expect(manifest[`${name}.html`].css).toBeUndefined();

      const html = result.output.find(
        (item) => item.type === "asset" && item.fileName === `${name}.html`
      ) as Rollup.OutputAsset;

      expect(String(html.source)).not.toContain(lazy.css[0]);
    }
  });

  it("preserves custom manualChunks and global-prefix fallback", async () => {
    for (const custom of [false, true]) {
      const root = await fixture(
        custom ? ".shared { color: red; }" : "body { color: red; }"
      );

      const result = await compile(root, custom);

      expect(
        result.output.some((item) => item.fileName.includes("mincho-shared-"))
      ).toBe(false);
    }
  });
});

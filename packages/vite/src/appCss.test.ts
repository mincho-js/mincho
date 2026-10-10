import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  minchoVitePlugin,
  type MinchoAppCssOptions,
  type MinchoVitePluginOptions
} from "./index.js";
import { appCssConfig } from "./appCss.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "app-css-"));
  roots.push(root);

  const files: Record<string, string> = {
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js":
      'import "./home.css"; globalThis.loaders = { a: () => import("./a-shell.js"), b: () => import("./b-shell.js") };',
    "home.css": ".home { color: black; }",
    "root-layout.js": 'import "./root.css"; export const root = "root";',
    "root.css": ".root { color: red; }",
    "layout.js": 'import "./layout.css"; export const layout = "layout";',
    "layout.css": ".layout { padding: 8px; }"
  };

  for (const name of ["a", "b"]) {
    files[`${name}-shell.js`] =
      `import { root } from "./root-layout.js"; import { layout } from "./layout.js"; import { page } from "./${name}.js"; export const rendered = root + layout + page;`;
    files[`${name}.js`] =
      `import "./${name}.css"; export const page = "${name}";`;
    files[`${name}.css`] =
      `.${name} { color: ${name === "a" ? "blue" : "green"}; }`;
  }

  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(join(root, name), content)
    )
  );

  return root;
}

function routes(): NonNullable<MinchoAppCssOptions["routes"]> {
  return ["a", "b"].map((id) => ({
    id,
    entry: `${id}.js`,
    layouts: ["root-layout.js", "layout.js"]
  }));
}

async function compile(
  root: string,
  appCss: MinchoAppCssOptions,
  options?: Omit<MinchoVitePluginOptions, "appCss">
) {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin({ cache: false, ...options, appCss })],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      manifest: true,
      sourcemap: true
    }
  });

  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rollup.RollupOutput;

  const manifestAsset = output.output.find(
    (item): item is Rollup.OutputAsset =>
      item.type === "asset" && item.fileName.endsWith("manifest.json")
  )!;

  const manifest = JSON.parse(String(manifestAsset.source)) as Record<
    string,
    { imports?: string[]; css?: string[] }
  >;

  const files = new Map(
    output.output.map((item) => [
      item.fileName,
      item.type === "chunk" ? item.code : String(item.source)
    ])
  );

  const cssFiles = (entry: string): string[] => {
    const seen = new Set<string>();
    const css = new Set<string>();

    const visit = (id: string) => {
      if (seen.has(id)) return;

      seen.add(id);

      const item = manifest[id];

      for (const imported of item?.imports ?? []) visit(imported);

      for (const stylesheet of item?.css ?? []) css.add(stylesheet);
    };

    visit(entry);

    return [...css];
  };

  return {
    files,
    cssFiles,

    css: (entry: string) =>
      cssFiles(entry)
        .map((id) => files.get(id))
        .join("\n"),

    shared: [...files.keys()].filter(
      (id) => id.includes("mincho-shared-") && id.endsWith(".css")
    )
  };
}

describe("application CSS distribution", () => {
  it("emits one sheet for single and keeps route CSS lazy for dist-chunk", async () => {
    const root = await fixture();
    const single = await compile(root, { mode: "single" });
    const singleCss = [...single.files.entries()].filter(([id]) =>
      id.endsWith(".css")
    );

    expect(singleCss).toHaveLength(1);
    expect(singleCss[0]![1]).toContain(".a {");
    expect(singleCss[0]![1]).toContain(".b {");
    expect(single.files.get("index.html")).toContain(singleCss[0]![0]);

    const chunks = await compile(root, { mode: "dist-chunk" });

    expect(chunks.css("index.html")).toContain(".home {");
    expect(chunks.css("index.html")).not.toContain(".root {");
    expect(chunks.css("index.html")).not.toContain(".a {");
    expect(chunks.css("index.html")).not.toContain(".b {");
    expect(chunks.css("a-shell.js")).toContain(".a {");
    expect(chunks.css("a-shell.js")).not.toContain(".b {");
    expect(chunks.css("b-shell.js")).toContain(".b {");
    expect(chunks.css("b-shell.js")).not.toContain(".a {");
  });

  it("preserves native config and rejects contradictory distribution options", () => {
    const env = { command: "build", mode: "production" } as const;

    expect(
      appCssConfig({ mode: "native" }, { build: { cssCodeSplit: false } }, env)
    ).toBeUndefined();
    expect(() =>
      appCssConfig(
        { mode: "dist-chunk" },
        { build: { cssCodeSplit: false } },
        env
      )
    ).toThrow("conflicts");
    expect(() =>
      appCssConfig({ mode: "single" }, { build: { cssCodeSplit: true } }, env)
    ).toThrow("conflicts");
    expect(
      appCssConfig(
        { mode: "dist-chunk" },
        { build: { lib: { entry: "index.js" } } },
        env
      )
    ).toBeUndefined();
    expect(
      appCssConfig({ mode: "single" }, { build: { ssr: true } }, env)
    ).toBeUndefined();
    expect(
      appCssConfig(
        { mode: "single" },
        {},
        { command: "serve", mode: "development" }
      )
    ).toBeUndefined();
  });

  it("shares ancestor layouts by distinct route reach without loading them initially", async () => {
    const root = await fixture();
    const result = await compile(root, {
      mode: "dist-chunk",
      sharing: { minBytes: 0 },
      routes: routes()
    });

    expect(result.shared).toHaveLength(1);

    const shared = result.files.get(result.shared[0]!)!;

    expect(shared).toContain(".root {");
    expect(shared).toContain(".layout {");
    expect(shared).not.toContain(".a {");
    expect(shared).not.toContain(".b {");
    expect(shared.indexOf(".root {")).toBeLessThan(shared.indexOf(".layout {"));

    for (const route of ["a", "b"]) {
      const css = result.cssFiles(`${route}-shell.js`);

      expect(css[0]).toBe(result.shared[0]);
      expect(result.css(`${route}-shell.js`)).toContain(`.${route} {`);
    }

    expect(result.cssFiles("index.html")).not.toContain(result.shared[0]);
    expect(result.files.get("index.html")).not.toContain(result.shared[0]);
  });

  it("counts route aliases once each instead of counting generated chunks", async () => {
    const root = await fixture();
    const options = {
      mode: "dist-chunk",
      sharing: { minBoundaries: 3, minBytes: 0 }
    } as const;

    expect(
      (await compile(root, { ...options, routes: routes() })).shared
    ).toHaveLength(0);

    const result = await compile(root, {
      ...options,
      routes: [...routes(), { ...routes()[0]!, id: "a-alias" }]
    });

    expect(result.shared).toHaveLength(1);
  });

  it("does not count optional lazy widgets as additional routes", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "main.js"),
      'import "./home.css"; globalThis.loadRoute = () => import("./route.js");'
    );
    await writeFile(
      join(root, "route.js"),
      'export const widgets = { a: () => import("./a-shell.js"), b: () => import("./b-shell.js") };'
    );

    const sharing = { minBytes: 0 };

    expect((await compile(root, { sharing })).shared).toHaveLength(1);

    const result = await compile(root, {
      sharing,
      routes: [{ id: "route", entry: "route.js" }]
    });

    expect(result.shared).toHaveLength(0);
    expect(result.css("index.html")).not.toContain(".root {");
    expect(result.css("route.js")).not.toContain(".root {");
    expect(result.css("a-shell.js")).toContain(".root {");
  });

  it("retains ordering constraints from consumers absent in the route list", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "main.js"),
      'import "./home.css"; globalThis.loaders = { a: () => import("./a-shell.js"), b: () => import("./b-shell.js"), extra: () => import("./extra.js") };'
    );
    await writeFile(
      join(root, "extra.js"),
      'import "./b.css"; import "./root.css"; export const extra = true;'
    );

    const result = await compile(root, {
      sharing: { minBytes: 0 },
      routes: routes()
    });

    expect(result.shared).toHaveLength(0);
    expect(result.css("extra.js")).toContain(".root {");
    expect(result.css("a-shell.js")).toContain(".root {");
  });

  it("falls back for missing routes and honors explicit sharing opt-out", async () => {
    const root = await fixture();
    const result = await compile(root, {
      sharing: { minBytes: 0 },
      routes: [...routes(), { id: "missing", entry: "missing.js" }]
    });

    expect(result.shared).toHaveLength(0);
    expect(result.css("a-shell.js")).toContain(".root {");
    expect(result.css("b-shell.js")).toContain(".b {");

    const disabled = await compile(
      root,
      { sharing: false, routes: routes() },
      {
        experimental: { cssChunkSharing: { minBytes: 0 } }
      }
    );

    expect(disabled.shared).toHaveLength(0);
  });

  it("tracks extracted Mincho CSS through route layout dependencies", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "root-layout.js"),
      'import { css } from "@mincho-js/css"; export const root = css({ color: "purple" });'
    );

    const result = await compile(root, {
      mode: "dist-chunk",
      sharing: { minBytes: 0 },
      routes: routes()
    });

    expect(result.shared).toHaveLength(1);
    expect(result.files.get(result.shared[0]!)).toContain("color: purple");
    expect(result.css("index.html")).not.toContain("color: purple");
  });

  it("rejects duplicate route identities instead of inflating sharing counts", () => {
    expect(() =>
      minchoVitePlugin({ appCss: { routes: [routes()[0]!, routes()[0]!] } })
    ).toThrow("unique route ids");
  });
});

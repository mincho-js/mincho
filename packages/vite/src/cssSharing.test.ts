import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin, type Rollup } from "vite";
import { minchoVitePlugins } from "./index.js";

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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

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

import { promises as fs } from "node:fs";
import { parse } from "@babel/parser";
import { dirname, join, relative, resolve } from "node:path";
import {
  build,
  context,
  type BuildOptions,
  type BuildResult,
  type Plugin
} from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { minchoEsbuildPlugins } from "./index.js";
import { EsbuildAssets } from "./assets.js";

const roots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const cache = resolve(".cache");
  await fs.mkdir(cache, { recursive: true });

  const root = await fs.mkdtemp(join(cache, "esbuild-contract-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, source]) => {
      await fs.mkdir(dirname(join(root, path)), { recursive: true });
      await fs.writeFile(join(root, path), source);
    })
  );

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

function buildOptions(root: string, options: BuildOptions = {}): BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: [join(root, "entry.tsx")],
    outdir: join(root, "out"),
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    logLevel: "silent",
    external: ["@mincho-js/css"],
    plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
    ...options
  };
}

function outputText(result: BuildResult, extension: string): string {
  return (
    result.outputFiles
      ?.filter((file) => file.path.endsWith(extension))
      .map((file) => file.text)
      .join("\n") ?? ""
  );
}

function cssVariable(result: BuildResult, name: string): string {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(
    outputText(result, ".css")
  )?.[1];
  if (!value) throw new Error(`Missing CSS variable ${name}`);

  return value;
}

function observeBuilds() {
  const pending: Array<(result: BuildResult) => void> = [];
  const plugin: Plugin = {
    name: "observe-builds",

    setup(build) {
      build.onEnd((result) => {
        pending.shift()?.(result);
      });
    }
  };

  return {
    plugin,

    next(): Promise<BuildResult> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Watch rebuild did not run")),
          10000
        );

        pending.push((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }
  };
}

describe("esbuild build contracts", () => {
  it("respects native and configured script loaders", async () => {
    const root = await fixture({
      "entry.jsx": "export const App = () => <div />;",
      "entry.js": "export const App = () => <div />;",
      "entry.component": "export const App = () => <div />;",
      "entry.tsx": "plain text that is not JavaScript"
    });

    for (const [extension, loader] of [
      ["jsx", undefined],
      ["js", "jsx"],
      ["component", "tsx"]
    ] as const) {
      const result = await build(
        buildOptions(root, {
          entryPoints: [join(root, `entry.${extension}`)],
          plugins: minchoEsbuildPlugins(),
          jsxFactory: "h",
          loader: loader ? { [`.${extension}`]: loader } : undefined
        })
      );

      expect(outputText(result, ".js")).toContain('h("div"');
    }

    const text = await build(
      buildOptions(root, { loader: { ".tsx": "text" } })
    );

    expect(outputText(text, ".js")).toContain(
      "plain text that is not JavaScript"
    );
  });

  it("leaves a later plugin's virtual JavaScript module to its namespace", async () => {
    const root = await fixture({
      "entry.tsx": 'export { value } from "virtual:module.js";'
    });

    const result = await build(
      buildOptions(root, {
        plugins: [
          ...minchoEsbuildPlugins(),
          {
            name: "virtual-provider",

            setup(build) {
              build.onResolve({ filter: /^virtual:/ }, (args) => ({
                path: args.path,
                namespace: "virtual-provider"
              }));
              build.onLoad(
                { filter: /.*/, namespace: "virtual-provider" },
                () => ({ contents: "export const value = 42;", loader: "js" })
              );
            }
          }
        ]
      })
    );

    expect(outputText(result, ".js")).toContain("42");
  });

  it.each(["jsx", "tsx"] as const)(
    "passes a .js %s loader to ordinary css() dependencies",
    async (loader) => {
      const root = await fixture({
        "entry.tsx":
          'import { css } from "@mincho-js/css"; import { color } from "./tokens.js"; export const className = css({ color });',
        "tokens.js": `export const color${loader === "tsx" ? ": string" : ""} = "red"; export const App = () => <div />;`
      });

      const result = await build(
        buildOptions(root, {
          plugins: minchoEsbuildPlugins(),
          loader: { ".js": loader }
        })
      );

      expect(outputText(result, ".css")).toContain("color: red");
    }
  );

  it("automatically rebuilds ordinary css() when a compile-only dependency changes", async () => {
    const root = await fixture({
      "entry.tsx":
        'import { css } from "@mincho-js/css"; import { color } from "./tokens"; export const className = css({ color });',
      "tokens.ts": 'export const color = "red";'
    });

    const observed = observeBuilds();
    const buildContext = await context(
      buildOptions(root, {
        plugins: [...minchoEsbuildPlugins(), observed.plugin]
      })
    );

    try {
      const first = observed.next();
      await buildContext.watch();

      expect(outputText(await first, ".css")).toContain("color: red");

      const next = observed.next();
      await fs.writeFile(
        join(root, "tokens.ts"),
        'export const color = "blue";'
      );

      expect(outputText(await next, ".css")).toContain("color: blue");
    } finally {
      await buildContext.dispose();
    }
  }, 20000);
});

describe("native esbuild assets", () => {
  it("diagnoses output-dependent file strings and accepts publicPath or dataurl", async () => {
    const source =
      'import image from "./icon.png?url"; export const App = () => <div css={{vars:{"--asset-url":image}}} />;';

    const root = await fixture({
      "entry.tsx": source,
      "other.tsx": source,
      "icon.png": "asset-bytes"
    });

    const options = buildOptions(root, {
      entryPoints: { one: "./entry.tsx", "nested/deeper/two": "./other.tsx" },
      loader: { ".png": "file" }
    });

    await expect(build(options)).rejects.toThrow(
      "Set esbuild publicPath or use a dataurl loader"
    );

    const withPublicPath = await build({
      ...options,
      publicPath: "/static",
      plugins: minchoEsbuildPlugins({ jsxCssProp: true })
    });

    expect(cssVariable(withPublicPath, "--asset-url")).toMatch(/^\/static\//);
    expect(
      withPublicPath.outputFiles?.filter((file) => file.path.endsWith(".png"))
    ).toHaveLength(1);

    const withDataUrl = await build({
      ...options,
      loader: { ".png": "dataurl" },
      plugins: minchoEsbuildPlugins({ jsxCssProp: true })
    });

    expect(outputText(withDataUrl, ".css")).toContain("data:image/png");
    expect(
      withDataUrl.outputFiles?.some((file) => file.path.endsWith(".png"))
    ).toBe(false);
  });

  it("allows splitting in one output folder and diagnoses a different chunk folder", async () => {
    const root = await fixture({
      "entry.tsx": 'export const load = () => import("./lazy");',
      "lazy.tsx":
        'import image from "./icon.png?url"; export { image }; export const App = () => <div css={{vars:{"--asset-url":image}}} />;',
      "icon.png": "asset-bytes"
    });

    const options = buildOptions(root, {
      splitting: true,
      loader: { ".png": "file" }
    });

    const sameFolder = await build(options);

    expect(outputText(sameFolder, ".js")).toContain(
      JSON.stringify(cssVariable(sameFolder, "--asset-url"))
    );
    await expect(
      build({
        ...options,
        chunkNames: "chunks/deep/[name]-[hash]",
        plugins: minchoEsbuildPlugins({ jsxCssProp: true })
      })
    ).rejects.toThrow("Set esbuild publicPath or use a dataurl loader");

    const withPublicPath = await build({
      ...options,
      publicPath: "/static",
      chunkNames: "chunks/deep/[name]-[hash]",
      plugins: minchoEsbuildPlugins({ jsxCssProp: true })
    });

    expect(outputText(withPublicPath, ".js")).toContain(
      JSON.stringify(cssVariable(withPublicPath, "--asset-url"))
    );
  });

  it("matches native asset values for a single nested JS output directory", async () => {
    const root = await fixture({
      "entry.tsx":
        'import image from "./icon.png?url"; export { image }; export const App = () => <div css={{vars:{"--asset-url":image}}} />;',
      "icon.png": "asset-bytes"
    });

    const result = await build(
      buildOptions(root, {
        loader: { ".png": "file" },
        entryNames: "nested/deeper/[name]",
        assetNames: "assets/[name]-[hash]"
      })
    );

    const value = cssVariable(result, "--asset-url");

    expect(value).toMatch(/^\.\.\/\.\.\/assets\//);
    expect(outputText(result, ".js")).toContain(JSON.stringify(value));
  });

  it("uses native entry glob expansion when determining default outbase", async () => {
    const source =
      'import image from "../../shared/icon.png?url"; export { image }; export const App = () => <div css={{vars:{"--asset-url":image}}} />;';

    const root = await fixture({
      "src/pages/a/entry.tsx": source,
      "src/pages/b/entry.tsx": source,
      "src/shared/icon.png": "asset-bytes"
    });

    const result = await build(
      buildOptions(root, {
        entryPoints: ["./src/pages/**/*.tsx"],
        loader: { ".png": "file" },
        assetNames: "assets/[dir]/[name]-[hash]",
        publicPath: "/static"
      })
    );

    expect(
      result.outputFiles?.filter((file) => file.path.endsWith(".js"))
    ).toHaveLength(2);
    expect(
      result.outputFiles?.filter((file) => file.path.endsWith(".png"))
    ).toHaveLength(1);
    expect(outputText(result, ".js")).toContain(
      JSON.stringify(cssVariable(result, "--asset-url"))
    );
  });

  it.each(["file", "dataurl"] as const)(
    "supports %s assets, raw strings and CSS url tokens in ordinary css()",
    async (loader) => {
      const root = await fixture({
        "entry.tsx":
          'import { css } from "@mincho-js/css"; import image from "./icon.png?url"; import raw from "./icon.png?raw"; export const className = css({ vars: { "--raw": raw, "--asset-url": image }, backgroundImage: `url("${image}")` });',
        "icon.png": "asset-bytes"
      });

      const result = await build(
        buildOptions(root, {
          loader: { ".png": loader },
          entryNames: "nested/[name]",
          plugins: minchoEsbuildPlugins()
        })
      );

      expect(cssVariable(result, "--raw")).toBe("asset-bytes");

      if (loader === "file") {
        const asset = result.outputFiles?.find((file) =>
          file.path.endsWith(".png")
        );

        expect(asset?.text).toBe("asset-bytes");
        expect(outputText(result, ".css")).toContain(
          `../${asset!.path.split("/").at(-1)}?url`
        );
        expect(
          result.outputFiles?.filter((file) => file.path.endsWith(".png"))
        ).toHaveLength(1);
      } else {
        expect(outputText(result, ".css")).toContain("data:image/png");
        expect(
          result.outputFiles?.some((file) => file.path.endsWith(".png"))
        ).toBe(false);
      }
    }
  );

  it.each(["?url&v=1#fragment", "?url#fragment"])(
    "keeps raw/query identity %s distinct and emits CSS-only assets",
    async (suffix) => {
      const root = await fixture({
        "entry.tsx": `import raw from "./icon.svg?raw"; import url from "./icon.svg${suffix}"; export const App = () => <div css={{vars:{"--raw":raw,"--asset-url":url}}} />;`,
        "icon.svg": "asset-content"
      });

      const result = await build(
        buildOptions(root, {
          publicPath: "/static",
          assetNames: "assets/[name]-[hash]",
          loader: { ".svg": "file" }
        })
      );

      expect(cssVariable(result, "--raw")).toBe("asset-content");

      const asset = result.outputFiles?.find((file) =>
        file.path.endsWith(".svg")
      );

      expect(asset?.text).toBe("asset-content");
      expect(cssVariable(result, "--asset-url")).toBe(
        `/static/${relative(join(root, "out"), asset!.path)}${suffix}`
      );
      expect(
        Object.keys(result.metafile?.inputs ?? {}).some((path) =>
          path.includes("icon.svg")
        )
      ).toBe(true);
      expect(Object.keys(result.metafile?.inputs ?? {})).not.toContain(
        "<stdin>"
      );
      expect(
        Object.keys(result.metafile?.inputs ?? {}).some((path) =>
          path.includes("mincho-asset-helper")
        )
      ).toBe(false);
      expect(
        result.outputFiles?.filter((file) => file.path.endsWith(".js"))
      ).toHaveLength(1);
      await expect(fs.stat(join(root, "out"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it("matches the runtime URL for implicit outbase, multiple entries and configured paths", async () => {
    const source =
      'import image from "../../shared/icon.png?url"; export { image }; export const App = () => <div css={{vars:{"--asset-url":image}}} />;';

    const root = await fixture({
      "src/one/a/entry.tsx": source,
      "src/two/b/entry.tsx": source,
      "src/shared/icon.png": "asset-bytes"
    });

    for (const outbase of [undefined, root]) {
      const result = await build(
        buildOptions(root, {
          entryPoints: [
            join(root, "src/one/a/entry.tsx"),
            join(root, "src/two/b/entry.tsx")
          ],
          entryNames: "entries/[dir]/[name]",
          assetNames: "assets/[dir]/[name]-[hash]",
          loader: { ".png": "file" },
          publicPath: "https://cdn.example/assets",
          outbase
        })
      );

      expect(outputText(result, ".js")).toContain(
        JSON.stringify(cssVariable(result, "--asset-url"))
      );
      expect(
        result.outputFiles?.filter((file) => file.path.endsWith(".png"))
      ).toHaveLength(1);
    }
  });

  it("supports outfile and writes CSS-only assets without publishing the helper module", async () => {
    const root = await fixture({
      "entry.tsx":
        'import image from "./icon.png?url"; export const App = () => <div css={{vars:{"--asset-url":image}}} />;',
      "icon.png": "asset-bytes"
    });

    const outfile = join(root, "out/nested/bundle.js");
    const result = await build(
      buildOptions(root, {
        outdir: undefined,
        outfile,
        write: true,
        loader: { ".png": "file" }
      })
    );

    expect(result.outputFiles).toBeUndefined();

    const css = await fs.readFile(join(root, "out/nested/bundle.css"), "utf8");
    const assetName = /--asset-url:\s*\.\/([^;?]+)\?url;/.exec(css)?.[1];

    expect(assetName).toBeDefined();
    expect(
      await fs.readFile(join(root, "out/nested", assetName!), "utf8")
    ).toBe("asset-bytes");
    expect(
      (await fs.readdir(join(root, "out/nested"))).filter((name) =>
        name.endsWith(".js")
      )
    ).toEqual(["bundle.js"]);
  });

  it("uses native dataurl strings without emitting an asset file", async () => {
    const root = await fixture({
      "entry.tsx":
        'import image from "./icon.svg?url"; export { image }; export const App = () => <div css={{vars:{"--asset-url":image}}} />;',
      "icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    });

    const result = await build(
      buildOptions(root, { loader: { ".svg": "dataurl" } })
    );

    expect(outputText(result, ".css")).toContain("data:image/svg+xml,");
    expect(result.outputFiles?.some((file) => file.path.endsWith(".svg"))).toBe(
      false
    );

    // The native JS export and static evaluation use the same encoded string.
    const css = outputText(result, ".css");
    const url = /--asset-url:\s*(.*);/.exec(css)?.[1];

    expect(url).toBeDefined();

    const constants = parse(outputText(result, ".js"), { sourceType: "module" })
      .program.body.filter((node) => node.type === "VariableDeclaration")
      .flatMap((node) => node.declarations)
      .flatMap((node) =>
        node.init?.type === "StringLiteral" ? [node.init.value] : []
      );

    expect(constants).toContain(url);
  });

  it.each([false, true])(
    "watches asset contents with jsxCssProp=%s and updates emitted bytes",
    async (jsxCssProp) => {
      const root = await fixture({
        "entry.tsx": jsxCssProp
          ? 'import image from "./icon.png?url"; export const App = () => <div css={{vars:{"--asset-url":image}}} />;'
          : 'import { css } from "@mincho-js/css"; import image from "./icon.png?url"; export const className = css({ vars: { "--asset-url": image } });',
        "icon.png": "first"
      });

      const observed = observeBuilds();
      const buildContext = await context(
        buildOptions(root, {
          loader: { ".png": "file" },
          plugins: [...minchoEsbuildPlugins({ jsxCssProp }), observed.plugin]
        })
      );

      try {
        const first = observed.next();
        await buildContext.watch();

        const oldUrl = cssVariable(await first, "--asset-url");
        const next = observed.next();
        await fs.writeFile(join(root, "icon.png"), "second");

        const result = await next;

        expect(result.errors).toEqual([]);
        expect(cssVariable(result, "--asset-url")).not.toBe(oldUrl);
        expect(
          result.outputFiles?.find((file) => file.path.endsWith(".png"))?.text
        ).toBe("second");
      } finally {
        await buildContext.dispose();
      }
    },
    20000
  );

  it("rejects conflicting asset output names before writing extra files", async () => {
    const root = await fixture({
      "entry.tsx":
        'import a from "./a/icon.png?url"; import b from "./b/icon.png?url"; export const App = () => <div css={{vars:{"--a":a,"--b":b}}} />;',
      "a/icon.png": "first",
      "b/icon.png": "second"
    });

    await expect(
      build(
        buildOptions(root, {
          assetNames: "assets/[name]",
          loader: { ".png": "file" },
          write: true
        })
      )
    ).rejects.toThrow("Conflicting esbuild asset output");
    await expect(
      fs.stat(join(root, "out/assets/icon.png"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves CSS url tokens through the original native asset", async () => {
    const root = await fixture({
      "styles/main.css": "",
      "icon.png": "asset-bytes"
    });

    const result = await build(
      buildOptions(root, {
        entryPoints: [join(root, "styles/main.css")],
        entryNames: "nested/[name]",
        assetNames: "assets/[name]-[hash]",
        loader: { ".png": "file" },
        plugins: [
          {
            name: "asset-css-fixture",

            setup(build) {
              const assets = new EsbuildAssets(build);
              build.onStart(() => assets.beginBuild());
              build.onResolve({ filter: /.*/ }, (args) =>
                args.kind === "url-token"
                  ? assets.resolveCssUrl(args.path)
                  : undefined
              );
              build.onLoad(
                { filter: /\.css$/, namespace: "file" },
                async () => ({
                  contents: `.icon { background-image: url(${JSON.stringify(await assets.load(join(root, "icon.png"), "?url"))}); }`,
                  loader: "css"
                })
              );
              build.onEnd((result) => assets.finishBuild(result));
            }
          }
        ]
      })
    );

    const asset = result.outputFiles?.find((file) =>
      file.path.endsWith(".png")
    );

    expect(asset).toBeDefined();
    expect(outputText(result, ".css")).toContain(
      `../assets/${asset!.path.split("/").at(-1)}?url`
    );
    expect(
      result.outputFiles?.filter((file) => file.path.endsWith(".png"))
    ).toHaveLength(1);
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InternalVanillaCssArtifact } from "@mincho-js/integration";
import {
  build,
  createBuilder,
  type Plugin,
  type Rollup,
  type UserConfig,
  type ResolvedConfig
} from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { minchoVitePlugin, type MinchoVitePluginOptions } from "./index.js";
import { createDistChunkCss } from "./distChunkCss.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(extra: Record<string, string> = {}) {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "dist-chunk-"));
  roots.push(root);

  const files = {
    "package.json":
      '{"name":"dist-chunk-fixture","type":"module","sideEffects":true}',
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js":
      'import "./home.css"; globalThis.routes = {a:()=>import("./a.js"), b:()=>import("./b.js")};',
    "home.css": ".home {color:black}",
    "layout.js":
      'import {css} from "@mincho-js/css"; export const layout = css({color:"red"});',
    "a.js":
      'import {layout} from "./layout.js"; import {style} from "./a-style.js"; export const page = layout + " " + style;',
    "b.js":
      'import {layout} from "./layout.js"; import {style} from "./b-style.js"; export const page = layout + " " + style;',
    "a-style.js":
      'import {css} from "@mincho-js/css"; export const style = css({color:"blue"});',
    "b-style.js":
      'import {css} from "@mincho-js/css"; export const style = css({color:"green"});',
    "unused.js":
      'import {css} from "@mincho-js/css"; export const unused = css({color:"magenta"});',
    ...extra
  };

  await Promise.all(
    Object.entries(files).map(([name, source]) =>
      writeFile(join(root, name), source)
    )
  );

  return root;
}

async function compile(
  root: string,
  options: MinchoVitePluginOptions = {},
  config: UserConfig = {}
) {
  const moduleSources: string[] = [];
  const observer: Plugin = {
    name: "observe-dist-chunk-graph",

    buildEnd(error) {
      if (error) return;

      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id)!;

        if (id.startsWith("\0mincho-extracted-css:"))
          moduleSources.push(info.code!);
        if (id.startsWith("\0mincho-style-marker:"))
          expect(info.moduleSideEffects).toBe("no-treeshake");
      }
    }
  };

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    ...config,
    plugins: [
      minchoVitePlugin({
        cache: false,
        ...options,
        appCss: { mode: "dist-chunk", optimize: true, ...options.appCss },
        diagnostics: { json: "events.json" }
      }),
      observer,
      ...(config.plugins ?? [])
    ],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      manifest: true,
      sourcemap: true,
      ...config.build
    }
  });

  const output = (
    Array.isArray(result) ? result[0] : result
  ) as Rollup.RollupOutput;

  const css = output.output.filter(
    (item): item is Rollup.OutputAsset =>
      item.type === "asset" && item.fileName.endsWith(".css")
  );

  const report = JSON.parse(await readFile(join(root, "events.json"), "utf8"));
  const events: {
    phase: string;
    detail?: {
      chunk?: string;
      mergedRules?: number;
      enabled?: boolean;
      reason?: string;
      removedVariables?: number;
      liveness?: string;
    };
  }[] = report.builds.flatMap((b: { events: unknown[] }) => b.events);

  return {
    output: output.output,
    css,
    events,
    moduleSources,
    text: css.map((item) => String(item.source)).join("\n")
  };
}

describe("shared artifact provenance", () => {
  function fixture() {
    const adapter = createDistChunkCss(() => {});
    adapter.configure(
      {
        command: "build",
        root: process.cwd(),
        css: {},
        build: { cssCodeSplit: true },
        plugins: [
          { name: "vite:css", transform: async (code: string) => code },
          { name: "vite:css-post", transform: async () => "export default '';" }
        ]
      } as unknown as ResolvedConfig,
      true,
      { mergeRules: false, compactThemes: false, pruneGenerated: true }
    );

    const data = (
      publicReferences: string[],
      opaque = false
    ): InternalVanillaCssArtifact => ({
      origin: "/project/shared.css.ts",
      fileScope: { filePath: "shared.css.ts", packageName: "test" },
      cssObjs: [
        {
          type: "local",
          selector: "shared",
          rule: {
            vars: { "--one": "red", "--two": "blue", "--dead": "green" },
            color: "black"
          }
        }
      ],
      localClassNames: ["shared"],
      composedClassLists: [],
      usedCompositions: [],
      provenance: {
        version: 1,
        publicReferences,
        generatedVariables: ["--one", "--two", "--dead"],
        opaque
      }
    });

    const publish = (owner: string, values: InternalVanillaCssArtifact[]) => {
      const transaction = adapter.transaction();

      for (const value of values) adapter.collect(value, transaction);

      adapter.commit(owner, transaction);

      expect(transaction.size).toBe(1);

      return [...transaction.keys()][0]!;
    };

    const preview = async (ids: string[], code?: string) => {
      const sources: string[] = [];
      await adapter.plan(
        {
          getModuleIds: () => ids.values(),

          ...(code === undefined
            ? {}
            : { getModuleInfo: () => ({ code }) as Rollup.ModuleInfo })
        },
        (_id, css) => sources.push(css)
      );

      return sources.join("\n");
    };

    return { adapter, data, publish, preview };
  }

  it("unions per-owner visibility while retaining one CSS identity", async () => {
    const { data, publish, preview } = fixture();
    const id = publish("/project/a.js", [data(["--one"]), data(["--two"])]);
    const second = publish("/project/b.js", [data([])]);

    expect(second).toBe(id);

    const css = await preview(["/project/a.js", "/project/b.js", id]);

    expect(css).toContain("--one");
    expect(css).toContain("--two");
    expect(css).not.toContain("--dead");
    expect(css.match(/color: black/g)).toHaveLength(1);
  });

  it("recomputes union and opaque state after owner replacement or deletion", async () => {
    const { adapter, data, publish, preview } = fixture();
    const id = publish("/project/a.js", [data(["--one"])]);
    publish("/project/b.js", [data(["--two"], true)]);

    const ids = ["/project/a.js", "/project/b.js", id];

    expect(await preview(ids)).toContain("--dead");

    publish("/project/b.js", [data(["--two"])]);

    expect(await preview(ids)).not.toContain("--dead");

    publish("/project/a.js", [data([])]);

    expect(await preview(ids)).not.toContain("--one");
    expect(await preview(ids)).toContain("--two");

    adapter.clearOwner("/project/b.js");

    expect(await preview(ids)).not.toContain("--two");

    const unknown = data([]);
    delete unknown.provenance;
    publish("/project/b.js", [unknown]);

    expect(await preview(ids)).toContain("--dead");

    adapter.clearOwner("/project/b.js");

    expect(await preview(ids)).not.toContain("--dead");
  });

  it("discards removed consumer visibility even when a live owner keeps the shared marker", async () => {
    const { adapter, data, publish, preview } = fixture();
    const id = publish("/project/a.js", [data(["--one"])]);
    publish("/project/b.js", [data([])]);

    expect(await preview(["/project/a.js", "/project/b.js", id])).toContain(
      "--one"
    );
    expect(await preview(["/project/b.js?query", id])).not.toContain("--one");
    expect(adapter.load(id)).toBeDefined();
    expect(await preview(["/project/b.js"])).toBe("");
    expect(() => adapter.load(id)).toThrow("Missing dist-chunk style artifact");
    expect(publish("/project/a.js", [data(["--two"])])).toBe(id);
    expect(await preview(["/project/a.js", id])).toContain("--two");

    adapter.clear();

    expect(() => adapter.load(id)).toThrow("Missing dist-chunk style artifact");
  });

  it.each([
    "getComputedStyle",
    "computedStyleMap",
    "cssRules",
    "styleSheets",
    "getPropertyValue",
    "setProperty",
    "registerProperty"
  ])("keeps private resources when loaded JS can use %s", async (method) => {
    const { data, publish, preview } = fixture();
    const id = publish("/project/a.js", [data([])]);
    const ids = ["/project/a.js", id];

    expect(await preview(ids)).not.toContain("--dead");
    expect(
      await preview(ids, `globalThis.observe = value => value["${method}"];`)
    ).toContain("--dead");
  });
});

describe("chunk-stage Mincho CSS generation", () => {
  it("merges adjacent equal rules without changing exported class names", async () => {
    const root = await fixture({
      "main.js": 'import {a,b} from "./styles.js"; globalThis.classes=[a,b];',
      "styles.js":
        'import {css} from "@mincho-js/css"; export const a=css({color:"red"}); export const b=css({color:"red"});'
    });

    const baseline = await compile(root, { appCss: { optimize: false } });
    const optimized = await compile(root);

    expect(baseline.text.match(/color: red/g)).toHaveLength(2);
    expect(optimized.text.match(/color: red/g)).toHaveLength(1);

    const classes = (css: string) =>
      [...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]).sort();

    expect(classes(optimized.text)).toEqual(classes(baseline.text));
    expect(
      optimized.events.some(
        (event) =>
          event.phase === "css-ir-optimize" &&
          (event.detail?.mergedRules ?? 0) > 0
      )
    ).toBe(true);
  });

  it("prunes captured private vars while retaining exported and author-owned vars", async () => {
    const root = await fixture({
      "main.js":
        'import {style,publicToken} from "./styles.js"; globalThis.classes=[style,publicToken];',
      "styles.js": `import {css,createVar} from "@mincho-js/css";
        import {createGlobalVar} from "@vanilla-extract/css";
        export const publicToken=createVar({syntax:"<color>",inherits:false,initialValue:"green"},"publicToken");
        const author=createGlobalVar("author-token",{syntax:"<color>",inherits:false,initialValue:"blue"});
        export const style=css((()=>{const privateToken=createVar({syntax:"<color>",inherits:false,initialValue:"red"},"privateToken");return {vars:{[privateToken]:"red",[publicToken]:"green",[author]:"blue"},color:"black"};})());`
    });

    const baseline = await compile(root, { appCss: { optimize: false } });
    const optimized = await compile(root);

    expect(baseline.text.match(/@property /g)).toHaveLength(3);
    expect(optimized.text.match(/@property /g)).toHaveLength(2);
    expect(optimized.text).toContain("initial-value: green");
    expect(optimized.text).toContain("author-token");
    expect(optimized.text).toContain("color: black");
    expect(
      optimized.events.some(
        (event) =>
          event.phase === "css-ir-optimize" &&
          (event.detail?.removedVariables ?? 0) > 0
      )
    ).toBe(true);
  });

  it("preserves private properties observed through runtime CSSOM access", async () => {
    const root = await fixture({
      "main.js":
        'import {style} from "./styles.js"; globalThis.classes=style; globalThis.observe=element=>getComputedStyle(element);',
      "styles.js": `import {css,createVar} from "@mincho-js/css";
        export const style=css((()=>{const token=createVar({syntax:"<color>",inherits:false,initialValue:"red"});return {vars:{[token]:"red"},color:"black"};})());`
    });

    const observed = await compile(root);

    expect(observed.text.match(/@property /g)).toHaveLength(1);
    expect(
      observed.events.some(
        (event) =>
          event.phase === "css-ir-optimize" &&
          event.detail?.liveness === "opaque-runtime-css"
      )
    ).toBe(true);

    await writeFile(
      join(root, "main.js"),
      'import {style} from "./styles.js"; globalThis.classes=style;'
    );

    const unobserved = await compile(root);

    expect(unobserved.text).not.toContain("@property");
    expect(unobserved.text).toContain("color: black");
  });

  it("memoizes pure serialization across sharing previews and outputs, with a cache opt-out", async () => {
    const root = await fixture();
    const cached = await compile(root, {
      cache: { type: "memory" },
      appCss: { sharing: { minBytes: 0 } }
    });

    const uncached = await compile(root, {
      cache: false,
      appCss: { sharing: { minBytes: 0 } }
    });

    expect(uncached.text).toBe(cached.text);

    const count = (result: typeof cached) =>
      result.events.filter((event) => event.phase === "css-ir-serialize")
        .length;

    expect(count(uncached)).toBeGreaterThan(count(cached));
    expect(
      uncached.events
        .filter((event) => event.phase === "css-ir-serialize-cache")
        .every((event) => event.detail?.enabled === false)
    ).toBe(true);
  });

  it("skips structural passes for inline or automatically discovered PostCSS configuration", async () => {
    const root = await fixture({
      "main.js": 'import {a,b} from "./styles.js"; globalThis.classes=[a,b];',
      "styles.js":
        'import {css} from "@mincho-js/css"; export const a=css({color:"red"}); export const b=css({color:"red"});',
      ".postcssrc.json": '{"plugins":{}}'
    });

    const result = await compile(root, {
      appCss: { optimize: { shareAtoms: false } }
    });

    expect(result.text.match(/color: red/g)).toHaveLength(2);
    expect(
      result.events.some(
        (event) =>
          event.phase === "css-ir-optimize" &&
          event.detail?.reason === "opaque-postcss"
      )
    ).toBe(true);

    const inline = await compile(
      root,
      {},
      { css: { postcss: { plugins: [] } } }
    );

    expect(inline.text).toBe(result.text);
  });

  it("fails explicitly when native adapter hooks are missing, leaving inactive modes alone", () => {
    const adapter = createDistChunkCss(() => {});
    const config = {
      command: "build",
      build: { cssCodeSplit: true },
      css: {},
      plugins: []
    } as unknown as ResolvedConfig;

    expect(() => adapter.configure(config, false)).not.toThrow();
    expect(() =>
      adapter.configure(
        { ...config, build: { ...config.build, ssr: true } },
        true
      )
    ).not.toThrow();
    expect(() => adapter.configure(config, true)).toThrow(
      "validated Vite 7.3.3 CSS adapter"
    );
  });

  it("collects raw rules during transform and generates from actual output membership", async () => {
    const root = await fixture();
    const result = await compile(root);

    expect(result.moduleSources.length).toBeGreaterThan(0);

    for (const source of result.moduleSources) {
      expect(source).toContain("mincho-style-marker:");
      expect(source).not.toContain(".vanilla.css");
      expect(source).not.toContain("color:");
    }

    expect(result.events.some((e) => e.phase === "css-ir-preview")).toBe(true);

    const generated = result.events.filter(
      (e) => e.phase === "css-ir-generate"
    );

    expect(generated).toHaveLength(3);
    expect(new Set(generated.map((e) => e.detail?.chunk)).size).toBe(3);
    expect(result.text).toContain("color: red");
    expect(result.text.match(/color: red/g)).toHaveLength(1);
    expect(result.text).not.toContain("magenta");

    const html = result.output.find(
      (i) => i.fileName === "index.html"
    ) as Rollup.OutputAsset;

    for (const item of result.css.filter(
      (i) =>
        String(i.source).includes("color: blue") ||
        String(i.source).includes("color: green")
    ))
      expect(html.source).not.toContain(item.fileName);

    const js = result.output.filter(
      (i): i is Rollup.OutputChunk => i.type === "chunk"
    );

    expect(js.some((i) => i.code.includes("__vitePreload"))).toBe(true);

    const native = await compile(root, { appCss: { mode: "native" } });

    const maps = (items: Rollup.OutputBundle[string][]) =>
      items
        .filter((i): i is Rollup.OutputChunk => i.type === "chunk")
        .map((i) => [i.name, i.map?.sources])
        .sort();

    expect(js.every((i) => i.map)).toBe(true);
    expect(maps(result.output)).toEqual(maps(native.output));
  });

  it("honors user manualChunks while generating real chunk CSS", async () => {
    const root = await fixture();
    const result = await compile(
      root,
      { appCss: { sharing: { minBytes: 0 } } },
      {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                if (id.endsWith("/layout.js")) return "user-layout";
              }
            }
          }
        }
      }
    );

    expect(
      result.css.find((i) => i.fileName.includes("user-layout"))?.source
    ).toContain("color: red");
    expect(result.events.some((e) => e.phase === "css-ir-generate")).toBe(true);
    expect(result.css.some((i) => i.fileName.includes("mincho-shared-"))).toBe(
      false
    );
  });

  it("generates each Rollup output independently", async () => {
    const root = await fixture();
    const result = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        minchoVitePlugin({ cache: false, appCss: { mode: "dist-chunk" } })
      ],
      build: {
        write: false,
        cssMinify: false,
        rollupOptions: {
          input: join(root, "main.js"),
          output: [
            { format: "es", entryFileNames: "esm/[name].js" },
            { format: "cjs", entryFileNames: "cjs/[name].cjs" }
          ]
        }
      }
    })) as Rollup.RollupOutput[];

    expect(result).toHaveLength(2);

    const css = (output: Rollup.RollupOutput) =>
      output.output
        .filter(
          (i): i is Rollup.OutputAsset =>
            i.type === "asset" && i.fileName.endsWith(".css")
        )
        .map((i) => String(i.source))
        .sort();

    expect(css(result[0]!)).toEqual(css(result[1]!));
    expect(css(result[0]!).join("")).toContain("color: blue");
  });

  it("isolates client chunk generation from a simultaneous SSR environment", async () => {
    const root = await fixture();
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        minchoVitePlugin({
          cache: false,
          appCss: { mode: "dist-chunk" },
          diagnostics: { json: "environments.json" }
        })
      ],
      builder: { sharedPlugins: true, sharedConfigBuild: true },
      build: { write: false, rollupOptions: { input: join(root, "main.js") } },
      environments: {
        client: { consumer: "client" },
        ssr: { consumer: "server", build: { ssr: join(root, "main.js") } }
      }
    });

    const [client, server] = (await Promise.all([
      builder.build(builder.environments.client!),
      builder.build(builder.environments.ssr!)
    ])) as Rollup.RollupOutput[];

    expect(
      client!.output.some(
        (i) => i.type === "asset" && i.fileName.endsWith(".css")
      )
    ).toBe(true);
    expect(
      server!.output.some(
        (i) => i.type === "asset" && i.fileName.endsWith(".css")
      )
    ).toBe(false);

    const report = JSON.parse(
      await readFile(join(root, "environments.json"), "utf8")
    );

    const generated = report.builds.filter(
      (b: { events: { phase: string }[] }) =>
        b.events.some((e) => e.phase === "css-ir-generate")
    );

    expect(
      generated.map((b: { environment: string }) => b.environment)
    ).toEqual(["client"]);
  });

  it("matches native ownership for a style provider evaluated from multiple consumers", async () => {
    const root = await fixture({
      "a-style.js":
        'import {css,createVar} from "@mincho-js/css"; import {layout} from "./layout.js"; const token=createVar(); export const style=css([layout,{color:"blue",vars:{[token]:"a"}}]);',
      "b-style.js":
        'import {css,createVar} from "@mincho-js/css"; import {layout} from "./layout.js"; const token=createVar(); export const style=css([layout,{color:"green",vars:{[token]:"b"}}]);'
    });

    const native = await compile(root, { appCss: { mode: "native" } });
    const chunk = await compile(root);

    expect(chunk.text.match(/color: red/g)?.length).toBe(
      native.text.match(/color: red/g)?.length
    );
    expect(chunk.text.match(/color: blue/g)?.length).toBe(1);
    expect(chunk.text.match(/color: green/g)?.length).toBe(1);
  });

  it("shares marker ownership through generic route/layout lists", async () => {
    const root = await fixture();
    const result = await compile(root, {
      appCss: {
        sharing: { minBytes: 0 },
        routes: ["a", "b"].map((id) => ({
          id,
          entry: `${id}.js`,
          layouts: ["layout.js"]
        }))
      }
    });

    const shared = result.css.filter((i) =>
      i.fileName.includes("mincho-shared-")
    );

    expect(shared).toHaveLength(1);
    expect(shared[0]!.source).toContain("color: red");
    expect(shared[0]!.source).not.toContain("color: blue");
    expect(result.events.some((e) => e.phase === "css-ir-preview")).toBe(true);
    expect(result.text.match(/color: red/g)).toHaveLength(1);
    expect(
      result.output.some(
        (i) => i.type === "chunk" && i.fileName.includes("mincho-shared-")
      )
    ).toBe(false);
  });

  it("preserves pure style imports and ordinary CSS ordering, resolving URLs and PostCSS from the origin", async () => {
    const root = await fixture({
      "main.js":
        'import "./before.css"; import "./only-style.js"; import "./after.css";',
      "before.css": ".order {color: red}",
      "only-style.js":
        'import {globalCss} from "@mincho-js/css"; globalCss(".order", {color:"blue",backgroundImage:"url(./icon.svg)","@media":{"(min-width:1px)":{padding:2}}});',
      "after.css": ".order {color: green}",
      "icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>'
    });

    const config: UserConfig = {
      css: {
        postcss: {
          plugins: [
            {
              postcssPlugin: "recolor",

              Declaration(declaration) {
                if (declaration.value === "blue") declaration.value = "purple";
              }
            }
          ]
        }
      },
      build: { assetsInlineLimit: 0 }
    };

    const native = await compile(root, { appCss: { mode: "native" } }, config);
    const chunk = await compile(root, {}, config);
    const svg = chunk.output.find((i) => i.fileName.endsWith(".svg"))!;

    expect(chunk.text.replace(`/${svg.fileName}`, "./icon.svg")).toBe(
      native.text
    );
    expect(chunk.text.indexOf("color: red")).toBeLessThan(
      chunk.text.indexOf("color: purple")
    );
    expect(chunk.text.indexOf("color: purple")).toBeLessThan(
      chunk.text.indexOf("color: green")
    );
    expect(chunk.text).toContain("min-width:1px");
    expect(chunk.text).toContain(svg.fileName);
  });

  it.each([
    { cache: false, execution: { workers: 0, evaluation: "fresh" } },
    { cache: false, execution: { workers: 2 } },
    {
      cache: { type: "filesystem", evaluationResults: true },
      execution: { workers: 0 }
    }
  ] satisfies MinchoVitePluginOptions[])(
    "preserves CSS across cold/warm builds with %j",
    async (options) => {
      const root = await fixture();
      const cold = await compile(root, options);
      const warm = await compile(root, options);

      expect(warm.css).toEqual(cold.css);
      expect(
        warm.events.filter((e) => e.phase === "css-ir-generate")
      ).toHaveLength(3);

      if (options.cache)
        expect(warm.events.some((e) => e.phase.includes("hit"))).toBe(true);
    }
  );

  it("rejects opaque CSS transforms while accepting explicit JS-only filters", async () => {
    const root = await fixture();

    await expect(
      compile(
        root,
        {},
        {
          plugins: [
            {
              name: "opaque-styles",

              transform(code) {
                return code;
              }
            }
          ]
        }
      )
    ).rejects.toThrow('cannot replay CSS transform "opaque-styles"');

    const result = await compile(
      root,
      {},
      {
        plugins: [
          {
            name: "js-only",
            transform: {
              filter: { id: /\.[jt]sx?$/ },

              handler(code) {
                return code;
              }
            }
          }
        ]
      }
    );

    expect(result.text).toContain("color: blue");
  });

  it("changes CSS, JS and manifest hashes after a CSS-only edit", async () => {
    const root = await fixture();
    const before = await compile(root);
    await writeFile(
      join(root, "a-style.js"),
      'import {css} from "@mincho-js/css"; export const style=css({color:"orange"});'
    );

    const after = await compile(root);

    const jsName = (result: typeof before) =>
      result.output.find(
        (i) => i.type === "chunk" && i.facadeModuleId === join(root, "a.js")
      )!.fileName;

    expect(jsName(after)).not.toBe(jsName(before));
    expect(after.text).toContain("orange");
    expect(after.text).not.toContain("blue");
    expect(
      after.output.find((i) => i.fileName === ".vite/manifest.json")
    ).not.toEqual(
      before.output.find((i) => i.fileName === ".vite/manifest.json")
    );
  });

  it("keeps composition, layer, keyframe and conditional output equal to native CSS", async () => {
    const root = await fixture({
      "main.js":
        'import "./home.css"; import {style} from "./complex.js"; import "./after.css"; globalThis.style=style;',
      "after.css": "@media (min-width:1px) {body {color:green}}",
      "complex.js": `import {css, globalCss, layer, keyframes} from '@mincho-js/css';
        const scope=layer('example');
        const animation=keyframes({from:{opacity:0},to:{opacity:1}});
        const base=css({color:'red'});
        export const group=css([base]);
        globalCss('body', {'@media':{'(min-width:1px)':{color:'orange'}}});
        export const style=css({animationName:animation, selectors:{[group+' &']:{padding:3}}, '@layer':{[scope]:{color:'blue'}}, '@media':{'(min-width:1px)':{margin:2}}});`
    });

    const native = await compile(root, { appCss: { mode: "native" } });
    const chunk = await compile(root);

    expect(chunk.text).toBe(native.text);
    expect(chunk.text).toContain("@keyframes");
    expect(chunk.text).toContain("@layer");
  });

  it("retains unchanged IR and removes edited/deleted owners in watch builds", async () => {
    const root = await fixture();
    let latest = "";
    const watcher = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        minchoVitePlugin({
          cache: { type: "memory" },
          appCss: { mode: "dist-chunk" }
        }),
        {
          name: "watch-css-output",

          generateBundle(_options, bundle) {
            latest = Object.values(bundle)
              .filter(
                (i): i is Rollup.OutputAsset =>
                  i.type === "asset" && i.fileName.endsWith(".css")
              )
              .map((i) => String(i.source))
              .join("\n");
          }
        }
      ],

      // Allow the watcher's file-event throttle to settle between rapid edits,
      // including the deliberately fast syntax-error/recovery cycle.
      build: {
        write: false,
        watch: { buildDelay: 150 },
        minify: false,
        cssMinify: false
      }
    })) as Rollup.RollupWatcher;

    const next = () =>
      new Promise<string>((resolve, reject) => {
        let started = false;

        const handler = (event: Rollup.RollupWatcherEvent) => {
          if (event.code === "BUNDLE_START") started = true;
          if (!started) return;

          if (event.code === "ERROR") {
            watcher.off("event", handler);
            reject(event.error);
          }

          if (event.code === "BUNDLE_END") void event.result.close();

          if (event.code === "END") {
            watcher.off("event", handler);
            resolve(latest);
          }
        };

        watcher.on("event", handler);
      });

    try {
      expect(await next()).toContain("color: blue");

      let changed = next();
      await writeFile(
        join(root, "a-style.js"),
        'import {css} from "@mincho-js/css"; export const style=css({color:"orange"});'
      );

      const edited = await changed;

      expect(edited).toContain("color: orange");
      expect(edited).toContain("color: green");
      expect(edited).not.toContain("color: blue");

      changed = next();

      const failed = expect(changed).rejects.toThrow();
      await writeFile(join(root, "a-style.js"), "export const style = ;");
      await failed;
      changed = next();
      await writeFile(
        join(root, "a-style.js"),
        'import {css} from "@mincho-js/css"; export const style=css({color:"purple"});'
      );

      const recovered = await changed;

      expect(recovered).toContain("color: purple");
      expect(recovered).not.toContain("color: orange");

      changed = next();
      await writeFile(
        join(root, "main.js"),
        'import "./home.css"; globalThis.load=()=>import("./b.js");'
      );

      const removed = await changed;

      expect(removed).not.toContain("color: orange");
      expect(removed).not.toContain("color: purple");
      expect(removed).toContain("color: green");

      changed = next();
      await writeFile(
        join(root, "main.js"),
        'import "./home.css"; globalThis.routes={a:()=>import("./a.js"),b:()=>import("./b.js")};'
      );

      expect(await changed).toContain("color: purple");

      changed = next();
      await writeFile(
        join(root, "main.js"),
        'import "./home.css"; globalThis.load=()=>import("./b.js");'
      );
      await rm(join(root, "a-style.js"));

      expect(await changed).not.toContain("color: purple");
    } finally {
      await watcher.close();
    }
  });
});

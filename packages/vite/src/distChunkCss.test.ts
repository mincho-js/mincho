import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
        appCss: { mode: "dist-chunk", ...options.appCss },
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
  const events: { phase: string; detail?: { chunk?: string } }[] =
    report.builds.flatMap((b: { events: unknown[] }) => b.events);

  return {
    output: output.output,
    css,
    events,
    moduleSources,
    text: css.map((item) => String(item.source)).join("\n")
  };
}

describe("chunk-stage Mincho CSS generation", () => {
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

    expect(result.events.some((e) => e.phase === "css-ir-preview")).toBe(false);

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
        'import {css} from "@mincho-js/css"; import {layout} from "./layout.js"; export const style=css([layout,{color:"blue"}]);',
      "b-style.js":
        'import {css} from "@mincho-js/css"; import {layout} from "./layout.js"; export const style=css([layout,{color:"green"}]);'
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
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  build,
  createServer,
  normalizePath,
  transformWithEsbuild,
  type DevEnvironment,
  type InlineConfig,
  type Plugin,
  type Rollup,
  type ViteDevServer
} from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "./index.js";

const roots: string[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture(files: Record<string, string>) {
  const cacheRoot = join(process.cwd(), ".cache");
  await mkdir(cacheRoot, { recursive: true });

  const root = normalizePath(await mkdtemp(join(cacheRoot, "vite-runtime-")));
  roots.push(root);
  await mkdir(join(root, "src"));
  await Promise.all(
    Object.entries(files).map(([file, source]) =>
      writeFile(join(root, file), source)
    )
  );

  return root;
}

async function createFixtureServer(
  root: string,
  plugins: Plugin[],
  watch = false,
  optimizeCommonJs = false
) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: {
      middlewareMode: true,
      watch: watch
        ? {
            usePolling: true,
            interval: 20,

            // Deliver complete edits instead of discarding rapid writes in the
            // watcher's 50 ms change throttle. Both Vite watchers inherit this.
            awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 }
          }
        : null
    },
    optimizeDeps: {
      noDiscovery: !optimizeCommonJs,
      include: optimizeCommonJs ? ["@mincho-js/css"] : []
    },
    plugins
  });

  servers.push(server);

  return server;
}

async function readCssPropOutput(
  environment: DevEnvironment,
  ownerUrl = "/src/entry.tsx"
) {
  const result = await environment.transformRequest(ownerUrl);
  const owner = await environment.moduleGraph.getModuleByUrl(ownerUrl);
  const sidecar = ownerUrl.endsWith(".css.ts")
    ? owner
    : [...(owner?.importedModules ?? [])].find((module) =>
        module.id?.startsWith("\0mincho-extracted-css:")
      );
  if (!sidecar) throw new Error("Expected the owner to import extracted CSS");

  await environment.transformRequest(sidecar.url);

  const virtualCss = [...sidecar.importedModules].filter(
    (module) =>
      module.id?.startsWith("\0mincho-virtual-css:") ||
      module.id?.includes(".vanilla.css")
  );
  if (virtualCss.length === 0)
    throw new Error("Expected the sidecar to import virtual CSS");

  const loaded = await Promise.all(
    virtualCss.map((module) => environment.pluginContainer.load(module.id!))
  );

  return {
    code: result?.code,
    css: loaded
      .map((source) => (typeof source === "string" ? source : source?.code))
      .join("\n")
  };
}

describe("mincho with the Vite runtime", () => {
  it("keeps import and require package conditions distinct", async () => {
    const directory = join(
      process.cwd(),
      "../integration/src/__fixtures__/commonjs-conditions"
    );

    const files = Object.fromEntries(
      await Promise.all(
        ["package.json", "entry.js", "import.cjs", "require.cjs"].map(
          async (name) => [name, await readFile(join(directory, name), "utf8")]
        )
      )
    );

    const root = await createFixture(files);
    const server = await createFixtureServer(root, [
      minchoVitePlugin({
        extractCalls: { "./import.cjs": ["make"], "./require.cjs": ["make"] }
      })
    ]);

    for (const environment of [
      server.environments.client!,
      server.environments.ssr!
    ]) {
      const output = await readCssPropOutput(environment, "/entry.js");

      expect(output.css).toContain("color: red");
      expect(output.css).toContain("color: blue");
    }

    const runtime = await server.ssrLoadModule("/entry.js");

    expect(runtime.imported).not.toBe(runtime.required);
  });

  it.each(
    [false, true].flatMap((vanilla) =>
      ["ts", "cjs"].map((extension) => [vanilla, extension] as const)
    )
  )(
    "supports local extractCalls in client, SSR and HMR (vanilla: %s, %s)",
    async (vanilla, extension) => {
      const sourceRoot = join(
        process.cwd(),
        `../integration/src/__fixtures__/extract-calls${extension === "cjs" ? "-commonjs" : ""}/`
      );

      const sources = Object.fromEntries(
        await Promise.all(
          ["entry", "factory", "implementation", "helper"]
            .map((name) => `${name}.${extension}`)
            .map(async (name) => [
              `src/${name}`,
              await readFile(join(sourceRoot, name), "utf8")
            ])
        )
      );

      const root = await createFixture(sources);
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      let updates = 0;
      const server = await createFixtureServer(
        root,
        [
          minchoVitePlugin({
            // The top-level setting overrides the nested Babel setting.
            babel: { extractCalls: { "./missing.ts": ["missing"] } },
            extractCalls: {
              [`./src/factory.${extension}`]: ["defineStyle", "makeRecipe"]
            }
          }),
          ...(vanilla ? vanillaExtractPlugin() : []),
          {
            name: "observe-extract-calls-hmr",

            config() {
              return {
                server: {
                  hotUpdateEnvironments: async (server, hmr) => {
                    await Promise.all(
                      Object.values(server.environments).map(hmr)
                    );
                    updates++;
                  }
                }
              };
            },

            configureServer(server) {
              server.watcher.once("ready", resolveReady);
            }
          }
        ],
        true
      );

      // The factory dependency can be transformed before any call sites.
      const helper = await server.environments.client!.transformRequest(
        `/src/helper.${extension}`
      );

      expect(helper?.code).toContain("return style({");

      for (const environment of [
        server.environments.client!,
        server.environments.ssr!
      ]) {
        const output = await readCssPropOutput(
          environment,
          `/src/entry.${extension}`
        );

        expect(output.css).toContain("color: tomato");
        expect(output.css).toContain("border-width: 3px");
        expect(output.code).not.toContain("defineStyle({");
      }

      const runtime = await server.ssrLoadModule(`/src/entry.${extension}`);

      expect(runtime.render("quiet")).not.toBe(runtime.render("loud"));

      const update = async (file: string, source: string) => {
        await ready;

        const previous = updates;
        await writeFile(join(root, file), source);
        await vi.waitFor(() => expect(updates).toBeGreaterThan(previous), {
          timeout: 5_000
        });
      };

      await update(
        `src/helper.${extension}`,
        sources[`src/helper.${extension}`]!.replace('"3px"', '"7px"')
      );

      for (const environment of [
        server.environments.client!,
        server.environments.ssr!
      ]) {
        const output = await readCssPropOutput(
          environment,
          `/src/entry.${extension}`
        );

        expect(output.css).toContain("border-width: 7px");
        expect(output.css).not.toContain("border-width: 3px");
      }

      await update(
        `src/factory.${extension}`,
        extension === "cjs"
          ? "exports.defineStyle = 1; exports.makeRecipe = 1;"
          : "export const defineStyle = 1; export const makeRecipe = 1;"
      );

      await expect(
        server.environments.client!.transformRequest(`/src/entry.${extension}`)
      ).rejects.toThrow(/extractCalls.*implementation/);

      await update(
        `src/factory.${extension}`,
        sources[`src/factory.${extension}`]!
      );

      expect(
        (
          await readCssPropOutput(
            server.environments.client!,
            `/src/entry.${extension}`
          )
        ).css
      ).toContain("border-width: 7px");

      // Finish the new module's HMR cycle before waiting for the factory edit.
      await update(
        `src/alternate.${extension}`,
        extension === "cjs"
          ? 'const {style} = require("@vanilla-extract/css"); exports.makeRecipe = require("./implementation.cjs").makeRecipe; exports.defineStyle = (rule) => style({ ...rule, borderWidth: "11px" });'
          : 'import { style } from "@vanilla-extract/css"; export { makeRecipe } from "./implementation"; export const defineStyle = (rule) => style({ ...rule, borderWidth: "11px" });'
      );
      await update(
        `src/factory.${extension}`,
        extension === "cjs"
          ? 'module.exports = require("./alternate.cjs");'
          : 'export { defineStyle, makeRecipe } from "./alternate";'
      );

      const alternate = await readCssPropOutput(
        server.environments.client!,
        `/src/entry.${extension}`
      );

      expect(alternate.css).toContain("border-width: 11px");
      expect(alternate.css).not.toContain("border-width: 7px");
    },
    30_000
  );

  it.each(
    [false, true].flatMap((vanilla) =>
      ["ts", "cjs"].map((extension) => [vanilla, extension] as const)
    )
  )(
    "extracts vanilla-extract definitions for client and SSR (vanilla plugin: %s, %s)",
    async (vanilla, extension) => {
      const source = await readFile(
        join(
          process.cwd(),
          "../integration/src/__fixtures__/vanilla-extract/entry.ts"
        ),
        "utf8"
      );

      const root = await createFixture({
        [`src/entry.${extension}`]:
          extension === "cjs"
            ? (
                await transformWithEsbuild(source, "entry.ts", {
                  loader: "ts",
                  format: "cjs"
                })
              ).code
            : source
      });

      const server = await createFixtureServer(
        root,
        [minchoVitePlugin(), ...(vanilla ? vanillaExtractPlugin() : [])],
        false,
        extension === "cjs"
      );

      for (const environment of [
        server.environments.client!,
        server.environments.ssr!
      ]) {
        const output = await readCssPropOutput(
          environment,
          `/src/entry.${extension}`
        );

        expect(output.css).toContain("padding: 13px");
        expect(output.css).toContain("rebeccapurple");
        expect(output.css).toContain("display: flex");
        expect(output.css).toContain("opacity: 0.5");
        expect(output.code).not.toContain("styles.globalLayer(");
        expect(output.code).not.toContain("createRecipe(");
        expect(output.code).not.toContain("atomic.defineProperties(");
        expect(output.code).toContain("assignInlineVars");

        if (extension === "cjs" && environment.name === "client") {
          const owner = await environment.moduleGraph.getModuleByUrl(
            `/src/entry.${extension}`
          );

          const runtime = [...owner!.importedModules].find((module) =>
            module.id?.includes("/.vite/deps/")
          );

          expect(runtime).toBeDefined();

          const optimized = await environment.transformRequest(runtime!.url);

          expect(optimized?.code).toMatch(/export\s+(default|\{)/);
        }
      }

      const runtime = await server.ssrLoadModule(`/src/entry.${extension}`);
      const quiet = runtime.render("quiet", "flex", "red");
      const loud = runtime.render("loud", "grid", "blue");

      expect(quiet.className).not.toBe(loud.className);
      expect(quiet.inline).toEqual({ [Object.keys(quiet.inline)[0]!]: "red" });
      expect(loud.inline).toEqual({ [Object.keys(quiet.inline)[0]!]: "blue" });
      expect(quiet.mapped).toEqual({ mobile: 4, desktop: 8 });
    }
  );

  it("refreshes inherited rules after parent edits, deletion and failed evaluation", async () => {
    const parentSource = (color: string | undefined) =>
      [
        'import { defineRules } from "@mincho-js/css";',
        "const rules = defineRules({ properties: { color: true } });",
        ...(color === undefined
          ? []
          : [`rules.css({ color: ${JSON.stringify(color)} });`]),
        "export const preset = rules.preset;"
      ].join("\n");

    const root = await createFixture({
      "src/parent.css.ts": parentSource("red"),
      "src/entry.css.ts": [
        'import { defineRules } from "@mincho-js/css";',
        'import { preset } from "./parent.css";',
        "const rules = defineRules({ presets: preset, properties: { color: true } });",
        'export const cls = rules.css({ color: "green" });',
        "export const childPreset = rules.preset;"
      ].join("\n")
    });

    let resolveWatcherReady!: () => void;
    const watcherReady = new Promise<void>((resolve) => {
      resolveWatcherReady = resolve;
    });

    let completedUpdates = 0;
    const server = await createFixtureServer(
      root,
      [
        minchoVitePlugin(),
        ...vanillaExtractPlugin(),
        {
          name: "observe-hmr-completion",

          config() {
            return {
              server: {
                hotUpdateEnvironments: async (server, hmr) => {
                  await Promise.all(
                    Object.values(server.environments).map(hmr)
                  );
                  completedUpdates++;
                }
              }
            };
          },

          configureServer(server) {
            server.watcher.once("ready", () => resolveWatcherReady());
          }
        }
      ],
      true
    );

    const client = server.environments.client!;
    const hotMessages = vi.spyOn(client.hot, "send");
    const parent = join(root, "src/parent.css.ts");

    const updateParent = async (source: string) => {
      await watcherReady;

      const previous = completedUpdates;
      await writeFile(parent, source);

      // Request after Vite has completed HMR invalidation in every environment.
      await vi.waitFor(
        () => {
          expect(
            completedUpdates,
            JSON.stringify({ source, calls: hotMessages.mock.calls })
          ).toBeGreaterThan(previous);
        },
        { timeout: 5_000 }
      );
    };

    const readOutput = async () => {
      const result = await readCssPropOutput(client, "/src/entry.css.ts");
      const entry =
        await client.moduleGraph.getModuleByUrl("/src/entry.css.ts");

      for (const module of entry?.importedModules ?? []) {
        if (module.id?.includes(".vanilla.css"))
          await client.transformRequest(module.url);
      }

      return result;
    };

    const snapshotRoot = (code: string | undefined) => {
      const root = code?.match(
        /\brootNodeId\s*:\s*["']([a-f0-9]{64})["']/
      )?.[1];

      expect(root).toBeDefined();

      return root;
    };

    const initial = await readOutput();

    expect(initial.css).toContain("color: red;");
    expect(initial.css).toContain("color: green;");

    const initialRoot = snapshotRoot(initial.code);

    await updateParent(parentSource("blue"));
    await vi.waitFor(
      async () => {
        const next = await readOutput();

        expect(next.css).toContain("color: blue;");
        expect(next.css).not.toContain("color: red;");
        expect(next.css).toContain("color: green;");
      },
      { timeout: 5_000 }
    );

    await updateParent(parentSource(undefined));
    await vi.waitFor(
      async () => {
        const next = await readOutput();

        expect(next.css).not.toContain("color: blue;");
        expect(next.css).toContain("color: green;");
        expect(next.code?.match(/\batomId\s*:/g)).toHaveLength(1);
      },
      { timeout: 5_000 }
    );

    await updateParent(
      `${parentSource("purple")}\nthrow new Error("parent evaluation failed");`
    );
    await vi.waitFor(
      async () => {
        await expect(
          client.transformRequest("/src/entry.css.ts")
        ).rejects.toThrow("parent evaluation failed");
      },
      { timeout: 5_000 }
    );

    await updateParent(parentSource("orange"));
    await vi.waitFor(
      async () => {
        const next = await readOutput();

        expect(next.css).toContain("color: orange;");
        expect(next.css).toContain("color: green;");
        expect(next.css).not.toMatch(/color: (?:red|blue|purple);/);

        // The exported snapshot is regenerated along with its CSS.
        expect(snapshotRoot(next.code)).not.toBe(initialRoot);
        expect(next.code?.match(/\batomId\s*:/g)).toHaveLength(2);
      },
      { timeout: 5_000 }
    );
  });

  it("preserves preceding pre transforms and composes their source maps", async () => {
    const source = [
      'import { css } from "@mincho-js/css";',
      'export const cls = css({ color: "red" });',
      "export const marker = __MARKER__;"
    ].join("\n");

    const root = await createFixture({ "src/entry.ts": source });
    const entry = join(root, "src/entry.ts");
    const server = await createFixtureServer(root, [
      {
        name: "replace-before-mincho",
        enforce: "pre",

        transform(code, id) {
          if (id === entry) {
            return transformWithEsbuild(code, id, {
              define: { __MARKER__: '"after"' },
              sourcemap: true
            });
          }
        }
      },
      minchoVitePlugin()
    ]);

    const result = await server.transformRequest("/src/entry.ts");

    expect(result?.code).toContain('marker = "after"');
    expect(result?.code).not.toContain("__MARKER__");
    expect(result?.code).toContain("extracted_");
    expect(result?.map?.mappings).not.toBe("");
    expect(
      result?.map && "sourcesContent" in result.map && result.map.sourcesContent
    ).toContain(source);
  });

  it.each([
    { entry: "src/a.ts", entries: 1 },
    { entry: ["src/a.ts", "src/b.ts"], entries: 2 },
    { entry: { alpha: "src/a.ts", beta: "src/b.ts" }, entries: 2 }
  ])(
    "resolves relative library entries from the configured root: $entry",
    async ({ entry, entries }) => {
      const root = await createFixture({
        "src/a.ts": 'export const value = "a";',
        "src/b.ts": 'export const value = "b";'
      });

      const config: InlineConfig = {
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        build: { write: false, minify: false, lib: { entry, formats: ["es"] } }
      };

      const result = await build(config);
      if ("on" in result) throw new Error("Unexpected watch build");

      const outputs: Rollup.RollupOutput[] = Array.isArray(result)
        ? result
        : [result];

      expect(
        outputs
          .flatMap((output) => output.output)
          .filter((output) => output.type === "chunk" && output.isEntry)
      ).toHaveLength(entries);
    }
  );

  it("uses unrewritten virtual exports from the current environment and refreshes them after HMR", async () => {
    const root = await createFixture({
      "src/entry.tsx":
        'import { button } from "virtual:styles";\nexport const App = () => <div css={button} />;',
      "src/tokens.json": JSON.stringify({ color: "red" })
    });

    const tokens = join(root, "src/tokens.json");
    const virtualId = "\0virtual:styles";
    const provider: Plugin = {
      name: "virtual-style-provider",

      resolveId(id) {
        if (id === "virtual:styles") return virtualId;
      },

      async load(id) {
        if (id !== virtualId) return;

        this.addWatchFile(tokens);

        const { color } = JSON.parse(await readFile(tokens, "utf8")) as {
          color: string;
        };

        return `export const button = { color: ${JSON.stringify(this.environment.name === "ssr" ? "purple" : color)} };`;
      }
    };

    const server = await createFixtureServer(root, [
      provider,
      minchoVitePlugin({ jsxCssProp: true })
    ]);

    const client = server.environments.client!;
    const ssr = server.environments.ssr!;

    expect((await readCssPropOutput(client)).css).toContain("color: red;");
    expect((await readCssPropOutput(ssr)).css).toContain("color: purple;");
    expect((await readCssPropOutput(client)).css).toContain("color: red;");

    await writeFile(tokens, JSON.stringify({ color: "blue" }));
    server.watcher.emit("change", tokens);
    await vi.waitFor(
      async () => {
        const next = await readCssPropOutput(client);

        expect(next.css).toContain("color: blue;");
        expect(next.css).not.toContain("color: red;");
      },
      { timeout: 5_000 }
    );
  });

  it("does not reenter the owner's static evaluation from a virtual transform", async () => {
    const source =
      'import { button } from "virtual:styles";\nexport const App = () => <div css={button} />;';

    const root = await createFixture({ "src/entry.tsx": source });
    let nestedTransforms = 0;
    const provider: Plugin = {
      name: "owner-reentrant-provider",

      resolveId(id) {
        if (id === "virtual:styles") return "\0virtual:styles";
      },

      load(id) {
        if (id === "\0virtual:styles")
          return 'export const button = { color: "green" };';
      },

      async transform(_code, id) {
        if (id !== "\0virtual:styles") return;

        nestedTransforms += 1;

        const nested =
          await server.environments.client!.pluginContainer.transform(
            source,
            join(root, "src/entry.tsx")
          );

        expect(nested.code).not.toContain("extracted_");
      }
    };

    const server = await createFixtureServer(root, [
      provider,
      minchoVitePlugin({ jsxCssProp: true })
    ]);

    expect(
      (await readCssPropOutput(server.environments.client!)).css
    ).toContain("color: green;");
    expect(nestedTransforms).toBeGreaterThan(0);
  });
});

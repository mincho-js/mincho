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
  watch = false
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
    optimizeDeps: { noDiscovery: true, include: [] },
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
        /\/extracted_[^/]+\.css\.ts$/.test(module.id ?? "")
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

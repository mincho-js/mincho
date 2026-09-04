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

async function createFixtureServer(root: string, plugins: Plugin[]) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins
  });

  servers.push(server);

  return server;
}

async function readCssPropOutput(environment: DevEnvironment) {
  const result = await environment.transformRequest("/src/entry.tsx");
  const owner = await environment.moduleGraph.getModuleByUrl("/src/entry.tsx");
  const sidecar = [...(owner?.importedModules ?? [])].find((module) =>
    /\/extracted_[^/]+\.css\.ts$/.test(module.id ?? "")
  );
  if (!sidecar) throw new Error("Expected the owner to import extracted CSS");

  await environment.transformRequest(sidecar.url);

  const virtualCss = [...sidecar.importedModules].find((module) =>
    module.id?.startsWith("\0mincho-virtual-css:")
  );
  if (!virtualCss?.id)
    throw new Error("Expected the sidecar to import virtual CSS");

  const loaded = await environment.pluginContainer.load(virtualCss.id);

  return {
    code: result?.code,
    css: typeof loaded === "string" ? loaded : loaded?.code
  };
}

describe("mincho with the Vite runtime", () => {
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

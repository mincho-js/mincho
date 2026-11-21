import { createHash } from "node:crypto";
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
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  it.each(["client", "ssr"] as const)(
    "validates the actual PostCSS result of origin-free dev CSS (%s)",
    async (environmentName) => {
      const root = await createFixture({
        "src/entry.ts":
          'import { css } from "@mincho-js/css"; export const cls = css({color:"red"});'
      });
      const integration = await import("@mincho-js/integration");
      const compile = vi.spyOn(integration, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: [],
        cssScopeOrigins: []
      } as Awaited<ReturnType<typeof integration.compile>>);
      let request: string | undefined;
      let stylesheet = ".probe { color: red; }";
      const registry = vi
        .spyOn(integration, "processDefineRulesPresetRegistryFile")
        .mockImplementation(async ({ serializeVirtualCssPath }) => {
          const cssImport = await serializeVirtualCssPath!({
            fileName: "logical.css.ts",
            fileScope: { filePath: "logical.css.ts" },
            source: stylesheet
          });
          request = /import "([^"]+)";/.exec(cssImport)?.[1];
          return {
            source: cssImport,
            ancestorStyleSpecifiers: [],
            registrySession: {
              instances: [],
              nextRegistrationIndex: 0,
              nextRegistrationIndexByFileScope: {}
            }
          };
        });
      onTestFinished(() => {
        compile.mockRestore();
        registry.mockRestore();
      });
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, watch: null },
        plugins: [minchoVitePlugin()],
        css: {
          postcss: {
            plugins: [
              {
                postcssPlugin: "dev-processed-css-probe",
                OnceExit(css) {
                  css.walkDecls("color", (decl) => {
                    if (decl.value === "red") decl.value = "purple";
                    else if (decl.value === "blue")
                      decl.cloneAfter({
                        prop: "background-image",
                        value: 'url("./local-image.svg")'
                      });
                  });
                }
              }
            ]
          }
        }
      });
      servers.push(server);
      const environment = server.environments[environmentName]!;
      await readCssPropOutput(environment, "/src/entry.ts");
      expect(request).toBeDefined();
      await server.listen();
      const base = server.resolvedUrls!.local[0];
      const inline = request + "?url&inline=1";
      const url =
        environmentName === "client"
          ? `/@id/__x00__${request}?direct`
          : (await server.ssrLoadModule(request + "?url")).default;
      const getCss = () =>
        fetch(new URL(url, base), { headers: { Accept: "text/css" } });
      const warmCss = await getCss();
      expect(warmCss.status).toBe(200);
      const prepared = await warmCss.text();
      expect(prepared).toContain("color: purple;");
      expect(await (await getCss()).text()).toBe(prepared);
      if (environmentName === "client") {
        const wrapped = await environment.transformRequest(request + "?import");
        expect(wrapped?.code).toContain("__vite__css");
        expect(wrapped?.code).toContain("color: purple;");
      } else {
        const value = (await server.ssrLoadModule(inline)).default;
        expect(
          Buffer.from(value.split(",")[1], "base64").toString("utf8")
        ).toBe(prepared);
      }

      stylesheet = ".probe { color: blue; }";
      const owner =
        (await environment.moduleGraph.getModuleByUrl("/src/entry.ts"))!;
      const sidecar = [...owner.importedModules].find((module) =>
        module.id?.startsWith("\0mincho-extracted-css:")
      )!;
      environment.moduleGraph.invalidateModule(sidecar);
      await environment.transformRequest(sidecar.url);
      const failed = await getCss();
      expect(failed.status).toBe(500);
      expect(await failed.text()).toMatch(
        /processed an origin-free stylesheet.*physical origin/i
      );
      if (environmentName === "client") {
        await expect(
          environment.transformRequest(request + "?import")
        ).rejects.toThrow(
          /processed an origin-free stylesheet.*physical origin/i
        );
      } else {
        await expect(server.ssrLoadModule(inline)).rejects.toThrow(
          /processed an origin-free stylesheet.*physical origin/i
        );
      }

      stylesheet = ".probe { color: green; }";
      environment.moduleGraph.invalidateModule(sidecar);
      await environment.transformRequest(sidecar.url);
      const recovered = await getCss();
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("color: green;");
    }
  );

  it.each(["ssr", "rsc", "rsc-attributed"] as const)(
    "serves an origin-free stylesheet from its publishing %s environment",
    async (publisherName) => {
      const root = await createFixture({
        "src/entry.ts":
          'import { css } from "@mincho-js/css"; export const cls = css({color:"red"});'
      });
      const integration = await import("@mincho-js/integration");
      const compileSpy = vi.spyOn(integration, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: [],
        cssScopeOrigins: []
      } as Awaited<ReturnType<typeof integration.compile>>);
      let request: string | undefined;
      let stylesheet = ".probe { color: red; }";
      const registrySpy = vi
        .spyOn(integration, "processDefineRulesPresetRegistryFile")
        .mockImplementation(async ({ serializeVirtualCssPath }) => {
          const cssImport = await serializeVirtualCssPath!({
            fileName: "logical.css.ts",
            fileScope: { filePath: "logical.css.ts" },
            ...(publisherName === "rsc-attributed"
              ? { origin: normalizePath(join(root, "src/entry.ts")) }
              : {}),
            source: stylesheet
          });
          request = cssImport.match(/import "([^"]+)";/)?.[1];
          return {
            source: cssImport,
            ancestorStyleSpecifiers: [],
            registrySession: {
              instances: [],
              nextRegistrationIndex: 0,
              nextRegistrationIndexByFileScope: {}
            }
          };
        });

      onTestFinished(() => {
        compileSpy.mockRestore();
        registrySpy.mockRestore();
      });
      const server = await createServer({
        root,
        base: "/site/",
        configFile: false,
        logLevel: "silent",
        server: {
          host: "127.0.0.1",
          port: 0,
          watch: null,
          headers: {
            "X-Css-Probe": "configured",
            "CONTENT-TYPE": "text/plain",
            "cache-control": "public"
          }
        },
        ...(publisherName !== "ssr"
          ? { environments: { rsc: { consumer: "server" } } }
          : {}),
        plugins: [minchoVitePlugin()],
        css: {
          postcss: {
            plugins: [
              {
                postcssPlugin: "origin-free-test-color",
                Declaration(decl: { prop: string; value: string }) {
                  if (decl.prop === "color" && decl.value === "red")
                    decl.value = "purple";
                  else if (decl.prop === "color" && decl.value === "blue")
                    decl.value = "green";
                }
              }
            ]
          }
        }
      });
      servers.push(server);
      await server.listen();
      const base = server.resolvedUrls!.local[0];
      const getCss = (path: string, method = "GET") =>
        fetch(new URL(path, base), { method, headers: { Accept: "text/css" } });

      const ssr = server.environments[publisherName === "ssr" ? "ssr" : "rsc"]!;
      const client = server.environments.client!;
      await readCssPropOutput(ssr, "/src/entry.ts");
      expect(request).toBeDefined();
      if (publisherName !== "ssr") {
        const rawRequest = request + "?raw";
        expect((await ssr.transformRequest(rawRequest))?.code).toContain(
          "color: red;"
        );
        stylesheet = ".probe { color: blue; }";
        const owner = (await ssr.moduleGraph.getModuleByUrl("/src/entry.ts"))!;
        const sidecar = [...owner.importedModules].find((module) =>
          module.id?.startsWith("\0mincho-extracted-css:")
        )!;
        ssr.moduleGraph.invalidateModule(sidecar);
        await ssr.transformRequest(sidecar.url);
        expect((await ssr.transformRequest(rawRequest))?.code).toContain(
          "color: blue;"
        );
        return;
      }
      const url = (await server.ssrLoadModule(request + "?url")).default;
      expect(url).toMatch(/^\/site\/@mincho\/css\//);
      const bytes = await getCss(url);
      expect(bytes.status).toBe(200);
      expect(bytes.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(bytes.headers.get("cache-control")).toBe("no-store");
      expect(bytes.headers.get("x-css-probe")).toBe("configured");
      const preparedCss = await bytes.text();
      expect(preparedCss).toContain("color: purple;");
      const head = await getCss(url, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers.get("x-css-probe")).toBe("configured");
      expect(head.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(head.headers.get("cache-control")).toBe("no-store");
      expect(await head.text()).toBe("");
      const encoded = (await server.ssrLoadModule(request + "?url&inline"))
        .default;
      expect(encoded).toMatch(/^data:text\/css;charset=utf-8;base64,/);
      expect(
        Buffer.from(encoded.split(",")[1], "base64").toString("utf8")
      ).toBe(preparedCss);
      expect((await server.ssrLoadModule(request + "?raw")).default).toBe(
        stylesheet
      );

      const clientPath = `/site/@id/__x00__${request}?direct`;
      const clientCold = await getCss(clientPath);
      expect(clientCold.status).toBe(404);
      await clientCold.text();
      const absent = await getCss(url.replace(/[a-f0-9]{64}/, "0".repeat(64)));
      expect(absent.status).toBe(404);
      await absent.text();

      // Same source + scope tuple, but different output in the client environment.
      // The newly warmed client must not alter the original SSR URL.
      stylesheet = ".probe { color: blue; }";
      await readCssPropOutput(client, "/src/entry.ts");
      const clientModule = await client.pluginContainer.resolveId(
        request + "?url"
      );
      const clientValue = await client.pluginContainer.load(clientModule!.id);
      const clientCode =
        typeof clientValue === "string" ? clientValue : clientValue?.code;
      expect(clientCode).toBe(`export default ${JSON.stringify(clientPath)};`);
      const clientPrepared = await (await getCss(clientPath)).text();
      expect(clientPrepared).toContain("color: green;");
      const clientInline = await client.pluginContainer.resolveId(
        request + "?url&inline"
      );
      const inlineValue = await client.pluginContainer.load(clientInline!.id);
      const inlineCode =
        typeof inlineValue === "string" ? inlineValue : inlineValue?.code;
      const clientEncoded = inlineCode?.match(
        /data:text\/css;charset=utf-8;base64,([^"]+)/
      )?.[1];
      expect(clientEncoded).toBeDefined();
      expect(Buffer.from(clientEncoded!, "base64").toString("utf8")).toBe(
        clientPrepared
      );
      expect(await (await getCss(url)).text()).toContain("color: purple;");

      await ssr.pluginContainer.transform(
        "export {};",
        normalizePath(join(root, "src/entry.ts"))
      );
      const retired = await getCss(url);
      expect(retired.status).toBe(404);
      await retired.text();
      expect(await (await getCss(clientPath)).text()).toBe(clientPrepared);
    }
  );

  it.each([
    ["client", true],
    ["client", false],
    ["ssr", true],
    ["ssr", false]
  ] as const)(
    "recovers package-scope watches after invalid JSON (%s, hmr: %s)",
    async (environmentName, hmr) => {
      const root = await createFixture({
        "package.json": '{"name":"scope-parent"}',
        "src/package.json": '{"name":"scope-first"}',
        "src/entry.tsx": 'export const App=()=> <div css={{color:"red"}}/>;'
      });
      const manifest = normalizePath(join(root, "src/package.json"));
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      let changes = 0;
      const server = await createFixtureServer(
        root,
        [
          minchoVitePlugin({ jsxCssProp: true }),
          {
            name: "observe-package-recovery",
            perEnvironmentWatchChangeDuringDev: true,
            config() {
              return { server: { hmr } };
            },
            configureServer(server) {
              server.watcher.once("ready", resolveReady);
            },
            watchChange(id) {
              if (id === manifest && this.environment.name === environmentName)
                changes++;
            }
          }
        ],
        true
      );
      await ready;
      const environment = server.environments[environmentName]!;
      const write = async (contents: string) => {
        const before = changes;
        await writeFile(manifest, contents);
        await vi.waitFor(() => expect(changes).toBeGreaterThan(before), {
          timeout: 5000
        });
      };
      const assertPhysicalCssProducer = async (packageName: string) => {
        const owner =
          await environment.moduleGraph.getModuleByUrl("/src/entry.tsx");
        const sidecar = [...(owner?.importedModules ?? [])].find((module) =>
          module.id?.startsWith("\0mincho-extracted-css:")
        );
        const origin = normalizePath(join(root, "src/entry.tsx"));
        const identity = createHash("sha256")
          .update(JSON.stringify([packageName, "entry.tsx", origin]))
          .digest("hex");
        const expected = `${origin}.mincho-scope-${identity}.vanilla.css`;
        expect(
          [...(sidecar?.importedModules ?? [])].map((module) => module.id)
        ).toContain(expected);
        return expected;
      };
      const initial = await readCssPropOutput(environment);
      const initialCssId = await assertPhysicalCssProducer("scope-first");
      expect(initial.css).toContain("color: red;");
      expect(initial.code).not.toContain("/package.json");
      await write('{"name":');
      const error = await readCssPropOutput(environment).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(error).toBeDefined();
      await write('{"name":"scope-recovered"}');
      const recovered = await readCssPropOutput(environment);
      expect(recovered.css).toContain("color: red;");
      expect(recovered.css).not.toBe(initial.css);
      expect(await assertPhysicalCssProducer("scope-recovered")).not.toBe(
        initialCssId
      );
      expect(recovered.code).not.toContain("/package.json");
      await write('{"name":"scope-first"}');
      expect((await readCssPropOutput(environment)).css).toBe(initial.css);
      expect(await assertPhysicalCssProducer("scope-first")).toBe(initialCssId);
    }
  );

  it.each(["client", "ssr"])(
    "watches package boundary creation, edits and deletion without runtime imports (%s)",
    async (environment) => {
      const root = await createFixture({
        "package.json": '{"name":"scope-parent"}',
        "src/entry.tsx": [
          'import metadata from "../package.json";',
          "export const packageName = metadata.name;",
          'export const App = () => <div css={{ color: "red" }} />;'
        ].join("\n")
      });
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      let completedUpdates = 0;
      const server = await createFixtureServer(
        root,
        [
          minchoVitePlugin({ jsxCssProp: true }),
          {
            name: "observe-package-scope-updates",
            configureServer(server) {
              server.watcher.once("ready", resolveReady);
            },
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
            }
          }
        ],
        true
      );
      await ready;
      const client = server.environments[environment]!;
      const manifest = normalizePath(join(root, "src/package.json"));
      const read = async () => {
        const output = await readCssPropOutput(client);
        expect(output.css).toContain("color: red;");
        // A real source import still belongs to Vite's executable graph.
        expect(output.code).toContain("/package.json");
        const owner = await client.moduleGraph.getModuleByUrl("/src/entry.tsx");
        const sidecar = [...owner!.importedModules].find((module) =>
          module.id?.startsWith("\0mincho-extracted-css:")
        )!;
        expect(
          [...sidecar.importedModules].map((module) => module.id)
        ).not.toContain(manifest);
        return output.css;
      };
      const initial = await read();
      const change = async (name?: string) => {
        const before = completedUpdates;
        if (name) await writeFile(manifest, JSON.stringify({ name }));
        else await rm(manifest);
        await vi.waitFor(
          () => expect(completedUpdates).toBeGreaterThan(before),
          {
            timeout: 5_000
          }
        );
        return read();
      };
      const added = await change("scope-added");
      expect(added).not.toBe(initial);
      const edited = await change("scope-edited");
      expect(edited).not.toBe(added);
      expect(await change()).toBe(initial);
    }
  );

  it.each([
    ["physical", true, false],
    ["prefixed", true, false],
    ["prefixed", false, false],
    ["prefixed", false, true]
  ] as const)(
    "serves cached generated CSS through URL imports in development and build (%s, embeds assets: %s, asset suffix: %s)",
    async (requestForm, embedsAssets, assetSuffix) => {
      const root = await createFixture({
        "src/entry.ts":
          'export { className, stylesheet, inlineStylesheet } from "./styles";',
        "src/styles.ts": `import { css } from "@mincho-js/css"; export const className = css({ color: "red", ${assetSuffix ? 'filter: "url(#shadow)", ' : ""}backgroundImage: "url(./image.svg${assetSuffix ? "?no-inline#mark" : ""})" });`,
        "src/image.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
      });
      let exposeInline = true;
      let retiringSsr = false;
      let stylesheetRequest: string | undefined;
      const exposeUrl: Plugin = {
        name: "expose-generated-stylesheet-url",
        enforce: "post",
        transform(code, id) {
          const source = code.match(
            /import\s*["']([^"']+\.vanilla\.css)["']/
          )?.[1];
          if (source) {
            const request =
              requestForm === "physical"
                ? source.replace(/^mincho-virtual-css:/, "")
                : source;
            stylesheetRequest = request;
            return `${code}\nexport { default as stylesheet } from ${JSON.stringify(`${request}?url`)};${exposeInline ? `\nexport { default as inlineStylesheet } from ${JSON.stringify(`${request}?url&inline`)};` : "\nexport const inlineStylesheet = undefined;"}`;
          }
          if (!id.endsWith("/styles.ts")) return;
          const sidecar = code.match(
            /["']([^"']*extracted_[^"']+\.css\.ts)["']/
          )?.[1];
          if (!sidecar && retiringSsr) return;
          if (!sidecar)
            throw new Error(
              `Expected generated CSS before requesting its URL: ${code}`
            );
          return `${code}\nexport { stylesheet, inlineStylesheet } from ${JSON.stringify(sidecar)};`;
        }
      };
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, watch: null },
        plugins: [
          minchoVitePlugin(),
          exposeUrl,
          {
            name: "inline-asset-limit",
            config: () => ({
              build: { assetsInlineLimit: embedsAssets ? 4096 : 0 }
            })
          }
        ]
      });
      servers.push(server);
      await server.listen();
      const base = server.resolvedUrls!.local[0];
      const readHttpCss = async (stylesheet: string) => {
        expect(stylesheet).toMatch(
          /^\/@mincho\/css\/[^/]+\/a-[a-f0-9]{64}\.vanilla\.css$/
        );
        const response = await fetch(new URL(stylesheet, base), {
          headers: { Accept: "text/css" }
        });
        expect(response.status).toBe(200);
        return response.text();
      };
      if (!embedsAssets) {
        await expect(server.ssrLoadModule("/src/entry.ts")).rejects.toThrow(
          /base-dependent CSS resource.*Use \?url/
        );
        expect(stylesheetRequest).toBeDefined();
        const plain = await server.ssrLoadModule(`${stylesheetRequest}?url`);
        const ssrCss = await readHttpCss(plain.default);
        const asset = assetSuffix
          ? "/src/image.svg?no-inline#mark"
          : "/src/image.svg";
        expect(ssrCss).toContain(asset);
        if (assetSuffix) {
          expect(ssrCss).toMatch(/url\(["']?#shadow["']?\)/);
          const image = await fetch(new URL(asset, base));
          expect(image.status).toBe(200);
          expect(await image.text()).toContain('d="M0 0"');
        }
        exposeInline = false;
        await readCssPropOutput(server.environments.client!, "/src/styles.ts");
        exposeInline = true;
        await expect(
          build({
            root,
            configFile: false,
            logLevel: "silent",
            plugins: [minchoVitePlugin(), exposeUrl],
            build: {
              write: false,
              assetsInlineLimit: 0,
              rollupOptions: {
                input: join(root, "src/entry.ts"),
                preserveEntrySignatures: "strict"
              }
            }
          })
        ).rejects.toThrow(/base-dependent CSS resource.*Use \?url/);
        return;
      }
      const runtime = await server.ssrLoadModule("/src/entry.ts");
      const ssrCss = await readHttpCss(runtime.stylesheet);
      expect(ssrCss).toContain(runtime.className);
      expect(ssrCss).toContain("data:image/svg+xml,");
      expect(runtime.inlineStylesheet).toMatch(
        /^data:text\/css;charset=utf-8,/
      );
      const inlineCss = decodeURIComponent(
        runtime.inlineStylesheet.split(",")[1]
      );
      expect(inlineCss).toContain(runtime.className);
      expect(inlineCss).toContain("data:image/svg+xml,");
      expect(inlineCss).toContain("M0%200");
      const client = server.environments.client!;
      await readCssPropOutput(client, "/src/styles.ts");
      const clientUrlModule = await client.pluginContainer.resolveId(
        `${stylesheetRequest}?url`
      );
      const clientUrlResult = await client.pluginContainer.load(
        clientUrlModule!.id
      );
      const clientUrlCode =
        typeof clientUrlResult === "string"
          ? clientUrlResult
          : clientUrlResult?.code;
      const clientUrl = JSON.parse(
        clientUrlCode!.match(/export default ("[^"]+");?/)![1]
      ) as string;
      expect(clientUrl).not.toContain("/@mincho/css/");
      const resolved = await client.pluginContainer.resolveId(clientUrl);
      const cached = await client.pluginContainer.load(resolved!.id);
      const css = typeof cached === "string" ? cached : cached?.code;
      expect(css).toContain(runtime.className);
      expect(css).toContain("color: red;");
      const stylesheet = await client.transformRequest(`${clientUrl}?direct`);
      expect(stylesheet?.code).toContain(runtime.className);
      expect(stylesheet?.code).toContain("color: red;");
      expect(stylesheet?.code).toContain("data:image/svg+xml,");
      retiringSsr = true;
      await server.environments.ssr!.pluginContainer.transform(
        "export {};",
        normalizePath(join(root, "src/styles.ts"))
      );
      retiringSsr = false;
      const expired = await fetch(new URL(runtime.stylesheet, base), {
        headers: { Accept: "text/css" }
      });
      expect(expired.status).toBe(404);
      await expired.text();
      expect(
        (await client.transformRequest(`${clientUrl}?direct`))?.code
      ).toContain(runtime.className);

      const result = await build({
        root,
        configFile: false,
        logLevel: "silent",
        base: "/assets-base/",
        plugins: [minchoVitePlugin(), exposeUrl],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          rollupOptions: {
            input: join(root, "src/entry.ts"),
            preserveEntrySignatures: "strict"
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const js = outputs.find((item) => item.type === "chunk" && item.isEntry);
      if (js?.type !== "chunk") throw new Error("Expected Vite build entry");
      const encodedCss = js.code.match(
        /data:text\/css;charset=utf-8,([^"\n]+)/
      )?.[1];
      expect(encodedCss).toBeDefined();
      const builtInlineCss = decodeURIComponent(encodedCss!);
      expect(builtInlineCss).toContain("color: red;");
      expect(builtInlineCss).toContain("data:image/svg+xml,");
      expect(builtInlineCss).toContain("M0%200");
      expect(
        outputs.some(
          (item) =>
            item.type === "asset" &&
            item.fileName.endsWith(".css") &&
            String(item.source).includes("color: red") &&
            js?.type === "chunk" &&
            js.code.includes(`/assets-base/${item.fileName}`)
        )
      ).toBe(true);
    }
  );

  it.each([
    "palette",
    "attributed palette",
    "republication",
    "HTTP republication",
    "embedded SVG",
    "explicit inline SVG",
    "network path",
    "percent basename"
  ] as const)(
    "preserves generated stylesheet delivery and dependencies (%s)",
    async (kind) => {
      const changesPalette =
        kind === "palette" || kind === "attributed palette";
      const republishes =
        kind === "republication" || kind === "HTTP republication";
      let source =
        kind === "embedded SVG" || kind === "percent basename"
          ? '.probe { color: red; background-image: url("./image.svg"); }'
          : kind === "explicit inline SVG"
            ? '.probe { color: red; background-image: url("./image.svg?inline"); }'
            : kind === "network path"
              ? '.probe { background-image: url("//localhost:43210/image.svg"); }'
              : ".probe { color: red; }";
      const producer =
        kind === "percent basename" ? "100%.mjs" : "producer.mjs";
      const root = await createFixture({
        "src/entry.ts":
          'import { css } from "@mincho-js/css"; export const cls = css({color:"red"});',
        [`src/${producer}`]: "export {};",
        "src/palette.txt": "red",
        "src/image.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><path fill="orange"/></svg>'
      });
      const palette = normalizePath(join(root, "src/palette.txt"));
      const image = normalizePath(join(root, "src/image.svg"));
      const integration = await import("@mincho-js/integration");
      const compile = vi.spyOn(integration, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: [],
        cssScopeOrigins: []
      } as Awaited<ReturnType<typeof integration.compile>>);
      let request: string | undefined;
      const registry = vi
        .spyOn(integration, "processDefineRulesPresetRegistryFile")
        .mockImplementation(async ({ serializeVirtualCssPath }) => {
          const cssImport = await serializeVirtualCssPath!({
            fileName: "logical.css.ts",
            fileScope: { filePath: "logical.css.ts" },
            ...(kind === "palette"
              ? {}
              : { origin: normalizePath(join(root, "src", producer)) }),
            source
          });
          request = /import ("[^"]+");/.exec(cssImport)?.[1];
          request =
            request === undefined ? undefined : (JSON.parse(request) as string);
          return {
            source: cssImport,
            ancestorStyleSpecifiers: [],
            registrySession: {
              instances: [],
              nextRegistrationIndex: 0,
              nextRegistrationIndexByFileScope: {}
            }
          };
        });
      onTestFinished(() => {
        compile.mockRestore();
        registry.mockRestore();
      });
      let republish: (() => Promise<void>) | undefined;
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, watch: null },
        plugins: [minchoVitePlugin()],
        ...(changesPalette || republishes
          ? {
              css: {
                postcss: {
                  plugins: [
                    {
                      postcssPlugin: "observed-palette",
                      async Once(css, { result }) {
                        if (!changesPalette) {
                          const publish = republish;
                          republish = undefined;
                          await publish?.();
                          return;
                        }
                        const color = await readFile(palette, "utf8");
                        result.messages.push({
                          type: "dependency",
                          plugin: "observed-palette",
                          file: palette
                        });
                        css.walkDecls("color", (declaration) => {
                          declaration.value = color;
                        });
                      }
                    }
                  ]
                }
              }
            }
          : {})
      });
      servers.push(server);
      await server.listen();
      const origin = server.resolvedUrls!.local[0];
      const ssr = server.environments.ssr!;
      const client = server.environments.client!;
      const republishSidecar = async (publisher: typeof client) => {
        const owner =
          (await publisher.moduleGraph.getModuleByUrl("/src/entry.ts"))!;
        const sidecar = [...owner.importedModules].find((module) =>
          module.id?.startsWith("\0mincho-extracted-css:")
        )!;
        publisher.moduleGraph.invalidateModule(sidecar);
        await publisher.transformRequest(sidecar.url);
      };
      if (republishes) {
        const http = kind === "HTTP republication";
        const publisher = http ? ssr : client;
        await readCssPropOutput(publisher, "/src/entry.ts");
        const url =
          http && (await server.ssrLoadModule(request + "?url")).default;
        const read = async (attempt: number) => {
          if (http) {
            const response = await fetch(new URL(url, origin), {
              headers: { Accept: "text/css" }
            });
            const css = await response.text();
            if (!response.ok) throw new Error(css);
            return css;
          }
          const result = await client.transformRequest(
            request + "?url&inline=" + attempt
          );
          return decodeURIComponent(result!.code);
        };
        republish = () => republishSidecar(publisher);
        expect(await read(1)).toContain("color: red");
        expect(republish).toBeUndefined();
        republish = async () => {
          source = ".probe { color: blue; }";
          await republishSidecar(publisher);
        };
        await expect(read(2)).rejects.toThrow("changed during host processing");
        expect(await read(3)).toContain("color: blue");
        expect(
          (await publisher.transformRequest(request + "?raw"))?.code
        ).toContain(JSON.stringify(source));
        return;
      }
      if (kind === "network path") {
        await readCssPropOutput(ssr, "/src/entry.ts");
        const plain = (await server.ssrLoadModule(request + "?url"))
          .default as string;
        const css = await fetch(new URL(plain, origin), {
          headers: { Accept: "text/css" }
        });
        expect(css.status).toBe(200);
        expect(await css.text()).toContain("//localhost:43210/image.svg");
        await expect(
          server.ssrLoadModule(request + "?url&inline")
        ).rejects.toThrow(/base-dependent CSS resource/);
        return;
      }
      if (kind === "percent basename") {
        await readCssPropOutput(client, "/src/entry.ts");
        const owner =
          (await client.moduleGraph.getModuleByUrl("/src/entry.ts"))!;
        const sidecar = [...owner.importedModules].find((dependency) =>
          dependency.id?.startsWith("\0mincho-extracted-css:")
        )!;
        const transformed = await client.transformRequest(sidecar.url);
        const href = transformed?.code.match(
          /import\s*["']([^"']+\.vanilla\.css(?:\?[^"']*)?)["']/
        )?.[1];
        expect(href).toBeDefined();
        const css = await fetch(new URL(href!, origin), {
          headers: { Accept: "text/css" }
        });
        expect(css.status).toBe(200);
        expect(await css.text()).toContain("data:image/svg+xml,");
        // The basename changes, but Vite still resolves the SVG from /src.
        expect(href).toMatch(
          /^\/src\/mincho-producer-[a-f0-9]{64}\.mincho-scope-/
        );
        expect(href).not.toContain("100%");
        return;
      }
      await readCssPropOutput(ssr, "/src/entry.ts");
      await readCssPropOutput(client, "/src/entry.ts");
      const wrapper = request + "?url&inline";
      const raw = request + "?raw";
      const fromUri = (uri: string) =>
        uri.includes(";base64,")
          ? Buffer.from(uri.split(",")[1], "base64").toString("utf8")
          : decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
      const ssrCss = async () =>
        fromUri((await server.ssrLoadModule(wrapper)).default);
      const clientCss = async () => {
        const code = (await client.transformRequest(wrapper))?.code;
        const data = code?.match(/export default ("data:[^\n]+?");?$/m)?.[1];
        if (!data) throw new Error(`Expected inline URL wrapper: ${code}`);
        return fromUri(JSON.parse(data));
      };
      const from = changesPalette ? "color: red" : "orange";
      const to = changesPalette ? "color: blue" : "purple";
      expect(await ssrCss()).toContain(from);
      expect(await clientCss()).toContain(from);
      expect((await server.ssrLoadModule(raw)).default).toBe(source);
      if (kind === "attributed palette") {
        await republishSidecar(ssr);
        await republishSidecar(client);
        expect(await ssrCss()).toContain(from);
        expect(await clientCss()).toContain(from);
      }
      const changed = changesPalette ? palette : image;
      await writeFile(
        changed,
        changesPalette
          ? "blue"
          : '<svg xmlns="http://www.w3.org/2000/svg"><path fill="purple"/></svg>'
      );
      server.watcher.emit("change", changed);
      await vi.waitFor(
        async () => {
          expect(await ssrCss()).toContain(to);
          expect(await clientCss()).toContain(to);
        },
        { timeout: 1800 }
      );
      expect((await server.ssrLoadModule(raw)).default).toBe(source);
      if (changesPalette) {
        const plain = (await server.ssrLoadModule(request + "?url"))
          .default as string;
        const response = await fetch(new URL(plain, origin), {
          headers: { Accept: "text/css" }
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(await ssrCss());
      }
    }
  );

  it("serves cached virtual CSS as a string module for raw requests", async () => {
    const root = await createFixture({
      "src/entry.tsx":
        'export const App = () => <div css={{ color: "red" }} />;'
    });
    const server = await createFixtureServer(root, [
      minchoVitePlugin({ jsxCssProp: true })
    ]);
    for (const environment of [
      server.environments.client!,
      server.environments.ssr!
    ]) {
      const output = await readCssPropOutput(environment);
      expect(output.css).toContain("color: red;");
      const owner =
        await environment.moduleGraph.getModuleByUrl("/src/entry.tsx");
      const sidecar = [...owner!.importedModules].find((module) =>
        module.id?.startsWith("\0mincho-extracted-css:")
      )!;
      const css = [...sidecar.importedModules].find((module) =>
        module.id?.endsWith(".vanilla.css")
      )!;
      for (const query of ["raw", "import&raw", "raw&inline"]) {
        const raw = await environment.transformRequest(`${css.url}?${query}`);
        if (environment.name === "client")
          expect(raw?.code).toContain("export default ");
        expect(raw?.code).toContain(JSON.stringify(output.css));
      }
      if (environment.name === "ssr") {
        const raw = await server.ssrLoadModule(`${css.url}?raw`);
        expect(raw.default).toBe(output.css);
      }
    }
  });

  it("serves retired CSS to already resolved loads without authorizing filesystem reads", async () => {
    const root = await createFixture({
      "src/entry.tsx":
        'export const App = () => <div css={{ color: "red" }} />;',
      "src/private.vanilla.css": ".private { color: blue; }"
    });
    const server = await createFixtureServer(root, [
      minchoVitePlugin({ jsxCssProp: true })
    ]);
    const client = server.environments.client!;
    expect((await readCssPropOutput(client)).css).toContain("color: red;");
    const owner = await client.moduleGraph.getModuleByUrl("/src/entry.tsx");
    const sidecar = [...owner!.importedModules].find((module) =>
      module.id?.startsWith("\0mincho-extracted-css:")
    )!;
    const css = [...sidecar.importedModules].find((module) =>
      module.id?.endsWith(".vanilla.css")
    )!;
    const privateId = `\0mincho-virtual-css:${join(root, "src/private.vanilla.css")}`;
    expect(await client.pluginContainer.load(privateId)).toBeNull();

    await client.pluginContainer.transform(
      "export const App = () => <div />;",
      owner!.id!
    );

    expect(await client.pluginContainer.load(css.id!)).toBe("");
    expect(await client.pluginContainer.load(`${css.id!}?raw`)).toBe(
      'export default "";'
    );
    expect(await client.pluginContainer.load(privateId)).toBeNull();
    expect(await client.pluginContainer.load(`${privateId}?raw`)).toBeNull();
  });

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

        async transform(code, id) {
          if (id === entry) {
            const result = await transformWithEsbuild(code, id, {
              define: { __MARKER__: '"after"' },
              sourcemap: true
            });

            return { ...result, map: JSON.stringify(result.map) };
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

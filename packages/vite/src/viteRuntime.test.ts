import { spawnSync } from "node:child_process";
import { types as t, type PluginObj } from "@babel/core";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  createViteClientIntrinsicObserver,
  loadViteTransformedModuleSource,
  matchesViteClientSource
} from "./staticCssEvalSourceProvider.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  build,
  createServer,
  normalizePath,
  transformWithEsbuild,
  type DevEnvironment,
  type InlineConfig,
  type Plugin,
  type ResolverObject,
  type Rollup,
  type ViteDevServer
} from "vite";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "./index.js";

it.each(["map from custom load", "string custom load"])(
  "reads the same SSR JavaScript after a %s",
  async (kind) => {
    const withMap = kind === "map from custom load";
    const source = 'export const shade = "original";';
    const root = await createFixture({ "src/shade.js": source });
    const file = normalizePath(join(root, "src/shade.js"));
    const expected = withMap ? "blue" : "red";
    const server = await createFixtureServer(root, [
      {
        name: "ordinary-ssr-load-map",
        load(id) {
          if (id !== file) return;
          if (!withMap) return source;
          return {
            code: source,
            map: {
              version: 3,
              names: [],
              mappings: "AAAA",
              sources: ["author-token.js"],
              sourcesContent: [source]
            }
          };
        },
        transform(code, id) {
          if (id !== file) return;
          const map = this.getCombinedSourcemap();
          const authored = map.sources.some((source) =>
            source.endsWith("author-token.js")
          );
          return {
            code: code.replace("original", authored ? "blue" : "red"),
            map: JSON.stringify(map)
          };
        }
      }
    ]);
    const ssr = server.environments.ssr!;
    expect((await server.ssrLoadModule("/src/shade.js")).shade).toBe(expected);
    const runtime = await ssr.transformRequest("/src/shade.js");
    const runtimeMap = runtime?.map;
    expect(
      !!runtimeMap &&
        "sources" in runtimeMap &&
        runtimeMap.sources.some((source) => source.endsWith("author-token.js"))
    ).toBe(withMap);

    // No mocked host: this runs the same Vite plugin load/transform callbacks
    // while preserving ESM for the compiler instead of SSR rewriting.
    const input = await loadViteTransformedModuleSource(
      file,
      {} as Parameters<typeof loadViteTransformedModuleSource>[1],
      ssr
    );
    expect(input?.source).toBe(`export const shade = "${expected}";`);
  }
);

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
  base = "/"
) {
  const server = await createServer({
    root,
    base,
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
    optimizeDeps: { noDiscovery: true },
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

const cjsInitializationSource =
  'const init=require("./init.cjs"); const {css}=require("@mincho-js/css"); const ref=require("./later.cjs"); exports.className=css({color:"red"}); exports.read=()=>[init.ready&&ref.ok,globalThis.__minchoRuntimeOrder];';
const cjsRuntimeDependentSource =
  'const m=require("./marker.cjs"); const {cx}=require("@mincho-js/css"); exports.ok=m.marker&&typeof cx==="function";';

async function commonJsInitializationFixture(
  reciprocal = false,
  dependencies = 0,
  edge?: "import" | "named" | "star" | "dynamic",
  relative:
    boolean | "alias" | "absolute-alias" | "other-absolute-alias" = false,
  includeFirstChild = false
) {
  const extra = Array.from(
    { length: dependencies },
    (_, index) => `extra${index}`
  );
  const laterSource =
    extra.map((name) => `const ${name}=require("./${name}.cjs"); `).join("") +
    cjsRuntimeDependentSource.replace(
      "exports.ok=m.marker",
      `exports.ok=${extra
        .map((name) => `${name}.ready`)
        .concat("m.marker")
        .join("&&")}`
    );
  const source = includeFirstChild
    ? cjsInitializationSource
        .replace(
          `const ref=require("./later.cjs");`,
          `const first=require("./first.cjs"); const ref=require("./later.cjs");`
        )
        .replace("init.ready&&ref.ok", "init.ready&&first.ok&&ref.ok")
    : cjsInitializationSource;
  const root = await createFixture({
    ...(includeFirstChild
      ? {
          "src/first.cjs": `const m=require("./marker.cjs"); exports.ok=m.marker;`
        }
      : {}),
    ...Object.fromEntries(
      extra.map((name) => [`src/${name}.cjs`, "exports.ready=true;"])
    ),
    "package.json": '{"type":"module"}',
    "src/main.cjs": source,
    "src/init.cjs": "globalThis.__minchoRuntimeOrder=[]; exports.ready=true;",
    "src/later.cjs": reciprocal
      ? 'const {css}=require("@mincho-js/css"); const back=require("./main.cjs"); exports.className=css({color:"blue"}); exports.ok=()=>typeof back.read==="function";'
      : edge
        ? 'const m=require("./marker.cjs"); exports.ok=m.marker;'
        : laterSource,
    "src/unrelated.mjs": "export const ready = true;",
    "src/marker.cjs":
      'globalThis.__minchoRuntimeOrder??=[]; globalThis.__minchoRuntimeOrder.push("observer"); exports.marker=true;',
    "src/mincho-compat.cjs":
      'const ve=require("@vanilla-extract/css"); globalThis.__minchoRuntimeOrder??=[]; globalThis.__minchoRuntimeOrder.push("css-package"); exports.css=ve.style; exports.cx=(...v)=>v.join(" ");'
  });
  const main = join(root, "src/main.cjs");
  const later = join(root, "src/later.cjs");
  const calls = new Map<string, number>();
  const observer: Plugin = {
    name: "ordinary-cjs-transform-count",
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@mincho-js\/css$/,
              replacement: join(root, "src/mincho-compat.cjs")
            },
            ...(relative === "alias"
              ? [
                  {
                    find: "css-runtime",
                    replacement: join(root, "src/mincho-compat.cjs")
                  }
                ]
              : []),
            ...(relative === "absolute-alias" ||
            relative === "other-absolute-alias"
              ? [
                  {
                    find: join(root, "src/runtime-alias.cjs"),
                    replacement: join(
                      root,
                      relative === "absolute-alias"
                        ? "src/mincho-compat.cjs"
                        : "src/unrelated.mjs"
                    )
                  }
                ]
              : [])
          ]
        }
      };
    },
    transform(_source, file) {
      const path = normalizePath(file);
      const label =
        path === main
          ? "main"
          : path === later
            ? "later"
            : path === join(root, "src/first.cjs")
              ? "first"
              : null;
      if (label === null) return;
      const key = `${this.environment.name}:${label}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
    }
  };
  const plugins = [observer, minchoVitePlugin()];
  if (edge) {
    plugins.push({
      name: "ordinary-static-module-edge",
      enforce: "post",
      transform(source, id) {
        if (normalizePath(id) !== later) return;
        const target = JSON.stringify(
          relative === "alias"
            ? "css-runtime"
            : relative === "absolute-alias" ||
                relative === "other-absolute-alias"
              ? join(root, "src/runtime-alias.cjs")
              : relative
                ? "./mincho-compat.cjs"
                : join(root, "src/mincho-compat.cjs")
        );
        const request =
          edge === "dynamic"
            ? `export const lazy = () => import(${target});`
            : edge === "named"
              ? `export { cx as exportedCx } from ${target};`
              : edge === "star"
                ? `export * from ${target};`
                : `import ${target};`;
        return { code: `${source}\n${request}`, map: null };
      }
    });
  }
  return { root, later, laterSource, main, calls, plugins, source };
}

it.each([
  ["ordinary", "/", 0],
  ["non-root base", "/demo/", 0],
  ["many eager dependencies", "/", 17]
] as const)(
  "retains first authored CommonJS initialization in cold Vite client and SSR: %s",
  async (_fixture, base, extra) => {
    const { root, later, laterSource, calls, plugins } =
      await commonJsInitializationFixture(false, extra);
    const server = await createFixtureServer(root, plugins, false, base);
    const environments = [
      server.environments.client!,
      server.environments.ssr!
    ];
    const expectOrder = async (environment: DevEnvironment, keep: boolean) => {
      const response = await environment.transformRequest("/src/main.cjs");
      const code = response?.code ?? "";
      const request = code.indexOf("/src/mincho-compat.cjs");
      expect(code.indexOf("/src/later.cjs")).toBeGreaterThanOrEqual(0);
      if (keep) {
        expect(request).toBeGreaterThanOrEqual(0);
        expect(request).toBeLessThan(code.indexOf("/src/later.cjs"));
      } else expect(request).toBe(-1);
      const map = response?.map;
      expect(map && "sourcesContent" in map && map.sourcesContent).toContain(
        cjsInitializationSource
      );
    };
    for (const environment of environments) {
      expect(
        await environment.moduleGraph.getModuleByUrl("/src/later.cjs")
      ).toBeUndefined();
      await expectOrder(environment, true);
    }
    const app = await server.ssrLoadModule("/src/main.cjs");
    expect(app.className).toEqual(expect.any(String));
    expect(app.read()).toEqual([true, ["css-package", "observer"]]);
    expect(calls.get("client:later")).toBe(1);
    expect(calls.get("ssr:later")).toBe(1);

    await writeFile(
      later,
      'const m=require("./marker.cjs"); exports.ok=m.marker;'
    );
    for (const environment of environments)
      environment.moduleGraph.onFileChange(later);
    for (const environment of environments)
      await expectOrder(environment, false);

    await writeFile(later, laterSource);
    for (const environment of environments)
      environment.moduleGraph.onFileChange(later);
    for (const environment of environments)
      await expectOrder(environment, true);
  }
);

it.each([
  ["import", false],
  ["named", false],
  ["star", false],
  ["dynamic", false],
  ["import", true],
  ["named", true],
  ["dynamic", true],
  ["import", "alias"],
  ["named", "alias"],
  ["dynamic", "alias"],
  ["import", "absolute-alias"],
  ["dynamic", "absolute-alias"],
  ["import", "other-absolute-alias"]
] as const)(
  "retains only an eager host module request in cold client and built SSR: %s (relative=%s)",
  async (edge, relative) => {
    const { root, main, calls, plugins } = await commonJsInitializationFixture(
      false,
      0,
      edge,
      relative
    );
    const server = await createFixtureServer(root, plugins);
    const client = server.environments.client!;
    const original = await client.transformRequest("/src/main.cjs");
    const code = original?.code ?? "";
    const before = code.indexOf("/src/mincho-compat.cjs");
    const child = code.indexOf("/src/later.cjs");
    expect(child).toBeGreaterThanOrEqual(0);
    const eager = edge !== "dynamic" && relative !== "other-absolute-alias";
    if (!eager) expect(before).toBe(-1);
    else {
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(child);
    }
    const map = original?.map;
    expect(map && "sourcesContent" in map && map.sourcesContent).toContain(
      cjsInitializationSource
    );
    expect(calls.get("client:later")).toBe(1);

    const out = join(root, "out");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins,
      build: {
        ssr: main,
        outDir: out,
        rollupOptions: { output: { entryFileNames: "app.mjs" } }
      }
    });
    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)});
         console.log(JSON.stringify({ className: app.className, read: app.read() }));`
      ],
      { encoding: "utf8" }
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual({
      className: expect.any(String),
      read: [true, eager ? ["css-package", "observer"] : ["observer"]]
    });
  }
);

it.each(["import", "dynamic"] as const)(
  "keeps each staged authored require only for its own live demand: %s",
  async (edge) => {
    const { root, main, source, calls, plugins } =
      await commonJsInitializationFixture(false, 0, edge);
    await writeFile(
      main,
      source
        .replace(
          'const ref=require("./later.cjs");',
          'const {style}=require("@vanilla-extract/css"); const ref=require("./later.cjs");'
        )
        .replace(
          "exports.read=",
          "exports.extra=style({padding:4}); exports.read="
        )
    );
    const server = await createFixtureServer(root, plugins);
    const client =
      await server.environments.client!.transformRequest("/src/main.cjs");
    const code = client?.code ?? "";
    const peer = code.indexOf("/src/later.cjs");
    const css = code.indexOf("/src/mincho-compat.cjs");
    expect(peer).toBeGreaterThanOrEqual(0);
    if (edge === "import") {
      expect(css).toBeGreaterThanOrEqual(0);
      expect(css).toBeLessThan(peer);
    } else expect(css).toBe(-1);
    expect(calls.get("client:later")).toBe(1);

    const out = join(root, "out");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins,
      build: {
        ssr: main,
        outDir: out,
        rollupOptions: { output: { entryFileNames: "app.mjs" } }
      }
    });
    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)});
       console.log(JSON.stringify({ style: app.className, extra: app.extra, read: app.read() }));`
      ],
      { encoding: "utf8" }
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual({
      style: expect.any(String),
      extra: expect.any(String),
      read: [
        true,
        edge === "import" ? ["css-package", "observer"] : ["observer"]
      ]
    });
    expect(calls.get("ssr:later")).toBe(1);
  }
);

it.each([false, true])(
  "keeps automatically configured CommonJS generator output and original demand (demand=%s)",
  async (demand) => {
    const { root, main, later, plugins, source } =
      await commonJsInitializationFixture();
    await writeFile(
      main,
      source + ` /* authored-marker */ exports.marker="before";`
    );
    if (!demand)
      await writeFile(
        later,
        `const m=require("./marker.cjs"); exports.ok=m.marker;`
      );
    await writeFile(
      join(root, "babel.config.cjs"),
      `let posts = 0, generated = 0;
       const owner = ${JSON.stringify(main)};
       const posted = new WeakSet();
       module.exports = { passPerPreset: true, presets: [() => ({
         plugins: [() => ({
           post(file) {
             if (file.opts.filename !== owner) return;
             if (++posts !== 1 || posted.has(file.ast))
               throw new Error("author post must run once for the owner");
             posted.add(file.ast);
           },
           generatorOverride(ast, options, input, generate) {
             const output = generate(ast, options, input);
             if (!posted.has(ast)) return output;
             if (posts !== 1 || ++generated !== 1)
               throw new Error("generate once on the actual posted owner AST");
             return { ...output, code: output.code.replace('"before"', '"later!"') };
           },
           visitor: {}
         })]
       })] };`
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const out = join(root, "out");
    try {
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins,
        build: {
          ssr: main,
          outDir: out,
          rollupOptions: { output: { entryFileNames: "app.mjs" } }
        }
      });
    } finally {
      cwd.mockRestore();
    }
    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)});
         console.log(JSON.stringify({ className: app.className, marker: app.marker, read: app.read() }));`
      ],
      { encoding: "utf8" }
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual({
      className: expect.any(String),
      marker: "later!",
      read: [true, demand ? ["css-package", "observer"] : ["observer"]]
    });
  }
);

it.each([
  ["unchanged", false],
  ["retargeted", false],
  ["retargeted", true],
  ["replaced", true],
  ["removed", false]
] as const)(
  "respects an authored %s CommonJS request after Babel post (generator=%s)",
  async (edit, configuredGenerator) => {
    const { root, main, later, plugins } =
      await commonJsInitializationFixture();
    await writeFile(
      later,
      `const m=require("./marker.cjs"); exports.ok=m.marker;`
    );
    await writeFile(
      join(root, "src/instrument.cjs"),
      `globalThis.__minchoRuntimeOrder.push("instrument"); exports.valid=true;`
    );
    const authored = new WeakSet<t.File>();
    const post = vi.fn();
    const generated = vi.fn();
    plugins.pop();
    plugins.push(
      minchoVitePlugin({
        babel: {
          plugins: [
            () => ({
              post(file: Parameters<NonNullable<PluginObj["post"]>>[0]) {
                if (file.opts.filename !== main) return;
                post();
                authored.add(file.ast);
                for (const statement of file.ast.program.body) {
                  if (!t.isVariableDeclaration(statement)) continue;
                  const index = statement.declarations.findIndex(
                    ({ init }) =>
                      t.isCallExpression(init) &&
                      t.isIdentifier(init.callee, { name: "require" }) &&
                      t.isStringLiteral(init.arguments[0], {
                        value: "@mincho-js/css"
                      })
                  );
                  if (index < 0) continue;
                  if (edit === "removed") {
                    statement.declarations.splice(index, 1);
                    if (!statement.declarations.length)
                      file.ast.program.body = file.ast.program.body.filter(
                        (node) => node !== statement
                      );
                  } else if (edit === "retargeted") {
                    const init = statement.declarations[index]!.init;
                    if (!t.isCallExpression(init))
                      throw new Error("Expected the original call");
                    const specifier = init.arguments[0];
                    if (!t.isStringLiteral(specifier))
                      throw new Error("Expected the original request");
                    specifier.value = "./instrument.cjs";
                  } else if (edit === "replaced") {
                    statement.declarations[index] = t.variableDeclarator(
                      t.identifier("instrumentation"),
                      t.callExpression(t.identifier("require"), [
                        t.stringLiteral("./instrument.cjs")
                      ])
                    );
                  }
                  return;
                }
                throw new Error("Expected the staged authored request in post");
              },
              ...(configuredGenerator
                ? {
                    generatorOverride(
                      ast: t.File,
                      options: unknown,
                      input: string,
                      generate: (
                        ast: t.File,
                        options: unknown,
                        input: string
                      ) => { code: string }
                    ) {
                      if (authored.has(ast)) generated();
                      return generate(ast, options, input);
                    }
                  }
                : {}),
              visitor: {}
            })
          ]
        }
      })
    );
    const out = join(root, "out");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins,
      build: {
        ssr: main,
        outDir: out,
        rollupOptions: { output: { entryFileNames: "app.mjs" } }
      }
    });
    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)});
         console.log(JSON.stringify({ className: app.className, read: app.read() }));`
      ],
      { encoding: "utf8" }
    );
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(JSON.parse(runtime.stdout)).toEqual({
      className: expect.any(String),
      read: [
        true,
        edit === "retargeted" || edit === "replaced"
          ? ["instrument", "observer"]
          : ["observer"]
      ]
    });
    expect(post).toHaveBeenCalledOnce();
    expect(generated).toHaveBeenCalledTimes(configuredGenerator ? 1 : 0);
  }
);

it("retains order when the second live CommonJS child proves eager runtime use", async () => {
  const { root, main, later, calls, plugins, source } =
    await commonJsInitializationFixture(false, 0, undefined, false, true);
  const server = await createFixtureServer(root, plugins);
  for (const name of ["client", "ssr"] as const) {
    const environment = server.environments[name]!;
    const response = await environment.transformRequest("/src/main.cjs");
    const code = response?.code ?? "";
    const target = code.indexOf("/src/mincho-compat.cjs");
    expect(target).toBeGreaterThanOrEqual(0);
    expect(target).toBeLessThan(code.indexOf("/src/first.cjs"));
    expect(code.indexOf("/src/first.cjs")).toBeLessThan(
      code.indexOf("/src/later.cjs")
    );
    const map = response?.map;
    expect(map && "sourcesContent" in map && map.sourcesContent).toContain(
      source
    );
    expect(calls.get(`${name}:first`)).toBe(1);
    expect(calls.get(`${name}:later`)).toBe(1);
  }
  const dev = await server.ssrLoadModule("/src/main.cjs");
  expect(dev.className).toEqual(expect.any(String));
  expect(dev.read()).toEqual([true, ["css-package", "observer"]]);

  const out = join(root, "out");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    build: {
      ssr: main,
      outDir: out,
      rollupOptions: { output: { entryFileNames: "app.mjs" } }
    }
  });
  const runtime = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)});
       console.log(JSON.stringify({ className: app.className, read: app.read() }));`
    ],
    { encoding: "utf8" }
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(JSON.parse(runtime.stdout)).toEqual({
    className: expect.any(String),
    read: [true, ["css-package", "observer"]]
  });
  expect(calls.get("ssr:first")).toBe(2);
  expect(calls.get("ssr:later")).toBe(2);

  await writeFile(later, "exports.ok=true;");
  for (const name of ["client", "ssr"] as const) {
    const environment = server.environments[name]!;
    environment.moduleGraph.onFileChange(later);
    const response = await environment.transformRequest("/src/main.cjs");
    expect(response?.code).toContain("/src/first.cjs");
    expect(response?.code).toContain("/src/later.cjs");
    expect(response?.code).not.toContain("/src/mincho-compat.cjs");
  }
});

it.each([false, true])(
  "finishes reciprocal CommonJS runtime preparation without duplicate transforms (build=%s)",
  async (production) => {
    const { root, main, later, calls, plugins } =
      await commonJsInitializationFixture(true);
    if (production) {
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins,
        build: {
          ssr: main,
          write: false,
          rollupOptions: { input: { main, later } }
        }
      });
      expect([...calls.values()]).toEqual([1, 1]);
    } else {
      const server = await createFixtureServer(root, plugins);
      for (const environment of [
        server.environments.client!,
        server.environments.ssr!
      ]) {
        const outputs = await Promise.all([
          environment.transformRequest("/src/main.cjs"),
          environment.transformRequest("/src/later.cjs")
        ]);
        expect(
          outputs.every((output) => typeof output?.code === "string")
        ).toBe(true);
        expect(calls.get(`${environment.name}:main`)).toBe(1);
        expect(calls.get(`${environment.name}:later`)).toBe(1);
      }
    }
  }
);

it("retains the first CommonJS initialization in a Vite SSR production bundle", async () => {
  const { root, main, calls, plugins } = await commonJsInitializationFixture();
  const out = join(root, "out");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    build: {
      ssr: main,
      outDir: out,
      rollupOptions: { output: { format: "es", entryFileNames: "app.mjs" } }
    }
  });
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const app = await import(${JSON.stringify(pathToFileURL(join(out, "app.mjs")).href)}); console.log(JSON.stringify({className:app.className, trace:app.read()}));`
    ],
    { cwd: root, env: process.env, encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    className: expect.any(String),
    trace: [true, ["css-package", "observer"]]
  });
  expect([...calls.values()]).toEqual([1, 1]);
});

describe("mincho with the Vite runtime", () => {
  it.each([false, true])(
    "ordinary authored CSS honors late resolved aliases (Mincho: %s)",
    async (mincho) => {
      const root = await createFixture({
        "src/ordinary.css":
          '.ordinary { background-image: url("@lateicons/logo.svg"); }',
        "src/logo.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" fill="purple"/>',
        "src/decoy.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" fill="orange"/>'
      });
      const resolveAlias = vi.fn((id: string) => id);
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, watch: null },
        plugins: [
          ...(mincho ? [minchoVitePlugin()] : []),
          {
            name: "ordinary-late-resolved-alias",
            configResolved(config) {
              config.resolve.alias.push(
                {
                  find: "@lateicons/logo.svg",
                  replacement: normalizePath(join(root, "src/logo.svg")),
                  customResolver: resolveAlias
                },
                {
                  find: "@lateicons/logo.svg",
                  replacement: normalizePath(join(root, "src/decoy.svg"))
                }
              );
            }
          }
        ]
      });
      servers.push(server);
      await server.listen();
      const css = await fetch(
        new URL("/src/ordinary.css?direct", server.resolvedUrls!.local[0]),
        {
          headers: { Accept: "text/css" }
        }
      );
      const body = await css.text();
      expect(css.status, body).toBe(200);
      expect(body).toContain("data:image/svg+xml,");
      expect(body).toContain("purple");
      expect(body).not.toContain("orange");
      expect(resolveAlias).toHaveBeenCalledWith(
        normalizePath(join(root, "src/logo.svg")),
        expect.stringContaining("/src/ordinary.css"),
        expect.anything()
      );
      expect(body).not.toContain("@lateicons");
    }
  );

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
        .spyOn(integration, "internalProcessManagedRegistryFile")
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

  it.each([
    "origin-free",
    "attributed",
    "unverified order",
    "in-flight retirement",
    "early replacement",
    "early retirement",
    "early restored bytes",
    "early republication",
    "style PostCSS retirement",
    "style PostCSS unchanged republication",
    "style PostCSS bare inline retirement"
  ] as const)(
    "validates final client direct CSS after ordered Vite transforms (%s)",
    async (scope) => {
      const early = scope.startsWith("early ");
      const stylePostCss = scope.startsWith("style PostCSS ");
      const bareInline = scope === "style PostCSS bare inline retirement";
      const root = await createFixture({
        "src/entry.ts":
          'import { css } from "@mincho-js/css"; export const cls = css({color:"red"});',
        "src/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>'
      });
      const integration = await import("@mincho-js/integration");
      const compile = vi.spyOn(integration, "compile").mockResolvedValue({
        source: "compiled source",
        watchFiles: [],
        cssScopeOrigins: []
      } as Awaited<ReturnType<typeof integration.compile>>);
      let source = ".probe { color: red; }";
      let styleRequest: string | undefined;
      let enterPausedRequest!: () => void;
      let releasePausedRequest!: () => void;
      const pausedRequest = new Promise<void>((resolve) => {
        enterPausedRequest = resolve;
      });
      const resumeRequest = new Promise<void>((resolve) => {
        releasePausedRequest = resolve;
      });
      const registry = vi
        .spyOn(integration, "internalProcessManagedRegistryFile")
        .mockImplementation(async ({ serializeVirtualCssPath }) => {
          const cssImport = await serializeVirtualCssPath!({
            fileName: "logical.css.ts",
            fileScope: { filePath: "logical.css.ts" },
            ...(scope === "attributed"
              ? { origin: normalizePath(join(root, "src/entry.ts")) }
              : {}),
            source
          });
          styleRequest = /import "([^"]+)";/.exec(cssImport)?.[1];
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
        ...(stylePostCss
          ? {
              css: {
                postcss: {
                  plugins: [
                    {
                      postcssPlugin: "pause-generated-style-capture",
                      async OnceExit(sheet) {
                        let pause = false;
                        sheet.walkDecls("color", (decl) => {
                          if (decl.value === "red") decl.value = "purple";
                          else if (decl.value === "blue") pause = true;
                        });
                        if (pause) {
                          enterPausedRequest();
                          await resumeRequest;
                          if (
                            scope === "style PostCSS retirement" ||
                            bareInline
                          ) {
                            sheet.walkDecls("color", (decl) => {
                              decl.cloneAfter({
                                prop: "background-image",
                                value: 'url("./icon.svg")'
                              });
                            });
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          : {}),
        plugins: [
          {
            name: "observe-direct-css-input",
            enforce: "pre",
            transform: {
              order: "pre",
              handler(css, id) {
                if (
                  id.endsWith("?direct") ||
                  (stylePostCss && id.includes(".vanilla.css"))
                )
                  expect(css).not.toContain("mincho-css-load:");
              }
            }
          },
          minchoVitePlugin(),
          {
            name: "late-direct-css-probe",
            configResolved(config) {
              if (scope !== "unverified order") return;
              // Simulate a later host extension appending a transform after
              // Mincho has inserted its own default tail.
              (config.plugins as Plugin[]).push({
                name: "extra-host-tail",
                transform: { order: "post", handler() {} }
              });
            },
            transform: {
              order: "post",
              async handler(css, id) {
                if (!/\.vanilla\.css\?direct(?:&|$)/.test(id)) return;
                if (
                  scope === "in-flight retirement" &&
                  css.includes("color: blue;")
                ) {
                  enterPausedRequest();
                  await resumeRequest;
                }
                if (early && css.includes("color: blue;")) return;
                return css.includes("color: blue;")
                  ? css +
                      '\n.local-icon { background-image: url("./icon.svg"); }'
                  : css.replace("color: red;", "color: purple;");
              }
            }
          }
        ]
      });
      servers.push(server);
      await server.listen();
      const client = server.environments.client!;
      if (early) {
        const nativeLoad = client.pluginContainer.load.bind(
          client.pluginContainer
        );
        vi.spyOn(client.pluginContainer, "load").mockImplementation(
          async (id) => {
            const loaded = await nativeLoad(id);
            if (id.endsWith("?direct") && source.includes("color: blue;")) {
              enterPausedRequest();
              await resumeRequest;
            }
            return loaded;
          }
        );
      }
      await readCssPropOutput(client, "/src/entry.ts");
      const owner = (await client.moduleGraph.getModuleByUrl("/src/entry.ts"))!;
      const sidecar = [...owner.importedModules].find((module) =>
        module.id?.startsWith("\0mincho-extracted-css:")
      )!;
      const code = (await client.transformRequest(sidecar.url))?.code;
      const request = code?.match(
        /import\s*["']([^"']+\.vanilla\.css(?:\?[^"']*)?)["']/
      )?.[1];
      expect(request).toBeDefined();
      expect(styleRequest).toBeDefined();
      const url = new URL(request!, server.resolvedUrls!.local[0]);
      if (bareInline) url.search = "?inline";
      const getCss = () =>
        fetch(url, {
          headers: {
            Accept: stylePostCss ? "application/javascript" : "text/css"
          }
        });

      const cold = await getCss();
      if (scope === "unverified order") {
        expect(cold.status).toBe(500);
        expect(await cold.text()).toMatch(
          /Cannot validate final origin-free direct CSS.*unsupported Vite transform order/
        );
        // The regular style module still goes through our usual capture check.
        expect(
          (await client.transformRequest(styleRequest + "?import"))?.code
        ).toContain("color: red;");
        return;
      }
      const prepared = await cold.text();
      expect(cold.status, prepared).toBe(200);
      expect(prepared).toContain("color: purple;");
      const warm = await getCss();
      expect(warm.status).toBe(200);
      expect(await warm.text()).toBe(prepared);

      if (bareInline) {
        const wrapper = new URL(url);
        wrapper.search = "?url&inline";
        const response = await fetch(wrapper);
        expect(response.status).toBe(200);
        const data = /data:text\/css;charset=utf-8;base64,([a-z0-9+/=]+)/i.exec(
          await response.text()
        )?.[1];
        expect(data).toBeDefined();
        const css = /^export default ("[^\n]+")/m.exec(prepared)?.[1];
        expect(css).toBeDefined();
        expect(Buffer.from(data!, "base64").toString("utf8")).toBe(
          JSON.parse(css!)
        );
      }

      source = ".probe { color: blue; }";
      client.moduleGraph.invalidateModule(sidecar);
      await client.transformRequest(sidecar.url);
      const fetching = getCss();
      if (early || stylePostCss || scope === "in-flight retirement") {
        try {
          await pausedRequest;
          if (scope === "style PostCSS unchanged republication") {
            client.moduleGraph.invalidateModule(sidecar);
            await client.transformRequest(sidecar.url);
          } else if (
            scope === "early replacement" ||
            scope === "early restored bytes" ||
            scope === "early republication"
          ) {
            if (scope !== "early republication")
              source = ".probe { color: green; }";
            client.moduleGraph.invalidateModule(sidecar);
            await client.transformRequest(sidecar.url);
            if (scope === "early restored bytes") {
              source = ".probe { color: blue; }";
              client.moduleGraph.invalidateModule(sidecar);
              await client.transformRequest(sidecar.url);
            }
          } else {
            await client.pluginContainer.transform(
              "export {};",
              normalizePath(join(root, "src/entry.ts"))
            );
          }
        } finally {
          releasePausedRequest();
        }
        const response = await fetching;
        const body = await response.text();
        if (scope === "style PostCSS unchanged republication") {
          expect(response.status, body).toBe(200);
          expect(body).toContain("__vite__css");
          expect(body).toContain("color: blue;");
          return;
        }
        if (scope === "style PostCSS retirement" || bareInline) {
          const fresh = await getCss();
          const freshBody = await fresh.text();
          expect(fresh.status, freshBody).toBe(200);
          expect(freshBody).toContain(
            bareInline ? 'export default ""' : '__vite__css = ""'
          );
        }
        if (scope === "early republication") {
          expect(response.status).toBe(200);
          expect(body).toContain("color: blue;");
          return;
        }
        expect(response.status, body).toBe(500);
        expect(body).toMatch(
          /Generated stylesheet changed during host processing/
        );
        if (scope === "early replacement" || scope === "early restored bytes") {
          const fresh = await getCss();
          expect(fresh.status).toBe(200);
          expect(await fresh.text()).toContain(source);
        }
        return;
      }
      const response = await fetching;
      const body = await response.text();
      if (scope === "origin-free") {
        expect(response.status, body).toBe(500);
        expect(body).toMatch(
          /processed an origin-free stylesheet.*physical origin/i
        );
      } else {
        expect(response.status).toBe(200);
        expect(body).toContain('url("./icon.svg")');
        expect(url.pathname).toMatch(/^\/src\//);
      }
      const wrapped = await client.transformRequest(styleRequest + "?import");
      expect(wrapped?.code).toContain("color: blue;");
      expect(wrapped?.code).not.toContain("./icon.svg");
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
        .spyOn(integration, "internalProcessManagedRegistryFile")
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

  it.each(["client", "ssr"] as const)(
    "checks imported iterator default safety (%s)",
    async (environment) => {
      for (const mutated of [false, true]) {
        const root = await createFixture({
          "src/entry.tsx":
            "import {getStyles} from './theme.css.js';import {readSize} from './runtime';export const Box=()=>{const [size=readSize()]=[4];return <div css={getStyles(size)}/>}",
          "src/theme.css.js":
            "export function getStyles(size){return {padding:size}}",
          "src/runtime.ts":
            (mutated
              ? "const original=Array.prototype[Symbol.iterator];Array.prototype[Symbol.iterator]=function*(){if(this.length===1&&this[0]===4)yield undefined;else yield* original.call(this)};"
              : "") +
            "export function readSize(){throw new Error('ITERATOR_DEFAULT_MUST_NOT_RUN_DURING_BUILD')}"
        });
        const server = await createFixtureServer(root, [
          minchoVitePlugin({ jsxCssProp: true })
        ]);
        if (!mutated)
          expect(
            (await readCssPropOutput(server.environments[environment]!)).css
          ).toContain("padding: 4px;");
        else {
          const error = await readCssPropOutput(
            server.environments[environment]!
          ).then(
            () => undefined,
            (error: unknown) => error
          );
          expect(error).toBeDefined();
          expect(String(error)).not.toContain(
            "ITERATOR_DEFAULT_MUST_NOT_RUN_DURING_BUILD"
          );
          expect(String(error)).toMatch(
            /Cannot statically|Cannot safely|Unsupported|Cannot extract/
          );
        }
      }
    }
  );

  it.each(["client", "ssr"] as const)(
    "observes actual CSS runtime effects before JSX defaults (%s)",
    async (environment) => {
      for (const mutated of [false, true]) {
        const root = await createFixture({
          "src/entry.tsx":
            "import './plain.css';import {getStyles} from './theme.css.js';import {readSize} from './runtime';export const Box=()=>{const [size=readSize()]=[4];return <div css={getStyles(size)}/>}",
          "src/plain.css": ".contrast{color:red}",
          "src/theme.css.js":
            "export function getStyles(size){return {padding:size}}",
          "src/runtime.ts":
            "export function readSize(){throw new Error('CSS_DEFAULT_MUST_NOT_RUN_DURING_BUILD')}"
        });
        const server = await createFixtureServer(root, [
          minchoVitePlugin({ jsxCssProp: true }),
          {
            name: "opaque-css-runtime-effect",
            enforce: "post",
            transform(code, id) {
              if (mutated && id.endsWith("/plain.css"))
                return (
                  code +
                  "\nArray.prototype[Symbol.iterator]=function*(){yield undefined};"
                );
            }
          }
        ]);
        if (!mutated)
          expect(
            (await readCssPropOutput(server.environments[environment]!)).css
          ).toContain("padding: 4px;");
        else {
          const error = await readCssPropOutput(
            server.environments[environment]!
          ).then(
            () => undefined,
            (error: unknown) => error
          );
          expect(error).toBeDefined();
          expect(String(error)).not.toContain(
            "CSS_DEFAULT_MUST_NOT_RUN_DURING_BUILD"
          );
          expect(String(error)).toMatch(
            /Cannot statically|Cannot safely|Unsupported|Cannot extract/
          );
        }
      }
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
      const read = async (
        packageName = "scope-parent",
        scopePath = "src/entry.tsx"
      ) => {
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
        const origin = normalizePath(join(root, "src/entry.tsx"));
        const scopeIdentity = createHash("sha256")
          .update(JSON.stringify([packageName, scopePath, origin]))
          .digest("hex");
        expect(
          [...sidecar.importedModules].map((module) => module.id)
        ).toContain(`${origin}.mincho-scope-${scopeIdentity}.vanilla.css`);
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
        return name ? read(name, "entry.tsx") : read();
      };
      const added = await change("scope-added");
      expect(added).not.toBe(initial);
      const edited = await change("scope-edited");
      expect(edited).not.toBe(added);
      expect(await change()).toBe(initial);
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

  it("preserves Vite's native CSS alias resolver hook descriptor", async () => {
    const root = await createFixture({
      "src/entry.css":
        '.fixture { background: url("./fixture.svg?no-inline"); }',
      "src/selected.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" fill="green"/>'
    });
    const calls: Array<{ importer?: string; canResolve: boolean }> = [];
    const customResolver = {
      resolveId: {
        handler(this: Rollup.PluginContext, id: string, importer?: string) {
          calls.push({
            importer,
            canResolve: typeof this.resolve === "function"
          });
          return { id };
        }
      }
      // The pinned native alias plugin also accepts the Rollup hook descriptor
      // in JavaScript config, beyond Vite's narrower exported ResolverObject.
    } as unknown as ResolverObject;
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: [
          {
            find: "./fixture.svg?no-inline",
            replacement: join(root, "src/selected.svg?no-inline"),
            customResolver
          }
        ]
      },
      server: { host: "127.0.0.1", port: 0, watch: null },
      plugins: [minchoVitePlugin()]
    });
    servers.push(server);
    await server.listen();
    const base = server.resolvedUrls!.local[0];
    const css = await fetch(new URL("src/entry.css", base), {
      headers: { Accept: "text/css" }
    });
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("/src/selected.svg?no-inline");
    expect(calls).toEqual([
      {
        importer: normalizePath(join(root, "src/entry.css")),
        canResolve: true
      }
    ]);
    const svg = await fetch(new URL("src/selected.svg?no-inline", base));
    expect(svg.status).toBe(200);
    expect(await svg.text()).toContain('fill="green"');
  });

  it.each([
    ["icons", false],
    ["100%", false],
    ["literal%20dir", false],
    ["literal%20dir", true],
    ["aliased%20dir", false],
    ["mixed%20dir", false]
  ] as const)(
    "serves native CSS and its sibling SVG from %s (server.origin: %s)",
    async (directory, configuredOrigin) => {
      let origin = "";
      let countInline = false;
      let inlineCalls = 0;
      let port = 0;
      if (configuredOrigin) {
        const reservation = createTcpServer();
        await new Promise<void>((resolve) =>
          reservation.listen(0, "127.0.0.1", resolve)
        );
        port = (reservation.address() as AddressInfo).port;
        await new Promise<void>((resolve, reject) =>
          reservation.close((error) => (error ? reject(error) : resolve()))
        );
        origin = "http://127.0.0.1:" + port;
      }
      const root = await createFixture({
        "src/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" fill="blue"/>'
      });
      if (directory === "literal%20dir") {
        const decoy = join(root, "src/literal dir");
        await mkdir(decoy);
        await writeFile(
          join(decoy, "icon.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" fill="blue"/>'
        );
      }
      const producer = join(root, "src", directory);
      await mkdir(producer);
      const fragmentAsset =
        directory === "mixed%20dir"
          ? "icon.svg"
          : directory === "100%"
            ? "icon.svg?no-inline"
            : "fragment.svg";
      await writeFile(
        join(producer, "producer.ts"),
        `import { css } from "@mincho-js/css"; export const cls = css({ backgroundImage: 'url("./icon.svg")', maskImage: 'url("./icon.svg?no-inline")', clipPath: 'url("./${fragmentAsset}#shape")' });`
      );
      await writeFile(
        join(producer, "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" id="shape" fill="orange"/>'
      );
      await writeFile(
        join(producer, "fragment.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><path id="shape"/></svg>'
      );
      if (directory === "aliased%20dir") {
        await writeFile(
          join(producer, "chosen.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" fill="green"/>'
        );
      }
      const server = await createServer({
        root,
        resolve:
          directory === "aliased%20dir"
            ? {
                alias: [
                  {
                    find: "./icon.svg?no-inline",
                    replacement: join(producer, "chosen.svg?no-inline")
                  }
                ]
              }
            : undefined,
        base:
          directory === "literal%20dir" ? "/preview/" : "/preview%20assets/",
        configFile: false,
        logLevel: "silent",
        build:
          directory === "100%"
            ? {
                assetsInlineLimit(file) {
                  if (countInline && file === join(producer, "icon.svg"))
                    inlineCalls++;
                  return true;
                }
              }
            : undefined,
        server: {
          host: "127.0.0.1",
          port,
          strictPort: configuredOrigin,
          preTransformRequests: false,
          origin: origin || undefined,
          watch: null
        },
        css: {
          postcss: {
            plugins: [
              {
                postcssPlugin: "add-browser-urls-after-native-resolution",
                Once(sheet) {
                  if (directory !== "literal%20dir") return;
                  sheet.walkDecls("mask-image", (decl) => {
                    if (decl.value.includes("./icon.svg?no-inline"))
                      decl.cloneAfter({
                        prop: "--original-input",
                        value: "yes"
                      });
                  });
                },
                OnceExit(sheet) {
                  if (directory !== "literal%20dir") return;
                  const path = "/preview/src/literal%20dir/icon.svg";
                  sheet.walkDecls("mask-image", (declaration) => {
                    declaration.cloneAfter({
                      prop: "--from-origin",
                      value: `url("${origin}${path}")`
                    });
                    declaration.cloneAfter({
                      prop: "--from-root",
                      value: `url("${path}")`
                    });
                    const href =
                      declaration.value.match(/url\(["']?([^"')]+)/)?.[1];
                    const mirror = new URL(path, origin);
                    mirror.search = new URL(href!, origin).search;
                    declaration.cloneAfter({
                      prop: "--from-mirror",
                      value: `url("${mirror.href}")`
                    });
                  });
                }
              }
            ]
          }
        },
        plugins: [
          {
            name: "watch-unrelated-asset",
            transform(_code, id) {
              if (id.includes(".vanilla.css"))
                this.addWatchFile(join(producer, "icon.svg"));
            }
          },
          minchoVitePlugin(),
          {
            name: "probe-generated-css-url-source-literals",
            enforce: "post",
            transform(code, id) {
              if (directory !== "100%" || !id.includes("mincho-extracted-css:"))
                return;
              const source = /import\s*["']([^"']+\.vanilla\.css)["']/.exec(
                code
              )?.[1];
              if (source) {
                const href = JSON.stringify(source + "?url");
                return (
                  code +
                  `\nimport importedStylesheet from ${href}; export { importedStylesheet };\n` +
                  `export { default as stylesheet } from ${href};`
                );
              }
            }
          }
        ]
      });
      servers.push(server);
      await server.listen();
      const base = server.resolvedUrls!.local[0];
      origin = new URL(base!).origin;
      const ownerUrl = `src/${directory}/producer.ts`;
      const owner = await fetch(new URL(encodeURI(ownerUrl), base));
      expect(owner.status).toBe(200);
      const sidecarHref = (await owner.text()).match(
        /import[^"';]*["']([^"']+mincho-extracted-css:[^"']+)["']/
      )?.[1];
      expect(sidecarHref).toBeDefined();
      const sidecar = await fetch(new URL(sidecarHref!, base));
      expect(sidecar.status, sidecarHref).toBe(200);
      const sidecarCode = await sidecar.text();
      const href = sidecarCode.match(
        /import\s*["']([^"']+\.vanilla\.css(?:\?[^"']*)?)["']/
      )?.[1];
      expect(href).toBeDefined();
      countInline = true;
      const response = await fetch(new URL(href!, base), {
        headers: { Accept: "text/css" }
      });
      const css = await response.text();
      countInline = false;
      if (directory === "100%") expect(inlineCalls).toBe(1);
      if (directory === "mixed%20dir") {
        expect(response.status).toBe(500);
        expect(css).toContain(
          "Vite cannot distinguish inline and fragment SVG uses"
        );
        return;
      }
      expect(response.status, href).toBe(200);
      if (directory === "100%") {
        const literal = /import importedStylesheet from ["']([^"']+)["']/.exec(
          sidecarCode
        )?.[1];
        const reexported =
          /export \{ default as stylesheet \} from ["']([^"']+)["']/.exec(
            sidecarCode
          )?.[1];
        expect(literal).toBeDefined();
        expect(reexported).toBeDefined();
        const literalResponse = await fetch(new URL(literal!, base));
        const reexportResponse = await fetch(new URL(reexported!, base));
        const literalJs = await literalResponse.text();
        const reexportJs = await reexportResponse.text();
        expect(literalResponse.status).toBe(200);
        expect(reexportResponse.status, reexported).toBe(200);
        expect(reexportJs).toBe(literalJs);
      }
      expect(css).toMatch(
        /background-image:\s*url\(["']?data:image\/svg\+xml,[^;]*orange/
      );
      const external = css.match(
        /mask-image:\s*url\(["']?([^"')]+)["']?\)/
      )?.[1];
      expect(external).toBeDefined();
      const asset = await fetch(new URL(external!, response.url));
      expect(asset.status, external).toBe(200);
      expect(await asset.text()).toContain(
        directory === "aliased%20dir" ? 'fill="green"' : 'fill="orange"'
      );
      const clipped = css.match(/clip-path:\s*url\(["']?([^"')]+)/)?.[1];
      expect(clipped).toMatch(/#shape$/);
      expect(
        await (await fetch(new URL(clipped!, response.url))).text()
      ).toContain('id="shape"');
      if (directory === "literal%20dir") {
        expect(css).toMatch(/--original-input:\s*yes/);
        for (const property of [
          "--from-origin",
          "--from-root",
          "--from-mirror"
        ]) {
          const href = css.match(
            new RegExp(property + ":\\s*url\\([\"']?([^\"')]+)")
          )?.[1];
          const input = "/preview/src/literal%20dir/icon.svg";
          const expected = property === "--from-root" ? input : origin + input;
          expect(href).toBe(
            expected + (property === "--from-mirror" ? "?no-inline" : "")
          );
          const network = await fetch(new URL(href!, response.url));
          expect(network.status).toBe(200);
          expect(await network.text(), property).toContain('fill="blue"');
        }
      }
      const ssr = server.environments.ssr!;
      await readCssPropOutput(ssr, "/" + ownerUrl);
      const ssrOwner = (await ssr.moduleGraph.getModuleByUrl("/" + ownerUrl))!;
      const ssrSidecar = [...ssrOwner.importedModules].find((child) =>
        child.id?.startsWith("\0mincho-extracted-css:")
      )!;
      const sheet = [...ssrSidecar.importedModules].find((child) =>
        child.id?.includes(".vanilla.css")
      )!;
      const ssrCss = (
        await ssr.pluginContainer.transform(
          (await ssr.pluginContainer.load(sheet.id!)) as string,
          sheet.id! + "?direct"
        )
      ).code;
      const ssrHref = ssrCss.match(/mask-image:\s*url\(["']?([^"')]+)/)?.[1];
      expect(ssrHref).toBeDefined();
      expect(await (await fetch(new URL(ssrHref!, base))).text()).toContain(
        directory === "aliased%20dir" ? 'fill="green"' : 'fill="orange"'
      );
      const styleModule = await fetch(new URL(href!, base));
      expect(styleModule.status).toBe(200);
      expect(await styleModule.text()).toContain(external!);
      const rawUrl = new URL(href!, base);
      rawUrl.search = "?raw";
      const raw = await fetch(rawUrl);
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain("./icon.svg?no-inline");
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
        .spyOn(integration, "internalProcessManagedRegistryFile")
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
    expect(css.id).toContain("/src/");
    const inlineUrl = css.url + "?url&inline";
    const warmInline = await client.transformRequest(inlineUrl);
    expect(warmInline?.code).toMatch(/export default ["']data:text\/css/);
    expect(warmInline?.code).toContain("red");
    const privateId = `\0mincho-virtual-css:${join(root, "src/private.vanilla.css")}`;
    expect(await client.pluginContainer.load(privateId)).toBeNull();

    await client.pluginContainer.transform(
      "export const App = () => <div />;",
      owner!.id!
    );

    expect(await client.pluginContainer.load(css.id!)).toBe("");
    const coldInline = await client.transformRequest(inlineUrl);
    expect(coldInline?.code).toContain(
      'export default "data:text/css;charset=utf-8;base64,"'
    );
    expect(coldInline?.code).not.toContain("red");
    expect(await client.pluginContainer.load(`${css.id!}?raw`)).toBe(
      'export default "";'
    );
    expect(await client.pluginContainer.load(privateId)).toBeNull();
    expect(await client.pluginContainer.load(`${privateId}?raw`)).toBeNull();
    const ordinaryInline = await client.transformRequest(
      "/src/private.vanilla.css?url&inline"
    );
    expect(ordinaryInline?.code).toContain(
      Buffer.from(".private { color: blue; }").toString("base64")
    );
    await expect(
      client.transformRequest("/src/absent.vanilla.css?url&inline")
    ).rejects.toThrow(/Denied ID|ENOENT|Failed to load url/);
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

      // The old parameterized helper is no longer reachable from a registered
      // factory. It must not silently keep stale protection after the re-export
      // changes, even when the entry only imports its unrelated static style.
      await expect(
        server.environments.client!.transformRequest(`/src/helper.${extension}`)
      ).rejects.toThrow(/captures runtime binding rule/);
      await update(
        `src/implementation.${extension}`,
        extension === "cjs"
          ? `const { recipe } = require("@vanilla-extract/recipes");
              function makeRecipe(options) { return recipe(options); }
              exports.makeRecipe = makeRecipe;
              exports.localClassName = makeRecipe({ base: { color: "orchid" } })();`
          : `import { recipe } from "@vanilla-extract/recipes";
              export function makeRecipe(options) { return recipe(options); }
              export const localClassName = makeRecipe({ base: { color: "orchid" } })();`
      );
      await update(
        `src/helper.${extension}`,
        extension === "cjs"
          ? 'const { style } = require("@vanilla-extract/css"); exports.unrelated = style({ outlineStyle: "dotted" });'
          : 'import { style } from "@vanilla-extract/css"; export const unrelated = style({ outlineStyle: "dotted" });'
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

      const server = await createFixtureServer(root, [
        minchoVitePlugin(),
        ...(vanilla ? vanillaExtractPlugin() : [])
      ]);

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
            /vanilla-extract[-_/]dynamic/.test(module.id ?? "")
          );

          expect(runtime).toBeDefined();
          const native = await environment.transformRequest(runtime!.url);

          expect(native?.code).toMatch(/export\s+(default|\{)/);
          expect(native?.code).toContain("assignInlineVars");
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

const physicalBytes = vi.hoisted(() => ({ changed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const value = actual.readFileSync(...args);
      return physicalBytes.changed &&
        String(args[0]).endsWith("/dist/client/client.mjs") &&
        typeof value === "string"
        ? value + "\nArray.prototype[0] = 9;"
        : value;
    }
  };
});

const clientRequire = createRequire(join(process.cwd(), "package.json"));
const client = join(
  dirname(clientRequire.resolve("vite/package.json")),
  "dist/client/client.mjs"
);

afterEach(() => {
  physicalBytes.changed = false;
});
describe("owned Vite client pattern-effect observation", () => {
  it.each([
    "clean",
    "pre-loader",
    "normal-loader",
    "post-loader",
    "tail-loader",
    "post-mutation",
    "source-bytes"
  ] as const)(
    "preserves loader precedence and validates final source: %s",
    async (scenario) => {
      const baseline = await readFile(client, "utf8");
      physicalBytes.changed = scenario === "source-bytes";
      const root = await mkdtemp(join("/var/tmp", "mincho-client-contract-"));
      roots.push(root);
      const observers = new Map<
        string,
        ReturnType<typeof createViteClientIntrinsicObserver>
      >();
      const core: Plugin = {
        name: "test-core",
        enforce: "pre",
        applyToEnvironment(environment) {
          const observer = createViteClientIntrinsicObserver();
          observers.set(environment.name, observer);
          return [core, observer.issuer];
        }
      };
      const load = (id: string) =>
        id === client && scenario.endsWith("loader") ? baseline : undefined;
      const user: Plugin = {
        name: "test-user",
        ...(scenario === "pre-loader"
          ? { enforce: "pre" as const }
          : scenario === "post-loader"
            ? { enforce: "post" as const }
            : {}),
        load:
          scenario === "tail-loader" ? { order: "post", handler: load } : load,
        transform: {
          order: "post",
          handler(source, id) {
            if (id === client && scenario === "post-mutation")
              return (
                source +
                "\nArray.prototype[Symbol.iterator] = function* () { yield 9; };"
              );
          }
        }
      };
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: true },
        plugins: [core, user]
      });
      servers.push(server);
      const environment = server.environments.client!;
      const result = await environment.transformRequest("/@vite/client");
      expect(result).toBeTruthy();
      let validateSsr: (() => boolean) | undefined;
      if (scenario === "clean") {
        const ssr = server.environments.ssr!;
        await ssr.moduleGraph.ensureEntryFromUrl(client);
        const loaded = await ssr.pluginContainer.load(client);
        const original = typeof loaded === "string" ? loaded : loaded?.code;
        expect(original).toBe(baseline);
        const transformed = await ssr.pluginContainer.transform(
          original!,
          client
        );
        const ssrSource = transformed?.code ?? original!;
        const ssrReceipt = await observers
          .get("ssr")!
          .validate(client, ssrSource, async (specifier, importer) => {
            const resolved = await ssr.pluginContainer.resolveId(
              specifier,
              importer
            );
            return resolved && !resolved.external ? resolved.id : undefined;
          });
        // Inspect the complete SSR plugin view before its execution wrapper;
        // the same literal-only comparison applies in this environment.
        expect(ssrReceipt).toBeDefined();
        expect(ssrReceipt!.validate(ssrSource)).toBe(true);
        validateSsr = () => ssrReceipt!.validate(ssrSource);
      }
      const observer = observers.get("client")!;
      const receipt = await observer.validate(
        client,
        result!.code,
        async (specifier, importer) => {
          const resolved = await environment.pluginContainer.resolveId(
            specifier,
            importer
          );
          return resolved && !resolved.external ? resolved.id : undefined;
        }
      );
      if (scenario === "clean") {
        expect(receipt).toBeDefined();
        expect(receipt!.validate(result!.code)).toBe(true);
        physicalBytes.changed = true;
        expect(receipt!.validate(result!.code)).toBe(false);
        physicalBytes.changed = false;
        expect(
          receipt!.validate(result!.code + "\nArray.prototype[0] = 9;")
        ).toBe(false);
        const benignFile = join(root, "benign.js");
        await writeFile(benignFile, "export const value = 2;");
        // Dispatch this benign edit to one environment, as Vite does for its
        // environment-scoped hook. Other environments retain their receipts.
        const watch = observer.issuer.watchChange;
        if (typeof watch === "function")
          watch.call({} as never, benignFile, { event: "update" });
        expect(receipt!.validate(result!.code)).toBe(false);
        expect(validateSsr!()).toBe(true);
        const node = environment.moduleGraph.getModuleById(client)!;
        environment.moduleGraph.invalidateModule(node);
        const refreshed = await environment.transformRequest("/@vite/client");
        const nextReceipt = await observer.validate(
          client,
          refreshed!.code,
          async (specifier, importer) => {
            const resolved = await environment.pluginContainer.resolveId(
              specifier,
              importer
            );
            return resolved && !resolved.external ? resolved.id : undefined;
          }
        );
        expect(nextReceipt).toBeDefined();
        expect(nextReceipt!.key).not.toBe(receipt!.key);
        expect(nextReceipt!.validate(refreshed!.code)).toBe(true);
        expect(receipt!.validate(result!.code)).toBe(false);
        expect(validateSsr!()).toBe(true);
      } else expect(receipt).toBeUndefined();
      expect(
        environment.plugins.filter((plugin) => plugin === core)
      ).toHaveLength(1);
    }
  );
  it("permits only literal config replacements and exact env import rewriting", () => {
    const original = 'import "@vite/env"; const base = __BASE__;';
    expect(
      matchesViteClientSource(
        original,
        'import "/@vite/env"; const base = "/";',
        "/@vite/env"
      )
    ).toBe(true);
    for (const expression of [
      "mutate()",
      "({ get value() { return 1; } })",
      "__DEFINES__"
    ]) {
      expect(
        matchesViteClientSource(
          original,
          `import "/@vite/env"; const base = ${expression};`,
          "/@vite/env"
        )
      ).toBe(false);
    }
    expect(
      matchesViteClientSource(
        original,
        'import "other"; const base = "/";',
        "/@vite/env"
      )
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, createServer, type Plugin, type ResolvedConfig } from "vite";
import {
  minchoVitePlugin,
  minchoVitePlugins,
  type MinchoVitePluginOptions
} from "./index.js";
import { createJsxRuntimeGuardPlugins } from "./jsxRuntimeGuards.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function bundle(
  source: string,
  options: MinchoVitePluginOptions = {},
  format: "es" | "cjs" = "es",
  preset = true,
  jsxDev = false,
  laterPlugins: Plugin[] = []
) {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "jsx-runtime-guards-"));
  roots.push(root);
  await writeFile(join(root, "entry.tsx"), source);

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      ...(preset
        ? minchoVitePlugins({ cache: false, ...options })
        : [minchoVitePlugin({ cache: false, ...options })]),
      ...laterPlugins
    ],
    esbuild: { jsx: "automatic", jsxImportSource: "@mincho-js/react", jsxDev },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: join(root, "entry.tsx"),
        preserveEntrySignatures: "strict",

        external: (id) => id.startsWith("@mincho-js/react/"),

        output: { format }
      }
    }
  });

  return (Array.isArray(result) ? result : [result])
    .flatMap((item) => ("output" in item ? item.output : []))
    .filter((item) => item.type === "chunk")
    .map((item) => item.code)
    .join("\n");
}

describe("Vite automatic JSX runtime specialization", () => {
  it("uses current source evidence in serve mode when explicitly enabled", async () => {
    const parent = join(process.cwd(), ".cache");
    await mkdir(parent, { recursive: true });

    const root = await mkdtemp(join(parent, "jsx-runtime-guards-dev-"));
    roots.push(root);

    const entry = join(root, "entry.tsx");
    await writeFile(entry, "export const App = () => <div />;");

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        ...minchoVitePlugins({
          cache: false,
          optimize: { jsxRuntimeGuards: true }
        }),
        {
          name: "fixture-jsx-runtime",

          resolveId(id) {
            return id.startsWith("@mincho-js/react/") ? `\0${id}` : null;
          },

          load(id) {
            return id.startsWith("\0@mincho-js/react/")
              ? "export const jsx = (...args) => args; export const jsxs = jsx; export const jsxDEV = jsx;"
              : null;
          }
        }
      ],
      esbuild: { jsx: "automatic", jsxImportSource: "@mincho-js/react" },
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true }
    });

    try {
      const first = await server.transformRequest("/entry.tsx");

      expect(first?.code).toContain("compiled-jsx-dev-runtime");

      await writeFile(
        entry,
        'import { jsx } from "@mincho-js/react/jsx-runtime"; export const direct = () => jsx("div", incoming); export const App = () => <div />;'
      );
      server.moduleGraph.invalidateAll();

      const second = await server.transformRequest("/entry.tsx");

      expect(second?.code).toContain("react/jsx-dev-runtime");
      expect(second?.code).not.toContain("compiled-jsx");
    } finally {
      await server.close();
    }
  });

  it("matches original-source evidence to each map across overlapping transforms", async () => {
    const { evidence, guard } = createJsxRuntimeGuardPlugins({});
    if (
      typeof evidence.configResolved !== "function" ||
      typeof evidence.transform !== "function" ||
      typeof guard.transform !== "function"
    )
      throw new Error("Expected callable guard hooks");

    const transform = guard.transform;
    await evidence.configResolved.call(
      {} as ThisParameterType<typeof evidence.configResolved>,
      { command: "build" } as ResolvedConfig
    );

    const id = "/app.tsx";
    const source = "export const App = () => <div />;";
    const explicit =
      'import { jsx } from "@mincho-js/react/jsx-runtime"; export const App = () => jsx("div", {});';

    const lowered =
      'import { jsx as _jsx } from "@mincho-js/react/jsx-runtime"; export const App = () => _jsx("div", {});';

    const context = (content: string) =>
      ({
        environment: { name: "client" },

        getCombinedSourcemap: () => ({ sourcesContent: [content] })
      }) as unknown as ThisParameterType<typeof transform>;

    await evidence.transform.call(context(source), source, id);
    await evidence.transform.call(context(explicit), explicit, id);

    expect(await transform.call(context(explicit), lowered, id)).toBeNull();
    expect(await transform.call(context(source), lowered, id)).toHaveProperty(
      "code",
      expect.stringContaining("compiled-jsx-runtime")
    );
    expect(
      await transform.call(context("missing source"), lowered, id)
    ).toBeNull();

    for (let index = 0; index < 4; index++) {
      const next = `${source}\n// revision ${index}`;
      await evidence.transform.call(context(next), next, id);
    }

    expect(await transform.call(context(source), lowered, id)).toBeNull();
  });

  it.each(["es", "cjs"] as const)(
    "specializes %s after the native JSX transform",
    async (format) => {
      const code = await bundle(
        'export const App = () => <div css={{ color: "red" }} />;',
        { jsxCssProp: true },
        format
      );

      expect(code).toContain("@mincho-js/react/compiled-jsx-runtime");
      expect(code).not.toMatch(/["']@mincho-js\/react\/jsx-runtime["']/);
    }
  );

  it("splits safe and unsafe calls in the same lowered module", async () => {
    const code = await bundle(
      "export const safe = () => <div />; export const unsafe = () => <div {...incoming} />;"
    );

    expect(code).toContain("@mincho-js/react/compiled-jsx-runtime");
    expect(code).toMatch(/["']@mincho-js\/react\/jsx-runtime["']/);
  });

  it("retains guards when a later post transform may change props", async () => {
    const code = await bundle(
      "export const App = () => <div />;",
      {},
      "es",
      true,
      false,
      [
        {
          name: "later-props-transform",
          enforce: "post",
          transform: { order: "post", handler: () => null }
        }
      ]
    );

    expect(code).toContain("@mincho-js/react/jsx-runtime");
    expect(code).not.toContain("compiled-jsx-runtime");
  });

  it.each([
    ['export const App = () => <div css="uncompiled" />;', {}],
    ["export const App = () => <div />;", { optimizationMode: "development" }],
    [
      "export const App = () => <div />;",
      { optimize: { jsxRuntimeGuards: false } }
    ],
    [
      'import { jsx } from "@mincho-js/react/jsx-runtime"; export const direct = () => jsx("div", incoming); export const App = () => <div />;',
      {}
    ],
    [
      'const { jsx } = require("@mincho-js/react/jsx-runtime"); export const direct = () => jsx("div", incoming); export const App = () => <div />;',
      {}
    ]
  ] as const)("retains guards for %s", async (source, options) => {
    const code = await bundle(source, options);

    expect(code).toContain("@mincho-js/react/jsx-runtime");
    expect(code).not.toContain("compiled-jsx-runtime");
  });

  it("keeps the original single plugin API and honors a development override", async () => {
    const source = "export const App = () => <div />;";

    expect(await bundle(source, {}, "es", false)).not.toContain(
      "compiled-jsx-runtime"
    );
    expect(
      await bundle(source, {
        optimizationMode: "development",
        optimize: { jsxRuntimeGuards: true }
      })
    ).toContain("compiled-jsx-runtime");
  });

  it("specializes generated development calls without changing their arguments", async () => {
    const code = await bundle(
      "export const App = () => <div />;",
      {},
      "es",
      true,
      true
    );

    expect(code).toContain("@mincho-js/react/compiled-jsx-dev-runtime");
    expect(code).toContain("fileName:");
    expect(code).toContain("lineNumber:");
  });
});

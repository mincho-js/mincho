import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  build,
  createServer,
  normalizePath,
  type HMRPayload,
  type Plugin,
  type Rollup
} from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "./index.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true }))
  );
  roots.clear();
});

async function fixture(importSource = "test-preset") {
  const root = await mkdtemp(resolve(process.cwd(), ".jsx-css-source-"));
  roots.add(root);
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "jsx-css-source-fixture",
      type: "module",
      exports: { ".": "./preset.ts", "./tokens": "./tokens.ts" }
    })
  );
  await writeFile(resolve(root, "tokens.ts"), 'export const blue = "#147aff";');
  await writeFile(
    resolve(root, "preset.ts"),
    `
    import { defineRules } from "@mincho-js/css";
    import { blue } from "./tokens";
    export const { css, rules, cx } = defineRules({
      properties: {
        backgroundColor: { blue },
        paddingLeft: { 3: "12px" }, paddingRight: { 3: "12px" }
      },
      shortcuts: { bg: "backgroundColor", px: ["paddingLeft", "paddingRight"], rounded: {borderRadius: "4px"} }
    });
  `
  );
  await writeFile(
    resolve(root, "entry.tsx"),
    `
    export const Button = () => <button css={[{bg: "blue", px: 3}, "rounded"]} />;
    export const ClassName = ({value}) => <span css={value} />;
  `
  );

  return {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    resolve: {
      alias: [
        { find: /^test-preset$/, replacement: resolve(root, "preset.ts") },
        { find: /^@mincho-js$/, replacement: resolve(root, "preset.ts") }
      ]
    },
    esbuild: { jsx: "automatic" as const, jsxImportSource: "@mincho-js/react" },
    plugins: [
      minchoVitePlugin({ jsxCssProp: { importSource } }),
      vanillaExtractPlugin()
    ]
  };
}

it.each([
  [false, "none", false],
  [false, "noop", false],
  [false, "explicit", false],
  [false, "auto", false],
  [true, "explicit", false],
  [true, "noop", true],
  [true, "explicit", true]
] as const)(
  "extracts configured factory calls with JSX CSS %s and %s Babel hook, synchronous values=%s",
  async (jsxCssProp, mode, synchronousValues) => {
    const options = await fixture();
    const { root } = options;
    const entry = resolve(root, synchronousValues ? "entry.tsx" : "entry.ts");
    const config = resolve(root, "babel.config.cjs");
    const calls = resolve(root, "pre-count");
    const appendImport = mode === "explicit" || mode === "auto";
    await Promise.all([
      writeFile(
        entry,
        'import { make } from "./preset.ts"; export const className = make({ color: "red" });' +
          (synchronousValues
            ? 'import { rule } from "./rule.ts"; export const Box = () => <div css={rule} />;'
            : "")
      ),
      ...(synchronousValues
        ? [
            writeFile(
              resolve(root, "rule.ts"),
              'export const rule = { color: "blue" };'
            )
          ]
        : []),
      writeFile(
        resolve(root, "preset.ts"),
        'import { style } from "@vanilla-extract/css"; export function make(rule) { return style(rule); }'
      ),
      writeFile(
        resolve(root, "effects.js"),
        "globalThis.__minchoExistingBuildEffect = true;"
      ),
      ...(mode === "none"
        ? []
        : [
            writeFile(
              config,
              `const { appendFileSync } = require("node:fs");
              module.exports = { plugins: [({ types: t }) => ({
                pre(file) {
                  if (file.opts.filename !== ${JSON.stringify(entry)}) return;
                  appendFileSync(${JSON.stringify(calls)}, "pre");
                  if (${appendImport}) file.ast.program.body.unshift(
                    t.importDeclaration([], t.stringLiteral("./effects.js"))
                  );
                },
                visitor: {}
              })] };`
            )
          ])
    ]);

    const result = await build({
      ...options,
      plugins: [
        minchoVitePlugin({
          jsxCssProp,
          extractCalls: { "./preset.ts": ["make"] },
          babel: {
            cwd: root,
            babelrc: false,
            staticCssEvalProvider: synchronousValues
              ? {
                  getResolvedCssValue(query) {
                    return query.bindingName === "rule"
                      ? {
                          kind: "resolved",
                          value: { color: "green" },
                          dependencies: []
                        }
                      : { kind: "not-candidate" };
                  }
                }
              : undefined,
            ...(mode === "auto"
              ? {}
              : { configFile: mode === "none" ? false : config })
          }
        }),
        vanillaExtractPlugin()
      ],
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        cssCodeSplit: true,
        lib: { entry, formats: ["es"] },
        rollupOptions: {
          external: (id) => id === "react" || id.startsWith("@mincho-js/react/")
        }
      }
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (item) => ("output" in item ? item.output : [])
    );
    const css = outputs
      .flatMap((item) =>
        item.type === "asset" && item.fileName.endsWith(".css")
          ? [String(item.source)]
          : []
      )
      .join("\n");
    const js = outputs
      .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
      .join("\n");
    const className = /\.([\w-]+)\s*\{\s*color: red;/.exec(css)?.[1];
    expect(className).toBeDefined();
    expect(js).toContain(JSON.stringify(className));
    expect(js).not.toMatch(/className\s*=\s*make\(/);
    expect(js.includes("__minchoExistingBuildEffect")).toBe(appendImport);
    if (mode !== "none") expect(await readFile(calls, "utf8")).toBe("pre");
    if (synchronousValues) {
      const syncClass = /\.([\w-]+)\s*\{\s*color: green;/.exec(css)?.[1];
      expect(syncClass).toBeDefined();
      expect(js).toContain(JSON.stringify(syncClass));
      expect(css).not.toContain("color: blue;");
    }
  }
);

it.each(["builtin", "configured-unrelated", "configured-used"] as const)(
  "builds %s CSS without resolving an unused JSX preset",
  async (kind) => {
    const options = await fixture();
    const { root } = options;
    const calls: string[] = [];
    const usesPreset = kind === "configured-used";
    const entry = resolve(root, usesPreset ? "entry.tsx" : "legacy.ts");
    await writeFile(
      resolve(root, "preset.ts"),
      `import { defineRules } from "@mincho-js/css";
       export const { css, cx, rules } = defineRules({ properties: { color: true } });`
    );
    await writeFile(
      entry,
      usesPreset
        ? 'export const App = () => <div css={{ color: "blue" }} />;'
        : 'import { css } from "@mincho-js/css"; export const style = css({ color: "blue" });'
    );
    const preset: Plugin = {
      name: "entry-specific-preset",
      resolveId(id, importer) {
        if (id !== "test-preset") return;
        calls.push(importer ?? "");
        if (importer?.endsWith("legacy.ts"))
          throw new Error("Legacy entry cannot resolve the unused JSX preset");
        return resolve(root, "preset.ts");
      }
    };
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      esbuild: { jsx: "transform", jsxFactory: "jsx" },
      plugins: [
        preset,
        minchoVitePlugin(
          kind === "builtin"
            ? {}
            : { jsxCssProp: { importSource: "test-preset" } }
        ),
        vanillaExtractPlugin()
      ],
      build: {
        write: false,
        minify: false,
        cssCodeSplit: true,
        lib: { entry, formats: ["es"] }
      }
    });
    const css = (Array.isArray(result) ? result : [result])
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .flatMap((file) =>
        file.type === "asset" && file.fileName.endsWith(".css")
          ? [String(file.source)]
          : []
      )
      .join("\n");
    expect(css).toContain("color: blue");
    if (usesPreset)
      expect(calls.some((importer) => importer.endsWith("entry.tsx"))).toBe(
        true
      );
    else expect(calls).toEqual([]);
  }
);

async function separateOwnerFixture(
  distChunk: boolean,
  origins: "conflicting" | "different-files" | "same-file" = "conflicting"
) {
  const options = await fixture();

  for (const [name, color] of [
    ["first", "red"],
    ["second", "blue"]
  ]) {
    const directory = resolve(options.root, name);

    if (origins === "same-file" && name === "second") {
      await symlink(resolve(options.root, "first"), directory, "junction");
    } else {
      await mkdir(directory);
      await writeFile(
        resolve(directory, "package.json"),
        JSON.stringify({ name: "separate-owner-package", type: "module" })
      );
      await writeFile(
        resolve(
          directory,
          origins === "different-files" ? `${name}.mjs` : "index.mjs"
        ),
        `import { css as nativeCss } from "@mincho-js/css";
         import { style } from "@vanilla-extract/css";
         ${
           origins === "conflicting"
             ? `// Deliberately claim the same manual tuple from two physical producers.
              // Compiler-generated scopes now distinguish package installations.
              import {setFileScope as manualScope,endFileScope} from "@vanilla-extract/css/fileScope";
              manualScope("index.mjs", "separate-owner-package");`
             : ""
         }
         const className = style({ color: "${color}" });
         ${origins === "conflicting" ? "endFileScope();" : ""}
         export const css = rule => nativeCss([className, rule]);`
      );
    }

    await writeFile(
      resolve(options.root, `${name}.tsx`),
      `export const ${name} = () => <div css={{ padding: 12 }} />;`
    );
  }

  await writeFile(
    resolve(options.root, "entry.tsx"),
    'export { first } from "./first"; export { second } from "./second";'
  );

  return {
    ...options,
    resolve: { ...options.resolve, alias: options.resolve.alias.slice(1) },
    plugins: [
      {
        name: "separate-owner-css-source",
        resolveId(source, importer) {
          if (source !== "test-preset") return;

          const name = importer?.includes("second.tsx") ? "second" : "first";
          return resolve(
            options.root,
            name,
            origins === "different-files" ? `${name}.mjs` : "index.mjs"
          );
        }
      } satisfies Plugin,
      minchoVitePlugin({
        jsxCssProp: { importSource: "test-preset" },
        appCss: { mode: distChunk ? "dist-chunk" : "native" }
      }),
      ...(!distChunk ? [vanillaExtractPlugin()] : [])
    ],
    build: {
      write: false,
      minify: false as const,
      cssMinify: false as const,
      cssCodeSplit: true,
      rollupOptions: {
        input: resolve(options.root, "entry.tsx"),
        preserveEntrySignatures: "strict" as const,
        external: (id: string) => id.startsWith("@mincho-js/react/")
      }
    }
  };
}

describe("configured JSX css source", () => {
  it.each([false, true])(
    "reuses native sidecar compilation without user aliases (static styles: %s)",
    async (staticStyles) => {
      const options = await fixture("@mincho-js/css");
      await mkdir(resolve(options.root, "reports"));
      await writeFile(
        resolve(options.root, "entry.tsx"),
        'export const Button = () => <button css={{ color: "red" }} />;'
      );
      const server = await createServer({
        ...options,
        resolve: { alias: [] },
        esbuild: { jsx: "transform", jsxFactory: "jsx" },
        plugins: [
          minchoVitePlugin({
            jsxCssProp: true,
            optimize: { staticStyles, dependencyGraph: true },
            diagnostics: { json: "reports/compilation.json" }
          }),
          vanillaExtractPlugin()
        ],
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          middlewareMode: true,
          preTransformRequests: false,
          watch: null
        },
        appType: "custom"
      });

      try {
        expect(server.config.resolve.alias.length).toBeGreaterThan(0);
        await server.transformRequest("/entry.tsx");
        const sidecar = [...server.moduleGraph.idToModuleMap.values()].find(
          (module) => module.id?.startsWith("\0mincho-extracted-css:")
        );
        expect(sidecar).toBeDefined();
        const first = await server.transformRequest(sidecar!.url);
        expect(first?.code).toContain(".vanilla.css");
        server.moduleGraph.invalidateModule(sidecar!);
        const second = await server.transformRequest(sidecar!.url);
        expect(second?.code).toBe(first?.code);
        const cssModule = [...server.moduleGraph.idToModuleMap.values()].find(
          (module) => module.id?.endsWith(".vanilla.css")
        );
        expect(cssModule).toBeDefined();
        expect((await server.transformRequest(cssModule!.url))?.code).toContain(
          "color: red"
        );
      } finally {
        await server.close();
      }

      const report = JSON.parse(
        await readFile(
          resolve(options.root, "reports/compilation.json"),
          "utf8"
        )
      ) as {
        builds: Array<{
          events: Array<{ phase: string; detail?: { reason?: string } }>;
        }>;
      };
      const events = report.builds.flatMap((build) => build.events);
      expect(
        events.filter(
          (event) =>
            event.phase === "cache-bypass" &&
            event.detail?.reason === "opaque-compile-plugin"
        )
      ).toEqual([]);
      expect(events.some((event) => event.phase === "cache-hit")).toBe(true);
      expect(
        events.some((event) => event.phase === "static-styles-compile")
      ).toBe(staticStyles);
    }
  );

  it.each([
    [false, "top-level"],
    [true, "top-level"],
    [false, "overrides"],
    [true, "overrides"]
  ] as const)(
    "evaluates configured decorator dependencies in authoring sidecars (dependency graph: %s, Babel configuration: %s)",
    async (dependencyGraph, configuration) => {
      const options = await fixture();
      await writeFile(
        resolve(options.root, "palette.ts"),
        `const colors: string[] = [];
         function register(palette: typeof Palette) {
           colors.push("#237a5b");
           return palette;
         }
         export @register class Palette {}
         export const themeColor = colors[0];`
      );
      await writeFile(
        resolve(options.root, "preset.ts"),
        `import { defineRules } from "@mincho-js/css";
         import { themeColor } from "./palette";
         export const { css } = defineRules({
           properties: { color: { theme: themeColor } }
         });`
      );
      await writeFile(
        resolve(options.root, "entry.tsx"),
        'export const Button = () => <button css={{ color: "theme" }} />;'
      );
      const parserOpts = {
        plugins: [
          ["decorators", { decoratorsBeforeExport: false }]
        ] satisfies NonNullable<
          import("@babel/core").TransformOptions["parserOpts"]
        >["plugins"]
      };
      const result = await build({
        ...options,
        plugins: [
          minchoVitePlugin({
            jsxCssProp: { importSource: "test-preset" },
            optimize: { dependencyGraph },
            babel:
              configuration === "overrides"
                ? { overrides: [{ test: /\.tsx?$/, parserOpts }] }
                : { parserOpts }
          }),
          vanillaExtractPlugin()
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          rollupOptions: {
            input: resolve(options.root, "entry.tsx"),
            preserveEntrySignatures: "strict",
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const output = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = output
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("color: #237a5b");
    }
  );

  it.each([false, true])(
    "rejects conflicting CSS scopes across separate owners (dist chunk: %s)",
    async (distChunk) => {
      const options = await separateOwnerFixture(distChunk);

      await expect(build(options)).rejects.toThrow(
        'Ambiguous CSS file scope "index.mjs" in package "separate-owner-package"'
      );
    }
  );

  it.each([
    [false, "different-files"],
    [false, "same-file"],
    [true, "different-files"],
    [true, "same-file"]
  ] as const)(
    "shares non-conflicting CSS scopes across separate owners (dist chunk: %s, origins: %s)",
    async (distChunk, origins) => {
      const result = await build(
        await separateOwnerFixture(distChunk, origins)
      );
      const output = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = output
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("color: red");
      expect(css).toContain("padding: 12px");
      if (origins === "different-files") expect(css).toContain("color: blue");
    }
  );

  it("releases CSS scopes when an owner stops emitting styles", async () => {
    const options = await separateOwnerFixture(false);
    const server = await createServer({
      ...options,
      esbuild: { jsx: "transform", jsxFactory: "jsx" },
      server: {
        middlewareMode: true,
        preTransformRequests: false,
        watch: null
      },
      appType: "custom"
    });
    const transformOwner = async (name: string) => {
      await server.transformRequest(`/${name}.tsx`);
      const owner = server.moduleGraph.getModuleById(
        resolve(options.root, `${name}.tsx`)
      );
      const sidecar = [...(owner?.importedModules ?? [])].find((module) =>
        module.id?.startsWith("\0mincho-extracted-css:")
      );
      expect(sidecar).toBeDefined();
      return server.transformRequest(sidecar!.url);
    };

    try {
      await transformOwner("first");
      await expect(transformOwner("second")).rejects.toThrow(
        'Ambiguous CSS file scope "index.mjs" in package "separate-owner-package"'
      );

      await writeFile(
        resolve(options.root, "first.tsx"),
        "export const first = () => <div />;"
      );
      server.moduleGraph.invalidateAll();
      await server.transformRequest("/first.tsx");

      await expect(transformOwner("second")).resolves.not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "releases CSS scopes for owners pruned by the dev graph (dist-chunk: %s)",
    async (distChunk) => {
      const options = await separateOwnerFixture(distChunk);
      const entry = resolve(options.root, "entry.tsx");
      const otherEntry = resolve(options.root, "other-entry.tsx");
      await writeFile(entry, 'export { first } from "./first";');
      const server = await createServer({
        ...options,
        esbuild: { jsx: "transform", jsxFactory: "jsx" },
        server: {
          middlewareMode: true,
          preTransformRequests: false,
          watch: null
        },
        appType: "custom"
      });
      const sent = vi.spyOn(server.environments.client.hot, "send");
      const transformOwner = async (name: string) => {
        await server.transformRequest(`/${name}.tsx`);
        const owner = server.moduleGraph.getModuleById(
          resolve(options.root, `${name}.tsx`)
        );
        const sidecar = [...(owner?.importedModules ?? [])].find((module) =>
          module.id?.startsWith("\0mincho-extracted-css:")
        );
        expect(sidecar).toBeDefined();
        await server.transformRequest(sidecar!.url);
        const cssModules = [...sidecar!.importedModules].filter((module) =>
          module.id?.endsWith(".vanilla.css")
        );
        expect(cssModules.length).toBeGreaterThan(0);
        return (
          await Promise.all(
            cssModules.map((module) => server.transformRequest(module.url))
          )
        )
          .map((result) => result?.code)
          .join("\n");
      };

      try {
        await server.transformRequest("/entry.tsx");
        expect(await transformOwner("first")).toContain("color: red");
        const first = server.environments.client.moduleGraph.getModuleById(
          resolve(options.root, "first.tsx")
        )!;
        expect(first.importers.size).toBe(1);

        await writeFile(entry, 'export { second } from "./second";');
        server.moduleGraph.invalidateModule(
          server.moduleGraph.getModuleById(entry)!
        );
        await server.transformRequest("/entry.tsx");
        expect(first.importers.size).toBe(0);
        expect(
          sent.mock.calls.some(
            ([payload]: [HMRPayload | string, ...unknown[]]) =>
              typeof payload === "object" &&
              payload.type === "prune" &&
              payload.paths.includes(first.url)
          )
        ).toBe(true);
        expect(
          await readFile(resolve(options.root, "first.tsx"), "utf8")
        ).toContain("padding: 12");
        expect(await transformOwner("second")).toContain("color: blue");
        const second = server.moduleGraph.getModuleById(
          resolve(options.root, "second.tsx")
        )!;
        const cachedSecond = second.transformResult;
        await writeFile(otherEntry, 'export { second } from "./second";');
        await server.transformRequest("/other-entry.tsx");
        expect(second.importers.size).toBe(2);

        await writeFile(entry, 'export { first } from "./first";');
        server.moduleGraph.invalidateModule(
          server.moduleGraph.getModuleById(entry)!
        );
        await server.transformRequest("/entry.tsx");
        expect(second.importers.size).toBe(1);
        expect(second.transformResult).toBe(cachedSecond);
        await expect(transformOwner("first")).rejects.toThrow(
          'Ambiguous CSS file scope "index.mjs" in package "separate-owner-package"'
        );
      } finally {
        sent.mockRestore();
        await server.close();
      }
    }
  );

  it.each([false, true])(
    "checks only active watch owners while retaining cached scopes (dist-chunk: %s)",
    async (distChunk) => {
      const options = await separateOwnerFixture(distChunk);
      const entry = resolve(options.root, "entry.tsx");
      const ownerSource =
        "export const Component = () => <div css={{ padding: 12 }} />;";
      await Promise.all(
        ["first", "second"].map((name) =>
          writeFile(resolve(options.root, `${name}.tsx`), ownerSource)
        )
      );
      await writeFile(entry, 'export { Component } from "./first";');

      let css = "";
      let secondTransforms = 0;
      const closingResults: Promise<void>[] = [];
      const watcher = (await build({
        ...options,
        plugins: [
          ...options.plugins,
          {
            name: "observe-active-scope-watch",
            transform: {
              filter: { id: /\.tsx$/ },
              handler(_source, id) {
                if (id === resolve(options.root, "second.tsx"))
                  secondTransforms++;
              }
            },
            generateBundle(_options, bundle) {
              css = Object.values(bundle)
                .flatMap((item) =>
                  item.type === "asset" && item.fileName.endsWith(".css")
                    ? [String(item.source)]
                    : []
                )
                .join("\n");
            }
          }
        ],
        build: { ...options.build, watch: { buildDelay: 20 } }
      })) as Rollup.RollupWatcher;
      const nextBuild = () =>
        new Promise<Rollup.RollupError | undefined>((resolve) => {
          let error: Rollup.RollupError | undefined;
          const onEvent = (event: Rollup.RollupWatcherEvent) => {
            if (event.code === "ERROR") error = event.error;
            if (event.code === "BUNDLE_END")
              closingResults.push(event.result.close());
            if (event.code === "END") {
              watcher.off("event", onEvent);
              resolve(error);
            }
          };

          watcher.on("event", onEvent);
        });

      try {
        expect(await nextBuild()).toBeUndefined();
        expect(css).toContain("color: red");

        const changed = nextBuild();
        await writeFile(entry, 'export { Component } from "./second";');
        expect(await changed).toBeUndefined();
        expect(css).toContain("color: blue");
        expect(css).not.toContain("color: red");
        expect(
          await readFile(resolve(options.root, "first.tsx"), "utf8")
        ).toContain("padding: 12");

        const cachedTransforms = secondTransforms;
        const conflicting = nextBuild();
        await writeFile(
          entry,
          'export { Component as first } from "./first"; export { Component as second } from "./second";'
        );
        expect((await conflicting)?.message).toContain(
          'Ambiguous CSS file scope "index.mjs" in package "separate-owner-package"'
        );
        expect(secondTransforms).toBe(cachedTransforms);
      } finally {
        await watcher.close();
        await Promise.allSettled(closingResults);
      }
    }
  );

  it.each([false, true])(
    "keeps dependency CSS from equal package-relative filenames distinct (dist-chunk: %s)",
    async (distChunk) => {
      const options = await fixture();
      const cssModules = new Set<string>();

      for (const [name, color] of [
        ["first", "red"],
        ["second", "blue"]
      ] as const) {
        const directory = resolve(options.root, name);
        await mkdir(directory);
        await writeFile(
          resolve(directory, "package.json"),
          JSON.stringify({ name: `css-source-${name}`, type: "module" })
        );
        await writeFile(
          resolve(directory, "index.mjs"),
          `import {style} from "@vanilla-extract/css";
        export const className=style({color:${JSON.stringify(color)}});`
        );
      }

      await writeFile(
        resolve(options.root, "preset.ts"),
        `import {css as nativeCss} from "@mincho-js/css";
      import {className as first} from "./first/index.mjs";
      import {className as second} from "./second/index.mjs";
      export const css = rule => nativeCss([first, second, rule]);`
      );
      await writeFile(
        resolve(options.root, "entry.tsx"),
        "export const Button = () => <button css={{padding: 12}} />;"
      );
      const result = await build({
        ...options,
        plugins: [
          {
            name: "observe-package-css-sources",
            moduleParsed({ id }) {
              if (id.endsWith(".css")) cssModules.add(id);
            }
          },
          minchoVitePlugin({
            jsxCssProp: { importSource: "test-preset" },
            appCss: { mode: distChunk ? "dist-chunk" : "native" }
          }),
          ...(distChunk ? [] : [vanillaExtractPlugin()])
        ],
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          rollupOptions: {
            input: resolve(options.root, "entry.tsx"),
            preserveEntrySignatures: "strict",
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const output = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );

      for (const item of output) {
        if (item.type !== "chunk") continue;

        for (const id of Object.keys(item.modules)) {
          if (id.endsWith(".css")) cssModules.add(id);
        }
      }

      const css = output
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("color: red");
      expect(css).toContain("color: blue");
      expect(css).toContain("padding: 12px");
      for (const name of ["first", "second"]) {
        const original = resolve(options.root, name, "index.mjs");

        if (distChunk) {
          expect([...cssModules]).toEqual(
            expect.arrayContaining([
              expect.stringContaining(`${original}.vanilla.css.mincho-`)
            ])
          );
        } else {
          const origin = original.replaceAll("\\", "/");
          const scopeIdentity = createHash("sha256")
            .update(
              JSON.stringify([
                `css-source-${name}`,
                `${name}/index.mjs`,
                origin
              ])
            )
            .digest("hex");
          expect(cssModules).toContain(
            `${origin}.mincho-scope-${scopeIdentity}.vanilla.css`
          );
        }
      }
    }
  );

  it.each([false, true])(
    "keeps compiler-generated CSS scopes from duplicate package instances distinct (dist chunk: %s)",
    async (distChunk) => {
      const options = await fixture();

      for (const [name, color] of [
        ["first", "red"],
        ["second", "blue"]
      ]) {
        const directory = resolve(options.root, name);
        await mkdir(directory);
        await writeFile(
          resolve(directory, "package.json"),
          JSON.stringify({ name: "duplicate-css-package", type: "module" })
        );
        await writeFile(
          resolve(directory, "asset.svg"),
          `<svg xmlns="http://www.w3.org/2000/svg"><path fill="${color}"/></svg>`
        );
        await writeFile(
          resolve(directory, "index.mjs"),
          `import { style } from "@vanilla-extract/css";
export const className = style({ color: "${color}", backgroundImage: "url('./asset.svg')" });`
        );
      }

      await writeFile(
        resolve(options.root, "preset.ts"),
        `import { css as nativeCss } from "@mincho-js/css";
import { className as first } from "./first/index.mjs";
import { className as second } from "./second/index.mjs";
export const css = (rule) => nativeCss([first, second, rule]);`
      );
      await writeFile(
        resolve(options.root, "entry.tsx"),
        `export const view = <div css={{ padding: 12 }} />;`
      );

      const result = build({
        ...options,
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          assetsInlineLimit: 0,
          rollupOptions: {
            input: resolve(options.root, "entry.tsx"),
            preserveEntrySignatures: "strict",
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        },
        plugins: [
          minchoVitePlugin({
            jsxCssProp: { importSource: "test-preset" },
            appCss: { mode: distChunk ? "dist-chunk" : "native" }
          }),
          ...(!distChunk ? [vanillaExtractPlugin()] : [])
        ]
      });

      const built = await result;
      const output = (Array.isArray(built) ? built : [built]).flatMap((item) =>
        "output" in item ? item.output : []
      );
      const css = output
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");
      const red = css.match(/(\.[\w-]+)\s*\{[^}]*color:\s*red[;}]/)?.[1];
      const blue = css.match(/(\.[\w-]+)\s*\{[^}]*color:\s*blue[;}]/)?.[1];
      expect(red).toBeDefined();
      expect(blue).toBeDefined();
      expect(red).not.toBe(blue);
      expect(css).toContain("padding: 12px");
      const assets = output.filter(
        (item) => item.type === "asset" && item.fileName.endsWith(".svg")
      );
      expect(assets).toHaveLength(2);
      for (const color of ["red", "blue"]) {
        const asset = assets.find(
          (item) =>
            item.type === "asset" &&
            String(item.source).includes(`fill="${color}"`)
        );
        expect(asset).toBeDefined();
        const rule = css.match(
          new RegExp(`\\.[\\w-]+\\s*\\{[^}]*color:\\s*${color}[;}][^}]*\\}`)
        )?.[0];
        expect(rule).toContain(asset!.fileName);
      }
    }
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])(
    "keeps unambiguous same-package CSS origins (dist chunk: %s, symlink: %s)",
    async (distChunk, linked) => {
      const options = await fixture();

      for (const [name, color] of [
        ["first", "red"],
        ["second", "blue"]
      ]) {
        const directory = resolve(options.root, name);

        if (linked && name === "second") {
          await symlink(resolve(options.root, "first"), directory, "junction");
          continue;
        }

        await mkdir(directory);
        await writeFile(
          resolve(directory, "package.json"),
          JSON.stringify({ name: "shared-css-package", type: "module" })
        );
        await writeFile(
          resolve(directory, "asset.svg"),
          `<svg xmlns="http://www.w3.org/2000/svg"><path fill="${color}"/></svg>`
        );
        await writeFile(
          resolve(directory, linked ? "index.mjs" : `${color}.mjs`),
          `import { style } from "@vanilla-extract/css";
export const className = style({ color: "${color}", backgroundImage: "url('./asset.svg')" });`
        );
      }

      await writeFile(
        resolve(options.root, "preset.ts"),
        `import { css as nativeCss } from "@mincho-js/css";
import { className as first } from "./first/${linked ? "index" : "red"}.mjs";
import { className as second } from "./second/${linked ? "index" : "blue"}.mjs";
export const css = (rule) => nativeCss([first, second, rule]);`
      );
      await writeFile(
        resolve(options.root, "entry.tsx"),
        `export const view = <div css={{ padding: 12 }} />;`
      );

      const result = await build({
        ...options,
        base: "/demo/",
        resolve: { ...options.resolve, preserveSymlinks: linked },
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          assetsInlineLimit: 0,
          rollupOptions: {
            input: resolve(options.root, "entry.tsx"),
            preserveEntrySignatures: "strict",
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        },
        plugins: [
          minchoVitePlugin({
            jsxCssProp: { importSource: "test-preset" },
            appCss: { mode: distChunk ? "dist-chunk" : "native" }
          }),
          ...(!distChunk ? [vanillaExtractPlugin()] : [])
        ]
      });
      const output = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = output
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");
      const images = output.flatMap((item) =>
        item.type === "asset" && item.fileName.endsWith(".svg") ? [item] : []
      );

      expect(css).toContain("color: red");
      expect(css).toContain("padding: 12px");
      if (!linked) expect(css).toContain("color: blue");

      expect(images).toHaveLength(linked ? 1 : 2);
      const imageContents = images
        .map((image) => String(image.source))
        .join("\n");
      expect(imageContents).toContain('fill="red"');
      if (!linked) expect(imageContents).toContain('fill="blue"');

      const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(
        (match) => match[1]!
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(images.some((image) => url === `/demo/${image.fileName}`)).toBe(
          true
        );
      }
    }
  );

  it("lets native Vite resolve relative, inline, public and external CSS URLs", async () => {
    const options = await fixture();
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="red"/></svg>';
    await writeFile(resolve(options.root, "asset.svg"), image);
    await writeFile(resolve(options.root, "inline.svg"), image);
    await mkdir(resolve(options.root, "public"));
    await writeFile(resolve(options.root, "public/public.svg"), image);
    await writeFile(
      resolve(options.root, "preset.ts"),
      'export { css } from "@mincho-js/css";'
    );
    const background = resolve(options.root, "background.ts");
    await writeFile(background, 'export const image = "url(./asset.svg)";');
    await writeFile(
      resolve(options.root, "entry.tsx"),
      `import { image } from "./background";
      export const view = <>
        <div css={{backgroundImage: image}} />
        <div css={{backgroundImage: "url('./inline.svg?inline')"}} />
        <div css={{backgroundImage: "url('/public.svg')"}} />
        <div css={{backgroundImage: "url('https://cdn.example.test/image.svg')"}} />
        <div css={{backgroundImage: "url('data:image/png;base64,AAAA')"}} />
      </>;`
    );
    const result = await build({
      ...options,
      base: "/demo/",
      build: {
        write: true,
        minify: false,
        cssMinify: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: resolve(options.root, "entry.tsx"),
          preserveEntrySignatures: "strict",
          external: (id) => id.startsWith("@mincho-js/react/")
        }
      }
    });
    const output = (Array.isArray(result) ? result : [result]).flatMap(
      (item) => ("output" in item ? item.output : [])
    );
    const css = output
      .flatMap((item) =>
        item.type === "asset" && item.fileName.endsWith(".css")
          ? [String(item.source)]
          : []
      )
      .join("\n");
    const emitted = output.filter((item) => item.fileName.endsWith(".svg"));
    expect(emitted).toHaveLength(1);
    expect(css).toContain(`/demo/${emitted[0]!.fileName}`);
    expect(css).toContain("data:image/svg+xml");
    expect(css).toContain("/demo/public.svg");
    expect(css).toContain("https://cdn.example.test/image.svg");
    expect(css).toContain("data:image/png;base64,AAAA");
    expect(
      await readFile(resolve(options.root, "dist/public.svg"), "utf8")
    ).toBe(image);

    const server = await createServer({
      ...options,
      base: "/demo/",
      build: { assetsInlineLimit: 0 },
      plugins: [
        minchoVitePlugin({ jsxCssProp: { importSource: "test-preset" } }),
        vanillaExtractPlugin()
      ],
      esbuild: { jsx: "transform", jsxFactory: "jsx" },
      optimizeDeps: { noDiscovery: true, entries: [] },
      server: {
        host: "127.0.0.1",
        port: 0,
        preTransformRequests: false,
        watch: null
      }
    });
    try {
      await server.listen();
      await server.transformRequest("/entry.tsx");
      const sidecar = [...server.moduleGraph.idToModuleMap.values()].find(
        (module) => module.id?.startsWith("\0mincho-extracted-css:")
      );
      expect(sidecar).toBeDefined();
      await server.transformRequest(sidecar!.url);
      const cssModule = [...server.moduleGraph.idToModuleMap.values()].find(
        (module) => module.id?.endsWith(".vanilla.css")
      );
      expect(cssModule).toBeDefined();
      const style = await server.transformRequest(`${cssModule!.url}?direct`);
      expect(style?.code).toContain("/demo/asset.svg");
      expect(style?.code).toContain("/demo/public.svg");
      const address = server.httpServer!.address();
      if (!address || typeof address === "string")
        throw new Error("Expected a TCP server");
      const origin = `http://127.0.0.1:${address.port}`;
      for (const path of ["/demo/asset.svg", "/demo/public.svg"]) {
        const response = await fetch(new URL(path, origin));
        expect(response.headers.get("content-type")).toContain("image/svg+xml");
        expect(await response.text()).toBe(image);
      }

      await writeFile(
        resolve(options.root, "next.svg"),
        image.replace("red", "blue")
      );
      await writeFile(background, 'export const image = "url(./next.svg)";');
      await server.pluginContainer.watchChange(background, { event: "update" });
      await server.transformRequest("/entry.tsx");
      // Extraction can inline the updated value and change the sidecar hash.
      // Follow the owner's current import, just as the browser does during HMR.
      const updatedOwner = server.moduleGraph.getModuleById(
        resolve(options.root, "entry.tsx")
      );
      const updatedSidecar = [...(updatedOwner?.importedModules ?? [])].find(
        (module) => module.id?.startsWith("\0mincho-extracted-css:")
      );
      expect(updatedSidecar).toBeDefined();
      await server.transformRequest(updatedSidecar!.url);
      const updated = await server.transformRequest(`${cssModule!.url}?direct`);
      expect(updated?.code).toContain("/demo/next.svg");
      expect(updated?.code).not.toContain("/demo/asset.svg");
    } finally {
      await server.close();
    }
  });

  it.each(["CSS source", "authoring alias"])(
    "resolves a cold installed %s before dependency optimization",
    async (mode) => {
      const packageName = "cold-css-preset";
      const options = await fixture(
        mode === "CSS source" ? packageName : "test-preset"
      );
      const dependencyRoot = createRequire(
        resolve(options.root, "entry.tsx")
      ).resolve.paths(packageName)?.[0];

      if (!dependencyRoot)
        throw new Error("Fixture has no dependency search path");
      expect(dirname(dependencyRoot)).toBe(options.root);

      const directory = resolve(dependencyRoot, packageName);
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, "package.json"),
        JSON.stringify({
          name: packageName,
          type: "module",
          exports: "./index.js"
        })
      );
      await writeFile(
        resolve(directory, "index.js"),
        mode === "CSS source"
          ? await readFile(resolve(options.root, "preset.ts"), "utf8")
          : 'export const blue = "#147aff";'
      );
      await writeFile(
        resolve(directory, "tokens.js"),
        'export const blue = "#147aff";'
      );

      if (mode === "authoring alias") {
        const preset = resolve(options.root, "preset.ts");
        await writeFile(
          preset,
          (await readFile(preset, "utf8")).replace(
            'from "./tokens"',
            'from "@design/tokens"'
          )
        );
      }

      const server = await createServer({
        ...options,
        resolve: {
          alias: [
            ...options.resolve.alias,
            {
              find: mode === "CSS source" ? packageName : "@design/tokens",
              replacement: resolve(directory, "index.js")
            }
          ]
        },
        esbuild: { jsx: "transform", jsxFactory: "jsx" },
        optimizeDeps: { noDiscovery: false, entries: [] },
        server: {
          middlewareMode: true,
          preTransformRequests: false,
          watch: null
        },
        appType: "custom"
      });

      try {
        const entry = await server.transformRequest("/entry.tsx");
        expect(entry?.code).toContain("className");
        const sidecar = [...server.moduleGraph.idToModuleMap.values()].find(
          (module) => module.id?.startsWith("\0mincho-extracted-css:")
        );
        expect(sidecar).toBeDefined();
        const extracted = await server.transformRequest(sidecar!.url);
        expect(extracted?.code).toContain(".vanilla.css");
        const cssModules = [
          ...server.moduleGraph.idToModuleMap.values()
        ].filter((module) => module.id?.endsWith(".vanilla.css"));
        const css = (
          await Promise.all(
            cssModules.map((module) => server.transformRequest(module.url))
          )
        )
          .map((result) => result?.code)
          .join("\n");

        expect(css).toContain("background-color: #147aff");
        expect(css).toContain("padding-left: 12px");
        expect(css).toContain("padding-right: 12px");
      } finally {
        await server.close();
      }
    }
  );

  it.each(
    [false, true].flatMap((jsxCssProp) =>
      ["inline", "config hook", "post config hook"].map((aliasSource) => ({
        jsxCssProp,
        aliasSource
      }))
    )
  )(
    "resolves registered preset aliases from $aliasSource without a custom JSX CSS source (JSX: $jsxCssProp)",
    async ({ jsxCssProp, aliasSource }) => {
      const options = await fixture();
      await writeFile(
        resolve(options.root, "entry.tsx"),
        `import { css } from "test-preset";
         export const className = css({ bg: "blue", px: 3 });
         export const Button = () => <button className={className}${jsxCssProp ? " css={{ margin: 4 }}" : ""} />;`
      );
      const result = await build({
        ...options,
        resolve: aliasSource === "inline" ? options.resolve : { alias: [] },
        plugins: [
          minchoVitePlugin({
            jsxCssProp,
            extractCalls: { "test-preset": ["css"] }
          }),
          ...(aliasSource === "inline"
            ? []
            : [
                {
                  name: "configure-preset-alias-after-mincho",
                  enforce: "post",
                  config: {
                    ...(aliasSource === "post config hook"
                      ? { order: "post" as const }
                      : {}),
                    handler: () => ({ resolve: options.resolve })
                  }
                } satisfies Plugin
              ]),
          vanillaExtractPlugin()
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
      if (jsxCssProp) expect(css).toContain("margin: 4px");
      for (const output of outputs)
        if (output.type === "chunk")
          expect(output.code).not.toMatch(/\bdefineRules\s*\(/);
    }
  );

  it.each([false, true])(
    "preserves mixed import and require conditions for the configured CSS source (alias: %s)",
    async (aliased) => {
      const packageName = "jsx-css-source-fixture";
      const importSource = aliased ? "test-preset" : packageName;
      const options = await fixture(importSource);
      const packagePath = resolve(options.root, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

      packageJson.exports["."] = {
        import: "./preset-import.mjs",
        require: "./preset-require.cjs"
      };
      await writeFile(packagePath, JSON.stringify(packageJson));
      await writeFile(
        resolve(options.root, "preset-import.mjs"),
        `import { defineRules } from "@mincho-js/css";
         export const { css } = defineRules({ properties: {
           color: { tone: "#147aff" }, paddingLeft: true, paddingRight: true, margin: true
         } });`
      );
      await writeFile(
        resolve(options.root, "preset-require.cjs"),
        `const { defineRules } = require("@mincho-js/css");
         exports.css = defineRules({ properties: {
           color: { tone: "#ff6723" }, paddingLeft: true, paddingRight: true, margin: true
         } }).css;`
      );
      await writeFile(
        resolve(options.root, "entry.tsx"),
        `import { css as importedCss } from "${importSource}";
         const { css: requiredCss } = require("${importSource}");
         export const importedClass = importedCss({ color: "tone", paddingLeft: 12 });
         export const requiredClass = requiredCss({ color: "tone", paddingRight: 16 });
         export const Button = () => <button css={{ color: "tone", margin: 4 }} />;`
      );
      const result = await build({
        ...options,
        resolve: {
          alias: aliased
            ? [{ find: /^test-preset$/, replacement: packageName }]
            : []
        },
        esbuild: { jsx: "transform", jsxFactory: "jsx" },
        plugins: [
          minchoVitePlugin({
            jsxCssProp: { importSource },
            extractCalls: { [importSource]: ["css"] }
          }),
          vanillaExtractPlugin()
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["cjs"] }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("color: #147aff");
      expect(css).toContain("color: #ff6723");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 16px");
      expect(css).toContain("margin: 4px");
      const entry = outputs.find(
        (item) => item.type === "chunk" && item.isEntry
      );
      if (!entry || entry.type !== "chunk")
        throw new Error("Missing mixed-source fixture entry");

      const exports: { importedClass?: string; requiredClass?: string } = {};
      new Function("exports", "require", entry.code)(exports, (id: string) => {
        expect(
          outputs.some(
            (item) => item.type === "asset" && id === `./${item.fileName}`
          )
        ).toBe(true);
        return {};
      });
      expect(exports.importedClass).toBeTruthy();
      expect(exports.requiredClass).toBeTruthy();
      expect(exports.requiredClass).not.toBe(exports.importedClass);
      const declarations = new Map(
        [...css.matchAll(/\.([\w-]+)\s*\{([^}]+)\}/g)].map(
          ([, name, declaration]) => [name, declaration]
        )
      );
      const importedStyles = exports
        .importedClass!.split(" ")
        .map((name) => declarations.get(name))
        .join("\n");
      const requiredStyles = exports
        .requiredClass!.split(" ")
        .map((name) => declarations.get(name))
        .join("\n");

      expect(importedStyles).toContain("color: #147aff");
      expect(importedStyles).not.toContain("color: #ff6723");
      expect(requiredStyles).toContain("color: #ff6723");
      expect(requiredStyles).not.toContain("color: #147aff");
    }
  );

  it.each(["import", "require"])(
    "preserves %s conditions for an aliased authoring dependency",
    async (kind) => {
      const options = await fixture();
      const packagePath = resolve(options.root, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

      packageJson.exports["./tokens"] = {
        import: "./tokens-import.mjs",
        require: "./tokens-require.cjs"
      };
      await writeFile(packagePath, JSON.stringify(packageJson));
      await writeFile(
        resolve(options.root, "tokens-import.mjs"),
        'export const blue = "#147aff";'
      );
      await writeFile(
        resolve(options.root, "tokens-require.cjs"),
        'exports.blue = "#ff6723";'
      );
      const preset = resolve(options.root, "preset.ts");

      await writeFile(
        preset,
        (await readFile(preset, "utf8")).replace(
          'import { blue } from "./tokens";',
          kind === "import"
            ? 'import { blue } from "@design/tokens";'
            : 'const { blue } = require("@design/tokens");'
        )
      );
      const result = await build({
        ...options,
        resolve: {
          alias: [
            ...options.resolve.alias,
            {
              find: /^@design\/tokens$/,
              replacement: "jsx-css-source-fixture/tokens"
            }
          ]
        },
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain(
        `background-color: ${kind === "import" ? "#147aff" : "#ff6723"}`
      );
      expect(css).not.toContain(kind === "import" ? "#ff6723" : "#147aff");
    }
  );

  it.each(["string prefix", "regular expression"])(
    "resolves an authoring source dependency through a %s alias",
    async (kind) => {
      const options = await fixture();
      const preset = resolve(options.root, "preset.ts");

      await writeFile(
        preset,
        (await readFile(preset, "utf8")).replace(
          'from "./tokens"',
          'from "@design/tokens"'
        )
      );

      const alias =
        kind === "string prefix"
          ? { find: "@design", replacement: options.root }
          : {
              find: /^@design\/(.+)$/,
              replacement: `${options.root}/$1`
            };
      const result = await build({
        ...options,
        resolve: { alias: [...options.resolve.alias, alias] },
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");
      const javascript = outputs
        .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
      expect(javascript).toContain("className");
      expect(javascript).not.toMatch(/defineRules|@design|test-preset|css:/);
    }
  );

  it.each(
    [false, true, undefined].flatMap((moduleSideEffects) =>
      [false, true].map((external) => ({ moduleSideEffects, external }))
    )
  )(
    "preserves alias resolver moduleSideEffects=$moduleSideEffects with external=$external",
    async ({ moduleSideEffects, external }) => {
      const options = await fixture();
      const unused = resolve(options.root, "unused.ts");

      await writeFile(
        resolve(options.root, "tokens.ts"),
        `export const blue = "#147aff";
         export { unused } from "@design/unused";`
      );
      await writeFile(
        unused,
        `throw new Error("unused authoring alias evaluated");
         export const unused = true;`
      );

      const compilation = build({
        ...options,
        resolve: {
          alias: [
            ...options.resolve.alias,
            {
              find: "@design/unused",
              replacement: unused,
              customResolver: () => ({
                id: unused,
                moduleSideEffects,
                external
              })
            }
          ]
        },
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });

      if (moduleSideEffects !== false) {
        await expect(compilation).rejects.toThrow(
          "unused authoring alias evaluated"
        );
        return;
      }

      const result = await compilation;
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
    }
  );

  it.each([false, true])(
    "resolves a plugin-only source for a symlinked component (preserveSymlinks: %s)",
    async (preserveSymlinks) => {
      const importSource = "plugin-only-preset";
      const options = await fixture(importSource);
      const components = resolve(options.root, "components");
      const linkedComponents = resolve(options.root, "linked-components");
      await mkdir(components);
      await writeFile(
        resolve(components, "button.tsx"),
        'export const Button = () => <button css={{bg: "blue", px: 3}} />;'
      );
      await symlink(components, linkedComponents, "junction");

      const sourcePlugin: Plugin = {
        name: "plugin-only-css-source",
        resolveId(id) {
          if (id === importSource) return resolve(options.root, "preset.ts");
        }
      };
      const result = await build({
        ...options,
        resolve: { ...options.resolve, preserveSymlinks },
        plugins: [sourcePlugin, ...options.plugins],
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: {
            entry: resolve(linkedComponents, "button.tsx"),
            formats: ["es"]
          },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");
      const javascript = outputs
        .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
      expect(javascript).toContain("className");
      expect(javascript).not.toMatch(/defineRules|plugin-only-preset|css:/);
    }
  );

  it.each(["query", "cache query", "fragment", "filesystem URL"])(
    "compiles a physical authoring source resolved with a %s",
    async (decoration) => {
      const importSource = "decorated-preset";
      const options = await fixture(importSource);
      const physicalPath = resolve(options.root, "preset.ts");
      const suffix =
        decoration === "fragment"
          ? "#preset?raw"
          : `?${decoration === "cache query" ? "import&t=1234567890123&v=abc" : "import"}#preset`;
      const resolvedId = `${decoration === "filesystem URL" ? "/@fs" : ""}${physicalPath}${suffix}`;
      const decoratedSource: Plugin = {
        name: "decorated-css-source",
        resolveId(id) {
          if (id === importSource) return resolvedId;
        }
      };
      const result = await build({
        ...options,
        plugins: [decoratedSource, ...options.plugins],
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => ("output" in item ? item.output : [])
      );
      const css = outputs
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");
      const javascript = outputs
        .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
      expect(javascript).toContain("className");
      expect(javascript).not.toMatch(
        /defineRules|decorated-preset|compileCSSRule|css:/
      );
    }
  );

  it.each(
    ["raw", "url", "custom-loader", "import&raw"].flatMap((query) =>
      [
        "authoring source",
        "transitive JSON alias",
        ...(query === "raw" ? ["registered call"] : [])
      ].map((target) => ({ query, target }))
    )
  )(
    "rejects a $query loader query on the $target",
    async ({ query, target }) => {
      const registeredCall = target === "registered call";
      const importSource = registeredCall ? "test-preset" : "loader-preset";
      const options = await fixture(importSource);
      const physicalPath = resolve(options.root, "preset.ts");
      const tokensPath = resolve(options.root, "tokens.json");
      const transitive = target !== "authoring source";

      if (registeredCall) {
        await writeFile(
          resolve(options.root, "entry.tsx"),
          `import { css } from "test-preset";
         export const className = css({ bg: "blue", px: 3 });`
        );
      }

      if (transitive) {
        await writeFile(tokensPath, JSON.stringify({ blue: "#ff6723" }));
        const preset = await readFile(physicalPath, "utf8");
        await writeFile(
          physicalPath,
          preset.replace(
            'import { blue } from "./tokens";',
            `import tokenData from "@design/tokens";
           const blue = typeof tokenData === "string" ? "#147aff" : tokenData.blue;`
          )
        );
      }

      const loaderSource: Plugin = {
        name: "loader-query-css-source",
        resolveId(id) {
          if (id === importSource)
            return transitive ? physicalPath : `${physicalPath}?${query}`;
        }
      };

      await expect(
        build({
          ...options,
          resolve: {
            alias: [
              { find: "@design/tokens", replacement: `${tokensPath}?${query}` },
              ...options.resolve.alias
            ]
          },
          plugins: registeredCall
            ? [
                minchoVitePlugin({
                  jsxCssProp: false,
                  extractCalls: { "test-preset": ["css"] }
                }),
                vanillaExtractPlugin()
              ]
            : [loaderSource, ...options.plugins],
          build: {
            write: false,
            minify: false,
            cssCodeSplit: true,
            lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
            rollupOptions: {
              external: (id) => id.startsWith("@mincho-js/react/")
            }
          }
        })
      ).rejects.toThrow(/cannot evaluate loader queries/);
    }
  );

  it.each(["\0virtual:css-source", "virtual:css-source"])(
    "rejects a non-physical authoring source resolved to %j",
    async (resolvedId) => {
      const source = "virtual:css-source";
      const options = await fixture(source);
      let loads = 0;

      const virtualSource: Plugin = {
        name: "virtual-css-source",
        resolveId(id) {
          if (id === source) return resolvedId;
        },
        load(id) {
          if (id !== resolvedId) return;
          loads++;
          return 'export const css = () => "virtual-class";';
        }
      };

      await expect(
        build({
          ...options,
          esbuild: { jsx: "transform", jsxFactory: "jsx" },
          plugins: [virtualSource, ...options.plugins],
          build: {
            write: false,
            minify: false,
            lib: {
              entry: resolve(options.root, "entry.tsx"),
              formats: ["es"]
            }
          }
        })
      ).rejects.toThrow(
        'jsxCssProp.importSource "virtual:css-source" must resolve to a physical module file'
      );
      expect(loads).toBe(0);
    }
  );

  it("compiles static factories and preserves registered runtime recipe/cx selection", async () => {
    const options = await fixture();
    await writeFile(
      resolve(options.root, "theme.css.ts"),
      `
      import {rules} from "./preset";
      export function getStyles() { return {px: 3}; }
      export function getEmptyStyles() { return {}; }
      export const recipe = rules({
        base: {bg: "blue"},
        variants: {tone: {square: {borderRadius: 0}, rounded: {borderRadius: "4px"}}}
      });
    `
    );
    await writeFile(
      resolve(options.root, "entry.tsx"),
      `
      import {cx} from "test-preset";
      import {getStyles, getEmptyStyles, recipe} from "./theme.css";
      export const Static = () => <div css={getStyles()} />;
      export const Recipe = ({tone}) => <button css={recipe({tone})} />;
      export const Dynamic = ({active, tone}) => <button css={cx("external", active && recipe({tone}))} />;
      export const DynamicArray = ({active, tone}) => <button css={cx(["external", active && recipe({tone})])} />;
      export const Or = ({base, fallback}) => <div css={cx(base, getEmptyStyles() || fallback())} />;
    `
    );
    const result = await build({
      ...options,
      esbuild: { jsx: "transform", jsxFactory: "jsx" },
      plugins: [
        minchoVitePlugin({
          jsxCssProp: { importSource: "test-preset" },
          extractCalls: { "test-preset": ["css", "rules", "cx"] },
          optimize: { pureFunctions: false }
        }),
        vanillaExtractPlugin()
      ],
      build: {
        write: false,
        minify: false,
        cssCodeSplit: true,
        lib: { entry: resolve(options.root, "entry.tsx"), formats: ["cjs"] }
      }
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (item) => ("output" in item ? item.output : [])
    );
    const entry = outputs.find((item) => item.type === "chunk" && item.isEntry);
    const runtime = outputs
      .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
      .join("\n");
    const css = outputs
      .flatMap((item) =>
        item.type === "asset" && item.fileName.endsWith(".css")
          ? [String(item.source)]
          : []
      )
      .join("\n");
    if (!entry || entry.type !== "chunk")
      throw new Error("Missing callable fixture entry");

    const exports: Record<
      string,
      (props?: {
        active?: boolean;
        tone?: "rounded" | "square";
        base?: string;
        fallback?: () => string;
      }) => {
        props: { className: string };
      }
    > = {};
    const requireModule = createRequire(resolve(options.root, "package.json"));

    new Function("exports", "jsx", "require", entry.code)(
      exports,
      (type: string, props: { className: string }) => ({ type, props }),
      (id: string) => {
        if (
          outputs.some(
            (item) =>
              item.type === "asset" &&
              item.fileName.endsWith(".css") &&
              id === `./${item.fileName}`
          )
        ) {
          return {};
        }

        expect([
          "@mincho-js/css/classname",
          "@mincho-js/css/rules/createRuntimeFn",
          "@mincho-js/css/rules/createClassRuntimeFn",
          "@mincho-js/css/defineRules/createDefineRulesCxRuntime"
        ]).toContain(id);
        return requireModule(id);
      }
    );

    expect(css).toContain("padding-left: 12px");
    expect(css).toContain("padding-right: 12px");
    expect(css).toContain("background-color: #147aff");
    expect(css).toContain("border-radius: 4px");
    expect(css).toContain("border-radius: 0");
    expect(exports.Static!().props.className).toBeTruthy();
    const rounded = exports.Recipe!({ tone: "rounded" }).props.className;
    const square = exports.Recipe!({ tone: "square" }).props.className;
    expect(rounded).not.toBe(square);
    for (const render of [exports.Dynamic!, exports.DynamicArray!]) {
      expect(render({ active: true, tone: "rounded" }).props.className).toBe(
        `external ${rounded}`
      );
      expect(render({ active: false, tone: "square" }).props.className).toBe(
        "external"
      );
    }
    const fallback = vi.fn(() => "fallback");
    expect(exports.Or!({ base: "external", fallback }).props.className).toBe(
      "external"
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(runtime).not.toMatch(
      /\bdefineRules\s*\(|compileCSSRule|__mincho__|__recipe__|getStyles|getEmptyStyles|static token values/
    );
  });

  it.each(["test-preset", "@mincho-js"])(
    "resolves %s in production while preserving package subpaths",
    async (importSource) => {
      const options = await fixture(importSource);
      const result = await build({
        ...options,
        build: {
          write: false,
          minify: false,
          cssCodeSplit: true,
          lib: { entry: resolve(options.root, "entry.tsx"), formats: ["es"] },
          rollupOptions: {
            external: (id) => id.startsWith("@mincho-js/react/")
          }
        }
      });
      const output = Array.isArray(result) ? result : [result];
      const chunks = output.flatMap((item) =>
        "output" in item ? item.output : []
      );
      const javascript = chunks
        .filter((item) => item.type === "chunk")
        .map((item) => item.code)
        .join("\n");
      const css = chunks
        .flatMap((item) =>
          item.type === "asset" && item.fileName.endsWith(".css")
            ? [String(item.source)]
            : []
        )
        .join("\n");

      expect(css).toContain("background-color: #147aff");
      expect(css).toContain("padding-left: 12px");
      expect(css).toContain("padding-right: 12px");
      expect(css).toContain("border-radius: 4px");
      expect(javascript).toContain("className");
      expect(javascript).not.toMatch(
        /defineRules|test-preset|compileCSSRule|__mincho__|css:/
      );
    }
  );

  it("applies configured class-only props during dev without an extracted CSS module", async () => {
    const options = await fixture();
    await writeFile(
      resolve(options.root, "entry.tsx"),
      `export const ClassName = ({value}) => <span css={value} />;`
    );
    const server = await createServer({
      ...options,
      esbuild: { jsx: "transform", jsxFactory: "jsx" },
      server: { middlewareMode: true },
      appType: "custom"
    });

    try {
      const result = await server.transformRequest("/entry.tsx");
      expect(result?.code).toMatch(/className: (?:_cx\()?value/);
      expect(result?.code).not.toContain("css: value");
    } finally {
      await server.close();
    }
  });
});

it("resolves a registered authoring alias from its component importer", async () => {
  const options = await fixture();
  const entry = resolve(options.root, "entry.tsx");
  const red = resolve(options.root, "red-preset.ts");
  const blue = resolve(options.root, "blue-preset.ts");
  const redTone = resolve(options.root, "red-tone.ts");
  const blueTone = resolve(options.root, "blue-tone.ts");
  await Promise.all([
    writeFile(redTone, 'export const tone = "#a91225";'),
    writeFile(blueTone, 'export const tone = "#1625bc";')
  ]);
  for (const file of [red, blue]) {
    await writeFile(
      file,
      `
      import { style } from "@vanilla-extract/css";
      import { tone } from "registered-tone";
      export { tone };
      export function make() { return style({ color: tone }); }
    `
    );
  }
  const requests: string[] = [];
  const transitiveRequests: string[] = [];
  const resolveOptions = {
    alias: [
      {
        find: "registered-preset",
        replacement: red,
        customResolver(_target: string, importer?: string) {
          if (importer) requests.push(normalizePath(importer));
          return {
            id:
              importer && normalizePath(importer) === normalizePath(entry)
                ? red
                : blue
          };
        }
      },
      {
        find: "registered-tone",
        replacement: redTone,
        customResolver(_target: string, importer?: string) {
          if (importer) transitiveRequests.push(normalizePath(importer));
          return {
            id:
              importer && normalizePath(importer) === normalizePath(red)
                ? redTone
                : blueTone
          };
        }
      }
    ]
  };
  const config = {
    ...options,
    resolve: resolveOptions,
    build: {
      write: false,
      minify: false as const,
      cssCodeSplit: true,
      lib: { entry, formats: ["es" as const] }
    }
  };
  await writeFile(entry, 'export { tone } from "registered-preset";');
  const native = await build({ ...config, plugins: [vanillaExtractPlugin()] });
  const readOutputs = (value: typeof native) =>
    (Array.isArray(value) ? value : [value]).flatMap((item) =>
      "output" in item ? item.output : []
    );
  expect(
    readOutputs(native).some(
      (item) => item.type === "chunk" && item.code.includes("#a91225")
    )
  ).toBe(true);
  expect(requests).toContain(normalizePath(entry));
  requests.length = 0;
  transitiveRequests.length = 0;
  await writeFile(
    entry,
    'import { make } from "registered-preset"; export const cls = make();'
  );
  const compiled = await build({
    ...config,
    plugins: [
      minchoVitePlugin({
        extractCalls: {
          "./red-preset.ts": ["make"],
          "./blue-preset.ts": ["make"]
        }
      }),
      vanillaExtractPlugin()
    ]
  });
  const outputs = readOutputs(compiled);
  const css = outputs
    .flatMap((item) =>
      item.type === "asset" && item.fileName.endsWith(".css")
        ? [String(item.source)]
        : []
    )
    .join("\n");
  expect(css).toContain("color: #a91225");
  expect(css).not.toContain("#1625bc");
  const cssClass = css.match(/\.([\w-]+)\s*\{\s*color: #a91225/)?.[1];
  expect(cssClass).toBeTruthy();
  const javascript = outputs
    .flatMap((item) => (item.type === "chunk" ? [item.code] : []))
    .join("\n");
  expect(javascript).toContain(cssClass);
  expect(requests).toContain(normalizePath(entry));
  expect(transitiveRequests).toContain(normalizePath(red));
  expect(transitiveRequests).not.toContain(normalizePath(entry));
});

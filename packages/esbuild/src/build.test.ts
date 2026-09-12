import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { buildWithMincho } from "./build.js";
import { getBuildTransaction } from "./buildInputSnapshot.js";
import { collectDefineRulesPackageGraph } from "@mincho-js/integration";
import { defineRules } from "@mincho-js/css";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession
} from "@mincho-js/css/defineRules/registry";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import {
  setAdapter,
  removeAdapter,
  mockAdapter
} from "@vanilla-extract/css/adapter";
import { runInNewContext } from "node:vm";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { build as nativeBuild, type Plugin } from "esbuild";
import MagicString from "magic-string";

function actualPackageGraph() {
  beginDefineRulesRegistrySession();
  setAdapter(mockAdapter);

  try {
    setFileScope("a.css.ts", "@proof/a");

    const a = defineRules({ properties: { color: true } });
    a.css({ color: "red" });

    const aPreset = a.preset;
    endFileScope();
    setFileScope("b.css.ts", "@proof/b");

    const b = defineRules({ properties: { color: true }, presets: aPreset });
    b.css({ color: "blue" });

    const bPreset = b.preset;
    endFileScope();
    setFileScope("app.css.ts", "@proof/app");

    const app = defineRules({ properties: { color: true }, presets: bPreset });

    return collectDefineRulesPackageGraph([app.preset]);
  } finally {
    endFileScope();
    removeAdapter();
    endDefineRulesRegistrySession();
  }
}

const roots: string[] = [];

async function fixture(files: Record<string, string>) {
  const parent = resolve(process.cwd(), ".test-build-api");
  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(join(parent, "case-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([name, contents]) => {
      await fs.mkdir(join(root, name, ".."), { recursive: true });
      await fs.writeFile(join(root, name), contents);
    })
  );

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe("buildWithMincho transaction", () => {
  it.each(["", "?variant"])(
    "orders CSS for virtual entries with suffix %s",
    async (suffix) => {
      const root = await fixture({
        "body.js": 'import "@proof/b/style.css"; import "@proof/a/style.css";',
        "a.css": ".same{color:red}",
        "b.css": ".same{color:blue}"
      });

      const graph = actualPackageGraph();
      const result = await buildWithMincho({
        entryPoints: ["virtual-entry"],
        outdir: join(root, "out"),
        write: false,

        plugins: () => [
          {
            name: "virtual-entry",

            setup(build) {
              build.onResolve({ filter: /^virtual-entry$/ }, () => ({
                path: "entry.js",
                namespace: "virtual",
                suffix
              }));
              build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
                contents: `import ${JSON.stringify(join(root, "body.js"))};`,
                loader: "js",
                resolveDir: root
              }));
              build.onResolve(
                { filter: /^@proof\/(a|b)\/style.css$/ },
                (args) => ({
                  path: join(
                    root,
                    args.path.includes("/a/") ? "a.css" : "b.css"
                  )
                })
              );
              build.onLoad(
                { filter: /body\.js$/, namespace: "file" },
                (args) => {
                  getBuildTransaction(build.initialOptions)!.graphs.set(
                    args.path,
                    graph
                  );

                  return undefined;
                }
              );
            }
          }
        ]
      });

      const css = result.outputFiles!.find((file) =>
        file.path.endsWith(".css")
      )!.text;

      expect(css.indexOf("red")).toBeLessThan(css.indexOf("blue"));
    }
  );

  it("uses native loaders configured during plugin setup", async () => {
    const root = await fixture({
      "entry.js": 'export { default } from "./value.snippet";',
      "value.snippet": "hello from a native text loader"
    });

    const result = await buildWithMincho({
      entryPoints: [join(root, "entry.js")],
      outdir: join(root, "out"),
      write: false,

      plugins: () => [
        {
          name: "configure-loader",

          setup(build) {
            build.initialOptions.loader = { ".snippet": "text" };
          }
        }
      ]
    });

    expect(result.outputFiles![0]!.text).toContain(
      "hello from a native text loader"
    );
  });

  it.each([false, true])(
    "rolls back I/O failures (existing output: %s)",
    async (existing) => {
      const root = await fixture({
        "one.js": "export const one = 1;",
        "two.js": "export const two = 2;"
      });

      const output = join(root, "out");
      await fs.mkdir(join(output, "two.js"), { recursive: true });

      if (existing)
        await fs.writeFile(join(output, "one.js"), "previous output");

      await expect(
        buildWithMincho({
          entryPoints: [join(root, "one.js"), join(root, "two.js")],
          outdir: output
        })
      ).rejects.toThrow("Published paths:");

      if (existing)
        expect(await fs.readFile(join(output, "one.js"), "utf8")).toBe(
          "previous output"
        );
      else await expect(fs.stat(join(output, "one.js"))).rejects.toThrow();

      expect((await fs.stat(join(output, "two.js"))).isDirectory()).toBe(true);
    }
  );

  it.each([false, true])(
    "retains native TypeScript field and decorator semantics (legacy: %s)",
    async (legacy) => {
      const graph = actualPackageGraph();
      const root = await fixture({
        "entry.ts": `
      import "@proof/b/style.css";import "@proof/a/style.css";
      let calls = 0; let kind = "";
      function decorator(...args: any[]) { kind = typeof args[1] === "string" ? "legacy" : "standard"; }
      class Base { set value(v: number) { calls += v; } }
      class Child extends Base { value = 1; @decorator method() {} }
      new Child(); export { calls, kind };
    `,
        "a.css": ".same{color:red}",
        "b.css": ".same{color:blue}"
      });

      const plugin = (): Plugin => ({
        name: "raw-typescript",

        setup(build) {
          build.onResolve({ filter: /^@proof\/(a|b)\/style.css$/ }, (args) => ({
            path: join(root, args.path.includes("/a/") ? "a.css" : "b.css")
          }));
          build.onLoad({ filter: /entry\.ts$/ }, async (args) => {
            getBuildTransaction(build.initialOptions)?.graphs.set(
              args.path,
              graph
            );

            return {
              contents: await fs.readFile(args.path, "utf8"),
              loader: "ts",
              resolveDir: root
            };
          });
        }
      });

      const options = {
        entryPoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        format: "cjs" as const,
        write: false as const,
        bundle: true,
        target: "es2022",
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: legacy,
            useDefineForClassFields: !legacy
          }
        }
      };

      const baseline = await nativeBuild({ ...options, plugins: [plugin()] });
      const actual = await buildWithMincho({
        ...options,

        plugins: () => [plugin()]
      });

      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(code, { module, exports: module.exports });

        return { ...module.exports };
      };

      const expected = execute(
        baseline.outputFiles.find((output) => output.path.endsWith(".js"))!.text
      );

      expect(
        execute(
          actual.outputFiles!.find((output) => output.path.endsWith(".js"))!
            .text
        )
      ).toEqual(expected);
      expect(expected).toEqual({
        calls: legacy ? 1 : 0,
        kind: legacy ? "legacy" : "standard"
      });
    }
  );

  it("snapshots JSON consumed by isolated CSS compilation", async () => {
    const root = await fixture({
      "entry.ts":
        'import { css } from "@mincho-js/css";import data from "./data.json";export const color = css({ color: data.color });',
      "data.json": '{"color":"red"}'
    });

    await expect(
      buildWithMincho({
        entryPoints: [join(root, "entry.ts")],
        outdir: join(root, "out"),
        external: ["@mincho-js/css"],

        plugins: (phase) => [
          {
            name: "change-json",

            setup(build) {
              if (phase === "analyze")
                build.onEnd(async () => {
                  await fs.writeFile(
                    join(root, "data.json"),
                    '{"color":"blue"}'
                  );
                });
            }
          }
        ]
      })
    ).rejects.toThrow("changed between passes");
    await expect(fs.stat(join(root, "out"))).rejects.toThrow();
  });

  it.each(["direct", "indirect", "local"])(
    "validates package-local CSS ownership: %s",
    async (kind) => {
      const graph = actualPackageGraph();
      const root = await fixture({
        "entry.js": 'import "@proof/b/style.css";import "@proof/a/style.css";',
        "a.css": ".a{color:red}",
        "b.css":
          kind === "direct"
            ? '@import "./a.css";.b{color:blue}'
            : '@import "./fragment.css";.b{color:blue}',
        "fragment.css":
          kind === "indirect"
            ? '@import "./a.css";.fragment{padding:1px}'
            : ".fragment{padding:1px}"
      });

      const output = join(root, "out");

      const build = () =>
        buildWithMincho({
          entryPoints: [join(root, "entry.js")],
          outdir: output,

          plugins: () => [
            {
              name: "package-css-imports",

              setup(build) {
                build.onResolve(
                  { filter: /^@proof\/(a|b)\/style.css$/ },
                  (args) => ({
                    path: join(
                      root,
                      args.path.includes("/a/") ? "a.css" : "b.css"
                    )
                  })
                );
                build.onLoad({ filter: /entry\.js$/ }, (args) => {
                  getBuildTransaction(build.initialOptions)!.graphs.set(
                    args.path,
                    graph
                  );

                  return undefined;
                });
              }
            }
          ]
        });

      if (kind === "local") {
        await build();

        const css = await fs.readFile(join(output, "entry.css"), "utf8");

        expect(css.indexOf("red")).toBeLessThan(css.indexOf("blue"));
        expect(css).toContain("padding: 1px");
      } else {
        await expect(build()).rejects.toThrow(
          "@proof/b/style.css imports @proof/a/style.css through CSS @import"
        );
        await expect(fs.stat(output)).rejects.toThrow();
      }
    }
  );

  it("rejects two installed identities for one package CSS in the same output", async () => {
    const graph = actualPackageGraph();
    const root = await fixture({
      "entry.js":
        'import "./first.js";import "./second.js";import "@proof/b/style.css";',
      "first.js": 'import "@proof/a/style.css";',
      "second.js": 'import "@proof/a/style.css";',
      "a1.css": ".one{color:red}",
      "a2.css": ".two{color:green}",
      "b.css": ".same{color:blue}"
    });

    await expect(
      buildWithMincho({
        entryPoints: [join(root, "entry.js")],
        outdir: join(root, "out"),

        plugins: () => [
          {
            name: "duplicate-package",

            setup(build) {
              build.onResolve(
                { filter: /^@proof\/(a|b)\/style.css$/ },
                (args) => ({
                  path: join(
                    root,
                    args.path.includes("/b/")
                      ? "b.css"
                      : args.importer.endsWith("first.js")
                        ? "a1.css"
                        : "a2.css"
                  )
                })
              );
              build.onLoad({ filter: /entry\.js$/ }, (args) => {
                getBuildTransaction(build.initialOptions)!.graphs.set(
                  args.path,
                  graph
                );

                return undefined;
              });
            }
          }
        ]
      })
    ).rejects.toThrow("cannot establish CSS ownership");
    await expect(fs.stat(join(root, "out"))).rejects.toThrow();
  });

  it.each(["esm", "cjs"] as const)(
    "preserves CommonJS input interop with a CSS prelude in %s",
    async (format) => {
      const graph = actualPackageGraph();
      const root = await fixture({
        "entry.cjs":
          'require("@proof/b/style.css");require("@proof/a/style.css");module.exports={ named:42, default:7 };',
        "a.css": ".same{color:red}",
        "b.css": ".same{color:blue}"
      });

      const result = await buildWithMincho({
        entryPoints: [join(root, "entry.cjs")],
        outfile: join(root, "out", "entry.js"),
        write: false,
        format,

        plugins: () => [
          {
            name: "package-graph",

            setup(build) {
              build.onResolve(
                { filter: /^@proof\/(a|b)\/style.css$/ },
                (args) => ({
                  path: join(
                    root,
                    args.path.includes("/a/") ? "a.css" : "b.css"
                  )
                })
              );
              build.onLoad({ filter: /entry\.cjs$/ }, (args) => {
                getBuildTransaction(build.initialOptions)!.graphs.set(
                  args.path,
                  graph
                );

                return undefined;
              });
            }
          }
        ]
      });

      const code = result.outputFiles!.find((output) =>
        output.path.endsWith(".js")
      )!.text;

      if (format === "cjs") {
        const module = { exports: {} };
        runInNewContext(code, { module, exports: module.exports });

        expect(module.exports).toEqual({ named: 42, default: 7 });
      } else {
        const namespace = await import(
          `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
        );

        expect(namespace.default).toEqual({ named: 42, default: 7 });
      }

      const css = result.outputFiles!.find((output) =>
        output.path.endsWith(".css")
      )!.text;

      expect(css.indexOf("red")).toBeLessThan(css.indexOf("blue"));
    }
  );

  it.each(["none", "inline", "external"] as const)(
    "composes the prelude map with an %s input map",
    async (inputMap) => {
      const graph = actualPackageGraph();
      const root = await fixture({
        "entry.js":
          '"use strict";\nimport "@proof/b/style.css";\nimport "@proof/a/style.css";\nexport const marker = "original-marker";\n',
        "a.css": ".same{color:red}",
        "b.css": ".same{color:blue}"
      });

      let transformedSource: string | undefined;

      if (inputMap !== "none") {
        const edited = new MagicString(
          await fs.readFile(join(root, "entry.js"), "utf8")
        );

        edited.prepend("// upstream transform\n\n");

        const map = edited.generateMap({
          hires: true,
          includeContent: true,
          source:
            inputMap === "external"
              ? "../original.ts"
              : join(root, "original.ts")
        });

        if (inputMap === "external") {
          await fs.mkdir(join(root, "maps"));
          await fs.writeFile(
            join(root, "maps", "entry.js.map"),
            map.toString()
          );
        }

        transformedSource = `${edited.toString()}\n//# sourceMappingURL=${inputMap === "inline" ? map.toUrl() : "maps/entry.js.map"}\n`;
      }

      const result = await buildWithMincho({
        entryPoints: [join(root, "entry.js")],
        outdir: join(root, "out"),
        write: false,
        format: "esm",
        sourcemap: "external",

        plugins: () => [
          {
            name: "map-package-graph",

            setup(build) {
              build.onResolve(
                { filter: /^@proof\/(a|b)\/style.css$/ },
                (args) => ({
                  path: join(
                    root,
                    args.path.includes("/a/") ? "a.css" : "b.css"
                  )
                })
              );
              build.onLoad({ filter: /entry\.js$/ }, (args) => {
                getBuildTransaction(build.initialOptions)!.graphs.set(
                  args.path,
                  graph
                );

                return transformedSource
                  ? {
                      contents: transformedSource,
                      loader: "js",
                      resolveDir: root
                    }
                  : undefined;
              });
            }
          }
        ]
      });

      const code = result.outputFiles!.find((output) =>
        output.path.endsWith(".js")
      )!.text;

      const marker = code.indexOf('"original-marker"');
      const prefix = code.slice(0, marker).split("\n");
      const map = new TraceMap(
        JSON.parse(
          result.outputFiles!.find((output) => output.path.endsWith(".js.map"))!
            .text
        )
      );

      const original = originalPositionFor(map, {
        line: prefix.length,
        column: prefix.at(-1)!.length
      });

      expect(original.line).toBe(4);
      expect(original.column).toBe(22);
      expect(original.source).toMatch(
        inputMap === "none" ? /entry\.js$/ : /original\.ts$/
      );
    }
  );

  it("runs actual defineRules extraction and retains generated CSS in both passes", async () => {
    const root = await fixture({
      "entry.ts": `
      import { css as vanillaCss, defineRules } from "@mincho-js/css";
      export const { css: ruleCss, preset } = defineRules({ properties: { background: true } });
      export const blue = vanillaCss([ruleCss({ background: "blue" })]);
    `
    });

    const result = await buildWithMincho({
      entryPoints: [join(root, "entry.ts")],
      outdir: join(root, "out"),
      external: ["@mincho-js/css"],
      format: "esm",
      write: false
    });

    expect(
      result.outputFiles!.find((output) => output.path.endsWith(".css"))?.text
    ).toContain("background: blue");
  });

  it.each([false, true])(
    "orders actual package graphs across native lazy CSS (multiple entries: %s)",
    async (multipleEntries) => {
      const graph = actualPackageGraph();
      const root = await fixture({
        "entry.js":
          'import "@proof/b/style.css";export const load = () => import("./lazy.js");',
        "lazy.js":
          'import "@proof/a/style.css";import "@proof/b/style.css";export default 42;',
        "second.js": 'export { default } from "./lazy.js";',
        "a.css": ".same { color: red }",
        "b.css": ".same { color: blue }"
      });

      const result = await buildWithMincho({
        entryPoints: [
          join(root, "entry.js"),
          ...(multipleEntries ? [join(root, "second.js")] : [])
        ],
        outdir: join(root, "out"),
        splitting: true,
        format: "esm",
        write: false,
        metafile: true,
        sourcemap: "external",
        entryNames: "[name]-[hash]",

        plugins: () => [
          {
            name: "package-graph-fixture",

            setup(build) {
              build.onResolve(
                { filter: /^@proof\/(a|b)\/style.css$/ },
                (args) => ({
                  path: join(
                    root,
                    `${args.path.includes("/a/") ? "a" : "b"}.css`
                  )
                })
              );
              build.onLoad({ filter: /lazy\.js$/ }, (args) => {
                getBuildTransaction(build.initialOptions)!.graphs.set(
                  args.path,
                  graph
                );

                return undefined;
              });
            }
          }
        ]
      });

      const css = result.outputFiles!.filter((output) =>
        output.path.endsWith(".css")
      );

      expect(css.length).toBeGreaterThanOrEqual(2);

      for (const output of css)
        expect(output.text.indexOf("red")).toBeLessThan(
          output.text.indexOf("blue")
        );

      expect(
        result.outputFiles!.some((output) => /entry-.*\.js$/.test(output.path))
      ).toBe(true);
    }
  );

  it.each(["esm", "cjs"] as const)(
    "preserves %s exports, configured names and native source maps",
    async (format) => {
      const root = await fixture({
        "entry.ts": "export const marker = 42; export default marker;"
      });

      const result = await buildWithMincho({
        entryPoints: { custom: join(root, "entry.ts") },
        outdir: join(root, "out"),
        write: false,
        format,
        sourcemap: "external",
        entryNames: "[name]-[hash]",
        metafile: true
      });

      expect(
        result.outputFiles?.some((output) => /custom-.*\.js$/.test(output.path))
      ).toBe(true);
      expect(
        result.outputFiles?.find((output) => output.path.endsWith(".map"))?.text
      ).toContain("entry.ts");
      expect(
        result.outputFiles?.find((output) => output.path.endsWith(".js"))?.text
      ).toContain("marker");
      await expect(fs.stat(join(root, "out"))).rejects.toThrow();
    }
  );

  it("rejects changed virtual plugin inputs before publishing", async () => {
    const root = await fixture({
      "entry.js": 'export { value } from "virtual";'
    });

    await expect(
      buildWithMincho({
        entryPoints: [join(root, "entry.js")],
        outdir: join(root, "out"),

        plugins: (phase) => [
          {
            name: "virtual",

            setup(build) {
              build.onResolve({ filter: /^virtual$/ }, () => ({
                path: "value",
                namespace: "virtual"
              }));
              build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
                contents: `export const value = ${phase === "analyze" ? 1 : 2}`
              }));
            }
          }
        ]
      })
    ).rejects.toThrow("changed between passes");
    await expect(fs.stat(join(root, "out"))).rejects.toThrow();
  });

  it("rejects filesystem changes even when both passes use cached input bytes", async () => {
    const root = await fixture({ "entry.js": "export const value = 1" });

    await expect(
      buildWithMincho({
        entryPoints: [join(root, "entry.js")],
        outdir: join(root, "out"),

        plugins: (phase) => [
          {
            name: "mutate-after-analysis",

            setup(build) {
              if (phase === "analyze")
                build.onEnd(async () => {
                  await fs.writeFile(
                    join(root, "entry.js"),
                    "export const value = 2"
                  );
                });
            }
          }
        ]
      })
    ).rejects.toThrow("changed between passes");
    await expect(fs.stat(join(root, "out"))).rejects.toThrow();

    const rebuilt = await buildWithMincho({
      entryPoints: [join(root, "entry.js")],
      outdir: join(root, "out"),
      write: false
    });

    expect(rebuilt.outputFiles?.[0]?.text).toContain("2");
  });

  it("supports stdin and native file assets", async () => {
    const root = await fixture({ "image.svg": "<svg/>" });
    const result = await buildWithMincho({
      stdin: {
        contents: 'import image from "./image.svg";export default image;',
        resolveDir: root,
        sourcefile: "input.js"
      },
      loader: { ".svg": "file" },
      outdir: join(root, "out"),
      assetNames: "assets/[name]-[hash]",
      write: false,
      format: "esm"
    });

    expect(
      result.outputFiles?.some((output) =>
        /assets\/image-.*\.svg$/.test(output.path)
      )
    ).toBe(true);
  });
});

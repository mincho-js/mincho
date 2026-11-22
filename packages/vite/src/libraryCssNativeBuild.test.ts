import { parseSync } from "@babel/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { runInNewContext } from "node:vm";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { defineRules, type DefineRulesPresetArtifactV5 } from "@mincho-js/css";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession
} from "@mincho-js/css/defineRules/registry";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import {
  build,
  normalizePath,
  transformWithEsbuild,
  type InlineConfig,
  type Plugin,
  type Rollup
} from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minchoVitePlugin, type ExtractCalls } from "./index.js";

interface NativeBuildOutput {
  output: Array<Rollup.OutputAsset | Rollup.OutputChunk>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(files: Record<string, string> = {}) {
  const cache = join(process.cwd(), ".cache");
  await mkdir(cache, { recursive: true });

  const root = await mkdtemp(join(cache, "css-native-build-"));
  roots.push(root);

  for (const [name, source] of Object.entries({
    "package.json": '{"name":"css-native-fixture","type":"module"}',
    "entry.js":
      'import "./style.css";\nexport const marker = "CSS_NATIVE_MARKER";\n',
    "style.css": ".fixture { color: red; }",
    ...files
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), source);
  }

  return root;
}

async function compile(
  root: string,
  {
    format = "es",
    split = true,
    analysis = "worker",
    fileName,
    graph = false,
    extractCalls,
    vanilla = false,
    assetNames = "assets/custom-[name]-[hash][extname]",
    entries = "entry.js"
  }: {
    format?: "es" | "cjs" | Array<"es" | "cjs">;
    split?: boolean;
    analysis?: "worker" | "inline";
    fileName?: string;
    graph?: boolean;
    extractCalls?: ExtractCalls;
    vanilla?: boolean;
    assetNames?: string;
    entries?: string | Record<string, string>;
  } = {}
) {
  let starts = 0;
  const transformed = new Map<string, number>();
  const observer: Plugin = {
    name: "observe-native-library-build",

    buildStart() {
      starts++;
    },

    transform(_code, id) {
      if (
        id.startsWith(`${root}/`) &&
        /\.[jt]s$/.test(id) &&
        !id.endsWith(".css.ts") &&
        !id.endsWith(".vanilla.js")
      )
        transformed.set(id, (transformed.get(id) ?? 0) + 1);
    }
  };

  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      observer,
      minchoVitePlugin({ libraryCss: { analysis, fileName }, extractCalls }),
      ...(vanilla ? vanillaExtractPlugin() : []),
      ...(graph
        ? [
            {
              name: "resolve-published-style-contracts",

              resolveId(id: string) {
                // The package-contract suite checks installed CSS exports. Here
                // external sidecars isolate native graph ordering and scope.
                if (/^@native-proof\/[abcd]\/style\.css$/.test(id))
                  return { id, external: true };
              }
            }
          ]
        : [])
    ],
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      sourcemap: true,
      cssCodeSplit: split,
      lib: {
        entry:
          typeof entries === "string"
            ? join(root, entries)
            : Object.fromEntries(
                Object.entries(entries).map(([name, path]) => [
                  name,
                  join(root, path)
                ])
              ),
        formats: Array.isArray(format) ? format : [format]
      },
      rollupOptions: {
        output: {
          entryFileNames: "js/[name]-[hash].js",
          chunkFileNames: "js/chunk-[name]-[hash].js",
          assetFileNames: assetNames
        }
      }
    }
  });

  expect(starts).toBe(1);
  expect(transformed.size).toBeGreaterThan(0);

  for (const count of transformed.values()) expect(count).toBe(1);

  const outputs = (
    Array.isArray(result) ? result : [result]
  ) as Rollup.RollupOutput[];

  return { output: outputs.flatMap((output) => output.output) };
}

function chunks(output: NativeBuildOutput) {
  return output.output.filter(
    (item): item is Rollup.OutputChunk => item.type === "chunk"
  );
}

function cssAssets(output: NativeBuildOutput) {
  return output.output.filter(
    (item): item is Rollup.OutputAsset =>
      item.type === "asset" && item.fileName.endsWith(".css")
  );
}

function cssReferences(chunk: Rollup.OutputChunk) {
  return [...chunk.code.matchAll(/["']([^"']+\.css)["']/g)].map(
    ([, specifier]) =>
      posix.normalize(posix.join(posix.dirname(chunk.fileName), specifier!))
  );
}

function diamondArtifacts() {
  const artifacts: DefineRulesPresetArtifactV5[] = [];
  beginDefineRulesRegistrySession();
  setAdapter(mockAdapter);

  try {
    for (const [index, parents] of [[], [0], [0], [1, 2]].entries()) {
      setFileScope("src/rules.css.ts", `@native-proof/${"abcd"[index]}`);

      try {
        const rules = defineRules({
          presets: parents.map((parent) => artifacts[parent]!),
          properties: { color: true },
          debugId: `native_${index}`
        });

        rules.css({ color: ["red", "blue", "green", "orange"][index]! });
        artifacts.push(rules.preset);
      } finally {
        endFileScope();
      }
    }
  } finally {
    removeAdapter();
    endDefineRulesRegistrySession();
  }

  return artifacts;
}

describe("native library CSS in one Vite application build", () => {
  it.each([false, true])(
    "preserves package side effects while preloading imports (vanilla: %s)",
    async (vanilla) => {
      const root = await fixture({
        "entry.js":
          'import "./preset/style.css"; export { themeClass } from "./preset/index.js";',
        "preset/package.json": JSON.stringify({
          name: "precompiled-preset-fixture",
          type: "module",
          sideEffects: ["**/*.css"]
        }),
        "preset/index.js":
          'export { themeClass } from "./theme.js"; export { factory } from "./authoring.js";',
        "preset/theme.js": 'export const themeClass = "compiled-theme";',
        "preset/style.css": ".compiled-theme { --color: purple; }",
        "preset/authoring.js":
          'import { createDefinition } from "../compiler.js"; export const factory = createDefinition();',
        "compiler.js":
          'export function createDefinition() { console.log("AUTHORING_ENGINE_EXECUTED"); return {}; }'
      });

      const output = await compile(root, { vanilla });
      const javascript = chunks(output)
        .map((chunk) => chunk.code)
        .join("\n");
      const css = cssAssets(output)
        .map((asset) => String(asset.source))
        .join("\n");

      expect(javascript).toContain('"compiled-theme"');
      expect(javascript).not.toContain("AUTHORING_ENGINE_EXECUTED");
      expect(css).toContain(".compiled-theme");
      expect(css).toContain("--color: purple");
    }
  );

  it.each(
    [false, true].flatMap((vanilla) =>
      ["ts", "cjs"].map((extension) => [vanilla, extension] as const)
    )
  )(
    "builds local extractCalls factories and serialized recipes (vanilla: %s, %s)",
    async (vanilla, extension) => {
      const sourceRoot = join(
        process.cwd(),
        `../integration/src/__fixtures__/extract-calls${extension === "cjs" ? "-commonjs" : ""}/`
      );

      const files = Object.fromEntries(
        await Promise.all(
          ["entry", "factory", "implementation", "helper"]
            .map((name) => `${name}.${extension}`)
            .map(async (name) => [
              name,
              await readFile(join(sourceRoot, name), "utf8")
            ])
        )
      );

      const root = await fixture({
        ...files,
        "entry.js": `export * from "./entry.${extension}";`
      });

      const output = await compile(root, {
        format: "cjs",
        vanilla,
        extractCalls: {
          [`./factory.${extension}`]: ["defineStyle", "makeRecipe"]
        }
      });

      const css = cssAssets(output)
        .map((asset) => String(asset.source))
        .join("\n");

      const entry = chunks(output).find((chunk) => chunk.isEntry)!;
      const module = {
        exports: {} as {
          className: string;
          localClassName: string;
          render: (tone: string) => string;
        }
      };

      runInNewContext(entry.code, {
        module,
        exports: module.exports,
        process: { env: { NODE_ENV: "production" } },

        require: (id: string) => {
          expect(id).toMatch(/\.css$/);
        }
      });

      const quiet = module.exports.render("quiet");
      const loud = module.exports.render("loud");

      expect(quiet).not.toBe(loud);
      expect(css).toContain(`.${module.exports.className}`);
      expect(css).toContain(`.${module.exports.localClassName}`);
      expect(css).toContain("color: orchid");

      for (const name of quiet
        .split(" ")
        .filter((name) => !loud.split(" ").includes(name)))
        expect(css).toContain(`.${name}`);

      for (const name of loud
        .split(" ")
        .filter((name) => !quiet.split(" ").includes(name)))
        expect(css).toContain(`.${name}`);

      expect(css).toContain("color: tomato");
      expect(css).toContain("border-width: 3px");
      expect(css).toContain("outline-style: dotted");
    },
    30_000
  );

  it.each(
    [false, true].flatMap((vanilla) =>
      ["ts", "cjs"].map((extension) => [vanilla, extension] as const)
    )
  )(
    "extracts official vanilla-extract packages (vanilla plugin: %s, %s)",
    async (vanilla, extension) => {
      const source = await readFile(
        join(
          process.cwd(),
          "../integration/src/__fixtures__/vanilla-extract/entry.ts"
        ),
        "utf8"
      );

      const root = await fixture({
        "entry.js": `export * from "./styles.${extension}";`,
        [`styles.${extension}`]:
          extension === "cjs"
            ? (
                await transformWithEsbuild(source, "styles.ts", {
                  loader: "ts",
                  format: "cjs"
                })
              ).code
            : source
      });

      const output = await compile(root, { format: "cjs", vanilla });
      const css = cssAssets(output)
        .map((asset) => String(asset.source))
        .join("\n");

      const entry = chunks(output).find((chunk) => chunk.isEntry)!;
      const module = {
        exports: {} as {
          render: (
            tone: string,
            display: string,
            color: string
          ) => {
            className: string;
            inline: Record<string, string>;
            normalized: Record<string, string>;
            mapped: Record<string, number>;
            assigned: Record<string, string>;
            fallback: string;
          };
          update: (element: unknown, color: string) => void;
        }
      };

      const imports: string[] = [];
      runInNewContext(entry.code, {
        module,
        exports: module.exports,
        process: { env: { NODE_ENV: "production" } },

        require: (id: string) => {
          imports.push(id);
        }
      });

      expect(imports).toHaveLength(1);
      expect(imports[0]).toMatch(/\.css$/);

      const quiet = module.exports.render("quiet", "flex", "red");
      const loud = module.exports.render("loud", "grid", "blue");

      expect(quiet.className).not.toBe(loud.className);

      for (const className of `${quiet.className} ${loud.className}`.split(" "))
        expect(css).toContain(`.${className}`);

      expect(quiet.inline).toEqual({ [Object.keys(quiet.inline)[0]!]: "red" });
      expect(loud.inline).toEqual({ [Object.keys(quiet.inline)[0]!]: "blue" });
      expect(quiet.normalized).toEqual({ mobile: "flex", desktop: "grid" });
      expect(loud.normalized).toEqual({ mobile: "grid", desktop: "grid" });
      expect(quiet.mapped).toEqual({ mobile: 4, desktop: 8 });
      expect(Object.values(loud.assigned)).toEqual(["blue"]);
      expect(loud.fallback).toMatch(/^var\(--.+, blue\)$/);

      const assigned: Record<string, string> = {};
      module.exports.update(
        {
          style: {
            setProperty: (name: string, value: string) => {
              assigned[name] = value;
            }
          }
        },
        "green"
      );

      expect(assigned).toEqual({ [Object.keys(quiet.inline)[0]!]: "green" });

      expect(css).toContain("padding: 13px");
      expect(css).toContain("padding: 7px");
      expect(css).toContain("@layer reset");
      expect(css).toContain("@keyframes");
      expect(css).toContain("view-transition-name:");

      const bodyColors = [
        ...css.matchAll(/body\s*\{\s*color:\s*([^;]+);/g)
      ].map(([, value]) => value);

      expect(bodyColors).toHaveLength(2);
      expect(bodyColors[0]).toBe(Object.keys(quiet.assigned)[0]);
      expect(bodyColors[1]).not.toBe(bodyColors[0]);
    },
    30_000
  );

  for (const format of ["es", "cjs"] as const) {
    it(`${format}: hashes custom CSS references and preserves source positions`, async () => {
      const root = await fixture();
      const first = await compile(root, { format });
      const second = await compile(root, {
        format,
        assetNames: "renamed/other-[name]-[hash][extname]"
      });

      const a = chunks(first).find((chunk) => chunk.isEntry)!;
      const b = chunks(second).find((chunk) => chunk.isEntry)!;

      expect(cssReferences(a)).toEqual([cssAssets(first)[0]!.fileName]);
      expect(cssReferences(b)).toEqual([cssAssets(second)[0]!.fileName]);
      expect(a.code).not.toBe(b.code);
      expect(a.fileName).not.toBe(b.fileName);

      for (const entry of [a, b]) {
        const index = entry.code.indexOf('"CSS_NATIVE_MARKER"');

        expect(index).toBeGreaterThan(0);

        const before = entry.code.slice(0, index).split("\n");
        const position = originalPositionFor(
          new TraceMap(entry.map!.toString()),
          { line: before.length, column: before.at(-1)!.length }
        );

        expect(position.source).toMatch(/entry\.js$/);
        expect(position.line).toBe(2);
        expect(position.column).toBe(22);
      }
    });

    it(`${format}: links an explicitly matching unsplit stylesheet`, async () => {
      const root = await fixture();
      const output = await compile(root, {
        format,
        split: false,
        fileName: "assets/style.css",
        assetNames: "assets/style[extname]"
      });

      expect(cssAssets(output).map((asset) => asset.fileName)).toEqual([
        "assets/style.css"
      ]);
      expect(
        cssReferences(chunks(output).find((chunk) => chunk.isEntry)!)
      ).toEqual(["assets/style.css"]);
    });
  }

  it("worker and inline analysis produce identical native artifacts", async () => {
    const root = await fixture();
    const worker = await compile(root);
    const inline = await compile(root, { analysis: "inline" });

    const artifact = (output: NativeBuildOutput) =>
      output.output
        .map((item) => [
          item.fileName,
          item.type === "chunk" ? item.code : String(item.source)
        ])
        .sort(([a], [b]) => a!.localeCompare(b!));

    expect(artifact(worker)).toEqual(artifact(inline));
  });

  it("emits ESM and CJS from one application graph", async () => {
    const root = await fixture();
    const output = await compile(root, { format: ["es", "cjs"] });
    const entries = chunks(output).filter((chunk) => chunk.isEntry);

    expect(entries).toHaveLength(2);
    expect(entries.some((chunk) => /import ["']/.test(chunk.code))).toBe(true);
    expect(entries.some((chunk) => /require\(["']/.test(chunk.code))).toBe(
      true
    );
    expect(new Set(entries.map((chunk) => chunk.fileName)).size).toBe(2);

    for (const entry of entries) expect(cssReferences(entry)).toHaveLength(1);
  });

  it("analyzes real preset graphs identically in worker and inline modes with entry-scoped parent order", async () => {
    const presets = diamondArtifacts();

    const rulesSource = (preset: DefineRulesPresetArtifactV5) =>
      [
        'import { defineRules, css } from "@mincho-js/css";',
        `const rules = defineRules({ presets: ${JSON.stringify(preset)}, properties: { display: true } });`,
        // The direct css import extracts the referenced rules binding into a
        // Mincho sidecar, executing registration without a Babel mock.
        'export const cls = css([rules.css({ display: "grid" })]);'
      ].join("\n");

    const root = await fixture({
      "entry.js": 'export { cls } from "./diamond.ts";',
      "second.js": 'export { cls } from "./branch.ts";',
      "diamond.ts": rulesSource(presets[3]!),
      "branch.ts": rulesSource(presets[1]!)
    });

    const options = {
      graph: true,
      entries: { diamond: "entry.js", branch: "second.js" }
    };

    const worker = await compile(root, options);
    const inline = await compile(root, { ...options, analysis: "inline" });

    const styles = (chunk: Rollup.OutputChunk) =>
      [
        ...chunk.code.matchAll(/["'](@native-proof\/[^"']+\/style\.css)["']/g)
      ].map(([, name]) => name);

    for (const output of [worker, inline]) {
      const entries = chunks(output).filter((chunk) => chunk.isEntry);

      expect(
        styles(entries.find((chunk) => chunk.name === "diamond")!),
        entries.find((chunk) => chunk.name === "diamond")!.code
      ).toEqual(
        ["a", "b", "c", "d"].map((name) => `@native-proof/${name}/style.css`)
      );
      expect(styles(entries.find((chunk) => chunk.name === "branch")!)).toEqual(
        ["a", "b"].map((name) => `@native-proof/${name}/style.css`)
      );
      expect(cssAssets(output).length).toBeGreaterThan(0);
    }

    const artifact = (output: NativeBuildOutput) =>
      output.output
        .map((item) => [
          item.fileName,
          item.type === "chunk" ? item.code : String(item.source)
        ])
        .sort(([a], [b]) => a!.localeCompare(b!));

    expect(artifact(worker)).toEqual(artifact(inline));
  }, 60_000);

  for (const format of ["es", "cjs"] as const) {
    it(`${format}: preserves Mincho graph classes alongside vanilla-extract files`, async () => {
      const preset = diamondArtifacts()[3]!;
      const root = await fixture({
        "entry.js": 'export { cls } from "./rules.ts";',
        "rules.ts": [
          'import { defineRules, css } from "@mincho-js/css";',
          `const rules = defineRules({ presets: ${JSON.stringify(preset)}, properties: { display: true } });`,
          'export const cls = css([rules.css({ display: "grid" })]);'
        ].join("\n"),
        "vanilla.css.ts": [
          'import { style } from "@vanilla-extract/css";',
          'export const native = style({ padding: "17px" });'
        ].join("\n")
      });

      const baseline = await compile(root, { graph: true, format });
      const baselineCss = cssAssets(baseline)
        .map((asset) => String(asset.source))
        .join("\n");

      const gridSelectors = [
        ...baselineCss.matchAll(/([^{}]+)\{[^{}]*display:\s*grid[^{}]*\}/g)
      ].map(([, selector]) => selector!.trim());

      expect(gridSelectors.length).toBeGreaterThan(0);

      await writeFile(
        join(root, "entry.js"),
        'export { cls } from "./rules.ts"; export { native } from "./vanilla.css.ts";'
      );

      const combined = await compile(root, {
        graph: true,
        vanilla: true,
        format
      });

      const combinedCss = cssAssets(combined)
        .map((asset) => String(asset.source))
        .join("\n");

      for (const selector of gridSelectors)
        expect(combinedCss).toContain(selector);

      expect(combinedCss).toMatch(/padding:\s*17px/);

      const entry = chunks(combined).find((chunk) => chunk.isEntry)!;

      expect(
        [
          ...entry.code.matchAll(/["'](@native-proof\/[^"']+\/style\.css)["']/g)
        ].map(([, specifier]) => specifier)
      ).toEqual(
        ["a", "b", "c", "d"].map((name) => `@native-proof/${name}/style.css`)
      );
    }, 60_000);
  }

  it("keeps lazy CSS with its chunk and shares CSS across two entries", async () => {
    const root = await fixture({
      "entry.js":
        'export { shared } from "./shared.js"; import "./entry.css"; export const load = () => import("./lazy.js");',
      "second.js":
        'export { shared } from "./shared.js"; import "./second.css";',
      "shared.js": 'import "./shared.css"; export const shared = 1;',
      "shared.css": ".shared { padding: 4px; }",
      "entry.css": ".entry { color: red; }",
      "second.css": ".second { color: blue; }",
      "lazy.js": 'import "./lazy.css"; export const lazy = 1;',
      "lazy.css": ".lazy { display: grid; }"
    });

    const output = await compile(root, {
      entries: { main: "entry.js", second: "second.js" }
    });

    const allChunks = chunks(output);
    const assets = cssAssets(output);
    const lazy = allChunks.find((chunk) => chunk.isDynamicEntry)!;
    const lazyCss = assets.find((asset) =>
      String(asset.source).includes(".lazy")
    )!;

    expect(cssReferences(lazy)).toContain(lazyCss.fileName);

    for (const entry of allChunks.filter((chunk) => chunk.isEntry))
      expect(cssReferences(entry)).not.toContain(lazyCss.fileName);

    const references = allChunks.flatMap(cssReferences);

    for (const asset of assets) expect(references).toContain(asset.fileName);

    expect(
      assets.filter((asset) => String(asset.source).includes(".shared"))
    ).toHaveLength(1);
    expect(allChunks.filter((chunk) => chunk.isEntry)).toHaveLength(2);

    const sharedCss = assets.find((asset) =>
      String(asset.source).includes(".shared")
    )!;

    for (const [entryName, selector] of [
      ["main", ".entry"],
      ["second", ".second"]
    ]) {
      const entry = allChunks.find((chunk) => chunk.name === entryName)!;
      const ownCss = assets.find((asset) =>
        String(asset.source).includes(selector!)
      )!;

      // Production links dependency CSS from its owning chunk. Follow the
      // static JS graph instead of requiring the root to import every sheet.
      const visited = new Set<string>();

      const collect = (chunk: Rollup.OutputChunk): string[] => {
        if (visited.has(chunk.fileName)) return [];

        visited.add(chunk.fileName);

        return [
          ...chunk.imports.flatMap((id) => {
            const child = allChunks.find((item) => item.fileName === id);

            return child ? collect(child) : [];
          }),
          ...cssReferences(chunk)
        ];
      };

      const ordered = [...new Set(collect(entry))];

      expect(ordered).toContain(sharedCss.fileName);
      expect(ordered.indexOf(sharedCss.fileName)).toBeLessThan(
        ordered.indexOf(ownCss.fileName)
      );
    }
  });

  it("preserves declaration order within a stylesheet", async () => {
    const root = await fixture({
      "style.css":
        ".ordered { color: red; }\n@media (min-width: 1px) { .ordered { color: blue; } }\n.ordered { color: green !important; }"
    });

    const output = await compile(root);
    const css = String(cssAssets(output)[0]!.source);

    expect(css.indexOf("red")).toBeLessThan(css.indexOf("blue"));
    expect(css.indexOf("blue")).toBeLessThan(css.indexOf("green"));
    expect(css).toContain("!important");
  });

  it("rejects unsplit CSS without an explicit filename", async () => {
    const root = await fixture();

    await expect(compile(root, { split: false })).rejects.toThrow(
      /libraryCss.*fileName|fileName.*libraryCss/
    );
  });

  it("rejects an unsplit output filename that differs from the declared contract", async () => {
    const root = await fixture();

    await expect(
      compile(root, { split: false, fileName: "assets/style.css" })
    ).rejects.toThrow(/assets\/style\.css/);
  });

  it("rejects hash placeholders in an unsplit filename contract", async () => {
    const root = await fixture();

    await expect(
      compile(root, { split: false, fileName: "assets/style-[hash].css" })
    ).rejects.toThrow(/fileName|fixed|hash/);
  });
});

it.each(["native", "dist-chunk"] as const)(
  "keeps named dependency scopes and relative assets distinct (%s)",
  async (mode) => {
    const root = await fixture({
      "first/package.json": '{"name":"origin-first","type":"module"}',
      "second/package.json": '{"name":"origin-second","type":"module"}',
      "first/index.mjs": `import {style} from '@vanilla-extract/css';export const className=style({color:'red',backgroundImage:"url('./image.svg')"});`,
      "second/index.mjs": `import {style} from '@vanilla-extract/css';export const className=style({color:'blue',backgroundImage:"url('./image.svg')"});`,
      "first/image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="red"/></svg>',
      "second/image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="blue"/></svg>',
      "app/package.json": '{"name":"origin-app","type":"module"}',
      "app/entry.js": "export {classes} from './owner.css.ts';",
      "app/owner.css.ts":
        "import {className as first} from '../first/index.mjs';import {className as second} from '../second/index.mjs';export const classes=[first,second];"
    });
    const result = await build({
      root: join(root, "app"),
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin({ appCss: { mode } })],
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: join(root, "app/entry.js"),
          preserveEntrySignatures: "strict"
        }
      }
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (output) => ("output" in output ? output.output : [])
    );
    const assets = outputs.filter(
      (output): output is Rollup.OutputAsset => output.type === "asset"
    );
    const css = assets
      .filter((asset) => asset.fileName.endsWith(".css"))
      .map((asset) => String(asset.source))
      .join("\n");
    expect(css).toContain("color: red");
    expect(css).toContain("color: blue");
    const images = assets.filter((asset) => asset.fileName.endsWith(".svg"));
    expect(images).toHaveLength(2);
    expect(images.map((asset) => String(asset.source)).sort()).toEqual(
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="red"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="blue"/></svg>'
      ].sort()
    );
    for (const image of images) expect(css).toContain(image.fileName);
    expect(css).not.toContain("url('./image.svg')");
  }
);

// Simulate a host whose final CSS capture predecessor is not the validator,
// without touching Vite's own hooks.
function insertUnexpectedCssCapturePredecessor(): Plugin {
  return {
    name: "test-unverified-capture-order",
    options: {
      order: "post",
      handler(input) {
        if (!Array.isArray(input.plugins))
          throw new Error("Expected Vite plugin order");
        const effective = input.plugins as Rollup.Plugin[];
        const capture = effective.findIndex(
          (plugin) => plugin.name === "vite:css-post"
        );
        expect(effective[capture - 1]?.name).toBe(
          "mincho-validate-origin-free-css"
        );
        const extra = { name: "unverified-css-predecessor", transform() {} };
        return {
          ...input,
          plugins: [
            ...effective.slice(0, capture),
            extra,
            ...effective.slice(capture)
          ]
        };
      }
    }
  };
}

const publishedPackageDirectory = "node_modules/published";

it.each([false, true])(
  "publishes from a physical hash directory only for origin-independent CSS (resource: %s)",
  async (resource) => {
    const producerDirectory = `${publishedPackageDirectory}/hash#dir`;
    const producer = `${producerDirectory}/index.mjs`;
    const root = await fixture({
      [`${publishedPackageDirectory}/package.json`]:
        '{"name":"published","type":"module"}',
      [producer]: `
        import { style } from "@vanilla-extract/css";
        import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
        import { setFileScope as begin, endFileScope as end } from "@vanilla-extract/css/fileScope";
        setFileScope("src/first.css.ts", "published");
        export const first = style({
          color: "red",
          ${resource ? 'backgroundImage: "url(./icon.svg)"' : ""}
        });
        endFileScope();
        begin("src/second.css.ts", "published");
        export const second = style({ color: "blue" });
        end();
      `,
      [`${producerDirectory}/icon.svg`]:
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "app/package.json": '{"name":"consumer","type":"module"}',
      "app/entry.js": `
        import { css } from "@mincho-js/css";
        import { first, second } from "../${producer}";
        export const classes = css({
          selectors: { ["&." + first]: { padding: 1 }, ["&." + second]: { margin: 1 } }
        });
      `
    });
    const output = build({
      root: join(root, "app"),
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin({ appCss: { mode: "native" } })],
      build: {
        write: false,
        cssMinify: false,
        minify: false,
        rollupOptions: {
          input: join(root, "app/entry.js"),
          preserveEntrySignatures: "strict"
        }
      }
    });
    if (resource) {
      await expect(output).rejects.toThrow(
        /Native CSS cannot represent a physical producer directory/
      );
      return;
    }
    const result = await output;
    const css = (Array.isArray(result) ? result : [result])
      .flatMap((entry) => ("output" in entry ? entry.output : []))
      .filter(
        (asset): asset is Rollup.OutputAsset =>
          asset.type === "asset" && asset.fileName.endsWith(".css")
      )
      .map((asset) => String(asset.source))
      .join("\n");
    expect(css).toContain("color: red");
    expect(css).toContain("color: blue");
  },
  20_000
);

it.each([
  ["native", "index.mjs", false],
  ["dist-chunk", "index.mjs", false],
  ["native", "hash#.mjs", false],
  ...(process.platform === "win32"
    ? []
    : [["native", "index.mjs", true] as const])
] as const)(
  "keeps multiple preserved scopes from one producer and stable replacements (%s, %s, quoted: %s)",
  async (mode, fileName, quoted) => {
    const producerDirectory = quoted
      ? `${publishedPackageDirectory}/quoted"dir`
      : publishedPackageDirectory;
    const producer = (first: string, second: boolean) => `
      import {style} from '@vanilla-extract/css';
      import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope';
      import {setFileScope as setFileScope2,endFileScope as endFileScope2} from '@vanilla-extract/css/fileScope';
      setFileScope('src/first.css.ts','published-multi');
      export const first=style({color:'${first}',backgroundImage:"url('./image.svg')"});
      endFileScope();
      ${
        second
          ? `setFileScope2('src/second.css.ts','published-multi');
      export const second=style({color:'blue'});endFileScope2();`
          : 'export const second="";'
      }
    `;
    // Exercise a published producer, not a local authoring module: local
    // style calls are projected into one sidecar scope before this boundary.
    // owner.ts is intentionally authoring code (.css.ts belongs to the vanilla
    // plugin). The marker only forces this ID/asset test through build evaluation.
    const root = await fixture({
      [`${publishedPackageDirectory}/package.json`]:
        '{"name":"published-multi","type":"module"}',
      [`${producerDirectory}/${fileName}`]: producer("red", true),
      [`${producerDirectory}/image.svg`]:
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="orange"/></svg>',
      "app/package.json": '{"name":"consumer-multi","type":"module"}',
      "app/entry.js": 'export {classes} from "./owner.ts";',
      "app/owner.ts": `import {mincho$} from "@mincho-js/css";import {first,second} from ${JSON.stringify(`../${producerDirectory}/${fileName}`)};export const classes=mincho$(()=>[first,second]);`
    });
    const run = async () => {
      const virtual = new Map<string, string>();
      const result = await build({
        root: join(root, "app"),
        configFile: false,
        logLevel: "silent",
        plugins: [
          minchoVitePlugin({ appCss: { mode } }),
          // An unverified capture ordering does not restrict attributed CSS.
          ...(mode === "native" && fileName === "hash#.mjs"
            ? [insertUnexpectedCssCapturePredecessor()]
            : []),
          ...(mode === "native"
            ? [
                {
                  name: "observe-multi-scope-css",
                  enforce: "pre" as const,
                  transform(source: string, id: string) {
                    if (id.endsWith(".vanilla.css")) virtual.set(id, source);
                  }
                }
              ]
            : [])
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          assetsInlineLimit: 0,
          rollupOptions: {
            input: join(root, "app/entry.js"),
            preserveEntrySignatures: "strict"
          }
        }
      });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (output) => ("output" in output ? output.output : [])
      );
      const assets = outputs.filter(
        (output): output is Rollup.OutputAsset => output.type === "asset"
      );
      const css = assets
        .filter((asset) => asset.fileName.endsWith(".css"))
        .map((asset) => String(asset.source))
        .join("\n");
      const image = assets.find((asset) => asset.fileName.endsWith(".svg"));
      expect(image).toBeDefined();
      expect(css).toContain(image!.fileName);
      expect(css).not.toContain("url('./image.svg')");
      return { css, virtual };
    };
    const initial = await run();
    expect(initial.css).toContain("color: red");
    expect(initial.css).toContain("color: blue");
    const firstId = [...initial.virtual].find(([, source]) =>
      source.includes("color: red")
    )?.[0];
    if (mode === "native") {
      const secondId = [...initial.virtual].find(([, source]) =>
        source.includes("color: blue")
      )?.[0];
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();
      expect(firstId).not.toBe(secondId);
      expect(normalizePath(dirname(firstId!))).toBe(
        normalizePath(join(root, producerDirectory))
      );
      expect(firstId).not.toContain("#");
    }
    await writeFile(
      join(root, producerDirectory, fileName),
      producer("green", false)
    );
    const replaced = await run();
    expect(replaced.css).toContain("color: green");
    expect(replaced.css).not.toContain("color: red");
    expect(replaced.css).not.toContain("color: blue");
    if (mode === "native")
      expect(
        [...replaced.virtual].find(([, source]) =>
          source.includes("color: green")
        )?.[0]
      ).toBe(firstId);
  }
);

it.each([
  ["color", "color:'red'", "color: red", "?url"],
  ["url then no-inline", "color:'red'", "color: red", "?url&no-inline"],
  ["no-inline then url", "color:'red'", "color: red", "?no-inline&url"],
  [
    "transform value",
    "transform:'translateX(10px)'",
    "transform: translateX(10px)"
  ],
  ["late processed URL", "color:'red'", undefined],
  ["inline flag value", "color:'red'", "color: red"],
  ["unverified capture order", "color:'red'", undefined],
  ["color var()", "color:'var(--brand, red)'", "color: var(--brand, red)"],
  [
    "literal theme color",
    "vars:{'--brand':'red'},color:'var(--brand, red)'",
    "--brand: red"
  ],
  [
    "literal gradient",
    'backgroundImage:"linear-gradient(red, blue)"',
    "background-image: linear-gradient(red, blue)"
  ],
  ["relative resource", 'backgroundImage:"url(./image.svg)"', undefined],
  ["resource var()", 'backgroundImage:"var(--bg, none)"', undefined],
  ["custom property var()", 'vars:{"--brand":"var(--other, red)"}', undefined]
] as const)(
  "handles dynamic-scope native CSS without inventing an origin (%s)",
  async (name, declaration, expected, plainUrlQuery?: string) => {
    const checkRepresentations =
      plainUrlQuery !== undefined || name === "inline flag value";
    const lateProcessed: InlineConfig["css"] = {
      postcss: {
        plugins: [
          {
            postcssPlugin: "append-benign-relative-image",
            OnceExit(css) {
              css.walkDecls("color", (decl) => {
                decl.cloneAfter({
                  prop: "background-image",
                  value: 'url("./local-image.svg")'
                });
              });
            }
          }
        ]
      }
    };
    let postObserved = false;
    const root = await fixture({
      "node_modules/dynamic/package.json":
        '{"name":"dynamic-css","type":"commonjs"}',
      "node_modules/dynamic/index.cjs": `
      const {style}=require('@vanilla-extract/css');
      const scopeName=['@vanilla-extract/css','fileScope'].join('/');
      const scope=require(scopeName);
      scope.setFileScope('logical-only.css.ts','dynamic-css');
      exports.className=style({padding:'4px',${declaration}});
      scope.endFileScope();`,
      "entry.js": `import {mincho$} from '@mincho-js/css';import {className} from './node_modules/dynamic/index.cjs';export const value=mincho$(()=>className);`
    });
    const ids = new Set<string>();
    const building = build({
      root,
      configFile: false,
      logLevel: "silent",
      ...(name === "late processed URL" ? { css: lateProcessed } : {}),
      ...(checkRepresentations
        ? {
            css: {
              postcss: {
                plugins: [
                  {
                    postcssPlugin: "test-prod-color",
                    Declaration(decl: { prop: string; value: string }) {
                      if (decl.prop === "color" && decl.value === "red")
                        decl.value = "purple";
                    }
                  }
                ]
              }
            }
          }
        : {}),
      plugins: [
        minchoVitePlugin({ appCss: { mode: "native" } }),
        ...(name === "unverified capture order"
          ? [insertUnexpectedCssCapturePredecessor()]
          : []),
        ...(checkRepresentations
          ? [
              {
                name: "observe-after-vite-css-capture",
                transform: {
                  order: "post" as const,
                  handler(code: string, id: string) {
                    if (
                      id.startsWith(
                        "\0mincho-virtual-css:mincho-unattributed/"
                      ) &&
                      id.endsWith(".vanilla.css")
                    ) {
                      postObserved = true;
                      expect(code).not.toContain("color: purple");
                    }
                  }
                }
              }
            ]
          : []),
        {
          name: "observe-origin-free-css",
          enforce: "post",
          transform(source, id) {
            if (!checkRepresentations) return;
            const css = source.match(
              /import\s+["']([^"']+\.vanilla\.css)["']/
            )?.[1];
            if (css) {
              const plain = plainUrlQuery
                ? `\nexport {default as stylesheet} from ${JSON.stringify(css + plainUrlQuery)};`
                : "";
              return `${source}\nexport {default as inline} from ${JSON.stringify(css + (name === "inline flag value" ? "?url&inline=1" : "?url&inline"))};\nexport {default as raw} from ${JSON.stringify(css + "?raw")};${plain}`;
            }
            if (!id.endsWith("/entry.js")) return;
            const sidecar = source.match(
              /["']([^"']*extracted_[^"']+\.css\.ts)["']/
            )?.[1];
            if (sidecar)
              return `${source}\nexport {inline,raw${plainUrlQuery ? ",stylesheet" : ""}} from ${JSON.stringify(sidecar)};`;
          },
          moduleParsed({ id }) {
            if (id.endsWith(".vanilla.css")) ids.add(id);
          }
        }
      ],
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        rollupOptions: {
          input: join(root, "entry.js"),
          preserveEntrySignatures: "strict"
        }
      }
    });
    if (expected === undefined) {
      const diagnostic =
        name === "late processed URL"
          ? /Vite processed an origin-free stylesheet.*physical origin/
          : name === "unverified capture order"
            ? /unsupported Vite CSS capture ordering/
            : "Missing CSS scope provenance";
      await expect(building).rejects.toThrow(diagnostic);
      return;
    }
    const result = await building;
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (output) => ("output" in output ? output.output : [])
    );
    const css = outputs
      .flatMap((output) =>
        output.type === "asset" && output.fileName.endsWith(".css")
          ? [String(output.source)]
          : []
      )
      .join("\n");
    expect(css).toContain(checkRepresentations ? "color: purple" : expected);
    if (checkRepresentations) {
      expect(postObserved).toBe(true);
      const js = outputs.find(
        (output) => output.type === "chunk" && output.isEntry
      );
      if (js?.type !== "chunk") throw new Error("Missing Vite output entry");
      const encoded = js.code.match(
        /data:text\/css;charset=utf-8;base64,([A-Za-z0-9+/=]+)/
      )?.[1];
      expect(encoded).toBeDefined();
      expect(Buffer.from(encoded!, "base64").toString("utf8")).toContain(
        "color: purple"
      );
      expect(js.code).toContain("color: red");
      if (plainUrlQuery) {
        const body = parseSync(js.code, {
          babelrc: false,
          configFile: false,
          sourceType: "module"
        })!.program.body;
        const exportedString = (name: string) => {
          const exported = body
            .flatMap((node) =>
              node.type === "ExportNamedDeclaration" ? node.specifiers : []
            )
            .find(
              (node) =>
                node.type === "ExportSpecifier" &&
                node.exported.type === "Identifier" &&
                node.exported.name === name
            );
          if (exported?.type !== "ExportSpecifier") return undefined;
          const value = body
            .flatMap((node) =>
              node.type === "VariableDeclaration" ? node.declarations : []
            )
            .find(
              (decl) =>
                decl.id.type === "Identifier" &&
                decl.id.name === exported.local.name
            )?.init;
          return value?.type === "StringLiteral" ? value.value : undefined;
        };
        const stylesheet = exportedString("stylesheet");
        expect(stylesheet).toMatch(/^\/assets\/[^/]+\.css$/);
        expect(exportedString("inline")).toBe(
          `data:text/css;charset=utf-8;base64,${encoded}`
        );
        expect(exportedString("raw")).toContain("color: red");
        expect(exportedString("raw")).not.toContain("color: purple");
        const asset = outputs.find(
          (output): output is Rollup.OutputAsset =>
            output.type === "asset" && `/${output.fileName}` === stylesheet
        );
        expect(asset).toBeDefined();
        expect(String(asset!.source)).toContain("color: purple");
        expect(String(asset!.source)).not.toContain("color: red");
      }
    }
    expect(css).toContain("padding: 4px");
    expect(
      [...ids].some((id) =>
        id.startsWith("\0mincho-virtual-css:mincho-unattributed/")
      )
    ).toBe(true);
    expect([...ids].some((id) => id.includes("logical-only.css.ts"))).toBe(
      false
    );
  }
);

it("preserves physical assets in native fallback for an unsupported adapter without granting IR authority", async () => {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...original,
      readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
        const value = original.readFileSync(...args);
        const name = String(args[0]);
        if (name.includes("vanilla-extract") && name.endsWith("package.json")) {
          const changed = JSON.stringify({
            ...JSON.parse(String(value)),
            version: "0.0.0-unvalidated"
          });
          return typeof value === "string" ? changed : Buffer.from(changed);
        }
        return value;
      }
    };
  });
  try {
    const { minchoVitePlugin: freshPlugin } = await import("./index.js");
    // Distinct producers deliberately use the same relative asset spelling.
    // Checking each color's rule against its own SVG detects swapped origins.
    const files: Record<string, string> = {
      "entry.js": `import {mincho$} from '@mincho-js/css';import {className as red} from './red/owner.js';import {className as blue} from './blue/owner.js';export const value=mincho$(()=>[red,blue]);`
    };
    for (const color of ["red", "blue"]) {
      files[`${color}/owner.js`] =
        `import {style} from '@vanilla-extract/css';export const className=style({color:'${color}',backgroundImage:'url(./image.svg)'});`;
      files[`${color}/image.svg`] =
        `<svg xmlns="http://www.w3.org/2000/svg"><path fill="${color}"/></svg>`;
    }
    const root = await fixture(files);
    const config = {
      root,
      configFile: false as const,
      logLevel: "silent" as const,
      build: {
        write: false,
        minify: false as const,
        cssMinify: false as const,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: join(root, "entry.js"),
          preserveEntrySignatures: "strict" as const
        }
      }
    };
    const result = await build({
      ...config,
      plugins: [freshPlugin({ appCss: { mode: "native" } })]
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (item) => ("output" in item ? item.output : [])
    );
    const images = outputs.filter(
      (item) => item.type === "asset" && item.fileName.endsWith(".svg")
    );
    expect(images).toHaveLength(2);
    expect(new Set(images.map((image) => image.fileName)).size).toBe(2);
    const css = outputs
      .flatMap((item) =>
        item.type === "asset" && item.fileName.endsWith(".css")
          ? [String(item.source)]
          : []
      )
      .join("\n");
    const selectors = new Set<string>();
    for (const color of ["red", "blue"]) {
      const ownImage = images.find(
        (image) =>
          image.type === "asset" &&
          String(image.source).includes(`fill="${color}"`)
      );
      expect(ownImage).toBeDefined();
      const match = css.match(
        new RegExp(`(\\.[\\w-]+)\\s*\\{[^}]*color:\\s*${color}[;}][^}]*\\}`)
      );
      expect(match).not.toBeNull();
      selectors.add(match![1]);
      expect(match![0]).toContain(ownImage!.fileName);
      for (const other of images.filter((image) => image !== ownImage))
        expect(match![0]).not.toContain(other.fileName);
    }
    expect(selectors.size).toBe(2);
    await expect(
      build({
        ...config,
        plugins: [freshPlugin({ appCss: { mode: "dist-chunk" } })]
      })
    ).rejects.toThrow(/validated|adapter/i);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

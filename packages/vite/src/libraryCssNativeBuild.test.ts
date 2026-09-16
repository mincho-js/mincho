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
import { build, transformWithEsbuild, type Plugin, type Rollup } from "vite";
import { afterEach, describe, expect, it } from "vitest";
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

      const ordered = cssReferences(entry);

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

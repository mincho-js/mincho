import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import {
  createLibraryCssLinker,
  type LibraryCssChunk
} from "./libraryCssLinker.js";

function chunk(
  fileName: string,
  extra: Partial<LibraryCssChunk> = {}
): LibraryCssChunk {
  return {
    fileName,
    imports: [],
    isEntry: true,
    isDynamicEntry: false,
    ...extra
  };
}

describe("library CSS linker", () => {
  it.each([".style.css", ".assets/style.css"])(
    "uses a relative module specifier for %s",
    async (fileName) => {
      const linker = createLibraryCssLinker({ cssCodeSplit: false, fileName });
      const root = chunk("entry.js");
      const linked = await linker.renderChunk({
        code: "export const x=1;",
        chunk: root,
        chunks: { "entry.js": root },
        format: "es",
        ancestorStyleSpecifiers: [],
        hasOwnCss: true
      });

      expect(linked!.code).toContain(
        `import ${JSON.stringify(`./${fileName}`)};`
      );
      expect(root.imports).toContain(`./${fileName}`);
    }
  );

  it("reuses only previously verified unsplit CSS within the supplied output scope", async () => {
    const seen = new Set<string>();

    const create = async () => {
      const linker = createLibraryCssLinker({
        cssCodeSplit: false,
        fileName: "style.css"
      });

      const root = chunk("root.js");
      await linker.renderChunk({
        code: "export const x=1;",
        chunk: root,
        chunks: { "root.js": root },
        format: "es",
        ancestorStyleSpecifiers: [],
        hasOwnCss: true
      });

      return linker;
    };

    const first = await create();

    expect(() =>
      first.validateBundle({}, { validatedUnsplitCss: seen })
    ).toThrow("was not emitted");

    first.validateBundle(
      {
        "style.css": {
          type: "asset",
          fileName: "style.css",
          originalFileNames: ["style.css"]
        }
      },
      { validatedUnsplitCss: seen }
    );

    const next = await create();
    next.validateBundle({}, { validatedUnsplitCss: seen });

    expect(() =>
      next.validateBundle({}, { validatedUnsplitCss: new Set() })
    ).toThrow("was not emitted");
    expect(() =>
      next.validateBundle(
        { "style.css": { type: "chunk", fileName: "style.css" } },
        { validatedUnsplitCss: seen }
      )
    ).toThrow("was not emitted");
    expect(() =>
      next.validateBundle(
        {
          "other.css": {
            type: "asset",
            fileName: "other.css",
            originalFileNames: ["style.css"]
          }
        },
        { validatedUnsplitCss: seen }
      )
    ).toThrow("was not emitted");
    expect(() =>
      next.validateBundle(
        { "style.css": { type: "asset", fileName: "style.css" } },
        { validatedUnsplitCss: seen }
      )
    ).toThrow("does not identify Vite's native unsplit CSS asset");
  });

  it("rejects an unrelated plugin asset that masks the wrong unsplit CSS filename", async () => {
    const linker = createLibraryCssLinker({
      cssCodeSplit: false,
      fileName: "style.css"
    });

    const files: Record<string, string> = {
      "/virtual/entry.js": 'import "./red.css";export const x=1;',
      "/virtual/red.css": ".red{color:red}"
    };

    let checked = false;

    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [
          {
            name: "source-and-unrelated-css",

            resolveId(id, importer) {
              if (id in files) return id;
              if (importer && id.startsWith("."))
                return posix.resolve(posix.dirname(importer), id);
            },

            load(id) {
              return files[id];
            },

            buildStart() {
              this.emitFile({
                type: "asset",
                fileName: "style.css",
                source: ".blue{color:blue}"
              });
            }
          },
          {
            name: "verify-native-unsplit-provenance",
            enforce: "post",
            renderChunk: {
              order: "post",

              handler(code, chunk, output, meta) {
                return linker.renderChunk({
                  code,
                  chunk,
                  chunks: meta.chunks,
                  format: output.format,
                  ancestorStyleSpecifiers: [],
                  hasOwnCss: true
                });
              }
            },
            generateBundle: {
              order: "post",

              handler(_output, bundle) {
                expect(bundle["style.css"]).toMatchObject({
                  source: ".blue{color:blue}",
                  originalFileNames: []
                });
                expect(bundle["native.css"]).toMatchObject({
                  originalFileNames: ["style.css"]
                });

                checked = true;
                linker.validateBundle(bundle);
              }
            }
          }
        ],
        build: {
          write: false,
          minify: false,
          cssCodeSplit: false,
          lib: {
            entry: "/virtual/entry.js",
            formats: ["es"],
            cssFileName: "native"
          },
          rollupOptions: { output: { assetFileNames: "[name][extname]" } }
        }
      })
    ).rejects.toThrow("does not identify Vite's native unsplit CSS asset");

    expect(checked).toBe(true);
  });

  it("fails closed when owned split CSS has no metadata after the barrier", async () => {
    const linker = createLibraryCssLinker({ cssCodeSplit: true });
    const root = chunk("root.js");

    await expect(
      linker.renderChunk({
        code: "export const x=1;",
        chunk: root,
        chunks: { "root.js": root },
        format: "es",
        ancestorStyleSpecifiers: [],
        hasOwnCss: true
      })
    ).rejects.toThrow("found 0 after all CSS render hooks completed");
  });

  it.each([
    "export const x=1;",
    '"use strict";export const x=1;',
    '"use strict";\nexport const x=1;'
  ])("does not insert an unnecessary leading newline: %s", async (code) => {
    const linker = createLibraryCssLinker({
      cssCodeSplit: false,
      fileName: "style.css"
    });

    const root = chunk("root.js");
    const linked = await linker.renderChunk({
      code,
      chunk: root,
      chunks: { "root.js": root },
      format: "es",
      ancestorStyleSpecifiers: [],
      hasOwnCss: true
    });

    expect(linked!.code).not.toMatch(/^\n/);
    expect(linked!.code).not.toContain("\n\nimport");
    expect(linked!.code).toContain('import "./style.css";\nexport const x=1;');
  });

  it("terminates an ASI directive before inserting imports", async () => {
    const linker = createLibraryCssLinker({
      cssCodeSplit: false,
      fileName: "style.css"
    });

    const root = chunk("root.js");
    const linked = await linker.renderChunk({
      code: '"use strict" /* trailing comment */',
      chunk: root,
      chunks: { "root.js": root },
      format: "es",
      ancestorStyleSpecifiers: [],
      hasOwnCss: true
    });

    expect(linked!.code).toContain("/* trailing comment */\nimport");
  });

  it("aborts waiting chunks when another render fails", async () => {
    const linker = createLibraryCssLinker({ cssCodeSplit: true });
    const root = chunk("root.js");
    const shared = chunk("shared.js", { isEntry: false });
    const input = {
      code: "export const x=1;",
      chunk: root,
      chunks: { "root.js": root, "shared.js": shared },
      format: "es",
      ancestorStyleSpecifiers: [],
      hasOwnCss: false
    };

    const waiting = linker.renderChunk(input);
    const failed = expect(waiting).rejects.toThrow("CSS transform failed");
    linker.abort(new Error("CSS transform failed"));
    await failed;

    await expect(linker.renderChunk(input)).rejects.toThrow(
      "CSS transform failed"
    );
  });

  it("waits for shared and pure-CSS chunks, preserving static dependency order", async () => {
    const linker = createLibraryCssLinker({ cssCodeSplit: true });
    const root = chunk("root.js", {
      imports: ["shared.js"],
      viteMetadata: { importedCss: new Set(["root.css"]) }
    });

    const shared = chunk("shared.js", { isEntry: false, imports: ["pure.js"] });
    const pure = chunk("pure.js", { isEntry: false });
    const chunks = { "root.js": root, "shared.js": shared, "pure.js": pure };

    const render = (current: LibraryCssChunk) =>
      linker.renderChunk({
        code: '"use strict";\nexport const value = 1;',
        chunk: current,
        chunks,
        format: "es",
        ancestorStyleSpecifiers: ["@proof/a/style.css"],
        hasOwnCss: true
      });

    let complete = false;
    const result = render(root).then((value) => {
      complete = true;

      return value;
    });

    await Promise.resolve();

    expect(complete).toBe(false);

    shared.viteMetadata = { importedCss: new Set(["shared.css"]) };

    const sharedResult = render(shared);
    pure.viteMetadata = { importedCss: new Set(["pure.css"]) };
    await render(pure);
    await sharedResult;

    const linked = (await result)!;

    expect(linked.code.startsWith('"use strict";')).toBe(true);
    expect(root.imports).toEqual([
      "shared.js",
      "@proof/a/style.css",
      "./pure.css",
      "./shared.css",
      "./root.css"
    ]);
    expect(linked.code.indexOf("pure.css")).toBeLessThan(
      linked.code.indexOf("shared.css")
    );
    expect(() => linker.validateBundle({})).toThrow("was not emitted");

    linker.validateBundle(
      Object.fromEntries(
        ["pure.css", "shared.css", "root.css"].map((fileName) => [
          fileName,
          { fileName, type: "asset" }
        ])
      )
    );
  });

  it.each([
    "../style.css",
    "/style.css",
    "[name].css",
    "x\\style.css",
    "https://x/style.css",
    "x.css?raw",
    "x//style.css"
  ])("rejects non-fixed output filename %s", (fileName) => {
    expect(() =>
      createLibraryCssLinker({ cssCodeSplit: false, fileName })
    ).toThrow("fixed output-relative");
  });

  it("requires a fixed unsplit filename only when owned CSS is needed", async () => {
    const linker = createLibraryCssLinker({ cssCodeSplit: false });
    const root = chunk("entry.js");
    const input = {
      code: "export const x=1;",
      chunk: root,
      chunks: { "entry.js": root },
      format: "es",
      ancestorStyleSpecifiers: [],
      hasOwnCss: false
    };

    expect(await linker.renderChunk(input)).toBeNull();
    await expect(
      linker.renderChunk({ ...input, hasOwnCss: true })
    ).rejects.toThrow("explicit libraryCss.fileName");
  });

  it.each(["es", "cjs"] as const)(
    "preserves %s maps, native hashes and lazy CSS links",
    async (format) => {
      const files: Record<string, string> = {
        "/virtual/entry.js":
          'import "./entry.css";\nexport const marker = 42;\nexport const load = () => import("./lazy.js");\nexport { shared } from "./shared.js";\nimport "./pure.css";',
        "/virtual/shared.js": 'import "./shared.css";export const shared = 3;',
        "/virtual/lazy.js": 'import "./lazy.css";export const lazy = 7;',
        "/virtual/entry.css": ".entry{color:red}",
        "/virtual/shared.css": ".shared{padding:4px}",
        "/virtual/pure.css": ".pure{margin:4px}",
        "/virtual/lazy.css": ".lazy{color:blue}"
      };

      for (const split of [false, true]) {
        const names: string[][] = [];

        for (const prefix of ["alpha", "beta"]) {
          const linker = createLibraryCssLinker({
            cssCodeSplit: split,
            fileName: `${prefix}/style.css`
          });

          const plugin: Plugin = {
            name: "test-library-linker",
            enforce: "post",
            renderChunk: {
              order: "post",

              handler(code, chunk, options, meta) {
                return linker.renderChunk({
                  code,
                  chunk,
                  chunks: meta.chunks,
                  format: options.format,
                  ancestorStyleSpecifiers: [],
                  hasOwnCss: true
                });
              }
            },
            generateBundle: {
              order: "post",

              handler(_options, bundle) {
                linker.validateBundle(bundle);
              }
            }
          };

          const result = await build({
            configFile: false,
            logLevel: "silent",
            plugins: [
              {
                name: "virtual-source",

                resolveId(id, importer) {
                  if (id in files) return id;
                  if (importer && id.startsWith("."))
                    return posix.resolve(posix.dirname(importer), id);
                },

                load(id) {
                  return files[id];
                }
              },
              plugin
            ],
            build: {
              write: false,
              minify: false,
              sourcemap: true,
              cssCodeSplit: split,
              lib: {
                entry: "/virtual/entry.js",
                formats: [format],
                cssFileName: "style"
              },
              rollupOptions: {
                output: {
                  entryFileNames: "entries/[name]-[hash].js",
                  chunkFileNames: "chunks/[name]-[hash].js",
                  assetFileNames: `${prefix}/[name][extname]`,
                  manualChunks: {
                    shared: ["/virtual/shared.js"],
                    pure: ["/virtual/pure.css"]
                  }
                }
              }
            }
          });
          if ("on" in result) throw new Error("unexpected watcher");

          const output = (Array.isArray(result) ? result[0]! : result).output;
          const roots = output.filter(
            (item) =>
              item.type === "chunk" && (item.isEntry || item.isDynamicEntry)
          );

          names.push(roots.map((item) => item.fileName));

          const root = roots.find(
            (item) => item.type === "chunk" && item.isEntry
          )!;
          if (root.type !== "chunk" || !root.map)
            throw new Error("missing root map");

          const position = root.code
            .slice(0, root.code.indexOf("marker"))
            .split("\n");

          expect(
            originalPositionFor(new TraceMap(root.map.toString()), {
              line: position.length,
              column: position.at(-1)!.length
            })
          ).toMatchObject({ line: 2, column: 13 });

          const lazy = roots.find(
            (item) => item.type === "chunk" && item.isDynamicEntry
          )!;
          if (lazy.type !== "chunk") throw new Error("missing lazy chunk");

          expect(lazy.code).toContain(
            split ? `${prefix}/lazy.css` : `${prefix}/style.css`
          );

          if (split) {
            expect(root.code).toContain(`${prefix}/shared.css`);
            expect(root.code).toContain(`${prefix}/pure.css`);
            expect(root.code).not.toContain(`${prefix}/lazy.css`);
          }

          if (format === "cjs")
            expect(root.code.startsWith('"use strict";')).toBe(true);
        }

        expect(names[0]).not.toEqual(names[1]);
        expect(names[0]!.every((name) => !names[1]!.includes(name))).toBe(true);
      }
    },
    30_000
  );
});

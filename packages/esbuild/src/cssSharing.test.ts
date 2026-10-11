import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { build as nativeBuild } from "esbuild";
import { buildWithMincho } from "./build.js";
import { minchoEsbuildPlugins } from "./plugin.js";

const roots: string[] = [];

async function fixture(files: Record<string, string | Uint8Array> = {}) {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "css-sharing-"));
  roots.push(root);

  for (const [name, contents] of Object.entries({
    "a.js": 'import "./shared.css"; import "./a.css"; export const a = 1;',
    "b.js": 'import "./shared.css"; import "./b.css"; export const b = 2;',
    "shared.css": ".shared { color: red; }",
    "a.css": ".shared { color: blue; }",
    "b.css": ".shared { color: green; }",
    ...files
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("native esbuild CSS sharing", () => {
  it.each([
    { write: false, sourcemap: false, hasPrivateCss: false },
    { write: false, sourcemap: false, hasPrivateCss: true },
    { write: false, sourcemap: true, hasPrivateCss: false },
    { write: false, sourcemap: true, hasPrivateCss: true },
    { write: true, sourcemap: false, hasPrivateCss: false },
    { write: true, sourcemap: false, hasPrivateCss: true },
    { write: true, sourcemap: true, hasPrivateCss: false },
    { write: true, sourcemap: true, hasPrivateCss: true }
  ])(
    "omits empty private CSS (write=$write, sourcemap=$sourcemap, private=$hasPrivateCss)",
    async ({ write, sourcemap, hasPrivateCss }) => {
      const root = await fixture({
        "a.js": 'import "./shared.css"; export const a = 1;',
        "b.js": hasPrivateCss
          ? 'import "./shared.css"; import "./b.css"; export const b = 2;'
          : 'import "./shared.css"; export const b = 2;'
      });
      const result = await buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        write,
        sourcemap,
        metafile: true,
        mincho: {
          cache: false,
          experimental: { cssChunkSharing: { minBytes: 0 } }
        }
      });
      const entries = result.minchoCssManifest!.entries;

      expect(entries["a.js"]!.css).toHaveLength(1);
      expect(entries["a.js"]!.css[0]).toContain("mincho-shared-");
      expect(entries["b.js"]!.css[0]).toBe(entries["a.js"]!.css[0]);
      expect(entries["b.js"]!.css).toHaveLength(hasPrivateCss ? 2 : 1);

      const styles = [
        ...new Set(Object.values(entries).flatMap(({ css }) => css))
      ];
      const expected = styles
        .flatMap((css) => (sourcemap ? [css, `${css}.map`] : [css]))
        .sort();
      const replayPaths = (paths: string[]) =>
        paths
          .map((path) => path.replaceAll("\\", "/"))
          .filter((path) => path.includes("/mincho-css/"))
          .map((path) => path.slice(path.indexOf("mincho-css/")))
          .sort();
      const outputs = write
        ? (await readdir(join(root, "out/mincho-css"))).map(
            (name) => `mincho-css/${name}`
          )
        : replayPaths(result.outputFiles!.map(({ path }) => path));

      expect(outputs.sort()).toEqual(expected);
      expect(replayPaths(Object.keys(result.metafile!.outputs))).toEqual(
        expected
      );
    },
    20_000
  );

  it("keeps shared CSS filenames stable across checkout roots", async () => {
    const sharedFiles: string[] = [];

    for (const root of [await fixture(), await fixture()]) {
      const result = await buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        write: false,
        mincho: {
          cache: false,
          experimental: { cssChunkSharing: { minBytes: 0 } }
        }
      });
      const shared = result.minchoCssManifest!.entries["a.js"]!.css[0]!;

      expect(shared).toContain("mincho-shared-");
      expect(shared).toBe(result.minchoCssManifest!.entries["b.js"]!.css[0]);
      sharedFiles.push(shared);
    }

    expect(sharedFiles[0]).toBe(sharedFiles[1]);
  }, 20_000);

  it("keeps in-memory JavaScript builds without an output path supported", async () => {
    const root = await fixture();
    const result = await buildWithMincho({
      absWorkingDir: root,
      stdin: { contents: "console.log(42);", resolveDir: root },
      write: false,
      mincho: { cache: false }
    });

    expect(result.outputFiles![0].text).toContain("42");
    expect(result.minchoCssManifest).toBeUndefined();
  });

  it.each(["production", "development", "disabled"] as const)(
    "keeps CSS sharing opt-in in %s mode",
    async (mode) => {
      const root = await fixture({
        "shared.css": Array.from(
          { length: 180 },
          (_, i) => `.shared${i} { padding: ${i}px; color: red; }`
        ).join("\n")
      });

      const result = await buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        write: false,
        mincho: {
          cache: false,
          optimizationMode:
            mode === "development" ? "development" : "production",
          ...(mode === "disabled"
            ? { experimental: { cssChunkSharing: false } }
            : {})
        }
      });

      expect(result.minchoCssManifest).toBeUndefined();
      expect(
        result.outputFiles!.some((file) => file.path.includes("mincho-css"))
      ).toBe(false);
    },
    20_000
  );

  it("adds no automatic manifest or replay files when sharing is ineligible", async () => {
    const root = await fixture();
    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["a.js", "b.js"],
      outdir: "out",
      write: false,
      mincho: { cache: false }
    });

    expect(result.minchoCssManifest).toBeUndefined();
    expect(
      result.outputFiles!.some((file) => file.path.includes("mincho-css"))
    ).toBe(false);
  });

  it("replays captured CSS without additional user hooks and exposes ordered manifests", async () => {
    const root = await fixture();
    let setups = 0;
    let loads = 0;
    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["a.js", "b.js"],
      outdir: "out",
      write: false,
      mincho: {
        cache: false,
        experimental: { cssChunkSharing: { minBytes: 0 } }
      },

      plugins: () => [
        {
          name: "observe-hooks",

          setup(build) {
            setups++;
            build.onLoad({ filter: /\.css$/ }, () => {
              loads++;

              return undefined;
            });
          }
        }
      ]
    });

    expect(setups).toBe(2);
    expect(loads).toBe(6);

    const manifest = result.minchoCssManifest!;

    expect(manifest.version).toBe(1);
    expect(manifest.entries["a.js"]!.css).toHaveLength(2);
    expect(manifest.entries["a.js"]!.css[0]).toBe(
      manifest.entries["b.js"]!.css[0]
    );

    for (const name of ["a", "b"]) {
      const entry = manifest.entries[`${name}.js`]!;

      expect(entry.fallbackCssBundle).toBe(`${name}.css`);

      const css = entry.css
        .map(
          (file) =>
            result.outputFiles!.find(
              (output) => output.path === join(root, "out", file)
            )!.text
        )
        .join("\n");

      expect(css.indexOf("red")).toBeLessThan(
        css.indexOf(name === "a" ? "blue" : "green")
      );
      expect(
        result.outputFiles!.some(
          (file) => file.path === join(root, "out", `${name}.css`)
        )
      ).toBe(true);
    }

    const json = result.outputFiles!.find((file) =>
      file.path.endsWith("/mincho-css-manifest.json")
    )!;

    expect(JSON.parse(json.text)).toEqual(manifest);
    await expect(
      readFile(join(root, "out", "mincho-css-manifest.json"))
    ).rejects.toThrow();
  });

  it("replays URL assets and source maps while publishing the manifest transactionally", async () => {
    const root = await fixture({
      "shared.css": '.shared { background: url("./image.png"); }',
      "image.png": new Uint8Array([1, 2, 3, 4])
    });

    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["a.js", "b.js"],
      outdir: "out",
      sourcemap: true,
      loader: { ".png": "file" },
      mincho: {
        cache: false,
        experimental: { cssChunkSharing: { minBytes: 0 } }
      }
    });

    const json = JSON.parse(
      await readFile(join(root, "out/mincho-css-manifest.json"), "utf8")
    );

    expect(json).toEqual(result.minchoCssManifest);

    const cssPath = join(root, "out", json.entries["a.js"].css[0]);
    const css = await readFile(cssPath, "utf8");

    expect(css).toMatch(/url\([^)]*image-[\w]+\.png["']?\)/);

    const map = JSON.parse(await readFile(`${cssPath}.map`, "utf8"));

    expect(
      map.sources.some((source: string) => source.endsWith("shared.css"))
    ).toBe(true);
  });

  it("keeps dynamic descendants at the same entry loading boundary", async () => {
    const root = await fixture({
      "a.js": 'export const load = () => import("./lazy.js");',
      "lazy.js":
        'import "./shared.css"; import "./a.css"; export const lazy = true;'
    });

    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["a.js", "b.js"],
      outdir: "out",
      write: false,
      mincho: {
        cache: false,
        experimental: { cssChunkSharing: { minBytes: 0 } }
      }
    });

    expect(result.minchoCssManifest!.entries["a.js"]!.css).toHaveLength(2);

    const css = result
      .minchoCssManifest!.entries[
        "a.js"
      ]!.css.map((file) => result.outputFiles!.find((output) => output.path === join(root, "out", file))!.text)
      .join("\n");

    expect(css).toContain("red");
    expect(css).toContain("blue");
  });

  it("shares extracted Mincho CSS in CommonJS output", async () => {
    const root = await fixture({
      "shared.ts":
        'import { css } from "@mincho-js/css"; export const shared = css({ color: "red" });',
      "a.js":
        'import { shared } from "./shared.ts"; import "./a.css"; export { shared };',
      "b.js":
        'import { shared } from "./shared.ts"; import "./b.css"; export { shared };'
    });

    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["a.js", "b.js"],
      outdir: "out",
      format: "cjs",
      write: false,
      mincho: {
        cache: false,
        experimental: { cssChunkSharing: { minBytes: 0 } }
      }
    });

    const [shared] = result.minchoCssManifest!.entries["a.js"]!.css;

    expect(shared).toContain("mincho-shared-");
    expect(shared).toBe(result.minchoCssManifest!.entries["b.js"]!.css[0]);
    expect(
      result.outputFiles!.find(
        (output) => output.path === join(root, "out", shared!)
      )!.text
    ).toContain("color: red");
  });

  it("keeps original files when publishing an additional manifest fails", async () => {
    const root = await fixture();
    await mkdir(join(root, "out/mincho-css-manifest.json"), {
      recursive: true
    });
    await writeFile(join(root, "out/a.js"), "original");

    await expect(
      buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        mincho: {
          cache: false,
          experimental: { cssChunkSharing: { minBytes: 0 } }
        }
      })
    ).rejects.toThrow(/publication failed/);
    expect(await readFile(join(root, "out/a.js"), "utf8")).toBe("original");
    await expect(readFile(join(root, "out/b.js"))).rejects.toThrow();
  });

  it("validates captured CSS again before publishing replay outputs", async () => {
    const root = await fixture();

    await expect(
      buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        mincho: {
          cache: false,
          experimental: { cssChunkSharing: { minBytes: 0 } }
        },

        plugins: (phase) => [
          {
            name: "late-source-change",

            setup(build) {
              if (phase === "emit")
                build.onEnd(async () => {
                  await writeFile(
                    join(root, "shared.css"),
                    ".shared { color: purple; }"
                  );
                });
            }
          }
        ]
      })
    ).rejects.toThrow(/input changed/);
    await expect(
      readFile(join(root, "out/mincho-css-manifest.json"))
    ).rejects.toThrow();
    await expect(readFile(join(root, "out/a.js"))).rejects.toThrow();
  });

  it.each(["import", "banner", "threshold"] as const)(
    "keeps native CSS for %s fallback",
    async (scenario) => {
      const root = await fixture(
        scenario === "import"
          ? {
              "a.css": '@import "./inner.css"; .shared { color: blue; }',
              "inner.css": ".inner { color: black; }"
            }
          : {}
      );

      const result = await buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        write: false,
        ...(scenario === "banner"
          ? { banner: { css: "body { color: pink; }" } }
          : {}),
        mincho: {
          cache: false,
          experimental: {
            cssChunkSharing: scenario === "threshold" ? true : { minBytes: 0 }
          }
        }
      });

      expect(result.minchoCssManifest!.entries["a.js"]!.css).toEqual(["a.css"]);
      expect(result.minchoCssManifest!.entries["b.js"]!.css).toEqual(["b.css"]);
    },
    30_000
  );

  it("falls back for global prefixes and custom CSS loaders", async () => {
    for (const custom of [false, true]) {
      const root = await fixture({
        "shared.css": custom
          ? ".shared { color: red; }"
          : "body { color: red; }"
      });

      const result = await buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["a.js", "b.js"],
        outdir: "out",
        write: false,
        mincho: {
          cache: false,
          experimental: { cssChunkSharing: { minBytes: 0 } }
        },

        plugins: () =>
          custom
            ? [
                {
                  name: "custom-css",

                  setup(build) {
                    build.onLoad({ filter: /shared\.css$/ }, () => ({
                      contents: ".custom { color: red; }",
                      loader: "css"
                    }));
                  }
                }
              ]
            : []
      });

      expect(result.minchoCssManifest!.entries["a.js"]!.css).toEqual(["a.css"]);

      if (custom)
        expect(
          result.warnings.some((warning) => warning.text.includes("provenance"))
        ).toBe(true);
    }
  });

  it("rejects unsupported direct plugin builds", async () => {
    await expect(
      nativeBuild({
        stdin: { contents: "export const x = 1;" },
        write: false,
        logLevel: "silent",
        plugins: minchoEsbuildPlugins({
          experimental: { cssChunkSharing: true }
        })
      })
    ).rejects.toThrow(/requires buildWithMincho/);
  });
});

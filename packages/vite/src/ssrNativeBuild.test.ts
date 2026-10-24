import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, createServer, type Rollup } from "vite";
import { minchoVitePlugin } from "./index.js";
import { resolveSsrStylesheets, type MinchoSsrCssManifest } from "./ssr.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "mincho-ssr-native-"));
  roots.push(root);

  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }

  return root;
}

function assets(
  result: Awaited<ReturnType<typeof build>>
): Rollup.OutputBundle {
  if ("on" in result) throw new Error("Unexpected watcher");

  return Object.fromEntries(
    (Array.isArray(result) ? result : [result])
      .flatMap((item) => item.output)
      .map((item) => [item.fileName, item])
  );
}

async function rscLibrary(files: Record<string, string>) {
  const root = await fixture(files);
  return assets(
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin({ libraryRsc: true })],
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, "entry.js"), formats: ["es"] }
      }
    })
  );
}

describe("native client manifest and library boundaries", () => {
  it.each([
    "export async function action(){'use server';return 42}",
    "export const action=async()=>{'use server';return 42}",
    "export const action=async function(){'use server';return 42}",
    "export function Component(){return async function action(){'use strict';'use server';return 42}}",
    "export const actions={async save(){'use server';return 42}}"
  ])("rejects a function-level server action: %s", async (source) => {
    await expect(rscLibrary({ "entry.js": source })).rejects.toThrow(
      "does not compile 'use server' actions"
    );
  });

  it("allows ordinary use-server strings outside directive prologues", async () => {
    await expect(
      rscLibrary({
        "entry.js":
          "export const text='use server';export function action(){const value=42;'use server';if(globalThis.enabled){'use server';return value}return 0}"
      })
    ).resolves.toBeDefined();
  });

  it.each([
    {
      entry: "export {Client} from './client.js'",
      client: "'use client';export {Client} from './impl.js'"
    },
    {
      entry: "export {Client} from './client.js'",
      client:
        "'use client';import {Client as Local} from './impl.js';export {Local as Client}"
    },
    {
      entry: "export {Client as Public} from './barrel.js'",
      client: "'use client';export {Client} from './impl.js'"
    },
    {
      entry: "export * from './barrel.js'",
      client: "'use client';export * from './impl.js'"
    },
    {
      entry: "export * as ui from './client.js'",
      client: "'use client';export {Client} from './impl.js'"
    },
    {
      entry: "export {default} from './client.js'",
      client: "'use client';import Local from './impl.js';export default Local"
    }
  ])(
    "rejects an elided client re-export boundary: $entry / $client",
    async ({ entry, client }) => {
      await expect(
        rscLibrary({
          "entry.js": entry,
          "barrel.js": "export * from './client.js'",
          "client.js": client,
          "impl.js": "export const Client=()=>42;export default Client"
        })
      ).rejects.toThrow("separate library entry");
    }
  );

  it("follows cyclic star re-exports without losing client boundaries", async () => {
    await expect(
      rscLibrary({
        "entry.js": "export {Client} from './a.js'",
        "a.js": "export * from './b.js'",
        "b.js": "export * from './a.js';export * from './client.js'",
        "client.js": "'use client';export {Client} from './impl.js'",
        "impl.js": "export const Client=()=>42"
      })
    ).rejects.toThrow("separate library entry");
  });

  it.each([
    "export {value} from './barrel.js'",
    "import {Client} from './client.js';export const value=1"
  ])("allows unused client re-exports: %s", async (entry) => {
    await expect(
      rscLibrary({
        "entry.js": entry,
        "barrel.js": "export {Client} from './client.js';export const value=1",
        "client.js": "'use client';export {Client} from './impl.js'",
        "impl.js": "export const Client=()=>42"
      })
    ).resolves.toBeDefined();
  });

  it.each([
    {
      barrel: "export * from './client.js';export const value=1",
      client: "'use client';export {default} from './impl.js'"
    },
    {
      barrel: "export * from './client.js';export const Client=1",
      client: "'use client';export {Client} from './impl.js'"
    },
    {
      barrel: "export * from './client.js';export * from './other.js'",
      client: "'use client';export {Client} from './impl.js'"
    }
  ])(
    "allows namespaces without excluded or shadowed client exports: $barrel / $client",
    async ({ barrel, client }) => {
      await expect(
        rscLibrary({
          "entry.js": "export * as ui from './barrel.js'",
          "barrel.js": barrel,
          "client.js": client,
          "impl.js": "export const Client=()=>42;export default Client",
          "other.js": "export const Client=1"
        })
      ).resolves.toBeDefined();
    }
  );

  it("preserves a declared client entry that only re-exports a binding", async () => {
    const bundle = await rscLibrary({
      "entry.js": "'use client';export {Client} from './impl.js'",
      "impl.js": "export const Client=()=>42"
    });
    expect(
      Object.values(bundle).find(
        (item): item is Rollup.OutputChunk => item.type === "chunk"
      )?.code
    ).toMatch(/^["']use client["'];/);
  });

  it.each([false, true])(
    "uses root-relative manifest keys for a symlinked root with preserveSymlinks=%s",
    async (preserveSymlinks) => {
      const root = await fixture({
        "real/src/main.js":
          "import {className} from './widgets/chart.js';globalThis.chart=className",
        "real/src/widgets/chart.js":
          "import './chart.css';export const className='chart'",
        "real/src/widgets/chart.css": ".chart{color:red}"
      });
      const linked = join(root, "linked");
      await symlink(join(root, "real"), linked, "junction");

      const bundle = assets(
        await build({
          root: linked,
          configFile: false,
          logLevel: "silent",
          resolve: { preserveSymlinks },
          plugins: [
            minchoVitePlugin({
              appCss: {
                ssrManifest: true,
                routes: [{ id: "chart", entry: "./src/widgets/chart.js" }]
              }
            })
          ],
          build: {
            write: false,
            minify: false,
            rollupOptions: { input: join(linked, "src/main.js") }
          }
        })
      );
      const manifest = JSON.parse(
        String(
          (bundle[".vite/mincho-css-manifest.json"] as Rollup.OutputAsset)
            .source
        )
      ) as MinchoSsrCssManifest;

      const modules = resolveSsrStylesheets(manifest, {
        modules: ["src/widgets/chart.js"]
      });
      expect(modules.length).toBeGreaterThan(0);
      expect(
        resolveSsrStylesheets(manifest, { entries: ["src/main.js"] })
      ).toEqual(modules);
      expect(resolveSsrStylesheets(manifest, { routes: ["chart"] })).toEqual(
        modules
      );
    }
  );

  it.each([false, true])(
    "allows libraryRsc in client and SSR dev environments with build.lib=%s",
    async (library) => {
      const root = await fixture({
        "client.js": "'use client';export const Client=()=>42"
      });
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryRsc: true })],
        build: {
          lib: library
            ? { entry: join(root, "client.js"), formats: ["es"] }
            : false
        },
        server: { middlewareMode: true, watch: null, hmr: false },
        optimizeDeps: { noDiscovery: true }
      });

      try {
        expect((await server.transformRequest("/client.js"))?.code).toContain(
          "Client"
        );
        expect((await server.ssrLoadModule("/client.js")).Client()).toBe(42);
      } finally {
        await server.close();
      }
    }
  );

  it("rejects libraryRsc for a client application build", async () => {
    const root = await fixture({
      "index.html": '<script type="module" src="/client.js"></script>',
      "client.js": "export const Client=()=>42"
    });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryRsc: true })],
        build: { write: false }
      })
    ).rejects.toThrow("libraryRsc is only available for library builds");
  });

  it("resolves CSS-only layouts removed from the final JS chunks", async () => {
    const root = await fixture({
      "index.html": '<script type="module" src="/main.js"></script>',
      "main.js":
        "globalThis.a=()=>import('./a.js');globalThis.b=()=>import('./b.js')",
      "layout.js": "import './layout.css'",
      "a.js": "import './layout.js';import './a.css';export const a=1",
      "b.js": "import './layout.js';export const b=2",
      "layout.css": ".layout{color:green}",
      "a.css": ".a{color:red}"
    });

    const result = assets(
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          minchoVitePlugin({
            appCss: {
              ssrManifest: true,
              routes: [{ id: "a", entry: "./a.js", layouts: ["./layout.js"] }]
            }
          })
        ],
        build: { write: false }
      })
    );

    const manifest = JSON.parse(
      String(
        (result[".vite/mincho-css-manifest.json"] as Rollup.OutputAsset).source
      )
    ) as MinchoSsrCssManifest;

    expect(
      manifest.routes
        .a!.map((file) => String((result[file] as Rollup.OutputAsset).source))
        .join("\n")
    ).toContain("green");
  });

  it.each(["native", "dist-chunk", "single"] as const)(
    "emits ordered %s SSR CSS without unrelated routes/pages",
    async (mode) => {
      const root = await fixture({
        "index.html": '<script type="module" src="/main.js"></script>',
        "other.html": '<script type="module" src="/other.js"></script>',
        "main.js":
          "globalThis.loadA=()=>import('./a.js');globalThis.loadB=()=>import('./b.js')",
        "other.js": "import './other.css'",
        "layout.js": "import './layout.css';export const shared='shared'",
        "a.js":
          "import {shared} from './layout.js';import './a.css';export const a=shared+'a'",
        "b.js":
          "import {shared} from './layout.js';import './b.css';export const b=shared+'b'",
        "layout.css": ".order{color:green}",
        "a.css": ".order{color:red}",
        "b.css": ".b{color:blue}",
        "other.css": ".other{color:pink}"
      });

      const bundle = assets(
        await build({
          root,
          configFile: false,
          logLevel: "silent",
          base: "/app/",
          plugins: [
            minchoVitePlugin({
              appCss: {
                mode,
                ssrManifest: true,
                routes: [
                  { id: "a", entry: "./a.js", layouts: ["./layout.js"] },
                  { id: "b", entry: "./b.js", layouts: ["./layout.js"] }
                ]
              }
            })
          ],
          build: {
            write: false,
            minify: false,
            rollupOptions: {
              input: {
                main: join(root, "index.html"),
                other: join(root, "other.html")
              }
            }
          }
        })
      );

      const asset = bundle[
        ".vite/mincho-css-manifest.json"
      ] as Rollup.OutputAsset;

      const manifest = JSON.parse(String(asset.source)) as MinchoSsrCssManifest;
      const selected = resolveSsrStylesheets(manifest, {
        entries: ["index.html"],
        routes: ["a"]
      });

      const css = selected
        .map((link) =>
          String((bundle[link.href.slice(5)] as Rollup.OutputAsset).source)
        )
        .join("\n");

      expect(css).toContain("green");
      expect(css).toContain("red");
      expect(css.indexOf("green")).toBeLessThan(css.indexOf("red"));

      if (mode !== "single") {
        expect(css).not.toContain("pink");
        expect(css).not.toContain("blue");
      } else expect(selected).toHaveLength(1);
    }
  );

  it.each(["es", "cjs"] as const)(
    "preserves a client entry before CSS and imports in minified %s output",
    async (format) => {
      const root = await fixture({
        "client.js":
          "'use client';import './client.css';export const Client=()=>42",
        "client.css": ".client{color:red}",
        "server.js": "export const Server=()=>1"
      });

      const bundle = assets(
        await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [minchoVitePlugin({ libraryRsc: true })],
          build: {
            write: false,
            minify: true,
            cssCodeSplit: true,
            lib: {
              entry: {
                client: join(root, "client.js"),
                server: join(root, "server.js")
              },
              formats: [format]
            }
          }
        })
      );

      const chunks = Object.values(bundle).filter(
        (item): item is Rollup.OutputChunk => item.type === "chunk"
      );

      expect(chunks.find((chunk) => chunk.name === "client")!.code).toMatch(
        /^["']use client["'];/
      );
      expect(chunks.find((chunk) => chunk.name === "client")!.code).toContain(
        ".css"
      );
      expect(
        chunks.find((chunk) => chunk.name === "server")!.code
      ).not.toContain("use client");
    }
  );

  it("rejects a client module merged into an undeclared server entry", async () => {
    const root = await fixture({
      "client.js": "'use client';export const Client=()=>42",
      "entry.js": "export {Client} from './client.js'"
    });

    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryRsc: true })],
        build: {
          write: false,
          cssCodeSplit: true,
          lib: { entry: join(root, "entry.js"), formats: ["es"] }
        }
      })
    ).rejects.toThrow("separate library entry");
  });

  it("retains client boundaries with preserveModules", async () => {
    const root = await fixture({
      "client.js": "'use client';export const Client=()=>42",
      "entry.js": "export {Client} from './client.js'"
    });

    const bundle = assets(
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryRsc: true })],
        build: {
          write: false,
          cssCodeSplit: true,
          lib: { entry: join(root, "entry.js"), formats: ["es"] },
          rollupOptions: { output: { preserveModules: true } }
        }
      })
    );

    const client = Object.values(bundle).find(
      (item): item is Rollup.OutputChunk =>
        item.type === "chunk" &&
        item.facadeModuleId?.endsWith("/client.js") === true
    );

    expect(client?.code).toMatch(/^["']use client["'];/);
  });

  it("allows re-exports through a separately emitted client facade", async () => {
    const root = await fixture({
      "client.js": "'use client';export const Client=()=>42",
      "entry.js": "export {Client} from './client.js'"
    });
    const bundle = assets(
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin({ libraryRsc: true })],
        build: {
          write: false,
          lib: {
            entry: {
              entry: join(root, "entry.js"),
              client: join(root, "client.js")
            },
            formats: ["es"]
          }
        }
      })
    );
    const chunks = Object.values(bundle).filter(
      (item): item is Rollup.OutputChunk => item.type === "chunk"
    );
    const client = chunks.find((chunk) => chunk.name === "client")!;
    const entry = chunks.find((chunk) => chunk.name === "entry")!;
    expect(client.code).toMatch(/^["']use client["'];/);
    expect(entry.imports).toContain(client.fileName);
    expect(entry.code).not.toContain("use client");
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalMeasureBundleBytes } from "@mincho-js/integration";
import { build, type Rollup } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minchoVitePlugin, type MinchoVitePluginOptions } from "./index.js";
import * as bundleMetrics from "./bundleMetrics.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("native bundle metrics", () => {
  const diagnosticModes: {
    diagnostics: MinchoVitePluginOptions["diagnostics"];
    measured: boolean;
  }[] = [
    { diagnostics: undefined, measured: false },
    { diagnostics: { console: true }, measured: false },
    { diagnostics: { json: "metrics.json" }, measured: true },
    { diagnostics: { trace: "trace.json" }, measured: true },
    { diagnostics: { console: true, json: "metrics.json" }, measured: true },
    { diagnostics: { console: true, trace: "trace.json" }, measured: true }
  ];

  it.each(diagnosticModes)(
    "measures assets only for detailed diagnostics: %j",
    async ({ diagnostics, measured }) => {
      const measure = vi.spyOn(bundleMetrics, "measureOutputBundle");
      const consoleReport = vi
        .spyOn(console, "info")
        .mockImplementation(() => {});
      const root = await mkdtemp(join(tmpdir(), "mincho-bundle-diagnostics-"));
      roots.push(root);

      await Promise.all([
        writeFile(
          join(root, "index.html"),
          '<script type="module" src="/main.js"></script>'
        ),
        writeFile(
          join(root, "main.js"),
          'import "./style.css";globalThis.rendered=true;'
        ),
        writeFile(join(root, "style.css"), ".entry{color:red}")
      ]);
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          minchoVitePlugin({ diagnostics, appCss: { mode: "native" } })
        ],
        build: { write: false, minify: false, cssMinify: false }
      });

      if (measured) expect(measure).toHaveBeenCalledOnce();
      else expect(measure).not.toHaveBeenCalled();

      if (diagnostics?.console)
        expect(consoleReport).toHaveBeenCalledWith(
          "[mincho] compilation",
          expect.objectContaining({ "input-validation": expect.any(Object) })
        );

      if (diagnostics?.json) {
        const report: {
          builds: { events: { phase: string; detail?: unknown }[] }[];
        } = JSON.parse(await readFile(join(root, diagnostics.json), "utf8"));
        expect(
          report.builds
            .flatMap((item) => item.events)
            .find((event) => event.phase === "bundle-size-final")
        ).toMatchObject({
          detail: { estimate: false, cssAssets: 1 }
        });
      }

      if (diagnostics?.trace) {
        const report: {
          traceEvents: { name: string; args: { detail?: unknown } }[];
        } = JSON.parse(await readFile(join(root, diagnostics.trace), "utf8"));
        expect(
          report.traceEvents.find((event) => event.name === "bundle-size-final")
        ).toMatchObject({
          args: { detail: { estimate: false, cssAssets: 1 } }
        });
      }
    }
  );

  it.each([
    { cssCodeSplit: false, renamed: false },
    { cssCodeSplit: false, renamed: true },
    { cssCodeSplit: true, renamed: false },
    { cssCodeSplit: true, renamed: true }
  ])(
    "reports initial and route CSS for %j",
    async ({ cssCodeSplit, renamed }) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-bundle-metrics-"));
      roots.push(root);
      const files = {
        "package.json": '{"name":"bundle-metrics-fixture","type":"module"}',
        "index.html": '<script type="module" src="/main.js"></script>',
        "second.html": '<script type="module" src="/second.js"></script>',
        "main.js":
          'import "./home.css";globalThis.visit=()=>import("./lazy.js");',
        "second.js": 'import "./second.css";globalThis.second=true;',
        "lazy.js": 'import "./lazy.css";export const page="lazy";',
        "home.css": ".home{color:red}",
        "second.css": ".second{color:blue}",
        "lazy.css": ".lazy{color:green}"
      };

      await Promise.all(
        Object.entries(files).map(([name, source]) =>
          writeFile(join(root, name), source)
        )
      );

      const result = (await build({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          minchoVitePlugin({
            diagnostics: { json: "metrics.json" },
            appCss: {
              mode: "native",
              ssrManifest: true,
              routes: [{ id: "lazy", entry: "./lazy.js" }]
            }
          })
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          cssCodeSplit,
          rollupOptions: {
            input: [join(root, "index.html"), join(root, "second.html")],
            output: renamed
              ? { assetFileNames: "assets/[name]-[hash].asset" }
              : {}
          }
        }
      })) as Rollup.RollupOutput;
      const report: {
        builds: {
          events: {
            phase: string;
            detail: ReturnType<typeof bundleMetrics.measureOutputBundle>;
          }[];
        }[];
      } = JSON.parse(await readFile(join(root, "metrics.json"), "utf8"));
      const metrics = report.builds
        .flatMap((item) => item.events)
        .find((event) => event.phase === "bundle-size-final")!.detail;
      const css = result.output.filter(
        (item): item is Rollup.OutputAsset =>
          item.type === "asset" &&
          item.names.some((name) => name.endsWith(".css"))
      );

      expect(css).toHaveLength(cssCodeSplit ? 3 : 1);
      expect(metrics.cssAssets).toBe(css.length);
      expect(metrics.entries).toHaveLength(2);

      for (const entry of metrics.entries) {
        const chunk = result.output.find(
          (item): item is Rollup.OutputChunk =>
            item.type === "chunk" && item.facadeModuleId === entry.entry
        )! as Rollup.OutputChunk & {
          viteMetadata: { importedCss: Set<string> };
        };
        const initial = cssCodeSplit
          ? css.filter((item) =>
              chunk.viteMetadata.importedCss.has(item.fileName)
            )
          : css;

        expect(initial).toHaveLength(1);
        if (!cssCodeSplit) expect(chunk.viteMetadata.importedCss.size).toBe(0);
        expect(entry.cssAssets).toBe(1);
        expect(entry.css).toEqual(
          internalMeasureBundleBytes(initial[0]!.source)
        );
        expect(entry.routeVisits).toHaveLength(1);
        expect(entry.routeVisits[0]!.additionalAssets).toBe(
          cssCodeSplit ? 1 : 0
        );

        if (!cssCodeSplit) {
          expect(entry.routeVisits[0]).toMatchObject({
            coldCss: entry.css,
            cumulativeCss: entry.css,
            additionalCss: { raw: 0, gzip: 0, brotli: 0 }
          });
        }
      }
    }
  );
});

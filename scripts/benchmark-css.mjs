import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build as viteBuild, version as viteVersion } from "vite";
import { minchoVitePlugin } from "../packages/vite/dist/esm/index.mjs";
import { buildWithMincho } from "../packages/esbuild/dist/esm/index.mjs";
import {
  buildApp,
  buildLibrary,
  consumeLibrary
} from "./benchmark-css/build.mjs";
import { browserVisits } from "./benchmark-css/browser.mjs";
import { fileReport } from "./benchmark-css/measure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "apps,library" },
    output: { type: "string" },
    browser: { type: "string", default: process.env.MINCHO_BROWSER_BINARY }
  }
});

const selected = values.cases.split(",");

assert(
  selected.every((value) => ["apps", "library"].includes(value)),
  "Unknown benchmark case"
);

const parent = join(root, ".cache/css-benchmark");
await mkdir(parent, { recursive: true });

const work = await mkdtemp(join(parent, "run-"));
const { build: esbuildBuild, version: esbuildVersion } = createRequire(
  new URL("../packages/esbuild/package.json", import.meta.url)
)("esbuild");

const tools = { viteBuild, minchoVitePlugin, buildWithMincho, esbuildBuild };
const report = {
  version: 1,
  node: process.version,
  tools: { vite: viteVersion, esbuild: esbuildVersion },
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8"
  }).trim(),
  compression: { gzipLevel: 9, brotliQuality: 11, perFile: true },
  duplicateMetric:
    "Repeated synthetic module markers across required CSS files; not selector liveness or removable equal declarations.",
  browser: values.browser ?? "skipped",
  work,
  results: []
};

if (selected.includes("apps")) {
  for (const kind of ["spa", "mpa"]) {
    for (const bundler of ["vite", "esbuild"]) {
      for (const mode of bundler === "vite"
        ? ["single", "native", "dist-chunk", "shared", "routes"]
        : ["native", "shared"]) {
        const id = `${kind}-${bundler}-${mode}`;
        const result = await buildApp(
          tools,
          join(work, id),
          kind,
          bundler,
          mode
        );

        const browser = await browserVisits(
          result.outdir,
          kind === "spa"
            ? ["/index.html", "/index.html?order=reverse"]
            : ["/a.html", "/b.html", "/a.html"],
          values.browser
        );

        if (
          kind === "spa" &&
          bundler === "vite" &&
          mode !== "single" &&
          browser.visits
        ) {
          for (const visit of browser.visits)
            assert.equal(
              visit.phases[0].css.length,
              1,
              "Only home CSS belongs to the initial page"
            );
        }

        report.results.push({
          id,
          kind,
          bundler,
          mode,
          buildMs: result.buildMs,
          generatedArtifacts: result.generatedArtifacts,
          files: fileReport(result.artifacts),
          navigation: result.navigation,
          reverse: result.reverse,
          browser,
          ...(result.artifacts.cssManifest
            ? { cssManifest: result.artifacts.cssManifest }
            : {})
        });
        console.log(
          `[css-benchmark] ${id}: initial CSS ${result.navigation.visits[0].transferred.css.brotli} B br, session ${result.navigation.total.css.brotli} B br`
        );
      }
    }
  }
}

if (selected.includes("library")) {
  for (const layout of ["single", "component", "group"]) {
    const library = join(work, `library-${layout}`);
    const producer = await buildLibrary(tools, library, layout);

    for (const usage of [1, 3, 6, 12]) {
      for (const method of layout === "single"
        ? ["named"]
        : ["named", "subpath"]) {
        for (const bundler of ["vite", "esbuild"]) {
          const id = `library-${layout}-${usage}-${method}-${bundler}`;
          const result = await consumeLibrary(
            tools,
            join(work, id),
            library,
            layout,
            usage,
            method,
            bundler
          );

          const expectedCount =
            layout === "single"
              ? 12
              : layout === "group"
                ? Math.ceil(usage / 4) * 4
                : usage;

          const expectedComponents = Array.from(
            { length: expectedCount },
            (_, i) => i
          );

          // Native esbuild 0.27 retains CSS from unused barrel exports even
          // when the JS modules are marked side-effect-free. Record this case;
          // exact ownership is required for Vite and esbuild subpath imports.
          if (bundler !== "esbuild" || method !== "named") {
            assert.deepEqual(
              result.components,
              expectedComponents,
              `CSS ownership: ${id}`
            );
          } else {
            for (let i = 0; i < usage; i++)
              assert(
                result.components.includes(i),
                `Missing CSS for component${i}`
              );
          }

          assert(result.shared, `Missing shared CSS: ${id}`);

          report.results.push({
            id,
            kind: "library",
            layout,
            usage,
            method,
            includedComponents: result.components,
            unusedComponents: result.components.filter((i) => i >= usage),
            bundler,
            buildMs: result.buildMs,
            components: result.components,
            producerFiles: fileReport(producer),
            files: fileReport(result.artifacts),
            navigation: result.navigation
          });
          console.log(
            `[css-benchmark] ${id}: ${result.navigation.total.css.brotli} B br`
          );
        }
      }
    }
  }
}

const target = values.output
  ? resolve(values.output)
  : join(work, "report.json");

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(report, null, 2) + "\n");
console.log(`[css-benchmark] report: ${target}`);

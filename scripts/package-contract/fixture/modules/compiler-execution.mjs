import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build as viteBuild } from "vite";

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(import.meta.dirname, "execution-proof-"));
const filename = join(root, "entry.tsx");
const source = `
  import { color } from "./color";
  export const App = () => <div css={{ color }} />;
  /*${"worker payload ".repeat(3000)}*/
`;

await writeFile(filename, source);
await writeFile(join(root, "color.ts"), 'export const color = "red";');

function events(diagnostics) {
  return diagnostics.builds.flatMap((build) => build.events);
}

try {
  for (const mode of ["import", "require"]) {
    const load = (id) => (mode === "import" ? import(id) : require(id));
    const integration = await load("@mincho-js/integration");
    const execution = new integration.InternalCompilationExecution({
      workers: 1
    });
    const diagnostics = new integration.CompilationDiagnostics({
      console: true
    });
    const input = {
      filename,
      source,
      sourceMaps: true,
      babel: {
        jsxCssProp: true,
        staticCssEvalSourceProvider: {
          resolve: (_owner, request) =>
            request === "./color" ? { id: join(root, "color.ts") } : null,
          load: async (id) => ({ source: await readFile(id, "utf8") })
        }
      }
    };

    try {
      const inline = await integration.babelTransformSource(input);
      for (let index = 0; index < 2; index++) {
        const result = await diagnostics.run(filename, "transform", () =>
          execution.run(() => integration.babelTransformSource(input))
        );
        assert.equal(result.code, inline.code, `${mode}: transformed JS`);
        assert.deepEqual(result.map, inline.map, `${mode}: source map`);
        assert.deepEqual(result.result, inline.result, `${mode}: CSS sidecar`);
        for (const field of [
          "dependencies",
          "dependencyFiles",
          "resolvedDependencies",
          "diagnostics"
        ]) {
          assert.deepEqual(
            result.staticCssEval?.[field],
            inline.staticCssEval?.[field],
            `${mode}: ${field}`
          );
        }
      }

      const recorded = events(diagnostics.snapshot());
      assert.equal(
        recorded.filter((event) => event.phase === "worker-run").length,
        2,
        mode
      );
      assert.ok(
        recorded.some(
          (event) =>
            event.phase === "worker-ipc-source" &&
            event.detail.mode === "reference"
        ),
        `${mode}: source reference`
      );
      assert.ok(
        recorded.some(
          (event) =>
            event.phase === "worker-ipc-result" && event.detail.payloadHits > 0
        ),
        `${mode}: worker source reuse`
      );
    } finally {
      await execution.close();
    }

    const esbuild = await load("@mincho-js/esbuild");
    const vite = await load("@mincho-js/vite");
    for (const bundler of ["esbuild", "vite"]) {
      const outputs = [];
      for (const workers of [0, 1]) {
        const report = join(root, `${mode}-${bundler}-${workers}.json`);
        const options = {
          jsxCssProp: true,
          cache: false,
          execution: { workers, ioConcurrency: 1 },
          diagnostics: { json: report }
        };
        let css;
        if (bundler === "esbuild") {
          const result = await esbuild.buildWithMincho({
            absWorkingDir: root,
            entryPoints: [filename],
            outdir: join(root, "dist"),
            bundle: true,
            format: "esm",
            jsx: "automatic",
            external: ["react", "react/jsx-runtime", "@mincho-js/react"],
            write: false,
            mincho: options
          });
          css = result.outputFiles
            .filter((file) => file.path.endsWith(".css"))
            .map((file) => file.text);
        } else {
          const result = await viteBuild({
            root,
            configFile: false,
            logLevel: "silent",
            plugins: [vite.minchoVitePlugin(options)],
            build: {
              write: false,
              minify: false,
              cssCodeSplit: true,
              lib: { entry: filename, formats: ["es"] },
              rollupOptions: {
                external: [/^react(?:\/|$)/, /^@mincho-js\/react(?:\/|$)/]
              }
            }
          });
          css = [result]
            .flat()
            .flatMap((output) => output.output)
            .filter(
              (file) => file.type === "asset" && file.fileName.endsWith(".css")
            )
            .map((file) => String(file.source));
        }
        assert.ok(
          css.join("\n").includes("red"),
          `${mode}/${bundler}: CSS output`
        );
        outputs.push(css);
        const recorded = events(JSON.parse(await readFile(report, "utf8")));
        assert.equal(
          recorded.some((event) => event.phase === "worker-run"),
          workers > 0,
          `${mode}/${bundler}: worker option`
        );
      }
      assert.deepEqual(
        outputs[1],
        outputs[0],
        `${mode}/${bundler}: worker/inline CSS`
      );
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("[package-contract] installed ESM/CJS compiler execution passed");

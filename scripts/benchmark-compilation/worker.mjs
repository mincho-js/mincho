import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import crypto from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { entryName, edit, editShared, editedFileName } from "./fixture.mjs";

const [consumer, directory, name, format, bundler, diagnosticFile] =
  process.argv.slice(2);

const require = createRequire(join(consumer, "package.json"));
const operationCounts = {
  readFile: 0,
  readFileSync: 0,
  readFilePromise: 0,
  createHash: 0
};

if (diagnosticFile) {
  for (const [target, key, counter] of [
    [fs, "readFile", "readFile"],
    [fs, "readFileSync", "readFileSync"],
    [fs.promises, "readFile", "readFilePromise"],
    [crypto, "createHash", "createHash"]
  ]) {
    const original = target[key];
    target[key] = function (...args) {
      operationCounts[counter]++;

      return Reflect.apply(original, this, args);
    };
  }

  syncBuiltinESMExports();
}

const started = performance.now();

const hash = (value) => createHash("sha256").update(value).digest("hex");

const size = (text) => {
  const bytes = Buffer.from(text);

  return {
    raw: bytes.length,
    gzip: gzipSync(bytes).length,
    brotli: brotliCompressSync(bytes).length
  };
};

const versions = {};

for (const id of [
  "esbuild",
  "vite",
  "react",
  "react-dom",
  "@babel/core",
  "@vanilla-extract/css"
])
  versions[id] = require(id + "/package.json").version;

const options = diagnosticFile ? { diagnostics: { json: diagnosticFile } } : {};
const record = {
  node: process.version,
  versions,
  name,
  format,
  bundler,
  phases: {},
  outputs: {}
};

record.compilerHashes = {};

for (const id of [
  "@mincho-js/babel",
  "@mincho-js/integration",
  "@mincho-js/esbuild",
  "@mincho-js/vite"
])
  record.compilerHashes[id] = hash(await readFile(require.resolve(id)));

let serial = 0;

async function capture(label, js, css) {
  if (bundler === "vite") {
    record.outputs[label] = {
      js: size(js),
      css: size(css),
      cssHash: hash(css)
    };

    return;
  }

  const artifact = join(
    directory,
    "output",
    "artifact-" + serial++ + "." + (format === "cjs" ? "cjs" : "mjs")
  );

  await writeFile(artifact, js);

  const exported =
    format === "cjs"
      ? require(artifact)
      : await import(pathToFileURL(artifact));

  let value;

  if (exported.App) {
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    value = [0, 1].map((tick) =>
      renderToStaticMarkup(
        React.createElement(exported.App, { count: 50, tick })
      )
    );
  } else
    value = [
      exported.classes,
      exported.dynamic?.({ size: "large", active: true }),
      exported.versions
    ];

  record.outputs[label] = {
    js: size(js),
    css: size(css),
    cssHash: hash(css),
    valueHash: hash(JSON.stringify(value))
  };
}

const callbacks = [];
const diagnosticOffsets = new Map();
const deferredDiagnosticPhases = [];

async function captureDiagnostics(label, report, until) {
  if (!diagnosticFile) return;

  report ??= JSON.parse(await readFile(diagnosticFile, "utf8"));
  const counts = {};

  for (const build of report.builds) {
    const events =
      until === undefined
        ? build.events
        : build.events.filter((event) => event.start + event.duration <= until);
    const previous = diagnosticOffsets.get(build.environment);
    const offset =
      previous?.generation === build.generation ? previous.events : 0;

    for (const event of events.slice(offset)) {
      const key =
        event.phase.startsWith("cache-") && event.detail?.key
          ? event.phase + ":" + event.detail.key.split(":")[0]
          : event.phase;

      counts[key] = (counts[key] ?? 0) + 1;
    }

    diagnosticOffsets.set(build.environment, {
      generation: build.generation,
      events: events.length
    });
  }

  ((record.diagnostics ??= {})[label] ??= []).push(counts);
}

async function measure(label, build, save) {
  const operations = { ...operationCounts };
  const start = performance.now();
  const output = await build();
  const end = performance.now();
  const milliseconds = end - start;

  if (label === "first") {
    record.firstReadyMs = performance.now() - started;
    console.log(JSON.stringify({ event: "first-ready" }));
  }

  (record.phases[label] ??= []).push(milliseconds);

  if (diagnosticFile)
    ((record.operations ??= {})[label] ??= []).push(
      Object.fromEntries(
        Object.entries(operationCounts).map(([key, value]) => [
          key,
          value - operations[key]
        ])
      )
    );

  if (diagnosticFile && bundler === "vite-dev")
    deferredDiagnosticPhases.push({ label, until: end });
  else await captureDiagnostics(label);

  if (save) await save(output);

  return output;
}

try {
  if (bundler === "esbuild") {
    const esbuild = require("esbuild");
    const { minchoEsbuildPlugins } = require("@mincho-js/esbuild");
    const compiler = await esbuild.context({
      absWorkingDir: directory,
      entryPoints: [entryName(format, name)],
      outdir: join(directory, "output"),
      write: false,
      bundle: true,
      format,
      platform: "browser",
      minify: true,
      jsx: "automatic",
      external: ["react", "react-dom"],
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: minchoEsbuildPlugins(options)
    });

    callbacks.push(() => compiler.dispose());

    const save = (label) => async (result) => {
      const js = result.outputFiles
        .filter((file) => file.path.endsWith(".js"))
        .map((file) => file.text)
        .join("\n");

      const css = result.outputFiles
        .filter((file) => file.path.endsWith(".css"))
        .map((file) => file.text)
        .join("\n");

      await capture(label, js, css);
    };

    await measure("first", () => compiler.rebuild(), save("first"));

    const first = record.outputs.first;

    for (let iteration = 0; iteration < 3; iteration++) {
      await measure("unchanged", () => compiler.rebuild(), save("unchanged"));

      assert.deepEqual(record.outputs.unchanged, first);
    }

    for (let iteration = 0; iteration < 3; iteration++) {
      await edit(directory, name, format, iteration + 1);
      await measure(
        "edited",
        () => compiler.rebuild(),
        save("edited-" + iteration)
      );

      if (/^(logic|environments)-/.test(name)) {
        const edited = record.outputs["edited-" + iteration];
        const previous =
          iteration === 0 ? first : record.outputs["edited-" + (iteration - 1)];

        assert.equal(edited.cssHash, first.cssHash);
        assert.notEqual(edited.valueHash, previous.valueHash);
      }
    }

    if (name.startsWith("shared-"))
      for (let iteration = 0; iteration < 3; iteration++) {
        await editShared(directory, format, iteration + 1);
        await measure(
          "shared",
          () => compiler.rebuild(),
          save("shared-" + iteration)
        );
      }
  } else {
    const vite = await import(pathToFileURL(require.resolve("vite")));
    const { minchoVitePlugin } = require("@mincho-js/vite");
    const common = {
      root: directory,
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin(options)],
      esbuild: { jsx: "automatic" }
    };

    if (bundler === "vite") {
      const result = await measure("first", () =>
        vite.build({
          ...common,
          build: {
            write: false,
            minify: true,
            cssMinify: true,
            cssCodeSplit: true,
            lib: {
              entry: join(directory, entryName(format, name)),
              formats: [format === "esm" ? "es" : "cjs"]
            },
            rollupOptions: {
              external: (id) => /^react(?:-dom)?(?:\/|$)/.test(id)
            }
          }
        })
      );

      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => item.output
      );

      await capture(
        "first",
        outputs
          .filter((file) => file.type === "chunk")
          .map((file) => file.code)
          .join("\n"),
        outputs
          .filter(
            (file) => file.type === "asset" && file.fileName.endsWith(".css")
          )
          .map((file) => String(file.source))
          .join("\n")
      );
    } else {
      const server = await vite.createServer({
        ...common,
        cacheDir: join(
          consumer,
          "node_modules",
          ".vite-mincho-benchmark",
          String(process.pid)
        ),
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: format !== "cjs", entries: [] }
      });

      callbacks.push(() => server.close());

      const entry = "/" + entryName(format, name);

      const loadEnvironment = async (environment) => {
        const pending = [entry],
          visited = new Set();

        while (pending.length) {
          const url = pending.shift();
          if (visited.has(url)) continue;

          visited.add(url);
          await environment.transformRequest(url);

          const module = await environment.moduleGraph.getModuleByUrl(url);

          for (const dependency of module?.importedModules ?? [])
            if (
              dependency.id &&
              !/(?:node_modules|\.yarn)\//.test(dependency.id) &&
              !dependency.url.startsWith("/@vite/")
            )
              pending.push(dependency.url);
        }
      };

      const environments = name.startsWith("environments-")
        ? [server.environments.client, server.environments.ssr]
        : [server.environments.client];

      const loadGraph = async () => {
        for (const environment of environments)
          await loadEnvironment(environment);
      };

      await measure("first", loadGraph);

      for (let iteration = 0; iteration < 3; iteration++)
        await measure("unchanged", loadGraph);

      for (let iteration = 0; iteration < 3; iteration++) {
        await edit(directory, name, format, iteration + 1);

        const changed = join(directory, editedFileName(name, format));

        for (const environment of environments) {
          // Extracted, build-time-only dependencies need the watcher hook too.
          await environment.pluginContainer.watchChange(changed, {
            event: "update"
          });

          const module = environment.moduleGraph.getModuleById(changed);

          if (module) environment.moduleGraph.invalidateModule(module);

          const owner = environment.moduleGraph.getModuleById(
            join(directory, entryName(format, name))
          );

          if (owner) environment.moduleGraph.invalidateModule(owner);
        }

        await measure("edited", loadGraph);
      }

      record.note =
        "Development timings cover transformRequest after watcher hooks and explicit graph invalidation; browser network/render latency is excluded.";
    }
  }

  global.gc?.();
  record.heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
  record.rssMiB = process.memoryUsage().rss / 1024 / 1024;
  record.peakRssMiB = process.resourceUsage().maxRSS / 1024;
} finally {
  for (const close of callbacks.reverse()) await close();
}

if (deferredDiagnosticPhases.length) {
  const report = JSON.parse(await readFile(diagnosticFile, "utf8"));

  for (const { label, until } of deferredDiagnosticPhases)
    await captureDiagnostics(label, report, until);
}

console.log(JSON.stringify(record));

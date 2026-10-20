import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import * as vite from "vite";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

const { values } = parseArgs({
  options: {
    workload: { type: "string" },
    bundler: { type: "string" },
    profile: { type: "string" },
    diagnostics: { type: "boolean", default: false }
  }
});

const { workload, bundler, profile } = values;
const root = resolve("fixture", workload);
const count = workload === "tokens" ? 48 : 24;
const report = {
  workload,
  bundler,
  profile,
  count,
  measurements: {},
  outputs: {}
};

const hash = (text) => createHash("sha256").update(text).digest("hex");

const size = (text) => ({
  bytes: Buffer.byteLength(text),
  gzip: gzipSync(text, { level: 9 }).length,
  brotli: brotliCompressSync(text, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
  }).length
});

await mkdir(root, { recursive: true });
await rm(join(root, "diagnostics.json"), { force: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify({
    name: "atomic-defaults-fixture",
    type: "module",
    sideEffects: true
  })
);
await writeFile(
  join(root, "build.ts"),
  "export const staticValue = fn => fn();"
);

const producerName = workload === "ordinary" ? "tokens.css.ts" : "tokens.ts";

function tokens(color = "red", name = "brand") {
  return `import {createVar, globalCss} from "@mincho-js/css";
${name === "renamed" ? 'export const inserted=createVar("inserted");' : ""}
${Array.from({ length: 16 }, (_, i) => `export const token${i}=createVar("${name}${i}");`).join("\n")}
globalCss(":root",{vars:{${Array.from({ length: 16 }, (_, i) => `[token${i}]:"${color}"`).join(",")}}});`;
}

await writeFile(join(root, producerName), tokens());

if (workload === "ordinary") {
  await writeFile(
    join(root, "rules.css.ts"),
    `import {defineRules} from "@mincho-js/css";
export const {css,cx}=defineRules({properties:{color:true,display:true}});
export const red=css({color:"red",display:"flex"});
export const blue=css({color:"blue"});`
  );
}

for (let i = 0; i < count; i++) {
  let source;

  if (workload === "extracted-cx") {
    source = `import {defineRules} from "@mincho-js/css";
import {staticValue} from "./build";
const owner=defineRules({properties:{color:true,display:true}});
const red=staticValue(()=>owner.css({color:"red",display:"flex"}));
const blue=staticValue(()=>owner.css({color:"blue"}));
const cx=staticValue(()=>owner.cx);
export const stable${i}=cx(red,blue);
const table=[cx(red),cx(red,blue)];
export const render${i}=active=>table[active?1:0];`;
  } else if (workload === "tokens") {
    source = `import {${Array.from({ length: 16 }, (_, n) => `token${n}`).join(",")}} from "./tokens";
export const values${i}=[${Array.from({ length: 16 }, (_, n) => `token${n}`).join(",")}];
export const render${i}=active=>values${i}[active?0:1];`;
  } else {
    source = `import {cx,red,blue} from "./rules.css";
import {token0,token1} from "./tokens.css";
export const stable${i}=cx(red,blue);
export const values${i}=[token0,token1];
export const render${i}=active=>cx(active?red:blue);`;
  }

  await writeFile(join(root, `consumer${i}.ts`), source);
}

await writeFile(
  join(root, "entry.ts"),
  Array.from(
    { length: count },
    (_, i) => `export * from "./consumer${i}";`
  ).join("\n")
);

const editedFile = join(
  root,
  workload === "extracted-cx" ? "consumer0.ts" : producerName
);

const original = await readFile(editedFile, "utf8");

const edit = async (phase) => {
  const source =
    workload === "extracted-cx"
      ? original.replace(
          'color:"red"',
          phase === "css-edit" ? 'color:"green"' : 'color:"purple"'
        )
      : tokens(
          phase === "css-edit" ? "green" : "blue",
          phase === "reference-edit" ? "renamed" : "brand"
        );

  await writeFile(editedFile, source);
};

const options = {
  cache: { type: "memory" },
  execution: { workers: 0 },
  optimize: {
    staticScopedCx: profile === "cx",
    symbolicTokens: profile === "tokens"
  },
  ...(workload === "extracted-cx"
    ? { extractCalls: { "./build.ts": ["staticValue"] } }
    : {}),
  ...(values.diagnostics
    ? { diagnostics: { json: join(root, "diagnostics.json") } }
    : {})
};

const diagnosticOffsets = new Map();

async function measure(label, operation, capture) {
  const started = performance.now();
  const result = await operation();
  report.measurements[label] = performance.now() - started;

  if (capture) await capture(label, result);

  if (values.diagnostics) {
    try {
      const diagnostic = JSON.parse(
        await readFile(join(root, "diagnostics.json"), "utf8")
      );

      const events = diagnostic.builds.flatMap((build) => {
        const key = `${build.environment}:${build.generation}`;
        const events = build.events.slice(diagnosticOffsets.get(key) ?? 0);
        diagnosticOffsets.set(key, build.events.length);

        return events;
      });

      report.diagnostics ??= {};
      report.diagnostics[label] = {
        phases: Object.fromEntries(
          [...new Set(events.map((event) => event.phase))].map((phase) => [
            phase,
            {
              count: events.filter((event) => event.phase === phase).length,
              ms: events
                .filter((event) => event.phase === phase)
                .reduce((sum, event) => sum + event.duration, 0)
            }
          ])
        ),
        cx: events
          .filter((event) => event.phase === "static-scoped-cx-result")
          .map((event) => event.detail),
        tokens: events.filter(
          (event) => event.phase === "symbolic-token-reference"
        ).length,
        runtimeCache: Object.fromEntries(
          ["hit", "miss", "invalidated", "created", "pending"].map((kind) => [
            kind,
            events.filter(
              (event) =>
                event.phase === `cache-${kind}` &&
                event.detail?.key?.startsWith("runtime:")
            ).length
          ])
        )
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return result;
}

async function capture(label, assets) {
  const js = assets
    .filter((file) => file.name.endsWith(".js"))
    .map((file) => file.text)
    .join("\n");

  const css = assets
    .filter((file) => file.name.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");

  report.outputs[label] = {
    js: size(js),
    css: size(css),
    jsHash: hash(js),
    cssHash: hash(css)
  };

  {
    if (label === "cold") global.gc?.();

    const started = performance.now();
    const exports = await import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}#${label}`
    );

    if (label === "cold") report.initializationMs = performance.now() - started;

    const values = Object.entries(exports).filter(
      ([key]) => !key.startsWith("render")
    );

    report.outputs[label].runtimeHash = hash(JSON.stringify(values));

    if (label === "cold")
      report.runtimeHash = report.outputs[label].runtimeHash;

    assert.equal(
      Object.keys(exports).filter((key) => key.startsWith("render")).length,
      count
    );

    for (let i = 0; i < count; i++) {
      assert.equal(typeof exports[`render${i}`](true), "string");
      assert.equal(typeof exports[`render${i}`](false), "string");
    }
  }

  if (label === "unchanged")
    assert.deepEqual(report.outputs[label], report.outputs.cold);

  if (label === "css-edit") {
    assert.notEqual(report.outputs[label].cssHash, report.outputs.cold.cssHash);

    if (workload !== "extracted-cx")
      assert.equal(
        report.outputs[label].runtimeHash,
        report.outputs.cold.runtimeHash,
        "CSS value edit changed exported token references"
      );

    assert.match(css, /green/);
  }

  if (label === "reference-edit" && workload !== "extracted-cx")
    assert.notEqual(
      report.outputs[label].runtimeHash,
      report.outputs.cold.runtimeHash
    );
}

const devServers = [];
const viteCommon = {
  root,
  configFile: false,
  logLevel: "silent",
  cacheDir: join(root, ".vite-cache"),
  plugins: [
    minchoVitePlugin(options),
    ...(workload === "ordinary"
      ? [
          vanillaExtractPlugin({
            unstable_pluginFilter: ({ name }) =>
              name === "atomic-defaults-watchers"
          })
        ]
      : []),
    {
      name: "atomic-defaults-watchers",

      configureServer(server) {
        devServers.push(server);
      }
    }
  ]
};

if (bundler === "esbuild") {
  const compiler = await esbuild.context({
    absWorkingDir: root,
    entryPoints: ["entry.ts"],
    outdir: join(root, "out"),
    bundle: true,
    format: "esm",
    write: false,
    minify: true,
    logLevel: "silent",
    plugins: minchoEsbuildPlugins(options)
  });

  const run = (label) =>
    measure(
      label,
      () => compiler.rebuild(),
      (label, result) =>
        capture(
          label,
          result.outputFiles.map((file) => ({
            name: file.path,
            text: file.text
          }))
        )
    );

  try {
    await run("cold");
    await run("unchanged");

    for (const phase of ["css-edit", "reference-edit"]) {
      await edit(phase);
      await run(phase);
    }
  } finally {
    await compiler.dispose();
  }
} else if (bundler === "vite") {
  await measure(
    "cold",
    () =>
      vite.build({
        ...viteCommon,
        build: {
          write: false,
          minify: true,
          cssMinify: true,
          outDir: join(root, "out"),
          target: "esnext",
          rollupOptions: {
            input: join(root, "entry.ts"),
            preserveEntrySignatures: "exports-only",
            output: { format: "es", entryFileNames: "entry.js" }
          }
        }
      }),
    (label, result) =>
      capture(
        label,
        (Array.isArray(result) ? result : [result])
          .flatMap((result) => result.output)
          .map((file) => ({
            name: file.fileName,
            text: file.type === "chunk" ? file.code : String(file.source)
          }))
      )
  );
} else {
  assert.equal(bundler, "vite-dev");

  const server = await vite.createServer({
    ...viteCommon,
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, entries: [] }
  });

  const environment = server.environments.client;
  let previousCss;

  const graph = async () => {
    const pending = ["/entry.ts"],
      visited = new Set(),
      outputs = [];

    while (pending.length) {
      const url = pending.shift();
      if (visited.has(url)) continue;

      visited.add(url);

      const result = await environment.transformRequest(url);

      if (result) outputs.push([url, result.code]);

      const module = await environment.moduleGraph.getModuleByUrl(url);

      for (const dependency of module?.importedModules ?? [])
        if (
          dependency.id &&
          !/(?:node_modules|\.yarn)\//.test(dependency.id) &&
          !dependency.url.startsWith("/@vite/")
        )
          pending.push(dependency.url);
    }

    return outputs;
  };

  const save = (label, outputs) => {
    const text = outputs.map(([, code]) => code).join("\n");
    const references = [
      ...new Set([...text.matchAll(/var\(--[^)]+\)/g)].map((match) => match[0]))
    ].sort();

    const css = outputs
      .filter(([url]) => url.includes(".css"))
      .map(([, code]) => code)
      .join("\n");

    report.outputs[label] = {
      modules: outputs.length,
      references,
      bytes: outputs.reduce(
        (sum, [, code]) => sum + Buffer.byteLength(code),
        0
      ),
      cssHash: hash(css)
    };

    if (label === "cold") previousCss = hash(css);

    if (label === "css-edit") {
      assert.notEqual(hash(css), previousCss);
      assert.match(css, /green/);

      if (workload !== "extracted-cx")
        assert.deepEqual(references, report.outputs.cold.references);
    }

    if (label === "reference-edit" && workload !== "extracted-cx") {
      assert.ok(report.outputs.cold.references.length);
      assert.ok(
        report.outputs.cold.references.every(
          (reference) => !references.includes(reference)
        ),
        "Stale token reference after HMR"
      );
    }
  };

  try {
    await measure("cold", graph, save);
    await measure("unchanged", graph, save);

    for (const phase of ["css-edit", "reference-edit"]) {
      await edit(phase);
      await measure(
        phase,
        async () => {
          // Await Vite's actual change listeners, including watchChange, all
          // environment invalidation and handleHotUpdate (needed by vanilla).
          assert.ok(
            devServers.some((candidate) => candidate.watcher === server.watcher)
          );

          // Vanilla Extract has its own Vite compiler server and runner cache.
          // Dispatch there too; omitting it would measure stale CSS as a fast hit.
          for (const watched of [...devServers].reverse()) {
            const listeners = watched.watcher.listeners("change");

            assert.ok(listeners.length);

            for (const listener of listeners)
              await listener.call(watched.watcher, editedFile);
          }

          return graph();
        },
        save
      );
    }
  } finally {
    await server.close();
  }
}

report.peakRssMiB = process.resourceUsage().maxRSS / 1024;
console.log(JSON.stringify(report));

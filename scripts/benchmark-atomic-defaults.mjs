// Compare individual switches on one isolated snapshot of the current compiler.
// The seed is an installed consumer from benchmark-compilation.mjs --pack.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    consumer: { type: "string" },
    "vanilla-consumer": { type: "string" },
    prepared: { type: "string" },
    rounds: { type: "string", default: "7" },
    smoke: { type: "boolean", default: false },
    output: {
      type: "string",
      default: ".cache/benchmarks/atomic-runtime-default-decision.json"
    }
  }
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const rounds = Number(values.rounds);

assert.ok(
  values.prepared || values.consumer,
  "Provide --consumer=/installed/consumer or --prepared=/isolated/snapshot"
);
assert.ok(Number.isInteger(rounds) && (values.smoke || rounds >= 5));

const root = await realpath(
  values.prepared
    ? resolve(values.prepared)
    : await mkdtemp(join(tmpdir(), "mincho-atomic-defaults-"))
);

if (!values.prepared) {
  const seed = resolve(values.consumer);
  await cp(join(seed, "node_modules"), join(root, "node_modules"), {
    recursive: true
  });
  await cp(join(seed, "package.json"), join(root, "package.json"));

  const require = createRequire(join(root, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);

  for (const name of ["babel", "integration", "esbuild", "vite"]) {
    const directory = join(root, "node_modules/@mincho-js", name);

    assert.ok(
      (await realpath(directory)).startsWith(root + "/"),
      "Compiler packages must be private copies"
    );

    await cp(join(repo, "packages", name, "src"), join(directory, "src"), {
      recursive: true
    });

    const entries =
      name === "integration"
        ? {
            index: "index.ts",
            compilerWorker: "compilerWorker.ts",
            "package-graph": "package-graph.ts"
          }
        : { index: "index.ts" };

    await build({
      root: directory,
      configFile: false,
      logLevel: "warn",
      define: {
        "import.meta.vitest": "undefined",
        "import.meta.debugLog": "undefined"
      },
      build: {
        outDir: join(directory, "dist"),
        emptyOutDir: true,
        target: "es2020",
        minify: false,
        lib: {
          entry: Object.fromEntries(
            Object.entries(entries).map(([name, file]) => [
              name,
              join(directory, "src", file)
            ])
          ),
          formats: ["es", "cjs"],

          fileName: (format, name) =>
            `${format === "es" ? "esm" : "cjs"}/${name}.${format === "es" ? "mjs" : "cjs"}`
        },
        rollupOptions: {
          external: (id) =>
            !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),

          output: { interop: "compat" }
        }
      }
    });
    process.stderr.write(`Prepared ${name}\n`);
  }
}

if (values["vanilla-consumer"]) {
  const seedModules = join(resolve(values["vanilla-consumer"]), "node_modules");
  const names = [];

  for (const entry of await readdir(seedModules)) {
    if (entry.startsWith(".") || entry === "@mincho-js") continue;

    if (entry.startsWith("@"))
      names.push(
        ...(await readdir(join(seedModules, entry))).map(
          (name) => `${entry}/${name}`
        )
      );
    else names.push(entry);
  }

  for (const name of names) {
    const destination = join(root, "node_modules", name);

    try {
      await readFile(join(destination, "package.json"));
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const source = join(seedModules, name);
    await cp(source, destination, { recursive: true });
  }
}

await cp(
  join(repo, "scripts/benchmark-atomic-defaults/worker.mjs"),
  join(root, "atomic-defaults-worker.mjs")
);
process.stderr.write(`Snapshot: ${root}\n`);

const sha = (source) => createHash("sha256").update(source).digest("hex");

async function fingerprint(directory) {
  const result = {};

  const visit = async (directory, prefix = "") => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name),
        name = prefix + entry.name;

      if (entry.isDirectory()) await visit(file, name + "/");
      else result[name] = sha(await readFile(file));
    }
  };

  await visit(directory);

  return result;
}

const packageHashes = {};
const sourceTreeHashes = {};

for (const name of ["babel", "integration", "esbuild", "vite"])
  sourceTreeHashes[name] = sha(
    JSON.stringify(
      await fingerprint(join(root, "node_modules/@mincho-js", name, "src"))
    )
  );

for (const name of ["babel", "integration", "esbuild", "vite", "css"])
  packageHashes[name] = await fingerprint(
    join(root, "node_modules/@mincho-js", name, "dist")
  );

const report = {
  createdAt: new Date().toISOString(),
  root,
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  initialLoad: loadavg(),
  rounds,
  smoke: values.smoke,
  versions: {},
  packageHashes,
  sourceTreeHashes,
  workerSha256: sha(await readFile(join(root, "atomic-defaults-worker.mjs"))),
  methodology: {
    comparison:
      "The same current-source compiler snapshot, off versus one explicitly enabled option; other profile defaults unchanged.",
    compilerBuild:
      "Private copy of installed dependencies; current Babel/integration/esbuild/Vite sources compiled with Vite/Rollup, es2020, external dependencies, ESM and CJS; no workspace dist changes.",
    order:
      "Fresh Node process for each sample; switch order alternates; cases and bundlers rotate. No concurrent benchmark samples.",
    cache: "memory",
    workers: 0,
    diagnostics: "separate untimed samples",
    minify: true,
    cold: "esbuild first context rebuild, Vite production build, or Vite development client import-graph transformation; dependency imports and fixture setup excluded.",
    updates:
      "Native esbuild context rebuild; Vite development awaits native watcher change listeners on all servers, including Vanilla Extract's compiler server (watchChange, module invalidation, HMR hooks), then transformRequest. No OS watcher debounce, browser network, HMR transport or rendering latency.",
    edits:
      "CSS value changes, then token variable-reference changes by inserting a createVar before existing tokens; cx workload edits one feature's CSS twice.",
    compression:
      "gzip level 9 and Brotli quality 11, measured after build timing; runtime module import measured separately.",
    workloads: {
      ordinary:
        "24 consumers of ordinary .css.ts defineRules and token exports",
      "extracted-cx":
        "24 feature modules using configured extractCalls with 72 module-initialization cx calls",
      tokens:
        "48 consumers, each reading 16 generated createVar exports (768 reads)"
    }
  },
  samples: [],
  diagnostics: []
};

for (const name of [
  "vite",
  "rollup",
  "esbuild",
  "@babel/core",
  "@vanilla-extract/css",
  "@vanilla-extract/vite-plugin",
  "@vanilla-extract/compiler",
  "vite-node"
])
  report.versions[name] = JSON.parse(
    await readFile(join(root, "node_modules", name, "package.json"), "utf8")
  ).version;

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.NODE_ENV;

async function run(workload, bundler, profile, diagnostic = false) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--expose-gc",
      "atomic-defaults-worker.mjs",
      "--workload",
      workload,
      "--bundler",
      bundler,
      "--profile",
      profile,
      ...(diagnostic ? ["--diagnostics"] : [])
    ],
    { cwd: root, env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
  );

  const line = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));

  assert.ok(line, stdout);

  return JSON.parse(line);
}

const cases = [
  ["ordinary", "cx"],
  ["ordinary", "tokens"],
  ["extracted-cx", "cx"],
  ["tokens", "tokens"]
];

const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });

const checkpoint = () =>
  writeFile(output, JSON.stringify(report, null, 2) + "\n");

await checkpoint();

for (let round = 0; round < (values.smoke ? 1 : rounds); round++) {
  for (let offset = 0; offset < cases.length; offset++) {
    const [workload, profile] = cases[(round + offset) % cases.length];
    const bundlers = ["esbuild", "vite", "vite-dev"];

    for (let n = 0; n < bundlers.length; n++) {
      const bundler = bundlers[(round + n) % bundlers.length];
      const pair = {};

      for (const current of round % 2 ? [profile, "off"] : ["off", profile]) {
        const result = await run(workload, bundler, current);
        report.samples.push({ round, comparison: profile, ...result });
        pair[current] = result;
      }

      if (bundler !== "vite-dev") {
        assert.equal(
          pair.off.runtimeHash,
          pair[profile].runtimeHash,
          "Runtime output changed"
        );
        assert.equal(
          pair.off.outputs.cold.cssHash,
          pair[profile].outputs.cold.cssHash,
          "CSS output changed"
        );
      }

      process.stderr.write(
        `round ${round + 1}/${values.smoke ? 1 : rounds} ${workload} ${bundler} ${profile}: ${pair.off.measurements.cold.toFixed(0)} -> ${pair[profile].measurements.cold.toFixed(0)} ms\n`
      );
      await checkpoint();
    }
  }
}

if (!values.smoke) {
  for (const [workload, profile] of cases)
    for (const bundler of ["esbuild", "vite", "vite-dev"])
      for (const current of ["off", profile]) {
        report.diagnostics.push({
          comparison: profile,
          ...(await run(workload, bundler, current, true))
        });
        process.stderr.write(`diagnostics ${workload} ${bundler} ${current}\n`);
        await checkpoint();
      }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
};

report.summary = [];

for (const [workload, profile] of cases)
  for (const bundler of ["esbuild", "vite", "vite-dev"]) {
    const before = report.samples.filter(
      (row) =>
        row.workload === workload &&
        row.comparison === profile &&
        row.bundler === bundler &&
        row.profile === "off"
    );

    const after = report.samples.filter(
      (row) =>
        row.workload === workload &&
        row.comparison === profile &&
        row.bundler === bundler &&
        row.profile === profile
    );

    const timings = {};

    for (const metric of Object.keys(before[0].measurements)) {
      const pairs = before.map((base) => ({
        before: base.measurements[metric],
        after: after.find((row) => row.round === base.round).measurements[
          metric
        ]
      }));

      timings[metric] = {
        off: median(pairs.map((p) => p.before)),
        on: median(pairs.map((p) => p.after)),
        pairedPercent: pairs.map((p) => (p.after / p.before - 1) * 100)
      };
      timings[metric].medianPairedPercent = median(
        timings[metric].pairedPercent
      );
    }

    report.summary.push({
      workload,
      profile,
      bundler,
      timings,
      off: before[0].outputs.cold,
      on: after[0].outputs.cold,
      initializationMs:
        bundler === "vite-dev"
          ? undefined
          : {
              off: median(before.map((row) => row.initializationMs)),
              on: median(after.map((row) => row.initializationMs))
            },
      peakRssMiB: {
        off: median(before.map((row) => row.peakRssMiB)),
        on: median(after.map((row) => row.peakRssMiB))
      }
    });
  }

report.finalLoad = loadavg();
await checkpoint();
console.log(`Wrote ${output}`);

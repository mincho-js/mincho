// Preserve an uncommitted baseline with --snapshot DIR before editing runtime code.
// Each implementation × workload runs in its own process, sequentially.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { build, transformWithEsbuild } from "vite";
import { artifact, fixture, names } from "./benchmark-cx/fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    snapshot: { type: "string" },
    baseline: { type: "string" },
    candidate: { type: "string" },
    published: { type: "boolean", default: false },
    iterations: { type: "string", default: "50000" },
    rounds: { type: "string", default: "7" },
    processes: { type: "string", default: "1" },
    "heap-instances": { type: "string", default: "64" },
    scenarios: { type: "string", default: names.join(",") },
    output: { type: "string" }
  }
});

const cssRoot = join(root, "packages/css");
const clsxPath = createRequire(join(cssRoot, "package.json")).resolve("clsx");

// Keep copied test sources outside workspace discovery, lint, and build globs.
const cacheRoot = join(tmpdir(), "mincho-cx-benchmark");
await mkdir(cacheRoot, { recursive: true });

async function fingerprint(directory) {
  const hash = createHash("sha256");

  async function visit(relative = "") {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = join(relative, name);
      const entries = await readdir(join(directory, path)).catch(() => null);

      if (entries) await visit(path);
      else {
        hash.update(path);
        hash.update("\0");
        hash.update(await readFile(join(directory, path)));
      }
    }
  }

  await visit();

  return hash.digest("hex");
}

async function snapshot(target) {
  await mkdir(target); // Never overwrite an existing baseline.
  await cp(join(cssRoot, "src"), join(target, "src"), { recursive: true });
  await cp(join(cssRoot, "dist"), join(target, "dist"), { recursive: true });

  const metadata = {
    capturedAt: new Date().toISOString(),
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8"
    }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8"
    }).trim(),
    source: await fingerprint(join(target, "src")),
    built: await fingerprint(join(target, "dist"))
  };

  await writeFile(
    join(target, "snapshot.json"),
    JSON.stringify(metadata, null, 2) + "\n"
  );

  return target;
}

if (values.snapshot) {
  await snapshot(resolve(values.snapshot));
  process.stdout.write(
    `Saved source, dist, and fingerprints to ${resolve(values.snapshot)}\n`
  );
} else {
  assert.ok(
    values.baseline,
    "Capture --snapshot DIR before editing, then supply --baseline DIR."
  );

  const selected = values.scenarios.split(",");

  assert.ok(
    selected.every((name) => names.includes(name)),
    "Unknown scenario"
  );

  for (const key of ["iterations", "rounds", "processes", "heap-instances"])
    assert.ok(
      Number.isSafeInteger(Number(values[key])) && Number(values[key]) > 0,
      `${key} must be positive`
    );

  const run = await mkdtemp(join(cacheRoot, "run-"));
  const candidate = values.candidate
    ? resolve(values.candidate)
    : await snapshot(join(run, "candidate"));

  const variants = [
    ["before", resolve(values.baseline)],
    ["after", candidate]
  ];

  const results = {};
  const manifest = {};
  let referenceFactory;

  for (const [label, directory] of variants) {
    manifest[label] = JSON.parse(
      await readFile(join(directory, "snapshot.json"), "utf8")
    );

    assert.equal(
      await fingerprint(join(directory, "src")),
      manifest[label].source,
      "Source snapshot changed"
    );
    assert.equal(
      await fingerprint(join(directory, "dist")),
      manifest[label].built,
      "Dist snapshot changed"
    );

    const entry = join(
      directory,
      "src/defineRules/createDefineRulesCxRuntime.ts"
    );

    const outDir = join(run, label);
    await build({
      configFile: false,
      root,
      logLevel: "error",
      resolve: { alias: { clsx: clsxPath } },
      define: { "import.meta.vitest": "false" },
      build: {
        outDir,
        emptyOutDir: true,
        target: "es2020",
        minify: false,
        lib: {
          entry,
          formats: ["es", "cjs"],

          fileName: (format) => (format === "es" ? "source.mjs" : "source.cjs")
        }
      }
    });

    const source = await import(pathToFileURL(join(outDir, "source.mjs")).href);
    referenceFactory ??= source.createDefineRulesCxRuntime;

    const builtEntry = join(
      directory,
      "dist/esm/runtime/createDefineRulesCxRuntime.mjs"
    );

    if (values.published) {
      await build({
        configFile: false,
        root,
        logLevel: "error",
        resolve: { alias: { clsx: clsxPath } },
        build: {
          outDir,
          emptyOutDir: false,
          target: "es2020",
          minify: false,
          lib: {
            entry: builtEntry,
            formats: ["es"],

            fileName: () => "published.mjs"
          }
        }
      });
    }

    const timingEntry = join(
      outDir,
      values.published ? "published.mjs" : "source.mjs"
    );

    const measured = await import(pathToFileURL(timingEntry).href);
    results[label] = { scenarios: [], bundles: {} };

    for (const name of selected) {
      const data = fixture(name, 1024);
      const config = data.artifact ?? artifact;
      const direct = referenceFactory(config);
      const compiled = measured.createCompiledDefineRulesCxRuntime(config);
      const sourceCompiled = source.createCompiledDefineRulesCxRuntime(config);

      for (const input of [...(data.prefill ?? []), ...data.inputs]) {
        assert.equal(compiled(...input), direct(...input), `${label}/${name}`);
        assert.equal(
          compiled(...input),
          sourceCompiled(...input),
          `${label}/${name} source/dist parity`
        );
      }
    }

    for (const format of ["es", "cjs"]) {
      const consumerEntry = values.published
        ? join(
            directory,
            `dist/${format === "es" ? "esm" : "cjs"}/runtime/createDefineRulesCxRuntime.${format === "es" ? "mjs" : "cjs"}`
          )
        : join(outDir, format === "es" ? "source.mjs" : "source.cjs");

      const consumer = join(outDir, `consumer-${format}.mjs`);
      await writeFile(
        consumer,
        `import { createCompiledDefineRulesCxRuntime } from ${JSON.stringify(consumerEntry)};\nexport const cx = createCompiledDefineRulesCxRuntime(${JSON.stringify(artifact)});\n`
      );

      const bundle = await build({
        configFile: false,
        root,
        logLevel: "error",
        resolve: { alias: { clsx: clsxPath } },
        build: {
          write: false,
          target: "es2020",
          minify: "esbuild",
          lib: { entry: consumer, formats: [format] }
        }
      });

      const outputCode = bundle[0].output.find(
        (file) => file.type === "chunk"
      ).code;

      const { code } = await transformWithEsbuild(outputCode, "consumer.js", {
        minify: true,
        target: "es2020"
      });

      const path = join(outDir, `bundle.${format === "es" ? "mjs" : "cjs"}`);
      await writeFile(path, code);

      const bundled = await import(pathToFileURL(path).href);

      for (const input of fixture("ordered-64", 64).inputs)
        assert.equal(
          bundled.cx(...input),
          referenceFactory(artifact)(...input)
        );

      results[label].bundles[format] = {
        raw: Buffer.byteLength(code),
        gzip: gzipSync(code).byteLength
      };
    }

    results[label].entry = timingEntry;
  }

  // Preparation/builds are finished before any timed process starts.
  for (const [index, name] of selected.entries()) {
    const runs = { before: [], after: [] };

    for (let repeat = 0; repeat < Number(values.processes); repeat += 1) {
      for (const [label] of (index + repeat) % 2 === 0
        ? variants
        : [...variants].reverse()) {
        process.stderr.write(`[cx-benchmark] ${label}/${name}/${repeat + 1}\n`);

        const json = execFileSync(
          process.execPath,
          [
            "--expose-gc",
            join(root, "scripts/benchmark-cx/worker.mjs"),
            results[label].entry,
            name,
            values.iterations,
            values.rounds,
            values["heap-instances"]
          ],
          { cwd: root, encoding: "utf8" }
        );

        runs[label].push(JSON.parse(json));
      }
    }

    for (const [label] of variants) {
      const processes = runs[label];
      const combined = { ...processes[0], processRuns: processes };

      for (const field of [
        "timeNs",
        "retainedBytesPerFactory",
        "retainedArrayBufferBytesPerFactory",
        "retainedExternalBytesPerFactory"
      ]) {
        const samples = processes.flatMap((run) => run[field]?.samples ?? []);
        if (samples.length === 0) continue;

        const sorted = [...samples].sort((a, b) => a - b);

        const at = (fraction) =>
          sorted[Math.floor((sorted.length - 1) * fraction)];

        combined[field] = {
          median: at(0.5),
          p25: at(0.25),
          p75: at(0.75),
          min: at(0),
          max: at(1),
          samples
        };
      }

      combined.sampledAllocatedBytesPerOp = processes
        .map((run) => run.sampledAllocatedBytesPerOp)
        .sort((a, b) => a - b)[Math.floor(processes.length / 2)];
      results[label].scenarios.push(combined);
    }
  }

  for (const [label, directory] of variants) {
    assert.equal(
      await fingerprint(join(directory, "src")),
      manifest[label].source
    );
    assert.equal(
      await fingerprint(join(directory, "dist")),
      manifest[label].built
    );
  }

  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model
    },
    settings: {
      ...values,
      processIsolation: "one process per implementation and scenario",
      warmupRounds: 6
    },
    snapshots: manifest,
    results
  };

  const json = JSON.stringify(report, null, 2) + "\n";

  if (values.output) await writeFile(resolve(values.output), json);

  process.stdout.write(json);
}

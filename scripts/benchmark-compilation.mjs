// Prepared npm or strict-PnP consumers isolate the compiler revision and tooling.
// --pack=/repository --candidate=/consumer packages an already built revision.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, platform, arch, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases, prepare } from "./benchmark-compilation/fixture.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    "baseline-label": { type: "string", default: "baseline" },
    "candidate-label": { type: "string", default: "candidate" },
    pack: { type: "string" },
    linker: { type: "string", default: "npm" },
    output: { type: "string", default: ".cache/compilation-benchmark" },
    rounds: { type: "string", default: "5" },
    formats: { type: "string", default: "esm,cjs" },
    cases: { type: "string", default: cases.join(",") },
    bundlers: { type: "string", default: "esbuild,vite,vite-dev" },
    diagnostics: { type: "boolean", default: false }
  }
});

const output = resolve(values.output);

const exists = async (path) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

const environment = { ...process.env, NODE_ENV: "production" };
delete environment.NODE_OPTIONS;

async function execute(command, args, cwd, ready, options = {}) {
  const started = performance.now();
  const child = spawn(command, args, {
    ...options,
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "",
    stderr = "",
    line = "",
    firstReadyMs;

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    line += chunk;

    let index;

    while ((index = line.indexOf("\n")) >= 0) {
      const current = line.slice(0, index);
      line = line.slice(index + 1);

      if (ready && current.startsWith('{"event":"first-ready"'))
        firstReadyMs = performance.now() - started;
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (status !== 0)
    throw new Error(
      command + " failed (" + status + ")\n" + stdout + "\n" + stderr
    );

  return { stdout, stderr, firstReadyMs };
}

if (values.pack) {
  assert(["npm", "pnp"].includes(values.linker), "--linker must be npm or pnp");

  if (!values.candidate)
    throw new Error("--pack requires --candidate=/consumer");

  const repo = resolve(values.pack),
    consumer = resolve(values.candidate);
  if (
    (await exists(join(consumer, "node_modules"))) ||
    (await exists(join(consumer, ".pnp.cjs")))
  )
    throw new Error(
      "Choose a fresh consumer directory; replacing an installed revision can reuse stale tarballs."
    );

  await mkdir(join(consumer, "packed"), { recursive: true });

  const releases = (await readdir(join(repo, ".yarn/releases")))
    .filter((name) => name.endsWith(".cjs"))
    .sort();

  assert.equal(
    releases.length,
    1,
    "Choose a repository with one checked-in Yarn release"
  );

  const dependencies = {
    esbuild: "0.27.7",
    vite: "7.3.3",
    react: "19.2.6",
    "react-dom": "19.2.6",
    "@babel/core": "7.29.7",
    "@vanilla-extract/css": "1.21.2"
  };

  for (const directory of (await readdir(join(repo, "packages"))).sort()) {
    const manifestFile = join(repo, "packages", directory, "package.json");
    if (!(await exists(manifestFile))) continue;

    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (
      !manifest.name?.startsWith("@mincho-js/") ||
      (manifest.private && manifest.name !== "@mincho-js/vite")
    )
      continue;

    const archive = join(consumer, "packed", directory + ".tgz");
    await execute(
      process.execPath,
      [
        join(repo, ".yarn/releases", releases[0]),
        "workspace",
        manifest.name,
        "pack",
        "--out",
        archive
      ],
      repo
    );
    dependencies[manifest.name] = "file:" + archive;
  }

  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "mincho-compilation-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies,
        ...(values.linker === "pnp"
          ? {
              packageManager: "yarn@4.18.0",
              resolutions: dependencies
            }
          : {})
      },
      null,
      2
    )
  );

  if (values.linker === "pnp") {
    await writeFile(
      join(consumer, ".yarnrc.yml"),
      [
        "nodeLinker: pnp",
        "pnpMode: strict",
        "pnpFallbackMode: none",
        "enableGlobalCache: false",
        "enableScripts: false",
        "enableImmutableInstalls: false",
        ""
      ].join("\n")
    );
    await execute(
      process.execPath,
      [join(repo, ".yarn/releases", releases[0]), "install"],
      consumer
    );
  } else {
    await execute(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      consumer,
      undefined,
      { shell: process.platform === "win32" }
    );
  }

  const revision = await execute("git", ["rev-parse", "HEAD"], repo);
  const status = await execute("git", ["status", "--porcelain"], repo);
  await writeFile(
    join(consumer, ".mincho-compilation-revision.json"),
    JSON.stringify(
      {
        head: revision.stdout.trim(),
        dirty: Boolean(status.stdout.trim())
      },
      null,
      2
    )
  );
  console.log("Prepared " + consumer);
} else {
  if (!values.baseline || !values.candidate)
    throw new Error(
      "Pass --baseline=/installed-consumer and --candidate=/installed-consumer"
    );

  const rounds = Number(values.rounds);
  if (!Number.isSafeInteger(rounds) || rounds < 1)
    throw new Error("--rounds must be a positive integer");

  const formats = values.formats.split(","),
    names = values.cases.split(","),
    bundlers = values.bundlers.split(",");

  assert(formats.every((value) => ["esm", "cjs"].includes(value)));
  assert(names.every((value) => cases.includes(value)));
  assert(
    bundlers.every((value) => ["esbuild", "vite", "vite-dev"].includes(value))
  );

  await mkdir(output, { recursive: true });

  const worker = fileURLToPath(
    new URL("./benchmark-compilation/worker.mjs", import.meta.url)
  );

  const measurements = [];

  const median = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  const distribution = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);

    return {
      median: median(sorted),
      min: sorted[0],
      max: sorted.at(-1),
      q1: sorted[Math.floor((sorted.length - 1) * 0.25)],
      q3: sorted[Math.ceil((sorted.length - 1) * 0.75)]
    };
  };

  for (let round = 0; round < rounds; round++) {
    const revisions =
      round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];

    const order = [
      ...names.slice(round % names.length),
      ...names.slice(0, round % names.length)
    ];

    for (const bundler of bundlers)
      for (const format of formats)
        for (const name of order)
          for (const revision of revisions) {
            const consumer = resolve(values[revision]);
            const root = join(consumer, ".mincho-compilation-benchmark");
            const directory = await prepare(root, name, format);
            const pnp = await exists(join(consumer, ".pnp.cjs"));
            const loaders = pnp
              ? ["--require", join(consumer, ".pnp.cjs")]
              : [];

            if (pnp && (await exists(join(consumer, ".pnp.loader.mjs"))))
              loaders.push("--loader", join(consumer, ".pnp.loader.mjs"));

            const stem = [bundler, format, name, revision, round].join("-");
            const diagnosticFile = values.diagnostics
              ? join(output, stem + "-diagnostics.json")
              : "";

            const processResult = await execute(
              process.execPath,
              [
                "--expose-gc",
                ...loaders,
                worker,
                consumer,
                directory,
                name,
                format,
                bundler,
                diagnosticFile
              ],
              consumer,
              true
            );

            const record = JSON.parse(
              processResult.stdout.trim().split("\n").at(-1)
            );

            record.revision = revision;
            record.linker = pnp ? "pnp" : "npm";
            record.round = round;
            record.processFirstReadyMs = processResult.firstReadyMs;
            await writeFile(
              join(output, stem + ".json"),
              JSON.stringify(record, null, 2)
            );

            if (processResult.stderr)
              await writeFile(
                join(output, stem + ".log"),
                processResult.stderr
              );

            measurements.push(record);

            assert.deepEqual(
              record.versions,
              measurements[0].versions,
              "Tool versions must match"
            );
            assert.equal(
              record.linker,
              measurements[0].linker,
              "Compare revisions with the same linker"
            );

            const previous = measurements.find(
              (item) =>
                item.bundler === bundler &&
                item.format === format &&
                item.name === name &&
                item.round === round &&
                item.revision !== revision
            );

            if (previous)
              for (const [phase, result] of Object.entries(record.outputs)) {
                assert.equal(
                  result.cssHash,
                  previous.outputs[phase].cssHash,
                  "CSS mismatch: " + stem + "/" + phase
                );
                assert.equal(
                  result.valueHash,
                  previous.outputs[phase].valueHash,
                  "Runtime mismatch: " + stem + "/" + phase
                );
              }

            console.log(stem + ": " + record.phases.first[0].toFixed(1) + "ms");
          }
  }

  const summary = {};

  for (const bundler of bundlers)
    for (const format of formats)
      for (const name of names) {
        const group = (summary[[bundler, format, name].join("/")] = {});

        for (const revision of ["baseline", "candidate"]) {
          const records = measurements.filter(
            (item) =>
              item.bundler === bundler &&
              item.format === format &&
              item.name === name &&
              item.revision === revision
          );

          group[revision] = Object.fromEntries(
            Object.keys(records[0].phases).map((phase) => [
              phase,
              distribution(
                records.map((record) => median(record.phases[phase]))
              )
            ])
          );
          group[revision].processFirstReady = distribution(
            records.map((record) => record.processFirstReadyMs)
          );
          group[revision].heapMiB = distribution(
            records.map((record) => record.heapMiB)
          );
          group[revision].rssMiB = distribution(
            records.map((record) => record.rssMiB)
          );
          group[revision].peakRssMiB = distribution(
            records.map((record) => record.peakRssMiB)
          );
          group[revision].output = records[0].outputs.first;
        }
      }

  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        note: "Wall time excludes diagnostics unless requested. Process readiness includes Node/package loading; phase timings exclude fixture preparation, compression and SSR checks. Development measures the application transform graph, not browser network or render latency.",
        revisions: {
          baseline: values["baseline-label"],
          candidate: values["candidate-label"]
        },
        machine: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          cores: cpus().length,
          memoryGiB: totalmem() / 1024 ** 3
        },
        diagnostics: values.diagnostics,
        rounds,
        versions: measurements[0].versions,
        summary,
        measurements
      },
      null,
      2
    )
  );
  console.log("Report: " + join(output, "report.json"));
}

// Run serially on installed packages, with no concurrent builds or tests.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    baseline: { type: "string" },
    rounds: { type: "string", default: "5" },
    output: {
      type: "string",
      default: ".cache/benchmarks/pruning-defaults-results.json"
    }
  }
});

assert.ok(values.candidate, "Supply a fresh installed candidate consumer");

const rounds = Number(values.rounds);

assert.ok(Number.isInteger(rounds) && rounds >= 5);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = {
  candidate: resolve(values.candidate),
  ...(values.baseline ? { baseline: resolve(values.baseline) } : {})
};

const fingerprints = {};
const execute = promisify(execFile);
const env = { ...process.env };
delete env.NODE_OPTIONS;

const loaderArguments = (root) => {
  const pnp = join(root, ".pnp.cjs");
  const loader = join(root, ".pnp.loader.mjs");

  return existsSync(pnp)
    ? [
        "--require",
        pnp,
        ...(existsSync(loader) ? ["--loader", pathToFileURL(loader).href] : [])
      ]
    : [];
};

const toolchain = [
  "vite",
  "esbuild",
  "rollup",
  "react",
  "react-dom",
  "react-dom/client",
  "react-dom/server"
];

for (const [name, root] of Object.entries(roots)) {
  await copyFile(
    join(
      repo,
      "scripts/package-contract/fixture/modules/component-systems.mjs"
    ),
    join(root, "component-systems.mjs")
  );

  const dependencies = [
    "@mincho-js/vite",
    "@mincho-js/integration",
    "@mincho-js/babel",
    "@mincho-js/css",
    ...toolchain
  ];
  // Resolve and read inside this consumer's loader, including PnP ZipFS files.
  // Rollup belongs to Vite's dependency graph, not necessarily the root's.
  const { stdout } = await execute(
    process.execPath,
    [
      ...loaderArguments(root),
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "--eval",
      `import { createHash } from "node:crypto";
       import { readFile } from "node:fs/promises";
       import { fileURLToPath } from "node:url";
       const vite = import.meta.resolve("vite");
       const fingerprints = {};
       for (const dependency of process.argv.slice(1)) {
         const entry = fileURLToPath(import.meta.resolve(
           dependency, dependency === "rollup" ? vite : import.meta.url
         ));
         fingerprints[dependency] = {
           entry,
           sha256: createHash("sha256").update(await readFile(entry)).digest("hex")
         };
       }
       console.log(JSON.stringify(fingerprints));`,
      ...dependencies
    ],
    { cwd: root, env }
  );
  fingerprints[name] = JSON.parse(stdout);
}

if (roots.baseline) {
  for (const dependency of toolchain)
    assert.equal(
      fingerprints.candidate[dependency].sha256,
      fingerprints.baseline[dependency].sha256,
      `Use matching toolchains for ${dependency}`
    );
}

const cases = [
  { scenario: "small", guard: "none" },
  { scenario: "variants", guard: "none" },
  { scenario: "keyframes", guard: "none" },
  { scenario: "variants", guard: "cssom" },
  { scenario: "variants", guard: "external" },
  { scenario: "variants", guard: "react" }
];

async function run(root, item, profile, diagnostics = false) {
  const { stdout } = await execute(
    process.execPath,
    [
      ...loaderArguments(root),
      "--expose-gc",
      "component-systems.mjs",
      "--scenario",
      item.scenario,
      "--guard",
      item.guard,
      "--profile",
      profile,
      "--minify",
      ...(diagnostics ? ["--diagnostics"] : [])
    ],
    {
      cwd: root,
      env,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024
    }
  );

  return JSON.parse(
    stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith("{"))
  );
}

const samples = [];

for (let round = 0; round < rounds; round++) {
  for (const item of round % 2 ? [...cases].reverse() : cases) {
    const profiles =
      item.guard === "none" && item.scenario !== "small"
        ? ["off", "recipes", "keyframes", "default"]
        : ["off", "default"];

    const variants = profiles.map((profile) => ({
      implementation: "candidate",
      profile
    }));

    if (roots.baseline)
      variants.push({ implementation: "baseline", profile: "pruning" });

    for (const variant of round % 2 ? variants.reverse() : variants) {
      const result = await run(
        roots[variant.implementation],
        item,
        variant.profile
      );

      samples.push({ round, ...item, ...variant, ...result });
      console.log(
        `${round + 1}/${rounds} ${item.scenario}/${item.guard} ${variant.implementation}/${variant.profile}: ${result.coldBuildMs.toFixed(1)} / ${result.warmBuildMs.toFixed(1)} ms`
      );
    }
  }
}

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const summary = [];

for (const item of cases) {
  const rows = samples.filter(
    (row) => row.scenario === item.scenario && row.guard === item.guard
  );

  for (const key of new Set(
    rows.map((row) => `${row.implementation}/${row.profile}`)
  )) {
    const group = rows.filter(
      (row) => `${row.implementation}/${row.profile}` === key
    );

    assert.equal(
      new Set(group.map((row) => row.hash)).size,
      1,
      "nondeterministic output"
    );

    summary.push({
      ...item,
      configuration: key,
      coldMs: median(group.map((row) => row.coldBuildMs)),
      warmMs: median(group.map((row) => row.warmBuildMs)),
      initialCss: group[0].initialCss,
      initialJs: group[0].initialJs,
      hash: group[0].hash
    });
  }

  if (item.guard !== "none" || item.scenario === "small") {
    const candidate = rows.filter((row) => row.implementation === "candidate");

    assert.equal(
      new Set(candidate.map((row) => row.hash)).size,
      1,
      "no-op defaults changed output"
    );
  }
}

// Diagnostics are separate from timing. Zero candidates and blocked analysis
// are distinct facts; ordinary React DOM must retain the CSSOM safety guard.
const diagnostics = [];

for (const item of cases) {
  const result = await run(roots.candidate, item, "default", true);
  const proofs = result.events.filter(
    (event) => event.phase === "css-resource-proofs"
  );

  assert.ok(proofs.length);

  const expected =
    item.guard !== "none"
      ? "external-css"
      : item.scenario === "small"
        ? "no-candidates"
        : "eligible";

  assert.ok(proofs.every((event) => event.detail.reason === expected));

  if (expected !== "eligible") {
    assert.ok(proofs.every((event) => event.detail.analyzedOwners === 0));
    assert.ok(
      result.events.every(
        (event) => event.phase !== "private-resource-analysis"
      )
    );
  } else {
    assert.ok(proofs.some((event) => event.detail.analyzedOwners > 0));

    const off = summary.find(
      (row) =>
        row.configuration === "candidate/off" &&
        row.scenario === item.scenario &&
        row.guard === item.guard
    );

    assert.ok(result.initialCss.raw < off.initialCss.raw);
  }

  diagnostics.push({ ...item, events: result.events });
}

const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0]?.model,
      rounds,
      fingerprints,
      summary,
      diagnostics,
      samples
    },
    null,
    2
  ) + "\n"
);
console.log(`Wrote ${output}`);

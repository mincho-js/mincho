// Run on a fresh installed consumer, serially, without concurrent tests/builds.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    consumer: { type: "string" },
    rounds: { type: "string", default: "5" },
    output: {
      type: "string",
      default: ".cache/benchmarks/bundle-size-results.json"
    }
  }
});
assert.ok(
  values.consumer,
  "Supply --consumer pointing to a fresh installed node_modules consumer"
);
const rounds = Number(values.rounds);
assert.ok(
  Number.isInteger(rounds) && rounds >= 5,
  "At least five alternating rounds are required"
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const consumer = resolve(values.consumer);
await copyFile(
  join(repo, "scripts/package-contract/fixture/modules/bundle-size.mjs"),
  join(consumer, "bundle-size.mjs")
);
await copyFile(
  join(
    repo,
    "scripts/package-contract/fixture/modules/recipe-runtime-cost.mjs"
  ),
  join(consumer, "recipe-runtime-cost.mjs")
);
const require = createRequire(join(consumer, "package.json"));
const versions = {};
for (const name of [
  "@mincho-js/vite",
  "@mincho-js/integration",
  "@mincho-js/babel",
  "@mincho-js/css",
  "vite",
  "rollup",
  "esbuild",
  "@vanilla-extract/css"
]) {
  const entry = require.resolve(name);
  let directory = dirname(entry);
  while (true) {
    try {
      const pkg = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8")
      );
      if (pkg.name === name) {
        versions[name] = {
          version: pkg.version,
          entrySha256: createHash("sha256")
            .update(await readFile(entry))
            .digest("hex")
        };
        break;
      }
    } catch {}
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Missing package manifest: ${name}`);
    directory = parent;
  }
}
const execute = promisify(execFile);
const env = { ...process.env };
delete env.NODE_OPTIONS;
const samples = [];
const scenarios = [
  "compact",
  "closed",
  "cross-file",
  "resources",
  "sharing",
  "themes",
  "theme-controller"
];
for (const scenario of scenarios)
  for (let round = 0; round < rounds; round++) {
    for (const profile of round % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]) {
      const { stdout } = await execute(
        process.execPath,
        ["bundle-size.mjs", "--scenario", scenario, "--profile", profile],
        { cwd: consumer, env, timeout: 180000, maxBuffer: 16 * 1024 * 1024 }
      );
      samples.push({
        round,
        ...JSON.parse(
          stdout
            .trim()
            .split("\n")
            .findLast((line) => line.startsWith("{"))
        )
      });
      process.stderr.write(`${scenario} ${round + 1}/${rounds} ${profile}\n`);
    }
  }
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = [];
for (const scenario of scenarios)
  for (const profile of ["baseline", "candidate"]) {
    const group = samples.filter(
      (sample) => sample.scenario === scenario && sample.profile === profile
    );
    for (const field of [
      "initialJs",
      "initialCss",
      "initialHtml",
      "totalCss",
      "initialAssets",
      "themeTransitionCss",
      "routeVisits"
    ])
      assert.equal(
        new Set(group.map((sample) => JSON.stringify(sample[field]))).size,
        1,
        `Unstable ${scenario}/${profile}/${field}`
      );
    summary.push({
      scenario,
      profile,
      milliseconds: median(group.map((sample) => sample.milliseconds)),
      cpuMicroseconds: median(
        group.map((sample) => sample.cpu.user + sample.cpu.system)
      ),
      initialJs: group[0].initialJs,
      initialCss: group[0].initialCss,
      initialHtml: group[0].initialHtml,
      totalCss: group[0].totalCss,
      initialAssets: group[0].initialAssets,
      themeTransitionCss: group[0].themeTransitionCss,
      routeVisits: group[0].routeVisits
    });
  }
const output = resolve(repo, values.output);
const runtimeSamples = [];
for (let round = 0; round < rounds; round++)
  for (const profile of round % 2
    ? ["candidate", "baseline"]
    : ["baseline", "candidate"]) {
    const { stdout } = await execute(
      process.execPath,
      ["recipe-runtime-cost.mjs", "--profile", profile],
      { cwd: consumer, env, timeout: 60000 }
    );
    runtimeSamples.push({ round, ...JSON.parse(stdout) });
  }
assert.equal(new Set(runtimeSamples.map((sample) => sample.checksum)).size, 1);
const runtimeSummary = ["baseline", "candidate"].map((profile) => {
  const group = runtimeSamples.filter((sample) => sample.profile === profile);
  return {
    profile,
    iterations: group[0].iterations,
    milliseconds: median(group.map((sample) => sample.milliseconds)),
    cpuMicroseconds: median(
      group.map((sample) => sample.cpu.user + sample.cpu.system)
    )
  };
});
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model,
      rounds,
      comparison:
        "same installed packages; new opt-in strategies off/on; C01 encoding is shared by both profiles",
      versions,
      summary,
      samples,
      runtimeSummary,
      runtimeSamples
    },
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify({ output, summary, runtimeSummary }, null, 2));

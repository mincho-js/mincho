// Build both checkouts first. All measurements below run serially in fresh processes.
// node scripts/benchmark-compiler-helpers.mjs BEFORE_ROOT [OUTPUT_DIRECTORY]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const before = resolve(process.argv[2]);
const output = resolve(
  process.argv[3] ?? "/var/tmp/mincho-compiler-helpers-benchmark"
);

const scripts = join(root, "scripts/benchmark-compiler-helpers");
const scenarios = [
  "props-static",
  "props-dynamic",
  "classes",
  "both",
  "conditions1",
  "conditions2",
  "conditions3",
  "conditions5",
  "spreads1",
  "spreads10",
  "spreads50",
  "vars4",
  "vars8",
  "vars16",
  "cascade"
];

await mkdir(output, { recursive: true });

async function fingerprint(checkout) {
  const files = [];

  async function walk(directory) {
    for (const entry of await readdir(join(checkout, directory), {
      withFileTypes: true
    })) {
      const name = join(directory, entry.name);

      if (entry.isDirectory()) await walk(name);
      else if (
        /\.(?:ts|tsx|js|mjs|cjs)$/.test(name) &&
        !name.endsWith(".test.ts")
      )
        files.push([
          name,
          createHash("sha256")
            .update(await readFile(join(checkout, name)))
            .digest("hex")
        ]);
    }
  }

  for (const name of [
    "babel",
    "css",
    "integration",
    "esbuild",
    "transform-runtime"
  ])
    for (const directory of ["src", "dist"])
      await walk(`packages/${name}/${directory}`);

  return files.sort(([a], [b]) => a.localeCompare(b));
}

const fingerprints = {
  before: await fingerprint(before),
  after: await fingerprint(root)
};

const report = {
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model,
    created: new Date().toISOString()
  },
  fingerprints,
  builds: [],
  runtimes: []
};

const run = async (args, cwd = root) =>
  (
    await exec(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "" },
      maxBuffer: 8 * 1024 * 1024
    })
  ).stdout;

for (const scenario of scenarios) {
  for (const [version, checkout] of [
    ["before", before],
    ["after", root]
  ]) {
    const directory = join(output, version);
    let built;

    try {
      built = JSON.parse(
        await run(
          [
            "--require",
            join(checkout, ".pnp.cjs"),
            join(scripts, "build.cjs"),
            checkout,
            directory,
            scenario
          ],
          checkout
        )
      );
    } catch (error) {
      report.builds.push({
        version,
        scenario,
        error: String(error.stderr ?? error)
      });
      console.log(
        `[compiler-helpers] ${version} ${scenario}: build failed (recorded)`
      );
      continue;
    }

    report.builds.push({ version, ...built });

    const cases = [scenario];

    if (
      version === "after" &&
      (scenario.startsWith("spreads") || scenario.startsWith("vars"))
    ) {
      for (const candidate of scenario.startsWith("spreads")
        ? ["finish", "finish-owned"]
        : ["writer"]) {
        report.builds.push({
          version,
          ...JSON.parse(
            await run([
              "--require",
              join(root, ".pnp.cjs"),
              join(scripts, "candidates.cjs"),
              root,
              directory,
              scenario,
              candidate
            ])
          )
        });
        cases.push(`${scenario}-${candidate}`);
      }
    }

    for (const name of cases)
      for (const format of ["esm", "cjs"]) {
        const samples = [];

        for (let sample = 0; sample < 3; sample++)
          samples.push(
            JSON.parse(
              await run([
                "--expose-gc",
                join(scripts, "run.mjs"),
                join(directory, `${name}.${format === "esm" ? "mjs" : "cjs"}`),
                "20000"
              ])
            )
          );

        report.runtimes.push({ version, scenario: name, format, samples });
      }

    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(`[compiler-helpers] ${version} ${scenario}`);
  }
}

report.factories = [];

for (const [version, checkout] of [
  ["before", before],
  ["after", root]
]) {
  for (const mode of ["full", "classes"]) {
    const samples = [];

    for (let sample = 0; sample < 3; sample++)
      samples.push(
        JSON.parse(
          await run(
            [
              "--expose-gc",
              "--require",
              join(checkout, ".pnp.cjs"),
              join(scripts, "factory.cjs"),
              checkout,
              version,
              mode
            ],
            checkout
          )
        )
      );

    report.factories.push({ version, mode, samples });
  }
}

await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));

for (const [version, checkout] of [
  ["before", before],
  ["after", root]
])
  if (
    JSON.stringify(fingerprints[version]) !==
    JSON.stringify(await fingerprint(checkout))
  )
    throw new Error(
      `Sources or build outputs changed during ${version} measurements`
    );

const failures = report.builds.filter(
  (build) => build.version === "after" && Object.hasOwn(build, "error")
);
if (failures.length)
  throw new Error(
    `After builds failed: ${failures.map((build) => build.scenario).join(", ")}. Report: ${join(output, "report.json")}`
  );

console.log(`Report: ${join(output, "report.json")}`);

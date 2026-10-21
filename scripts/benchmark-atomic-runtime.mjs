// Installed consumers are prepared by benchmark-compilation.mjs --pack.
// Run without concurrent builds/tests; diagnostics are deliberately separate.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, platform, arch } from "node:os";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(
  repo,
  "scripts/package-contract/fixture/modules/atomic-runtime.mjs"
);
const defaultOutput =
  "docs/framework-optimization-audit/atomic-runtime-results.json";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    rounds: { type: "string", default: "5" },
    browser: { type: "boolean", default: false },
    "browser-only": { type: "boolean", default: false },
    chromium: {
      type: "string",
      default: process.env.CHROME_BIN ?? "/usr/bin/chromium"
    },
    output: {
      type: "string",
      default: defaultOutput
    }
  }
});

const output = resolve(values.output);
const markdownOutput = output.replace(/\.json$/, ".md");

assert.ok(
  extname(output) === ".json",
  "--output must end with .json; the Markdown report is derived from it"
);

if (values["browser-only"]) {
  assert.ok(
    output !== resolve(defaultOutput),
    "--browser-only requires a separate --output <new-report.json> path"
  );

  for (const path of [output, markdownOutput]) {
    const exists = await stat(path).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;

        throw error;
      }
    );

    assert.ok(!exists, `Browser-only output already exists: ${path}`);
  }
}

assert.ok(
  values.baseline && values.candidate,
  "Supply installed --baseline and --candidate consumers"
);

const rounds = Number(values.rounds);

assert.ok(
  Number.isInteger(rounds) && rounds >= 5,
  "At least five paired rounds are required"
);

const roots = {
  baseline: resolve(values.baseline),
  candidate: resolve(values.candidate)
};

for (const root of Object.values(roots))
  await copyFile(fixture, join(root, "atomic-runtime.mjs"));

const env = { ...process.env };
delete env.NODE_OPTIONS;

async function run(implementation, profile, bundler, extra = []) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--expose-gc",
      "atomic-runtime.mjs",
      "--profile",
      profile,
      "--bundler",
      bundler,
      ...extra
    ],
    {
      cwd: roots[implementation],
      env,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024
    }
  );

  const line = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));

  assert.ok(line, "Fixture did not report JSON");

  return JSON.parse(line);
}

async function versions(root) {
  const names = [
    "vite",
    "rollup",
    "esbuild",
    "@babel/core",
    "@vanilla-extract/css",
    "react",
    "react-dom"
  ];

  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        JSON.parse(
          await readFile(
            join(root, "node_modules", name, "package.json"),
            "utf8"
          )
        ).version
      ])
    )
  );
}

const report = {
  baseline: "c9298a76",
  candidate: "working tree after c9298a76",
  createdAt: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  versions: {
    baseline: await versions(roots.baseline),
    candidate: await versions(roots.candidate)
  },
  packageFingerprints: Object.fromEntries(
    await Promise.all(
      Object.entries(roots).map(async ([name, root]) => [
        name,
        Object.fromEntries(
          await Promise.all(
            ["babel", "css", "integration", "esbuild", "vite"].map(
              async (packageName) => [
                packageName,
                createHash("sha256")
                  .update(
                    await readFile(
                      join(
                        root,
                        "node_modules/@mincho-js",
                        packageName,
                        "dist/esm/index.mjs"
                      )
                    )
                  )
                  .digest("hex")
              ]
            )
          )
        )
      ])
    )
  ),
  fixtureSha256: createHash("sha256")
    .update(await readFile(fixture))
    .digest("hex"),
  methodology: {
    rounds,
    cache: false,
    workers: 0,
    diagnostics: false,
    format: "esm",
    sizes:
      "esbuild minify, gzip level 9, Brotli quality 11; raw generated sizes also retained",
    order:
      "baseline/candidate alternate each round; profiles rotate; each sample is a fresh Node process",
    initialization:
      "one unminified generated module import with pre-import GC; heap delta includes transient allocations, not retained heap",
    browser:
      "candidate all versus baseline off; 200 React updates forcing computed style; includes React, DOM and style calculation, not isolated CSS engine time or a gate-only comparison"
  },
  samples: [],
  diagnostics: [],
  browser: []
};

assert.deepEqual(
  report.versions.baseline,
  report.versions.candidate,
  "Tool versions must match"
);

const profiles = ["off", "cx", "tokens", "atoms", "gates", "all"];

if (!values["browser-only"]) {
  for (let round = 0; round < rounds; round++) {
    for (const bundler of round % 2
      ? ["vite", "esbuild"]
      : ["esbuild", "vite"]) {
      for (let n = 0; n < profiles.length; n++) {
        const profile = profiles[(n + round) % profiles.length];
        const order =
          round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];

        for (const implementation of order) {
          const result = await run(
            implementation,
            implementation === "baseline" ? "off" : profile,
            bundler
          );

          report.samples.push({
            round,
            implementation,
            comparison: profile,
            ...result
          });
        }

        process.stderr.write(
          `round ${round + 1}/${rounds} ${bundler} ${profile}\n`
        );
      }
    }
  }

  for (const bundler of ["esbuild", "vite"]) {
    await run("candidate", "all", bundler, ["--diagnostics"]);
    report.diagnostics.push({
      bundler,
      report: JSON.parse(
        await readFile(
          join(
            roots.candidate,
            "fixture/modules/atomic-runtime",
            `${bundler}-all-diagnostics.json`
          ),
          "utf8"
        )
      )
    });
  }
}

async function browser(directory) {
  const server = createServer(async (request, response) => {
    try {
      const file = resolve(
        directory,
        "." + new URL(request.url, "http://localhost").pathname
      );

      assert.ok(file.startsWith(directory + "/"));

      response.setHeader(
        "Content-Type",
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(file)
        ] ?? "application/octet-stream"
      );
      response.end(await readFile(file));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));

  try {
    const { stdout } = await execute(
      values.chromium,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--dump-dom",
        "--virtual-time-budget=3000",
        `http://127.0.0.1:${server.address().port}/index.html`
      ],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }
    );

    const contents = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];

    assert.ok(contents, "Browser did not finish: " + stdout.slice(-1200));

    const result = JSON.parse(
      contents
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
    );

    assert.equal(result.focusColor, "rgb(0, 128, 0)");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.server, {
      color: "rgb(255, 0, 0)",
      child: "rgb(0, 0, 255)"
    });
    assert.equal(result.phases.length, 3);

    for (const phase of result.phases) {
      assert.equal(
        phase.color,
        phase.active ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)"
      );
      assert.equal(
        phase.child,
        phase.active ? "rgb(0, 0, 255)" : "rgb(255, 0, 0)"
      );
      assert.equal(phase.opacity, phase.active ? "1" : "0.5");
      assert.equal(phase.width, phase.active ? "100px" : "200px");
      assert.deepEqual(phase.effects, [
        "before",
        "test",
        "after",
        "before",
        "test",
        "after"
      ]);
    }

    return result;
  } finally {
    await new Promise((done) => server.close(done));
  }
}

if (values.browser || values["browser-only"]) {
  report.chromium = (
    await execute(values.chromium, ["--version"])
  ).stdout.trim();

  for (const bundler of ["esbuild", "vite"]) {
    const built = {};

    for (const implementation of ["baseline", "candidate"]) {
      await run(
        implementation,
        implementation === "baseline" ? "off" : "all",
        bundler
      );
      built[implementation] = await run(
        implementation,
        implementation === "baseline" ? "off" : "all",
        bundler,
        ["--browser"]
      );
    }

    for (let round = 0; round < rounds; round++) {
      for (const implementation of round % 2
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"]) {
        report.browser.push({
          round,
          implementation,
          bundler,
          ...(await browser(built[implementation].browser))
        });
      }

      process.stderr.write(`browser ${bundler} round ${round + 1}/${rounds}\n`);
    }
  }
}

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
};

const summary = [];

for (const bundler of ["esbuild", "vite"]) {
  for (const profile of profiles) {
    const pair = {};

    for (const implementation of ["baseline", "candidate"]) {
      const rows = report.samples.filter(
        (row) =>
          row.bundler === bundler &&
          row.comparison === profile &&
          row.implementation === implementation
      );
      if (!rows.length) continue;

      pair[implementation] = {};

      for (const metric of [
        "buildMs",
        "initializationMs",
        "initializationHeap",
        "renderMs"
      ])
        pair[implementation][metric] = median(rows.map((row) => row[metric]));

      for (const asset of ["js", "css", "html"]) {
        pair[implementation][asset] = {};

        for (const encoding of ["raw", "gzip", "brotli"])
          pair[implementation][asset][encoding] = median(
            rows.map((row) => row[asset][encoding])
          );
      }
    }

    if (pair.baseline) summary.push({ bundler, profile, ...pair });
  }
}

report.summary = summary;

const writeOptions = { flag: values["browser-only"] ? "wx" : "w" };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", writeOptions);

const delta = (before, after) => `${((after / before - 1) * 100).toFixed(1)}%`;

const lines = [
  "# Atomic/runtime measurements",
  "",
  `Baseline: c9298a76. ${rounds} paired rounds, Node ${process.version}.`,
  "",
  "Cold installed consumers, cache off, workers 0, diagnostics off. Timings are medians; relative timings are observations, not universal speedups. JS/CSS sizes use the same esbuild minifier for both bundlers. HTML is two server renders. Initialization imports the unminified generated module. Heap is an allocation delta, not retained heap.",
  "",
  "| Bundler | Profile | Build ms (base → candidate) | Δ | JS raw/gzip/br | CSS raw/gzip/br | HTML raw/gzip/br |",
  "|---|---|---:|---:|---:|---:|---:|"
];

const sizes = (row, key) =>
  ["raw", "gzip", "brotli"]
    .map((e) => `${row.baseline[key][e]}→${row.candidate[key][e]}`)
    .join(" / ");

for (const row of summary)
  lines.push(
    `| ${row.bundler} | ${row.profile} | ${row.baseline.buildMs.toFixed(1)} → ${row.candidate.buildMs.toFixed(1)} | ${delta(row.baseline.buildMs, row.candidate.buildMs)} | ${sizes(row, "js")} | ${sizes(row, "css")} | ${sizes(row, "html")} |`
  );

lines.push(
  "",
  "Browser timings compare candidate all against baseline off and cover 200 React updates with forced computed-style reads. They include React and DOM work and are not a gate-only CPU comparison. Paired runs verify colors, opacity, factored width/height, self-focus selectors, evaluation order, and opposite parent/child states.",
  ""
);

for (const bundler of ["esbuild", "vite"]) {
  const base = report.browser.filter(
    (row) => row.bundler === bundler && row.implementation === "baseline"
  );

  const next = report.browser.filter(
    (row) => row.bundler === bundler && row.implementation === "candidate"
  );

  if (base.length)
    lines.push(
      `- ${bundler}: median updates ${median(base.map((r) => r.updateMs)).toFixed(1)} → ${median(next.map((r) => r.updateMs)).toFixed(1)} ms (${report.chromium}).`
    );
}

lines.push(
  "",
  "No option is enabled by default. Small fixtures do not represent all applications. See the JSON for every sample, versions, fixture fingerprint and separate diagnostics.",
  ""
);
await writeFile(markdownOutput, lines.join("\n"), writeOptions);
process.stdout.write(`Wrote ${output}\n`);

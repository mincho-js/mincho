// Alternate isolated, installed baseline/candidate processes. Do not run builds/tests alongside timing.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { cpus, platform, tmpdir } from "node:os";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput =
  "docs/framework-optimization-audit/component-systems-results.json";
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string" },
    rounds: { type: "string", default: "5" },
    output: {
      type: "string",
      default: defaultOutput
    },
    browser: { type: "boolean", default: false },
    "browser-only": { type: "boolean", default: false },
    chromium: {
      type: "string",
      default: process.env.CHROME_BIN ?? "/usr/bin/chromium"
    }
  }
});

const output = resolve(values.output);
const markdownOutput = output.replace(/\.json$/, ".md");

assert.ok(
  extname(output) === ".json",
  "--output must end with .json; the Markdown report is derived from it"
);

// Browser-only reports need a new pair of paths to preserve full measurements.
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
  "Supply installed baseline and candidate consumers"
);

const rounds = Number(values.rounds);

assert.ok(
  Number.isInteger(rounds) && rounds >= 5,
  "At least five paired rounds required"
);

if (values.browser || values["browser-only"])
  assert.ok(
    typeof WebSocket === "function",
    "Browser measurements require a global WebSocket (Node >= 22, or --experimental-websocket on Node 20)"
  );

const roots = {
  baseline: resolve(values.baseline),
  candidate: resolve(values.candidate)
};

for (const root of Object.values(roots))
  await copyFile(
    join(
      repo,
      "scripts/package-contract/fixture/modules/component-systems.mjs"
    ),
    join(root, "component-systems.mjs")
  );

const env = { ...process.env };
delete env.NODE_OPTIONS;

async function run(implementation, scenario, profile, minify, extra = []) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--expose-gc",
      "component-systems.mjs",
      "--scenario",
      scenario,
      "--profile",
      profile,
      ...(minify ? ["--minify"] : []),
      ...extra
    ],
    {
      cwd: roots[implementation],
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

async function fingerprints(root) {
  const result = {};

  for (const name of [
    "vite",
    "rollup",
    "esbuild",
    "react",
    "react-dom",
    "@vanilla-extract/css",
    "@babel/core",
    "@mincho-js/babel",
    "@mincho-js/css",
    "@mincho-js/integration",
    "@mincho-js/vite"
  ]) {
    const path = join(root, "node_modules", name, "package.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    result[name] = { version: data.version };

    if (name.startsWith("@mincho-js/"))
      result[name].entryHash = createHash("sha256")
        .update(await readFile(join(dirname(path), "dist/esm/index.mjs")))
        .digest("hex");
  }

  const archives = {};

  for (const file of (await readdir(join(root, "packed"))).sort())
    if (file.endsWith(".tgz"))
      archives[file] = createHash("sha256")
        .update(await readFile(join(root, "packed", file)))
        .digest("hex");

  result.archives = archives;

  return result;
}

const revisions = {};

for (const [label, root] of Object.entries(roots))
  revisions[label] = JSON.parse(
    await readFile(join(root, ".mincho-compilation-revision.json"), "utf8")
  );

const report = {
  baseline: revisions.baseline.head,
  candidate:
    revisions.candidate.head +
    (revisions.candidate.dirty ? " + working-tree changes" : ""),
  revisions,
  createdAt: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  cpu: cpus()[0]?.model,
  rounds,
  fingerprints: {
    baseline: await fingerprints(roots.baseline),
    candidate: await fingerprints(roots.candidate)
  },
  method: {
    cold: "fresh Node process and empty Mincho filesystem cache",
    warm: "new Vite environment in the same process, warm filesystem cache",
    memory:
      "heap after cold build and forced GC; Node process peak RSS includes cold and warm builds; excludes separate esbuild processes",
    transfer: "sum of separately compressed output assets: gzip 9/Brotli 11",
    nativeMinifier: "Vite JS/CSS minifier both off/on",
    duplication:
      "ordered wrapper path, selector and declaration equality; block equality ignores selector; bytes sum declaration.toString() plus semicolons, excluding selector/wrapper whitespace; not all repeated blocks can be safely merged",
    browser:
      "external React renderer and post-build verification script; 200 theme class changes with a forced computed-style read; includes DOM and style work",
    ordering:
      "profiles rotate, implementation order alternates each round; no concurrent builds or tests"
  },
  samples: [],
  diagnostics: [],
  defaultEquivalence: [],
  browser: []
};

for (const name of [
  "vite",
  "rollup",
  "esbuild",
  "react",
  "react-dom",
  "@vanilla-extract/css",
  "@babel/core"
])
  assert.equal(
    report.fingerprints.baseline[name].version,
    report.fingerprints.candidate[name].version,
    `Toolchain mismatch: ${name}`
  );

const cases = [
  ["tokens", "theme"],
  ["keyframes", "keyframes"],
  ["variants", "recipes"],
  ["conditional", "conditional"],
  ["small", "default"]
];

if (!values["browser-only"]) {
  for (const [scenario] of cases) {
    const baseline = await run("baseline", scenario, "default", false);
    const candidate = await run("candidate", scenario, "default", false);

    assert.equal(
      candidate.hash,
      baseline.hash,
      `Default output changed for ${scenario}`
    );

    report.defaultEquivalence.push({ scenario, hash: baseline.hash });
  }

  for (let round = 0; round < rounds; round++) {
    const rotated = [
      ...cases.slice(round % cases.length),
      ...cases.slice(0, round % cases.length)
    ];

    for (const [scenario, profile] of rotated)
      for (const candidateProfile of new Set([profile, "all"]))
        for (const minify of [false, true]) {
          for (const implementation of round % 2
            ? ["candidate", "baseline"]
            : ["baseline", "candidate"]) {
            const result = await run(
              implementation,
              scenario,
              implementation === "baseline" ? "default" : candidateProfile,
              minify
            );

            report.samples.push({
              round,
              implementation,
              comparison: candidateProfile,
              ...result
            });
          }

          process.stderr.write(
            `round ${round + 1}/${rounds} ${scenario} ${candidateProfile} minify=${minify}\n`
          );
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        }
  }

  for (const [scenario, profile] of cases)
    report.diagnostics.push(
      await run("candidate", scenario, profile, false, ["--diagnostics"])
    );
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

  const profile = await mkdtemp(join(tmpdir(), "mincho-component-browser-"));
  const chrome = spawn(
    values.chromium,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  const closed = new Promise((done) => chrome.once("exit", done));
  let socket;
  const pending = new Map();
  let sequence = 0;

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },

        reject
      });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })
      );
    });

  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error("Chromium startup timeout")),
        15000
      );

      chrome.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      chrome.stderr.on("data", (chunk) => {
        output += chunk;

        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);

        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });

    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const request = pending.get(message.id);
      if (!request) return;

      pending.delete(message.id);

      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });

    const { targetId } = await send("Target.createTarget", {
      url: "about:blank"
    });

    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true
    });

    await send("Page.enable", {}, sessionId);
    await send(
      "Page.navigate",
      { url: `http://127.0.0.1:${server.address().port}/index.html` },
      sessionId
    );

    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const { result } = await send(
        "Runtime.evaluate",
        {
          expression: "document.getElementById('result')?.textContent",
          returnByValue: true
        },
        sessionId
      );

      if (result?.value) {
        const value = JSON.parse(result.value);

        assert.equal(value.ok, true, value.error);
        assert.ok(
          value.updateMs > 0,
          "Real browser time must advance during theme updates"
        );

        return value;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error("Browser verification timed out");
  } finally {
    socket?.close();
    chrome.kill("SIGTERM");
    await closed;
    await new Promise((done) => server.close(done));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
  }
}

if (values.browser || values["browser-only"]) {
  report.browserVersion = (
    await execute(values.chromium, ["--version"], { timeout: 15000 })
  ).stdout.trim();

  const directories = {};

  for (const implementation of ["baseline", "candidate"])
    directories[implementation] = (
      await run(
        implementation,
        "variants",
        implementation === "baseline" ? "default" : "all",
        false,
        ["--browser"]
      )
    ).browser;

  for (let round = 0; round < rounds; round++) {
    for (const implementation of round % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"])
      report.browser.push({
        round,
        implementation,
        ...(await browser(directories[implementation]))
      });

    process.stderr.write(`browser round ${round + 1}/${rounds}\n`);
  }
}

const median = (numbers) =>
  numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

const rows = [];

for (const [scenario, profile] of cases)
  for (const comparison of new Set([profile, "all"]))
    for (const minify of [false, true]) {
      const pair = {};

      for (const implementation of ["baseline", "candidate"]) {
        const samples = report.samples.filter(
          (item) =>
            item.scenario === scenario &&
            item.comparison === comparison &&
            item.minify === minify &&
            item.implementation === implementation
        );

        if (samples.length) {
          assert.ok(
            samples.every((sample) => sample.hash === samples[0].hash),
            `Unstable output across rounds: ${scenario}/${comparison}/${minify}/${implementation}`
          );

          pair[implementation] = {
            ...samples[0],
            coldBuildMs: median(samples.map((item) => item.coldBuildMs)),
            warmBuildMs: median(samples.map((item) => item.warmBuildMs)),
            heapBytes: median(samples.map((item) => item.heapBytes)),
            maxRssBytes: median(samples.map((item) => item.maxRssBytes))
          };
        }
      }

      if (pair.baseline) rows.push({ scenario, comparison, minify, ...pair });
    }

report.summary = rows;
const writeOptions = { flag: values["browser-only"] ? "wx" : "w" };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", writeOptions);

const md = [
  "# Component systems measurements",
  "",
  `Baseline ${report.baseline.slice(0, 12)}${revisions.baseline.dirty ? " (dirty)" : ""}; ${rounds} alternating paired rounds; Node ${process.version}. Values are medians.`,
  "",
  "| Scenario | Flag | Native minify | Cold ms (base → candidate) | Warm ms | Initial CSS raw/gzip/br | Total CSS raw/gzip/br | Initial JS raw | Chunks / CSS assets |",
  "|---|---|---|---:|---:|---|---|---:|---|"
];

for (const row of rows) {
  const { baseline: a, candidate: b } = row;

  const size = (key) =>
    ["raw", "gzip", "brotli"]
      .map((format) => `${a[key][format]}→${b[key][format]}`)
      .join(" / ");

  md.push(
    `| ${row.scenario} | ${row.comparison} | ${row.minify} | ${a.coldBuildMs.toFixed(1)} → ${b.coldBuildMs.toFixed(1)} | ${a.warmBuildMs.toFixed(1)} → ${b.warmBuildMs.toFixed(1)} | ${size("initialCss")} | ${size("css")} | ${a.initialJs.raw}→${b.initialJs.raw} | ${a.chunks}→${b.chunks} / ${a.cssAssets}→${b.cssAssets} |`
  );
}

md.push(
  "",
  "Raw byte savings do not imply compression or CPU savings. Full memory, transfer, initial request, diagnostics and browser samples are in the adjacent JSON. Browser checks execute after building; React's generic CSSOM renderer is external to the Mincho graph so resource-pruning assertions exercise the passes.",
  ""
);

for (const implementation of ["baseline", "candidate"]) {
  const samples = report.browser.filter(
    (item) => item.implementation === implementation
  );

  if (samples.length)
    md.push(
      `${implementation}: 200 theme changes median ${median(samples.map((item) => item.updateMs)).toFixed(2)} ms; ${samples.length} successful SSR/hydration, independent-token override, animation and a→b→a route checks.`
    );
}

await writeFile(markdownOutput, md.join("\n") + "\n", writeOptions);
console.log(`Wrote ${values.output}`);

// Run after building @mincho-js/css. An optional Git baseline is transpiled into
// an isolated, disposable module tree; current direct factories are not legacy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const { values } = parseArgs({
  options: {
    "baseline-ref": { type: "string" },
    iterations: { type: "string", default: "20000" },
    rounds: { type: "string", default: "5" },
    "heap-instances": { type: "string", default: "128" },
    output: { type: "string" }
  }
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iterations = positiveInteger("iterations", values.iterations);
const rounds = positiveInteger("rounds", values.rounds);
const heapInstances = positiveInteger(
  "heap-instances",
  values["heap-instances"]
);

const cacheRoot = join(root, "packages/css/.cache/runtime-benchmark");
let baselineDirectory;
let sink;

function positiveInteger(name, value) {
  const number = Number(value);

  assert.ok(
    Number.isSafeInteger(number) && number > 0,
    `${name} must be positive`
  );

  return number;
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fingerprints() {
  const sourceFiles = [
    "rules/createRuntimeFn.ts",
    "rules/utils.ts",
    "defineRules/createDefineRulesCxRuntime.ts",
    "classname/cx.ts",
    "runtime/cxCache.ts",
    "runtime/cxArguments.ts",
    "runtime/cache.ts"
  ];

  const measuredDirectory = join(root, "packages/css/dist/esm/runtime");
  const measuredFiles = (await readdir(measuredDirectory))
    .filter((file) => file.endsWith(".mjs"))
    .sort();

  async function digest(directory, files) {
    const hash = createHash("sha256");

    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(await readFile(join(directory, file)));
    }

    return hash.digest("hex");
  }

  return {
    source: await digest(join(root, "packages/css/src"), sourceFiles),
    measured: await digest(measuredDirectory, measuredFiles)
  };
}

async function baselineFactories(ref) {
  const revision = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  await mkdir(cacheRoot, { recursive: true });
  baselineDirectory = await mkdtemp(join(cacheRoot, "baseline-"));

  for (const file of [
    "rules/createRuntimeFn",
    "rules/utils",
    "defineRules/createDefineRulesCxRuntime",
    "classname/cx"
  ]) {
    const source = git(["show", `${revision}:packages/css/src/${file}.ts`]);
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText;

    const target = join(baselineDirectory, `${file}.js`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output);
  }

  const recipe = await import(
    pathToFileURL(join(baselineDirectory, "rules/createRuntimeFn.js")).href
  );

  const cx = await import(
    pathToFileURL(
      join(baselineDirectory, "defineRules/createDefineRulesCxRuntime.js")
    ).href
  );

  return {
    label: `baseline:${revision.slice(0, 12)}`,
    revision,
    recipe: recipe.createRuntimeFn,
    cx: cx.createDefineRulesCxRuntime,
    note: "Actual historical factories; argument-key ordering follows that revision."
  };
}

function summary(samples, count) {
  const sorted = [...samples].sort((left, right) => left - right);

  const at = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)];

  return {
    operations: count,
    medianMs: at(0.5),
    medianNsPerOp: (at(0.5) * 1e6) / count,
    p25Ms: at(0.25),
    p75Ms: at(0.75),
    samplesMs: samples
  };
}

function measure(name, implementations, prepare, count = iterations) {
  process.stderr.write(`[runtime-benchmark] ${name}\n`);

  const samples = Object.fromEntries(
    implementations.map(({ label }) => [label, []])
  );

  for (let round = 0; round < rounds + 2; round += 1) {
    // Rotate order so each implementation sometimes precedes the others.
    const order = implementations.map(
      (_, index) => implementations[(index + round) % implementations.length]
    );

    for (const implementation of order) {
      const invoke = prepare(implementation);
      const start = performance.now();

      for (let index = 0; index < count; index += 1) sink = invoke(index);

      if (round >= 2)
        samples[implementation.label].push(performance.now() - start);
    }
  }

  return {
    scenario: name,
    results: Object.fromEntries(
      Object.entries(samples).map(([label, durations]) => [
        label,
        summary(durations, count)
      ])
    )
  };
}

const smallRecipe = {
  defaultClassName: "base",
  variantClassNames: {
    tone: {
      brand: "tone-brand",
      neutral: "tone-neutral",
      danger: "tone-danger"
    },
    size: { small: "size-small", medium: "size-medium", large: "size-large" },
    active: { true: "active", false: "inactive" }
  },
  defaultVariants: {},
  compoundVariants: [
    [{ tone: "brand", active: true }, "brand-active"],
    [{ size: "large", active: false }, "large-inactive"]
  ],
  propVars: { width: "--width" }
};

const repeatedInputs = Array.from({ length: 12 }, (_, index) => ({
  tone: ["brand", "neutral", "danger"][index % 3],
  size: ["small", "medium", "large"][Math.floor(index / 3) % 3],
  active: index % 2 === 0
}));

const broadRecipe = {
  defaultClassName: "base",
  variantClassNames: Object.fromEntries(
    Array.from({ length: 8 }, (_, variant) => [
      `variant${variant}`,
      Object.fromEntries(
        Array.from({ length: 4 }, (_, value) => [
          `v${value}`,
          `class-${variant}-${value}`
        ])
      )
    ])
  ),
  defaultVariants: {},
  compoundVariants: Array.from({ length: 16 }, (_, index) => [
    { variant0: `v${index % 4}`, variant1: `v${Math.floor(index / 4)}` },
    `compound-${index}`
  ]),
  propVars: {}
};

// 512 real selections cycle through a cache whose maximum capacity is 256.
const lowReuseInputs = Array.from({ length: 512 }, (_, state) =>
  Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `variant${index}`,
      `v${Math.floor(state / 4 ** index) % 4}`
    ])
  )
);

const complexRecipe = {
  ...broadRecipe,
  compoundVariants: Array.from({ length: 64 }, (_, index) => [
    {
      variant0: `v${index % 4}`,
      variant1: `v${Math.floor(index / 4) % 4}`,
      variant2: `v${Math.floor(index / 16)}`
    },
    `compound-${index}`
  ])
};

const complexRepeatedInputs = lowReuseInputs.slice(0, 16);
const permutations = [
  { tone: "brand", size: "small", active: true },
  { active: true, tone: "brand", size: "small" },
  { size: "small", active: true, tone: "brand" }
];

const cxArtifact = {
  classWrites: [
    ["color-red", 1],
    ["color-blue", 1],
    ["padding-small", 2],
    ["padding-large", 2],
    ["display-block", 3]
  ],
  segments: [["segment", [1, 2]]]
};

const repeatedCxInputs = [
  "segment color-red padding-small color-blue",
  "segment color-blue padding-large padding-small",
  "external color-red color-blue display-block external"
];

const lowReuseCxInputs = Array.from(
  { length: 512 },
  (_, index) =>
    `${repeatedCxInputs[index % repeatedCxInputs.length]} external-${index}`
);

function verify(implementations) {
  const current = implementations.find(
    ({ label }) => label === "direct-current"
  );

  for (const [config, inputs] of [
    [smallRecipe, repeatedInputs],
    [complexRecipe, complexRepeatedInputs],
    [broadRecipe, lowReuseInputs]
  ]) {
    const reference = current.recipe(config);

    for (const implementation of implementations) {
      const fn = implementation.recipe(config);

      for (const input of inputs) assert.equal(fn(input), reference(input));
    }
  }

  const referenceCx = current.cx(cxArtifact);
  const orderContract = {};

  for (const implementation of implementations) {
    const cx = implementation.cx(cxArtifact);

    for (const input of [...repeatedCxInputs, ...lowReuseCxInputs]) {
      assert.equal(cx(input), referenceCx(input));
    }

    const recipe = implementation.recipe(smallRecipe);
    const outputs = permutations.map((input) => recipe(input));

    if (!implementation.revision) assert.equal(new Set(outputs).size, 1);

    orderContract[implementation.label] = outputs;

    const boolean = recipe({ active: true, tone: "brand" });
    const string = recipe({ active: "true", tone: "brand" });

    assert.ok(boolean.includes("brand-active"));
    assert.ok(!string.includes("brand-active"));
  }

  return orderContract;
}

function heapMeasurements(implementations) {
  if (typeof globalThis.gc !== "function") {
    return {
      skipped:
        "Run node --expose-gc to measure retained heap after explicit GC."
    };
  }

  process.stderr.write("[runtime-benchmark] retained heap\n");

  const retainedKey = Symbol("Mincho runtime benchmark retained factories");
  const results = [];

  for (const implementation of implementations) {
    for (const [name, create, warm] of [
      ["recipe-unused", () => implementation.recipe(smallRecipe)],
      ["recipe-hot", () => implementation.recipe(smallRecipe), repeatedInputs],
      [
        "recipe-hot-compound-heavy",
        () => implementation.recipe(complexRecipe),
        complexRepeatedInputs
      ],
      [
        "recipe-capacity",
        () => implementation.recipe(broadRecipe),
        lowReuseInputs
      ],
      ["cx-unused", () => implementation.cx(cxArtifact)],
      ["cx-capacity", () => implementation.cx(cxArtifact), lowReuseCxInputs]
    ]) {
      const samplesBytes = [];

      for (let sample = 0; sample < 3; sample += 1) {
        globalThis.gc();

        const before = process.memoryUsage().heapUsed;
        const retained = Array.from({ length: heapInstances }, () => {
          const fn = create();

          for (const input of warm ?? []) fn(input);

          return fn;
        });

        // A global root and an explicit release prevent the previous iteration's
        // stack slot from contaminating the next sample's before/after delta.
        globalThis[retainedKey] = retained;
        globalThis.gc();
        samplesBytes.push(process.memoryUsage().heapUsed - before);
        Reflect.deleteProperty(globalThis, retainedKey);
        retained.length = 0;
        globalThis.gc();
      }

      const bytes = [...samplesBytes].sort((left, right) => left - right)[1];
      results.push({
        implementation: implementation.label,
        scenario: name,
        instances: heapInstances,
        bytes,
        bytesPerInstance: bytes / heapInstances,
        samplesBytes
      });
    }
  }

  return results;
}

try {
  const fingerprint = await fingerprints();
  const recipe =
    await import("../packages/css/dist/esm/runtime/createRuntimeFn.mjs");

  const cx =
    await import("../packages/css/dist/esm/runtime/createDefineRulesCxRuntime.mjs");

  assert.equal(
    typeof recipe.createCompiledRuntimeFn,
    "function",
    "Build @mincho-js/css before benchmarking."
  );
  assert.equal(
    typeof cx.createCompiledDefineRulesCxRuntime,
    "function",
    "Build @mincho-js/css before benchmarking."
  );

  const implementations = [
    {
      label: "direct-current",
      recipe: recipe.createRuntimeFn,
      cx: cx.createDefineRulesCxRuntime,
      note: "Current canonical, mutable-input factory without caching. This is not the historical baseline."
    },
    {
      label: "compiled-current",

      recipe: (config) =>
        recipe.createCompiledRuntimeFn(config, config.propVars),

      cx: cx.createCompiledDefineRulesCxRuntime,
      note: "Private immutable factory with lazy preparation and adaptive bounded caches for complex recipes. Differences from direct-current include preparation and metadata handling, not just caching."
    }
  ];

  if (values["baseline-ref"])
    implementations.unshift(await baselineFactories(values["baseline-ref"]));

  const orderContract = verify(implementations);
  const coldIterations = Math.min(iterations, 1000);
  const scenarios = [
    measure(
      "recipe-definition-unused",
      implementations,
      ({ recipe }) =>
        () =>
          recipe(smallRecipe),
      coldIterations
    ),
    measure(
      "recipe-definition-and-first-call",
      implementations,
      ({ recipe }) =>
        () =>
          recipe(smallRecipe)(repeatedInputs[0]),
      coldIterations
    )
  ];

  for (const [name, config, inputs] of [
    ["recipe-hot-small-state-space", smallRecipe, repeatedInputs],
    ["recipe-hot-compound-heavy", complexRecipe, complexRepeatedInputs],
    ["recipe-canonical-key-permutations", smallRecipe, permutations],
    ["recipe-low-reuse-512-states", broadRecipe, lowReuseInputs]
  ]) {
    scenarios.push(
      measure(name, implementations, ({ recipe }) => {
        const fn = recipe(config);

        for (const input of inputs) fn(input);

        return (index) => fn(inputs[index % inputs.length]);
      })
    );
  }

  scenarios.push(
    measure(
      "cx-definition-unused",
      implementations,
      ({ cx }) =>
        () =>
          cx(cxArtifact),
      coldIterations
    ),
    measure(
      "cx-definition-and-first-call",
      implementations,
      ({ cx }) =>
        () =>
          cx(cxArtifact)(repeatedCxInputs[0]),
      coldIterations
    )
  );

  for (const [name, inputs] of [
    ["cx-hot", repeatedCxInputs],
    ["cx-low-reuse-512-inputs", lowReuseCxInputs]
  ]) {
    scenarios.push(
      measure(name, implementations, ({ cx }) => {
        const fn = cx(cxArtifact);

        for (const input of inputs) fn(input);

        return (index) => fn(inputs[index % inputs.length]);
      })
    );
  }

  sink = undefined;

  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model
    },
    candidate: {
      revision: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
      fingerprint
    },
    settings: { iterations, rounds, warmupRounds: 2, heapInstances },
    implementations: implementations.map(({ label, note, revision }) => ({
      label,
      note,
      revision
    })),
    orderContract,
    scenarios,
    heap: heapMeasurements(implementations),
    limitations: [
      "Input objects and configuration fixtures are prepared before steady-state timing; cold cases include factory work.",
      "The historical permutation case intentionally has a different class-string ordering contract.",
      "Retained heap is approximate and includes engine noise; shared fixture/config objects are excluded.",
      "This harness does not measure React rendering, browser style recalculation, compiler folding, or end-to-end application latency."
    ]
  };

  assert.deepEqual(
    await fingerprints(),
    fingerprint,
    "Runtime source or built artifacts changed during the measurement."
  );

  const json = JSON.stringify(report, null, 2) + "\n";

  if (values.output) {
    const target = resolve(values.output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json);
  }

  process.stdout.write(json);
} finally {
  if (baselineDirectory)
    await rm(baselineDirectory, { recursive: true, force: true });
}

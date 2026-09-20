import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { artifact, fixture } from "./fixtures.mjs";

const [entry, name, countText, roundsText, heapText] = process.argv.slice(2);
const count = Number(countText);
const rounds = Number(roundsText);
const heapInstances = Number(heapText);
const { createCompiledDefineRulesCxRuntime: create } = await import(
  pathToFileURL(entry).href
);

const data = fixture(
  name,
  name.endsWith("-unique") ? Math.min(count, 20_000) : count
);

const config = data.artifact ?? artifact;

const pick = (i) =>
  data.inputs[
    data.order ? data.order[i % data.order.length] : i % data.inputs.length
  ];

let sink;

function invokeFactory() {
  const cx = create(config);

  return name === "factory" ? cx : cx(...data.inputs[0]);
}

const cold = name === "factory" || name === "first-call";

// Unused-factory creation takes only hundreds of nanoseconds. Give it longer
// blocks so scheduler/timer jitter does not dominate sub-millisecond samples.
const operations =
  name === "factory"
    ? Math.max(count, 100_000)
    : cold || name.startsWith("long-")
      ? Math.min(count, 4000)
      : data.unique
        ? Math.min(count, 20_000, data.inputs.length)
        : name.startsWith("known-")
          ? Math.min(count, 20_000)
          : count;

let cx = create(config);

function reset() {
  cx = create(config);

  for (const input of data.prefill ?? []) cx(...input);
}

const invoke = cold
  ? invokeFactory
  : name === "two-strings"
    ? (i) => {
        const input = pick(i);

        return cx(input[0], input[1]);
      }
    : name === "three-conditional"
      ? (i) => {
          const input = pick(i);

          return cx(input[0], input[1], input[2]);
        }
      : (i) => cx(...pick(i));

// Warm and measure the same call site so loop tiering does not distort early
// samples differently for each implementation.
function runBlock() {
  for (let i = 0; i < operations; i += 1) sink = invoke(i);
}

// Do not pre-warm the timed SSR instance; only warm the engine on throwaways.
// Short requests need more throwaways to give JIT compilation comparable work.
const warmupRounds = data.unique
  ? Math.max(6, Math.ceil(20_000 / operations))
  : 6;

for (let round = 0; round < warmupRounds; round += 1) {
  if (round === 0 || data.unique || data.prefill) reset();

  runBlock();
}

const samplesNs = [];

for (let round = 0; round < rounds; round += 1) {
  if (data.unique || data.prefill) reset();

  globalThis.gc?.();

  const start = performance.now();
  runBlock();
  samplesNs.push(((performance.now() - start) * 1e6) / operations);
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);

  const at = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)];

  return {
    median: at(0.5),
    p25: at(0.25),
    p75: at(0.75),
    min: at(0),
    max: at(1),
    samples: values
  };
}

const heapSamples = [];
const bufferSamples = [];
const externalSamples = [];

if (globalThis.gc) {
  for (let sample = 0; sample < 3; sample += 1) {
    sink = undefined;
    globalThis.gc();

    const before = process.memoryUsage();
    const retained = Array.from({ length: heapInstances }, () => {
      const fn = create(config);

      for (const input of data.prefill ?? []) fn(...input);

      if (name !== "factory") {
        for (
          let repeat = 0;
          repeat < (name === "first-call" || data.unique ? 1 : 2);
          repeat += 1
        )
          for (const input of data.inputs.slice(0, 1024)) fn(...input);
      }

      return fn;
    });

    globalThis.__minchoCxRetained = retained;
    globalThis.gc();

    const after = process.memoryUsage();
    heapSamples.push((after.heapUsed - before.heapUsed) / heapInstances);
    bufferSamples.push(
      (after.arrayBuffers - before.arrayBuffers) / heapInstances
    );
    externalSamples.push((after.external - before.external) / heapInstances);
    delete globalThis.__minchoCxRetained;
    retained.length = 0;
    globalThis.gc();
  }
}

// Allocation sampling includes collected objects, unlike a heapUsed delta.
// This is a separate untimed pass; the inspector never affects timing samples.
const session = new Session();
session.connect();

const post = promisify(session.post.bind(session));
await post("HeapProfiler.enable");
await post("HeapProfiler.startSampling", {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true
});
reset();

if (!data.unique && !cold) for (const input of data.inputs) sink = cx(...input);

const allocationOperations = Math.min(operations, 2000);

for (let i = 0; i < allocationOperations; i += 1) sink = invoke(i);

const { profile } = await post("HeapProfiler.stopSampling");
session.disconnect();

const sampledBytes = profile.samples.reduce((sum, item) => sum + item.size, 0);

assert.ok(sink !== undefined);

process.stdout.write(
  JSON.stringify({
    scenario: name,
    operations,
    warmupRounds,
    timeNs: summary(samplesNs),
    retainedBytesPerFactory: heapSamples.length ? summary(heapSamples) : null,
    retainedArrayBufferBytesPerFactory: bufferSamples.length
      ? summary(bufferSamples)
      : null,
    retainedExternalBytesPerFactory: externalSamples.length
      ? summary(externalSamples)
      : null,
    allocationOperations,
    sampledAllocatedBytesPerOp: sampledBytes / allocationOperations,
    note: "Allocation sampling is approximate and includes preparation; retained heap excludes shared input/artifact fixtures. ArrayBuffers are included in external memory, not heapUsed; do not add both external and ArrayBuffers."
  }) + "\n"
);

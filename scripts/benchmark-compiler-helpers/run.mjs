// Timing, allocation sampling and retained result objects are separate passes.
import { Session } from "node:inspector";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const [file, operationsText = "50000"] = process.argv.slice(2);
const operations = Number(operationsText);
globalThis.gc();

const importHeapBefore = process.memoryUsage().heapUsed;
const importStart = performance.now();
const loaded = await import(pathToFileURL(file));
const importMs = performance.now() - importStart;
globalThis.gc();

const moduleHeapDelta = process.memoryUsage().heapUsed - importHeapBefore;
const { run } = loaded.run ? loaded : loaded.default;
const input = {
  tone: "blue",
  size: "lg",
  width: 4,
  height: 8,
  color: "red",
  minWidth: 0,
  minHeight: 0,
  maxWidth: 100,
  maxHeight: 100,
  marginTop: 1,
  marginBottom: 2,
  marginLeft: 3,
  marginRight: 4,
  paddingTop: 1,
  paddingBottom: 2,
  paddingLeft: 3,
  paddingRight: 4,
  borderTopWidth: 1,
  borderBottomWidth: 2,
  pre: { id: "pre", className: "pre", style: { opacity: 0.5 } },
  post: { title: "post", className: "post", style: { display: "block" } },
  f0: true,
  f1: false,
  f2: true,
  f3: false,
  f4: true
};

let sink;
const start = performance.now();
sink = run(input, 0);

const firstCallNs = (performance.now() - start) * 1e6;

for (let round = 0; round < 5; round++)
  for (let i = 0; i < operations; i++) sink = run(input, i);

const summary = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    median: sorted[sorted.length >> 1],
    min: sorted[0],
    max: sorted.at(-1),
    samples
  };
};

const times = [];

for (let round = 0; round < 9; round++) {
  globalThis.gc();

  const start = performance.now();

  for (let i = 0; i < operations; i++) sink = run(input, i);

  times.push(((performance.now() - start) * 1e6) / operations);
}

const retained = [];

for (let sample = 0; sample < 3; sample++) {
  globalThis.gc();

  const before = process.memoryUsage().heapUsed;
  const results = Array.from({ length: 10000 }, (_, i) => run(input, i));
  globalThis.__minchoHelperResults = results;
  globalThis.gc();
  retained.push((process.memoryUsage().heapUsed - before) / results.length);
  delete globalThis.__minchoHelperResults;
  results.length = 0;
}

const session = new Session();
session.connect();

const post = promisify(session.post.bind(session));
await post("HeapProfiler.startSampling", {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true
});

for (let i = 0; i < 10000; i++) sink = run(input, i);

const { profile } = await post("HeapProfiler.stopSampling");
session.disconnect();
process.stdout.write(
  JSON.stringify({
    file,
    operations,
    firstCallNs,
    importMs,
    moduleHeapDelta,
    timeNs: summary(times),
    retainedResultBytes: summary(retained),
    sampledAllocatedBytesPerCall:
      profile.samples.reduce((sum, item) => sum + item.size, 0) / 10000,
    sink
  }) + "\n"
);

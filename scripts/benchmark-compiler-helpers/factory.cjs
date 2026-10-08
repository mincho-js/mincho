const { createRequire } = require("node:module");
const { join } = require("node:path");
const [root, version, mode] = process.argv.slice(2);
const requireCss = createRequire(join(root, "packages/css/package.json"));
const props = { width: "--width", color: "--color" };
const config = {
  defaultClassName: "base",
  variantClassNames: {
    tone: { red: "red", blue: "blue" },
    size: { sm: "small", lg: "large" }
  },
  defaultVariants: { tone: "red" },
  compoundVariants: [[{ tone: "blue", size: "lg" }, "compound"]]
};

const data = version === "before" ? { ...config, propVars: props } : config;
const factory =
  version === "after" && mode === "classes"
    ? requireCss("@mincho-js/css/rules/createClassRuntimeFn")
        .createCompiledClassRuntimeFn
    : requireCss("@mincho-js/css/rules/createRuntimeFn")
        .createCompiledRuntimeFn;

const create =
  version === "before"
    ? () => factory(data)
    : mode === "classes"
      ? () => factory(data, { variants: false, classNames: false })
      : () => factory(data, props);

let sink;

for (let i = 0; i < 50000; i++) sink = create();

const samples = [];

for (let round = 0; round < 9; round++) {
  globalThis.gc();

  const start = performance.now();

  for (let i = 0; i < 20000; i++) sink = create();

  samples.push(((performance.now() - start) * 1e6) / 20000);
}

const heap = [];

for (let round = 0; round < 3; round++) {
  globalThis.gc();

  const before = process.memoryUsage().heapUsed;
  const results = Array.from({ length: 10000 }, create);
  globalThis.__factories = results;
  globalThis.gc();
  heap.push((process.memoryUsage().heapUsed - before) / results.length);
  delete globalThis.__factories;
  results.length = 0;
}

process.stdout.write(
  JSON.stringify({
    version,
    mode,
    ns: samples,
    retainedBytes: heap,
    value: sink({ tone: "blue", size: "lg" })
  }) + "\n"
);

// Run after building @mincho-js/babel, with Node --expose-gc.
// The optional revision fixes fixture sources when comparing cache implementations.
const { createRequire } = require("node:module");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const { performance } = require("node:perf_hooks");
const { serialize, deserialize } = require("node:v8");
const req = createRequire(resolve("packages/babel/package.json"));
const { parseSync, types: t } = req("@babel/core");
const { InternalSourceAstCache: SourceAstCache } = req("./dist/cjs/index.cjs");
const fixtureRevision = process.argv[2];
const readFixture = (path) =>
  fixtureRevision
    ? execFileSync("git", ["show", fixtureRevision + ":" + path], {
        encoding: "utf8"
      })
    : readFileSync(path, "utf8");
const fixtures = [
  {
    name: "small-token",
    filename: "/token.ts",
    source:
      'export const tokens = {color:"red", spacing: {sm: 4, md: 8}} as const;'
  },
  {
    name: "component",
    filename: "/component.tsx",
    source: `import {styled} from '@mincho-js/react';\nexport const Button = styled('button', {color:'red', selectors:{'&:hover':{color:'blue'}}});\nexport const App = ({label}:{label:string}) => <Button css={{padding:8}}>{label}</Button>;`
  },
  {
    name: "module-parser",
    filename: "/parser.ts",
    source: readFixture("packages/babel/src/staticCssEval/moduleParser.ts")
  },
  {
    name: "vite-plugin",
    filename: "/vite.ts",
    source: readFixture("packages/vite/src/index.ts")
  }
];
const results = [];
for (const fixture of fixtures) {
  const jsx = fixture.filename.endsWith(".tsx");
  const options = {
    filename: fixture.filename,
    configFile: false,
    babelrc: false,
    parserOpts: {
      sourceType: "unambiguous",
      plugins: jsx ? ["jsx", "typescript"] : ["typescript"]
    }
  };
  const parse = () => parseSync(fixture.source, options);
  const ast = parse();
  const serialized = serialize(ast);
  const input = {
    resolvedFile: fixture.filename,
    source: fixture.source,
    parserOptions: {
      plugins: options.parserOpts.plugins,
      sourceType: "unambiguous",
      jsx,
      typescript: true
    }
  };
  const cache = new SourceAstCache();
  cache.parse(input);
  const operations = {
    parseSync: parse,
    structuredClone: () => structuredClone(ast),
    cloneNode: () => t.cloneNode(ast, true, false),
    deserialize: () => deserialize(serialized),
    cacheRead: () => cache.parse(input),
    serialize: () => serialize(ast)
  };
  const samples = Object.fromEntries(
    Object.keys(operations).map((k) => [k, []])
  );
  for (const op of Object.values(operations)) for (let i = 0; i < 12; i++) op();
  const iterations =
    fixture.name === "vite-plugin"
      ? 15
      : fixture.name === "module-parser"
        ? 75
        : 300;
  for (let round = 0; round < 5; round++) {
    const names = Object.keys(operations);
    const rotated = names.slice(round).concat(names.slice(0, round));
    for (const name of rotated) {
      global.gc();
      const start = performance.now();
      let value;
      for (let i = 0; i < iterations; i++) value = operations[name]();
      samples[name].push((performance.now() - start) / iterations);
      if (!value) throw new Error("missing result");
    }
  }
  const retained = [];
  const memory = [];
  const count =
    fixture.name === "vite-plugin"
      ? 16
      : fixture.name === "module-parser"
        ? 80
        : 400;
  for (let round = 0; round < 4; round++) {
    retained.length = 0;
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < count; i++) retained.push(parse());
    global.gc();
    if (round > 0)
      memory.push((process.memoryUsage().heapUsed - before) / count);
  }
  retained.length = 0;
  const result = {
    name: fixture.name,
    sourceBytes: Buffer.byteLength(fixture.source),
    serializedBytes: serialized.length,
    retainedHeapBytesPerAst: memory,
    iterations,
    samples,
    medianMs: Object.fromEntries(
      Object.entries(samples).map(([k, v]) => [
        k,
        [...v].sort((a, b) => a - b)[2]
      ])
    ),
    cloneNodePreservesOffsets:
      t.cloneNode(ast, true, false).program.body[0].start ===
      ast.program.body[0].start
  };
  results.push(result);
  console.error(JSON.stringify(result));
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      fixtureRevision: fixtureRevision ?? null,
      babel: req("@babel/core/package.json").version,
      fixtures: results
    },
    null,
    2
  )
);

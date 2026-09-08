// Run with the repository's mise/Yarn environment. No fixtures are written.
// Example: mise exec -- yarn node scripts/benchmark-preset-graph.mjs --nodes=500 --copies=16 --samples=5
// --target=dist measures the last built package; source is the default.
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("="))
);

const integer = (name, fallback) => {
  const value = Number(options[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);

  return value;
};

const count = integer("nodes", 100);
const copies = integer("copies", 4);
const atomsPerNode = integer("atoms", 1);
const shape = options.shape ?? "chain";
if (!["chain", "wide", "diamond"].includes(shape))
  throw new Error("--shape must be chain, wide or diamond");

const samples = integer("samples", 20);
const warmups = integer("warmups", 3);
const target = options.target ?? "source";
if (!["source", "dist"].includes(target))
  throw new Error("--target must be source or dist");

const repo = process.env.PWD ?? fileURLToPath(new URL("../", import.meta.url));

const directoryDigest = (relativeDirectory) => {
  const directory = resolve(repo, relativeDirectory);
  const hash = createHash("sha256");

  for (const name of readdirSync(directory, { recursive: true })
    .filter((name) => /\.(?:ts|js|cjs|mjs)$/.test(name))
    .sort()) {
    hash.update(name).update(readFileSync(resolve(directory, name)));
  }

  return hash.digest("hex");
};

const measuredDirectory =
  target === "source" ? "packages/css/src" : "packages/css/dist";

const sourceDigest = () => directoryDigest("packages/css/src");

const digest = sourceDigest();
const measuredDigest = directoryDigest(measuredDirectory);

if (!options.child) {
  console.log(
    JSON.stringify({
      node: process.version,
      target,
      sourceDigest: digest,
      measuredDigest,
      shape,
      atomsPerNode,
      nodes: count,
      copies,
      samples,
      warmups,
      heapMB: 512,
      timeoutMs: 60_000,
      note: "RSS includes module loading, fixture creation and timed operations. Each case runs in an isolated process; timings exclude fixture creation."
    })
  );

  for (const child of ["shared", "cloned", "verified", "authoring"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=512",
        "--experimental-transform-types",
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        `--child=${child}`
      ],
      { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 }
    );

    if (result.status !== 0) {
      console.error(
        JSON.stringify({
          child,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stderr: result.stderr
        })
      );
      process.exitCode = 1;
    } else process.stdout.write(result.stdout);
  }

  if (
    sourceDigest() !== digest ||
    directoryDigest(measuredDirectory) !== measuredDigest
  )
    throw new Error("Source changed during measurement; discard these results");
} else {
  // Source execution uses the pinned development Node's native TS stripping.
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (
          specifier.startsWith(".") &&
          specifier.endsWith(".js") &&
          context.parentURL?.includes("/packages/css/src/")
        )
          return next(specifier.slice(0, -3) + ".ts", context);

        throw error;
      }
    }
  });

  const source = (name) =>
    import(
      pathToFileURL(resolve(repo, `packages/css/src/defineRules/${name}.ts`))
        .href
    );

  const {
    createDefineRulesPresetNodeV5: makeNode,
    createPresetOriginId: origin
  } = await source("presetCanonical");

  const requireCss = createRequire(resolve(repo, "packages/css/package.json"));
  const { defineRules } =
    target === "source" ? await source("index") : requireCss("@mincho-js/css");

  const { parseDefineRulesPresetArtifactV5: parse } =
    target === "source"
      ? await source("presetArtifact")
      : requireCss("@mincho-js/css/defineRules/registry");

  const { resolveDefineRulesPresetGraphV5: merge } =
    target === "source"
      ? await source("presetGraph")
      : requireCss("@mincho-js/css/defineRules/registry");

  const measure = (run, prepare = () => undefined) => {
    for (let index = 0; index < warmups; index++) run(prepare());

    const values = [];

    for (let index = 0; index < samples; index++) {
      const prepared = prepare();
      const start = performance.now();
      run(prepared);
      values.push(performance.now() - start);
    }

    values.sort((a, b) => a - b);

    return {
      medianMs: values[Math.floor(values.length / 2)],
      p95Ms: values[Math.ceil(values.length * 0.95) - 1]
    };
  };

  const report = {
    case: options.child,
    uniqueNodes: count,
    edges: count - 1,
    atoms: 0
  };

  if (options.child === "authoring") {
    report.authoring = measure(() => {
      let owner = defineRules({ properties: {} });

      for (let index = 1; index < count; index++)
        owner = defineRules({ properties: {}, presets: owner.preset });

      assert.equal(owner.preset.nodes.length, count);
    });
    report.inputNote =
      "Every step consumes the growing parent snapshot; final unique node count is not total input volume.";
  } else {
    const nodes = [];

    for (let index = 0; index < count; index++)
      nodes.push(
        makeNode({
          origin: origin({
            packageName: `@benchmark/preset-${index}`,
            producerPath: "rules.css.ts",
            registrationIndex: 0
          }),
          parents:
            index === 0
              ? []
              : shape === "wide"
                ? index === count - 1
                  ? nodes.map((node) => node.nodeId)
                  : [nodes[0].nodeId]
                : shape === "diamond" && index > 1
                  ? [nodes[index - 2].nodeId, nodes[index - 1].nodeId]
                  : [nodes[index - 1].nodeId],
          atoms: Array.from({ length: atomsPerNode }, (_, atomIndex) => ({
            cacheKey: `color:${atomIndex}`,
            className: `node_${index}_atom_${atomIndex}`,
            property: "color",
            condition: {
              layer: null,
              supports: null,
              media: null,
              container: null,
              selector: "&"
            }
          }))
        })
      );

    const artifact = {
      schema: "mincho.defineRulesPreset",
      version: 5,
      rootNodeId: nodes.at(-1).nodeId,
      nodes
    };

    const reusable = options.child === "verified" ? parse(artifact) : artifact;
    const inputs = Array.from({ length: copies }, () =>
      options.child === "cloned"
        ? JSON.parse(JSON.stringify(artifact))
        : reusable
    );

    report.shape = shape;
    report.edges = nodes.reduce(
      (total, node) => total + node.parents.length,
      0
    );
    report.atoms = count * atomsPerNode;
    report.inputArtifacts = copies;
    report.serializedBytes = Buffer.byteLength(JSON.stringify(inputs));
    report.parse = measure(() => {
      for (const input of inputs) parse(input);
    });
    report.resolve = measure(() =>
      assert.equal(merge(inputs).producerOrigins.length, count)
    );
    report.defineRules = measure(() =>
      defineRules({ properties: {}, presets: inputs })
    );

    // Prepare owners outside the timed region; only snapshot work is timed.
    report.snapshot = measure(
      (owner) => assert.equal(owner.preset.nodes.length, count + 1),
      () => defineRules({ properties: {}, presets: inputs })
    );

    const owner = defineRules({ properties: {}, presets: inputs });
    const snapshot = owner.preset;
    report.cachedSnapshot = measure(() => assert.equal(owner.preset, snapshot));
  }

  report.peakRssKiB = process.resourceUsage().maxRSS;
  console.log(JSON.stringify(report));
}

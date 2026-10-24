import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build } from "esbuild";
import {
  internalMeasureBundleBytes as measureBundleBytes,
  internalBundleSizeMetric as bundleSizeMetric,
  type BundleSizeOptions
} from "@mincho-js/babel";

export { measureBundleBytes, bundleSizeMetric };
export type { BundleSizeOptions, BundleBytes } from "@mincho-js/babel";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Rollup rewrites import.meta.url for CommonJS.
const ownRequire = createRequire(import.meta.url);

export interface RuntimeCostGraph {
  modules: ReadonlyMap<string, string>;
  resolutions: ReadonlyMap<string, string>;
}

/** A minified module plus its real compiler-helper graph, not a final asset size. */
export async function measureRuntimeCandidate(
  source: string,
  filename: string,
  graph?: RuntimeCostGraph
) {
  const sourcefile = "mincho-cost-input.tsx";
  const result = await build({
    stdin: {
      contents: source,
      sourcefile,
      resolveDir: dirname(filename.replace(/^\0[^:]+:/, "")),
      loader: "tsx"
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    minify: true,
    logLevel: "silent",
    plugins: [
      {
        name: "mincho-runtime-cost",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const entry =
              args.importer === sourcefile ||
              args.importer.endsWith("/" + sourcefile) ||
              args.importer === "<stdin>";
            if (
              args.kind !== "entry-point" &&
              !entry &&
              args.namespace !== "mincho-cost-graph"
            )
              return;
            if (
              /^@mincho-js\/css\/(?:rules|defineRules)\/create\w*Runtime(?:Fn)?$/.test(
                args.path
              )
            )
              return { path: ownRequire.resolve(args.path) };
            const resolved = graph?.resolutions.get(
              `${entry ? filename : args.importer}\0${args.path}`
            );
            if (resolved && graph?.modules.has(resolved))
              return { path: resolved, namespace: "mincho-cost-graph" };
            return {
              path: args.path.includes("\0")
                ? "mincho-virtual-style"
                : args.path,
              external: true
            };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "mincho-cost-graph" },
            (args) => ({
              contents: graph!.modules.get(args.path)!,
              loader: "tsx"
            })
          );
        }
      }
    ]
  });
  return measureBundleBytes(result.outputFiles[0].contents);
}

export async function preferRuntimeCandidate(
  before: string,
  after: string,
  filename: string,
  options?: BundleSizeOptions,
  graph?: RuntimeCostGraph
) {
  const [original, candidate] = await Promise.all([
    measureRuntimeCandidate(before, filename, graph),
    measureRuntimeCandidate(after, filename, graph)
  ]);
  const metric = bundleSizeMetric(options);
  return {
    applied: candidate[metric] < original[metric],
    metric,
    original,
    candidate
  };
}

// @ts-expect-error Authoring preset data is available only from ./preset.
import type { preset } from "@mincho-js-proof/real-d" with {
  "resolution-mode": "import"
};
import type { preset as packedPreset } from "@mincho-js-proof/real-d/preset" with {
  "resolution-mode": "import"
};
import { defineRules } from "@mincho-js/css";
import type { DefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";
import {
  minchoBabelPlugin,
  type ExtractCalls,
  type PluginOptions
} from "@mincho-js/babel";
import {
  babelTransformSource,
  collectDefineRulesPackageGraph,
  getDefineRulesAncestorStyleSpecifiers,
  type BabelTransformSourceOptions,
  type ExtractCalls as IntegrationExtractCalls,
  type MinchoExecutionOptions as IntegrationExecutionOptions,
  type MinchoCacheOptions as IntegrationCacheOptions,
  type InternalStaticCssEvalSourceProvider
} from "@mincho-js/integration";
import {
  collectDefineRulesPackageGraph as collectPurePackageGraph,
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageGraph,
  type DefineRulesPackageGraphArtifact
} from "@mincho-js/integration/package-graph";
import {
  minchoEsbuildPlugins,
  type ExtractCalls as EsbuildExtractCalls,
  type MinchoExecutionOptions as EsbuildExecutionOptions,
  type MinchoCacheOptions as EsbuildCacheOptions
} from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import type {
  MinchoVitePluginOptions,
  ExtractCalls as ViteExtractCalls,
  MinchoExecutionOptions as ViteExecutionOptions,
  MinchoCacheOptions as ViteCacheOptions
} from "@mincho-js/vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

const extractCalls = {
  "./factory.ts": ["make"]
} satisfies ExtractCalls &
  IntegrationExtractCalls &
  EsbuildExtractCalls &
  ViteExtractCalls;

const cache = {
  type: "filesystem",
  maxBytes: 1024 * 1024,
  evaluationResults: false
} satisfies IntegrationCacheOptions & EsbuildCacheOptions & ViteCacheOptions;

const execution = {
  workers: 1,
  ioConcurrency: 2,
  evaluation: "auto"
} satisfies IntegrationExecutionOptions &
  EsbuildExecutionOptions &
  ViteExecutionOptions;

const babelOptions: PluginOptions = { result: ["", ""], extractCalls };

const options: BabelTransformSourceOptions = {
  babel: { extractCalls },
  filename: "/virtual/consumer.ts",
  source: "export const answer: number = 42;",
  loader: "ts",
  sourceMaps: true
};

const provider: InternalStaticCssEvalSourceProvider = {
  resolve: () => null,

  load: () => null
};

const babelPlugin = minchoBabelPlugin();
const esbuildPlugins: EsbuildPlugin[] = minchoEsbuildPlugins({
  cache,
  execution,
  extractCalls,
  jsxCssProp: true
});

const viteOptions: MinchoVitePluginOptions = {
  cache,
  execution,
  extractCalls,
  jsxCssProp: true,
  libraryCss: { fileName: "style.css", analysis: "worker" }
};

const vitePlugin: VitePlugin = minchoVitePlugin(viteOptions);

export {
  options,
  provider,
  babelPlugin,
  babelOptions,
  esbuildPlugins,
  vitePlugin
};

export const transform = () => babelTransformSource(options);

// Direct API artifacts must cross either conditional declaration format.
export function collectDirectPreset() {
  const preset = defineRules({ properties: { color: true } }).preset;

  return {
    graph: collectDefineRulesPackageGraph([preset]),
    pureGraph: collectPurePackageGraph([preset]),
    styles: getDefineRulesAncestorStyleSpecifiers({
      instances: [{ getPresetSnapshot: () => preset }]
    })
  };
}

export function collectRegistryStyles(session: DefineRulesRegistrySession) {
  return getDefineRulesAncestorStyleSpecifiers(session);
}

export function collectPackedPreset(preset: typeof packedPreset) {
  return collectDefineRulesPackageGraph([preset]);
}

export function collectPackedPackageGraph(preset: typeof packedPreset): {
  graph: DefineRulesPackageGraph;
  styles: readonly string[];
} {
  const artifact: DefineRulesPackageGraphArtifact = preset;
  const graph = mergeDefineRulesPackageGraphs([
    collectPurePackageGraph([artifact]),
    collectDefineRulesPackageGraph([preset])
  ]);

  return { graph, styles: getDefineRulesPackageStyleSpecifiers(graph) };
}

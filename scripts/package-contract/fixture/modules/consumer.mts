// @ts-expect-error Authoring preset data is available only from ./preset.
import type { preset } from "@mincho-js-proof/real-d" with {
  "resolution-mode": "import"
};
import type { preset as packedPreset } from "@mincho-js-proof/real-d/preset" with {
  "resolution-mode": "import"
};
import { defineRules } from "@mincho-js/css";
import type { DefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";
import { minchoBabelPlugin } from "@mincho-js/babel";
import {
  babelTransformSource,
  collectDefineRulesPackageGraph,
  getDefineRulesAncestorStyleSpecifiers,
  type BabelTransformSourceOptions,
  type InternalStaticCssEvalSourceProvider
} from "@mincho-js/integration";
import {
  collectDefineRulesPackageGraph as collectPurePackageGraph,
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageGraph,
  type DefineRulesPackageGraphArtifact
} from "@mincho-js/integration/package-graph";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import type { MinchoVitePluginOptions } from "@mincho-js/vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin as VitePlugin } from "vite";

const options: BabelTransformSourceOptions = {
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
  jsxCssProp: true
});

const viteOptions: MinchoVitePluginOptions = {
  jsxCssProp: true,
  libraryCss: { fileName: "style.css", analysis: "worker" }
};

const vitePlugin: VitePlugin = minchoVitePlugin(viteOptions);

export { options, provider, babelPlugin, esbuildPlugins, vitePlugin };

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

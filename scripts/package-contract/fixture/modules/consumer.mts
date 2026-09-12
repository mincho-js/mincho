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
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
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

const vitePlugin: VitePlugin = minchoVitePlugin({ jsxCssProp: true });

export { options, provider, babelPlugin, esbuildPlugins, vitePlugin };

export const transform = () => babelTransformSource(options);

// Direct API artifacts must cross either conditional declaration format.
export function collectDirectPreset() {
  const preset = defineRules({ properties: { color: true } }).preset;

  return {
    graph: collectDefineRulesPackageGraph([preset]),
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

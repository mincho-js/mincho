import { minchoBabelPlugin } from "@mincho-js/babel";
import {
  babelTransformSource,
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

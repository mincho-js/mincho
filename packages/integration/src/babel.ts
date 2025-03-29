import { TransformOptions, transformFileAsync } from "@babel/core";
import {
  PluginOptions,
  minchoBabelPlugin,
  minchoStyledComponentPlugin
} from "@mincho-js/babel";

export type BabelOptions = Omit<
  TransformOptions,
  | "ast"
  | "filename"
  | "root"
  | "sourceFileName"
  | "sourceMaps"
  | "inputSourceMap"
>;

export async function babelTransform(path: string, babel: BabelOptions = {}) {
  const options: PluginOptions = { result: ["", ""] };
  const result = await transformFileAsync(path, {
    ...babel,
    plugins: [
      ...(Array.isArray(babel.plugins) ? babel.plugins : []),
      minchoStyledComponentPlugin(),
      [minchoBabelPlugin(), options]
    ],
    presets: [
      ...(Array.isArray(babel.presets) ? babel.presets : []),
      "@babel/preset-typescript"
    ],
    sourceMaps: false
  });

  if (result === null || result.code === null) {
    throw new Error(`Failed to transform ${path}`);
  }

  return { result: options.result, code: result.code };
}

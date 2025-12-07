import { transform } from "oxc-transform";
import type { TransformOptions, TransformResult } from "oxc-transform";
import type { MinchoOxcBaseOptions } from "./types.js";

/**
 * OXC base transform - handles TypeScript and JSX only
 *
 * NOTE: This does NOT handle Mincho transformations (styled(), style(), css())
 * Those require the separate Mincho transform layer with oxc-parser
 *
 * @param filename - Path to the file being transformed
 * @param code - Source code to transform
 * @param options - Transform options
 * @returns Transform result with code and source map
 */
export function oxcBaseTransform(
  filename: string,
  code: string,
  options: MinchoOxcBaseOptions = {}
): TransformResult {
  // OXC's transform is synchronous and very fast
  const result = transform(filename, code, {
    typescript: {
      onlyRemoveTypeImports: options.typescript?.onlyRemoveTypeImports ?? true,
      declaration: options.typescript?.declaration
    },
    jsx: {
      runtime: options.jsx?.runtime ?? "automatic",
      development:
        options.jsx?.development ?? process.env.NODE_ENV !== "production",
      importSource: options.jsx?.importSource
    },
    // NOTE: OXC's styledComponents plugin is for styled-components library,
    // NOT for Mincho's styled() API. Do not enable this.
    // styledComponents: false, // explicitly disabled
    target: options.target ?? "es2020",
    sourcemap: options.sourcemap ?? true
  } as TransformOptions);

  return {
    code: result.code,
    map: result.map
  };
}

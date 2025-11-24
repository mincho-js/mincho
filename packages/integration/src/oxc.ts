import { readFile } from "node:fs/promises";
import { oxcBaseTransform, minchoTransform } from "@mincho-js/oxc";
import type {
  MinchoOxcBaseOptions,
  MinchoTransformOptions
} from "@mincho-js/oxc";

/**
 * Transform a file using OXC
 *
 * This performs a two-phase transformation:
 * 1. OXC base transform (TypeScript + JSX)
 * 2. Mincho custom transform (styled(), style(), css(), etc.)
 *
 * @param path - File path to transform
 * @param options - Optional transform options
 * @returns Transformation result with code and CSS extractions
 */
export async function oxcTransformFile(
  path: string,
  options?: {
    oxc?: MinchoOxcBaseOptions;
    mincho?: Partial<MinchoTransformOptions>;
    cwd?: string;
  }
) {
  const cwd = options?.cwd || process.cwd();

  const code = await readFile(path, "utf-8");

  // Phase 1: OXC base transform (TS/JSX only)
  const oxcResult = oxcBaseTransform(path, code, options?.oxc);

  // Phase 2: Mincho custom transform
  const minchoResult = minchoTransform(oxcResult.code, {
    filename: path,
    sourceRoot: cwd,
    extractCSS: true,
    ...options?.mincho
  });

  return {
    code: minchoResult.code,
    result:
      minchoResult.cssExtractions.length > 0
        ? [
            minchoResult.cssExtractions[0].id,
            minchoResult.cssExtractions[0].content
          ]
        : ["", ""],
    cssExtractions: minchoResult.cssExtractions,
    dependencies: minchoResult.dependencies
  };
}

/**
 * Transform code string using OXC
 *
 * @param filename - Virtual filename for the transform
 * @param code - Source code to transform
 * @param options - Optional transform options
 * @returns Transformation result
 */
export function oxcTransform(
  filename: string,
  code: string,
  options?: {
    oxc?: MinchoOxcBaseOptions;
    mincho?: Partial<MinchoTransformOptions>;
    cwd?: string;
  }
) {
  const cwd = options?.cwd || process.cwd();

  // Phase 1: OXC base transform (TS/JSX only)
  const oxcResult = oxcBaseTransform(filename, code, options?.oxc);

  // Phase 2: Mincho custom transform
  const minchoResult = minchoTransform(oxcResult.code, {
    filename,
    sourceRoot: cwd,
    extractCSS: true,
    ...options?.mincho
  });

  return {
    code: minchoResult.code,
    result:
      minchoResult.cssExtractions.length > 0
        ? [
            minchoResult.cssExtractions[0].id,
            minchoResult.cssExtractions[0].content
          ]
        : ["", ""],
    cssExtractions: minchoResult.cssExtractions,
    dependencies: minchoResult.dependencies
  };
}

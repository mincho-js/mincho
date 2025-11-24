/**
 * Mincho Vite Plugin - Main Entry Point
 */

import type { BabelOptions } from "@mincho-js/integration";
import type { MinchoOxcBaseOptions } from "@mincho-js/oxc";
import type { Plugin } from "./types.js";
import { minchoBabelVitePlugin } from "./vite-babel.js";
import { minchoOxcVitePlugin } from "./vite-oxc.js";

/**
 * Unified Mincho Vite Plugin
 *
 * By default, uses OXC for faster builds (10-15x faster than Babel).
 * Set MINCHO_USE_BABEL=true environment variable to use Babel instead.
 *
 * @example
 * // Using OXC (default, recommended)
 * export default defineConfig({
 *   plugins: [minchoVitePlugin()]
 * });
 *
 * @example
 * // Using Babel (legacy)
 * // Set environment variable: MINCHO_USE_BABEL=true
 * export default defineConfig({
 *   plugins: [minchoVitePlugin()]
 * });
 */
export function minchoVitePlugin(
  options?:
    | { babel?: BabelOptions }
    | { oxc?: MinchoOxcBaseOptions; mincho?: { extractCSS?: boolean } }
): Plugin {
  // Check for environment variable to use Babel instead of OXC
  if (process.env.MINCHO_USE_BABEL === "true") {
    // Use Babel version (legacy)
    return minchoBabelVitePlugin(options as { babel?: BabelOptions });
  }

  // Use OXC version by default (new, faster implementation)
  return minchoOxcVitePlugin(
    options as
      | { oxc?: MinchoOxcBaseOptions; mincho?: { extractCSS?: boolean } }
      | undefined
  );
}

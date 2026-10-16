import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "vite";

/** Deferred CSS has not run Vite's PostCSS loader when buildEnd is called. */
export function hasOpaquePostcss(config: ResolvedConfig): boolean {
  if (config.css.postcss || config.css.lightningcss) return true;

  for (let directory = config.root; ; directory = dirname(directory)) {
    try {
      const files = readdirSync(directory);
      if (
        files.some((name) =>
          /^(postcss\.config\.(?:c|m)?[jt]s|\.postcssrc(?:\.(?:json|ya?ml|(?:c|m)?[jt]s))?)$/.test(
            name
          )
        )
      )
        return true;

      if (files.includes("package.json")) {
        const pkg = JSON.parse(
          readFileSync(join(directory, "package.json"), "utf8")
        );
        if (pkg.postcss !== undefined) return true;
      }
    } catch {
      return true;
    }

    if (dirname(directory) === directory) return false;
  }
}

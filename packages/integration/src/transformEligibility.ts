import { internalAnalyzeSource } from "@mincho-js/babel";
import { join } from "node:path";
import type { BabelTransformSourceOptions } from "./babel.js";
import { CompilationInputs } from "./compilationInputs.js";
import { recordCompilationDiagnostic } from "./diagnostics.js";

/** Only adapters may skip Babel: the standalone Babel API still emits JavaScript. */
export async function canSkipMinchoTransform(
  options: BabelTransformSourceOptions
): Promise<boolean> {
  const cache = options.babel?.compilationCache;

  // Inspect eligibility in the same validated input session as compilation.
  return cache
    ? cache.withInputs(() => inspectTransformEligibility(options))
    : inspectTransformEligibility(options);
}

async function inspectTransformEligibility(
  options: BabelTransformSourceOptions
): Promise<boolean> {
  const {
    compilationCache: cache,
    compilationContext: _context,
    optimize: _optimize,
    jsxCssProp,
    diagnostics: _diagnostics,
    staticCssEvalSourceProvider: _provider,
    staticCssEvalProjectEngine: _engine,
    ...babel
  } = options.babel ?? {};

  // Even an unused registration must be validated; opaque plugins can do work on any input.
  if (
    Object.entries(babel).some(
      ([key, value]) =>
        value !== undefined &&
        !(["babelrc", "configFile"].includes(key) && value === false)
    )
  )
    return false;
  if (/@(?:mincho-js|vanilla-extract)\//.test(options.source)) return false;

  try {
    const facts = internalAnalyzeSource(
      options.filename,
      options.source,
      cache?.parser
    );
    if (
      facts.commonJs ||
      facts.sources.some((source) =>
        /^@(?:mincho-js|vanilla-extract)\//.test(source)
      ) ||
      (jsxCssProp && facts.cssJsx) ||
      facts.calls ||
      facts.componentJsx
    )
      return false;

    if (babel.babelrc !== false || babel.configFile !== false) {
      const inputs = cache ?? new CompilationInputs();
      const fingerprints = await inputs.fingerprint(
        inputs.configurationFiles([
          options.filename,
          join(process.cwd(), "babel.config.js")
        ])
      );
      if (await inputs.hasExternalBabelConfiguration(fingerprints))
        return false;
    }

    recordCompilationDiagnostic("transform-skipped", {
      reason: "no-mincho-candidates"
    });

    return true;
  } catch {
    // Preserve Babel's parser errors and unusual parser configuration behavior.
    return false;
  }
}

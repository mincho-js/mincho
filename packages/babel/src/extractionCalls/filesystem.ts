import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { resolveFromModule } from "../moduleResolution.js";
import type { ExtractCallsAnalysis, PreparedExtractCalls } from "./types.js";

const scriptExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
];

export function canonicalExtractCallsFile(filename: string): string {
  try {
    return realpathSync(filename).replaceAll("\\", "/");
  } catch {
    return resolve(filename).replaceAll("\\", "/");
  }
}

/** Node/PnP resolution, plus the source extensions commonly used with TypeScript. */
export function resolveExtractCallsFile(
  importer: string,
  source: string
): string | null {
  if (source.startsWith(".") || isAbsolute(source)) {
    const path = resolve(dirname(importer), source);
    const extension = extname(path);
    const candidates = [path];

    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
      const stem = path.slice(0, -extension.length);
      candidates.push(
        ...[".ts", ".tsx", ".mts", ".cts"].map((ext) => stem + ext)
      );
    }

    if (!scriptExtensions.includes(extension)) {
      for (const ext of scriptExtensions)
        candidates.push(path + ext, resolve(path, `index${ext}`));
    }

    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile())
          return canonicalExtractCallsFile(candidate);
      } catch {
        /* Try the next source extension. */
      }
    }
  }

  try {
    return canonicalExtractCallsFile(resolveFromModule(importer, source));
  } catch {
    return null;
  }
}

export function runExtractCallsAnalysisSync(
  analysis: ExtractCallsAnalysis
): PreparedExtractCalls {
  let step = analysis.next();

  while (!step.done) {
    const request = step.value;

    try {
      const value =
        request.kind === "resolve"
          ? resolveExtractCallsFile(request.importer, request.source)
          : readFileSync(request.id, "utf8");

      step = analysis.next(value);
    } catch (error) {
      step = analysis.throw(error);
    }
  }

  return step.value;
}

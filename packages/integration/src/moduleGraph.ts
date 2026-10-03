import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  internalCanonicalExtractCallsFile,
  internalResolveExtractCallsFile,
  InternalExtractCallsError,
  type InternalModuleGraphFlow
} from "@mincho-js/babel";
import type { StaticCssEvalSourceProvider } from "./babel.js";

/** Drive the same lexical graph with bundler I/O while retaining failed dependency watches. */
export async function driveModuleGraph<T>(
  analysis: InternalModuleGraphFlow<T>,
  provider?: StaticCssEvalSourceProvider,
  watchFiles = new Set<string>()
): Promise<T> {
  const loadKeys = new Map<string, string>();
  let step = analysis.next();

  while (!step.done) {
    const request = step.value;

    try {
      let value: string | null;

      if (request.kind === "resolve") {
        if (provider) {
          const resolved = await provider.resolve(
            request.importer,
            request.source,
            { kind: request.mode ?? "import" }
          );

          value =
            resolved?.realpath ??
            resolved?.resolvedFile ??
            resolved?.id ??
            resolved?.canonicalModuleId ??
            null;

          if (value) {
            const loadKey =
              resolved?.normalizedPathKey ??
              resolved?.id ??
              resolved?.canonicalModuleId ??
              value;

            if (isAbsolute(value))
              value = internalCanonicalExtractCallsFile(value);

            loadKeys.set(value, loadKey);
          }

          for (const file of resolved?.watchFiles ?? []) watchFiles.add(file);
        } else {
          value = internalResolveExtractCallsFile(
            request.importer,
            request.source
          );
        }
      } else {
        const loaded = provider
          ? await provider.load(loadKeys.get(request.id) ?? request.id)
          : null;

        for (const file of loaded?.watchFiles ?? []) watchFiles.add(file);

        value = provider
          ? (loaded?.sourceText ?? loaded?.source ?? null)
          : await readFile(request.id, "utf8");
      }

      step = analysis.next(value);
    } catch (error) {
      try {
        step = analysis.throw(error);
      } catch (failure) {
        if (failure instanceof InternalExtractCallsError)
          throw new InternalExtractCallsError(failure.message, [
            ...failure.dependencies,
            ...watchFiles
          ]);

        throw failure;
      }
    }
  }

  return step.value;
}

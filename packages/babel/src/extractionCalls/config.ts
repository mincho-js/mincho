import { isAbsolute } from "node:path";
import { builtInExtractionCalls } from "./builtins.js";
import type { ExtractCalls } from "./types.js";

export function isLocalExtractCallsSource(source: string): boolean {
  return source.startsWith(".") || isAbsolute(source);
}

/** Copy, deduplicate and sort without changing the caller's configuration. */
export function normalizeExtractCalls(input: unknown): ExtractCalls {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "extractCalls must be an object mapping sources to export names"
    );

  const result: Record<string, string[]> = Object.create(null);

  for (const source of Object.keys(input).sort()) {
    const names = (input as Record<string, unknown>)[source];
    if (!source.trim() || !Array.isArray(names))
      throw new Error(
        `extractCalls[${JSON.stringify(source)}] must be an array of export names`
      );

    for (const name of names) {
      if (typeof name !== "string" || !name.trim() || name === "*")
        throw new Error(
          `extractCalls[${JSON.stringify(source)}] contains an invalid export name`
        );
    }

    const builtIns = Object.hasOwn(builtInExtractionCalls, source)
      ? builtInExtractionCalls[source]
      : undefined;

    const additions = [...new Set(names as string[])]
      .filter((name) => !builtIns?.includes(name))
      .sort();

    if (additions.length) result[source] = additions;
  }

  return result;
}

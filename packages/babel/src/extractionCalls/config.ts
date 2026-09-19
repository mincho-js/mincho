import { isAbsolute } from "node:path";
import { builtInExtractionCalls } from "./builtins.js";
import type { ExtractCalls } from "./types.js";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";

export function isLocalExtractCallsSource(source: string): boolean {
  return source.startsWith(".") || isAbsolute(source);
}

/** Copy, deduplicate and sort without changing the caller's configuration. */
export function normalizeExtractCalls(
  input: unknown,
  cache?: SourceAstCache
): ExtractCalls {
  const key = cache && configurationKey(input);
  const previous = key ? cache?.get<ExtractCalls>(key) : undefined;
  if (previous) return previous;

  const result = normalizeConfiguration(input);

  if (key) {
    for (const names of Object.values(result)) Object.freeze(names);

    Object.freeze(result);
    cache?.set(key, result, Buffer.byteLength(JSON.stringify(result)));
  }

  return result;
}

function configurationKey(input: unknown): string | undefined {
  if (
    !input ||
    typeof input !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    return;

  const descriptors = Object.getOwnPropertyDescriptors(input);
  const entries: [string, string[]][] = [];

  for (const name of Object.keys(input).sort()) {
    const value = descriptors[name]?.value;
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length
    )
      return;

    const items = Object.getOwnPropertyDescriptors(value);
    if (
      Object.keys(items).some((key) => key !== "length" && !/^\d+$/.test(key))
    )
      return;

    const names: string[] = [];

    for (let index = 0; index < value.length; index++) {
      const item = items[index]?.value;
      if (typeof item !== "string") return;

      names.push(item);
    }

    entries.push([name, names]);
  }

  return `extract-config:${JSON.stringify(entries)}`;
}

function normalizeConfiguration(input: unknown): ExtractCalls {
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

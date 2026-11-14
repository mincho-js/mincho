import type { ExtractCalls } from "../extractionCalls/types.js";
import { isLocalExtractCallsSource } from "../extractionCalls/config.js";
import type { ProgramScope } from "../types.js";
import type { Scope } from "@babel/traverse";
import { cssModuleName } from "./constants.js";

export type JsxCssPropOptions =
  | boolean
  | {
      /** Package or bundler alias exporting the named build-time css function. */
      importSource: string;
    };

export function jsxCssPropImportSource(
  options: JsxCssPropOptions | undefined
): string {
  if (options === undefined || typeof options === "boolean")
    return cssModuleName;

  const source = options?.importSource;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    source !== source.trim() ||
    isLocalExtractCallsSource(source)
  )
    throw new Error(
      "jsxCssProp.importSource must be a package or bundler alias exporting css"
    );

  return source;
}

/** Share registration and its fingerprint between direct Babel and bundlers. */
export function jsxCssPropExtractCalls(
  options: JsxCssPropOptions | undefined,
  extractCalls: ExtractCalls | undefined
): ExtractCalls | undefined {
  const source = jsxCssPropImportSource(options);
  if (source === cssModuleName) return extractCalls;
  const names =
    extractCalls && Object.hasOwn(extractCalls, source)
      ? extractCalls[source]
      : [];

  return {
    ...extractCalls,
    [source]: [...new Set([...names, "css"])]
  };
}

export function cssPropImportSource(scope: Scope): string {
  return (
    (scope.getProgramParent() as ProgramScope).minchoData
      ?.jsxCssPropImportSource ?? cssModuleName
  );
}

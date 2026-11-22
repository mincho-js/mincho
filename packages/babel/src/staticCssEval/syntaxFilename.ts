const sourceExtension = /\.[cm]?[jt]sx?$/;
const typedVirtualSyntax = /^(?:\0?virtual:|pkg:|data:)/;

/** Match the earliest extension delimiter on the final line. Each extension
 * check examines at most the five characters of a supported extension. */
function findSyntaxSuffix(
  id: string,
  start: number,
  queryOnly = false
): number {
  let suffix = -1;
  for (let i = id.length - 1; i >= start; i--) {
    const char = id[i];
    if (
      char === "\n" ||
      char === "\r" ||
      char === "\u2028" ||
      char === "\u2029"
    )
      break;
    if (
      (char === "?" || (!queryOnly && char === "#")) &&
      sourceExtension.test(id.slice(Math.max(start, i - 5), i))
    )
      suffix = i;
  }
  return suffix;
}

/** Metadata-free IDs retain physical directory components. A query containing
 * slashes and ending in a source extension is ambiguous and needs syntaxFilename.
 */
export function inferSyntaxFilename(id: string): string {
  const basenameStart = Math.max(id.lastIndexOf("/"), id.lastIndexOf("\\")) + 1;
  const basenameSuffix = findSyntaxSuffix(id, basenameStart);
  if (basenameSuffix !== -1) return id.slice(0, basenameSuffix);
  if (sourceExtension.test(id.slice(Math.max(basenameStart, id.length - 5))))
    return id;
  // A slash in a query value must not hide its preceding source extension.
  const suffix = findSyntaxSuffix(id, 0);
  return suffix === -1 ? id : id.slice(0, suffix);
}

/** An explicit logical ID can have a slash or a source-like basename inside
 * its host suffix. Prefer the extension before the first recognized delimiter;
 * physical paths and metadata-free guesses use their existing precedence.
 */
export function inferLogicalSyntaxFilename(id: string): string {
  const suffix = findSyntaxSuffix(id, 0);
  return suffix === -1 ? id : id.slice(0, suffix);
}

/** With no provenance, a source extension directly before a query wins even
 * if the query value contains slashes. Otherwise favor the actual basename;
 * an earlier hash may be a literal directory character. Explicit loader and
 * host IDs are needed to disambiguate a literal query-like directory or a
 * slash-bearing fragment that itself looks like a path.
 */
export function inferMetadataFreeSyntaxFilename(id: string): string {
  if (id.includes("?")) {
    const query = findSyntaxSuffix(id, 0, true);
    if (
      query !== -1 &&
      query < Math.max(id.lastIndexOf("/"), id.lastIndexOf("\\"))
    )
      return id.slice(0, query);
  }

  return inferSyntaxFilename(id);
}

/** Concrete parser syntax for a declared virtual source, not a prefix guess. */
export function hasConcreteLogicalSyntaxFilename(id: string): boolean {
  return sourceExtension.test(inferLogicalSyntaxFilename(id));
}

/** Syntax recognition for provider metadata, without changing its graph identity. */
export function hasStaticCssEvalSyntaxFilename(
  id: string,
  physical = false
): boolean {
  const filename = physical ? id : inferSyntaxFilename(id);
  return sourceExtension.test(filename) || typedVirtualSyntax.test(filename);
}

export function hasVirtualTypeScriptSyntax(filename: string): boolean {
  return typedVirtualSyntax.test(filename);
}

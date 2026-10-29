/**
 * Appends an inline source map. The comment is a plain string concatenation
 * so that bundled output keeps it on the same line as code; a template literal
 * would be printed with a real newline, and tools that scan this package's
 * own files would read that line as the package's source map.
 */
export function appendInlineSourceMap(code: string, map: string): string {
  return (
    code +
    "\n//# sourceMappingURL=data:application/json;base64," +
    Buffer.from(map).toString("base64")
  );
}

// Preserve require-condition package resolution when Vite loads runtime imports.
// Analysis still reads the original file, never an optimized or external module.
export const commonJsRuntimePrefix = "\0mincho-commonjs-runtime:";

export function commonJsRuntimeId(file: string, specifier: string): string {
  return commonJsRuntimePrefix + JSON.stringify([file, specifier]);
}

export function commonJsRuntimeRequest(id: string): [string, string] {
  return JSON.parse(id.slice(commonJsRuntimePrefix.length)) as [string, string];
}

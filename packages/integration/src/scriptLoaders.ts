import type { BuildOptions, Loader } from "esbuild";

export type ScriptLoader = "js" | "jsx" | "ts" | "tsx";

const defaultLoaders: Readonly<Record<string, Loader>> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".module.css": "local-css",
  ".css": "css",
  ".json": "json",
  ".txt": "text"
};

/** Native loader overrides use the longest matching extension. */
export function effectiveLoader(
  filename: string,
  loaders: BuildOptions["loader"] = {}
): Loader | undefined {
  const extensions = { ...defaultLoaders, ...loaders };
  const extension = Object.keys(extensions)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => filename.endsWith(candidate));

  return extension ? extensions[extension] : undefined;
}

export function isScriptLoader(
  loader: Loader | undefined
): loader is ScriptLoader {
  return (
    loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx"
  );
}

export function getScriptLoader(
  filename: string,
  loaders?: BuildOptions["loader"]
): ScriptLoader | undefined {
  const loader = effectiveLoader(filename, loaders);

  return isScriptLoader(loader) ? loader : undefined;
}

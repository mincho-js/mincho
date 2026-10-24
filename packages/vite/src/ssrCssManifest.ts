import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizePath } from "@rollup/pluginutils";
import type { ResolvedConfig, Rollup } from "vite";
import type { MinchoCssRoute } from "./appCss.js";
import type { MinchoSsrCssManifest } from "./ssr.js";

type CssOutputChunk = Rollup.OutputChunk & {
  viteMetadata?: { importedCss?: Set<string> };
};

export async function emitSsrCssManifest(
  context: Pick<Rollup.PluginContext, "resolve" | "emitFile" | "getModuleInfo">,
  config: ResolvedConfig,
  bundle: Rollup.OutputBundle,
  fileName: string,
  routes: readonly MinchoCssRoute[] = []
) {
  if (config.experimental.renderBuiltUrl)
    throw new Error(
      "appCss.ssrManifest does not support experimental.renderBuiltUrl."
    );

  const manifest: {
    version: 1;
    base: string;
    entries: Record<string, string[]>;
    modules: Record<string, string[]>;
    routes: Record<string, string[]>;
  } = {
    version: 1,
    base: decodeURI(config.base),
    entries: Object.create(null),
    modules: Object.create(null),
    routes: Object.create(null)
  };

  const chunks = Object.values(bundle).filter(
    (item): item is Rollup.OutputChunk => item.type === "chunk"
  );

  const singleCss = config.build.cssCodeSplit
    ? []
    : Object.values(bundle)
        .filter(
          (item) =>
            item.type === "asset" &&
            (item.fileName.endsWith(".css") ||
              item.names.some((name) => name.endsWith(".css")))
        )
        .map((item) => item.fileName);
  if (singleCss.length > 1)
    throw new Error(
      "appCss.ssrManifest cannot identify a unique unsplit CSS asset."
    );

  function cssFor(chunk: CssOutputChunk): string[] {
    if (!config.build.cssCodeSplit) return singleCss;

    const visited = new Set<string>();
    const css = new Set<string>();

    // Match Vite's lazy preload traversal: static dependencies before own CSS.
    function visit(current: CssOutputChunk) {
      if (visited.has(current.fileName)) return;

      visited.add(current.fileName);

      for (const id of current.imports) {
        const imported = bundle[id];

        if (imported?.type === "chunk") visit(imported);
      }

      for (const file of current.viteMetadata?.importedCss ?? []) {
        if (bundle[file]?.type !== "asset")
          throw new Error(
            `Mincho SSR CSS asset is absent from this output: ${file}`
          );

        css.add(file);
      }
    }

    visit(chunk);

    return [...css];
  }

  const roots = [config.root, await realpath(config.root)];

  function moduleKey(id: string) {
    if (id.includes("\0")) return undefined;
    if (!isAbsolute(id)) return normalizePath(id);

    const paths = roots.map((root) => normalizePath(relative(root, id)));

    return (
      paths.find(
        (path) => !isAbsolute(path) && path !== ".." && !path.startsWith("../")
      ) ?? paths[0]
    );
  }

  for (const chunk of chunks) {
    const css = cssFor(chunk);

    for (const id of Object.keys(chunk.modules)) {
      const key = moduleKey(id);

      if (key !== undefined)
        manifest.modules[key] = [
          ...new Set([...(manifest.modules[key] ?? []), ...css])
        ];
    }

    if (chunk.isEntry) {
      manifest.entries[chunk.fileName] = css;

      if (chunk.facadeModuleId) {
        const key = moduleKey(chunk.facadeModuleId);

        if (key !== undefined) manifest.entries[key] = css;
      }
    }
  }

  for (const route of routes) {
    const css = new Set<string>();
    const importer = resolve(config.root, "index.html");
    const entry =
      (await context.resolve(route.entry, importer))?.id ??
      resolve(config.root, route.entry);

    const reachable = new Set<string>();

    function walk(id: string) {
      if (reachable.has(id)) return;

      reachable.add(id);

      for (const dependency of context.getModuleInfo(id)?.importedIds ?? [])
        walk(dependency);
    }

    walk(entry);

    for (const input of [...(route.layouts ?? []), route.entry]) {
      const resolved = await context.resolve(
        input,
        resolve(config.root, "index.html")
      );

      const id = resolved?.id ?? resolve(config.root, input);

      // Static layout CSS already has the right position in the entry traversal;
      // its CSS-only JS module may have been erased from the final output.
      if (input !== route.entry && reachable.has(id)) continue;

      const key = moduleKey(id);
      if (key === undefined || !Object.hasOwn(manifest.modules, key))
        throw new Error(
          `SSR route ${route.id} refers to a module absent from the client output: ${input}`
        );

      for (const file of manifest.modules[key]!) css.add(file);
    }

    manifest.routes[route.id] = [...css];
  }

  const checked: MinchoSsrCssManifest = manifest;
  context.emitFile({
    type: "asset",
    fileName,
    source: JSON.stringify(checked, null, 2)
  });
  return checked;
}

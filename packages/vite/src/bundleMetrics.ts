import type { Rollup } from "vite";
import {
  internalMeasureBundleBytes,
  type BundleBytes
} from "@mincho-js/integration";
import type { MinchoSsrCssManifest } from "./ssr.js";

type CssChunk = Rollup.OutputChunk & {
  viteMetadata?: { importedCss?: Set<string> };
};

/** Final output assets, compressed independently. Estimates are reported by separate passes. */
export function measureOutputBundle(
  bundle: Rollup.OutputBundle,
  manifest?: MinchoSsrCssManifest,
  cssCodeSplit = true
) {
  const assets = Object.fromEntries(
    Object.values(bundle).map((item) => [
      item.fileName,
      {
        kind:
          item.type === "asset" &&
          (item.fileName.endsWith(".css") ||
            item.names.some((name) => name.endsWith(".css")))
            ? "css"
            : item.fileName.endsWith(".html")
              ? "html"
              : item.type === "chunk"
                ? "js"
                : "metadata",
        ...internalMeasureBundleBytes(
          item.type === "chunk" ? item.code : item.source
        )
      }
    ])
  );
  const sum = (files: Iterable<string>): BundleBytes =>
    [...new Set(files)].reduce(
      (result, file) => {
        const bytes = assets[file];
        if (bytes) {
          result.raw += bytes.raw;
          result.gzip += bytes.gzip;
          result.brotli += bytes.brotli;
        }
        return result;
      },
      { raw: 0, gzip: 0, brotli: 0 }
    );
  const cssFiles = Object.keys(assets).filter(
    (file) => assets[file]!.kind === "css"
  );
  // Unsplit Vite CSS has no importedCss metadata. Infer ownership only when
  // the emitted stylesheet is unique, as required by the SSR manifest.
  const singleCss = !cssCodeSplit && cssFiles.length === 1 ? cssFiles : [];
  const entries = Object.values(bundle)
    .filter((item): item is CssChunk => item.type === "chunk" && item.isEntry)
    .map((entry) => {
      const js = new Set<string>(),
        css = new Set(singleCss);
      const pending = [entry];
      while (pending.length) {
        const chunk = pending.pop()!;
        if (js.has(chunk.fileName)) continue;
        js.add(chunk.fileName);
        for (const file of chunk.imports)
          if (bundle[file]?.type === "chunk")
            pending.push(bundle[file] as CssChunk);
        for (const file of chunk.viteMetadata?.importedCss ?? []) css.add(file);
      }
      const cache = new Set(css);
      const routeVisits = Object.entries(manifest?.routes ?? {}).map(
        ([route, files]) => {
          const cold = sum([...css, ...files]);
          const additional = files.filter((file) => !cache.has(file));
          for (const file of additional) cache.add(file);
          return {
            route,
            coldCss: cold,
            additionalCss: sum(additional),
            additionalAssets: additional.length,
            cumulativeCss: sum(cache)
          };
        }
      );
      return {
        entry: entry.facadeModuleId ?? entry.fileName,
        js: sum(js),
        css: sum(css),
        jsAssets: js.size,
        cssAssets: css.size,
        routeVisits
      };
    });
  const declarations = new Map<string, number>();
  let declarationBytes = 0,
    duplicateDeclarationBytes = 0;
  for (const file of cssFiles) {
    const asset = bundle[file] as Rollup.OutputAsset;
    const source =
      typeof asset.source === "string"
        ? asset.source
        : Buffer.from(asset.source).toString("utf8");
    for (const match of source.matchAll(/\{([^{}]+)\}/g)) {
      const body = match[1]!.trim();
      const bytes = Buffer.byteLength(body);
      declarationBytes += bytes;
      if (declarations.has(body)) duplicateDeclarationBytes += bytes;
      declarations.set(body, (declarations.get(body) ?? 0) + 1);
    }
  }
  return {
    estimate: false,
    compression: { gzip: 9, brotli: 11 },
    assets,
    entries,
    totalCss: sum(cssFiles),
    cssAssets: cssFiles.length,
    html: sum(
      Object.keys(assets).filter((file) => assets[file]!.kind === "html")
    ),
    duplicates: {
      measure: "identical-declaration-text" as const,
      declarationBytes,
      duplicateDeclarationBytes,
      ratio: declarationBytes ? duplicateDeclarationBytes / declarationBytes : 0
    }
  };
}

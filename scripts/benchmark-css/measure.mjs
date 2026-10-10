import assert from "node:assert/strict";
import { posix, relative, resolve } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

export function bytes(source) {
  const data = Buffer.from(source);

  return {
    raw: data.length,
    gzip: gzipSync(data, { level: 9 }).length,
    brotli: brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  };
}

const slash = (path) => path.replaceAll("\\", "/");

export function viteArtifacts(result) {
  const output = (Array.isArray(result) ? result[0] : result).output;
  const files = new Map(
    output.map((item) => [
      item.fileName,
      Buffer.from(item.type === "chunk" ? item.code : item.source)
    ])
  );

  const edges = new Map();
  const entries = new Map();

  for (const item of output) {
    if (item.type !== "chunk") continue;

    const normalize = (id) =>
      files.has(id)
        ? id
        : posix.normalize(posix.join(posix.dirname(item.fileName), id));

    edges.set(item.fileName, [
      ...item.imports.map(normalize),
      ...(item.viteMetadata?.importedCss ?? [])
    ]);

    if (item.isEntry || item.isDynamicEntry)
      entries.set(item.name, item.fileName);
  }

  const asset = output.find((item) => item.fileName.endsWith("/manifest.json"));

  if (asset) {
    const manifest = JSON.parse(String(asset.source));

    for (const [key, entry] of Object.entries(manifest)) {
      entries.set(key, entry.file);
      edges.set(entry.file, [
        ...new Set([
          ...(edges.get(entry.file) ?? []),
          ...(entry.css ?? []),
          ...(entry.imports ?? []).map((id) => manifest[id].file)
        ])
      ]);
    }
  }

  // Unsplit Vite CSS can be linked only from HTML, without per-chunk metadata.
  // Treat HTML as the page root so these real requests are still counted.
  for (const [fileName, source] of files) {
    if (!fileName.endsWith(".html")) continue;

    const entry = entries.get(fileName);
    const styles = [...source.toString().matchAll(/<link\b[^>]*>/g)]
      .map(([tag]) => ({
        rel: tag.match(/\brel=["']([^"']+)["']/)?.[1],
        href: tag.match(/\bhref=["']([^"']+)["']/)?.[1]
      }))
      .filter(({ rel, href }) => rel === "stylesheet" && href)
      .map(({ href }) =>
        new URL(href, `http://fixture/${fileName}`).pathname.slice(1)
      );

    edges.set(fileName, [...(entry ? [entry] : []), ...styles]);
    entries.set(fileName, fileName);
  }

  return { files, edges, entries };
}

export function esbuildArtifacts(result, root, outdir, cssEntries) {
  const name = (path) => slash(relative(outdir, resolve(root, path)));

  const files = new Map(
    result.outputFiles.map((file) => [
      name(file.path),
      Buffer.from(file.contents)
    ])
  );

  const edges = new Map();
  const entries = new Map();

  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    const id = name(path);
    if (!/\.[cm]?js$/.test(id)) continue;

    const source = output.entryPoint?.replace(/^\.\//, "");

    // esbuild emits CSS for dynamic chunks but has no runtime that loads it.
    // The HTML entry's CSS bundle already contains its dynamic descendants.
    const css =
      cssEntries && !cssEntries.includes(source)
        ? []
        : (result.minchoCssManifest?.entries[id]?.css ??
          (output.cssBundle ? [name(output.cssBundle)] : []));

    edges.set(id, [
      ...output.imports
        .filter((item) => !item.external && item.kind !== "dynamic-import")
        .map((item) => name(item.path)),
      ...css
    ]);

    if (source) entries.set(source, id);
  }

  return { files, edges, entries, cssManifest: result.minchoCssManifest };
}

export function closure(artifacts, entry) {
  const visited = new Set();

  const visit = (id) => {
    if (visited.has(id)) return;

    assert(artifacts.files.has(id), `Missing emitted dependency ${id}`);

    visited.add(id);

    for (const child of artifacts.edges.get(id) ?? []) visit(child);
  };

  visit(artifacts.entries.get(entry) ?? entry);

  return visited;
}

export function sizeOf(artifacts, ids) {
  const result = {
    javascript: { files: 0, raw: 0, gzip: 0, brotli: 0 },
    css: { files: 0, raw: 0, gzip: 0, brotli: 0 }
  };

  for (const id of ids) {
    const kind = id.endsWith(".css")
      ? "css"
      : /\.[cm]?js$/.test(id)
        ? "javascript"
        : null;
    if (!kind) continue;

    const measured = bytes(artifacts.files.get(id));
    result[kind].files++;

    for (const field of ["raw", "gzip", "brotli"])
      result[kind][field] += measured[field];
  }

  return result;
}

export function visitReport(artifacts, sequence) {
  const cache = new Set();
  const visits = sequence.map((entry) => {
    const required = closure(artifacts, entry);
    const added = [...required].filter((id) => !cache.has(id));
    const reused = [...required].filter((id) => cache.has(id));

    for (const id of required) cache.add(id);

    return { entry, added, reused, transferred: sizeOf(artifacts, added) };
  });

  const occurrences = new Map();

  for (const id of cache) {
    if (!id.endsWith(".css")) continue;

    for (const marker of new Set(
      [
        ...artifacts.files
          .get(id)
          .toString()
          .matchAll(/--bench-module-([\w-]+)\s*:/g)
      ].map((m) => m[1])
    )) {
      const assets = occurrences.get(marker) ?? [];
      assets.push(id);
      occurrences.set(marker, assets);
    }
  }

  const duplicateModules = [...occurrences]
    .filter(([, assets]) => assets.length > 1)
    .map(([module, assets]) => ({ module, assets }));

  const totalOccurrences = [...occurrences.values()].reduce(
    (sum, assets) => sum + assets.length,
    0
  );

  return {
    visits,
    total: sizeOf(artifacts, cache),
    duplicateModules,
    duplicateModuleOccurrenceRatio: totalOccurrences
      ? (totalOccurrences - occurrences.size) / totalOccurrences
      : 0
  };
}

export function fileReport(artifacts) {
  return [...artifacts.files]
    .filter(([id]) => /\.(css|[cm]?js)$/.test(id))
    .map(([file, source]) => ({ file, ...bytes(source) }));
}

/** Client-build data. Module keys are relative to the Vite project root. */
export interface MinchoSsrCssManifest {
  readonly version: 1;
  readonly base: string;
  readonly entries: Readonly<Record<string, readonly string[]>>;
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly routes: Readonly<Record<string, readonly string[]>>;
}

export interface MinchoSsrCssSelection {
  /** Select this document's HTML/JS entry; other MPA entries stay excluded. */
  entries?: readonly string[];
  routes?: readonly string[];

  /** Extra modules discovered while rendering, including Suspense boundaries. */
  modules?: readonly string[];
}

export interface MinchoSsrCssOptions {
  /** Absolute directory URL of the client output root, required for a relative Vite base. */
  assetBaseUrl?: string;
}

export interface MinchoSsrStylesheet {
  readonly rel: "stylesheet";
  readonly href: string;
  readonly crossOrigin: "";
}

/**
 * Stateless: safe to call during a retried/aborted React render. The selection
 * order is significant; within each selection the client build supplies order.
 */
export function resolveSsrStylesheets(
  manifest: MinchoSsrCssManifest,
  selection: MinchoSsrCssSelection,
  options: MinchoSsrCssOptions = {}
): MinchoSsrStylesheet[] {
  if (manifest.version !== 1)
    throw new Error("Unsupported Mincho SSR CSS manifest version.");

  const relative = manifest.base === "" || manifest.base === "./";
  if (relative && !options.assetBaseUrl)
    throw new Error("A relative Vite base requires an absolute assetBaseUrl.");

  if (relative) {
    const url = new URL(options.assetBaseUrl!);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.pathname.endsWith("/") ||
      url.search ||
      url.hash
    )
      throw new Error(
        "assetBaseUrl must be an absolute HTTP(S) directory URL."
      );
  }

  const hrefs = new Set<string>();
  const result: MinchoSsrStylesheet[] = [];

  for (const kind of ["entries", "routes", "modules"] as const) {
    for (const id of selection[kind] ?? []) {
      if (!Object.hasOwn(manifest[kind], id))
        throw new Error(`Unknown Mincho SSR CSS ${kind} id: ${id}`);

      for (const file of manifest[kind][id]!) {
        const href = relative
          ? new URL(file, options.assetBaseUrl).href
          : `${manifest.base.replace(/\/$/, "")}/${file}`;
        if (hrefs.has(href)) continue;

        hrefs.add(href);
        result.push({ rel: "stylesheet", href, crossOrigin: "" });
      }
    }
  }

  return result;
}

/**
 * One collector per document/request. collect() records discovered resources;
 * flush() acknowledges resources handed to the response writer, not browser
 * load completion. Share an instance only between roots of the same document.
 * Use the stateless resolver inside React render functions instead.
 */
export function createSsrCssCollector(
  manifest: MinchoSsrCssManifest,
  options?: MinchoSsrCssOptions
) {
  const discovered = new Map<string, MinchoSsrStylesheet>();
  const emitted = new Set<string>();

  return {
    collect(selection: MinchoSsrCssSelection): readonly MinchoSsrStylesheet[] {
      // Resolve the entire selection first: an unknown id must not partly
      // mutate request state and suppress assets on a subsequent retry.
      for (const link of resolveSsrStylesheets(manifest, selection, options))
        discovered.set(link.href, link);

      return [...discovered.values()];
    },

    flush(): MinchoSsrStylesheet[] {
      const links = [...discovered.values()].filter(
        (link) => !emitted.has(link.href)
      );

      for (const link of links) emitted.add(link.href);

      return links;
    }
  };
}

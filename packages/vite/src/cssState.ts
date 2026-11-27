import type { BabelTransformResult } from "@mincho-js/integration";

type SidecarParserPlugins = BabelTransformResult["parserPlugins"];

export const extractedSidecarIdPrefix = "\0mincho-extracted-css:";

export function extractedSidecarModuleId(filePath: string): string {
  return `${extractedSidecarIdPrefix}${filePath}.js`;
}

export function customNormalize(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

type CssModuleData =
  | { kind: "owner"; mainFilePath: string }
  | { kind: "sidecar"; mainFilePath: string; path: string }
  | {
      kind: "loaded-sidecar";
      mainFilePath: string;
      path: string;
      filePath: string;
      originalPath: string;
      parserPlugins?: SidecarParserPlugins;
    };

/** The serializer supplies the real emitter, even when the generated name is opaque. */
export interface PublishedStylesheet {
  readonly id: string;
  readonly environment: string;
  readonly hostId: string;
  readonly origin: string | null;
  readonly source: string;
}

type OwnedStylesheet = PublishedStylesheet & { readonly ownerId: string };

/** Generated CSS and its ownership belong to one Vite environment. */
export class ViteCssState {
  readonly resolverCache = new Map<string, string>();
  // Most recent publisher first. Different owners may emit the same physical scope.
  private readonly css = new Map<string, OwnedStylesheet[]>();
  // Empty responses clear CSS already imported by an in-flight HMR update. Keep
  // only recent retired IDs; they must not grow with the lifetime of the server.
  private readonly retiredCss = new Set<string>();
  private readonly sidecars = new Map<
    string,
    { source: string; parserPlugins?: SidecarParserPlugins }
  >();
  private readonly currentSidecars = new Map<string, string>();
  private readonly moduleData = new Map<string, CssModuleData>();
  private readonly ownerToCssPaths = new Map<string, Set<string>>();
  private readonly sidecarOutputs = new Map<
    string,
    { ownerId: string; ids: ReadonlySet<string> }
  >();
  private readonly authorizedVirtualCssIds = new Set<string>();

  constructor(
    private readonly effects: {
      invalidateModule(id: string): void;

      deleteContract(id: string): void;
    }
  ) {}

  getCss(id: string): string | undefined {
    return (
      this.publication(id)?.source ?? (this.retiredCss.has(id) ? "" : undefined)
    );
  }

  publication(id: string): PublishedStylesheet | undefined {
    return this.css.get(id)?.[0];
  }

  hasCss(id: string): boolean {
    return this.css.has(id) || this.retiredCss.has(id);
  }

  private retireCss(id: string): void {
    this.css.delete(id);
    this.retiredCss.delete(id);
    this.retiredCss.add(id);
    if (this.retiredCss.size > 256)
      this.retiredCss.delete(this.retiredCss.values().next().value!);
  }

  hasSidecar(path: string): boolean {
    return this.sidecars.has(path);
  }

  getSidecar(path: string): string | undefined {
    return this.sidecars.get(path)?.source;
  }

  getSidecarParserPlugins(path: string): SidecarParserPlugins {
    return this.sidecars.get(path)?.parserPlugins;
  }

  isCurrentSidecar(ownerId: string, path: string): boolean {
    return this.currentSidecars.get(ownerId) === path;
  }

  getModuleData(id: string): CssModuleData | undefined {
    return this.moduleData.get(id);
  }

  isAuthorizedVirtualCss(id: string): boolean {
    return this.authorizedVirtualCssIds.has(id);
  }

  authorizeVirtualCss(id: string): void {
    this.authorizedVirtualCssIds.add(id);
  }

  sidecarCount(ownerId: string): number {
    return this.ownerToCssPaths.get(ownerId)?.size ?? 0;
  }

  registerSidecar(
    ownerId: string,
    cssPath: string,
    source: string,
    parserPlugins?: SidecarParserPlugins
  ): void {
    this.currentSidecars.set(ownerId, cssPath);

    const cssPaths = this.ownerToCssPaths.get(ownerId) ?? new Set<string>();
    cssPaths.add(cssPath);
    this.ownerToCssPaths.set(ownerId, cssPaths);

    this.sidecars.set(cssPath, { source, parserPlugins });
    this.resolverCache.delete(ownerId);

    this.moduleData.set(ownerId, { kind: "owner", mainFilePath: ownerId });
    this.moduleData.set(customNormalize(cssPath), {
      kind: "sidecar",
      mainFilePath: ownerId,
      path: cssPath
    });
  }

  loadSidecar(id: string, cssPath: string): string | null {
    const data = this.moduleData.get(customNormalize(cssPath));
    if (!data || data.kind === "owner") return null;

    const sidecar = this.sidecars.get(data.path);
    if (!sidecar?.source) return null;

    this.moduleData.set(id, {
      kind: "loaded-sidecar",
      mainFilePath: data.mainFilePath,
      path: data.path,
      filePath: data.path,
      originalPath: data.mainFilePath,
      ...(sidecar.parserPlugins ? { parserPlugins: sidecar.parserPlugins } : {})
    });

    return sidecar.source;
  }

  /** Publish validated output without invalidating CSS merely because a sidecar was renamed. */
  commitVirtualCssForSidecar(
    ownerId: string,
    cssPath: string,
    entries: ReadonlyMap<string, PublishedStylesheet>
  ): { changed: number; unchanged: number; removed: number } {
    const previousIds = new Set<string>();
    const paths = this.ownerToCssPaths.get(ownerId) ?? new Set([cssPath]);

    for (const path of paths)
      for (const id of this.sidecarOutputs.get(path)?.ids ?? [])
        previousIds.add(id);

    let changed = 0;
    let unchanged = 0;
    let removed = 0;
    this.sidecarOutputs.set(cssPath, { ownerId, ids: new Set(entries.keys()) });

    for (const [id, publication] of entries) {
      const publishers = this.css.get(id) ?? [];
      const previous = publishers[0];
      if (
        previous?.ownerId === ownerId &&
        previous.id === publication.id &&
        previous.environment === publication.environment &&
        previous.source === publication.source &&
        previous.origin === publication.origin &&
        previous.hostId === publication.hostId
      )
        unchanged++;
      else {
        this.css.set(id, [
          { ...publication, ownerId },
          ...publishers.filter((record) => record.ownerId !== ownerId)
        ]);
        changed++;
        this.effects.invalidateModule(id);
      }

      this.retiredCss.delete(id);
      this.authorizedVirtualCssIds.add(id);
    }

    for (const path of paths) {
      if (path === cssPath) continue;

      this.sidecarOutputs.delete(path);
      this.sidecars.delete(path);
      this.resolverCache.delete(path);
      this.moduleData.delete(path);
      this.moduleData.delete(customNormalize(path));
      this.moduleData.delete(extractedSidecarModuleId(path));
      this.effects.deleteContract(path);
      this.effects.deleteContract(extractedSidecarModuleId(path));
      this.effects.invalidateModule(path);
      this.effects.invalidateModule(extractedSidecarModuleId(path));
    }

    this.ownerToCssPaths.set(ownerId, new Set([cssPath]));

    for (const id of previousIds) {
      if (entries.has(id)) continue;
      const change = this.withdrawPublication(id, ownerId);
      if (change === "changed") changed++;
      if (change === "removed") removed++;
    }

    return { changed, unchanged, removed };
  }

  private withdrawPublication(
    id: string,
    ownerId: string,
    invalidateModules = true
  ) {
    const publishers = this.css.get(id);
    if (!publishers) return;
    const index = publishers.findIndex((record) => record.ownerId === ownerId);
    if (index < 0) return;
    publishers.splice(index, 1);
    if (index !== 0) return;

    if (publishers[0]) {
      // Restoring an earlier owner's bytes starts a new publication, even
      // when a request still holds that owner's original record.
      publishers[0] = { ...publishers[0] };
    } else {
      this.retireCss(id);
      this.authorizedVirtualCssIds.delete(id);
    }
    if (invalidateModules) this.effects.invalidateModule(id);
    return publishers.length ? "changed" : "removed";
  }

  clearVirtualCssForSidecar(cssPath: string, invalidateModules = true): void {
    const outputs = this.sidecarOutputs.get(cssPath);
    if (!outputs) return;
    for (const id of outputs.ids)
      this.withdrawPublication(id, outputs.ownerId, invalidateModules);
    this.sidecarOutputs.delete(cssPath);
  }

  clearGeneratedCssForOwner(ownerId: string): void {
    this.currentSidecars.delete(ownerId);
    this.effects.deleteContract(ownerId);

    const paths = this.ownerToCssPaths.get(ownerId);
    if (!paths) return;

    for (const cssPath of paths) {
      const moduleId = extractedSidecarModuleId(cssPath);
      this.effects.deleteContract(cssPath);
      this.effects.deleteContract(moduleId);

      this.sidecars.delete(cssPath);
      this.resolverCache.delete(cssPath);
      this.moduleData.delete(cssPath);
      this.moduleData.delete(customNormalize(cssPath));
      this.moduleData.delete(moduleId);

      this.clearVirtualCssForSidecar(cssPath);
      this.effects.invalidateModule(cssPath);
      this.effects.invalidateModule(moduleId);
    }

    this.ownerToCssPaths.delete(ownerId);
  }
}

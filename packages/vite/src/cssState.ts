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
    };

/** Generated CSS and its ownership belong to one Vite environment. */
export class ViteCssState {
  readonly resolverCache = new Map<string, string>();
  private readonly css = new Map<string, string>();
  private readonly sidecars = new Map<string, string>();
  private readonly currentSidecars = new Map<string, string>();
  private readonly moduleData = new Map<string, CssModuleData>();
  private readonly ownerToCssPaths = new Map<string, Set<string>>();
  private readonly cssPathToVirtualCssIds = new Map<string, Set<string>>();
  private readonly authorizedVirtualCssIds = new Set<string>();

  constructor(
    private readonly effects: {
      invalidateModule(id: string): void;

      deleteContract(id: string): void;
    }
  ) {}

  getCss(id: string): string | undefined {
    return this.css.get(id);
  }

  hasCss(id: string): boolean {
    return this.css.has(id);
  }

  hasSidecar(path: string): boolean {
    return this.sidecars.has(path);
  }

  getSidecar(path: string): string | undefined {
    return this.sidecars.get(path);
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

  registerSidecar(ownerId: string, cssPath: string, source: string): void {
    this.currentSidecars.set(ownerId, cssPath);

    const cssPaths = this.ownerToCssPaths.get(ownerId) ?? new Set<string>();
    cssPaths.add(cssPath);
    this.ownerToCssPaths.set(ownerId, cssPaths);

    this.sidecars.set(cssPath, source);
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

    const contents = this.sidecars.get(data.path);
    if (!contents) return null;

    this.moduleData.set(id, {
      kind: "loaded-sidecar",
      mainFilePath: data.mainFilePath,
      path: data.path,
      filePath: data.path,
      originalPath: data.mainFilePath
    });

    return contents;
  }

  setVirtualCssForSidecar(
    cssPath: string,
    virtualCssId: string,
    source: string
  ): void {
    const ids = this.cssPathToVirtualCssIds.get(cssPath) ?? new Set<string>();
    ids.add(virtualCssId);
    this.cssPathToVirtualCssIds.set(cssPath, ids);
    this.authorizedVirtualCssIds.add(virtualCssId);
    this.css.set(virtualCssId, source);
  }

  /** Publish validated output without invalidating CSS merely because a sidecar was renamed. */
  commitVirtualCssForSidecar(
    ownerId: string,
    cssPath: string,
    entries: ReadonlyMap<string, string>
  ): { changed: number; unchanged: number; removed: number } {
    const previousIds = new Set<string>();
    const paths = this.ownerToCssPaths.get(ownerId) ?? new Set([cssPath]);

    for (const path of paths)
      for (const id of this.cssPathToVirtualCssIds.get(path) ?? [])
        previousIds.add(id);

    let changed = 0;
    let unchanged = 0;
    let removed = 0;
    this.cssPathToVirtualCssIds.set(cssPath, new Set(entries.keys()));

    for (const [id, source] of entries) {
      if (this.css.get(id) === source) unchanged++;
      else {
        changed++;
        this.effects.invalidateModule(id);
      }

      this.css.set(id, source);
      this.authorizedVirtualCssIds.add(id);
    }

    for (const path of paths) {
      if (path === cssPath) continue;

      this.cssPathToVirtualCssIds.delete(path);
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
      if (
        entries.has(id) ||
        [...this.cssPathToVirtualCssIds.values()].some((ids) => ids.has(id))
      )
        continue;

      removed++;
      this.css.set(id, "");
      this.authorizedVirtualCssIds.delete(id);
      this.effects.invalidateModule(id);
    }

    return { changed, unchanged, removed };
  }

  clearVirtualCssForSidecar(cssPath: string, invalidateModules = true): void {
    const ids = this.cssPathToVirtualCssIds.get(cssPath);
    if (!ids) return;

    for (const id of ids) {
      if (
        [...this.cssPathToVirtualCssIds].some(
          ([path, otherIds]) => path !== cssPath && otherIds.has(id)
        )
      )
        continue;

      this.css.set(id, "");
      this.authorizedVirtualCssIds.delete(id);

      if (invalidateModules) this.effects.invalidateModule(id);
    }

    this.cssPathToVirtualCssIds.delete(cssPath);
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

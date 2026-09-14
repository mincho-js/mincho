import type {
  StaticCssEvalLoadedSource,
  StaticCssEvalResolvedDependency
} from "./babel.js";
import {
  createStaticCssEvalPrepassImportResolution,
  createStaticCssEvalResolvedDependency,
  type ImportedStaticCssEvalImportResolution,
  type NormalizedStaticCssEvalSourceResolution
} from "./staticCssEvalPrepassSource.js";

/** Keep Babel and bundler views of each dependency in the same transition. */
export class StaticCssEvalPrepassDependencies {
  private readonly records = new Map<
    string,
    {
      importResolution: ImportedStaticCssEvalImportResolution;
      dependency: StaticCssEvalResolvedDependency;
    }
  >();

  update(
    importerId: string,
    specifier: string,
    resolution: NormalizedStaticCssEvalSourceResolution,
    loadedSource?: StaticCssEvalLoadedSource
  ): void {
    const key = JSON.stringify([
      importerId,
      specifier,
      resolution.resolvedFile
    ]);

    this.records.set(key, {
      importResolution: createStaticCssEvalPrepassImportResolution(
        importerId,
        specifier,
        resolution,
        loadedSource
      ),
      dependency: createStaticCssEvalResolvedDependency(
        importerId,
        specifier,
        resolution,
        loadedSource !== undefined,
        loadedSource
      )
    });
  }

  get importResolutions(): ImportedStaticCssEvalImportResolution[] {
    return [...this.records.values()].map(
      ({ importResolution }) => importResolution
    );
  }

  get resolvedDependencies(): StaticCssEvalResolvedDependency[] {
    return [...this.records.values()].map(({ dependency }) => dependency);
  }
}

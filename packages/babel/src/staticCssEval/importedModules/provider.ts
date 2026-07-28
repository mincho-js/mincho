import { createStaticCssModuleCache } from "../moduleCache.js";
import type { StaticCssEvalProvider } from "../types.js";
import type {
  CreateImportedStaticCssEvalProviderOptions,
  ImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord
} from "./contracts.js";
import { createImportedStaticCssEvalModuleRecordWithCache } from "./moduleSource.js";
import { ImportedStaticCssEvalResolver } from "./resolver.js";

export function createImportedStaticCssEvalProvider(
  options: CreateImportedStaticCssEvalProviderOptions
): StaticCssEvalProvider {
  const resolver = new ImportedStaticCssEvalResolver(options);

  return {
    getResolvedCssValue(query) {
      return resolver.resolve(query);
    }
  };
}

export function createImportedStaticCssEvalModuleRecord(
  loadedModule: ImportedStaticCssEvalLoadedModule
): ImportedStaticCssEvalModuleRecord {
  return createImportedStaticCssEvalModuleRecordWithCache(
    loadedModule,
    createStaticCssModuleCache()
  );
}

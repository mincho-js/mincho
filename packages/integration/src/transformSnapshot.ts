import {
  internalCreateImportedStaticCssEvalModuleRecord as createRecord,
  type InternalImportedStaticCssEvalModuleRecord
} from "@mincho-js/babel";
import type { BabelTransformResult } from "./babel.js";
import type { CompilationCache } from "./compilationCache.js";

type ModuleSnapshot = Omit<
  InternalImportedStaticCssEvalModuleRecord,
  "programPath" | "parsedModule" | "imports" | "cjsImports" | "exports"
>;

export interface TransformSnapshot {
  result: BabelTransformResult;
  modules: readonly (readonly [string, ModuleSnapshot])[];
}

export function snapshotTransform(
  result: BabelTransformResult
): TransformSnapshot {
  const modules = [...(result.staticCssEval?.resolvedModuleCache ?? [])].map(
    ([id, record]) => {
      const {
        programPath: _path,
        parsedModule: _parsed,
        imports: _imports,
        cjsImports: _cjs,
        exports: _exports,
        ...source
      } = record;

      return [id, source] as const;
    }
  );

  return {
    result: {
      ...result,
      ...(result.staticCssEval
        ? {
            staticCssEval: {
              ...result.staticCssEval,
              resolvedModuleCache: new Map()
            }
          }
        : {})
    },
    modules
  };
}

export function restoreTransform(
  snapshot: TransformSnapshot,
  cache?: CompilationCache
): BabelTransformResult {
  const result = structuredClone(snapshot.result);

  if (result.staticCssEval)
    result.staticCssEval.resolvedModuleCache = new Map(
      snapshot.modules.map(([id, source]) => {
        let record: ReturnType<typeof createRecord> | undefined;
        const lazy = { ...structuredClone(source) };

        for (const key of [
          "programPath",
          "parsedModule",
          "imports",
          "cjsImports",
          "exports"
        ] as const)
          Object.defineProperty(lazy, key, {
            enumerable: true,

            get: () => (record ??= createRecord(source, cache?.parser))[key]
          });

        return [id, lazy as ReturnType<typeof createRecord>];
      })
    );

  return result;
}

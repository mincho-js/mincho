import {
  STATIC_CSS_EVAL_LIMITS,
  type StaticCssEvalUnsupportedReason
} from "./types.js";
import {
  createStaticCssEvalDiagnostic,
  getStaticCssEvalDiagnosticDependencies,
  type StaticCssEvalDiagnosticContext,
  type StaticCssEvalGuardResult
} from "./diagnostics.js";

export type StaticCssEvalLimitName = keyof typeof STATIC_CSS_EVAL_LIMITS;

export interface StaticCssEvalLimitCheckOptions extends StaticCssEvalDiagnosticContext {
  actual: number;
  limitName: StaticCssEvalLimitName;
}

const staticCssEvalLimitLabels = {
  maxImportDepth: "max import depth",
  maxEvaluatedModulesPerOwner: "max evaluated modules per owner",
  maxLoadedDependencySourceBytes: "max loaded dependency source size",
  maxObjectArrayRecursionDepth: "max object/array recursion depth",
  maxStaticLiteralNodeCount: "max static literal node count"
} as const satisfies Record<StaticCssEvalLimitName, string>;

const staticCssEvalLimitUnits = {
  maxImportDepth: "levels",
  maxEvaluatedModulesPerOwner: "modules",
  maxLoadedDependencySourceBytes: "bytes",
  maxObjectArrayRecursionDepth: "levels",
  maxStaticLiteralNodeCount: "nodes"
} as const satisfies Record<StaticCssEvalLimitName, string>;

const staticCssEvalLimitReasons = {
  maxImportDepth: "failed-project-local-dependency",
  maxEvaluatedModulesPerOwner: "failed-project-local-dependency",
  maxLoadedDependencySourceBytes: "failed-project-local-dependency",
  maxObjectArrayRecursionDepth: "unsupported-literal",
  maxStaticLiteralNodeCount: "unsupported-literal"
} as const satisfies Record<
  StaticCssEvalLimitName,
  StaticCssEvalUnsupportedReason
>;

export function enforceStaticCssEvalLimit(
  options: StaticCssEvalLimitCheckOptions
): StaticCssEvalGuardResult {
  const limit = STATIC_CSS_EVAL_LIMITS[options.limitName];

  if (options.actual <= limit) {
    return { ok: true };
  }

  const unit = staticCssEvalLimitUnits[options.limitName];
  const diagnostic = createStaticCssEvalDiagnostic({
    code: "limit-exceeded",
    reason: staticCssEvalLimitReasons[options.limitName],
    detail: `${staticCssEvalLimitLabels[options.limitName]} exceeded (${options.actual} ${unit} > ${limit} ${unit})`,
    owner: options.owner,
    dependency: options.dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: options.importChain
  });

  return {
    ok: false,
    diagnostic,
    dependencies: getStaticCssEvalDiagnosticDependencies(diagnostic)
  };
}

export function enforceStaticCssEvalImportDepth(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    importDepth: number;
  }
): StaticCssEvalGuardResult {
  const { importDepth, ...context } = options;

  return enforceStaticCssEvalLimit({
    ...context,
    actual: importDepth,
    limitName: "maxImportDepth"
  });
}

export function enforceStaticCssEvalModuleCount(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    evaluatedModuleCount: number;
  }
): StaticCssEvalGuardResult {
  const { evaluatedModuleCount, ...context } = options;

  return enforceStaticCssEvalLimit({
    ...context,
    actual: evaluatedModuleCount,
    limitName: "maxEvaluatedModulesPerOwner"
  });
}

export function enforceStaticCssEvalSourceSize(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    source: string;
  }
): StaticCssEvalGuardResult {
  const { source, ...context } = options;

  return enforceStaticCssEvalSourceByteLength({
    ...context,
    byteLength: getStaticCssEvalSourceByteLength(source)
  });
}

export function enforceStaticCssEvalSourceByteLength(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    byteLength: number;
  }
): StaticCssEvalGuardResult {
  const { byteLength, ...context } = options;

  return enforceStaticCssEvalLimit({
    ...context,
    actual: byteLength,
    limitName: "maxLoadedDependencySourceBytes"
  });
}

export function enforceStaticCssEvalObjectArrayRecursionDepth(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    recursionDepth: number;
  }
): StaticCssEvalGuardResult {
  const { recursionDepth, ...context } = options;

  return enforceStaticCssEvalLimit({
    ...context,
    actual: recursionDepth,
    limitName: "maxObjectArrayRecursionDepth"
  });
}

export function enforceStaticCssEvalLiteralNodeCount(
  options: Omit<StaticCssEvalLimitCheckOptions, "actual" | "limitName"> & {
    literalNodeCount: number;
  }
): StaticCssEvalGuardResult {
  const { literalNodeCount, ...context } = options;

  return enforceStaticCssEvalLimit({
    ...context,
    actual: literalNodeCount,
    limitName: "maxStaticLiteralNodeCount"
  });
}

export function getStaticCssEvalSourceByteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const owner = { file: "/project/src/App.tsx", start: 42, end: 55 };
  const dependency = { file: "/project/src/styles.ts" };

  describe("static css eval limits", () => {
    it("rejects loaded dependency source over the shared 1 MB limit", () => {
      expect(
        enforceStaticCssEvalSourceSize({
          owner,
          dependency,
          source: "a".repeat(
            STATIC_CSS_EVAL_LIMITS.maxLoadedDependencySourceBytes
          )
        })
      ).toEqual({ ok: true });

      const result = enforceStaticCssEvalSourceSize({
        owner,
        dependency,
        importPath: "./styles",
        exportName: "button",
        memberPath: ["root"],
        source: "a".repeat(
          STATIC_CSS_EVAL_LIMITS.maxLoadedDependencySourceBytes + 1
        )
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic).toMatchObject({
          code: "limit-exceeded",
          reason: "failed-project-local-dependency",
          owner,
          dependency,
          importPath: "./styles",
          exportName: "button",
          memberPath: ["root"]
        });
        expect(result.diagnostic.message).toBe(
          "Cannot statically evaluate css prop value: max loaded dependency source size exceeded (1048577 bytes > 1048576 bytes)"
        );
        expect(result.dependencies).toEqual(["/project/src/styles.ts"]);
      }
    });

    it("enforces import depth and module count from shared constants", () => {
      expect(
        enforceStaticCssEvalImportDepth({
          owner,
          dependency,
          importDepth: STATIC_CSS_EVAL_LIMITS.maxImportDepth
        })
      ).toEqual({ ok: true });
      expect(
        enforceStaticCssEvalImportDepth({
          owner,
          dependency,
          importDepth: STATIC_CSS_EVAL_LIMITS.maxImportDepth + 1
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          code: "limit-exceeded",
          reason: "failed-project-local-dependency",
          message:
            "Cannot statically evaluate css prop value: max import depth exceeded (11 levels > 10 levels)"
        }
      });
      expect(
        enforceStaticCssEvalModuleCount({
          owner,
          dependency,
          evaluatedModuleCount:
            STATIC_CSS_EVAL_LIMITS.maxEvaluatedModulesPerOwner + 1
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          message:
            "Cannot statically evaluate css prop value: max evaluated modules per owner exceeded (101 modules > 100 modules)"
        }
      });
    });

    it("enforces recursion depth and literal node count from shared constants", () => {
      expect(
        enforceStaticCssEvalObjectArrayRecursionDepth({
          owner,
          dependency,
          recursionDepth:
            STATIC_CSS_EVAL_LIMITS.maxObjectArrayRecursionDepth + 1
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          code: "limit-exceeded",
          reason: "unsupported-literal",
          message:
            "Cannot statically evaluate css prop value: max object/array recursion depth exceeded (51 levels > 50 levels)"
        }
      });
      expect(
        enforceStaticCssEvalLiteralNodeCount({
          owner,
          dependency,
          literalNodeCount: STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount + 1
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          code: "limit-exceeded",
          reason: "unsupported-literal",
          message:
            "Cannot statically evaluate css prop value: max static literal node count exceeded (10001 nodes > 10000 nodes)"
        }
      });
    });
  });
}

import type {
  StaticCssEvalDiagnostic,
  StaticCssEvalDiagnosticCode,
  StaticCssEvalExportName,
  StaticCssEvalSourceLocation,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export const STATIC_CSS_EVAL_DIAGNOSTIC_MESSAGE_PREFIX =
  "Cannot statically evaluate css prop value";

export interface StaticCssEvalDiagnosticContext {
  owner: StaticCssEvalSourceLocation;
  dependency?: StaticCssEvalSourceLocation;
  importPath?: string;
  exportName?: StaticCssEvalExportName;
  memberPath?: readonly string[];
  importChain?: readonly string[];
}

export interface CreateStaticCssEvalDiagnosticOptions extends StaticCssEvalDiagnosticContext {
  code: StaticCssEvalDiagnosticCode;
  reason: StaticCssEvalUnsupportedReason;
  detail: string;
}

export type StaticCssEvalGuardResult =
  | { ok: true }
  | {
      ok: false;
      diagnostic: StaticCssEvalDiagnostic;
      dependencies: string[];
    };

export function createStaticCssEvalDiagnostic(
  options: CreateStaticCssEvalDiagnosticOptions
): StaticCssEvalDiagnostic {
  const diagnostic: StaticCssEvalDiagnostic = {
    code: options.code,
    message: formatStaticCssEvalDiagnosticMessage(options.detail),
    reason: options.reason,
    owner: cloneSourceLocation(options.owner)
  };

  if (options.dependency) {
    diagnostic.dependency = cloneSourceLocation(options.dependency);
  }

  if (options.importPath !== undefined) {
    diagnostic.importPath = options.importPath;
  }

  if (options.exportName !== undefined) {
    diagnostic.exportName = options.exportName;
  }

  if (options.memberPath) {
    diagnostic.memberPath = [...options.memberPath];
  }

  if (options.importChain) {
    diagnostic.importChain = [...options.importChain];
  }

  return diagnostic;
}

export function formatStaticCssEvalDiagnosticMessage(detail: string): string {
  return `${STATIC_CSS_EVAL_DIAGNOSTIC_MESSAGE_PREFIX}: ${detail}`;
}

export function getStaticCssEvalDiagnosticDependencies(
  diagnostic: StaticCssEvalDiagnostic
): string[] {
  const dependencies = new Set<string>();

  if (diagnostic.dependency) {
    dependencies.add(diagnostic.dependency.file);
  }

  return [...dependencies];
}

function cloneSourceLocation(
  location: StaticCssEvalSourceLocation
): StaticCssEvalSourceLocation {
  return { ...location };
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("static css eval diagnostics", () => {
    it("creates deterministic css prop diagnostics with cloned metadata", () => {
      const owner = { file: "/project/src/App.tsx", start: 10, end: 20 };
      const diagnostic = createStaticCssEvalDiagnostic({
        code: "unsupported-source",
        reason: "not-project-local",
        detail: "dependency is outside the project root",
        owner,
        dependency: { file: "/outside/style.ts" },
        importPath: "pkg/style",
        exportName: "button",
        memberPath: ["root"],
        importChain: ["/project/src/App.tsx", "/outside/style.ts#button.root"]
      });

      owner.file = "/mutated.tsx";

      expect(diagnostic).toEqual({
        code: "unsupported-source",
        message:
          "Cannot statically evaluate css prop value: dependency is outside the project root",
        reason: "not-project-local",
        owner: { file: "/project/src/App.tsx", start: 10, end: 20 },
        dependency: { file: "/outside/style.ts" },
        importPath: "pkg/style",
        exportName: "button",
        memberPath: ["root"],
        importChain: ["/project/src/App.tsx", "/outside/style.ts#button.root"]
      });
      expect(getStaticCssEvalDiagnosticDependencies(diagnostic)).toEqual([
        "/outside/style.ts"
      ]);
    });
  });
}

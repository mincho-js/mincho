export interface StaticCssEvalProvider {
  getResolvedCssValue(query: StaticCssEvalQuery): StaticCssEvalResult;
}

export interface StaticCssEvalQuery {
  importerId: string;
  expressionStart: number;
  expressionEnd: number;
  bindingName?: string;
  memberPath?: string[];
}

export type StaticCssEvalResult =
  | { kind: "not-candidate" }
  | {
      kind: "resolved";
      value: StaticCssLiteral;
      dependencies: string[];
    }
  | {
      kind: "error";
      diagnostic: StaticCssEvalDiagnostic;
      dependencies: string[];
    };

export type StaticCssLiteral =
  | string
  | number
  | boolean
  | null
  | StaticCssLiteral[]
  | { [key: string]: StaticCssLiteral };

export type StaticCssEvalExportName = "default" | string | null;

export interface StaticCssEvalSourceLocation {
  file: string;
  line?: number;
  column?: number;
  start?: number;
  end?: number;
}

export const STATIC_CSS_EVAL_DIAGNOSTIC_CODES = [
  "unsupported-syntax",
  "unsupported-source",
  "mutation-detected",
  "cycle-detected",
  "limit-exceeded",
  "failed-project-local-dependency"
] as const;

export type StaticCssEvalDiagnosticCode =
  (typeof STATIC_CSS_EVAL_DIAGNOSTIC_CODES)[number];

export const STATIC_CSS_EVAL_UNSUPPORTED_REASONS = [
  "let-or-var-binding",
  "mutated-binding",
  "namespace-import",
  "reexport-or-barrel",
  "commonjs-require",
  "node-modules-import",
  "virtual-module",
  "function-or-call",
  "runtime-dynamic-value",
  "computed-object-key",
  "object-or-array-spread",
  "conditional-or-logical-expression",
  "binary-expression",
  "template-expression",
  "identifier-object-value",
  "member-expression-object-value",
  "dynamic-member-path",
  "numeric-member-path",
  "optional-member-path",
  "unsupported-literal",
  "not-project-local",
  "failed-project-local-dependency"
] as const;

export type StaticCssEvalUnsupportedReason =
  (typeof STATIC_CSS_EVAL_UNSUPPORTED_REASONS)[number];

export interface StaticCssEvalDiagnostic {
  code: StaticCssEvalDiagnosticCode;
  message: string;
  reason: StaticCssEvalUnsupportedReason;
  owner: StaticCssEvalSourceLocation;
  dependency?: StaticCssEvalSourceLocation;
  importPath?: string;
  exportName?: StaticCssEvalExportName;
  memberPath?: string[];
  importChain?: string[];
}

export type StaticCssEvalDependencyKind = "owner" | "project-local-import";

export interface StaticCssEvalDependencyMetadata {
  kind: StaticCssEvalDependencyKind;
  id: string;
  realpath: string;
  importerId?: string;
  importPath?: string;
  sourceHash?: string;
  version?: string | number;
  projectLocal: boolean;
  insideNodeModules: boolean;
  virtual: boolean;
}

export interface StaticCssEvalModuleRecord {
  id: string;
  realpath: string;
  sourceHash: string;
  version?: string | number;
  dependencies: StaticCssEvalDependencyMetadata[];
}

export interface StaticCssEvalDependencyMaps {
  ownerToDependencies: ReadonlyMap<string, string[]>;
  dependencyToOwners: ReadonlyMap<string, string[]>;
  resolvedModuleCache: ReadonlyMap<string, StaticCssEvalModuleRecord>;
}

export interface StaticCssEvalProjectLocalBoundaryState {
  rootRealpath: string;
  resolvedRealpath: string;
  insideRoot: boolean;
  insideNodeModules: boolean;
  virtual: boolean;
  packageExportOutsideRoot: boolean;
}

export interface StaticCssEvalParserOptionsKey {
  plugins: string[];
  sourceType: "module" | "script" | "unambiguous";
  jsx: boolean;
  typescript: boolean;
}

export interface StaticCssEvalCacheKey {
  resolvedId: string;
  sourceHash: string;
  sourceVersion?: string | number;
  parserOptions: StaticCssEvalParserOptionsKey;
  exportName: StaticCssEvalExportName;
  memberPath: string[];
  projectLocalBoundary: StaticCssEvalProjectLocalBoundaryState;
}

export const STATIC_CSS_EVAL_LIMITS = {
  maxImportDepth: 10,
  maxEvaluatedModulesPerOwner: 100,
  maxLoadedDependencySourceBytes: 1024 * 1024,
  maxObjectArrayRecursionDepth: 50,
  maxStaticLiteralNodeCount: 10_000
} as const;

export const STATIC_CSS_EVAL_CYCLE_KEY_FIELDS = [
  "resolvedId",
  "exportName",
  "memberPath"
] as const satisfies readonly (keyof StaticCssEvalCacheKey)[];

export const STATIC_CSS_EVAL_GUARDRAILS = [
  "project-local-files-only",
  "no-module-execution",
  "no-node-vm-eval-dynamic-import",
  "no-bundler-runtime-evaluation",
  "no-reexports-or-barrels-v1",
  "no-namespace-imports-v1",
  "no-node-modules-or-virtual-modules-v1",
  "async-prepass-sync-babel-boundary"
] as const;

export type StaticCssEvalSupportStatus =
  | "preserved"
  | "supported"
  | "unsupported";

export interface StaticCssEvalSupportMatrixEntry {
  construct: string;
  behavior: string;
  status: StaticCssEvalSupportStatus;
}

export const STATIC_CSS_EVAL_SUPPORT_MATRIX = [
  {
    construct: "Direct object/array in `css={...}`",
    behavior: "Existing behavior preserved",
    status: "preserved"
  },
  {
    construct: "Same-file top-level `const` object/array",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "Same-file lexical `const` inside component/function",
    behavior: "Supported if Babel scope resolves it and no reassignment exists",
    status: "supported"
  },
  {
    construct: "`let` / `var`",
    behavior: "Unsupported as static css-rule candidates",
    status: "unsupported"
  },
  {
    construct: "`const style = {...}; style.color = ...`",
    behavior:
      "Unsupported; deterministic mutation diagnostic in css-rule candidate mode",
    status: "unsupported"
  },
  {
    construct: "`const styles = []; styles.push(...)`",
    behavior:
      "Unsupported; deterministic mutation diagnostic in css-rule candidate mode",
    status: "unsupported"
  },
  {
    construct: "Shadowed bindings",
    behavior: "Must respect Babel scope; local binding wins",
    status: "supported"
  },
  {
    construct: '`import { x } from "./style"`',
    behavior: "Supported for project-local ESM source",
    status: "supported"
  },
  {
    construct: '`import { x as y } from "./style"`',
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: '`import x from "./style"`',
    behavior: "Supported when default export resolves to supported literal",
    status: "supported"
  },
  {
    construct: "`export const x = {...}`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`const x = {...}; export { x }`",
    behavior: "Supported within same module only",
    status: "supported"
  },
  {
    construct: "`export { x as y }` in same module",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`export default {...}`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: "`const x = {...}; export default x`",
    behavior: "Supported",
    status: "supported"
  },
  {
    construct: 'Reexports / barrels (`export { x } from "./x"`, `export *`)',
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Namespace imports (`import * as styles`)",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "CommonJS / `require()`",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "`node_modules` imports",
    behavior: "Unsupported; preserve class-value or error per candidate policy",
    status: "unsupported"
  },
  {
    construct: "Virtual modules",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Calls / mixins / functions",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Runtime dynamic values",
    behavior: "Unsupported in css-rule contexts",
    status: "unsupported"
  },
  {
    construct: "Template literal without expressions",
    behavior: "Supported as string literal",
    status: "supported"
  },
  {
    construct: "Template literal with expressions",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "TS `as const` / `satisfies` wrappers",
    behavior:
      "Supported as transparent wrappers when already accepted by current unwrapping rules",
    status: "supported"
  },
  {
    construct: "Computed object keys",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Object spread / array spread",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "Conditional/logical expressions as static values",
    behavior:
      "Unsupported for imported/static evaluation; existing direct css prop branch semantics remain separate",
    status: "unsupported"
  },
  {
    construct: "Binary expressions / string concatenation",
    behavior: "Unsupported",
    status: "unsupported"
  },
  {
    construct: "BigInt / RegExp / Date / Symbol / `NaN` / `Infinity`",
    behavior: "Unsupported",
    status: "unsupported"
  }
] as const satisfies readonly StaticCssEvalSupportMatrixEntry[];

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("static css evaluator contracts", () => {
    it("encodes v1 static evaluator limits and guardrails", () => {
      expect(STATIC_CSS_EVAL_LIMITS).toEqual({
        maxImportDepth: 10,
        maxEvaluatedModulesPerOwner: 100,
        maxLoadedDependencySourceBytes: 1024 * 1024,
        maxObjectArrayRecursionDepth: 50,
        maxStaticLiteralNodeCount: 10_000
      });
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain("no-module-execution");
      expect(STATIC_CSS_EVAL_GUARDRAILS).toContain(
        "async-prepass-sync-babel-boundary"
      );
    });

    it("keeps the v1 support matrix testable", () => {
      expect(
        STATIC_CSS_EVAL_SUPPORT_MATRIX.find(
          ({ construct }) =>
            construct === "Namespace imports (`import * as styles`)"
        )?.status
      ).toBe("unsupported");
      expect(
        STATIC_CSS_EVAL_SUPPORT_MATRIX.find(
          ({ construct }) => construct === '`import x from "./style"`'
        )?.status
      ).toBe("supported");
      expect(STATIC_CSS_EVAL_SUPPORT_MATRIX).toHaveLength(30);
    });

    it("accepts synchronous provider and cache key contracts", () => {
      const provider: StaticCssEvalProvider = {
        getResolvedCssValue(query) {
          expect(query).toMatchObject({
            importerId: "/project/src/App.tsx",
            bindingName: "styles",
            memberPath: ["button"]
          });

          return {
            kind: "resolved",
            value: { color: "red" },
            dependencies: ["/project/src/styles.ts"]
          };
        }
      };
      const cacheKey: StaticCssEvalCacheKey = {
        resolvedId: "/project/src/styles.ts",
        sourceHash: "sha256:source",
        parserOptions: {
          plugins: ["jsx", "typescript"],
          sourceType: "module",
          jsx: true,
          typescript: true
        },
        exportName: "default",
        memberPath: ["button"],
        projectLocalBoundary: {
          rootRealpath: "/project",
          resolvedRealpath: "/project/src/styles.ts",
          insideRoot: true,
          insideNodeModules: false,
          virtual: false,
          packageExportOutsideRoot: false
        }
      };

      expect(cacheKey.projectLocalBoundary.insideRoot).toBe(true);
      expect(
        provider.getResolvedCssValue({
          importerId: "/project/src/App.tsx",
          expressionStart: 42,
          expressionEnd: 55,
          bindingName: "styles",
          memberPath: ["button"]
        })
      ).toEqual({
        kind: "resolved",
        value: { color: "red" },
        dependencies: ["/project/src/styles.ts"]
      });
    });
  });
}

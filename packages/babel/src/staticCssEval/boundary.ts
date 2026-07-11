import {
  createStaticCssEvalDiagnostic,
  type StaticCssEvalDiagnosticContext
} from "./diagnostics.js";
import type {
  StaticCssEvalDependencyKind,
  StaticCssEvalDependencyMetadata,
  StaticCssEvalProjectLocalBoundaryState,
  StaticCssEvalUnsupportedReason
} from "./types.js";

export interface StaticCssEvalProjectLocalBoundaryDescriptor {
  rootRealpath: string;
  resolvedId: string;
  resolvedRealpath: string;
  virtual?: boolean;
  packageExportRealpath?: string | null;
}

export interface StaticCssEvalProjectLocalBoundaryCheckOptions
  extends
    StaticCssEvalProjectLocalBoundaryDescriptor,
    StaticCssEvalDiagnosticContext {}

export type StaticCssEvalProjectLocalBoundaryResult =
  | {
      ok: true;
      boundary: StaticCssEvalProjectLocalBoundaryState;
      dependencies: string[];
    }
  | {
      ok: false;
      boundary: StaticCssEvalProjectLocalBoundaryState;
      diagnostic: ReturnType<typeof createStaticCssEvalDiagnostic>;
      dependencies: string[];
    };

export interface CreateStaticCssEvalDependencyMetadataOptions extends StaticCssEvalProjectLocalBoundaryDescriptor {
  kind: StaticCssEvalDependencyKind;
  id?: string;
  importerId?: string;
  importPath?: string;
  sourceHash?: string;
  version?: string | number;
}

export function createStaticCssEvalProjectLocalBoundaryState(
  descriptor: StaticCssEvalProjectLocalBoundaryDescriptor
): StaticCssEvalProjectLocalBoundaryState {
  const virtual = isStaticCssEvalVirtualId(
    descriptor.resolvedId,
    descriptor.virtual
  );
  const packageExportOutsideRoot =
    descriptor.packageExportRealpath != null &&
    !isStaticCssEvalPathInsideRoot(
      descriptor.rootRealpath,
      descriptor.packageExportRealpath
    );

  return {
    rootRealpath: descriptor.rootRealpath,
    resolvedRealpath: descriptor.resolvedRealpath,
    insideRoot: isStaticCssEvalPathInsideRoot(
      descriptor.rootRealpath,
      descriptor.resolvedRealpath
    ),
    insideNodeModules: hasStaticCssEvalNodeModulesSegment(
      descriptor.resolvedRealpath
    ),
    virtual,
    packageExportOutsideRoot
  };
}

export function enforceStaticCssEvalProjectLocalBoundary(
  options: StaticCssEvalProjectLocalBoundaryCheckOptions
): StaticCssEvalProjectLocalBoundaryResult {
  const boundary = createStaticCssEvalProjectLocalBoundaryState(options);
  const dependencies = boundary.virtual ? [] : [options.resolvedRealpath];

  if (isStaticCssEvalProjectLocalBoundaryAllowed(boundary)) {
    return { ok: true, boundary, dependencies };
  }

  const dependency =
    options.dependency ??
    (boundary.virtual ? undefined : { file: options.resolvedRealpath });
  const diagnostic = createStaticCssEvalDiagnostic({
    code: "failed-project-local-dependency",
    reason: getStaticCssEvalProjectLocalBoundaryReason(boundary),
    detail: createStaticCssEvalProjectLocalBoundaryDetail(options, boundary),
    owner: options.owner,
    dependency,
    importPath: options.importPath,
    exportName: options.exportName,
    memberPath: options.memberPath,
    importChain: options.importChain
  });

  return { ok: false, boundary, diagnostic, dependencies };
}

export function isStaticCssEvalProjectLocalBoundaryAllowed(
  boundary: StaticCssEvalProjectLocalBoundaryState
): boolean {
  return (
    boundary.insideRoot &&
    !boundary.insideNodeModules &&
    !boundary.virtual &&
    !boundary.packageExportOutsideRoot
  );
}

export function createStaticCssEvalDependencyMetadata(
  options: CreateStaticCssEvalDependencyMetadataOptions
): StaticCssEvalDependencyMetadata {
  const boundary = createStaticCssEvalProjectLocalBoundaryState(options);

  return {
    kind: options.kind,
    id: options.id ?? options.resolvedId,
    realpath: options.resolvedRealpath,
    ...(options.importerId !== undefined
      ? { importerId: options.importerId }
      : {}),
    ...(options.importPath !== undefined
      ? { importPath: options.importPath }
      : {}),
    ...(options.sourceHash !== undefined
      ? { sourceHash: options.sourceHash }
      : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    projectLocal: isStaticCssEvalProjectLocalBoundaryAllowed(boundary),
    insideNodeModules: boundary.insideNodeModules,
    virtual: boundary.virtual
  };
}

export function isStaticCssEvalVirtualId(
  resolvedId: string,
  virtual?: boolean
): boolean {
  return (
    virtual === true ||
    resolvedId.startsWith("\0") ||
    resolvedId.includes("\0") ||
    resolvedId.startsWith("virtual:") ||
    resolvedId.includes("__x00__")
  );
}

export function isStaticCssEvalPathInsideRoot(
  rootRealpath: string,
  resolvedRealpath: string
): boolean {
  if (rootRealpath.length === 0 || resolvedRealpath.length === 0) {
    return false;
  }

  const normalizedRoot = trimStaticCssEvalTrailingSlash(
    normalizeStaticCssEvalPath(rootRealpath)
  );
  const normalizedResolved = trimStaticCssEvalTrailingSlash(
    normalizeStaticCssEvalPath(resolvedRealpath)
  );

  return (
    normalizedResolved === normalizedRoot ||
    normalizedResolved.startsWith(`${normalizedRoot}/`)
  );
}

export function hasStaticCssEvalNodeModulesSegment(filePath: string): boolean {
  return normalizeStaticCssEvalPath(filePath)
    .split("/")
    .includes("node_modules");
}

function getStaticCssEvalProjectLocalBoundaryReason(
  boundary: StaticCssEvalProjectLocalBoundaryState
): StaticCssEvalUnsupportedReason {
  if (boundary.virtual) {
    return "virtual-module";
  }

  if (boundary.insideNodeModules) {
    return "node-modules-import";
  }

  if (boundary.packageExportOutsideRoot || !boundary.insideRoot) {
    return "not-project-local";
  }

  return "failed-project-local-dependency";
}

function createStaticCssEvalProjectLocalBoundaryDetail(
  options: StaticCssEvalProjectLocalBoundaryDescriptor,
  boundary: StaticCssEvalProjectLocalBoundaryState
): string {
  if (boundary.virtual) {
    return `dependency is a virtual module (${options.resolvedId})`;
  }

  if (boundary.insideNodeModules) {
    return `dependency is inside node_modules (${options.resolvedRealpath})`;
  }

  if (boundary.packageExportOutsideRoot) {
    return `package export resolves outside project root (${options.packageExportRealpath} outside ${options.rootRealpath})`;
  }

  if (!boundary.insideRoot) {
    return `dependency realpath is outside project root (${options.resolvedRealpath} outside ${options.rootRealpath})`;
  }

  return `dependency failed project-local boundary checks (${options.resolvedRealpath})`;
}

function normalizeStaticCssEvalPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function trimStaticCssEvalTrailingSlash(filePath: string): string {
  return filePath.length > 1 ? filePath.replace(/\/+$/g, "") : filePath;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const owner = { file: "/project/src/App.tsx", start: 11, end: 18 };

  describe("static css eval project-local boundary", () => {
    it("accepts real files inside the project root", () => {
      expect(
        enforceStaticCssEvalProjectLocalBoundary({
          owner,
          rootRealpath: "/project",
          resolvedId: "/project/src/styles.ts",
          resolvedRealpath: "/project/src/styles.ts",
          importPath: "./styles"
        })
      ).toEqual({
        ok: true,
        boundary: {
          rootRealpath: "/project",
          resolvedRealpath: "/project/src/styles.ts",
          insideRoot: true,
          insideNodeModules: false,
          virtual: false,
          packageExportOutsideRoot: false
        },
        dependencies: ["/project/src/styles.ts"]
      });
    });

    it("rejects outside-root, node_modules, virtual, and package-export dependencies", () => {
      expect(
        enforceStaticCssEvalProjectLocalBoundary({
          owner,
          rootRealpath: "/project",
          resolvedId: "/outside/styles.ts",
          resolvedRealpath: "/outside/styles.ts",
          importPath: "../outside"
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          code: "failed-project-local-dependency",
          reason: "not-project-local",
          message:
            "Cannot statically evaluate css prop value: dependency realpath is outside project root (/outside/styles.ts outside /project)"
        }
      });
      expect(
        enforceStaticCssEvalProjectLocalBoundary({
          owner,
          rootRealpath: "/project",
          resolvedId: "/project/node_modules/pkg/styles.ts",
          resolvedRealpath: "/project/node_modules/pkg/styles.ts",
          importPath: "pkg/styles"
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          reason: "node-modules-import",
          message:
            "Cannot statically evaluate css prop value: dependency is inside node_modules (/project/node_modules/pkg/styles.ts)"
        }
      });
      expect(
        enforceStaticCssEvalProjectLocalBoundary({
          owner,
          rootRealpath: "/project",
          resolvedId: "\0virtual:mincho",
          resolvedRealpath: "/project/src/virtual.ts",
          virtual: true,
          importPath: "virtual:mincho"
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          reason: "virtual-module",
          message:
            "Cannot statically evaluate css prop value: dependency is a virtual module (\0virtual:mincho)"
        },
        dependencies: []
      });
      expect(
        enforceStaticCssEvalProjectLocalBoundary({
          owner,
          rootRealpath: "/project",
          resolvedId: "/outside-pkg/styles.ts",
          resolvedRealpath: "/outside-pkg/styles.ts",
          packageExportRealpath: "/outside-pkg/styles.ts",
          importPath: "pkg/styles"
        })
      ).toMatchObject({
        ok: false,
        diagnostic: {
          reason: "not-project-local",
          message:
            "Cannot statically evaluate css prop value: package export resolves outside project root (/outside-pkg/styles.ts outside /project)"
        }
      });
    });

    it("classifies dependency metadata through the shared boundary helper", () => {
      expect(
        createStaticCssEvalDependencyMetadata({
          kind: "project-local-import",
          rootRealpath: "/project",
          resolvedId: "/project/src/styles.ts",
          resolvedRealpath: "/project/src/styles.ts",
          importerId: "/project/src/App.tsx",
          importPath: "./styles",
          sourceHash: "sha256:styles",
          version: 1
        })
      ).toEqual({
        kind: "project-local-import",
        id: "/project/src/styles.ts",
        realpath: "/project/src/styles.ts",
        importerId: "/project/src/App.tsx",
        importPath: "./styles",
        sourceHash: "sha256:styles",
        version: 1,
        projectLocal: true,
        insideNodeModules: false,
        virtual: false
      });
    });

    it("uses supplied realpaths so symlink targets outside root are rejected", () => {
      const result = enforceStaticCssEvalProjectLocalBoundary({
        owner: { file: "/project/src/App.tsx" },
        rootRealpath: "/project",
        resolvedId: "/project/src/symlinked-styles.ts",
        resolvedRealpath: "/outside-realpath/styles.ts",
        importPath: "./symlinked-styles"
      });

      expect(result).toMatchObject({
        ok: false,
        boundary: {
          insideRoot: false,
          insideNodeModules: false,
          virtual: false,
          packageExportOutsideRoot: false
        },
        diagnostic: {
          code: "failed-project-local-dependency",
          reason: "not-project-local"
        }
      });
    });
  });
}

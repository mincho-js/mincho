import type { MinchoStaticCssEvalMetadata } from "@mincho-js/babel";
import type {
  StaticCssEvalLoadedSource,
  StaticCssEvalResolvedDependency,
  StaticCssEvalSourceProvider,
  StaticCssEvalSourceResolution,
  StaticCssEvalTransformResult
} from "./babel.js";
import {
  type InternalStaticCssEvalMetadataLike,
  internalCollectStaticCssEvalDependencyIds
} from "./staticCssEvalUtils.js";

type StaticCssEvalDiagnostic =
  MinchoStaticCssEvalMetadata["diagnostics"][number];
type StaticCssEvalCacheKey = MinchoStaticCssEvalMetadata["cacheKeys"][number];

export type StaticEvalProjectEngineGeneratedArtifact = {
  readonly ownerFile: string;
  readonly artifactFile: string;
  readonly source: string;
  readonly kind: "sidecar-css-ts" | "virtual-css";
};
export type StaticEvalProjectEngineRefreshInput = {
  readonly fileId: string;
  readonly result?: StaticEvalProjectEngineStaticCssEvalLike;
  readonly generatedArtifacts?: readonly StaticEvalProjectEngineGeneratedArtifact[];
  readonly sourceHash?: string;
  readonly sourceVersion?: string | number;
  readonly preserveProviderRecords?: boolean;
};
export type StaticEvalProjectEngineProviderRecord =
  | {
      readonly kind: "resolve";
      readonly importerId: string;
      readonly importPath: string;
      readonly result: StaticCssEvalSourceResolution | null;
    }
  | {
      readonly kind: "load";
      readonly id: string;
      readonly result: StaticCssEvalLoadedSource | null;
    };
type StaticEvalProjectEngineStaticCssEvalLike = {
  readonly dependencyFiles?: readonly string[];
  readonly dependencies?: InternalStaticCssEvalMetadataLike["dependencies"];
  readonly resolvedDependencies?: readonly StaticCssEvalResolvedDependency[];
  readonly diagnostics?: readonly StaticCssEvalDiagnostic[];
  readonly cacheKeys?: readonly StaticCssEvalCacheKey[];
  readonly resolvedModuleIds?: readonly string[];
};
export type StaticEvalProjectEngineFileResult = {
  readonly fileId: string;
  readonly dependencyFiles: readonly string[];
  readonly resolvedDependencies: readonly StaticCssEvalResolvedDependency[];
  readonly diagnostics: readonly StaticCssEvalDiagnostic[];
  readonly cacheKeys: readonly StaticCssEvalCacheKey[];
  readonly generatedArtifacts: readonly StaticEvalProjectEngineGeneratedArtifact[];
  readonly providerSnapshot: readonly StaticEvalProjectEngineProviderRecord[];
  readonly sourceHash?: string;
  readonly sourceVersion?: string | number;
  readonly invalidated: boolean;
};
export type StaticEvalProjectEngineRefreshResult = {
  readonly fileId: string;
  readonly invalidatedFiles: readonly string[];
};

export interface StaticEvalProjectEngine {
  refreshFile(
    input: StaticEvalProjectEngineRefreshInput
  ): StaticEvalProjectEngineRefreshResult;
  removeFile(fileId: string): readonly string[];
  getFileResult(fileId: string): StaticEvalProjectEngineFileResult | undefined;
  getBabelStaticEvalProvider(
    fileId: string,
    sourceProvider?: StaticCssEvalSourceProvider
  ): StaticCssEvalSourceProvider;
  getGeneratedArtifacts(): readonly StaticEvalProjectEngineGeneratedArtifact[];
  getDiagnostics(): readonly StaticCssEvalDiagnostic[];
  invalidateByDependency(dependencyId: string): readonly string[];
}

type FileState = {
  result?: StaticEvalProjectEngineStaticCssEvalLike;
  generatedArtifacts: StaticEvalProjectEngineGeneratedArtifact[];
  providerRecords: StaticEvalProjectEngineProviderRecord[];
  dependencyFiles: string[];
  sourceHash?: string;
  sourceVersion?: string | number;
  invalidated: boolean;
};

export class MinchoProjectEngine implements StaticEvalProjectEngine {
  private readonly files = new Map<string, FileState>();
  private readonly dependencyToOwners = new Map<string, Set<string>>();
  constructor(private readonly sourceProvider?: StaticCssEvalSourceProvider) {}
  refreshFile(
    input: StaticEvalProjectEngineRefreshInput
  ): StaticEvalProjectEngineRefreshResult {
    const invalidatedFiles = this.invalidateByDependency(input.fileId);
    this.forgetOwnerDependencies(input.fileId);
    const dependencyFiles = internalCollectStaticCssEvalDependencyIds(
      input.result
    ).sort();
    const providerRecords = input.preserveProviderRecords
      ? (this.files.get(input.fileId)?.providerRecords ?? [])
      : [];
    const state: FileState = {
      generatedArtifacts: [...(input.generatedArtifacts ?? [])],
      providerRecords: [...providerRecords],
      dependencyFiles,
      invalidated: false
    };
    if (input.result) state.result = input.result;
    if (input.sourceHash !== undefined) state.sourceHash = input.sourceHash;
    if (input.sourceVersion !== undefined)
      state.sourceVersion = input.sourceVersion;
    this.files.set(input.fileId, state);
    this.rememberOwnerDependencies(input.fileId, dependencyFiles);
    return { fileId: input.fileId, invalidatedFiles };
  }
  removeFile(fileId: string): readonly string[] {
    const invalidatedFiles = this.invalidateByDependency(fileId);
    this.forgetOwnerDependencies(fileId);
    this.files.delete(fileId);
    return invalidatedFiles;
  }
  getFileResult(fileId: string): StaticEvalProjectEngineFileResult | undefined {
    const state = this.files.get(fileId);
    if (!state) return undefined;
    return {
      fileId,
      dependencyFiles: [...state.dependencyFiles].sort(),
      resolvedDependencies: [
        ...(state.result?.resolvedDependencies ?? [])
      ].sort(compareResolvedDependencies),
      diagnostics: [...(state.result?.diagnostics ?? [])].sort(
        compareDiagnostics
      ),
      cacheKeys: [...(state.result?.cacheKeys ?? [])].sort(compareJson),
      generatedArtifacts: [...state.generatedArtifacts].sort(compareArtifact),
      providerSnapshot: [...state.providerRecords].sort(compareJson),
      ...(state.sourceHash !== undefined
        ? { sourceHash: state.sourceHash }
        : {}),
      ...(state.sourceVersion !== undefined
        ? { sourceVersion: state.sourceVersion }
        : {}),
      invalidated: state.invalidated
    };
  }
  getBabelStaticEvalProvider(
    fileId: string,
    sourceProvider = this.sourceProvider
  ): StaticCssEvalSourceProvider {
    const state = this.getOrCreateState(fileId);
    state.providerRecords = [];
    return {
      resolve: async (importerId, importPath) => {
        const result =
          (await sourceProvider?.resolve(importerId, importPath)) ?? null;
        state.providerRecords.push({
          kind: "resolve",
          importerId,
          importPath,
          result: cloneResolution(result)
        });
        return result;
      },
      load: async (id) => {
        const result = (await sourceProvider?.load(id)) ?? null;
        state.providerRecords.push({
          kind: "load",
          id,
          result: cloneLoaded(result)
        });
        return result;
      }
    };
  }
  getGeneratedArtifacts(): readonly StaticEvalProjectEngineGeneratedArtifact[] {
    return [...this.files.values()]
      .flatMap((state) => state.generatedArtifacts)
      .sort(compareArtifact);
  }
  getDiagnostics(): readonly StaticCssEvalDiagnostic[] {
    return [...this.files.values()]
      .flatMap((state) => state.result?.diagnostics ?? [])
      .sort(compareDiagnostics);
  }
  invalidateByDependency(dependencyId: string): readonly string[] {
    const invalidatedFiles = [
      ...(this.dependencyToOwners.get(dependencyId) ?? [])
    ].sort();
    for (const owner of invalidatedFiles) {
      const state = this.files.get(owner);
      if (state) {
        state.invalidated = true;
        state.generatedArtifacts = [];
      }
    }
    return invalidatedFiles;
  }
  private getOrCreateState(fileId: string): FileState {
    const state = this.files.get(fileId);
    if (state) return state;
    const next: FileState = {
      generatedArtifacts: [],
      providerRecords: [],
      dependencyFiles: [],
      invalidated: false
    };
    this.files.set(fileId, next);
    return next;
  }
  private rememberOwnerDependencies(
    ownerId: string,
    dependencyFiles: readonly string[]
  ): void {
    for (const dependencyFile of dependencyFiles) {
      if (dependencyFile === ownerId) continue;
      const owners = this.dependencyToOwners.get(dependencyFile) ?? new Set();
      owners.add(ownerId);
      this.dependencyToOwners.set(dependencyFile, owners);
    }
  }
  private forgetOwnerDependencies(ownerId: string): void {
    const state = this.files.get(ownerId);

    for (const dependencyFile of state?.dependencyFiles ?? []) {
      const owners = this.dependencyToOwners.get(dependencyFile);
      if (!owners) continue;
      owners.delete(ownerId);
      if (owners.size === 0) this.dependencyToOwners.delete(dependencyFile);
    }

    if (state) state.dependencyFiles = [];
  }
}

function cloneResolution(
  result: StaticCssEvalSourceResolution | null
): StaticCssEvalSourceResolution | null {
  return result
    ? {
        ...result,
        ...(result.watchFiles ? { watchFiles: [...result.watchFiles] } : {}),
        ...(result.sourceIdentity
          ? { sourceIdentity: { ...result.sourceIdentity } }
          : {})
      }
    : null;
}
function cloneLoaded(
  result: StaticCssEvalLoadedSource | null
): StaticCssEvalLoadedSource | null {
  return result
    ? {
        ...result,
        ...(result.watchFiles ? { watchFiles: [...result.watchFiles] } : {}),
        ...(result.sourceIdentity
          ? { sourceIdentity: { ...result.sourceIdentity } }
          : {})
      }
    : null;
}
function compareArtifact(
  left: StaticEvalProjectEngineGeneratedArtifact,
  right: StaticEvalProjectEngineGeneratedArtifact
): number {
  return text(
    `${left.ownerFile}\0${left.artifactFile}\0${left.kind}`,
    `${right.ownerFile}\0${right.artifactFile}\0${right.kind}`
  );
}
function compareResolvedDependencies(
  left: StaticCssEvalResolvedDependency,
  right: StaticCssEvalResolvedDependency
): number {
  return text(
    `${left.importerId}\0${left.specifier}\0${left.resolvedFile}`,
    `${right.importerId}\0${right.specifier}\0${right.resolvedFile}`
  );
}
function compareDiagnostics(
  left: StaticCssEvalDiagnostic,
  right: StaticCssEvalDiagnostic
): number {
  return text(
    JSON.stringify([left.owner.file, left.id, left.code, left.message]),
    JSON.stringify([right.owner.file, right.id, right.code, right.message])
  );
}
function compareJson<T>(left: T, right: T): number {
  return text(JSON.stringify(left), JSON.stringify(right));
}
function text(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;
  const artifact = (
    ownerFile: string
  ): StaticEvalProjectEngineGeneratedArtifact => ({
    ownerFile,
    artifactFile: `${ownerFile}.css.ts`,
    source: "css({ color: token })",
    kind: "sidecar-css-ts"
  });
  const result = (
    fileId: string,
    dependencyFile: string,
    color: string,
    diagnosticId?: StaticCssEvalDiagnostic["id"]
  ): StaticCssEvalTransformResult => ({
    dependencyFiles: [dependencyFile],
    ownerToDependencies: new Map([[fileId, [dependencyFile]]]),
    dependencyToOwners: new Map([[dependencyFile, [fileId]]]),
    resolvedModuleCache: new Map(),
    resolvedDependencies: [
      {
        importerId: fileId,
        specifier: "./tokens",
        resolvedFile: dependencyFile,
        canonicalModuleId: dependencyFile,
        normalizedPathKey: dependencyFile,
        resolverKind: "test",
        loaded: true
      }
    ],
    dependencies: [
      {
        file: dependencyFile,
        kind: "imported",
        importer: fileId,
        specifier: "./tokens",
        exportName: "button",
        memberPath: ["color"],
        inspected: true,
        contributed: true
      }
    ],
    diagnostics: diagnosticId
      ? [
          {
            id: diagnosticId,
            code: "unsupported-source",
            reason: "unsupported-source-shape",
            message: `Cannot resolve ${color}`,
            owner: { file: fileId, start: 0, end: 1 },
            dependency: { file: dependencyFile }
          }
        ]
      : [],
    cacheKeys: [
      {
        importerFile: fileId,
        resolvedFile: dependencyFile,
        exportName: "button",
        memberPath: ["color"],
        sourceHash: `hash:${color}`,
        pluginOptionsVersion: "test",
        resolverOptionsVersion: "test",
        staticEvalSupportVersion: "test"
      }
    ],
    resolvedModuleIds: [`test:${dependencyFile}`]
  });
  const cycle = "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE";
  const unsupported = "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED";
  function providerEngine(): MinchoProjectEngine {
    return new MinchoProjectEngine({
      resolve: (importerId, importPath) => ({
        resolvedFile: `${importerId}/${importPath}`,
        canonicalModuleId: importPath,
        normalizedPathKey: importPath,
        resolverKind: "test"
      }),
      load: (id) => ({
        sourceText: `export const id = ${JSON.stringify(id)};`,
        sourceIdentity: { sourceHash: `hash:${id}`, version: 1 },
        resolverKind: "test"
      })
    });
  }
  describe("static css eval project engine", () => {
    it("refreshes a file and updates only its contribution plus dependents", () => {
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: "/project/Dependent.tsx",
        result: result("/project/Dependent.tsx", "/project/App.tsx", "green"),
        generatedArtifacts: [artifact("/project/Dependent.tsx")]
      });
      const refresh = engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/tokens.ts", "blue"),
        sourceHash: "owner:blue",
        sourceVersion: 2
      });
      expect(refresh.invalidatedFiles).toEqual(["/project/Dependent.tsx"]);
      expect(engine.getFileResult("/project/App.tsx")?.sourceHash).toBe(
        "owner:blue"
      );
      expect(engine.getFileResult("/project/App.tsx")?.sourceVersion).toBe(2);
      expect(
        engine.getFileResult("/project/Dependent.tsx")?.generatedArtifacts
      ).toEqual([]);
    });
    it("preserves source fingerprint hash and version together", () => {
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/tokens.ts", "blue"),
        sourceHash: "hash:owner",
        sourceVersion: "version:owner"
      });
      expect(engine.getFileResult("/project/App.tsx")?.sourceHash).toBe(
        "hash:owner"
      );
      expect(engine.getFileResult("/project/App.tsx")?.sourceVersion).toBe(
        "version:owner"
      );
    });
    it("removes a file and clears artifacts diagnostics while invalidating dependents", () => {
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result(
          "/project/App.tsx",
          "/project/tokens.ts",
          "red",
          unsupported
        ),
        generatedArtifacts: [artifact("/project/App.tsx")]
      });
      expect(engine.removeFile("/project/tokens.ts")).toEqual([
        "/project/App.tsx"
      ]);
      expect(engine.getFileResult("/project/tokens.ts")).toBeUndefined();
      expect(
        engine.getFileResult("/project/App.tsx")?.generatedArtifacts
      ).toEqual([]);
      expect(
        engine.getFileResult("/project/App.tsx")?.diagnostics
      ).toHaveLength(1);
    });
    it("invalidates owners by dependency", () => {
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/tokens.ts", "blue")
      });
      expect(engine.invalidateByDependency("/project/tokens.ts")).toEqual([
        "/project/App.tsx"
      ]);
      expect(engine.getFileResult("/project/App.tsx")?.invalidated).toBe(true);
    });
    it("returns deterministic diagnostics and artifacts", () => {
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: "/project/B.tsx",
        result: result(
          "/project/B.tsx",
          "/project/tokens-b.ts",
          "blue",
          unsupported
        ),
        generatedArtifacts: [artifact("/project/B.tsx")]
      });
      engine.refreshFile({
        fileId: "/project/A.tsx",
        result: result("/project/A.tsx", "/project/tokens-a.ts", "red", cycle),
        generatedArtifacts: [artifact("/project/A.tsx")]
      });
      expect(
        engine.getDiagnostics().map((diagnostic) => diagnostic.id)
      ).toEqual([cycle, unsupported]);
      expect(
        engine.getGeneratedArtifacts().map((item) => item.ownerFile)
      ).toEqual(["/project/A.tsx", "/project/B.tsx"]);
    });
    it("records deterministic provider artifacts snapshots", async () => {
      const engine = providerEngine();
      const provider = engine.getBabelStaticEvalProvider("/project/App.tsx");
      await provider.load("/project/tokens.ts");
      await provider.resolve("/project/App.tsx", "./tokens");
      const snapshot =
        engine.getFileResult("/project/App.tsx")?.providerSnapshot;
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
      expect(snapshot?.map((record) => record.kind)).toEqual([
        "load",
        "resolve"
      ]);
    });
    it("resets stale provider snapshot records across refresh cycles", async () => {
      const engine = providerEngine();
      const firstProvider =
        engine.getBabelStaticEvalProvider("/project/App.tsx");
      await firstProvider.load("/project/old-tokens.ts");
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/tokens.ts", "blue")
      });
      expect(
        engine.getFileResult("/project/App.tsx")?.providerSnapshot
      ).toEqual([]);
      const secondProvider =
        engine.getBabelStaticEvalProvider("/project/App.tsx");
      await secondProvider.resolve("/project/App.tsx", "./tokens");
      expect(
        engine
          .getFileResult("/project/App.tsx")
          ?.providerSnapshot.map((record) => record.kind)
      ).toEqual(["resolve"]);
    });
    it("preserves only current-transform provider records", async () => {
      const engine = providerEngine();
      const firstProvider =
        engine.getBabelStaticEvalProvider("/project/App.tsx");
      await firstProvider.load("/project/old-tokens.ts");
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/old-tokens.ts", "red"),
        preserveProviderRecords: true
      });

      const secondProvider =
        engine.getBabelStaticEvalProvider("/project/App.tsx");
      await secondProvider.resolve("/project/App.tsx", "./tokens");
      engine.refreshFile({
        fileId: "/project/App.tsx",
        result: result("/project/App.tsx", "/project/tokens.ts", "blue"),
        preserveProviderRecords: true
      });

      expect(
        engine
          .getFileResult("/project/App.tsx")
          ?.providerSnapshot.map((record) => record.kind)
      ).toEqual(["resolve"]);
    });
  });
}

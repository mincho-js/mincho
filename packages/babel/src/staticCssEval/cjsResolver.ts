import type {
  ImportedStaticCssEvalCjsBinding,
  StaticCssEvalCjsRequireSource
} from "./cjsBindings.js";
import type {
  BindingProvenance,
  ResolutionDependencyKind,
  StaticCssEvalExportName
} from "./types.js";

type StaticCssEvalCjsProvenanceKind = Extract<
  BindingProvenance["kind"],
  "imported" | "reexported"
>;

export type StaticCssEvalCjsResolutionRequestParts = {
  readonly specifier: string;
  readonly exportName: StaticCssEvalExportName;
  readonly memberPath: string[];
  readonly dependencyKind: ResolutionDependencyKind;
  readonly provenanceKind: StaticCssEvalCjsProvenanceKind;
  readonly reexportName?: string;
};

export function createStaticCssEvalCjsImportRequestParts(options: {
  readonly binding: ImportedStaticCssEvalCjsBinding;
  readonly queryMemberPath: readonly string[];
}): StaticCssEvalCjsResolutionRequestParts {
  return createStaticCssEvalCjsRequestParts({
    source: options.binding,
    queryMemberPath: options.queryMemberPath,
    dependencyKind: "imported",
    provenanceKind: "imported"
  });
}

export function createStaticCssEvalCjsReexportRequestParts(options: {
  readonly source: StaticCssEvalCjsRequireSource;
  readonly queryMemberPath: readonly string[];
  readonly reexportName: string;
}): StaticCssEvalCjsResolutionRequestParts {
  return createStaticCssEvalCjsRequestParts({
    source: options.source,
    queryMemberPath: options.queryMemberPath,
    dependencyKind: "reexported",
    provenanceKind: "reexported",
    reexportName: options.reexportName
  });
}

function createStaticCssEvalCjsRequestParts(options: {
  readonly source: StaticCssEvalCjsRequireSource;
  readonly queryMemberPath: readonly string[];
  readonly dependencyKind: ResolutionDependencyKind;
  readonly provenanceKind: StaticCssEvalCjsProvenanceKind;
  readonly reexportName?: string;
}): StaticCssEvalCjsResolutionRequestParts {
  const propertyPath = [
    ...options.source.propertyPath,
    ...options.queryMemberPath
  ];
  const [exportName, ...memberPath] = propertyPath;

  return {
    specifier: options.source.importPath,
    exportName: exportName ?? null,
    memberPath,
    dependencyKind: options.dependencyKind,
    provenanceKind: options.provenanceKind,
    ...(options.reexportName !== undefined
      ? { reexportName: options.reexportName }
      : {})
  };
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
const vitest = import.meta.vitest;

if (vitest) {
  const { describe, expect, it } = vitest;

  describe("CommonJS resolution request parts", () => {
    it("maps direct member and destructured require sources through one request shape", () => {
      expect(
        createStaticCssEvalCjsImportRequestParts({
          binding: {
            kind: "cjs-module",
            localName: "styles",
            importPath: "./styles",
            propertyPath: []
          },
          queryMemberPath: ["button"]
        })
      ).toEqual({
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        dependencyKind: "imported",
        provenanceKind: "imported"
      });

      expect(
        createStaticCssEvalCjsImportRequestParts({
          binding: {
            kind: "cjs-member",
            localName: "button",
            importPath: "./styles",
            propertyPath: ["button"]
          },
          queryMemberPath: ["tone"]
        })
      ).toEqual({
        specifier: "./styles",
        exportName: "button",
        memberPath: ["tone"],
        dependencyKind: "imported",
        provenanceKind: "imported"
      });
    });

    it("maps const-path CJS reexports with reexport metadata", () => {
      expect(
        createStaticCssEvalCjsReexportRequestParts({
          source: {
            importPath: "./styles",
            propertyPath: ["button"]
          },
          queryMemberPath: ["tone"],
          reexportName: "primaryButton"
        })
      ).toEqual({
        specifier: "./styles",
        exportName: "button",
        memberPath: ["tone"],
        dependencyKind: "reexported",
        provenanceKind: "reexported",
        reexportName: "primaryButton"
      });
    });
  });
}

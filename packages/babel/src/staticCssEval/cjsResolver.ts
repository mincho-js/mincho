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

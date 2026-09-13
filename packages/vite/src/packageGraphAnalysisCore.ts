import {
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
  type DefineRulesPackageGraph
} from "@mincho-js/integration/package-graph";

export interface PackageGraphAnalysisRequest {
  readonly generation: number;

  /** Stable declaration order for this output's static module closure. */
  readonly moduleIds: readonly string[];
  readonly excludePackages?: readonly string[];
}

export interface PackageGraphAnalysisResult {
  readonly graph: DefineRulesPackageGraph;
  readonly styleSpecifiers: readonly string[];
}

export type PackageGraphWorkerCommand =
  | { readonly type: "reset"; readonly generation: number }
  | {
      readonly type: "register";
      readonly generation: number;
      readonly moduleId: string;
      readonly graph: DefineRulesPackageGraph;
    }
  | {
      readonly type: "remove";
      readonly generation: number;
      readonly moduleId: string;
    }
  | (PackageGraphAnalysisRequest & {
      readonly type: "analyze";
      readonly requestId: number;
    });

export interface SerializedPackageGraphError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type PackageGraphWorkerResponse = {
  readonly requestId: number;
  readonly generation: number;
} & (
  | { readonly type: "result"; readonly result: PackageGraphAnalysisResult }
  | { readonly type: "error"; readonly error: SerializedPackageGraphError }
);

/** Both execution modes use the same output-scoped merge and cycle check. */
export function analyzeRegisteredPackageGraphs(
  graphs: ReadonlyMap<string, DefineRulesPackageGraph>,
  request: PackageGraphAnalysisRequest
): PackageGraphAnalysisResult {
  const selected: DefineRulesPackageGraph[] = [];
  const visited = new Set<string>();

  for (const moduleId of request.moduleIds) {
    if (visited.has(moduleId)) continue;

    visited.add(moduleId);

    const graph = graphs.get(moduleId);

    if (graph !== undefined) selected.push(graph);
  }

  const graph = mergeDefineRulesPackageGraphs(selected);

  return {
    graph,
    styleSpecifiers: getDefineRulesPackageStyleSpecifiers(graph, {
      excludePackages: request.excludePackages
    })
  };
}

export function serializePackageGraphError(
  error: unknown
): SerializedPackageGraphError {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "Error", message: String(error) };
}

export function restorePackageGraphError(
  value: SerializedPackageGraphError
): Error {
  const error =
    value.name === "TypeError"
      ? new TypeError(value.message)
      : value.name === "RangeError"
        ? new RangeError(value.message)
        : new Error(value.message);

  error.name = value.name;

  if (value.stack !== undefined) error.stack = value.stack;

  return error;
}

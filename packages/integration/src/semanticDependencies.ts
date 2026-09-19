import {
  internalSemanticExports,
  type InternalSemanticExportRequest
} from "@mincho-js/babel";
import type {
  BabelTransformResult,
  StaticCssEvalLoadedSource
} from "./babel.js";
import type { CompilationCache } from "./compilationCache.js";
import { cacheDigest } from "./compilationInputs.js";

export interface SemanticWitness {
  readonly file: string;
  readonly requests: readonly InternalSemanticExportRequest[];
  readonly digest: string;
}

export function semanticWitnesses(
  result: BabelTransformResult,
  loads: ReadonlyMap<string, StaticCssEvalLoadedSource | null>,
  owner: string,
  cache: CompilationCache
): SemanticWitness[] {
  if (result.staticCssEval?.diagnostics.length) return [];

  const requests = new Map<
    string,
    Map<string, InternalSemanticExportRequest>
  >();

  const demands = [
    ...(result.semanticDemands ?? []),
    ...(result.staticCssEval?.dependencies ?? [])
      .filter((item) => item.inspected)
      .map((item) => ({
        file: item.file,
        name: item.exportName,
        members: item.memberPath
      }))
  ];

  for (const { file, name, members } of demands) {
    if (file === owner) continue;

    const names = requests.get(file) ?? new Map();
    names.set(JSON.stringify([name, members]), { name, members });
    requests.set(file, names);
  }

  return [...requests].flatMap(([file, names]) => {
    const loaded = loads.get(file);
    const source = loaded?.sourceText ?? loaded?.source;
    if (source === undefined) return [];

    const requests = [...names.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );

    const digest = internalSemanticExports(
      file,
      source,
      requests,
      cache.parser
    );

    return digest ? [{ file, requests, digest }] : [];
  });
}

export function unchangedSemanticSource(
  witness: SemanticWitness,
  value: StaticCssEvalLoadedSource | null,
  cache: CompilationCache
): boolean {
  const source = value?.sourceText ?? value?.source;

  return (
    source !== undefined &&
    internalSemanticExports(
      witness.file,
      source,
      witness.requests,
      cache.parser
    ) === witness.digest
  );
}

/** Freshness may change; resolver policy, watch files and canonical identities may not. */
export function sourcePolicy(value: unknown): string {
  if (!value || typeof value !== "object")
    return cacheDigest(JSON.stringify(value) ?? "undefined");

  const {
    sourceText: _source,
    source: _legacySource,
    sourceHash: _hash,
    version: _version,
    sourceIdentity: _identity,
    ...policy
  } = value as StaticCssEvalLoadedSource;

  return cacheDigest(JSON.stringify(policy));
}

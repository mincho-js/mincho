import type {
  StaticCssEvalSourceKind,
  StaticCssEvalSourceOrigin
} from "./babel.js";

const sourceOrigins = {
  "project-source": "project",
  "package-source": "package",
  "provider-virtual": "provider",
  "static-data": "data",
  "external-no-source": "external",
  unresolved: "unresolved",
  "unsupported-source-shape": "unsupported"
} as const satisfies Record<StaticCssEvalSourceKind, StaticCssEvalSourceOrigin>;

export function getStaticCssEvalSourceOrigin(
  sourceKind: StaticCssEvalSourceKind
): StaticCssEvalSourceOrigin {
  if (!Object.hasOwn(sourceOrigins, sourceKind)) {
    throw new Error(`Unknown static CSS eval source kind: ${sourceKind}`);
  }

  return sourceOrigins[sourceKind];
}

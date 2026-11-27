import { createHash } from "node:crypto";
import type {
  ConsumerRuntimeSource,
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

/**
 * Validate the shape of a trusted host callback's effect-only receipt. This
 * structural check cannot establish loader ownership on behalf of a host.
 * Native CSS initialization (including CSS-module mapping exports) does not
 * mutate the observed intrinsics; no export, call or purity authority follows.
 */
export function hasNativeCssIntrinsicEffects(
  value: ConsumerRuntimeSource | undefined
): boolean {
  const receipt = value?.intrinsicEffects;
  return (
    value?.source === undefined &&
    receipt?.kind === "native-css" &&
    ["css", "local-css"].includes(receipt.loader) &&
    typeof receipt.sourceHash === "string" &&
    receipt.sourceHash.length > 0 &&
    typeof receipt.version === "string" &&
    receipt.version.length > 0
  );
}

/** Invoke the trusted provider's exact-source/generation validator. A DTO tag is
 * not authority, and a callback failure never restores another observation. */
export function hasValidatedPatternIntrinsicEffects(
  value: ConsumerRuntimeSource | undefined
): boolean {
  if (!value || typeof value.source !== "string") return false;
  const {
    source,
    sourceHash,
    version,
    validatesPatternIntrinsicEffects: validate
  } = value;
  if (
    typeof validate !== "function" ||
    createHash("sha256").update(source).digest("hex") !== sourceHash
  )
    return false;
  try {
    return validate({ source, sourceHash, version }) === true;
  } catch {
    return false;
  }
}

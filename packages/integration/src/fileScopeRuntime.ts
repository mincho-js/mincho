import { parseSync, traverse, types as t } from "@babel/core";
import { createHash } from "node:crypto";
// Shared compiler-owned wrapper; its exact AST is checked before VM reuse.
export const scopedFileScopeRuntime = `((fileScope) => {
    let parentCounter = 0;
    return {
      setFileScope(...args) {
        parentCounter = fileScope.hasFileScope()
          ? fileScope.getAndIncrementRefCounter()
          : 0;
        fileScope.setFileScope(...args);
      },
      endFileScope() {
        fileScope.endFileScope();
        for (let index = 0; index < parentCounter; index++) {
          fileScope.getAndIncrementRefCounter();
        }
      }
    };
  })(require("@vanilla-extract/css/fileScope"))`;

/** Physical CSS producer metadata, not source-analysis or call authority. */
export interface CssScopeOrigin {
  readonly fileScope: {
    readonly filePath: string;
    readonly packageName?: string;
  };
  readonly origin: string;
  /** Compiler-issued capability; not trusted merely because these fields exist. */
  readonly runtime?: {
    readonly id: string;
    readonly sourceHash: string;
    readonly factoryName: string;
  };
}

/** Snapshot caller-owned containers before evaluation or serializer callbacks.
 * Preserve the opaque runtime object identity: cloning it would erase its seal.
 */
export function snapshotCssScopeOrigins(
  origins: readonly CssScopeOrigin[] | undefined
): readonly CssScopeOrigin[] | undefined {
  return (
    origins &&
    Object.freeze(
      origins.map((entry) => {
        const { fileScope, origin, runtime } = entry;
        const { filePath, packageName } = fileScope;
        return Object.freeze({
          fileScope: Object.freeze({ filePath, packageName }),
          origin,
          runtime
        });
      })
    )
  );
}

/** A CSS-text scope can lack an origin, but ambiguous evidence is still invalid. */
export function findCssScopeOrigin(
  scope: CssScopeOrigin["fileScope"],
  origins: readonly CssScopeOrigin[]
): string | undefined {
  const candidates = [
    ...new Set(
      origins
        .filter(
          (entry) =>
            !entry.runtime &&
            entry.fileScope.filePath === scope.filePath &&
            (entry.fileScope.packageName || undefined) ===
              (scope.packageName || undefined)
        )
        .map((entry) => entry.origin)
    )
  ];
  if (candidates.length > 1)
    throw new Error(
      `Ambiguous CSS file scope "${scope.filePath}" in package "${scope.packageName}". Multiple physical sources match: ${candidates.join(", ")}.`
    );
  return candidates[0];
}

/** Artifacts require explicit scoping evidence; never guess a package root. */
export function resolveCssScopeOrigin(
  scope: CssScopeOrigin["fileScope"],
  origins: readonly CssScopeOrigin[]
): string {
  const origin = findCssScopeOrigin(scope, origins);
  if (origin === undefined)
    throw new Error(
      `Missing CSS scope provenance for "${scope.filePath}" in package "${scope.packageName}". Pass compile().cssScopeOrigins to CSS evaluation.`
    );
  return origin;
}

export const CSS_SCOPE_RUNTIME_PREFIX = "mincho:css-scope-runtime:";

/** Exact source-safe ASCII identifier; reject even a trailing line break. */
export function isCssScopeRuntimeFactoryName(name: string): boolean {
  return /^__mincho_css_scope_factory_[A-Za-z0-9_$]+$/.exec(name)?.[0] === name;
}

// Only the compiler's verified compile/worker/cache return boundary issues these
// capabilities. JSON fields alone are not an authorization to invent origins.
const issuedRuntimeOrigins = new WeakMap<object, string>();
// JavaScript strings are UTF-16 code units. Hash without UTF-8 replacement
// so the registration attests to the exact program text.
const runtimeSourceDigest = (source: string) =>
  createHash("sha256").update(source, "utf16le").digest("hex");
const runtimeSeal = (
  sourceHash: string,
  id: string,
  origin: string,
  factoryName: string
) => JSON.stringify([sourceHash, id, origin, factoryName]);

/** @internal Reissue only at a trusted successful compile/cache return boundary. */
export function issueCssScopeRuntimeOrigins(
  source: string,
  entries: readonly CssScopeOrigin[]
): CssScopeOrigin[] {
  const sourceHash = runtimeSourceDigest(source);
  return entries.map((entry) => {
    const { runtime: incoming, origin, fileScope } = entry;
    if (!incoming) return { origin, fileScope: structuredClone(fileScope) };
    const { id, factoryName } = incoming;
    if (
      typeof origin !== "string" ||
      typeof id !== "string" ||
      typeof factoryName !== "string" ||
      !id.startsWith(CSS_SCOPE_RUNTIME_PREFIX) ||
      !isCssScopeRuntimeFactoryName(factoryName)
    )
      throw new Error("Invalid compiler CSS scope runtime registration");
    const runtime = Object.freeze({ id, sourceHash, factoryName });
    issuedRuntimeOrigins.set(
      runtime,
      runtimeSeal(sourceHash, id, origin, factoryName)
    );
    return { origin, fileScope: { ...fileScope }, runtime };
  });
}

export interface CssScopeRuntimeRegistration {
  readonly key: string;
  readonly factoryName: string;
  readonly origins: ReadonlyMap<string, string>;
}

export function validateCssScopeRuntimeOrigins(
  source: string,
  entries: readonly CssScopeOrigin[] = []
): CssScopeRuntimeRegistration | undefined {
  // Snapshot each untrusted entry field once. Accessors must not pass the seal
  // check with one value and install a different origin on the subsequent read.
  const runtimeEntries = entries.flatMap((entry) => {
    const runtime = entry.runtime;
    return runtime ? [{ runtime, origin: entry.origin }] : [];
  });
  if (!runtimeEntries.length) return;
  const sourceHash = runtimeSourceDigest(source);
  const origins = new Map<string, string>();
  const factoryName = runtimeEntries[0]!.runtime!.factoryName;
  for (const entry of runtimeEntries) {
    const runtime = entry.runtime!;
    if (
      typeof entry.origin !== "string" ||
      runtime.factoryName !== factoryName ||
      runtime.sourceHash !== sourceHash ||
      issuedRuntimeOrigins.get(runtime) !==
        runtimeSeal(sourceHash, runtime.id, entry.origin, runtime.factoryName)
    )
      throw new Error(
        "Untrusted or stale compiler CSS scope runtime registration"
      );
    const previous = origins.get(runtime.id);
    if (previous !== undefined && previous !== entry.origin)
      throw new Error("Ambiguous compiler CSS scope runtime registration");
    origins.set(runtime.id, entry.origin);
  }
  return {
    key: createHash("sha256")
      .update(JSON.stringify([sourceHash, factoryName, [...origins].sort()]))
      .digest("hex"),
    factoryName,
    origins
  };
}

export interface CssScopeRuntimeReceipt {
  readonly id: string;
  readonly fileScope: CssScopeOrigin["fileScope"];
  readonly origin: string;
}
export interface SerializedCssScopeRuntime {
  readonly key: string;
  readonly receipts: readonly CssScopeRuntimeReceipt[];
}

export function validateCssScopeRuntimeReceipts(
  registration: CssScopeRuntimeRegistration,
  serialized: SerializedCssScopeRuntime | undefined
): CssScopeOrigin[] {
  if (!serialized || serialized.key !== registration.key)
    throw new Error("Stale CSS scope runtime receipt");
  return serialized.receipts.map((receipt) => {
    const origin = registration.origins.get(receipt.id);
    if (
      origin === undefined ||
      origin !== receipt.origin ||
      typeof receipt.fileScope.filePath !== "string" ||
      (receipt.fileScope.packageName !== undefined &&
        typeof receipt.fileScope.packageName !== "string")
    )
      throw new Error("Invalid CSS scope runtime receipt");
    return { origin, fileScope: { ...receipt.fileScope } };
  });
}

/** Per-evaluation state, never shared by pooled VMs or failed evaluations. */
export function createCssScopeRuntimeSession(
  registration: CssScopeRuntimeRegistration
) {
  const receipts: CssScopeRuntimeReceipt[] = [];
  let active = true;
  return {
    assertActive() {
      if (!active) throw new Error("Closed CSS scope runtime evaluation");
    },
    record(id: string, scope: CssScopeOrigin["fileScope"]) {
      if (!active) throw new Error("Closed CSS scope runtime evaluation");
      const origin = registration.origins.get(id);
      if (
        origin === undefined ||
        typeof scope.filePath !== "string" ||
        (scope.packageName !== undefined &&
          typeof scope.packageName !== "string")
      )
        throw new Error("Invalid CSS scope runtime invocation");
      receipts.push({
        id,
        origin,
        fileScope: {
          filePath: scope.filePath,
          packageName: scope.packageName || undefined
        }
      });
    },
    close(success: boolean) {
      active = false;
      if (!success) receipts.length = 0;
    },
    snapshot(): SerializedCssScopeRuntime {
      if (active) throw new Error("Incomplete CSS scope runtime evaluation");
      return { key: registration.key, receipts: structuredClone(receipts) };
    }
  };
}

/** Denial-only recognition: generated acquisition without its registration must
 * not fall back to a caller-supplied static origin map for artifact publication.
 * A matching name/string/comment alone confers no authority and is not a match.
 */
export function hasCssScopeRuntimeAcquisition(source: string): boolean {
  if (!source.includes("__mincho_css_scope_factory_")) return false;
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    sourceType: "unambiguous",
    parserOpts: { allowReturnOutsideFunction: true }
  });
  if (!ast) return false;
  let found = false;
  traverse(ast, {
    ConditionalExpression(path) {
      const { test, consequent } = path.node;
      if (
        !t.isBinaryExpression(test) ||
        (test.operator !== "===" && test.operator !== "==") ||
        !t.isUnaryExpression(test.left, { operator: "typeof" }) ||
        !t.isIdentifier(test.left.argument) ||
        !/^__mincho_css_scope_factory_[A-Za-z0-9_$]+$/.test(
          test.left.argument.name
        ) ||
        path.scope.getBinding(test.left.argument.name) ||
        !t.isStringLiteral(test.right, { value: "function" }) ||
        !t.isCallExpression(consequent) ||
        !t.isIdentifier(consequent.callee, { name: test.left.argument.name }) ||
        consequent.arguments.length !== 1 ||
        !t.isStringLiteral(consequent.arguments[0]) ||
        !consequent.arguments[0].value.startsWith(CSS_SCOPE_RUNTIME_PREFIX)
      )
        return;
      found = true;
      path.stop();
    }
  });
  return found;
}

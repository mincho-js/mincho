import type {
  DefineRulesPresetAtomV5,
  DefineRulesPresetNodeV5,
  PresetAtomId,
  PresetContentHash,
  PresetNodeId,
  PresetOriginId
} from "./types.js";
import type { NormalizedCondition } from "./conditions.js";
import { isUnSafeObjectKey } from "../utils.js";
import { sha256 } from "./presetSha256.js";

type PresetOriginInput = {
  readonly packageName: string;
  readonly producerPath: string;
  readonly registrationIndex: number;
};

type PresetAtomInput = Omit<DefineRulesPresetAtomV5, "atomId">;
type PresetNodeInput = {
  readonly origin: PresetOriginId;
  readonly parents: readonly PresetNodeId[];
  readonly atoms: readonly PresetAtomInput[];
};

export function canonicalizePresetValue(value: unknown): string {
  return canonicalize(value, new WeakSet());
}

export function hashPresetCanonical(value: unknown): string {
  return sha256(canonicalizePresetValue(value));
}

export function createPresetOriginId(input: PresetOriginInput): PresetOriginId {
  if (
    input.packageName.length === 0 ||
    input.packageName.includes(":") ||
    input.packageName.includes("#") ||
    input.packageName.includes("\\") ||
    !isPosixRelativePath(input.producerPath) ||
    !Number.isSafeInteger(input.registrationIndex) ||
    input.registrationIndex < 0
  ) {
    throw new TypeError("Invalid defineRules preset origin");
  }

  return `${input.packageName}:${input.producerPath}#defineRules:${input.registrationIndex}` as PresetOriginId;
}

export function parsePresetOriginId(value: string): PresetOriginId {
  const match = /^([^:#\\]+):([^#\\]+)#defineRules:(0|[1-9]\d*)$/.exec(value);

  if (match === null) {
    throw new TypeError("Invalid defineRules preset origin");
  }

  return createPresetOriginId({
    packageName: match[1],
    producerPath: match[2],
    registrationIndex: Number(match[3])
  });
}

export function createDefineRulesPresetAtomV5(
  input: PresetAtomInput
): DefineRulesPresetAtomV5 {
  const condition = freezeCondition(input.condition);
  const atomId = hashPresetCanonical({
    cacheKey: input.cacheKey,
    condition,
    property: input.property
  }) as PresetAtomId;

  return Object.freeze({
    atomId,
    cacheKey: input.cacheKey,
    className: input.className,
    condition,
    property: input.property
  });
}

export function createDefineRulesPresetNodeV5(
  input: PresetNodeInput
): DefineRulesPresetNodeV5 {
  const parents = Object.freeze([...input.parents]);
  const atoms = Object.freeze(
    input.atoms.map((atom) => createDefineRulesPresetAtomV5(atom))
  );
  const contentHash = hashPresetCanonical({
    parents,
    atoms
  }) as PresetContentHash;
  const nodeId = hashPresetCanonical({
    origin: input.origin,
    contentHash
  }) as PresetNodeId;

  return Object.freeze({
    nodeId,
    origin: input.origin,
    contentHash,
    parents,
    atoms
  });
}

function canonicalize(value: unknown, stack: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("Non-finite numbers are unsupported");
      return JSON.stringify(value);
    case "object":
      return canonicalizeObject(value, stack);
    default:
      throw new TypeError(`Unsupported preset value type: ${typeof value}`);
  }
}

function canonicalizeObject(value: object, stack: WeakSet<object>): string {
  if (stack.has(value))
    throw new TypeError("Circular preset values are unsupported");
  stack.add(value);

  try {
    if (Array.isArray(value)) return canonicalizeArray(value, stack);
    if (!isPlainRecord(value))
      throw new TypeError("Custom prototypes are unsupported");
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new TypeError("Symbols are unsupported");

    const keys = Object.keys(value).sort();
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      throw new TypeError("Non-enumerable preset fields are unsupported");
    }

    return `{${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          isUnSafeObjectKey(key) ||
          descriptor?.get !== undefined ||
          descriptor?.set !== undefined
        ) {
          throw new TypeError(`Unsupported preset field: ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], stack)}`;
      })
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function canonicalizeArray(
  value: readonly unknown[],
  stack: WeakSet<object>
): string {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Custom arrays and symbols are unsupported");
  }

  const expectedPropertyCount = value.length + 1;
  if (Object.getOwnPropertyNames(value).length !== expectedPropertyCount) {
    throw new TypeError("Array properties are unsupported");
  }

  return `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
}

function freezeCondition(
  condition: Readonly<NormalizedCondition>
): Readonly<NormalizedCondition> {
  return Object.freeze({
    layer: condition.layer,
    supports: condition.supports,
    media: condition.media,
    container: condition.container,
    selector: condition.selector
  });
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.getPrototypeOf(prototype) === null
  );
}

function isPosixRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== ".."
      )
  );
}

import { parsePresetOriginId } from "./presetCanonical.js";
import type {
  PresetAtomId,
  PresetContentHash,
  PresetNodeId,
  PresetOriginId
} from "./types.js";

export function readRecord(
  value: unknown,
  path: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throwInvalid(path, "expected a plain record");
  }

  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  ) {
    throwInvalid(path, "contains unsupported fields");
  }

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throwInvalid(`${path}.${key}`, "accessors are unsupported");
    }
  }

  return value;
}

export function readArray(value: unknown, path: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  ) {
    throwInvalid(path, "expected an array");
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throwInvalid(
        `${path}[${index}]`,
        "array holes and accessors are unsupported"
      );
    }
  }

  return value;
}

export function readOrigin(value: unknown, path: string): PresetOriginId {
  const origin = readString(value, path);

  try {
    return parsePresetOriginId(origin);
  } catch (error) {
    if (error instanceof TypeError) throwInvalid(path, error.message);
    throw error;
  }
}

export function readNodeId(value: unknown, path: string): PresetNodeId {
  return readHash(value, path) as PresetNodeId;
}

export function readContentHash(
  value: unknown,
  path: string
): PresetContentHash {
  return readHash(value, path) as PresetContentHash;
}

export function readAtomId(value: unknown, path: string): PresetAtomId {
  return readHash(value, path) as PresetAtomId;
}

function readHash(value: unknown, path: string): string {
  const hash = readString(value, path);
  if (!/^[a-f0-9]{64}$/.test(hash))
    throwInvalid(path, "expected a SHA-256 hash");
  return hash;
}

export function readNullableString(
  value: unknown,
  path: string
): string | null {
  return value === null ? null : readString(value, path);
}

export function readString(value: unknown, path: string): string {
  if (typeof value !== "string") throwInvalid(path, "expected a string");
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.getPrototypeOf(prototype) === null
  );
}

export function throwInvalid(path: string, reason: string): never {
  throw new TypeError(`Invalid defineRules preset at ${path}: ${reason}`);
}

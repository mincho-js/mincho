import { cx as rootCx, createCx } from "../classname/cx.js";
import { RuntimeCache } from "../runtime/cache.js";
import type { ClassValue } from "../classname/types.js";
import type { Cx } from "../classname/index.js";
import type { DefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";

type CxIndexes = {
  classWrites: Map<string, number>;
  segments: Map<string, readonly number[]>;
  markerByWrites: Map<string, string>;
};

type CachedResult = string | readonly number[];

/* @__NO_SIDE_EFFECTS__ */
export const createDefineRulesCxRuntime = (
  artifact: DefineRulesCxRuntimeArtifact
): Cx => {
  // Preserve eager snapshots for the directly callable mutable factory.
  const indexes = createIndexes(artifact);

  return createCx((...inputs) => mergeClassNames(rootCx(...inputs), indexes));
};

/** Compiler-only factory: serialized artifacts are private and immutable. */
/* @__NO_SIDE_EFFECTS__ */
export const createCompiledDefineRulesCxRuntime = (
  artifact: DefineRulesCxRuntimeArtifact
): Cx => {
  let indexes: CxIndexes | undefined;
  let cache: RuntimeCache<CachedResult> | undefined;

  return createCx((...inputs: ClassValue[]) => {
    // clsx may invoke getters or callbacks; normalization must run on cache hits.
    const input = rootCx(...inputs);
    indexes ??= createIndexes(artifact);
    cache ??= new RuntimeCache();

    const cacheable = input.length <= 4096;
    const key = `r:${input}`;

    if (cacheable) {
      const cached = cache.get(key);
      if (typeof cached === "string") return cached;
    }

    const result = mergeClassNames(
      input,
      indexes,
      cacheable ? cache : undefined
    );

    if (cacheable) cache.set(key, result, result.length);

    return result;
  });
};

function createIndexes(artifact: DefineRulesCxRuntimeArtifact): CxIndexes {
  const classWrites = new Map(artifact.classWrites);
  const segments = new Map(artifact.segments ?? []);
  const markerByWrites = new Map<string, string>();

  for (const [marker, writes] of segments) {
    const writeSequence = writes.join(",");
    const existingMarker = markerByWrites.get(writeSequence);

    if (existingMarker === undefined || marker < existingMarker) {
      markerByWrites.set(writeSequence, marker);
    }
  }

  return { classWrites, segments, markerByWrites };
}

function mergeClassNames(
  input: string,
  { classWrites, segments, markerByWrites }: CxIndexes,
  cache?: RuntimeCache<CachedResult>
): string {
  const tokens = input.trim().split(/\s+/);
  const classNames: string[] = [];
  const writeIds: (number | undefined)[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;

    const segment = segments.get(token);

    if (segment === undefined) {
      classNames.push(token);
      writeIds.push(classWrites.get(token));
      continue;
    }

    const valid = validateSegment(tokens, index, segment, classWrites, cache);

    if (!valid) {
      classNames.push(token);
      writeIds.push(undefined);
      continue;
    }

    for (let offset = 0; offset < segment.length; offset += 1) {
      // Match the legacy treatment of sparse segment arrays.
      if (segment[offset] !== undefined) {
        classNames.push(tokens[index + offset + 1]);
        writeIds.push(segment[offset]);
      }
    }

    index += segment.length;
  }

  const seenWrites = new Set<number>();
  const kept: string[] = [];
  const keptWrites: number[] = [];
  let hasUnknown = false;

  for (let index = classNames.length - 1; index >= 0; index -= 1) {
    const writeId = writeIds[index];

    if (writeId === undefined) {
      hasUnknown = true;
      kept.push(classNames[index]);
    } else if (!seenWrites.has(writeId)) {
      seenWrites.add(writeId);
      kept.push(classNames[index]);
      keptWrites.push(writeId);
    }
  }

  const className = kept.reverse().join(" ");
  if (hasUnknown) return className;

  const marker = markerByWrites.get(keptWrites.reverse().join(","));

  return marker === undefined ? className : `${marker} ${className}`;
}

function validateSegment(
  tokens: readonly string[],
  start: number,
  writes: readonly number[],
  classWrites: ReadonlyMap<string, number>,
  cache?: RuntimeCache<CachedResult>
): boolean {
  if (start + writes.length >= tokens.length) return false;

  let key = "";

  if (cache !== undefined) {
    key = `s:${tokens[start]}`;

    for (let offset = 0; offset < writes.length; offset += 1) {
      key += ` ${tokens[start + offset + 1]}`;
    }

    if (cache.get(key) !== undefined) return true;
  }

  for (let offset = 0; offset < writes.length; offset += 1) {
    if (classWrites.get(tokens[start + offset + 1]) !== writes[offset]) {
      return false;
    }
  }

  // Tokens are retained by the key; writes reference the immutable artifact.
  cache?.set(key, writes, 0);

  return true;
}

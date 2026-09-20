import { clsx } from "clsx";
import { cx as rootCx, createCx, attachCxHelpers } from "../classname/cx.js";
import { CxCache } from "../runtime/cxCache.js";
import { CxArguments } from "../runtime/cxArguments.js";
import { CxWrites } from "../runtime/cxWrites.js";
import {
  createCxTokenBuffer,
  isWhitespace,
  mergeTokenSpans
} from "../runtime/cxTokens.js";
import type { CxTokenBuffer } from "../runtime/cxTokens.js";
import type { ClassValue } from "../classname/types.js";
import type { Cx } from "../classname/index.js";
import type { DefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";

type CxIndexes = {
  classWrites: Map<string, number>;
  segments: Map<string, readonly number[]>;
  markerByWrites: Map<string, string>;
};

type CxFragment = {
  tokens: readonly string[];
  writes: readonly (number | undefined)[];
  normalized: boolean;
};

type CachedResult = string | readonly number[] | CxFragment | false;

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
  let cache: CxCache<CachedResult> | undefined;
  let argumentsCache: CxArguments | null | undefined;
  let writes: CxWrites | null | undefined;
  let tokens: CxTokenBuffer | null | undefined;
  let merges = 0;
  let retryEntry: object | undefined;
  let retryHits = 0;
  let retried = false;

  const mergeInputs = (...inputs: ClassValue[]): string => {
    // Normalize mutable values on every call, in their original order. Only
    // the resulting strings can participate in tuple reuse.
    let resolved = false;

    if (inputs.length === 1 && Array.isArray(inputs[0])) {
      const source = inputs[0];
      const length = source.length;
      inputs = [];

      for (let index = 0; index < length; index += 1) {
        // clsx snapshots length and reads truthy array slots twice. A getter
        // may change its value between reads, including to zero or NaN.
        if (source[index]) {
          const value = source[index];
          inputs.push(typeof value === "number" ? "" + value : clsx(value));
        }
      }

      resolved = true;
    }

    for (let index = 0; index < inputs.length; index += 1) {
      const value = inputs[index];

      if (value && typeof value !== "string") {
        inputs[index] = clsx(value);
        resolved = true;
      }
    }

    const scalarCandidate = inputs.length > 1 && inputs.length <= 8;

    if (scalarCandidate && argumentsCache !== null) {
      if (argumentsCache === undefined && CxArguments.accepts(inputs)) {
        (cache ??= new CxCache()).reserveArguments();
        argumentsCache = new CxArguments(cache);
      }

      // Direct scalar calls already tried prediction. Resolved objects and
      // arrays can now match strings, so try their normalized tuples too.
      if (resolved && argumentsCache != null) {
        const predicted =
          inputs.length <= 3
            ? argumentsCache.getPredicted(inputs[0], inputs[1], inputs[2])
            : argumentsCache.getPredictedEight(
                inputs[0],
                inputs[1],
                inputs[2],
                inputs[3],
                inputs[4],
                inputs[5],
                inputs[6],
                inputs[7]
              );
        if (predicted !== undefined) return predicted;
      }

      const cached = argumentsCache?.get(inputs, true);

      if (argumentsCache?.enabled === false) {
        argumentsCache = null;
        cache!.releaseArguments();
      }

      if (cached !== undefined) return cached;
    }

    const scalarInput = joinScalarInputs(inputs);
    const input = scalarInput!;
    indexes ??= createIndexes(artifact);
    cache ??= new CxCache();

    const cacheable = input.length <= 4096;
    const key = input;

    if (cacheable) {
      const entry = cache.getEntry(key);
      const cached = entry?.value;

      if (typeof cached === "string") {
        if (scalarCandidate) {
          if (!retried && argumentsCache === null) {
            retryHits = retryEntry === entry ? retryHits + 1 : 1;
            retryEntry = entry;

            if (retryHits === 32) {
              retryHits = 0;

              if (CxArguments.accepts(inputs)) {
                // One retry handles a changed workload without repeatedly
                // restarting tuples on low-reuse aliases.
                retried = true;
                retryEntry = undefined;
                argumentsCache = new CxArguments(cache);
                cache.reserveArguments();
              }
            }
          }

          argumentsCache?.set(inputs, cached);
        } else {
          retryEntry = undefined;
          retryHits = 0;
        }

        return cached;
      }
    }

    // Do not retain the probe after a miss could evict its result entry.
    retryEntry = undefined;
    retryHits = 0;

    // A one-off call or a factory served entirely by result/tuple hits never
    // needs a reusable buffer. Prepare it on the second actual merge.
    if (writes === undefined && merges > 0) {
      writes = CxWrites.create(indexes.classWrites);
    }

    // Learn only after repeated actual merges. Tuple-served factories do not
    // need another index, and unusual IDs retain the ordinary merge path.
    if (
      tokens === undefined &&
      merges >= 16 &&
      cacheable &&
      writes != null &&
      (argumentsCache == null || !scalarCandidate || scalarInput === undefined)
    ) {
      tokens = createCxTokenBuffer(indexes);
    }

    // Tuple hits already avoid token work. Prepare reusable fragments only
    // when tuples have proved ineffective, or cannot accept this call shape.
    const result =
      cacheable && writes != null && tokens != null && !tokens.active
        ? mergeTokenSpans(input, indexes, writes, tokens)
        : inputs.length > 1 &&
            (argumentsCache === null || !scalarCandidate || !cacheable) &&
            scalarInput !== undefined
          ? mergeFragments(
              input,
              inputs,
              indexes,
              cacheable ? cache : undefined,
              writes ?? undefined
            )
          : mergeClassNames(
              input,
              indexes,
              cacheable ? cache : undefined,
              writes ?? undefined
            );

    if (merges < 16) merges += 1;

    // A tuple entry already retains the result; do not duplicate it in the
    // normalized-string cache. Unsupported tuples still use the latter.
    if (scalarCandidate && argumentsCache?.set(inputs, result)) return result;

    if (cacheable) {
      argumentsCache?.releaseForResult(key.length + result.length);
      cache.set(key, result, result.length);
    }

    return result;
  };

  const callable = (...inputs: ClassValue[]): string => {
    if (
      (inputs.length === 2 || inputs.length === 3) &&
      argumentsCache != null
    ) {
      const cached = argumentsCache.getPredicted(
        inputs[0],
        inputs[1],
        inputs[2]
      );
      if (cached !== undefined) return cached;
    } else if (
      inputs.length > 3 &&
      inputs.length <= 8 &&
      argumentsCache?.canPredict
    ) {
      const cached = argumentsCache.getPredictedEight(
        inputs[0],
        inputs[1],
        inputs[2],
        inputs[3],
        inputs[4],
        inputs[5],
        inputs[6],
        inputs[7]
      );
      if (cached !== undefined) return cached;
    } else if (
      inputs.length === 1 &&
      typeof inputs[0] === "string" &&
      inputs[0].length <= 4096
    ) {
      const cached = cache?.get(inputs[0]);

      if (typeof cached === "string") {
        retryEntry = undefined;
        retryHits = 0;

        return cached;
      }
    }

    return mergeInputs(...inputs);
  };

  return attachCxHelpers(mergeInputs, callable);
};

function joinScalarInputs(inputs: ClassValue[]): string | undefined {
  let count = 0;

  for (const input of inputs) {
    if (!input) continue;
    if (typeof input !== "string") return undefined;

    count += 1;
  }

  // Compact only this call's rest array, after proving the whole input scalar.
  // An unsupported value must reach clsx with every original argument intact.
  if (count !== inputs.length) {
    let index = 0;

    for (const input of inputs) {
      if (input) inputs[index++] = input;
    }

    inputs.length = count;
  }

  return count === 1 ? (inputs[0] as string) : inputs.join(" ");
}

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
  cache?: CxCache<CachedResult>,
  writes?: CxWrites
): string {
  const tokens: string[] = [];

  // Track normalization during the scan so an unchanged merge can reuse input.
  let normalized = true;
  let start = 0;

  for (let index = 0; index <= input.length; index += 1) {
    const code = index < input.length ? input.charCodeAt(index) : 32;
    if (
      index < input.length &&
      ((code > 32 && code < 160) || !isWhitespace(code))
    )
      continue;

    if (index > start) tokens.push(input.slice(start, index));
    else normalized = false;

    if (index < input.length && code !== 32) normalized = false;

    start = index + 1;
  }

  const writeIds: (number | undefined)[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;

    const segment = segments.get(token);

    if (segment === undefined) {
      writeIds[index] = classWrites.get(token);
    } else if (validateSegment(tokens, index, segment, classWrites, cache)) {
      tokens[index] = "";
      normalized = false;

      for (let offset = 0; offset < segment.length; offset += 1) {
        const target = index + offset + 1;

        // Keep the direct factory's sparse arrays and accessor read order.
        if (segment[offset] !== undefined) writeIds[target] = segment[offset];
        else tokens[target] = "";
      }

      index += segment.length;
    } else {
      writeIds[index] = undefined;
    }
  }

  return mergeTokens(
    input,
    tokens,
    writeIds,
    normalized,
    markerByWrites,
    writes
  );
}

function mergeFragments(
  input: string,
  inputs: readonly ClassValue[],
  { classWrites, segments, markerByWrites }: CxIndexes,
  cache?: CxCache<CachedResult>,
  writes?: CxWrites
): string {
  const tokens: string[] = [];
  const writeIds: (number | undefined)[] = [];
  let normalized = true;

  for (const value of inputs) {
    if (!value) continue;

    const text = value as string;

    // Single tokens already carry their entire spelling. Do not retain fresh
    // external classes or allocate fragment records for ordinary atom names.
    if (!/\s/.test(text)) {
      tokens.push(text);
      writeIds.push(classWrites.get(text));
      continue;
    }

    const cached = cache?.get(text);
    const fragment =
      typeof cached === "object" && "tokens" in cached ? cached : undefined;

    if (fragment === undefined) {
      const from = tokens.length;
      let clean = true;
      let start = 0;
      let size = 0;

      for (let index = 0; index <= text.length; index += 1) {
        const code = index < text.length ? text.charCodeAt(index) : 32;
        if (
          index < text.length &&
          ((code > 32 && code < 160) || !isWhitespace(code))
        )
          continue;

        if (index > start) {
          const token = text.slice(start, index);
          tokens.push(token);
          writeIds.push(classWrites.get(token));
          size += token.length;
        } else clean = false;

        if (index < text.length && code !== 32) clean = false;

        start = index + 1;
      }

      normalized &&= clean;

      // A first sighting retains only its key. One-off SSR fragments scan
      // straight into the call's arrays without allocating reusable copies.
      // Both sightings and prepared fragments share the existing cache budget.
      if (cached === false) {
        cache!.set(
          text,
          {
            tokens: tokens.slice(from),
            writes: writeIds.slice(from),
            normalized: clean
          },
          size
        );
      } else cache?.set(text, false, 0);

      continue;
    }

    normalized &&= fragment.normalized;

    for (let index = 0; index < fragment.tokens.length; index += 1) {
      tokens.push(fragment.tokens[index]);
      writeIds.push(fragment.writes[index]);
    }
  }

  if (segments.size > 0) {
    for (let index = 0; index < tokens.length; index += 1) {
      const segment = segments.get(tokens[index]);
      if (segment === undefined) continue;

      let valid = index + segment.length < tokens.length;

      if (valid) {
        for (let offset = 0; offset < segment.length; offset += 1) {
          if (writeIds[index + offset + 1] !== segment[offset]) {
            valid = false;
            break;
          }
        }
      }

      if (!valid) {
        writeIds[index] = undefined;
        continue;
      }

      normalized = false;
      tokens[index] = "";

      for (let offset = 0; offset < segment.length; offset += 1) {
        const target = index + offset + 1;

        if (segment[offset] !== undefined) writeIds[target] = segment[offset];
        else tokens[target] = "";
      }

      index += segment.length;
    }
  }

  return mergeTokens(
    input,
    tokens,
    writeIds,
    normalized,
    markerByWrites,
    writes
  );
}

function mergeTokens(
  input: string,
  tokens: string[],
  writeIds: readonly (number | undefined)[],
  normalized: boolean,
  markerByWrites: ReadonlyMap<string, string>,
  writes?: CxWrites
): string {
  // Getters and reentrant input/segment reads have finished. Nothing in this
  // conflict loop calls user code, so nested calls cannot overwrite its marks.
  const marks = writes?.marks;
  const epoch = writes?.next();
  const seenWrites = marks === undefined ? new Set<number>() : undefined;
  let keptWrites = "";

  // Without segment markers, constructing a write-sequence string cannot
  // affect the result. Unknown classes likewise prevent marker synthesis.
  let canMark = markerByWrites.size > 0;

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.length === 0) continue;

    const writeId = writeIds[index];

    if (writeId === undefined) {
      canMark = false;
    } else {
      if (
        marks === undefined
          ? seenWrites!.has(writeId)
          : marks[writeId] === epoch
      ) {
        tokens[index] = "";
        normalized = false;
        continue;
      }

      if (marks === undefined) seenWrites!.add(writeId);
      else marks[writeId] = epoch!;

      if (canMark)
        keptWrites =
          keptWrites.length === 0
            ? String(writeId)
            : `${writeId},${keptWrites}`;
    }
  }

  const marker = canMark ? markerByWrites.get(keptWrites) : undefined;
  if (normalized && marker === undefined) return input;

  let keptCount = 0;

  for (const token of tokens) {
    if (token.length > 0) tokens[keptCount++] = token;
  }

  tokens.length = keptCount;

  // Materialize one result instead of retaining a chain of concatenations in
  // the caches. Compact the local token array rather than allocating another.
  const className = tokens.join(" ");

  return marker === undefined ? className : `${marker} ${className}`;
}

function validateSegment(
  tokens: readonly string[],
  start: number,
  writes: readonly number[],
  classWrites: ReadonlyMap<string, number>,
  cache?: CxCache<CachedResult>
): boolean {
  if (start + writes.length >= tokens.length) return false;

  let key = "";

  if (cache !== undefined) {
    key = `s:${tokens[start]}`;

    for (let offset = 0; offset < writes.length; offset += 1) {
      key += ` ${tokens[start + offset + 1]}`;
    }

    // Result keys need no prefix. A literal input may equal this segment key;
    // the value kind must match before trusting it as a validated segment.
    if (Array.isArray(cache.get(key))) return true;
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

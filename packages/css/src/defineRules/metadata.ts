import type { NormalizedCondition } from "./conditions.js";
import type {
  DefineRulesPresetArtifactV4,
  DefineRulesPresetCompiledEntry,
  DefineRulesPresetCompiledKnownEntry,
  DefineRulesPresetCompiledSegment,
  DefineRulesPresetCompiledUnknownEntry
} from "./types.js";

export type ConditionId = number;
export type PropertyId = number;
export type WriteKeyId = number;

export type CompiledKnownEntry = DefineRulesPresetCompiledKnownEntry & {
  writeKeyId: WriteKeyId;
};
export type CompiledUnknownEntry = DefineRulesPresetCompiledUnknownEntry;
export type CompiledEntry =
  | (DefineRulesPresetCompiledEntry & { kind: "known"; writeKeyId: WriteKeyId })
  | CompiledUnknownEntry;
export interface CompiledSegment extends DefineRulesPresetCompiledSegment {
  entries: CompiledEntry[];
}

export interface EngineMetadataOptions {
  segmentCacheSize?: number;
  fullResultCacheSize?: number;
  initialEpochCapacity?: number;
  initialEpoch?: number;
}

export interface EngineMetadata {
  internCondition(condition: NormalizedCondition): ConditionId;
  internProperty(property: string): PropertyId;
  internWriteKey(conditionId: ConditionId, propertyId: PropertyId): WriteKeyId;
  registerAtomicClass(className: string, writeKeyId: WriteKeyId): void;
  registerAtomicCacheEntry(
    cacheKey: string,
    className: string,
    writeKeyId: WriteKeyId
  ): void;
  hydrateAtomicClassesFromArtifact(
    artifact: Pick<
      DefineRulesPresetArtifactV4,
      "classNameByCache" | "writeKeyByCacheKey"
    >
  ): void;
  registerSegment(input: string, compiledSegment: CompiledSegment): void;
  getCompiledSegment(input: string): CompiledSegment;
  compileSegment(input: string): CompiledSegment;
  mergeCompiledSegments(segments: readonly CompiledSegment[]): string;
  mergeClassList(input: string): string;
  getCachedFullResult(input: string): string | undefined;
  setCachedFullResult(input: string, result: string): void;
  clearRuntimeCaches(): void;
  exportArtifact(): DefineRulesPresetArtifactV4;
  getWriteKeyIdForClassName(className: string): WriteKeyId | undefined;
  readonly segmentCacheSize: number;
  readonly fullResultCacheSize: number;
  readonly registeredSegmentSize: number;
}

const DEFAULT_SEGMENT_CACHE_SIZE = 2048;
const DEFAULT_FULL_RESULT_CACHE_SIZE = 4;
const MAX_EPOCH = 0xffffffff;

class BoundedLru<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = Math.max(0, maxSize);
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);

    if (value === undefined) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.maxSize === 0) {
      return;
    }

    this.entries.delete(key);
    this.entries.set(key, value);

    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();

      if (oldest.done) {
        return;
      }

      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createEngineMetadata(
  options: EngineMetadataOptions = {}
): EngineMetadata {
  const conditionIdByKey = new Map<string, ConditionId>();
  const propertyIdByKey = new Map<string, PropertyId>();
  const writeKeyIdByKey = new Map<string, WriteKeyId>();
  const classNameByCache: Record<string, string> = {};
  const writeKeyByCacheKey: Record<string, number> = {};
  const conditionById: Record<number, NormalizedCondition> = {};
  const propertyById: Record<number, string> = {};
  const writeKeyById: Record<
    number,
    { conditionId: number; propertyId: number }
  > = {};
  const writeKeyIdByClassName = new Map<string, WriteKeyId>();
  const registeredSegments = new Map<string, CompiledSegment>();
  const segmentCache = new BoundedLru<string, CompiledSegment>(
    options.segmentCacheSize ?? DEFAULT_SEGMENT_CACHE_SIZE
  );
  const fullResultCache = new BoundedLru<string, string>(
    options.fullResultCacheSize ?? DEFAULT_FULL_RESULT_CACHE_SIZE
  );
  let seenEpoch = new Uint32Array(options.initialEpochCapacity ?? 16);
  let currentEpoch = options.initialEpoch ?? 0;

  function internCondition(condition: NormalizedCondition): ConditionId {
    const key = conditionCacheKey(condition);
    const existing = conditionIdByKey.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const conditionId = conditionIdByKey.size;
    conditionIdByKey.set(key, conditionId);
    conditionById[conditionId] = { ...condition };
    return conditionId;
  }

  function internProperty(property: string): PropertyId {
    const existing = propertyIdByKey.get(property);

    if (existing !== undefined) {
      return existing;
    }

    const propertyId = propertyIdByKey.size;
    propertyIdByKey.set(property, propertyId);
    propertyById[propertyId] = property;
    return propertyId;
  }

  function internWriteKey(
    conditionId: ConditionId,
    propertyId: PropertyId
  ): WriteKeyId {
    const key = `${conditionId}:${propertyId}`;
    const existing = writeKeyIdByKey.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const writeKeyId = writeKeyIdByKey.size;
    writeKeyIdByKey.set(key, writeKeyId);
    writeKeyById[writeKeyId] = { conditionId, propertyId };
    return writeKeyId;
  }

  function registerAtomicClass(
    className: string,
    writeKeyId: WriteKeyId
  ): void {
    writeKeyIdByClassName.set(className, writeKeyId);
    clearRuntimeCaches();
  }

  function registerAtomicCacheEntry(
    cacheKey: string,
    className: string,
    writeKeyId: WriteKeyId
  ): void {
    classNameByCache[cacheKey] = className;
    writeKeyByCacheKey[cacheKey] = writeKeyId;
    registerAtomicClass(className, writeKeyId);
  }

  function hydrateAtomicClassesFromArtifact(
    artifact: Pick<
      DefineRulesPresetArtifactV4,
      "classNameByCache" | "writeKeyByCacheKey"
    >
  ): void {
    for (const [cacheKey, className] of Object.entries(
      artifact.classNameByCache
    )) {
      const writeKeyId = artifact.writeKeyByCacheKey[cacheKey];

      if (typeof writeKeyId === "number") {
        registerAtomicClass(className, writeKeyId);
      }
    }
  }

  function registerSegment(
    input: string,
    compiledSegment: CompiledSegment
  ): void {
    registeredSegments.set(input, compiledSegment);
    fullResultCache.delete(input);
  }

  function getCompiledSegment(input: string): CompiledSegment {
    const registeredSegment = registeredSegments.get(input);

    if (registeredSegment !== undefined) {
      return registeredSegment;
    }

    const cachedSegment = segmentCache.get(input);

    if (cachedSegment !== undefined) {
      return cachedSegment;
    }

    const compiledSegment = compileSegment(input);
    segmentCache.set(input, compiledSegment);
    return compiledSegment;
  }

  function compileSegment(input: string): CompiledSegment {
    const entries: CompiledEntry[] = [];
    const trimmed = input.trim();

    if (trimmed.length === 0) {
      return { entries, hasKnownAtomicClass: false };
    }

    let hasKnownAtomicClass = false;

    for (const className of trimmed.split(/\s+/)) {
      const writeKeyId = writeKeyIdByClassName.get(className);

      if (writeKeyId === undefined) {
        entries.push({ kind: "unknown", className });
        continue;
      }

      hasKnownAtomicClass = true;
      entries.push({ kind: "known", className, writeKeyId });
    }

    return { entries, hasKnownAtomicClass };
  }

  function mergeCompiledSegments(segments: readonly CompiledSegment[]): string {
    const epoch = nextEpoch();
    const keptEntries: CompiledEntry[] = [];

    for (
      let segmentIndex = segments.length - 1;
      segmentIndex >= 0;
      segmentIndex -= 1
    ) {
      const segment = segments[segmentIndex];

      if (segment == null) {
        continue;
      }

      for (
        let entryIndex = segment.entries.length - 1;
        entryIndex >= 0;
        entryIndex -= 1
      ) {
        const entry = segment.entries[entryIndex];

        if (entry == null) {
          continue;
        }

        if (entry.kind === "unknown") {
          keptEntries.push(entry);
          continue;
        }

        ensureSeenEpochCapacity(entry.writeKeyId);

        if (seenEpoch[entry.writeKeyId] === epoch) {
          continue;
        }

        seenEpoch[entry.writeKeyId] = epoch;
        keptEntries.push(entry);
      }
    }

    return keptEntries
      .reverse()
      .map((entry) => entry.className)
      .join(" ");
  }

  function mergeClassList(input: string): string {
    const cachedResult = fullResultCache.get(input);

    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const result = mergeCompiledSegments([getCompiledSegment(input)]);
    fullResultCache.set(input, result);
    return result;
  }

  function getCachedFullResult(input: string): string | undefined {
    return fullResultCache.get(input);
  }

  function setCachedFullResult(input: string, result: string): void {
    fullResultCache.set(input, result);
  }

  function clearRuntimeCaches(): void {
    segmentCache.clear();
    fullResultCache.clear();
  }

  function exportArtifact(): DefineRulesPresetArtifactV4 {
    return {
      schema: "mincho.defineRulesPreset",
      version: 4,
      classNameByCache: { ...classNameByCache },
      writeKeyByCacheKey: { ...writeKeyByCacheKey },
      conditionById: cloneConditionById(conditionById),
      propertyById: { ...propertyById },
      writeKeyById: cloneWriteKeyById(writeKeyById)
    };
  }

  function getWriteKeyIdForClassName(
    className: string
  ): WriteKeyId | undefined {
    return writeKeyIdByClassName.get(className);
  }

  function nextEpoch(): number {
    currentEpoch += 1;

    if (currentEpoch >= MAX_EPOCH) {
      seenEpoch.fill(0);
      currentEpoch = 1;
    }

    return currentEpoch;
  }

  function ensureSeenEpochCapacity(writeKeyId: WriteKeyId): void {
    if (writeKeyId < seenEpoch.length) {
      return;
    }

    let nextLength = Math.max(1, seenEpoch.length);

    while (writeKeyId >= nextLength) {
      nextLength *= 2;
    }

    const nextSeenEpoch = new Uint32Array(nextLength);
    nextSeenEpoch.set(seenEpoch);
    seenEpoch = nextSeenEpoch;
  }

  return {
    internCondition,
    internProperty,
    internWriteKey,
    registerAtomicClass,
    registerAtomicCacheEntry,
    hydrateAtomicClassesFromArtifact,
    registerSegment,
    getCompiledSegment,
    compileSegment,
    mergeCompiledSegments,
    mergeClassList,
    getCachedFullResult,
    setCachedFullResult,
    clearRuntimeCaches,
    exportArtifact,
    getWriteKeyIdForClassName,
    get segmentCacheSize() {
      return segmentCache.size;
    },
    get fullResultCacheSize() {
      return fullResultCache.size;
    },
    get registeredSegmentSize() {
      return registeredSegments.size;
    }
  };
}

function conditionCacheKey(condition: NormalizedCondition): string {
  return JSON.stringify([
    condition.layer,
    condition.supports,
    condition.media,
    condition.container,
    condition.selector
  ]);
}

function cloneConditionById(
  conditionById: Record<number, NormalizedCondition>
): Record<number, NormalizedCondition> {
  const clone: Record<number, NormalizedCondition> = {};

  for (const [conditionId, condition] of Object.entries(conditionById)) {
    clone[Number(conditionId)] = { ...condition };
  }

  return clone;
}

function cloneWriteKeyById(
  writeKeyById: Record<number, { conditionId: number; propertyId: number }>
): Record<number, { conditionId: number; propertyId: number }> {
  const clone: Record<number, { conditionId: number; propertyId: number }> = {};

  for (const [writeKeyId, writeKey] of Object.entries(writeKeyById)) {
    clone[Number(writeKeyId)] = { ...writeKey };
  }

  return clone;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, assertType } = import.meta.vitest;

  function baseCondition(
    overrides: Partial<NormalizedCondition> = {}
  ): NormalizedCondition {
    return {
      layer: null,
      supports: null,
      media: null,
      container: null,
      selector: "&",
      ...overrides
    };
  }

  function registerAtomicPair(
    metadata: EngineMetadata,
    property: string,
    firstClassName: string,
    secondClassName: string
  ) {
    const conditionId = metadata.internCondition(baseCondition());
    const propertyId = metadata.internProperty(property);
    const writeKeyId = metadata.internWriteKey(conditionId, propertyId);

    metadata.registerAtomicCacheEntry(
      `${property}:first`,
      firstClassName,
      writeKeyId
    );
    metadata.registerAtomicCacheEntry(
      `${property}:second`,
      secondClassName,
      writeKeyId
    );

    return writeKeyId;
  }

  describe("createEngineMetadata", () => {
    it("interns identical normalized condition tuples to the same condition ID", () => {
      const metadata = createEngineMetadata();
      const firstId = metadata.internCondition(
        baseCondition({ media: "screen and (min-width: 768px)" })
      );
      const secondId = metadata.internCondition(
        baseCondition({ media: "screen and (min-width: 768px)" })
      );
      const differentId = metadata.internCondition(
        baseCondition({ media: "screen and (min-width: 1024px)" })
      );

      expect(secondId).toBe(firstId);
      expect(differentId).not.toBe(firstId);
    });

    it("interns write keys by condition and transformed property only", () => {
      const metadata = createEngineMetadata();
      const conditionId = metadata.internCondition(baseCondition());
      const propertyId = metadata.internProperty("paddingLeft");
      const firstWriteKeyId = metadata.internWriteKey(conditionId, propertyId);
      const secondWriteKeyId = metadata.internWriteKey(conditionId, propertyId);

      metadata.registerAtomicCacheEntry(
        "paddingLeft:4",
        "pl_4",
        firstWriteKeyId
      );
      metadata.registerAtomicCacheEntry(
        "paddingLeft:8",
        "pl_8",
        secondWriteKeyId
      );

      expect(secondWriteKeyId).toBe(firstWriteKeyId);
      expect(metadata.exportArtifact().writeKeyByCacheKey).toEqual({
        "paddingLeft:4": firstWriteKeyId,
        "paddingLeft:8": firstWriteKeyId
      });
    });

    it("compiles unknown entries unchanged and known entries from hydrated runtime lookup", () => {
      const source = createEngineMetadata();
      const writeKeyId = registerAtomicPair(
        source,
        "color",
        "color_red",
        "color_blue"
      );
      const runtime = createEngineMetadata();

      runtime.hydrateAtomicClassesFromArtifact(source.exportArtifact());

      expect(runtime.compileSegment("external color_red external")).toEqual({
        entries: [
          { kind: "unknown", className: "external" },
          { kind: "known", className: "color_red", writeKeyId },
          { kind: "unknown", className: "external" }
        ],
        hasKnownAtomicClass: true
      });
    });

    it("merges using hydrated runtime state after dropping preset artifact maps", () => {
      const source = createEngineMetadata();
      registerAtomicPair(source, "color", "color_red", "color_blue");
      const artifact = source.exportArtifact();
      const runtime = createEngineMetadata();

      runtime.hydrateAtomicClassesFromArtifact(artifact);
      artifact.classNameByCache = {};
      artifact.writeKeyByCacheKey = {};
      artifact.conditionById = {};
      artifact.propertyById = {};
      artifact.writeKeyById = {};

      expect(
        runtime.mergeClassList("before color_red middle color_blue after")
      ).toBe("before middle color_blue after");
    });

    it("checks registered segments before the bounded segment LRU", () => {
      const metadata = createEngineMetadata();
      const input = "same-instance";
      const cachedSegment = metadata.getCompiledSegment(input);
      const registeredSegment: CompiledSegment = {
        entries: [
          { kind: "known", className: input, writeKeyId: 12 as WriteKeyId }
        ],
        hasKnownAtomicClass: true
      };

      metadata.registerSegment(input, registeredSegment);

      expect(cachedSegment).toEqual({
        entries: [{ kind: "unknown", className: input }],
        hasKnownAtomicClass: false
      });
      expect(metadata.getCompiledSegment(input)).toBe(registeredSegment);
    });

    it("invalidates only the matching full-result cache entry when registering a segment", () => {
      const metadata = createEngineMetadata();
      const input = "same-instance";
      const otherInput = "other-instance";
      const registeredSegment: CompiledSegment = {
        entries: [{ kind: "unknown", className: "registered-instance" }],
        hasKnownAtomicClass: false
      };

      expect(metadata.mergeClassList(input)).toBe(input);
      expect(metadata.mergeClassList(otherInput)).toBe(otherInput);
      expect(metadata.segmentCacheSize).toBe(2);
      expect(metadata.fullResultCacheSize).toBe(2);

      metadata.registerSegment(input, registeredSegment);

      expect(metadata.segmentCacheSize).toBe(2);
      expect(metadata.fullResultCacheSize).toBe(1);
      expect(metadata.getCachedFullResult(input)).toBe(undefined);
      expect(metadata.getCachedFullResult(otherInput)).toBe(otherInput);
      expect(metadata.mergeClassList(input)).toBe("registered-instance");
    });

    it("evicts the oldest external segment after 2048 unique segment cache entries", () => {
      const metadata = createEngineMetadata();
      const originalSegment = metadata.getCompiledSegment("evict-me");

      for (let index = 0; index < DEFAULT_SEGMENT_CACHE_SIZE; index += 1) {
        metadata.getCompiledSegment(`external-${index}`);
      }

      expect(metadata.segmentCacheSize).toBe(DEFAULT_SEGMENT_CACHE_SIZE);
      expect(metadata.getCompiledSegment("evict-me")).not.toBe(originalSegment);
    });

    it("caches full merge results and evicts them after four newer flattened inputs", () => {
      const metadata = createEngineMetadata();

      expect(metadata.getCachedFullResult("repeat")).toBe(undefined);
      expect(metadata.mergeClassList("repeat")).toBe("repeat");
      expect(metadata.mergeClassList("repeat")).toBe("repeat");
      expect(metadata.getCachedFullResult("repeat")).toBe("repeat");

      for (let index = 0; index < DEFAULT_FULL_RESULT_CACHE_SIZE; index += 1) {
        metadata.mergeClassList(`flattened-${index}`);
      }

      expect(metadata.fullResultCacheSize).toBe(DEFAULT_FULL_RESULT_CACHE_SIZE);
      expect(metadata.getCachedFullResult("repeat")).toBe(undefined);
    });

    it("clears stale segment and full-result caches when atomics are registered or hydrated", () => {
      const metadata = createEngineMetadata();
      const conditionId = metadata.internCondition(baseCondition());
      const propertyId = metadata.internProperty("color");
      const writeKeyId = metadata.internWriteKey(conditionId, propertyId);

      expect(metadata.mergeClassList("color_red color_blue")).toBe(
        "color_red color_blue"
      );
      expect(metadata.segmentCacheSize).toBeGreaterThan(0);
      expect(metadata.fullResultCacheSize).toBeGreaterThan(0);

      metadata.registerAtomicClass("color_red", writeKeyId);

      expect(metadata.segmentCacheSize).toBe(0);
      expect(metadata.fullResultCacheSize).toBe(0);

      metadata.registerAtomicClass("color_blue", writeKeyId);

      expect(metadata.mergeClassList("color_red color_blue")).toBe(
        "color_blue"
      );

      const source = createEngineMetadata();
      registerAtomicPair(source, "display", "display_block", "display_flex");
      const hydrated = createEngineMetadata();

      hydrated.mergeClassList("display_block display_flex");
      expect(hydrated.segmentCacheSize).toBeGreaterThan(0);
      expect(hydrated.fullResultCacheSize).toBeGreaterThan(0);

      hydrated.hydrateAtomicClassesFromArtifact(source.exportArtifact());

      expect(hydrated.segmentCacheSize).toBe(0);
      expect(hydrated.fullResultCacheSize).toBe(0);
      expect(hydrated.mergeClassList("display_block display_flex")).toBe(
        "display_flex"
      );
    });

    it("serializes only artifact-safe V4 metadata keys", () => {
      const metadata = createEngineMetadata();
      registerAtomicPair(metadata, "color", "color_red", "color_blue");

      metadata.registerSegment("color_red", {
        entries: [{ kind: "unknown", className: "color_red" }],
        hasKnownAtomicClass: false
      });
      metadata.mergeClassList("color_red");

      const artifact = metadata.exportArtifact();
      const serializedArtifact = JSON.stringify(artifact);

      expect(Object.keys(artifact)).toEqual([
        "schema",
        "version",
        "classNameByCache",
        "writeKeyByCacheKey",
        "conditionById",
        "propertyById",
        "writeKeyById"
      ]);
      expect(serializedArtifact).not.toContain("registeredSegments");
      expect(serializedArtifact).not.toContain("segmentCache");
      expect(serializedArtifact).not.toContain("fullResultCache");
    });

    it("grows epoch arrays and resets the epoch counter before overflow reuse", () => {
      const metadata = createEngineMetadata({
        initialEpoch: MAX_EPOCH - 1,
        initialEpochCapacity: 1
      });
      const segment: CompiledSegment = {
        entries: [
          { kind: "known", className: "old", writeKeyId: 4096 },
          { kind: "known", className: "new", writeKeyId: 4096 }
        ],
        hasKnownAtomicClass: true
      };

      expect(metadata.mergeCompiledSegments([segment])).toBe("new");
      expect(metadata.mergeCompiledSegments([segment])).toBe("new");
    });

    it("exposes artifact-safe compiled segment types without private runtime interfaces", () => {
      const segment: DefineRulesPresetCompiledSegment = {
        entries: [
          { kind: "unknown", className: "external" },
          { kind: "known", className: "color_red", writeKeyId: 0 }
        ],
        hasKnownAtomicClass: true
      };

      assertType<DefineRulesPresetCompiledSegment>(segment);
    });
  });
}

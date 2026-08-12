import type { NormalizedCondition } from "./conditions.js";
import type {
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
  marker?: string;
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
  registerSegment(
    input: string,
    compiledSegment: CompiledSegment
  ): string | undefined;
  getRegisteredSegment(input: string): CompiledSegment | undefined;
  getSegmentByMarker(marker: string): CompiledSegment | undefined;
  getRegisteredSegmentsByMarker(): ReadonlyMap<string, CompiledSegment>;
  getSegmentByMarkerToken(token: string): CompiledSegment | undefined;
  getCompiledSegment(input: string): CompiledSegment;
  compileSegment(input: string): CompiledSegment;
  mergeCompiledSegments(segments: readonly CompiledSegment[]): string;
  mergeClassList(input: string): string;
  getCachedFullResult(input: string): string | undefined;
  setCachedFullResult(input: string, result: string): void;
  clearRuntimeCaches(): void;
  getWriteKeyIdForClassName(className: string): WriteKeyId | undefined;
  readonly segmentCacheSize: number;
  readonly fullResultCacheSize: number;
  readonly registeredSegmentSize: number;
}

const DEFAULT_SEGMENT_CACHE_SIZE = 2048;
const DEFAULT_FULL_RESULT_CACHE_SIZE = 4;
const MAX_EPOCH = 0xffffffff;
export const SEGMENT_MARKER_PREFIX = "__mincho_seg_";

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

  set(key: K, value: V): readonly [K, V] | undefined {
    if (this.maxSize === 0) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, value);

    let evicted: readonly [K, V] | undefined;

    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.entries().next();

      if (oldest.done) {
        return evicted;
      }

      evicted = oldest.value;
      this.entries.delete(oldest.value[0]);
    }

    return evicted;
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

type CachedCompiledSegment = {
  readonly segment: CompiledSegment;
  readonly atomicRegistryVersion: number;
};

type CachedFullResult = {
  readonly result: string;
  readonly hasUnknownClass: boolean;
  readonly atomicRegistryVersion: number;
};

type CachedTransientSegment = {
  readonly marker: string;
  readonly segment: CompiledSegment;
};

export function createEngineMetadata(
  options: EngineMetadataOptions = {}
): EngineMetadata {
  const conditionIdByKey = new Map<string, ConditionId>();
  const propertyIdByKey = new Map<string, PropertyId>();
  const writeKeyIdByKey = new Map<string, WriteKeyId>();
  const conditionById: Record<number, NormalizedCondition> = {};
  const propertyById: Record<number, string> = {};
  const writeKeyById: Record<
    number,
    { conditionId: number; propertyId: number }
  > = {};
  const writeKeyIdByClassName = new Map<string, WriteKeyId>();
  const registeredSegments = new Map<string, CompiledSegment>();
  const segmentByMarker = new Map<string, CompiledSegment>();
  const markerBySegmentPayload = new Map<string, string>();
  const segmentPayloadByMarker = new Map<string, string>();
  const segmentCacheSize =
    options.segmentCacheSize ?? DEFAULT_SEGMENT_CACHE_SIZE;
  const segmentCache = new BoundedLru<string, CachedCompiledSegment>(
    segmentCacheSize
  );
  const fullResultCache = new BoundedLru<string, CachedFullResult>(
    options.fullResultCacheSize ?? DEFAULT_FULL_RESULT_CACHE_SIZE
  );
  const segmentMarkerPayloadCache = new BoundedLru<string, string>(
    segmentCacheSize
  );
  const transientSegmentByPayload = new BoundedLru<
    string,
    CachedTransientSegment
  >(segmentCacheSize);
  const transientPayloadByMarker = new Map<string, string>();
  let seenEpoch = new Uint32Array(options.initialEpochCapacity ?? 16);
  let currentEpoch = options.initialEpoch ?? 0;
  let atomicRegistryVersion = 0;

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
    registerSegment(className, {
      entries: [{ kind: "known", className, writeKeyId }],
      hasKnownAtomicClass: true
    });
    atomicRegistryVersion += 1;
  }

  function registerSegment(
    input: string,
    compiledSegment: CompiledSegment
  ): string | undefined {
    const registeredSegment = withRegisteredMarker(compiledSegment);

    registeredSegments.set(input, registeredSegment);
    fullResultCache.delete(input);

    if (registeredSegment.marker === undefined) {
      return undefined;
    }

    segmentByMarker.set(registeredSegment.marker, registeredSegment);

    const markerClassName = joinClassNames(
      registeredSegment.marker,
      serializeSegmentEntries(registeredSegment.entries)
    );

    registeredSegments.set(markerClassName, registeredSegment);
    fullResultCache.delete(markerClassName);
    return registeredSegment.marker;
  }

  function getRegisteredSegment(input: string): CompiledSegment | undefined {
    return registeredSegments.get(input);
  }

  function getSegmentByMarker(marker: string): CompiledSegment | undefined {
    const registeredSegment = segmentByMarker.get(marker);

    if (registeredSegment !== undefined) {
      return registeredSegment;
    }

    const payload = transientPayloadByMarker.get(marker);

    if (payload === undefined) {
      return undefined;
    }

    const cachedSegment = transientSegmentByPayload.get(payload);

    if (cachedSegment === undefined || cachedSegment.marker !== marker) {
      transientPayloadByMarker.delete(marker);
      return undefined;
    }

    return cachedSegment.segment;
  }

  function getRegisteredSegmentsByMarker(): ReadonlyMap<
    string,
    CompiledSegment
  > {
    return segmentByMarker;
  }

  function getSegmentByMarkerToken(token: string): CompiledSegment | undefined {
    return token.startsWith(SEGMENT_MARKER_PREFIX)
      ? getSegmentByMarker(token)
      : undefined;
  }

  function getCompiledSegment(input: string): CompiledSegment {
    const registeredSegment = registeredSegments.get(input);

    if (registeredSegment !== undefined) {
      return registeredSegment;
    }

    const cachedSegment = segmentCache.get(input);

    if (cachedSegment !== undefined) {
      if (isCachedSegmentFresh(cachedSegment)) {
        return cachedSegment.segment;
      }

      segmentCache.delete(input);
    }

    const compiledSegment = compileSegment(input);
    segmentCache.set(input, {
      segment: compiledSegment,
      atomicRegistryVersion
    });
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
      const markedSegment = getSegmentByMarker(className);

      if (markedSegment !== undefined) {
        entries.push(...markedSegment.entries);
        hasKnownAtomicClass ||= markedSegment.hasKnownAtomicClass;
        continue;
      }

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
    if (segments.length === 0) {
      return "";
    }

    if (segments.length === 1) {
      const segment = segments[0];

      return segment === undefined ? "" : mergeCompiledEntries(segment.entries);
    }

    const epoch = nextEpoch();
    const keptEntries: CompiledEntry[] = [];

    for (
      let segmentIndex = segments.length - 1;
      segmentIndex >= 0;
      segmentIndex -= 1
    ) {
      const segment = segments[segmentIndex];

      if (segment === undefined) {
        continue;
      }

      for (
        let entryIndex = segment.entries.length - 1;
        entryIndex >= 0;
        entryIndex -= 1
      ) {
        keepMergedEntry(keptEntries, segment.entries[entryIndex], epoch);
      }
    }

    return serializeMergedEntries(keptEntries);
  }

  function mergeCompiledEntries(entries: readonly CompiledEntry[]): string {
    const epoch = nextEpoch();
    const keptEntries: CompiledEntry[] = [];

    for (
      let entryIndex = entries.length - 1;
      entryIndex >= 0;
      entryIndex -= 1
    ) {
      keepMergedEntry(keptEntries, entries[entryIndex], epoch);
    }

    return serializeMergedEntries(keptEntries);
  }

  function keepMergedEntry(
    keptEntries: CompiledEntry[],
    entry: CompiledEntry | undefined,
    epoch: number
  ): void {
    if (entry === undefined) {
      return;
    }

    if (entry.kind === "unknown") {
      keptEntries.push(entry);
      return;
    }

    ensureSeenEpochCapacity(entry.writeKeyId);

    if (seenEpoch[entry.writeKeyId] === epoch) {
      return;
    }

    seenEpoch[entry.writeKeyId] = epoch;
    keptEntries.push(entry);
  }

  function serializeMergedEntries(keptEntries: CompiledEntry[]): string {
    const entries = keptEntries.reverse();
    const classList = serializeSegmentEntries(entries);
    const marker = getTransientMarkerForEntries(entries);

    return marker === undefined ? classList : joinClassNames(marker, classList);
  }

  function mergeClassList(input: string): string {
    const cachedResult = getCachedFullResult(input);

    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const segment = getCompiledSegment(input);
    const result = mergeCompiledSegments([segment]);
    fullResultCache.set(input, {
      result,
      hasUnknownClass: hasUnknownEntry(segment.entries),
      atomicRegistryVersion
    });
    return result;
  }

  function getCachedFullResult(input: string): string | undefined {
    const cachedResult = fullResultCache.get(input);

    if (cachedResult === undefined) {
      return undefined;
    }

    if (isCachedFullResultFresh(cachedResult)) {
      return cachedResult.result;
    }

    fullResultCache.delete(input);
    return undefined;
  }

  function setCachedFullResult(input: string, result: string): void {
    fullResultCache.set(input, {
      result,
      hasUnknownClass: true,
      atomicRegistryVersion
    });
  }

  function clearRuntimeCaches(): void {
    segmentCache.clear();
    fullResultCache.clear();
    segmentMarkerPayloadCache.clear();
    transientSegmentByPayload.clear();
    transientPayloadByMarker.clear();
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

  function isCachedSegmentFresh(cachedSegment: CachedCompiledSegment): boolean {
    return (
      !hasUnknownEntry(cachedSegment.segment.entries) ||
      cachedSegment.atomicRegistryVersion === atomicRegistryVersion
    );
  }

  function isCachedFullResultFresh(cachedResult: CachedFullResult): boolean {
    return (
      !cachedResult.hasUnknownClass ||
      cachedResult.atomicRegistryVersion === atomicRegistryVersion
    );
  }

  function withRegisteredMarker(
    compiledSegment: CompiledSegment
  ): CompiledSegment {
    const payload = createSegmentMarkerPayload(compiledSegment);

    if (payload === undefined) {
      return compiledSegment;
    }

    const existingMarker = markerBySegmentPayload.get(payload);
    const transientSegment = transientSegmentByPayload.get(payload);
    const marker =
      existingMarker ??
      transientSegment?.marker ??
      createSegmentMarker(payload);

    if (existingMarker === undefined) {
      const existingPayload = segmentPayloadByMarker.get(marker);
      const transientPayload = transientPayloadByMarker.get(marker);

      if (
        (existingPayload !== undefined && existingPayload !== payload) ||
        (transientPayload !== undefined && transientPayload !== payload)
      ) {
        throw new Error(`Mincho segment marker collision for ${marker}`);
      }

      markerBySegmentPayload.set(payload, marker);
      segmentPayloadByMarker.set(marker, payload);
      transientSegmentByPayload.delete(payload);
      transientPayloadByMarker.delete(marker);
    }

    return { ...compiledSegment, marker };
  }

  function getTransientMarkerForEntries(
    entries: readonly CompiledEntry[]
  ): string | undefined {
    if (segmentCacheSize === 0) {
      return undefined;
    }

    const segment: CompiledSegment = {
      entries: [...entries],
      hasKnownAtomicClass: entries.some((entry) => entry.kind === "known")
    };
    const payload = createSegmentMarkerPayload(segment);

    if (payload === undefined) {
      return undefined;
    }

    const registeredMarker = markerBySegmentPayload.get(payload);

    if (registeredMarker !== undefined) {
      return registeredMarker;
    }

    const cachedSegment = transientSegmentByPayload.get(payload);

    if (cachedSegment !== undefined) {
      return cachedSegment.marker;
    }

    const marker = createSegmentMarker(payload);
    const registeredPayload = segmentPayloadByMarker.get(marker);
    const transientPayload = transientPayloadByMarker.get(marker);

    if (
      (registeredPayload !== undefined && registeredPayload !== payload) ||
      (transientPayload !== undefined && transientPayload !== payload)
    ) {
      throw new Error(`Mincho segment marker collision for ${marker}`);
    }

    const evicted = transientSegmentByPayload.set(payload, { marker, segment });

    if (evicted !== undefined) {
      transientPayloadByMarker.delete(evicted[1].marker);
    }

    transientPayloadByMarker.set(marker, payload);
    return marker;
  }

  function createSegmentMarkerPayload(
    compiledSegment: CompiledSegment
  ): string | undefined {
    if (
      compiledSegment.entries.length === 0 ||
      compiledSegment.entries.some((entry) => entry.kind === "unknown")
    ) {
      return undefined;
    }

    const cacheKey = compiledSegment.entries
      .flatMap((entry) =>
        entry.kind === "known"
          ? [`${entry.className.length}:${entry.className}:${entry.writeKeyId}`]
          : []
      )
      .join("|");
    const cachedPayload = segmentMarkerPayloadCache.get(cacheKey);

    if (cachedPayload !== undefined) {
      return cachedPayload;
    }

    const payload: Array<
      readonly [
        className: string,
        layer: string | null,
        supports: string | null,
        media: string | null,
        container: string | null,
        selector: string,
        property: string
      ]
    > = [];

    for (const entry of compiledSegment.entries) {
      if (entry.kind === "unknown") {
        return undefined;
      }

      const writeKey = writeKeyById[entry.writeKeyId];

      if (writeKey === undefined) {
        return undefined;
      }

      const condition = conditionById[writeKey.conditionId];
      const property = propertyById[writeKey.propertyId];

      if (condition === undefined || property === undefined) {
        return undefined;
      }

      payload.push([
        entry.className,
        condition.layer,
        condition.supports,
        condition.media,
        condition.container,
        condition.selector,
        property
      ]);
    }

    const serializedPayload = JSON.stringify(payload);
    segmentMarkerPayloadCache.set(cacheKey, serializedPayload);
    return serializedPayload;
  }

  return {
    internCondition,
    internProperty,
    internWriteKey,
    registerAtomicClass,
    registerSegment,
    getRegisteredSegment,
    getSegmentByMarker,
    getRegisteredSegmentsByMarker,
    getSegmentByMarkerToken,
    getCompiledSegment,
    compileSegment,
    mergeCompiledSegments,
    mergeClassList,
    getCachedFullResult,
    setCachedFullResult,
    clearRuntimeCaches,
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

function createSegmentMarker(payload: string): string {
  return `${SEGMENT_MARKER_PREFIX}${hashSegmentMarkerPayload(
    payload,
    0x811c9dc5
  )}_${hashSegmentMarkerPayload(payload, 0x9e3779b9)}`;
}

function hashSegmentMarkerPayload(payload: string, seed: number): string {
  let hash = seed >>> 0;

  for (let index = 0; index < payload.length; index += 1) {
    hash = Math.imul(hash ^ payload.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function serializeSegmentEntries(entries: readonly CompiledEntry[]): string {
  return entries.map((entry) => entry.className).join(" ");
}

function hasUnknownEntry(entries: readonly CompiledEntry[]): boolean {
  return entries.some((entry) => entry.kind === "unknown");
}

function joinClassNames(...classNames: readonly string[]): string {
  return classNames.filter((className) => className.length > 0).join(" ");
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

    metadata.registerAtomicClass(firstClassName, writeKeyId);
    metadata.registerAtomicClass(secondClassName, writeKeyId);

    return writeKeyId;
  }

  function withoutSegmentMarkers(className: string): string {
    return className
      .split(/\s+/)
      .filter(
        (token) => token.length > 0 && !token.startsWith(SEGMENT_MARKER_PREFIX)
      )
      .join(" ");
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

    it("bounds merge markers without evicting registered segment markers", () => {
      const metadata = createEngineMetadata({ segmentCacheSize: 2 });
      registerAtomicPair(metadata, "color", "color_red", "color_blue");
      registerAtomicPair(metadata, "display", "display_block", "display_flex");
      registerAtomicPair(metadata, "padding", "padding_1", "padding_2");
      const registeredSegment = metadata.compileSegment("color_red");
      const registeredMarker = metadata.registerSegment(
        "registered-color",
        registeredSegment
      );
      const registeredSegmentSize = metadata.registeredSegmentSize;
      const firstMergeMarker = metadata
        .mergeCompiledSegments([
          metadata.compileSegment("color_blue display_flex")
        ])
        .split(/\s+/)[0];

      metadata.mergeCompiledSegments([
        metadata.compileSegment("display_block padding_2")
      ]);
      metadata.mergeCompiledSegments([
        metadata.compileSegment("padding_1 color_red")
      ]);

      expect(firstMergeMarker).toBeDefined();
      expect(metadata.registeredSegmentSize).toBe(registeredSegmentSize);
      expect(
        metadata.getSegmentByMarkerToken(firstMergeMarker ?? "")
      ).toBeUndefined();
      expect(
        metadata.getSegmentByMarkerToken(registeredMarker ?? "")
      ).toMatchObject(registeredSegment);
    });

    it("keeps all-known cached segments and full results after later atomic registration", () => {
      const metadata = createEngineMetadata();
      registerAtomicPair(metadata, "color", "color_red", "color_blue");
      const input = "color_red color_blue";
      const cachedSegment = metadata.getCompiledSegment(input);
      const cachedResult = metadata.mergeClassList(input);
      const conditionId = metadata.internCondition(baseCondition());
      const propertyId = metadata.internProperty("padding");
      const writeKeyId = metadata.internWriteKey(conditionId, propertyId);

      metadata.registerAtomicClass("padding_1", writeKeyId);

      expect(metadata.getCompiledSegment(input)).toBe(cachedSegment);
      expect(metadata.getCachedFullResult(input)).toBe(cachedResult);
      expect(metadata.mergeClassList(input)).toBe(cachedResult);
    });

    it("lazily recompiles unknown cached segments after direct atomic registration", () => {
      const metadata = createEngineMetadata();
      const conditionId = metadata.internCondition(baseCondition());
      const propertyId = metadata.internProperty("color");
      const writeKeyId = metadata.internWriteKey(conditionId, propertyId);
      const input = "color_red color_blue";

      metadata.registerAtomicClass("color_blue", writeKeyId);
      const cachedSegment = metadata.getCompiledSegment(input);

      expect(metadata.mergeClassList(input)).toBe(input);
      expect(metadata.segmentCacheSize).toBeGreaterThan(0);
      expect(metadata.fullResultCacheSize).toBeGreaterThan(0);

      metadata.registerAtomicClass("color_red", writeKeyId);

      expect(metadata.getCompiledSegment(input)).not.toBe(cachedSegment);
      expect(metadata.getCachedFullResult(input)).toBe(undefined);
      expect(withoutSegmentMarkers(metadata.mergeClassList(input))).toBe(
        "color_blue"
      );
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

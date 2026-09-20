import type { ClassValue } from "../classname/types.js";
import { CX_ARGUMENT_MAX_ENTRIES, CX_CACHE_MAX_CODE_UNITS } from "./cxCache.js";
import type { CxCache } from "./cxCache.js";

type Entry = {
  hash: number;

  // Small tuples expand to an array only when a wide prediction needs one.
  inputs: readonly string[] | undefined;
  first: string;
  second: string;
  third: string | undefined;
  length: number;
  result: string;
  next: Entry | undefined;
};

/**
 * Tuples reserve 512 entries and initially 16,384 UTF-16 units. A connected
 * result cache can lend space within the shared 131,072-unit ceiling. Only
 * primitive strings and falsy values match; mutable values must reach clsx.
 * Prediction links never outlive the entries: rotation clears the last root.
 */
export class CxArguments {
  // A generation contains either direct string entries or numeric buckets.
  private entries = new Map<string | number, Entry | Entry[]>();
  private byFirst = true;
  private count = 0;
  private codeUnits = 0;
  private maxCodeUnits = 16_384;
  private last: Entry | undefined;
  private calls = -CX_ARGUMENT_MAX_ENTRIES;
  private misses = 0;
  private predictionMisses = 0;
  private predicting = true;
  enabled = true;

  constructor(private readonly cache?: CxCache<unknown>) {}

  static accepts(inputs: readonly ClassValue[]): boolean {
    return argumentKey(inputs) !== undefined;
  }

  // Only predictions are tried here. A miss uses the regular lookup, which
  // records it once and verifies the full tuple before returning any result.
  getPredicted(
    first: ClassValue,
    second: ClassValue,
    third: ClassValue
  ): string | undefined {
    const last = this.last;
    const predicted = last?.next;

    if (
      predicted !== undefined &&
      matchesThree(predicted, first, second, third)
    ) {
      this.last = predicted;
      this.observePrediction();

      return predicted.result;
    }

    if (last !== undefined && matchesThree(last, first, second, third)) {
      this.observePrediction();

      return last.result;
    }

    return undefined;
  }

  get canPredict(): boolean {
    return this.last !== undefined;
  }

  // Fixed slots avoid forwarding a rest array on the common four-to-eight
  // argument path. Compare every truthy value before returning a prediction.
  getPredictedEight(
    first: ClassValue,
    second: ClassValue,
    third: ClassValue,
    fourth: ClassValue,
    fifth: ClassValue,
    sixth: ClassValue,
    seventh: ClassValue,
    eighth: ClassValue
  ): string | undefined {
    const last = this.last;
    let entry = last?.next ?? last;

    for (let attempt = 0; entry !== undefined && attempt < 2; attempt += 1) {
      let index = 0;

      // Only wide calls need the array representation of a compact tuple.
      // Reuse it thereafter; its strings are already counted in the budget.
      const strings = (entry.inputs ??=
        entry.length === 2
          ? [entry.first, entry.second]
          : [entry.first, entry.second, entry.third!]);

      if (
        (!first || first === strings[index++]) &&
        (!second || second === strings[index++]) &&
        (!third || third === strings[index++]) &&
        (!fourth || fourth === strings[index++]) &&
        (!fifth || fifth === strings[index++]) &&
        (!sixth || sixth === strings[index++]) &&
        (!seventh || seventh === strings[index++]) &&
        (!eighth || eighth === strings[index++]) &&
        index === entry.length
      ) {
        this.last = entry;
        this.observePrediction();

        return entry.result;
      }

      if (entry === last) break;

      entry = last;
    }

    return undefined;
  }

  getPredictedMany(...inputs: ClassValue[]): string | undefined {
    const predicted = this.last?.next;

    if (predicted !== undefined && this.matches(predicted, inputs)) {
      this.last = predicted;
      this.observePrediction();

      return predicted.result;
    }

    if (this.last !== undefined && this.matches(this.last, inputs)) {
      const result = this.last.result;
      this.observePrediction();

      return result;
    }

    return undefined;
  }

  get(inputs: readonly ClassValue[], probed = false): string | undefined {
    if (!this.enabled) return undefined;

    if (!probed) {
      const cached = this.getPredictedMany(...inputs);
      if (cached !== undefined) return cached;
    }

    let match: Entry | undefined;

    if (this.byFirst) {
      let first: string | undefined;

      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];

        if (input) {
          if (typeof input === "string") first = input;

          break;
        }
      }

      if (first === undefined) return undefined;

      const entry = this.entries.get(first) as Entry | undefined;

      if (entry !== undefined && this.matches(entry, inputs)) match = entry;
    } else {
      const key = argumentKey(inputs);
      if (key === undefined) return undefined;

      const bucket = this.entries.get(key) as Entry[] | undefined;

      if (bucket !== undefined) {
        for (const entry of bucket) {
          if (this.matches(entry, inputs)) {
            match = entry;
            break;
          }
        }
      }
    }

    if (match !== undefined) {
      if (this.predicting) {
        if (this.last !== undefined && this.last !== match)
          this.last.next = match;

        this.last = match;
      }

      this.observeLookup(true);

      return match.result;
    }

    // Exact tuple matches already prove eligibility. Validate misses before
    // counting them: unsupported or oversized inputs must not disable reuse.
    if (!this.byFirst || argumentKey(inputs) !== undefined)
      this.observeLookup(false);

    return undefined;
  }

  set(inputs: readonly ClassValue[], result: string): boolean {
    if (!this.enabled) return false;

    const hash = argumentKey(inputs);
    if (hash === undefined) return false;

    let size = result.length;
    const strings: string[] = [];

    for (const input of inputs) {
      if (input) {
        strings.push(input as string);
        size += (input as string).length;
      }
    }

    if (size > CX_CACHE_MAX_CODE_UNITS) return false;
    if (
      this.count >= CX_ARGUMENT_MAX_ENTRIES ||
      this.codeUnits + size > CX_CACHE_MAX_CODE_UNITS
    )
      this.clear();

    // A long but small working set should not thrash a fixed initial budget
    // while the rest is unused. Borrow from results before retaining strings;
    // the combined 131,072-unit / 1,024-entry ceiling never increases.
    if (
      this.cache !== undefined &&
      this.codeUnits + size > this.maxCodeUnits &&
      this.maxCodeUnits < CX_CACHE_MAX_CODE_UNITS
    ) {
      this.maxCodeUnits = this.codeUnits + size;
      this.cache.reserveArguments(this.maxCodeUnits);
    }

    if (size > this.maxCodeUnits) return false;
    if (this.codeUnits + size > this.maxCodeUnits) this.clear();

    // Unique first strings can use their engine-cached string hashes. When a
    // prefix is shared, switch the whole index to sampled tuple hashes once,
    // avoiding either a growing prefix bucket or another map lookup per hit.
    if (this.byFirst && this.entries.has(strings[0])) {
      const entries = new Map<number, Entry[]>();

      for (const value of this.entries.values()) {
        const entry = value as Entry;
        let target = entries.get(entry.hash);

        if (target === undefined) entries.set(entry.hash, (target = []));

        target.push(entry);
      }

      this.entries = entries;
      this.byFirst = false;
    }

    const entry: Entry = {
      hash,
      inputs: strings.length > 3 ? strings : undefined,
      first: strings[0],
      second: strings[1],
      third: strings[2],
      length: strings.length,
      result,
      next: undefined
    };

    if (this.byFirst) this.entries.set(strings[0], entry);
    else {
      let bucket = this.entries.get(hash) as Entry[] | undefined;

      if (bucket === undefined) this.entries.set(hash, (bucket = []));

      bucket.push(entry);
    }

    if (this.predicting) {
      if (this.last !== undefined) this.last.next = entry;

      this.last = entry;
    }

    this.count += 1;
    this.codeUnits += size;

    return true;
  }

  releaseForResult(size: number): void {
    if (
      this.maxCodeUnits > 16_384 &&
      size > CX_CACHE_MAX_CODE_UNITS - this.maxCodeUnits
    )
      this.clear();
  }

  private clear(): void {
    this.entries.clear();
    this.byFirst = true;
    this.count = 0;
    this.codeUnits = 0;
    this.last = undefined;

    if (this.maxCodeUnits !== 16_384) {
      this.maxCodeUnits = 16_384;
      this.cache?.reserveArguments(16_384);
    }
  }

  private observePrediction(): void {
    // Predicted hits need only advance the window, even during warmup.
    if (++this.calls === 64) this.finishWindow();
  }

  private observeLookup(hit: boolean): void {
    // Allow a full retained working set to warm before judging its reuse.
    // Otherwise a 512-tuple cycle would be disabled before its second pass.
    // Subsequent 64-lookup windows disable unhelpful prediction independently
    // of the tuple cache itself.
    // Low tuple reuse releases this cache for the instance's remaining life.
    if (++this.calls <= 0) return;
    if (!hit) this.misses += 1;

    this.predictionMisses += 1;

    if (this.calls === 64) this.finishWindow();
  }

  private finishWindow(): void {
    // More than 48 misses is exactly the previous fewer-than-16-hits policy.
    if (this.misses > 48) {
      this.entries.clear();
      this.count = 0;
      this.codeUnits = 0;
      this.enabled = false;
    }

    if (this.predictionMisses > 48 || !this.enabled) {
      this.last = undefined;
      this.predicting = false;
    }

    this.calls = this.misses = this.predictionMisses = 0;
  }

  private matches(entry: Entry, inputs: readonly ClassValue[]): boolean {
    const strings = entry.inputs;
    let index = 0;

    for (let position = 0; position < inputs.length; position += 1) {
      const input = inputs[position];
      if (!input) continue;

      const expected =
        strings !== undefined
          ? strings[index]
          : index === 0
            ? entry.first
            : index === 1
              ? entry.second
              : index === 2
                ? entry.third
                : undefined;
      if (input !== expected) return false;

      index += 1;
    }

    return index === entry.length;
  }
}

function matchesThree(
  entry: Entry,
  first: ClassValue,
  second: ClassValue,
  third: ClassValue
): boolean {
  if (first === entry.first && second === entry.second) {
    return third
      ? entry.length === 3 && third === entry.third
      : entry.length === 2;
  }

  // Entries contain at least two nonempty strings. The only remaining match
  // in three argument slots has a falsy first or second argument.
  if (entry.length !== 2) return false;

  return !first
    ? second === entry.first && third === entry.second
    : !second && first === entry.first && third === entry.second;
}

// A sampled hash selects a bucket only. Every hit still compares every string.
function argumentKey(inputs: readonly ClassValue[]): number | undefined {
  let hash = 0;
  let count = 0;
  let length = 0;

  for (const input of inputs) {
    if (!input) continue;
    if (typeof input !== "string") return undefined;

    const size = input.length;
    length += size + (count++ > 0 ? 1 : 0);
    hash = Math.imul(hash ^ size, 16_777_619) ^ input.charCodeAt(0);
    hash =
      Math.imul(hash ^ input.charCodeAt(size - 1), 16_777_619) ^
      input.charCodeAt(size >>> 1);
  }

  return count > 1 && length <= 4096 ? hash : undefined;
}

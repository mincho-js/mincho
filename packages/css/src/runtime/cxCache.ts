type Entry<Value> = { value: Value; size: number; used: boolean };

export const CX_CACHE_MAX_ENTRIES = 1024;
export const CX_CACHE_MAX_CODE_UNITS = 131_072;
export const CX_ARGUMENT_MAX_ENTRIES = 512;

/**
 * A second-chance cache: hits mark an entry without deleting/reinserting it.
 * Results, segments and prepared fragments share 1,024 entries / 131,072 UTF-16
 * code units. Active tuples reserve 512 entries and initially 16,384 units,
 * borrowing additional string space from this same budget when needed.
 * This bounds retained strings, not total heap (Maps and indexes also cost).
 */
export class CxCache<Value> {
  private entries = new Map<string, Entry<Value>>();
  private oldest: Iterator<string, undefined> | undefined;
  private codeUnits = 0;
  private maxEntries = CX_CACHE_MAX_ENTRIES;
  private maxCodeUnits = CX_CACHE_MAX_CODE_UNITS;

  reserveArguments(codeUnits = 16_384): void {
    // Evict only the space needed for tuples; hot fragments can survive growth.
    this.maxEntries = CX_CACHE_MAX_ENTRIES - CX_ARGUMENT_MAX_ENTRIES;
    this.maxCodeUnits = CX_CACHE_MAX_CODE_UNITS - codeUnits;
    this.trim(0, 0);
  }

  releaseArguments(): void {
    this.maxEntries = CX_CACHE_MAX_ENTRIES;
    this.maxCodeUnits = CX_CACHE_MAX_CODE_UNITS;
  }

  get(key: string): Value | undefined {
    return this.getEntry(key)?.value;
  }

  // A stable entry identity can detect repeated hits without retaining or
  // comparing another potentially long string. Callers must drop it on a miss.
  getEntry(key: string): Readonly<Entry<Value>> | undefined {
    const entry = this.entries.get(key);

    if (entry !== undefined) entry.used = true;

    return entry;
  }

  set(key: string, value: Value, valueCodeUnits: number): void {
    const size = key.length + valueCodeUnits;
    if (size > this.maxCodeUnits) return;

    const previous = this.entries.get(key);

    if (previous !== undefined) {
      if (previous.value === value) return;

      this.entries.delete(key);
      this.codeUnits -= previous.size;
    }

    this.trim(size, 1);
    this.entries.set(key, { value, size, used: false });
    this.codeUnits += size;
  }

  private trim(size: number, entries: number): void {
    while (
      this.entries.size + entries > this.maxEntries ||
      this.codeUnits + size > this.maxCodeUnits
    ) {
      const next = (this.oldest ??= this.entries.keys()).next();

      if (next.done) {
        this.oldest = undefined;
        continue;
      }

      const entry = this.entries.get(next.value)!;

      if (entry.used) {
        entry.used = false;
      } else {
        this.entries.delete(next.value);
        this.codeUnits -= entry.size;
      }
    }
  }
}

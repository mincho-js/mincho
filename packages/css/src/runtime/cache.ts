/** A shared per-instance budget for runtime results and validated segments. */
export class RuntimeCache<Value> {
  private readonly entries = new Map<string, { value: Value; size: number }>();
  private codeUnits = 0;

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);

    if (entry !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    return entry?.value;
  }

  clear(): void {
    this.entries.clear();
    this.codeUnits = 0;
  }

  set(key: string, value: Value, valueCodeUnits: number): void {
    const size = key.length + valueCodeUnits;
    if (size > 65_536) return;

    const previous = this.entries.get(key);

    if (previous !== undefined) {
      this.entries.delete(key);
      this.codeUnits -= previous.size;
    }

    while (this.entries.size >= 256 || this.codeUnits + size > 65_536) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;

      this.codeUnits -= this.entries.get(oldest)!.size;
      this.entries.delete(oldest);
    }

    this.entries.set(key, { value, size });
    this.codeUnits += size;
  }
}

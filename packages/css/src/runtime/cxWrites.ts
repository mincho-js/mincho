/** Reused only during conflict resolution, after all input/segment reads. */
export class CxWrites {
  epoch = 0;

  private constructor(readonly marks: Uint32Array) {}

  static create(classWrites: ReadonlyMap<string, number>): CxWrites | null {
    let maximum = -1;

    for (const id of classWrites.values()) {
      if (!Number.isInteger(id) || id < 0 || id >= 4096) return null;
      if (id > maximum) maximum = id;
    }

    // Serialized write IDs are dense. Sparse/unusual externally supplied IDs
    // retain Set semantics instead of allocating a large mostly empty buffer.
    if (maximum < 0 || maximum >= classWrites.size * 2) return null;

    return new CxWrites(new Uint32Array(maximum + 1));
  }

  next(): number {
    this.epoch = (this.epoch + 1) >>> 0;

    if (this.epoch === 0) {
      this.marks.fill(0);
      this.epoch = 1;
    }

    return this.epoch;
  }
}

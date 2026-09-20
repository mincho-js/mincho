import { describe, expect, it } from "vitest";
import { CxWrites } from "./cxWrites.js";

describe("scoped cx write generations", () => {
  it("clears old marks when the unsigned generation wraps", () => {
    const writes = CxWrites.create(
      new Map([
        ["a", 0],
        ["b", 1]
      ])
    )!;

    writes.marks[0] = writes.next();
    writes.epoch = 0xffff_ffff;

    expect(writes.next()).toBe(1);
    expect(writes.marks[0]).toBe(0);

    writes.marks[1] = writes.epoch;

    expect(writes.next()).toBe(2);
    expect(writes.marks[1]).not.toBe(writes.epoch);
  });

  it("bounds buffer size and falls back for non-dense or unusual IDs", () => {
    for (const id of [-1, 0.5, NaN, Infinity, 100, 4096, 2 ** 40]) {
      expect(CxWrites.create(new Map([["a", id]]))).toBeNull();
    }

    expect(CxWrites.create(new Map())).toBeNull();

    const dense = new Map(
      Array.from({ length: 4096 }, (_, id) => [`c${id}`, id] as const)
    );

    expect(CxWrites.create(dense)!.marks.byteLength).toBe(16_384);
    expect(CxWrites.create(new Map([["a", -0]]))!.marks.length).toBe(1);
  });
});

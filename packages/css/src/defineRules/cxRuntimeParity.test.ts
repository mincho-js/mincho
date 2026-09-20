import { describe, expect, it, vi } from "vitest";
import { CxCache } from "../runtime/cxCache.js";
import {
  createCompiledDefineRulesCxRuntime,
  createDefineRulesCxRuntime
} from "./createDefineRulesCxRuntime.js";
import type { ClassValue } from "../classname/types.js";
import { createReferenceCx } from "./__fixtures__/cxRuntimeReference.js";

const sparseWrites = new Array<number>(2);
sparseWrites[1] = 1;

const artifact = {
  classWrites: [
    ["a", 0],
    ["b", 0],
    ["c", 1],
    ["d", 2],
    ["__proto__", 3],
    ["marker-as-class", 4],
    ["nan", NaN],
    ["negative", -1],
    ["huge", 2 ** 40],
    ["fraction", 0.5],
    ["infinity", Infinity]
  ],
  segments: [
    ["segment", [0, 1]],
    ["alternate", [0, 1]],
    ["marker-as-class", [1, 2]],
    ["empty", []],
    ["sparse", sparseWrites],
    ["nan-segment", [NaN]]
  ]
} as const;

describe("cx parity with the frozen pre-optimization merge", () => {
  it("reevaluates normalized tuple inputs in order across hits and reentry", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const cx = create(artifact);
      const events: string[] = [];
      const results: string[] = [];
      let active = false;
      let fail = false;
      const failure = new Error("normalized tuple");
      const tail: ClassValue[] = ["c"];
      const value = Object.create({ inherited: true });
      Object.defineProperty(value, "b", {
        enumerable: true,

        get() {
          events.push("object");
          tail[0] = active ? "d" : "c";

          if (fail) throw failure;

          return active;
        }
      });

      const array = Object.defineProperty(["outside"], 0, {
        get() {
          events.push(cx("a", "c", false, "b"));

          return "outside";
        }
      });

      for (let index = 0; index < 160; index += 1) {
        active = index % 2 === 0;
        results.push(cx("a", value, [tail, array]));

        // The same normalized strings can also arrive without any objects.
        results.push(
          cx("a", active ? "b inherited" : "inherited", `${tail[0]} outside`)
        );
      }

      fail = true;

      expect(() => cx("a", value, array)).toThrow(failure);

      fail = false;
      results.push(cx("a", value, [tail, array]));

      expect(array).toHaveLength(1);

      return { results, events };
    };

    expect(run(createCompiledDefineRulesCxRuntime)).toEqual(
      run(createReferenceCx)
    );
  });

  it("checks every argument and falsy hole around the eight-slot boundary", () => {
    const cx = createCompiledDefineRulesCxRuntime(artifact);
    const reference = createReferenceCx(artifact);
    const falsy: ClassValue[] = [false, null, undefined, 0, NaN, "", 0n];

    for (let mask = 0; mask < 256; mask += 1) {
      const values = Array.from({ length: 8 }, (_, index) =>
        mask & (1 << index)
          ? ["a", "c", "b", "d"][index % 4]
          : falsy[index % falsy.length]
      );

      const frozen = Object.freeze(values);

      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(cx(...frozen)).toBe(reference(...frozen));
        expect(cx(...frozen, "outside", { a: true })).toBe(
          reference(...frozen, "outside", { a: true })
        );
        expect(cx(...frozen, false, null, undefined, "c")).toBe(
          reference(...frozen, false, null, undefined, "c")
        );
      }
    }
  });

  it("preserves array getter counts, captured length and changing falsy values", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const cx = create(artifact);
      const events: string[] = [];
      let firstReads = 0;
      let secondReads = 0;
      let fail = false;
      const failure = new Error("array slot");
      const values: ClassValue[] = [true, true, "c"];
      Object.defineProperty(values, 0, {
        get() {
          events.push("first");
          values.push("extra");
          firstReads += 1;

          return firstReads % 2 === 1 ? "a" : 0;
        }
      });
      Object.defineProperty(values, 1, {
        get() {
          events.push(cx("a", "b"));

          if (fail) throw failure;

          secondReads += 1;

          return secondReads % 2 === 1 ? "a" : NaN;
        }
      });

      const results: string[] = [];

      for (let index = 0; index < 100; index += 1) {
        values.length = 3;
        results.push(cx(values));
      }

      fail = true;

      expect(() => cx(values)).toThrow(failure);

      fail = false;
      results.push(cx(values));

      return { results, events, firstReads, secondReads };
    };

    expect(run(createCompiledDefineRulesCxRuntime)).toEqual(
      run(createReferenceCx)
    );
  });

  it("preserves colliding span lookups, Unicode names and buffer growth", () => {
    const config = {
      classWrites: [
        ["a", 0],
        ["b", 0],
        ["A", 2],
        ["i", 1],
        ["j", 1],
        ["q", 2],
        ["r", 2],
        ["😀", 3],
        ["😀x", 3],
        ["é", 4],
        ["é", 4],
        ["Q", 5],
        ["alias-marker", 5]
      ],
      segments: [
        ["Q", [0, 1]],
        ["R", []],
        ["S", sparseWrites]
      ]
    } as const;

    const compiled = createCompiledDefineRulesCxRuntime(config);
    const reference = createReferenceCx(config);

    for (let index = 0; index < 640; index += 1) {
      const input = ["a i", `outside-${index}`];

      expect(compiled(...input)).toBe(reference(...input));
    }

    const cases = [
      "a A ! b j",
      "a i y b j",
      "😀 é 😀x é",
      "Q a i b",
      "Q q r alias-marker",
      "Q Q a",
      "S outside i",
      "R a i",
      "a i ".repeat(600) + "b j",
      "a",
      "",
      "\ufeffQ\ta\u2003i\nb"
    ];

    for (let round = 0; round < 3; round += 1) {
      for (const source of cases) {
        const input = [source, `tail-${round}`];

        expect(compiled(...input)).toBe(reference(...input));
      }
    }
  });

  it("keeps a lent token buffer isolated during nested and throwing segment reads", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const writes = [0, 1];
      const cx = create({
        classWrites: [
          ["a", 0],
          ["b", 0],
          ["c", 1]
        ],
        segments: [["s", writes]]
      });

      for (let index = 0; index < 640; index += 1) cx("a", `outside-${index}`);

      const events: string[] = [];
      let fail = false;
      const failure = new Error("segment read");
      Object.defineProperty(writes, 0, {
        get() {
          events.push(cx("b c"));

          if (fail) throw failure;

          return 0;
        }
      });

      const results = [cx("s a c b", "first")];
      fail = true;

      expect(() => cx("s a c", "failure")).toThrow(failure);

      fail = false;
      results.push(cx("s b c", "after"));

      return { results, events };
    };

    expect(run(createCompiledDefineRulesCxRuntime)).toEqual(
      run(createReferenceCx)
    );
  });

  it("revalidates cached fragments across argument boundaries and overlapping markers", () => {
    const compiled = createCompiledDefineRulesCxRuntime(artifact);
    const reference = createReferenceCx(artifact);
    const sources = [
      "segment a c b",
      "marker-as-class c d b",
      "sparse outside c empty d",
      "segment marker-as-class c d",
      "\ufeffsegment\ta\u2003c\nb",
      "s:segment a c"
    ];

    for (let round = 0; round < 4; round += 1) {
      for (const source of sources) {
        for (let split = 0; split <= source.length; split += 1) {
          const values = [
            source.slice(0, split),
            source.slice(split),
            `outside-${round}-${split}`
          ];

          expect(compiled(...values)).toBe(reference(...values));
        }
      }
    }
  });

  it("evaluates mutable values after warming result and scalar tuple caches", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const cx = create({
        classWrites: [
          ["a", 0],
          ["b", 0],
          ["c", 1]
        ]
      });

      const events: string[] = [];
      const tail = ["c"];
      let active = false;
      const value = {
        get b() {
          events.push("object");
          tail[0] = active ? "b" : "c";

          return active;
        }
      };

      const inputs = ["a", value, tail] as const;
      const results = [];

      for (let index = 0; index < 150; index += 1) results.push(cx(...inputs));

      active = true;
      results.push(cx(...inputs));
      Object.defineProperty(tail, 0, {
        get() {
          events.push(cx("c", "b"));

          return "c";
        },

        set() {}
      });
      results.push(cx(...inputs));

      const failure = new Error("after cache warmup");
      const throwing = {
        get b(): boolean {
          throw failure;
        }
      };

      expect(() => cx("a", throwing, tail)).toThrow(failure);

      return { results, events };
    };

    expect(run(createCompiledDefineRulesCxRuntime)).toEqual(
      run(createReferenceCx)
    );
  });

  it("preserves falsy slots before scalar joins and mixed-value fallback", () => {
    const compiled = createCompiledDefineRulesCxRuntime(artifact);
    const reference = createReferenceCx(artifact);
    const cases: ClassValue[][] = [
      [],
      [false, 0, null, undefined, "", NaN],
      [false, "a", null, "c", 0, "b", undefined],
      [false, "a", false, false, "b", false, false, false, "c"],
      [false, "a", false, 42, "c"],
      ["a", null, "c", false, { b: true }],
      [false, "a", undefined, ["c", false, { b: true }]],
      [false, "segment a", 0, "c", "b", false]
    ];

    for (let round = 0; round < 160; round += 1) {
      for (const values of cases)
        expect(compiled(...values)).toBe(reference(...values));
    }
  });

  it("matches dense conflicts across cache eviction and changing input shapes", () => {
    const dense = {
      classWrites: Array.from(
        { length: 512 },
        (_, id) => [`c${id}`, id % 256] as const
      ),
      segments: [
        ["s", [0, 1, 2]],
        ["t", [0, 2]],
        ["empty", []]
      ] as const
    };

    const reference = createReferenceCx(dense);
    const compiled = createCompiledDefineRulesCxRuntime(dense);
    let seed = 0xabcdef;

    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;

      return seed >>> 0;
    };

    for (let index = 0; index < 6000; index += 1) {
      const tokens = Array.from(
        { length: 4 + (next() % 64) },
        () => `c${next() % 512}`
      ).join(index % 2 === 0 ? " " : "\u2003");

      const inputs: ClassValue[] = [
        index % 3 === 0 ? "s c0 c1 c2" : "t c0 c258",
        tokens,
        index % 4 === 0 && { [`outside-${index}`]: true },
        index % 5 === 0 && ["empty", "c0", "c256"]
      ];

      expect(compiled(...inputs)).toBe(reference(...inputs));
    }
  });

  it("keeps scalar predictions isolated from getters, exceptions and reentry", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const cx = create({
        classWrites: [
          ["a", 0],
          ["b", 0],
          ["c", 1]
        ]
      });

      const values = [cx("a", "b"), cx("b", "c")];
      const log: string[] = [];
      const array = Object.defineProperty(["b"], 0, {
        get() {
          log.push(cx("c", "a"));

          return "b";
        }
      });

      for (let index = 0; index < 4; index += 1) {
        values.push(cx("a", array));
        values.push(cx("a", "b", index % 2 === 0 && "c"));
      }

      const failure = new Error("getter");

      expect(() =>
        cx("a", {
          get b(): boolean {
            throw failure;
          }
        })
      ).toThrow(failure);

      values.push(cx("c", "a", "b"));

      expect(cx.length).toBe(0);
      expect(() => Reflect.construct(cx, [])).toThrow(TypeError);

      return { values, log };
    };

    expect(run(createCompiledDefineRulesCxRuntime)).toEqual(
      run(createReferenceCx)
    );
  });

  it("retries normalized tuple caching once, without cycling on tuple aliases", () => {
    const reservation = vi.spyOn(CxCache.prototype, "reserveArguments");

    const activations = () =>
      reservation.mock.calls.filter((args) => args.length === 0).length;

    try {
      const cx = createCompiledDefineRulesCxRuntime({ classWrites: [] });

      for (let index = 0; index < 576; index += 1)
        cx("base", `unique-${index}`);

      let reads = 0;

      for (let index = 0; index < 33; index += 1) {
        expect(
          cx("base", {
            get stable() {
              reads += 1;

              return true;
            }
          })
        ).toBe("base stable");
      }

      expect(reads).toBe(33);

      // Stable normalized values now qualify, while their getters still run.
      expect(activations()).toBe(2);

      for (let index = 0; index < 40; index += 1)
        expect(cx("base", "stable")).toBe("base stable");

      expect(activations()).toBe(2);

      const words = Array.from({ length: 256 }, (_, id) => `c${id}`);
      const result = words.join(" ");

      for (let index = 0; index < 1024; index += 1) {
        const split = 1 + (index % 255);

        expect(
          cx(words.slice(0, split).join(" "), words.slice(split).join(" "))
        ).toBe(result);
      }

      expect(activations()).toBe(2);
    } finally {
      reservation.mockRestore();
    }
  });

  it("preserves all ECMAScript whitespace and non-whitespace lookalikes", () => {
    const compiled = createCompiledDefineRulesCxRuntime(artifact);
    const direct = createReferenceCx(artifact);
    const whitespace = [
      " ",
      "\t",
      "\n",
      "\v",
      "\f",
      "\r",
      "\u00a0",
      "\u1680",
      ...Array.from({ length: 11 }, (_, index) =>
        String.fromCharCode(0x2000 + index)
      ),
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
      "\u0085",
      "\u180e",
      "\u200b",
      "\ud800"
    ];

    for (const space of whitespace) {
      for (const input of [
        "",
        "a",
        "segment a c b",
        "outside outside",
        "sparse outside c",
        "marker-as-class c d b"
      ]) {
        const value = space + input.replaceAll(" ", space + space) + space;

        expect(compiled(value)).toBe(direct(value));
        expect(compiled(value)).toBe(direct(value));
      }
    }
  });

  it("matches deterministic mixed inputs through cache pressure", () => {
    const compiled = createCompiledDefineRulesCxRuntime(artifact);
    const currentDirect = createDefineRulesCxRuntime(artifact);
    const direct = createReferenceCx(artifact);
    const tokens = [
      "",
      ...artifact.classWrites.map(([name]) => name),
      ...artifact.segments.map(([marker]) => marker),
      "unknown",
      "s:segment",
      "constructor"
    ];

    let state = 0xa73f01;

    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;

      return state >>> 0;
    };

    for (let index = 0; index < 12_000; index += 1) {
      const input = Array.from(
        { length: next() % 18 },
        () => tokens[next() % tokens.length]
      ).join(index % 2 ? " " : "\t");

      const args: ClassValue[] =
        index % 3 === 0
          ? [
              input,
              false,
              { [tokens[next() % tokens.length]]: true },
              [0, "outside"]
            ]
          : [input, index % 4 === 0 && "c", index % 5 === 0 && "b"];

      expect(compiled(...args)).toBe(direct(...args));
      expect(currentDirect(...args)).toBe(direct(...args));

      if (index % 11 === 0) expect(compiled(...args)).toBe(direct(...args));
    }
  }, 30_000);

  it("classifies every UTF-16 code unit exactly like the previous whitespace regex", () => {
    const cx = createCompiledDefineRulesCxRuntime({
      classWrites: [
        ["a", 0],
        ["b", 0]
      ]
    });

    for (let code = 0; code <= 0xffff; code += 1) {
      const character = String.fromCharCode(code);
      const input = `a${character}b`;

      expect(cx(input)).toBe(/\s/.test(character) ? "b" : input);
    }
  });

  it("keeps mutable direct segment accessors and reentrant reads in the same order", () => {
    const run = (create: typeof createDefineRulesCxRuntime) => {
      const log: string[] = [];
      let reads = 0;
      const writes = [0, 1];
      const cx = create({
        classWrites: [
          ["a", 0],
          ["b", 0],
          ["c", 1]
        ],
        segments: [["s", writes]]
      });

      Object.defineProperty(writes, "0", {
        get() {
          log.push(`read:${++reads}`);
          log.push(cx("a b"));

          return reads % 3 === 0 ? 1 : 0;
        }
      });

      const results = [cx("s a c"), cx("s b c"), cx("s c a"), cx("s a c b")];

      return { results, log };
    };

    expect(run(createDefineRulesCxRuntime)).toEqual(run(createReferenceCx));
  });

  it("keeps segment validation distinct from a result with the same cache key", () => {
    const compiled = createCompiledDefineRulesCxRuntime({
      classWrites: [
        ["a", 0],
        ["b", 0],
        ["c", 1]
      ],
      segments: [["marker", [0, 1]]]
    });

    for (let index = 0; index < 3; index += 1) {
      expect(compiled("s:marker c a")).toBe("s:marker c a");
      expect(compiled("marker c a")).toBe("marker c a");
      expect(compiled("marker a c")).toBe("marker a c");
      expect(compiled("s:marker a c")).toBe("s:marker a c");
      expect(compiled("marker a c b")).toBe("c b");
    }
  });

  it("rechecks mutable arrays, objects, getters, and reentrant inputs", () => {
    const cx = createCompiledDefineRulesCxRuntime({
      classWrites: [
        ["a", 0],
        ["b", 0]
      ]
    });

    let active = false;
    const reads: string[] = [];
    const object = {
      get a() {
        reads.push("a");

        expect(cx("a", "b")).toBe("b");

        return true;
      },

      get b() {
        reads.push("b");

        return active;
      }
    };

    const nested = [object, ["external"]];

    expect(cx("base", nested)).toBe("base a external");

    active = true;

    expect(cx("base", nested)).toBe("base b external");

    (nested[1] as string[]).push("more");

    expect(cx("base", nested)).toBe("base b external more");
    expect(reads).toEqual(["a", "b", "a", "b", "a", "b"]);

    const error = new Error("getter");
    const throws = {
      get a(): boolean {
        throw error;
      }
    };

    expect(() => cx("a", throws, "b")).toThrow(error);
    expect(cx("a", "b")).toBe("b");
  });

  it("preserves with callbacks and multiple callback/getter ordering", () => {
    const log: string[] = [];
    const cx = createCompiledDefineRulesCxRuntime({
      classWrites: [
        ["a", 0],
        ["b", 0]
      ]
    });

    const mixin = cx.with((name: string, enabled: boolean) => {
      log.push(`callback:${name}`);

      return {
        get a() {
          log.push(`get:${name}`);

          return enabled;
        },

        b: true
      };
    });

    expect(
      mixin.multiple({ first: ["first", true], second: ["second", false] })
    ).toEqual({ first: "b", second: "b" });
    expect(log).toEqual([
      "callback:first",
      "callback:second",
      "get:first",
      "get:second"
    ]);

    log.length = 0;

    expect(mixin("first", true)).toBe("b");
    expect(mixin("first", true)).toBe("b");
    expect(log).toEqual([
      "callback:first",
      "get:first",
      "callback:first",
      "get:first"
    ]);
    expect(
      Object.getPrototypeOf(cx.multiple({ ["__proto__"]: "a b" }))
    ).toBeNull();
  });

  it("never treats scalar hash or tuple boundaries as result identity", () => {
    const cx = createCompiledDefineRulesCxRuntime({ classWrites: [] });
    const direct = createReferenceCx({ classWrites: [] });
    const cases: ClassValue[][] = [
      ["a b", "c"],
      ["a", "b c"],
      ["a", "c", false],
      [false, "a", "c"],
      [0, "a", null, "c", undefined],
      ["a", true, "c"],
      ["a", 1, "c"],
      ["a", NaN, "c"],
      ["a", [], "c"],
      ["a", {}, "c"],
      ["a", ["b"], "c"],
      ["a", { b: true }, "c"],
      ["aXbcd", "same"],
      ["aYbcd", "same"],
      ["😀", "x".repeat(4096)],
      ["x".repeat(4096), "😀"]
    ];

    for (let repeat = 0; repeat < 3; repeat += 1)
      for (const args of cases) expect(cx(...args)).toBe(direct(...args));
  });
});

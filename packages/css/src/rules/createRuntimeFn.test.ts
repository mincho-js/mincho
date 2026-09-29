import { describe, expect, it, vi } from "vitest";
import { createCompiledRuntimeFn, createRuntimeFn } from "./createRuntimeFn.js";
import { RuntimeCache } from "../runtime/cache.js";
import type { PatternResult } from "./types.js";

type TestVariants = {
  tone: Record<"brand" | "neutral", string>;
  size: Record<"small" | "large", string>;
  active: Record<"true" | "false", string>;
};

type TestProps = { gap: { targets: ["gap"] } };

const makeConfig = (): PatternResult<TestVariants, TestProps> => ({
  defaultClassName: "base inherited-base",
  variantClassNames: {
    tone: { brand: "brand inherited-brand", neutral: "neutral" },
    size: { small: "small", large: "large" },
    active: { true: "active", false: "inactive" }
  },
  defaultVariants: { size: "small" },
  compoundVariants: [
    [{ active: true }, "compound-active"],
    [{ tone: "brand", size: "small" }, "compound-brand"]
  ],
  propVars: { gap: "--gap" }
});

const makeComplexConfig = (): PatternResult<TestVariants, TestProps> => ({
  ...makeConfig(),
  compoundVariants: Array.from({ length: 32 }, (_, index) => [
    { tone: index % 2 === 0 ? "brand" : "neutral", active: index % 2 === 0 },
    `compound-${index}`
  ])
});

describe.each([
  ["direct", createRuntimeFn],
  ["compiled", createCompiledRuntimeFn]
] as const)("%s recipe runtime", (_name, factory) => {
  it("uses declaration order independently of defaults, keys, and array order", () => {
    const recipe = factory(makeConfig());
    const expected =
      "base inherited-base brand inherited-brand small active compound-active compound-brand";

    expect(recipe({ tone: "brand", size: "small", active: true })).toBe(
      expected
    );
    expect(recipe({ active: true, size: "small", tone: "brand" })).toBe(
      expected
    );
    expect(recipe(["active", { tone: "brand" }])).toBe(expected);
    expect(recipe([{ active: false }, "active", { tone: "brand" }])).toBe(
      expected
    );
  });

  it("preserves typed compound checks and nullish default fallback", () => {
    const recipe = factory(makeConfig());

    expect(recipe({ active: true })).toBe(
      "base inherited-base small active compound-active"
    );
    expect(recipe({ active: "true" } as never)).toBe(
      "base inherited-base small active"
    );
    expect(recipe({ active: false })).toBe(
      "base inherited-base small inactive"
    );
    expect(recipe({ active: "false" } as never)).toBe(
      "base inherited-base small inactive"
    );
    expect(recipe({ tone: "brand", size: null } as never)).toBe(
      "base inherited-base brand inherited-brand small compound-brand"
    );
    expect(recipe({ size: undefined })).toBe("base inherited-base small");
  });

  it("reads all input getters in their own order on every call", () => {
    const reads: string[] = [];
    const selection = {
      get active() {
        reads.push("active");

        return true;
      },

      get ignored() {
        reads.push("ignored");

        return "ignored";
      },

      get tone() {
        reads.push("tone");

        return "brand" as const;
      }
    };

    const recipe = factory(makeComplexConfig());

    for (let index = 0; index < 20; index += 1) recipe(selection);

    reads.length = 0;

    const first = recipe(selection);

    expect(recipe(selection)).toBe(first);
    expect(reads).toEqual([
      "active",
      "ignored",
      "tone",
      "active",
      "ignored",
      "tone"
    ]);
  });

  it("does not memoize input identity or user coercions", () => {
    const recipe = factory(makeConfig());
    const selection = { tone: "brand" as "brand" | "neutral" };

    expect(recipe(selection)).toContain("brand");

    selection.tone = "neutral";

    expect(recipe(selection)).toBe("base inherited-base neutral small");

    let coercions = 0;
    const tone = {
      [Symbol.toPrimitive]() {
        coercions += 1;

        return "neutral";
      }
    };

    expect(recipe({ tone } as never)).toBe("base inherited-base neutral small");
    expect(recipe({ tone } as never)).toBe("base inherited-base neutral small");
    expect(coercions).toBe(2);
  });

  it("returns fresh introspection objects and retains fresh props mappings", () => {
    const recipe = factory(makeConfig());
    const names = recipe.variants();
    names.reverse();

    expect(recipe.variants()).toEqual(["tone", "size", "active"]);
    expect(recipe.classNames.base).toBe("base");

    const classes = recipe.classNames.variants;
    classes.tone.brand = "changed";

    expect(recipe.classNames.variants.tone.brand).toBe("brand");
    expect(recipe.classNames.variants).not.toBe(recipe.classNames.variants);
    expect(recipe.classNames.variants.tone).not.toBe(
      recipe.classNames.variants.tone
    );
    expect(recipe.props({ gap: 2 })).toEqual({ "--gap": 2 });
    expect(recipe.props({ gap: 2 })).not.toBe(recipe.props({ gap: 2 }));
  });

  it("does not select inherited values for missing variant inputs", () => {
    const name = "minchoUnselectedVariantProbe";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
    let reads = 0;
    Object.defineProperty(Object.prototype, name, {
      configurable: true,

      get() {
        reads += 1;

        return "brand";
      }
    });

    try {
      const recipe = factory({
        defaultClassName: "base",
        variantClassNames: { [name]: { brand: "brand" } },
        defaultVariants: {},
        compoundVariants: [],
        propVars: {}
      });

      expect(recipe({})).toBe("base");
      expect(recipe({})).toBe("base");
      expect(reads).toBe(0);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, name, previous);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  });
});

it("keeps directly callable recipe configs mutable", () => {
  const config = makeConfig();
  const recipe = createRuntimeFn(config);

  expect(recipe({ tone: "neutral" })).toBe("base inherited-base neutral small");

  config.variantClassNames.tone.neutral = "updated";
  config.defaultVariants.size = "large";
  config.compoundVariants.push([{ tone: "neutral" }, "new-compound"]);

  expect(recipe({ tone: "neutral" })).toBe(
    "base inherited-base updated large new-compound"
  );
  expect(recipe.classNames.variants.tone.neutral).toBe("updated");
});

it("matches the direct factory across table, typed keys, and cache fallback", () => {
  const config = makeComplexConfig();
  const direct = createRuntimeFn(config);
  const compiled = createCompiledRuntimeFn(config);

  for (let index = 0; index < 100; index += 1)
    expect(compiled({ tone: "brand" })).toBe(direct({ tone: "brand" }));

  const values = [
    undefined,
    null,
    true,
    false,
    "true",
    "false",
    "brand",
    "neutral",
    0,
    1,
    -0,
    NaN,
    Infinity
  ];

  for (let round = 0; round < 2; round += 1) {
    for (const tone of values) {
      for (const active of values) {
        const options = { active, tone } as never;

        expect(compiled(options)).toBe(direct(options));
      }
    }

    for (let index = 0; index < 300; index += 1) {
      const options = { tone: `unknown-${index}` } as never;

      expect(compiled(options)).toBe(direct(options));
    }
  }
});

it("omits compiler-proven unobserved runtime metadata without reading it", () => {
  const config = makeConfig();
  Object.defineProperty(config, "propVars", {
    get() {
      throw new Error("unused props");
    }
  });

  const recipe = createCompiledRuntimeFn(config, {
    props: false,
    variants: false,
    classNames: false
  });

  expect(Object.keys(recipe)).toEqual([]);
  expect(recipe({ tone: "brand" })).toBe(
    "base inherited-base brand inherited-brand small compound-brand"
  );
});

it("preserves inherited getter reads before and after cache population", () => {
  const name = "minchoInheritedVariantProbe";
  const config = {
    defaultClassName: "base",
    variantClassNames: { [name]: { brand: "brand", neutral: "neutral" } },
    defaultVariants: {},
    compoundVariants: Array.from({ length: 40 }, () => [
      { [name]: "brand" },
      "compound"
    ]),
    propVars: {}
  } as never;

  const direct = createRuntimeFn(config);
  const compiled = createCompiledRuntimeFn(config);

  for (let index = 0; index < 20; index += 1)
    expect(compiled({})).toBe(direct({}));

  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  let reads = 0;
  Object.defineProperty(Object.prototype, name, {
    configurable: true,

    get() {
      reads += 1;

      return reads % 2 === 1 ? "brand" : "neutral";
    }
  });

  try {
    const expected = direct({});
    const expectedReads = reads;

    expect(expectedReads).toBe(40);

    reads = 0;

    expect(compiled({})).toBe(expected);
    expect(reads).toBe(expectedReads);

    reads = 0;

    expect(createCompiledRuntimeFn(config)({})).toBe(expected);
    expect(reads).toBe(expectedReads);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, name, previous);
    else Reflect.deleteProperty(Object.prototype, name);
  }
});

it("does not cache inherited variant class getters", () => {
  const name = "minchoInheritedClassProbe";
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  let reads = 0;
  Object.defineProperty(Object.prototype, name, {
    configurable: true,

    get() {
      reads += 1;

      return `inherited-${reads}`;
    }
  });

  try {
    const config = makeComplexConfig();
    const recipe = createCompiledRuntimeFn(config);

    for (let index = 0; index < 20; index += 1) recipe({ tone: "neutral" });

    expect(recipe({ tone: name } as never)).toBe(
      "base inherited-base inherited-1 small"
    );
    expect(recipe({ tone: name } as never)).toBe(
      "base inherited-base inherited-2 small"
    );
    expect(reads).toBe(2);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, name, previous);
    else Reflect.deleteProperty(Object.prototype, name);
  }
});

it("keeps cheap recipes and first calls outside result caches", () => {
  const get = vi.spyOn(RuntimeCache.prototype, "get");
  const set = vi.spyOn(RuntimeCache.prototype, "set");

  try {
    const cheap = createCompiledRuntimeFn(makeConfig());

    for (let index = 0; index < 100; index += 1) cheap({ tone: "brand" });

    const expensive = createCompiledRuntimeFn(makeComplexConfig());
    expensive({ tone: "brand" });

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it("retains useful caches and releases them when reuse becomes too low", () => {
  const get = vi.spyOn(RuntimeCache.prototype, "get");
  const clear = vi.spyOn(RuntimeCache.prototype, "clear");

  try {
    const config = makeComplexConfig();
    const direct = createRuntimeFn(config);
    const compiled = createCompiledRuntimeFn(config);

    for (let index = 0; index < 200; index += 1) {
      const input = { tone: index % 2 ? "brand" : "neutral" } as const;

      expect(compiled(input)).toBe(direct(input));
    }

    expect(get).toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    for (let index = 0; index < 300; index += 1) {
      const input = { tone: `unknown-${index}` } as never;

      expect(compiled(input)).toBe(direct(input));
    }

    expect(clear).toHaveBeenCalledOnce();

    const previousReads = get.mock.calls.length;

    for (let index = 0; index < 100; index += 1)
      expect(compiled({ tone: "brand" })).toBe(direct({ tone: "brand" }));

    expect(get).toHaveBeenCalledTimes(previousReads);
  } finally {
    get.mockRestore();
    clear.mockRestore();
  }
});

it("supports ES2020 runtimes without Object.hasOwn", () => {
  const previous = Object.getOwnPropertyDescriptor(Object, "hasOwn");
  const results: [string, string][] = [];
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    value: undefined
  });

  try {
    const config = makeComplexConfig();
    const direct = createRuntimeFn(config);
    const compiled = createCompiledRuntimeFn(config);

    for (let index = 0; index < 200; index += 1) {
      const input = { tone: index % 2 ? "brand" : "neutral" } as const;
      results.push([direct(input), compiled(input)]);
    }
  } finally {
    if (previous) Object.defineProperty(Object, "hasOwn", previous);
    else Reflect.deleteProperty(Object, "hasOwn");
  }

  for (const [expected, actual] of results) expect(actual).toBe(expected);
});

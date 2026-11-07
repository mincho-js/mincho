import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { rules } from "./index.js";
import { recipe } from "./compat-impl.js";
import type { PatternOptions } from "./types.js";

beforeEach(() => setFileScope("boolean-variants.css.ts", "@test/variants"));
afterEach(() => endFileScope());

it("accepts empty selections and defaults when no variants are declared", () => {
  const options: PatternOptions<undefined, undefined> = {
    base: { color: "red" },
    defaultVariants: {},
    compoundVariants: () => []
  };
  const results = [
    rules({}),
    rules(options),
    rules(rules.raw(options)),
    rules.with(() => options)({}),
    rules.multiple({ plain: options }).plain,
    rules.extends(rules({}), {}),
    recipe({ base: { color: "red" }, defaultVariants: {} })
  ];

  for (const result of results) {
    expect(result({})).toBe(result());
    expect(result({})).toBe(result.classNames.base);
    expect(result.classNames.variants).toEqual({});
  }
});

it("keeps injected array defaults from enabling compound variants", () => {
  const result = recipe({
    variants: { active: { true: { opacity: 1 }, false: { opacity: 0.5 } } },
    defaultVariants: [JSON.parse('{"__proto__":{"active":true}}')],
    compoundVariants: [{ variants: { active: true }, style: { color: "red" } }]
  });

  expect(result()).toBe(result.classNames.base);
  expect(result({ active: false })).toBe(
    `${result.classNames.base} ${result.classNames.variants.active.false}`
  );
});

describe.each([
  { name: "rules", create: rules },
  { name: "recipe", create: recipe }
])("variant definitions in $name", ({ create }) => {
  it("uses only own groups and branches without mutating definitions", () => {
    const active = {
      true: Object.freeze({ opacity: 1 }),
      false: Object.freeze({ opacity: 0.5 })
    };
    Object.setPrototypeOf(active, { inherited: { color: "red" } });
    // The removed definition merge also ignored own __proto__ entries.
    Object.defineProperty(active, "__proto__", {
      value: { color: "green" },
      enumerable: true
    });
    Object.freeze(active);
    const variants = { active };
    Object.setPrototypeOf(variants, { inherited: { true: { color: "blue" } } });
    Object.defineProperty(variants, "__proto__", {
      value: { true: { color: "yellow" } },
      enumerable: true
    });
    Object.freeze(variants);
    const result = create({ variants, defaultVariants: { active: true } });

    expect(result.variants()).toEqual(["active"]);
    expect(Object.keys(result.classNames.variants.active)).toEqual([
      "true",
      "false"
    ]);
    expect(result()).toBe(
      `${result.classNames.base} ${result.classNames.variants.active.true}`
    );
    expect(result({ active: false })).toBe(
      `${result.classNames.base} ${result.classNames.variants.active.false}`
    );
  });
});

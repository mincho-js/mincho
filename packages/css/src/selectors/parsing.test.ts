import parser from "postcss-selector-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectors } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("selector parsing work", () => {
  it.each([
    {
      name: "append lists",
      call: () => selectors.append(".a, .b, .c", ".x, .y"),
      expected: ".a.x, .a.y, .b.x, .b.y, .c.x, .c.y",
      inputs: 2
    },
    {
      name: "unify compatible compounds",
      call: () => selectors.unify("button", ".primary"),
      expected: "button.primary",
      inputs: 2
    },
    {
      name: "has a relative selector list",
      call: () => selectors.has(".card", "> img, + .promo"),
      expected: ".card:has(> img, + .promo)",
      inputs: 2
    },
    {
      name: "nest complex parent references",
      call: () => selectors.nest(".a > .b", "& + & + &"),
      expected: ":is(.a > .b) + :is(.a > .b) + :is(.a > .b)",
      inputs: 2
    },
    {
      name: "nest shared parent groups",
      call: () => selectors.nest(".a, .b", "& + &, :not(&)"),
      expected: ":is(.a, .b) + :is(.a, .b), :not(:is(.a, .b))",
      inputs: 2
    },
    {
      name: "replace with alternatives",
      call: () => selectors.replace(".old + .old", ".old", ".a, .b"),
      expected: ":is(.a, .b) + :is(.a, .b)",
      inputs: 3
    },
    {
      name: "replace with a pseudo-element subject",
      call: () => selectors.replace(".card.old", ".old", "::before"),
      expected: ".card::before",
      inputs: 3
    }
  ])(
    "$name parses no more than its input strings",
    ({ call, expected, inputs }) => {
      const prototype = Object.getPrototypeOf(parser()) as ReturnType<
        typeof parser
      >;
      const parse = vi.spyOn(prototype, "astSync");

      expect(call()).toBe(expected);
      expect(parse).toHaveBeenCalled();
      expect(parse.mock.calls.length).toBeLessThanOrEqual(inputs);
    }
  );

  it("keeps validation when reusing parsed arguments", () => {
    expect(() => selectors.has(".a", "> :is(.b, :has(.c))")).toThrow(TypeError);
    expect(() => selectors.has(".a", "> img", "")).toThrow(TypeError);
    expect(() => selectors.has(".a", "> img", ".b,")).toThrow(TypeError);
    expect(() => selectors.unify("button", ".x::before")).toThrow(TypeError);
    expect(() =>
      selectors.replace(".scope .old", ".old", ".a, ::before")
    ).toThrow(TypeError);
  });

  it("preserves escapes and comments across reused groups and repeated calls", () => {
    const parent = '#a\\ , [data-label="a,b"]/*keep*/';
    const group = `:is(${parent})`;
    for (let i = 0; i < 3; i++) {
      expect(selectors.nest(parent, "& + &, :not(&)")).toBe(
        `${group} + ${group}, :not(${group})`
      );
      expect(selectors.replace(".old + .old", ".old", parent)).toBe(
        `${group} + ${group}`
      );
      expect(selectors.nest(".scope > #a\\ ", "& + &")).toBe(
        ":is(.scope > #a\\ ) + :is(.scope > #a\\ )"
      );
    }
  });

  it("isolates list combinations after consuming a single selector pair", () => {
    expect(selectors.append(".root", "button.ready", ":hover, :focus")).toBe(
      "button.root.ready:hover, button.root.ready:focus"
    );
    expect(selectors.append(".a, .b", "button.ready", ":hover")).toBe(
      "button.a.ready:hover, button.b.ready:hover"
    );
    expect(
      selectors.replace(".old:is(.old, .other), .old", ".old", "button")
    ).toBe("button:is(button, .other), button");
  });
});

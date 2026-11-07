import { describe, expect, expectTypeOf, it } from "vitest";
import { selectors } from "./index.js";

const apply = (condition: selectors.Condition) =>
  selectors.children(".list", ".item", condition);

describe("selectors public namespace", () => {
  it("types conditions and composed selector results", () => {
    expectTypeOf(selectors.first()).toEqualTypeOf<selectors.Condition>();
    expectTypeOf(apply(selectors.first())).toEqualTypeOf<string>();
  });

  it.each([
    [selectors.first(), "-n+1"],
    [selectors.first(3), "-n+3"],
    [selectors.nth(3), "3"],
    [selectors.from(3), "n+3"],
    [selectors.before(3), "-n+2"],
    [selectors.after(3), "n+4"],
    [selectors.odd(), "odd"],
    [selectors.even(), "even"],
    [selectors.every(3), "3n+3"],
    [selectors.every(3, { startAt: 1 }), "3n+1"]
  ])("compiles forward positions %j", (condition, formula) => {
    expect(apply(condition)).toBe(
      `.list > .item:nth-child(${formula} of .item)`
    );
  });

  it.each([
    [selectors.last(), "-n+1"],
    [selectors.last(3), "-n+3"],
    [selectors.nthLast(2), "2"],
    [selectors.every(3, { from: "end" }), "3n+3"]
  ])("compiles reverse positions %j", (condition, formula) => {
    expect(apply(condition)).toBe(
      `.list > .item:nth-last-child(${formula} of .item)`
    );
  });

  it("keeps both bounds inclusive in either direction", () => {
    expect(apply(selectors.between(2, 4))).toBe(
      ".list > .item:nth-child(n+2 of .item):nth-child(-n+4 of .item)"
    );
    expect(apply(selectors.between(2, 4, { from: "end" }))).toBe(
      ".list > .item:nth-last-child(n+2 of .item):nth-last-child(-n+4 of .item)"
    );
  });

  it("defines empty logical predicates and freezes condition inputs", () => {
    expect(apply(selectors.all())).toBe(".list > .item");
    expect(apply(selectors.none())).toBe(".list > .item");
    expect(apply(selectors.any())).toBe(".list > .item:not(*)");
    expect(apply(selectors.any(selectors.all(), selectors.first()))).toContain(
      ":is(*, :nth-child"
    );
    expect(Object.isFrozen(selectors.first())).toBe(true);
    expect(() =>
      selectors.all(".item" as unknown as selectors.Condition)
    ).toThrow(TypeError);
  });

  it.each([-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid 1-based indices %s",
    (value) => {
      for (const fn of [
        selectors.first,
        selectors.last,
        selectors.nth,
        selectors.nthLast,
        selectors.from,
        selectors.before,
        selectors.after,
        selectors.every,
        selectors.countMultipleOf
      ])
        expect(() => fn(value)).toThrow(RangeError);
    }
  );

  it("validates count bounds and options without unsafe arithmetic", () => {
    expect(() => selectors.count(-1)).toThrow(RangeError);
    expect(() => selectors.between(4, 2)).toThrow(RangeError);
    expect(() => selectors.countBetween(4, 2)).toThrow(RangeError);
    expect(() => selectors.every(2, { startAt: 0 })).toThrow(RangeError);
    expect(() =>
      selectors.every(2, { from: "side" } as unknown as selectors.EveryOptions)
    ).toThrow(TypeError);
    expect(apply(selectors.after(Number.MAX_SAFE_INTEGER))).toContain(
      ":not(*)"
    );
    expect(apply(selectors.countOver(Number.MAX_SAFE_INTEGER))).toContain(
      ":not(*)"
    );
    expect(apply(selectors.countUnder(0))).toContain(":not(*)");
  });
});

describe("selector composition", () => {
  it("implements the documented examples", () => {
    expect(selectors.nest(".card", ".title")).toBe(".card .title");
    expect(selectors.child(".card", ".title")).toBe(".card > .title");
    expect(selectors.append(".button", ".active")).toBe(".button.active");
    expect(selectors.unify("button", ".primary")).toBe("button.primary");
    expect(selectors.replace(".button:hover", ".button", ".link")).toBe(
      ".link:hover"
    );
    expect(selectors.is(".button", ":hover", ":focus")).toBe(
      ".button:is(:hover, :focus)"
    );
    expect(selectors.where(".button", ":hover", ":focus")).toBe(
      ".button:where(:hover, :focus)"
    );
    expect(selectors.has(".card", "> img")).toBe(".card:has(> img)");
    expect(selectors.exclude(".button", ".disabled")).toBe(
      ".button:not(.disabled)"
    );
  });

  it("handles lists, escaped identifiers and punctuation inside attributes", () => {
    expect(selectors.child(".a, .b", '[title="a,b"], .c\\,d')).toBe(
      '.a > [title="a,b"], .a > .c\\,d, .b > [title="a,b"], .b > .c\\,d'
    );
    expect(selectors.append(".a, .b", ".active, .busy")).toBe(
      ".a.active, .a.busy, .b.active, .b.busy"
    );
    expect(selectors.is(".a, .b", '[title="a,b"]')).toBe(
      '.a:is([title="a,b"]), .b:is([title="a,b"])'
    );
    expect(selectors.nest(".card", '&:hover, [title="&"]')).toBe(
      '.card:hover, .card [title="&"]'
    );
    expect(selectors.nest(".a, .b", "& + &")).toBe(":is(.a, .b) + :is(.a, .b)");
    expect(selectors.nest(".a > .b", ".active&")).toBe(".active:is(.a > .b)");
    expect(selectors.nest("&", "&:hover")).toBe("&:hover");
  });

  it("intersects complex matching subjects without inventing ancestor order", () => {
    expect(selectors.unify(".a .x", ".b .y")).toBe(":is(.a .x):is(.b .y)");
    expect(selectors.unify("button", "a")).toBe(":is(button):is(a)");
    expect(() => selectors.unify("a::before", ".x")).toThrow(TypeError);
    expect(selectors.append(".a .b", ".c .d")).toBe(".a .b.c .d");
  });

  it("rejects pseudo-element ancestors and functional nesting subjects", () => {
    for (const inputs of [
      [".a::before", ".b"],
      [".a:before", "> .b"],
      [".a::before", "& > .b"],
      ["button::before", ".active&"],
      [".a::before", ":is(&)"],
      [".a::before, .b", ":not(&)"],
      [".a::before, .b", "& + &"],
      [".a", "&::before", ".b"],
      [".a", "&::before > .b"]
    ])
      expect(() => selectors.nest(...inputs), inputs.join(" → ")).toThrow(
        TypeError
      );
  });

  it("preserves pseudo-element subjects and valid nesting chains", () => {
    expect(selectors.nest(".card", "&::before")).toBe(".card::before");
    expect(selectors.nest(".card", ".title::before")).toBe(
      ".card .title::before"
    );
    expect(selectors.nest("x-foo::part(label)", "&::before")).toBe(
      "x-foo::part(label)::before"
    );
    expect(selectors.nest(".a::part(label), .b::part(label)", "&:hover")).toBe(
      ".a::part(label):hover, .b::part(label):hover"
    );
    expect(selectors.nest(".a", "&::part(label)", "&/*keep*/::before")).toBe(
      ".a::part(label)/*keep*/::before"
    );
  });

  it("does not let comments hide incomplete selector boundaries", () => {
    for (const selector of ["/*c*/ > .b", ".b > /*c*/"])
      for (const compose of [
        selectors.child,
        selectors.is,
        selectors.where,
        selectors.exclude,
        selectors.unify
      ])
        expect(() => compose(".a", selector)).toThrow(TypeError);
    expect(() => selectors.has(".a", ".b > /*c*/")).toThrow(TypeError);
    expect(() => selectors.append(".a > /*c*/", ".b")).toThrow(TypeError);
    expect(() => selectors.append(".a", "/*c*/ > .b")).toThrow(TypeError);
    expect(() => selectors.nest(".a", ".b > /*c*/")).toThrow(TypeError);
    expect(selectors.has(".a", "/*c*/ > .b")).toBe(".a:has(/*c*/ > .b)");
    expect(selectors.nest(".a", "/*c*/ > .b")).toBe(".a/*c*/ > .b");
  });

  it("preserves existing sub-pseudo-element chains during replacement", () => {
    for (const chain of [
      "::part(label)::before",
      "::part(label)/*keep*/::before",
      "::slotted(span)::after",
      "::before::marker",
      "::part(label)::before::marker"
    ]) {
      expect(selectors.replace(`x-foo${chain}`, ".a", ".b")).toBe(
        `x-foo${chain}`
      );
      expect(selectors.replace(`x-foo.a${chain}`, ".a", ".b")).toBe(
        `x-foo.b${chain}`
      );
      expect(selectors.append(".a", `x-foo${chain}`)).toBe(`x-foo.a${chain}`);
    }
    expect(() => selectors.append("::before", "::after")).toThrow(TypeError);
    expect(() => selectors.append("x-foo::part(label)::before", ".a")).toThrow(
      TypeError
    );
  });

  it("rejects replacements that turn pseudo-elements into element subjects", () => {
    for (const source of [
      ".old .x",
      ".old > .x",
      ".old + .x",
      ":is(.old)",
      ":has(> .old)",
      ":nth-child(2 of .old)"
    ])
      for (const replacement of ["::before", ":before", ":is(::before)"])
        expect(() => selectors.replace(source, ".old", replacement)).toThrow(
          TypeError
        );
  });

  it("preserves relative selectors and pseudo-element replacement subjects", () => {
    expect(selectors.replace("> .old", ".old", ".new")).toBe("> .new");
    expect(selectors.replace("> .old", ".old", "::before")).toBe("> ::before");
    expect(selectors.replace(".card.old", ".old", "::before")).toBe(
      ".card::before"
    );
    expect(
      selectors.replace("x-foo.old", ".old", "::part(label)::before")
    ).toBe("x-foo::part(label)::before");
    expect(selectors.replace("> .old", ".old", '[data-label="::before"]')).toBe(
      '> [data-label="::before"]'
    );
  });

  it("keeps parent lists grouped inside negated nesting references", () => {
    expect(selectors.nest(".a, .b", ":not(&)")).toBe(":not(:is(.a, .b))");
    expect(selectors.nest(".a, .b", ".item:not(:is(&))")).toBe(
      ".item:not(:is(:is(.a, .b)))"
    );
    expect(selectors.nest(".a, .b", "&:hover")).toBe(".a:hover, .b:hover");
  });

  it("counts the whole parent list inside positional nesting predicates", () => {
    for (const name of ["nth-child", "nth-last-child"])
      expect(selectors.nest(".a, .b", `:${name}(2 of &)`)).toBe(
        `:${name}(2 of :is(.a, .b))`
      );
  });

  it("preserves Unicode whitespace in type selectors", () => {
    expect(selectors.nest("\u00a0")).toBe("\u00a0");
    expect(selectors.unify("a", "a\u00a0")).toBe(":is(a):is(a\u00a0)");
    expect(() => selectors.append("a", "a\u00a0")).toThrow(TypeError);
    expect(selectors.replace("a\u00a0", "a", "b")).toBe("a\u00a0");
    expect(selectors.replace("a\\ :hover", "a\\ ", "b")).toBe("b:hover");
    expect(() => selectors.nest(" \t\n\f\r")).toThrow(TypeError);
  });

  it("replaces selector tokens without changing strings or partial identifiers", () => {
    expect(
      selectors.replace(
        '.button-large [data-name=".button"] .button:is(.button, .other)',
        ".button",
        ".link"
      )
    ).toBe('.button-large [data-name=".button"] .link:is(.link, .other)');
    expect(selectors.replace(".b\\75 tton:hover", ".button", ".link")).toBe(
      ".link:hover"
    );
    expect(selectors.replace(":lang(en) en", "en", "fr")).toBe(":lang(en) fr");
    expect(
      selectors.replace(".button:hover", ".button", ".link, .action")
    ).toBe(":is(.link, .action):hover");
  });

  it("rejects malformed or unrepresentable arguments", () => {
    expect(() => selectors.nest()).toThrow(TypeError);
    expect(() => selectors.append()).toThrow(TypeError);
    expect(() => selectors.child(".a,", ".b")).toThrow();
    expect(() => selectors.is(".a")).toThrow(TypeError);
    expect(() => selectors.has(".a", ":has(.b)")).toThrow(TypeError);
    expect(() =>
      selectors.children(".list", "::before", selectors.first())
    ).toThrow(TypeError);
    expect(() => selectors.children(".list", "&", selectors.first())).toThrow(
      TypeError
    );
    expect(() => selectors.append("button", "a")).toThrow(TypeError);
    expect(() => selectors.nest(".a", "&-active")).toThrow(TypeError);
  });

  it("preserves compound subjects and each replacement in selector lists", () => {
    expect(selectors.nest("button", ".active&")).toBe(".active:is(button)");
    expect(selectors.replace(".active.old", ".old", "button")).toBe(
      "button.active"
    );
    expect(selectors.replace(".old + .old", ".old", ".a, .b")).toBe(
      ":is(.a, .b) + :is(.a, .b)"
    );
    expect(selectors.append(".x", "::part(button):hover")).toBe(
      ".x::part(button):hover"
    );
    expect(() => selectors.append(".x::before", ".active")).toThrow(TypeError);
    expect(
      selectors.replace(":nth-child(2n + 1 of .old, .other)", ".old", ".new")
    ).toBe(":nth-child(2n + 1 of .new, .other)");
    const grouped = apply(selectors.countAtLeast(3));
    expect(selectors.replace(grouped, ".item", ".other")).toBe(
      selectors.children(".list", ".other", selectors.countAtLeast(3))
    );
  });
});

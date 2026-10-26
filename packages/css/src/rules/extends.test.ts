import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { setFileScope } from "@vanilla-extract/css/fileScope";
import {
  setAdapter,
  removeAdapter,
  mockAdapter
} from "@vanilla-extract/css/adapter";
import { rules } from "./index.js";
import { getRulesConfig } from "./metadata.js";
import { createRuntimeFn } from "./createRuntimeFn.js";
import { createCompiledRuntimeFn } from "./createRuntimeFn.js";
import { createCompactRuntimeFn } from "./createCompactRuntimeFn.js";
import {
  beginCompilerStyleCapture,
  endCompilerStyleCapture,
  recordCompilerClass
} from "../compilerResources.js";
import type { RulesVariants } from "./types.js";

beforeEach(() => setFileScope("rules-extends.css.ts", "@test/rules"));

describe("rules.extends", () => {
  it.each([createCompiledRuntimeFn, createCompactRuntimeFn])(
    "keeps inheritance and selector references in %s",
    (factory) => {
      const parent = rules({
        color: "red",
        props: ["width"],
        variants: { size: { small: { padding: 4 } } }
      });
      const child = rules.extends(parent, {
        color: "blue",
        variants: { size: { small: { margin: 8 } } }
      });
      const { propVars, ...config } = getRulesConfig(child);
      const restored = factory(config, propVars);
      const grandchild = rules.extends(restored, {});

      expect(restored.classNames).toEqual(child.classNames);
      expect(restored({ size: "small" })).toBe(child({ size: "small" }));
      expect(grandchild({ size: "small" })).toBe(child({ size: "small" }));
      expect(grandchild.props({ width: 12 })).toEqual(
        parent.props({ width: 12 })
      );
      restored.classNames.variants.size.small = "mutated";
      expect(restored.classNames.variants.size.small).toBe(
        child.classNames.variants.size.small
      );
    }
  );

  it("records parent classes as references, not newly owned child resources", () => {
    const capture = beginCompilerStyleCapture();
    setAdapter({ ...mockAdapter, registerClassName: recordCompilerClass });

    try {
      const parent = rules({ color: "red" });
      const child = rules.extends(parent, { color: "blue" });

      expect(capture.recipes).toHaveLength(2);
      expect(capture.recipes[1].classes).toEqual([child.classNames.base]);
      expect(capture.recipes[1].references).toContain(parent.classNames.base);
    } finally {
      removeAdapter();
      endCompilerStyleCapture();
    }
  });

  it("inherits base, variants, toggles and compounds while emitting child classes", () => {
    const parent = rules(
      {
        color: "red",
        variants: { size: { small: { padding: 4 }, large: { padding: 16 } } },
        toggles: { rounded: { borderRadius: 8 } },
        defaultVariants: { size: "small" },
        compoundVariants: ({ size, rounded }) => [
          {
            condition: [size.large, rounded.true],
            style: "parent_compound"
          }
        ]
      },
      "parent"
    );
    const before = JSON.stringify(getRulesConfig(parent));
    const child = rules.extends(
      parent,
      {
        color: "blue",
        variants: {
          size: { large: { padding: 24 }, huge: { padding: 32 } },
          tone: { accent: { color: "purple" } }
        },
        toggles: { disabled: { opacity: 0.5 } },
        defaultVariants: { size: "large", rounded: true },
        compoundVariants: ({ size, rounded, tone }) => [
          {
            condition: [size.large, rounded.true, tone.accent],
            style: "child_compound"
          }
        ]
      },
      "child"
    );

    expect(child()).toContain(parent.classNames.base);
    expect(child()).toContain(child.classNames.base);
    expect(child.classNames.base).not.toBe(parent.classNames.base);
    expect(child.classNames.variants.size.small).toBe(
      parent.classNames.variants.size.small
    );
    expect(child.classNames.variants.size.large).not.toBe(
      parent.classNames.variants.size.large
    );
    expect(child({ size: "large", tone: "accent" }).split(" ")).toEqual(
      expect.arrayContaining([
        parent.classNames.variants.size.large,
        child.classNames.variants.size.large,
        "parent_compound",
        "child_compound"
      ])
    );
    expect(child({ size: "huge", rounded: false })).not.toContain(
      "parent_compound"
    );
    expect(child.variants()).toEqual(
      expect.arrayContaining(["size", "rounded", "tone", "disabled"])
    );
    expect(JSON.stringify(getRulesConfig(parent))).toBe(before);
    expectTypeOf<RulesVariants<typeof child>>().not.toBeAny();
    const invalidInputs = () => {
      // @ts-expect-error Unknown inherited variant value.
      child({ size: "missing" });
      // @ts-expect-error Unknown variant group.
      child({ missing: true });
      // @ts-expect-error Defaults must select a known parent or child value.
      rules.extends(parent, { defaultVariants: { size: "missing" } });
    };
    expectTypeOf(invalidInputs).toBeFunction();
  });

  it("shares inherited prop variables and keeps siblings and empty extensions independent", () => {
    const parent = rules({
      props: [{ space: { targets: ["padding"], base: 4 } }, "color"]
    });
    const child = rules.extends(parent, {
      props: [{ space: { targets: ["margin"], base: 8 } }, "width"]
    });
    expect(child.props({ space: 12 })).toEqual(parent.props({ space: 12 }));
    expect(child.props({ color: "red" })).toEqual(
      parent.props({ color: "red" })
    );
    expect(Object.keys(child.props({ width: 10 }))).toHaveLength(1);
    const inherited = rules.extends(parent, {});
    expect(inherited()).toBe(parent());
    expect(inherited.classNames).toEqual(parent.classNames);
    expect(rules.extends(child, {}).props({ space: 20, width: 5 })).toEqual(
      child.props({ space: 20, width: 5 })
    );
    const invalidInputs = () => {
      // @ts-expect-error Unknown prop.
      child.props({ missing: "red" });
    };
    expectTypeOf(invalidInputs).toBeFunction();
  });

  it("extends through typed handles and restores extension metadata from serialized config", () => {
    const parent = rules({ variants: { size: { small: { padding: 4 } } } });
    const custom = rules.with<{ tone: string }>(({ tone }) => ({
      color: tone
    }));
    const child = custom.extends(parent, { tone: "blue" });
    expect(child({ size: "small" })).toContain(
      parent.classNames.variants.size.small
    );
    const config = getRulesConfig(child);
    const snapshot = JSON.parse(JSON.stringify(config)) as typeof config;
    const restored = createRuntimeFn(snapshot);
    expect(restored.classNames).toEqual(child.classNames);
    expect(restored({ size: "small" })).toBe(child({ size: "small" }));
    const grandchild = rules.extends(restored, {
      variants: { size: { large: { padding: 8 } } }
    });
    expect(grandchild({ size: "small" })).toContain(
      parent.classNames.variants.size.small
    );
    expect(grandchild({ size: "large" })).toContain(
      grandchild.classNames.variants.size.large
    );
    const invalidInputs = () => {
      // @ts-expect-error Typed handle still validates its style input.
      custom.extends(parent, { tone: 12 });
    };
    expectTypeOf(invalidInputs).toBeFunction();
  });

  it("rejects invalid parents, options and debug IDs", () => {
    const parent = rules({});
    expect(() =>
      Reflect.apply(rules.extends, undefined, [() => "external", {}])
    ).toThrow("extension metadata");
    expect(() => Reflect.apply(rules.extends, undefined, [parent])).toThrow(
      "extension options"
    );
    expect(() =>
      Reflect.apply(rules.extends, undefined, [parent, null])
    ).toThrow("extension options");
    expect(() =>
      Reflect.apply(rules.extends, undefined, [parent, {}, 123])
    ).toThrow("debugId must be a string");
  });

  it("does not inherit Object.prototype members as classes or prop variables", () => {
    const child = rules.extends(rules({}), {
      props: { toString: { targets: ["width" as const] } },
      variants: { toString: { valueOf: { color: "red" } } }
    });
    expect(child({ toString: "valueOf" })).not.toContain("function");
    const vars = child.props({ toString: 12 });
    expect(Object.values(vars)).toEqual([12]);
    expect(Object.keys(vars)[0]).toMatch(/^--/);
    expect(Object.keys(vars)[0]).not.toContain("function");
  });
});

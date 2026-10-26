import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { defineRules } from "./index.js";
import { createDefineRulesCssRuntime } from "./createDefineRulesCssRuntime.js";
import { getDefineRulesDefinition } from "./extension.js";
import { compilePrivateDefineRulesClass } from "./compilerClasses.js";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession
} from "./registry.js";

beforeEach(() =>
  setFileScope("define-rules-extends.css.ts", "@test/define-rules")
);

describe("defineRules.extends", () => {
  it("infers definitions added to an empty parent", () => {
    const child = defineRules.extends(defineRules({}), {
      properties: { color: { brand: "red" } },
      shortcuts: { text: "color" }
    });
    expect(child.css.raw({ text: "brand" })).toEqual({ color: "red" });
    const invalidInputs = () => {
      // @ts-expect-error Empty parents do not widen the new allowed values.
      child.css({ color: "missing" });
    };
    expectTypeOf(invalidInputs).toBeFunction();
  });
  it("merges named values and replaces allowed arrays, conditions and shortcuts", () => {
    const parent = defineRules({
      properties: {
        color: { brand: "red", muted: "gray" },
        display: ["flex"],
        paddingLeft: [0, 4],
        paddingRight: [0, 4]
      },
      conditions: { desktop: "(min-width: 800px)" },
      shortcuts: {
        foreground: "color",
        px: ["paddingLeft", "paddingRight"],
        inline: { display: "flex" }
      }
    });
    const child = defineRules.extends(parent, {
      properties: {
        color: { brand: "blue", accent: "purple" },
        display: ["grid"],
        margin: [0, 8]
      },
      conditions: { desktop: "(min-width: 1000px)", print: "print" },
      shortcuts: { inline: { display: "grid" }, ink: "foreground" }
    });
    expect(parent.css.raw({ color: "brand" })).toEqual({ color: "red" });
    expect(child.css.raw({ color: "brand", display: "grid" })).toEqual({
      color: "blue",
      display: "grid"
    });
    expect(
      child.css.raw({ foreground: "muted", ink: "accent", px: 4 })
    ).toEqual({ color: "purple", paddingLeft: 4, paddingRight: 4 });
    expect(child.css.raw("inline")).toEqual({ display: "grid" });
    expect(
      child.css.raw({
        _desktop: { display: "grid" },
        _print: { display: "grid" }
      })
    ).toEqual({
      "@media": {
        "(min-width: 1000px)": { display: "grid" },
        print: { display: "grid" }
      }
    });
    expectTypeOf(child.css).not.toBeAny();
    const invalidInputs = () => {
      // @ts-expect-error Child arrays replace inherited allowed values.
      child.css({ display: "flex" });
      // @ts-expect-error Inherited shortcuts use merged property values.
      child.css({ foreground: "missing" });
      // @ts-expect-error New shortcuts must refer to known properties or shortcuts.
      defineRules.extends(parent, { shortcuts: { bad: "missing" } });
    };
    expectTypeOf(invalidInputs).toBeFunction();
  });

  it("inherits context by identity and permits replacement and explicit undefined", () => {
    const context = { tone: "red" };
    const parent = defineRules({ context, properties: { color: true } });
    const inherited = defineRules.extends(parent, {});
    inherited.css.raw((ctx) => {
      expect(ctx).toBe(context);
      return { color: ctx.tone };
    });
    const replacement = { color: "blue" };
    const child = defineRules.extends(parent, { context: replacement });
    child.css.raw((ctx) => {
      expect(ctx).toBe(replacement);
      return { color: ctx.color };
    });
    const cleared = defineRules.extends(child, { context: undefined });
    cleared.css.raw((ctx) => {
      expectTypeOf(ctx).toBeUndefined();
      return { color: "red" };
    });
  });

  it("reuses the parent preset snapshot and supports subsequent serialized extensions", () => {
    const parent = defineRules({ properties: { color: { brand: "red" } } });
    const parentColor = parent.css({ color: "brand" });
    const snapshot = parent.preset;
    const child = defineRules.extends(parent, {
      properties: { display: ["grid"] }
    });
    expect(child.cx(child.css({ color: "brand" }))).toBe(
      parent.cx(parentColor)
    );
    expect(
      child.preset.nodes.find((node) => node.nodeId === child.preset.rootNodeId)
        ?.atoms
    ).toEqual([]);
    child.css({ display: "grid" });
    expect(parent.preset).toBe(snapshot);
    const definition = getDefineRulesDefinition(child);
    const serialized = JSON.parse(
      JSON.stringify({ ...definition, presets: child.preset })
    ) as typeof definition;
    const restored = {
      css: createDefineRulesCssRuntime(serialized),
      cx: child.cx,
      preset: child.preset
    };
    const grandchild = defineRules.extends(restored, {
      properties: { color: { accent: "blue" } }
    });
    expect(grandchild.css.raw({ color: "brand", display: "grid" })).toEqual({
      color: "red",
      display: "grid"
    });
    expect(grandchild.css.raw({ color: "accent" })).toEqual({ color: "blue" });
  });

  it("preserves local function-valued definitions and diagnoses exported functions lazily", () => {
    const parent = defineRules({
      properties: { padding: (value: number) => `${value * 4}px` }
    });
    const child = defineRules.extends(parent, { properties: { color: true } });
    expect(child.css.raw({ padding: 2, color: "red" })).toEqual({
      padding: "8px",
      color: "red"
    });
    const recipe = Reflect.get(child.css, "__recipe__") as { args: unknown };
    expect(() => recipe.args).toThrow("function-valued");
    const replaced = defineRules.extends(child, {
      properties: { padding: [0, 4] }
    });
    expect(
      () => (Reflect.get(replaced.css, "__recipe__") as { args: unknown }).args
    ).not.toThrow();
  });

  it.each([false, true])(
    "registers imported definitions in the consumer scope with compiler emission %s",
    (compiled) => {
      const session = beginDefineRulesRegistrySession();
      try {
        setFileScope("../node_modules/parent/rules.js", "@consumer/app");
        const importedCss = (() => {
          try {
            return createDefineRulesCssRuntime({ properties: { color: true } });
          } finally {
            endFileScope();
          }
        })();
        expect(session.instances).toHaveLength(0);
        if (compiled) {
          compilePrivateDefineRulesClass(
            importedCss,
            { color: "red" } as never,
            {
              version: 1,
              globalAtomicClasses: true,
              compileClass: false,
              source: "/app.ts"
            }
          );
        } else importedCss({ color: "red" });
        expect(session.instances).toHaveLength(1);
        expect(session.instances[0].fileScope.filePath).toBe(
          "define-rules-extends.css.ts"
        );
        importedCss({ color: "red" });
        expect(session.instances).toHaveLength(1);
      } finally {
        endDefineRulesRegistrySession();
      }
    }
  );

  it("rejects invalid extension parents and configs", () => {
    const parent = defineRules({});
    const untypedExtends = defineRules.extends as unknown as (
      ...args: unknown[]
    ) => unknown;
    expect(() => untypedExtends({ css: () => "x" }, {})).toThrow(
      "extension metadata"
    );
    expect(() => untypedExtends(parent)).toThrow("extension config");
    expect(() => untypedExtends(parent, [])).toThrow("extension config");
  });

  it.each([false, true])(
    "isolates reused imported definitions across consumer sessions with compiler emission %s",
    (compiled) => {
      const importedCss = createDefineRulesCssRuntime({
        properties: { color: true }
      });
      const emit = (color: string) =>
        compiled
          ? compilePrivateDefineRulesClass(importedCss, { color } as never, {
              version: 1,
              globalAtomicClasses: true,
              compileClass: false,
              source: "/app.ts"
            })
          : importedCss({ color });
      const first = beginDefineRulesRegistrySession();
      try {
        importedCss.raw({ color: "red" });
        expect(first.instances).toHaveLength(0);
        const firstClass = emit("red");
        expect(emit("red")).toBe(firstClass);
        expect(first.instances).toHaveLength(1);
        const firstSnapshot = first.instances[0].getPresetSnapshot();

        setFileScope("second-consumer.css.ts", "@test/second-consumer");
        const second = beginDefineRulesRegistrySession();
        try {
          emit("red");
          expect(second.instances).toHaveLength(1);
          const secondSnapshot = second.instances[0].getPresetSnapshot();
          const secondRoot = secondSnapshot.nodes.find(
            (node) => node.nodeId === secondSnapshot.rootNodeId
          );
          expect(secondRoot?.origin).toBe(
            "@test/second-consumer:second-consumer.css.ts#defineRules:0"
          );
          expect(secondRoot?.atoms).toHaveLength(1);
          expect(first.instances[0].getPresetSnapshot()).toBe(firstSnapshot);
          expect(secondSnapshot.rootNodeId).not.toBe(firstSnapshot.rootNodeId);
          emit("blue");
          expect(second.instances).toHaveLength(1);
          expect(first.instances[0].getPresetSnapshot()).toBe(firstSnapshot);
        } finally {
          endDefineRulesRegistrySession();
          endFileScope();
        }

        expect(emit("red")).toBe(firstClass);
        expect(first.instances).toHaveLength(1);
        expect(first.instances[0].getPresetSnapshot()).toBe(firstSnapshot);
      } finally {
        endDefineRulesRegistrySession();
      }
    }
  );
});

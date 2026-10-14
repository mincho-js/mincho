import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  setAdapter,
  removeAdapter,
  mockAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import type { Adapter } from "@vanilla-extract/css";
import { createDefineRulesRuntime } from "./runtime.js";
import { defineRules } from "./index.js";
import { createDefineRulesCssRuntime } from "./createDefineRulesCssRuntime.js";
import { createDefineRulesCxRuntime } from "./createDefineRulesCxRuntime.js";
import {
  compilePrivateDefineRulesClass,
  type CompilerClassStrategy
} from "./compilerClasses.js";

const strategy: CompilerClassStrategy = {
  version: 1,
  globalAtomicClasses: true,
  compileClass: false,
  source: "/project/src/app.tsx"
};

type Rule = Parameters<Adapter["appendCss"]>[0];

let rules: Rule[];
let classes: Set<string>;

const make = () =>
  createDefineRulesRuntime({
    properties: {
      color: true,
      display: true,
      opacity: true,
      width: true,
      margin: true,
      cursor: true
    }
  } as const);

const compile = (
  owner: ReturnType<typeof make>,
  input: object,
  options = strategy
) => compilePrivateDefineRulesClass(owner.css, input as never, options);

const atomNames = (value: string) =>
  value.split(" ").filter((name) => !name.startsWith("__mincho_seg_"));

beforeEach(() => {
  rules = [];
  classes = new Set();
  setAdapter({
    ...mockAdapter,

    appendCss: (rule) => rules.push(rule),

    registerClassName: (name) => classes.add(name)
  });
  setFileScope("src/app.css.ts", "test");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("private class generation", () => {
  it("keeps public css calls ignoring extra arguments", () => {
    const owner = make();
    const result = Reflect.apply(owner.css, undefined, [
      { color: "red", display: "flex" },
      { ...strategy, compileClass: true }
    ]) as string;

    expect(owner.css.length).toBe(1);
    expect(atomNames(result)).toHaveLength(2);
    expect(atomNames(result).every((name) => !/^m[ac]_/.test(name))).toBe(true);
  });

  it("assigns atom identity before CSS and cx/preset metadata are serialized", () => {
    const owner = make();
    const red = compile(owner, { color: "red", display: "flex" });
    const blue = compile(owner, { color: "blue", display: "flex" });
    const atoms = owner.preset.nodes.flatMap((node) => node.atoms);

    expect(atomNames(red)).toHaveLength(2);
    expect(atomNames(red).every((name) => /^ma_[a-f0-9]{32}$/.test(name))).toBe(
      true
    );
    expect(new Set(atoms.map((atom) => atom.className))).toEqual(classes);
    expect(
      new Set(
        rules.flatMap((rule) => (rule.type === "local" ? [rule.selector] : []))
      )
    ).toEqual(classes);

    const artifact = owner.getCxRuntimeArtifact();
    const restored = createDefineRulesCxRuntime(artifact);

    // The serialized cx factory canonicalizes equivalent write sequences to
    // one registered marker; the authoring factory retains the value-specific
    // marker. Both must resolve exactly the same emitted atomic classes.
    expect(atomNames(restored(red, blue))).toEqual(
      atomNames(owner.cx(red, blue))
    );
    expect(artifact.segments?.map(([marker]) => marker)).toContain(
      restored(red, blue).split(" ")[0]
    );
    expect(restored(red, blue)).not.toContain(atomNames(red)[0]);
  });

  it("deduplicates private owners within one closed file and preserves independent file domains", () => {
    const first = compile(make(), { color: "red" });
    const second = compile(make(), { color: "red" });

    expect(atomNames(second)).toEqual(atomNames(first));
    expect(rules).toHaveLength(1);

    const otherFile = compile(
      make(),
      { color: "red" },
      { ...strategy, source: "/project/src/lazy.tsx" }
    );

    expect(atomNames(otherFile)).not.toEqual(atomNames(first));
    expect(rules).toHaveLength(2);
  });

  it("is stable across fresh evaluation and source processing order", () => {
    const expected = compile(make(), { color: "red", display: "flex" });
    endFileScope();
    setFileScope("src/unrelated.css.ts", "test");
    compile(
      make(),
      { color: "blue" },
      { ...strategy, source: "/project/src/unrelated.tsx" }
    );
    endFileScope();
    setFileScope("src/app.css.ts", "test");

    const actual = compile(make(), { color: "red", display: "flex" });

    expect(actual).toBe(expected);
  });

  it.each([false, true])(
    "collapses independent static declarations before emitting CSS (global=%s)",
    (globalAtomicClasses) => {
      const owner = make();
      const options = { ...strategy, compileClass: true, globalAtomicClasses };
      const result = compile(
        owner,
        { color: "red", display: "flex", opacity: 0.5 },
        options
      );

      expect(result.split(" ")).toHaveLength(1);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        type: "local",
        selector: result,
        rule: { color: "red", display: "flex", opacity: 0.5 }
      });
      expect(
        compile(owner, { color: "red", display: "flex", opacity: 0.5 }, options)
      ).toBe(result);
      expect(rules).toHaveLength(1);

      // A compound must never masquerade as an independently removable atom.
      expect(owner.preset.nodes.flatMap((node) => node.atoms)).toEqual([]);
      expect(owner.getCxRuntimeArtifact().classWrites).toEqual([]);
    }
  );

  it.each([
    { margin: "1px", color: "red" },
    { cursor: 'url("./cursor.svg"), pointer', color: "red" },
    { color: { _hover: "red" } },
    { color: ["red", "blue"] }
  ])("retains scoped CSS for unsupported writes: %j", (input) => {
    const owner = make();
    const result = compile(owner, input, { ...strategy, compileClass: true });

    expect(atomNames(result).every((name) => !/^m[ac]_/.test(name))).toBe(true);
    expect(
      owner.preset.nodes.flatMap((node) => node.atoms).length
    ).toBeGreaterThan(0);
  });

  it("retains an existing scoped atom when a fallback already owns its preset lookup", () => {
    const owner = make();
    const fallback = compile(owner, { color: "red", margin: "1px" });
    const optimized = compile(owner, { color: "red" });

    expect(atomNames(fallback)[0]).toBe(atomNames(optimized)[0]);

    const names = owner.preset.nodes.flatMap((node) =>
      node.atoms.map((atom) => atom.className)
    );

    expect(names).toContain(atomNames(fallback)[0]);
    expect(names).toContain(atomNames(optimized)[0]);
  });

  it("keeps serialized css and cx recipes consistent with emitted atom names", () => {
    const config = {
      properties: { color: true, display: true }
    } as const;

    const owner = defineRules(config);
    const input = { color: "red", display: "flex" };
    const output = compilePrivateDefineRulesClass(
      owner.css,
      input as never,
      strategy
    );

    expect(atomNames(output).every((name) => name.startsWith("ma_"))).toBe(
      true
    );

    const cssRecipe = Reflect.get(owner.css, "__recipe__") as {
      args: [typeof config];
    };

    const restoredCss = createDefineRulesCssRuntime(cssRecipe.args[0]);
    const previousCount = rules.length;

    expect(restoredCss(input as never)).toBe(output);
    expect(rules).toHaveLength(previousCount);

    const cxRecipe = Reflect.get(owner.cx, "__recipe__") as {
      args: Parameters<typeof createDefineRulesCxRuntime>;
    };

    expect(createDefineRulesCxRuntime(...cxRecipe.args)(output)).toBe(
      owner.cx(output)
    );
  });
});

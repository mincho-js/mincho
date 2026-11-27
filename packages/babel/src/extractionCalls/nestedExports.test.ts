import { transformSync } from "@babel/core";
import { buildSync, transformSync as compileModule } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { minchoBabelPlugin } from "../index.js";
import { babelTransform } from "../testUtils/plugin.js";
import * as bindings from "../commonjs/bindings.js";

const extractCalls = {
  "test-preset": ["system.css", "system.rules", "system.cx", "base.css"]
};

function transformReceiverBranch(usage: string) {
  const root = mkdtempSync(join(tmpdir(), "mincho-receiver-branch-"));
  const filename = join(root, "factory.ts");
  const source = `import { style } from "@vanilla-extract/css";
    const replacement = rule => ({ ...rule, color: "blue" });
    const flag = true;
    const other = { themeClass: "other" };
    const identity = value => value;
    function replace(owner) { owner.helper = replacement; }
    export const system = {
      themeClass: "theme",
      helper(rule) { return style(rule); },
      css(rule) { return this.helper(rule); }
    };
    ${usage}`;

  writeFileSync(filename, source);

  try {
    return babelTransform(
      source,
      { extractCalls: { "./factory.ts": ["system.css"] } },
      { root, filename }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function transformDataPreset(source: string) {
  const root = mkdtempSync(join(tmpdir(), "mincho-data-preset-"));
  writeFileSync(
    join(root, "preset.ts"),
    `export const system = {
      themeClass: "theme",
      preset: "system",
      css: rule => rule.color,
      rules: rule => rule,
      cx: value => value
    };
    export const dark = { css: rule => rule.color, settings: { mode: "dark" } };
    export const base = { css: rule => rule.color };
    export default { css: rule => rule.color };`
  );

  try {
    return babelTransform(
      source.replaceAll('"test-preset"', '"./preset.ts"'),
      { extractCalls: { "./preset.ts": extractCalls["test-preset"] } },
      { root, filename: join(root, "entry.tsx") }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("nested preset extraction exports", () => {
  const executeModule = (input: string, modules: Record<string, unknown>) => {
    const module = { exports: {} as Record<string, unknown> };
    new Function(
      "require",
      "module",
      "exports",
      compileModule(input, { format: "cjs" }).code
    )(
      (specifier: string) => {
        if (specifier in modules) return modules[specifier];
        throw new Error(`Unexpected import ${specifier}`);
      },
      module,
      module.exports
    );
    return module.exports;
  };

  it.each([
    ["captured first", 'const color = "red", marker = report();', false],
    ["captured last", 'const marker = report(), color = "red";', false],
    [
      "independent declaration",
      'const color = "red"; const marker = report();',
      true
    ],
    ["inert sibling", 'const color = "red", marker = 1;', true]
  ] as const)(
    "does not replay a sibling initializer in the sidecar: %s",
    (_case, declarations, extracts) => {
      const source = `import { system } from "test-preset";
        import { report } from "./runtime";
        ${declarations}
        export { marker };
        export const cls = system.css(color);`;
      const { code, result } = babelTransform(source, { extractCalls });
      const report = vi.fn(() => 1);
      const modules = {
        "test-preset": { system: { css: (color: string) => `class:${color}` } },
        "./runtime": { report }
      };
      const sidecar = executeModule(result[1], modules);
      expect(report).not.toHaveBeenCalled();
      expect(executeModule(code, { ...modules, [result[0]]: sidecar })).toEqual(
        {
          cls: "class:red",
          marker: 1
        }
      );
      expect(report).toHaveBeenCalledTimes(
        declarations.includes("report()") ? 1 : 0
      );
      expect(result[1].includes("system.css")).toBe(extracts);
    }
  );

  it.each([
    ['let color = "red"; color = "blue";', "blue", false],
    ['if (false) { var color = "red"; }', "fallback", false],
    ['for (; false;) { var color = "red"; }', "fallback", false],
    ['var color = "red";', "fallback", true]
  ])(
    "preserves captured primitive initialization and updates: %s",
    (setup, expected, afterCall) => {
      const source = `import { system } from "test-preset";
      ${afterCall ? "" : setup}
      export const cls = system.css(color);
      ${afterCall ? setup : ""}`;
      const { code, result } = babelTransform(source, {
        extractCalls,
        optimize: { pureFunctions: false }
      });
      const modules = {
        "test-preset": { system: { css: (color = "fallback") => color } }
      };
      const original = executeModule(source, modules);
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.cls).toBe(expected);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1]).not.toContain("system.css(");
    }
  );

  it.each([
    "const { trigger: {} } = system;",
    "const { trigger: [] } = system;",
    "const [] = system;"
  ])(
    "preserves destructuring effects without bound identifiers: %s",
    (usage) => {
      const source = `import { system } from "test-preset";
      ${usage}
      export const cls = system.css();`;
      const { code, result } = babelTransform(source, {
        extractCalls,
        optimize: { pureFunctions: false }
      });
      const createModules = () => ({
        "test-preset": {
          system: {
            mode: "red",
            get trigger() {
              this.mode = "blue";
              return [];
            },
            [Symbol.iterator]() {
              this.mode = "blue";
              return [][Symbol.iterator]();
            },
            css() {
              return this.mode;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.cls).toBe("blue");
      expect(runtime.cls).toBe(original.cls);
      expect(result[1]).not.toContain("system.css(");
    }
  );

  it.each([false, true])(
    "resolves dotted registrations through namespace exports, mutated=%s",
    (mutated) => {
      const root = mkdtempSync(
        join(tmpdir(), "mincho-namespace-registration-")
      );
      const factory = `export const system = { css: rule => rule.color };
        ${mutated ? 'system.css = () => "blue";' : ""}`;
      writeFileSync(join(root, "factory.ts"), factory);
      writeFileSync(
        join(root, "barrel.ts"),
        'export * as ns from "./factory.ts";'
      );
      const entry =
        'import { ns } from "./barrel.ts"; export const cls = ns.system.css({ color: "red" });';
      try {
        const transform = () =>
          babelTransform(
            entry,
            { extractCalls: { "./barrel.ts": ["ns.system.css"] } },
            { root, filename: join(root, "entry.ts") }
          );
        if (mutated) {
          expect(transform).toThrow(/Cannot use mutated extractCalls receiver/);
          return;
        }
        const { code, result } = transform();
        const modules = { "./barrel.ts": { ns: executeModule(factory, {}) } };
        const sidecar = executeModule(result[1], modules);
        expect(
          executeModule(code, { ...modules, [result[0]]: sidecar }).cls
        ).toBe("red");
        expect(result[1]).toContain("ns.system.css(");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["direct", "", "color", false],
    ["snapshot", "const initial = color;", "initial", false],
    ["computed snapshot", "const initial = `${color}`;", "initial", false],
    ["literal snapshot", 'const initial = "red";', "initial", true]
  ] as const)(
    "preserves a live imported value read before a registered call: %s",
    (_name, setup, value, extracted) => {
      const source = `import { system, color } from "test-preset";
      ${setup}
      export const values = [${value}, system.configure()];
      export const cls = system.css(color);`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["system.configure", "system.css"] }
      });
      const createModules = () => {
        let color = "red";
        return {
          "test-preset": {
            get color() {
              return color;
            },
            system: {
              configure() {
                color = "blue";
                return color;
              },
              css(value: string) {
                return `color-${value}`;
              }
            }
          }
        };
      };
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.values).toEqual(["red", "blue"]);
      expect(runtime.values).toEqual(original.values);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("system.configure(")).toBe(extracted);
    }
  );

  it("keeps initialization failures ahead of replayed calls", () => {
    const source = `import { system } from "test-preset";
      export const values = [initial, system.configure()];
      const initial = "red";
      export const cls = system.css();`;
    const { code, result } = babelTransform(source, {
      extractCalls: { "test-preset": ["system.configure", "system.css"] }
    });
    const createModules = () => {
      const calls: string[] = [];
      return {
        calls,
        modules: {
          "test-preset": {
            system: {
              configure() {
                calls.push("configure");
              },
              css() {
                calls.push("css");
                return "cls";
              }
            }
          }
        }
      };
    };
    const original = createModules();
    expect(() => executeModule(source, original.modules)).toThrow(
      ReferenceError
    );
    const compiled = createModules();
    expect(() => {
      const sidecar = executeModule(result[1], compiled.modules);
      executeModule(code, { ...compiled.modules, [result[0]]: sidecar });
    }).toThrow(ReferenceError);
    expect(compiled.calls).toEqual(original.calls);
  });

  it.each([
    'if (false) { var initial = "red"; }',
    'for (; false;) { var initial = "red"; }'
  ])("preserves a conditionally initialized primitive prefix: %s", (setup) => {
    const source = `import { system } from "test-preset";
      ${setup}
      export const values = [initial, system.configure()];
      export const cls = system.css(initial);`;
    const { code, result } = babelTransform(source, {
      extractCalls: { "test-preset": ["system.configure", "system.css"] }
    });
    const createModules = () => ({
      "test-preset": {
        system: {
          configure() {
            return "configured";
          },
          css(value: unknown) {
            return `color-${value}`;
          }
        }
      }
    });
    const original = executeModule(source, createModules());
    const modules = createModules();
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

    expect(original.cls).toBe("color-undefined");
    expect(runtime.cls).toBe(original.cls);
    expect(runtime.values).toEqual(original.values);
  });

  it.each([
    ["object", 'const state = { color: "red" };', "state.color"],
    ["function", 'function state() {} state.color = "red";', "state.color"],
    ["primitive", 'const state = "red";', "state"]
  ] as const)(
    "preserves shared %s identity between a prefix and a registered argument",
    (kind, setup, color) => {
      const source = `import { system } from "test-preset";
      ${setup}
      export const values = [state, system.configure(state)];
      export const cls = system.css(${color});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["system.configure", "system.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          system: {
            configure(value: unknown) {
              if (
                (typeof value === "object" && value !== null) ||
                typeof value === "function"
              )
                (value as { color: string }).color = "blue";
              return "configured";
            },
            css(value: string) {
              return `color-${value}`;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const observedColor = (exports: Record<string, unknown>) => {
        const value = (exports.values as Array<string | { color: string }>)[0]!;
        return typeof value === "string" ? value : value.color;
      };

      expect(observedColor(original)).toBe(
        kind === "primitive" ? "red" : "blue"
      );
      expect(observedColor(runtime)).toBe(observedColor(original));
      expect(runtime.cls).toBe(original.cls);
      if (kind === "primitive")
        expect(result[1]).toContain("system.configure(state)");
    }
  );

  it.each([
    [
      "successive properties using a generated sidecar import",
      `export const values = {
        first: system.css("red"),
        second: system.css("blue"),
        third: system.css("green")
      };`
    ],
    [
      "nested receiver groups with earlier recipe initializers",
      `const baseButton = base.rules("base");
      const systemButton = system.rules("system");
      const darkButton = dark.rules("dark");
      export const values = {
        base: {
          root: base.cx(base.css("red")),
          button: base.rules.extends(baseButton),
          multiple: base.rules.multiple("base")
        },
        system: {
          root: system.cx(system.css("blue")),
          button: system.rules.extends(systemButton),
          multiple: system.rules.multiple("system")
        },
        dark: {
          root: dark.cx(dark.css("green")),
          button: dark.rules.extends(darkButton),
          multiple: dark.rules.multiple("dark")
        }
      };`
    ],
    [
      "nested array and object prefixes with array holes",
      `export const values = [
        [base.css("red"), , base.css("orange")],
        { nested: [system.css("blue"), system.css("purple")] },
        [dark.css("green")]
      ];`
    ]
  ])("replays registered calls in %s", (_name, usage) => {
    const source = `import { base, system, dark } from "test-preset";
      ${usage}`;
    const { code, result } = babelTransform(source, {
      extractCalls: {
        "test-preset": ["base", "system", "dark"].flatMap((receiver) =>
          ["css", "cx", "rules", "rules.extends", "rules.multiple"].map(
            (method) => `${receiver}.${method}`
          )
        )
      }
    });
    const createModules = () => {
      const calls: string[] = [];
      const method = (name: string) => (value: string) => {
        const output = `${calls.length}:${name}:${value}`;
        calls.push(output);
        return output;
      };
      const modules = {
        "test-preset": Object.fromEntries(
          ["base", "system", "dark"].map((receiver) => [
            receiver,
            {
              css: method(`${receiver}.css`),
              cx: method(`${receiver}.cx`),
              rules: Object.assign(method(`${receiver}.rules`), {
                extends: method(`${receiver}.rules.extends`),
                multiple: method(`${receiver}.rules.multiple`)
              })
            }
          ])
        )
      };
      return { calls, modules };
    };
    const originalModules = createModules();
    const original = executeModule(source, originalModules.modules);
    const extractedModules = createModules();
    const sidecar = executeModule(result[1], extractedModules.modules);
    const runtime = executeModule(code, {
      ...extractedModules.modules,
      [result[0]]: sidecar
    });

    expect(runtime.values).toEqual(original.values);
    expect(extractedModules.calls).toEqual(originalModules.calls);
    expect(code).not.toMatch(/(?:base|system|dark)\.(?:css|cx|rules)\b/);
  });

  it.each([
    ["computed key", "{ [base.make(state)]: system.configure(state) }"],
    ["template", "`${base.make(state)}${system.configure(state)}`"],
    [
      "object spread",
      "{ ...base.make(state), color: system.configure(state) }"
    ],
    ["array spread", "[...base.make(state), system.configure(state)]"]
  ])(
    "preserves registered result %s hooks before later calls",
    (kind, value) => {
      const source = `import { base, system } from "test-preset";
      const state = { color: "red" };
      export const values = ${value};
      export const cls = system.css(state.color);`;
      const { code, result } = babelTransform(source, {
        extractCalls: {
          "test-preset": ["base.make", "system.configure", "system.css"]
        }
      });
      const createModules = () => ({
        "test-preset": {
          base: {
            make(state: { color: string }) {
              if (kind === "object spread")
                return {
                  get initial() {
                    return state.color;
                  }
                };
              if (kind === "array spread")
                return {
                  *[Symbol.iterator]() {
                    yield state.color;
                  }
                };
              return {
                toString() {
                  return state.color;
                }
              };
            }
          },
          system: {
            configure(state: { color: string }) {
              state.color = "blue";
              return state.color;
            },
            css(color: string) {
              return `color-${color}`;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(runtime.values).toEqual(original.values);
      expect(runtime.cls).toBe(original.cls);
    }
  );

  it.each([
    ["a readonly member", "", "box.current", "red", true],
    [
      "a written member",
      'box.current.color = "blue";',
      "box.current",
      "blue",
      false
    ],
    [
      "a replaced member",
      'box.current = { color: "blue" };',
      "box.current",
      "blue",
      false
    ],
    [
      "a written aliased member",
      'const alias = box; alias.current.color = "blue";',
      'box["current"]',
      "blue",
      false
    ],
    ["a readonly optional member", "", "box?.current", "red", true],
    [
      "a member shared by registered calls",
      "const first = tools.css(box.current);",
      "box.current",
      "red",
      true
    ],
    [
      "a member changed through an opaque call",
      'function mutate(value) { value.current.color = "blue"; } mutate(box);',
      "box.current",
      "blue",
      false
    ]
  ] as const)(
    "preserves container state for member arguments: %s",
    (_name, setup, argument, color, extracted) => {
      const source = `import { tools } from "test-preset";
        const box = { current: { color: "red" } };
        ${setup}
        export const cls = tools.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: { color: string }) {
              return `color-${value.color}`;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(`color-${color}`);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(extracted);
    }
  );

  it.each([
    [
      "a snapshot before configure",
      "const initial = state.color; system.configure(state);",
      "initial",
      "red"
    ],
    [
      "a snapshot alias before configure",
      "const captured = state.color; const initial = captured; system.configure(state);",
      "initial",
      "red"
    ],
    [
      "a snapshot after configure",
      "system.configure(state); const initial = state.color;",
      "initial",
      "blue"
    ],
    [
      "a snapshot between two configure calls",
      'system.configure(state, "green"); const initial = state.color; system.configure(state, "blue");',
      "initial",
      "green"
    ],
    [
      "an earlier extracted call result",
      'const initial = system.configure(state, "green"); system.configure(state, "blue");',
      "initial",
      "green"
    ],
    [
      "a snapshot and configure in one declaration",
      "const initial = state.color, changed = system.configure(state);",
      "initial",
      "red"
    ],
    [
      "a snapshot read through a hoisted helper",
      "const initial = read(); system.configure(state); function read() { return state.color; }",
      "initial",
      "red"
    ],
    [
      "a snapshot before configure in one initializer",
      "const initial = [state.color, system.configure(state)][0];",
      "initial",
      "red",
      false
    ],
    [
      "a snapshot after configure in one initializer",
      "const initial = [system.configure(state), state.color][1];",
      "initial",
      "blue"
    ],
    [
      "a pure array element before configure",
      'const initial = ["red", system.configure(state)][0];',
      "initial",
      "red"
    ],
    [
      "an object snapshot before configure",
      "const initial = { before: state.color, changed: system.configure(state) }.before;",
      "initial",
      "red",
      false
    ],
    [
      "an object snapshot after configure",
      "const initial = { changed: system.configure(state), after: state.color }.after;",
      "initial",
      "blue"
    ],
    [
      "a binary snapshot before configure",
      "const initial = state.color + system.configure(state);",
      "initial",
      "redblue",
      false
    ],
    [
      "a template snapshot before configure",
      "const initial = `${state.color}${system.configure(state)}`;",
      "initial",
      "redblue",
      false
    ],
    [
      "an argument snapshot before configure",
      "const initial = join(state.color, system.configure(state)); function join(first, second) { return first + second; }",
      "initial",
      "redblue",
      false
    ],
    [
      "a discarded read before configure",
      "const initial = (state.color, system.configure(state));",
      "initial",
      "blue",
      false
    ],
    [
      "a pure sequence value before configure",
      'const initial = ("discarded", system.configure(state));',
      "initial",
      "blue"
    ],
    [
      "a pure binary value before configure",
      'const initial = "red" + system.configure(state);',
      "initial",
      "redblue"
    ],
    [
      "a pure template value before configure",
      "const initial = `red${system.configure(state)}`;",
      "initial",
      "redblue"
    ],
    [
      "a template coercion prefix before configure",
      "const initial = `${{ toString() { return state.color; } }}${system.configure(state)}`;",
      "initial",
      "redblue",
      false
    ],
    [
      "a nested computed key coercion prefix before configure",
      'const initial = { prefix: { [{ toString() { return state.color; } }]: "captured" }, changed: system.configure(state) }.prefix.red;',
      "initial",
      "captured",
      false
    ],
    [
      "a nested template coercion prefix before configure",
      "const initial = { prefix: { text: `${{ toString() { return state.color; } }}` }, changed: system.configure(state) }.prefix.text;",
      "initial",
      "red",
      false
    ],
    [
      "a nested unary coercion prefix before configure",
      'const initial = { prefix: { value: +{ valueOf() { return state.color === "red" ? 1 : 2; } } }, changed: system.configure(state) }.prefix.value === 1 ? "red" : "blue";',
      "initial",
      "red",
      false
    ],
    [
      "a nested binary coercion prefix before configure",
      'const initial = { prefix: { value: "" + { toString() { return state.color; } } }, changed: system.configure(state) }.prefix.value;',
      "initial",
      "red",
      false
    ],
    [
      "a nested object spread prefix before configure",
      "const initial = { prefix: { ...{ get color() { return state.color; } } }, changed: system.configure(state) }.prefix.color;",
      "initial",
      "red",
      false
    ],
    [
      "a nested array spread prefix before configure",
      "const initial = [[...{ *[Symbol.iterator]() { yield state.color; } }], system.configure(state)][0][0];",
      "initial",
      "red",
      false
    ],
    [
      "a nested opaque call prefix before configure",
      "const initial = { prefix: [capture()], changed: system.configure(state) }.prefix[0]; function capture() { return state.color; }",
      "initial",
      "red",
      false
    ],
    [
      "a computed key coercion prefix before configure",
      "const initial = { [{ toString() { return state.color; } }]: system.configure(state) }.red;",
      "initial",
      "blue",
      false
    ],
    [
      "a primitive template coercion prefix before configure",
      'const initial = `${"red"}${system.configure(state)}`;',
      "initial",
      "redblue"
    ],
    [
      "a primitive computed key coercion prefix before configure",
      'const initial = { ["red"]: system.configure(state) }.red;',
      "initial",
      "blue"
    ],
    [
      "an unproven function value before configure",
      'const initial = join("red", system.configure(state)); function join(first, second) { return first + second; }',
      "initial",
      "redblue",
      false
    ]
  ])(
    "preserves declaration order around registered calls: %s",
    (_name, setup, argument, color, extracted = true) => {
      const source = `import { system } from "test-preset";
        const state = { color: "red" };
        ${setup}
        export const cls = system.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["system.configure", "system.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          system: {
            configure(state: { color: string }, color = "blue") {
              state.color = color;
              return state.color;
            },
            css(value: string) {
              return `color-${value}`;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(`color-${color}`);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("system.configure(")).toBe(extracted);
      expect(result[1].includes("system.css(")).toBe(extracted);
      expect(code.includes("system.configure(")).toBe(!extracted);
      expect(code.includes("system.css(")).toBe(!extracted);
    }
  );

  it.each([
    [
      'export const styles = { a: system.css("red"), b: system.css("blue") };',
      { a: "color-red", b: "color-blue" }
    ],
    [
      'const state = { color: "red" }; export const styles = system.css(system.configure(state));',
      "color-blue"
    ]
  ])(
    "keeps registered call order in ordinary initializers: %s",
    (source, expected) => {
      const input = `import { system } from "test-preset"; ${source}`;
      const { code, result } = babelTransform(input, {
        extractCalls: { "test-preset": ["system.css", "system.configure"] }
      });
      const modules = {
        "test-preset": {
          system: {
            configure(state: { color: string }) {
              state.color = "blue";
              return state.color;
            },
            css(value: string) {
              return `color-${value}`;
            }
          }
        }
      };
      const sidecar = executeModule(result[1], modules);

      expect(
        executeModule(code, { ...modules, [result[0]]: sidecar }).styles
      ).toEqual(expected);
      expect(result[1]).toContain("system.css(");
      expect(code).not.toContain("system.css(");
    }
  );

  it("preserves a guarded flat export that shares provider state", () => {
    const source = `
      import { configure, css } from "test-preset";
      import { enabled } from "test-flag";
      if (enabled) configure();
      export const cls = css();
    `;
    const { code, result } = babelTransform(source, {
      extractCalls: { "test-preset": ["configure", "css"] }
    });
    const createModules = () => {
      let color = "red";
      return {
        "test-flag": { enabled: false },
        "test-preset": {
          configure() {
            color = "blue";
          },
          css() {
            return `color-${color}`;
          }
        }
      };
    };
    const original = executeModule(source, createModules());
    const modules = createModules();
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

    expect(original.cls).toBe("color-red");
    expect(runtime.cls).toBe(original.cls);
  });

  it.each(["import", "require"])(
    "preserves guarded repeated flat provider calls through %s",
    (mode) => {
      const source = `
        ${mode === "import" ? 'import { next } from "test-preset";' : 'const { next } = require("test-preset");'}
        import { enabled } from "test-flag";
        if (enabled) next();
        export const value = next();
      `;
      const createModules = () => {
        let count = 0;
        return {
          "test-flag": { enabled: false },
          "test-preset": { next: () => ++count }
        };
      };
      const original = executeModule(source, createModules());
      expect(original.value).toBe(1);
      const transform = () =>
        babelTransform(source, {
          extractCalls: { "test-preset": ["next"] }
        });
      if (mode === "require") {
        expect(transform).toThrow(/Unproven provider invocation order/);
        return;
      }
      const { code, result } = transform();
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(runtime.value).toBe(original.value);
    }
  );

  it.each([
    "(() => configure())();",
    "function init() { configure(); } init();",
    "const init = () => configure(); init();",
    "const init = () => configure(); const alias = init; alias();",
    "function init(n = 0) { if (n) init(n - 1); else configure(); } init(1);",
    "export default function init() { configure(); } init();",
    "export function init() { configure(); } init();",
    'function init() { configure(); } eval("init()");',
    "[1].forEach(() => configure());",
    "class Init { static { configure(); } }",
    "class Init { value = configure(); } new Init();"
  ])(
    "preserves provider state across possible callback execution: %s",
    (setup) => {
      const source = `
      import { configure, css } from "test-preset";
      ${setup}
      export const cls = css();
    `;
      const createModules = () => {
        let color = "red";
        return {
          "test-preset": {
            configure() {
              color = "blue";
            },
            css() {
              return `color-${color}`;
            }
          }
        };
      };
      const original = executeModule(source, createModules());
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["configure", "css"] }
      });
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.cls).toBe("color-blue");
      expect(runtime.cls).toBe(original.cls);
      expect(code).toContain("css()");
      expect(result[1]).not.toContain("css()");
    }
  );

  it.each(["trigger", "reexport", "provider", "standalone"])(
    "preserves exported initializer order through %s dependencies",
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), "mincho-provider-cycle-"));
      const filename = join(root, "entry.ts");
      const source = `
        import { configure, css } from "test-preset";
        ${mode === "trigger" ? 'import "./trigger";' : mode === "reexport" ? 'export * from "./trigger";' : ""}
        export function init() { configure(); }
        export const cls = css();
      `;
      // The runtime host supplies an opaque provider. Babel must not rely on
      // filesystem provenance that is unavailable for this supported source.
      const execute = () => {
        const output = buildSync({
          entryPoints: [filename],
          alias: { "test-preset": join(root, "preset.ts") },
          bundle: true,
          write: false,
          format: "cjs",
          platform: "node"
        }).outputFiles[0].text;
        const module = { exports: {} as Record<string, unknown> };
        new Function("module", "exports", output)(module, module.exports);
        return module.exports;
      };
      try {
        writeFileSync(filename, source);
        writeFileSync(
          join(root, "preset.ts"),
          `${mode === "provider" ? 'import { init } from "./entry";' : ""}
           let color = "red";
           ${mode === "provider" ? "init();" : ""}
           export function configure() { color = "blue"; }
           export function css() { return color; }`
        );
        writeFileSync(
          join(root, "trigger.ts"),
          'import { init } from "./entry"; init();'
        );
        const original = execute();
        const { code, result } = babelTransform(
          source,
          { extractCalls: { "test-preset": ["configure", "css"] } },
          { root, filename }
        );
        writeFileSync(filename, code.replace(result[0], "./sidecar"));
        writeFileSync(join(root, "sidecar.ts"), result[1]);

        expect(execute().cls).toBe(original.cls);
        expect(original.cls).toBe(mode === "standalone" ? "red" : "blue");
        const extracted = mode === "provider" || mode === "standalone";
        expect(result[1].includes("css()")).toBe(extracted);
        expect(code.includes("css()")).toBe(!extracted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "await 0;",
    'const dependency = import("other");',
    'const dependency = require("other");',
    "const observed = globalThis.value;",
    "const observed = unknownGlobal;"
  ])("keeps provider calls runtime across open initialization: %s", (setup) => {
    const { code, result } = babelTransform(
      `import { configure, css } from "test-preset";
       ${setup}
       export function init() { configure(); }
       export const cls = css();`,
      { extractCalls: { "test-preset": ["configure", "css"] } }
    );
    expect(code).toContain("css()");
    expect(result[1]).not.toContain("css()");
  });

  it("keeps standalone component-local flat styles extractable", () => {
    const { code, result } = babelTransform(
      `import { css } from "test-preset";
       export function component() {
         return css({ color: "red" });
       }`,
      { extractCalls: { "test-preset": ["css"] } }
    );

    expect(code).not.toContain("css({");
    expect(result[1]).toContain("css({");
    expect(result[1]).toContain('color: "red"');
  });

  // Extraction-layer execution contract: user-visible output is primitive.
  // This harness does not claim arbitrary function serialization support.
  const createGroupOwnershipModules = (enabled = true) => {
    const events: string[] = [];
    const singleton = { color: "red" };
    const produce = (name: string) => () => {
      events.push(name);
      return singleton;
    };
    const provider = {
      first: produce("first"),
      second: produce("second"),
      ordinary: produce("ordinary"),
      mutate(left: typeof singleton, right: typeof singleton) {
        events.push(`mutate:${left === right}`);
        left.color = "blue";
        return "changed";
      },
      finish(left: typeof singleton, right: typeof singleton, changed: string) {
        events.push(
          `finish:${left === right}:${left.color}:${right.color}:${changed}`
        );
        return `${left === right}:${left.color}:${right.color}:${changed}`;
      }
    };
    return {
      events,
      singleton,
      modules: {
        "test-group": provider,
        "test-observer": {
          enabled,
          observe(value: typeof singleton) {
            events.push(`observe:${value.color}`);
          }
        }
      }
    };
  };
  const groupOwnershipCalls = {
    "test-group": ["first", "second", "mutate", "finish"]
  };

  it.each(["nested", "bindings"])(
    "preserves shared provider identity and call order in an owned %s group",
    (form) => {
      const source = `import {first, second, mutate, finish} from "test-group";
        ${
          form === "bindings"
            ? "const left=first(); const right=second(); const changed=mutate(left,right); export const output=finish(left,right,changed);"
            : "const left=first(); const right=second(); export const output=finish(left,right,mutate(left,right));"
        }`;
      const originalModules = createGroupOwnershipModules();
      const original = executeModule(source, originalModules.modules);
      const transformed = babelTransform(source, {
        extractCalls: groupOwnershipCalls
      });
      const extractedModules = createGroupOwnershipModules();
      const sidecar = executeModule(
        transformed.result[1],
        extractedModules.modules
      );
      const runtime = executeModule(transformed.code, {
        ...extractedModules.modules,
        [transformed.result[0]]: sidecar
      });
      expect(original.output).toBe("true:blue:blue:changed");
      expect(runtime.output).toBe(original.output);
      expect(extractedModules.events).toEqual(originalModules.events);
      expect(extractedModules.events).toEqual([
        "first",
        "second",
        "mutate:true",
        "finish:true:blue:blue:changed"
      ]);
      expect(transformed.result[1]).toContain("mutate(");
      expect(transformed.result[1]).toContain("finish(");
      expect(transformed.code).not.toContain("finish(");
    }
  );

  it.each([
    [
      "runtime leak",
      "const left=first(); const right=second(); export {left}; const changed=mutate(left,right); export const output=finish(left,right,changed);"
    ],
    [
      "runtime barrier",
      "const left=first(); const right=second(); observe(left); const changed=mutate(left,right); export const output=finish(left,right,changed);"
    ],
    [
      "conditional call",
      'const left=first(); const right=second(); if(enabled) mutate(left,right); export const output=finish(left,right,"conditional");'
    ],
    [
      "ordinary factory",
      "const left=ordinary(); const right=second(); const changed=mutate(left,right); export const output=finish(left,right,changed);"
    ]
  ])("does not promote an open registered group across %s", (label, usage) => {
    const source = `import {first,second,ordinary,mutate,finish} from "test-group";
      ${label === "conditional call" ? 'import {enabled} from "test-observer";' : label === "runtime barrier" ? 'import {observe} from "test-observer";' : ""}
      ${usage}`;
    const transformed = babelTransform(source, {
      extractCalls: groupOwnershipCalls
    });
    for (const enabled of [false, true]) {
      const originalModules = createGroupOwnershipModules(enabled);
      const original = executeModule(source, originalModules.modules);
      const extractedModules = createGroupOwnershipModules(enabled);
      const sidecar = executeModule(
        transformed.result[1],
        extractedModules.modules
      );
      const runtime = executeModule(transformed.code, {
        ...extractedModules.modules,
        [transformed.result[0]]: sidecar
      });
      expect(runtime.output).toBe(original.output);
      expect(extractedModules.events).toEqual(originalModules.events);
      if ("left" in original) {
        expect(runtime.left).toEqual(original.left);
        expect(runtime.left).toBe(extractedModules.singleton);
      }
    }
    expect(transformed.code).toContain("finish(");
    expect(transformed.result[1]).not.toContain("finish(");
  });

  it.each([
    [
      "deferred-captured",
      "const x=first(); const get=()=>x; const z=mutate(x,get()); export const output=finish(x,get(),z);"
    ],
    [
      "runtime-getter",
      "const x=first(); const box={get value(){observe(x);return x}}; const z=mutate(x,box.value); export const output=finish(x,x,z);"
    ],
    [
      "array-default",
      "const x=first(); const [y=x]=[]; const z=mutate(x,y); export const output=finish(x,y,z);"
    ]
  ])(
    "does not partially extract an unproven group through %s",
    (label, usage) => {
      const source = `import {first,mutate,finish} from "test-group";
      ${label === "runtime-getter" ? 'import {observe} from "test-observer";' : ""}
      ${usage}`;
      const transformed = babelTransform(source, {
        extractCalls: groupOwnershipCalls,
        optimize: { pureFunctions: false }
      });
      const originalModules = createGroupOwnershipModules();
      const original = executeModule(source, originalModules.modules);
      const extractedModules = createGroupOwnershipModules();
      const sidecar = executeModule(
        transformed.result[1],
        extractedModules.modules
      );
      const runtime = executeModule(transformed.code, {
        ...extractedModules.modules,
        [transformed.result[0]]: sidecar
      });
      expect(original.output).toBe("true:blue:blue:changed");
      expect(runtime.output).toBe(original.output);
      expect(extractedModules.events).toEqual(originalModules.events);
      expect(transformed.result[1]).not.toContain("first(");
      expect(transformed.result[1]).not.toContain("finish(");
      expect(transformed.code).toContain("first(");
      expect(transformed.code).toContain("finish(");
    }
  );

  it.each([
    [
      "alias",
      "const x=first(); const y=x; const z=mutate(x,y); export const output=finish(x,y,z);"
    ],
    [
      "own data container",
      "const x=first(); const box={value:x}; const z=mutate(x,box.value); export const output=finish(x,box.value,z);"
    ]
  ])("preserves a closed group across a %s", (_label, usage) => {
    const source = `import {first,mutate,finish} from "test-group"; ${usage}`;
    const transformed = babelTransform(source, {
      extractCalls: groupOwnershipCalls,
      optimize: { pureFunctions: false }
    });
    const originalModules = createGroupOwnershipModules();
    const original = executeModule(source, originalModules.modules);
    const extractedModules = createGroupOwnershipModules();
    const sidecar = executeModule(
      transformed.result[1],
      extractedModules.modules
    );
    const runtime = executeModule(transformed.code, {
      ...extractedModules.modules,
      [transformed.result[0]]: sidecar
    });
    expect(runtime.output).toBe(original.output);
    expect(runtime.output).toBe("true:blue:blue:changed");
    expect(extractedModules.events).toEqual(originalModules.events);
    expect(extractedModules.events).toEqual([
      "first",
      "mutate:true",
      "finish:true:blue:blue:changed"
    ]);
    expect(transformed.result[1]).toContain("first(");
    expect(transformed.result[1]).toContain("finish(");
    expect(transformed.code).not.toContain("finish(");
  });

  it("extracts ordered repeated flat provider calls", () => {
    const { code, result } = babelTransform(
      `
      import { next } from "test-preset";
      export const first = next();
      export const second = next();
    `,
      { extractCalls: { "test-preset": ["next"] } }
    );
    let count = 0;
    const modules = { "test-preset": { next: () => ++count } };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

    expect([runtime.first, runtime.second]).toEqual([1, 2]);
    expect(code).not.toContain("next()");
  });

  it.each(["import", "require"])(
    "extracts ordered flat provider calls through %s",
    (mode) => {
      const source = `
      ${mode === "import" ? 'import { defineStyle, makeRecipe } from "test-preset";' : 'const { defineStyle, makeRecipe } = require("test-preset");'}
      const className = defineStyle({ color: "tomato" });
      export const button = makeRecipe({ base: className });
    `;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["defineStyle", "makeRecipe"] }
      });
      const modules = {
        "test-preset": {
          defineStyle: (rule: { color: string }) => `color-${rule.color}`,
          makeRecipe: (rule: { base: string }) => () => rule.base
        }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect((runtime.button as () => string)()).toBe("color-tomato");
      expect(result[1]).toContain('color: "tomato"');
      expect(code).not.toContain('color: "tomato"');
    }
  );

  it.each([
    [
      "lexically shadowed require",
      "const require=load;",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "dynamic provider request",
      "const request=selectProvider();",
      "const {defineStyle,makeRecipe}=require(request);",
      ""
    ],
    [
      "additional unknown loader",
      'const unknown=require("unregistered-provider");',
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "additional dynamic loader",
      "const unknown=require(request);",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "direct loader reassignment",
      "require=load;",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "escaped loader",
      "consume(require);",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "direct eval",
      'eval("require = replacement");',
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "global loader mutation",
      "globalThis.require=load;",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "global alias loader mutation",
      "const realm=globalThis; realm.require=load;",
      'const {defineStyle,makeRecipe}=require("test-preset");',
      ""
    ],
    [
      "namespace slot mutation",
      "",
      'const namespace=require("test-preset"); const {defineStyle,makeRecipe}=namespace;',
      "namespace.makeRecipe=replacement;"
    ]
  ])(
    "withholds source-less module provenance after %s",
    (_label, setup, loader, mutation) => {
      const source = `${setup} ${loader} ${mutation}
      const className=defineStyle({color:"tomato"});
      export const button=makeRecipe({base:className});`;
      let transformed: ReturnType<typeof babelTransform>;
      try {
        transformed = babelTransform(source, {
          extractCalls: { "test-preset": ["defineStyle", "makeRecipe"] },
          optimize: { pureFunctions: false }
        });
      } catch (error) {
        // CommonJS namespace safety reports a diagnostic; unrecognized loaders
        // may instead remain runtime. Neither path may grant module provenance.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/Cannot safely extract/);
        return;
      }
      expect(transformed.code).toContain("makeRecipe(");
      expect(transformed.result[1]).not.toContain("makeRecipe(");
      expect(transformed.result[1]).not.toContain("defineStyle(");
    }
  );

  it.each([
    "{ getOwner: () => system }",
    "{ getOwner() { return system; } }",
    "{ get getOwner() { return () => system; } }",
    "{ getOwner: () => () => system }"
  ])("rejects receiver escapes through callback results: %s", (box) => {
    const invoke = box.includes("() => ()") ? "()()" : "()";
    expect(() =>
      transformReceiverBranch(`
        function replaceBox(box) { box.getOwner${invoke}.helper = replacement; }
        replaceBox(${box});
        export const cls = system.css({ color: "red" });
      `)
    ).toThrow(/Cannot use (?:mutated|escaped) extractCalls receiver/);
  });

  it.each([
    [
      "generator yield",
      "function* () { yield system; }",
      "for (const owner of callback()) owner.helper = replacement;"
    ],
    [
      "thrown value",
      "() => { throw system; }",
      "try { callback(); } catch (owner) { owner.helper = replacement; }"
    ]
  ])("rejects receiver escapes through callback %s", (_, callback, use) => {
    expect(() =>
      transformReceiverBranch(`
        function consume(callback) { ${use} }
        consume(${callback});
        export const cls = system.css({ color: "red" });
      `)
    ).toThrow(/Cannot use (?:mutated|escaped) extractCalls receiver/);
  });

  it.each([
    "const box = {}; box.owner = system; replace(box.owner);",
    "const box = {}; ({ owner: box.owner } = { owner: system }); replace(box.owner);",
    "const box = {}; [box.owner] = [system]; replace(box.owner);",
    "const box = {}; ({ nested: [box.owner] } = { nested: [system] }); replace(box.owner);",
    "const box = {}; ({ owner: box.owner = system } = {}); replace(box.owner);",
    "const box = {}; [...box.owners] = [system]; replace(box.owners[0]);",

    "const box = { __proto__: { owner: system } }; box.owner.helper = replacement;",
    "const box = { __proto__: { owner: system } }; const alias = box; alias.owner.helper = replacement;",
    "const box = { __proto__: { owner: system }, ...identity({}) }; box.owner.helper = replacement;",
    "const box = { __proto__: { get owner() { return system; } } }; box.owner.helper = replacement;",
    "const box = {}; const alias = system; box.owner = alias; box.owner.helper = replacement;",
    "const box = {}; box.owner = { receiver: system }; replace(box.owner.receiver);",
    "const box = {}; box[flag ? 'owner' : 'other'] = system; replace(box.owner);",
    "const exports = {}; exports.system = system; replace(exports.system);",
    "const module = { exports: {} }; module.exports.system = system; replace(module.exports.system);",
    "function publish() { exports.system = system; } publish(); replace(exports.system);"
  ])("rejects receiver escapes through local property stores: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      /Cannot use (?:mutated|escaped) extractCalls receiver/
    );
  });

  it.each([
    "const box = {}; box.owner = other; replace(box.owner);",
    "let themeClass; ({ themeClass } = system); identity(themeClass);",
    "const box = {}; ({ safe: box.owner } = { safe: other, unused: system }); replace(box.owner);",
    "const box = {}; [box.owner] = [other, system]; replace(box.owner);",
    "const box = {}; ({ owner: box.owner = system } = { owner: { themeClass: 'other' } }); replace(box.owner);",

    "const box = { __proto__: { owner: system }, owner: other }; replace(box.owner);",
    "const box = { ...{ __proto__: { owner: system } } }; identity(box.owner);",
    "const box = {}; box.owner = { ...system }; replace(box.owner);",
    "const box = {}; box.label = system.themeClass; identity(box.label);"
  ])("preserves independent values in local property stores: %s", (usage) => {
    const transformed = transformReceiverBranch(
      `${usage} export const cls = system.css({ color: "red" });`
    );
    const module = { exports: {} as Record<string, unknown> };
    new Function(
      "module",
      "exports",
      "require",
      compileModule(transformed.code, { format: "cjs" }).code
    )(module, module.exports, (id: string) => {
      if (id === "@vanilla-extract/css")
        return { style: (rule: { color: string }) => rule.color };
      throw new Error(`Unexpected import: ${id}`);
    });

    expect(module.exports.cls).toBe("red");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "exports.system = system;",
    "module.exports.system = system;",
    "module.exports = { system };"
  ])(
    "preserves CommonJS publication beside local property stores: %s",
    (publication) => {
      const root = mkdtempSync(join(tmpdir(), "mincho-receiver-publication-"));
      const filename = join(root, "factory.cjs");
      const source = `const { style } = require("@vanilla-extract/css");
      const system = {
        helper(rule) { return style(rule); },
        css(rule) { return this.helper(rule); }
      };
      ${publication}`;
      writeFileSync(filename, source);

      try {
        const transformed = babelTransform(
          source,
          { extractCalls: { "./factory.cjs": ["system.css"] } },
          { root, filename }
        );
        const module = {
          exports: {} as { system: { css(rule: { color: string }): string } }
        };
        new Function("module", "exports", "require", transformed.code)(
          module,
          module.exports,
          (id: string) => {
            if (id === "@vanilla-extract/css")
              return { style: (rule: { color: string }) => rule.color };
            throw new Error(`Unexpected import: ${id}`);
          }
        );
        expect(module.exports.system.css({ color: "red" })).toBe("red");
        expect(transformed.result[1]).not.toContain("style(rule)");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "exports.system = system; replace(exports.system);",
    "module.exports.system = system; replace(module.exports.system);",
    "module.exports = { system }; replace(module.exports.system);",
    "exports.system = system; const alias = exports.system; replace(alias);",
    "exports.system = system; replaceNamespace(exports);",
    "module.exports = { system }; replaceNamespace(module.exports);"
  ])(
    "diagnoses escaped CommonJS publications after local property stores: %s",
    (usage) => {
      const root = mkdtempSync(join(tmpdir(), "mincho-receiver-publication-"));
      const filename = join(root, "factory.cjs");
      const source = `const { style } = require("@vanilla-extract/css");
      const system = {
        helper(rule) { return style(rule); },
        css(rule) { return this.helper(rule); }
      };
      function replace(receiver) { receiver.helper = rule => rule.color; }
      function replaceNamespace(namespace) { replace(namespace.system); }
      ${usage}`;
      writeFileSync(filename, source);

      try {
        expect(() =>
          babelTransform(
            source,
            { extractCalls: { "./factory.cjs": ["system.css"] } },
            { root, filename }
          )
        ).toThrow(/Cannot use escaped extractCalls receiver/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each<[string, string, boolean, string]>([
    ["factory", "ns.system.css = replacement;", false, "blue"],
    [
      "factory",
      "const alias = ns.system; alias.css = replacement;",
      false,
      "blue"
    ],
    ["factory", "mutate(ns.system);", false, "blue"],
    ["factory", "mutateNamespace(ns);", false, "blue"],
    ["independent", "ns.system.css = replacement;", true, "red"],
    // Opaque consumers can reach function identities shared by shallow copies.
    ["copy", "mutateNamespace(ns);", false, "red"],
    ["factory", "siblings.first.system.css = replacement;", false, "blue"],
    ["factory", "siblings.second.system.css = replacement;", false, "blue"],
    [
      "factory",
      'siblings["second"]["system"].css = replacement;',
      false,
      "blue"
    ],
    [
      "factory",
      'const alias = siblings["second"]; mutateNamespace(alias);',
      false,
      "blue"
    ],
    ["factory", "mutateSiblings(siblings);", false, "blue"],
    [
      "independent",
      'siblings["second"]["system"].css = replacement;',
      true,
      "red"
    ],
    ["copy", "mutateSiblings(siblings);", false, "red"],
    ["factory", "if (ns.system.themeClass) {}", true, "red"],
    ["factory", "identity(ns.system.themeClass);", false, "red"]
  ])(
    "preserves receiver identity through namespace reexports: %s / %s / extracted=%s",
    (target, usage, extracted, color) => {
      const root = mkdtempSync(join(tmpdir(), "mincho-namespace-receiver-"));
      const sources = {
        "./factory.ts":
          'export const system = { themeClass: "theme", css: rule => rule.color };',
        "./independent.ts":
          'export const system = { css: () => "independent" };',
        "./copy.ts":
          'import { system as original } from "./factory.ts"; export const system = { ...original };',
        "./aliases.ts": `export * as first from "./${target}.ts";
          export * as second from "./${target}.ts";`,
        "./namespace.ts": `export * as ns from "./${target}.ts";
          export * as siblings from "./aliases.ts";`,
        "./barrel.ts":
          'export { ns as renamed, siblings } from "./namespace.ts";'
      };
      for (const [name, source] of Object.entries(sources))
        writeFileSync(join(root, name), source);
      const entry = `import { system } from "./factory.ts";
        import { renamed as ns, siblings } from "./barrel.ts";
        const replacement = () => "blue";
        const identity = value => value;
        const mutate = receiver => { receiver.css = replacement; };
        const mutateNamespace = namespace => { namespace.system.css = replacement; };
        const mutateSiblings = namespace => { namespace.second.system.css = replacement; };
        ${usage}
        export const cls = system.css({ color: "red" });`;

      try {
        const transformed = babelTransform(
          entry,
          { extractCalls: { "./factory.ts": ["system.css"] } },
          { root, filename: join(root, "entry.ts") }
        );

        const createModules = () => {
          const modules: Record<string, unknown> = {};
          for (const [name, source] of Object.entries(sources))
            modules[name] = executeModule(source, modules);
          return modules;
        };
        const original = executeModule(entry, createModules());
        const modules = createModules();
        const sidecar = executeModule(transformed.result[1], modules);
        const runtime = executeModule(transformed.code, {
          ...modules,
          [transformed.result[0]]: sidecar
        });

        expect(original.cls).toBe(color);
        expect(runtime.cls).toBe(original.cls);
        expect(transformed.result[1].includes("system.css(")).toBe(extracted);
        expect(transformed.code.includes("system.css(")).toBe(!extracted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "const box = { ...{ owner: system } }; const alias = box.owner; alias.helper = replacement;",
    "const source = { owner: system }; const box = { ...source }; replace(box.owner);",
    "const box = { ...{ nested: { owner: system } } }; const { owner } = box.nested; replace(owner);",
    "const box = { owner: system, ...{ label: 'safe' } }; box.owner.helper = replacement;",
    "const box = { ...{ get owner() { return system; } } }; replace(box.owner);"
  ])(
    "rejects shared receiver values selected through object spreads: %s",
    (usage) => {
      expect(() => transformReceiverBranch(usage)).toThrow(
        /Cannot use (?:mutated|escaped) extractCalls receiver/
      );
    }
  );

  it.each([
    "const box = { owner: system, ...{ owner: other } }; replace(box.owner);",
    "const box = { owner: system, ...{ ...{ owner: other } } }; replace(box.owner);",
    "const box = { ...{ owner: { ...system } } }; replace(box.owner);",
    "const source = { owner: { ...system } }; const box = { ...source }; replace(box.owner);",
    "const box = { ...{ label: system.themeClass } }; identity(box.label);"
  ])(
    "preserves independent receiver values selected through object spreads: %s",
    (usage) => {
      const transformed = transformReceiverBranch(
        `${usage} export const cls = system.css({ color: "red" });`
      );
      const execute = (source: string, modules: Record<string, unknown>) => {
        const module = { exports: {} as Record<string, unknown> };
        new Function(
          "module",
          "exports",
          "require",
          compileModule(source, { format: "cjs" }).code
        )(module, module.exports, (id: string) => {
          if (id in modules) return modules[id];
          throw new Error(`Unexpected import: ${id}`);
        });
        return module.exports;
      };
      const modules = {
        "@vanilla-extract/css": {
          style: (rule: { color: string }) => rule.color
        }
      };
      const sidecar = execute(transformed.result[1], modules);
      const runtime = execute(transformed.code, {
        ...modules,
        [transformed.result[0]]: sidecar
      });

      expect(runtime.cls).toBe("red");
      expect(transformed.result[1]).not.toContain("style(rule)");
    }
  );

  it.each<[string, string, boolean, string?]>([
    ["system", "wrapper.system.css = replacement;", false],
    ["system", "const alias = wrapper.system; alias.css = replacement;", false],
    [
      "system",
      "const { system: alias } = wrapper; alias.css = replacement;",
      false
    ],
    ["system", "mutate(wrapper.system);", false],
    ["system", "mutateWrapper(wrapper);", false],
    ["system", "mutateWrapper(wrapper);", false, "['system']"],
    // Own data-slot evidence does not summarize an opaque consumer's effects.
    ["{ ...system }", "mutateWrapper(wrapper);", false, "['system']"],
    ["system", "mutate(wrapper.__proto__);", false, "['__proto__']"],
    ["{ ...system }", "mutate(wrapper.__proto__);", false, "['__proto__']"],
    ["system", "wrapper.second.system.css = replacement;", false],
    ["{ ...system }", "wrapper.system.css = replacement;", true],
    ["{ css: () => 'independent' }", "wrapper.system.css = replacement;", true],
    ["system", "identity(wrapper.label);", true]
  ])(
    "preserves extraction safety through unregistered wrapper exports: %s / %s / extracted=%s / key=%s",
    (value, usage, extracted, key = "system") => {
      const root = mkdtempSync(join(tmpdir(), "mincho-wrapper-receiver-"));
      const factory = "export const system = { css: rule => rule.color };";
      const wrapper = `import { system } from "./factory.ts";
      const shared = { system };
        export const wrapper = { ${key}: ${value}, label: "theme"${usage.includes("second") ? ", first: shared, second: shared" : ""} };`;
      const entry = `import { system } from "./factory.ts";
      import { wrapper } from "./wrapper.ts";
      const replacement = () => "blue";
      const identity = value => value;
      const mutate = receiver => { receiver.css = replacement; };
      const mutateWrapper = box => { box.system.css = replacement; };
      ${usage}
      export const cls = system.css({ color: "red" });`;
      writeFileSync(join(root, "factory.ts"), factory);
      writeFileSync(join(root, "wrapper.ts"), wrapper);

      try {
        const { code, result } = babelTransform(
          entry,
          { extractCalls: { "./factory.ts": ["system.css"] } },
          { root, filename: join(root, "entry.ts") }
        );

        const createModules = () => {
          const modules: Record<string, unknown> = {
            "./factory.ts": executeModule(factory, {})
          };
          modules["./wrapper.ts"] = executeModule(wrapper, modules);
          return modules;
        };
        const original = executeModule(entry, createModules());
        const modules = createModules();
        const sidecar = executeModule(result[1], modules);
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });

        expect(runtime.cls).toBe(original.cls);
        expect(result[1].includes("system.css(")).toBe(extracted);
        expect(code.includes("system.css(")).toBe(!extracted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "const [...receivers] = [system]; replace(receivers[0]);",
    "const [head, ...receivers] = [other, system]; replace(receivers[0]);",
    "const [, ...receivers] = [other, system]; replace(receivers[0]);",
    "const [...first] = [other, system]; const [, ...receivers] = first; replace(receivers[0]);",
    "const [...receivers] = [[system]]; replace(receivers[0][0]);",
    "const [...receivers] = [{ owner: system }]; replace(receivers[0].owner);",
    "const prefix = [other]; prefix.length = 0; const [, ...receivers] = [...prefix, other, system]; replace(receivers[0]);",
    "const [...receivers] = [system]; identity(receivers);",
    "const [...receivers] = [system]; receivers[0].helper = replacement;"
  ])("rejects escaped array-rest element aliases: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      /Cannot use (?:mutated|escaped) extractCalls receiver/
    );
  });

  it.each([
    "let alias; replace(alias = system);",
    "let alias; (alias = system).helper = replacement;",
    "let alias; replace((alias = { owner: system }).owner);",
    "let alias; identity({ ...(alias = { owner: system }) });",
    "let alias; const { owner } = (alias = { owner: system }); replace(owner);"
  ])("rejects escaped assignment-expression results: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      /Cannot use (?:mutated|escaped) extractCalls receiver/
    );
  });

  it.each([
    "const [head, ...receivers] = [system, other]; replace(receivers[0]);",
    "const [...receivers] = [{ ...system }]; replace(receivers[0]);",
    "const [...receivers] = [system.themeClass]; identity(receivers[0]);",
    "const [, ...receivers] = [system]; identity(receivers);",
    "const [...receivers] = [system]; receivers[0] = other;",
    "const [...first] = [system, other]; const [, ...receivers] = first; replace(receivers[0]);",
    "const prefix = [system.themeClass]; const [, ...receivers] = [...prefix, other]; replace(receivers[0]);",
    "let alias; replace(alias = { ...system });",
    "let alias; identity(alias = system.themeClass);",
    "let alias; replace((alias = system, other));",
    "let alias; identity({ owner: system, ...(alias = { owner: other }) });",
    "let value = 0; identity(value += system);"
  ])(
    "preserves independent array-rest and assignment-expression results: %s",
    (usage) => {
      const transformed = transformReceiverBranch(
        `${usage}\nexport const cls = system.css({ color: 'red' });`
      );
      const execute = (source: string, modules: Record<string, unknown>) => {
        const module = { exports: {} as Record<string, unknown> };
        new Function(
          "module",
          "exports",
          "require",
          compileModule(source, { format: "cjs" }).code
        )(module, module.exports, (id: string) => {
          if (id in modules) return modules[id];
          throw new Error(`Unexpected import: ${id}`);
        });
        return module.exports;
      };
      const modules = {
        "@vanilla-extract/css": {
          style: (rule: { color: string }) => rule.color
        }
      };
      const sidecar = execute(transformed.result[1], modules);
      const runtime = execute(transformed.code, {
        ...modules,
        [transformed.result[0]]: sidecar
      });

      expect(runtime.cls).toBe("red");
      expect(transformed.result[1]).not.toContain("style(rule)");
    }
  );

  it.each([
    "const key = flag ? 'owner' : 'other'; const box = { owner: system }; box[key].helper = replacement;",
    "const key = flag ? 'owner' : 'other'; const box = { ...{ owner: system } }; box[key].helper = replacement;",
    "const key = flag ? 'owner' : 'other'; const box = { get owner() { return system; } }; box[key].helper = replacement;",
    "function owner() { return system; } owner().helper = replacement;",
    "const owner = () => system; owner().helper = replacement;",
    "const owner = () => system; const alias = owner; alias().helper = replacement;",
    "function owner() { return system; } const box = owner(); box.helper = replacement;",
    "const accessors = { owner() { return system; } }; accessors.owner().helper = replacement;",
    "const accessors = { owner: () => system }; accessors.owner().helper = replacement;",
    "const owners = [() => system]; owners[0]().helper = replacement;",
    "const key = flag ? 'owner' : 'other'; const accessors = { owner() { return system; } }; accessors[key]().helper = replacement;",
    "const owner = flag ? () => system : () => other; owner().helper = replacement;",
    "const box = { get owner() { return system; } }; replace(box.owner);",
    "const box = { get owner() { return system; } }; const alias = box.owner; alias.helper = replacement;",
    "const box = { get value() { return { owner: system }; } }; replace(box.value.owner);",
    "const box = { get owner() { return system; } }; const { owner } = box; replace(owner);",
    "const box = { owner: system }; const alias = box?.owner; alias.helper = replacement;",
    "const box = { owner: system }; replace(box?.owner);",
    "const box = { nested: { owner: system } }; replace(box?.nested?.owner);",
    "const alias = (0, system); alias.helper = replacement;",
    "replace((0, system));",
    "replace((0, { owner: system }).owner);",
    "identity((replace(system), other));"
  ])("rejects escaped or mutated receiver selection results: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      /Cannot use (?:mutated|escaped) extractCalls receiver/
    );
  });

  it.each([
    "const key = flag ? 'owner' : 'other'; const box = { owner: system }; box[key] = other;",
    "function owner() { function unused() { return system; } return other; } owner().helper = replacement;",
    "const owner = () => ({ ...system }); owner().helper = replacement;",
    "const accessors = { owner() { return { ...system }; } }; accessors.owner().helper = replacement;",
    "const box = { get owner() { return { ...system }; } }; replace(box.owner);",
    "const box = { get label() { return system.themeClass; } }; identity(box.label);",
    "const box = { get owner() { function unused() { return system; } return other; } }; replace(box.owner);",
    "const box = { label: system.themeClass }; identity(box?.label);",
    "const skipped = null; identity(skipped?.[replace(system)]?.owner);",
    "const box = { owner: { ...system } }; replace(box?.owner);",
    "const { ...copy } = system; const box = { owner: copy }; replace(box?.owner);",
    "replace((system, other));",
    "const alias = (0, { ...system }); replace(alias);",
    "identity({ owner: system, ...(0, { owner: other }) });"
  ])("preserves safe receiver selection results at runtime: %s", (usage) => {
    const transformed = transformReceiverBranch(
      `${usage} export const cls = system.css({ color: "red" });`
    );
    const execute = (source: string, modules: Record<string, unknown>) => {
      const module = { exports: {} as Record<string, unknown> };
      new Function(
        "module",
        "exports",
        "require",
        compileModule(source, { format: "cjs" }).code
      )(module, module.exports, (id: string) => {
        if (id in modules) return modules[id];
        throw new Error(`Unexpected import: ${id}`);
      });
      return module.exports;
    };
    const modules = {
      "@vanilla-extract/css": { style: (rule: { color: string }) => rule.color }
    };
    const sidecar = execute(transformed.result[1], modules);
    const runtime = execute(transformed.code, {
      ...modules,
      [transformed.result[0]]: sidecar
    });

    expect(runtime.cls).toBe("red");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "const { ...copy } = system; Object.keys(copy);",
    "const { ...copy } = system; copy.helper = replacement;",
    "const { nested: { ...copy } } = { nested: system }; Object.keys(copy);",
    'const { owner, ...copy } = { owner: system, label: "safe" }; identity(copy);',
    'const { 0: owner, ...copy } = [system, "safe"]; identity(copy);'
  ])("preserves fresh object-rest receiver copies: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "const { ...copy } = { owner: system }; identity(copy);",
    'const { label, ...copy } = { owner: system, label: "safe" }; const alias = copy; identity(alias);',
    "const { ...copy } = { owner: system }; copy.owner.helper = replacement;",
    "const { ...copy } = [system]; identity(copy);"
  ])(
    "retains nested receiver identity inside object-rest copies: %s",
    (usage) => {
      expect(() => transformReceiverBranch(usage)).toThrow(
        /Cannot use (?:mutated|escaped) extractCalls receiver/
      );
    }
  );

  it.each([
    ["if (false) tools.configure(system);", true],
    ["function later() { tools.configure(system); }", false]
  ] as const)(
    "preserves guarded registered namespace consumers: %s",
    (usage, extracted) => {
      const source = `import { system, tools } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`;
      const { code, result } = babelTransform(source, {
        extractCalls: {
          "test-preset": ["system.css", "tools.configure"]
        },
        optimize: { pureFunctions: false }
      });

      const createModules = () => {
        const calls: string[] = [];
        return {
          calls,
          preset: {
            system: {
              color: "red",
              css() {
                calls.push("css");
                return this.color;
              }
            },
            tools: {
              configure(receiver: { color: string }) {
                calls.push("configure");
                receiver.color = "blue";
                return "configured";
              }
            }
          }
        };
      };
      const original = createModules();
      const expected = executeModule(source, {
        "test-preset": original.preset
      });
      const compiled = createModules();
      const sidecar = executeModule(result[1], {
        "test-preset": compiled.preset
      });
      const runtime = executeModule(code, {
        "test-preset": compiled.preset,
        [result[0]]: sidecar
      });

      expect(expected.cls).toBe("red");
      expect(runtime.cls).toBe(expected.cls);
      expect(original.preset.system.color).toBe("red");
      expect(compiled.preset.system.color).toBe(original.preset.system.color);
      expect(original.calls).toEqual(["css"]);
      expect(compiled.calls).toEqual(original.calls);
      expect(code).toContain("tools.configure(system)");
      expect(result[1]).not.toContain("tools.configure(system)");
      expect(code.includes('color: "red"')).toBe(!extracted);
      expect(result[1].includes('color: "red"')).toBe(extracted);
    }
  );

  it.each([
    ["binary", 'system.color + ""', true, "blue", false],
    ["unary", "-system.spacing", true, -2, false],
    ["template", "`${system.color}`", true, "blue", false],
    [
      "conditional test",
      'system.enabled ? "blue" : "red"',
      true,
      "blue",
      false
    ],
    ["call", "identity(system.color)", true, "blue", false],
    ["constructor", "new Box(system.color).color", true, "blue", false],
    ["constructor capture", "new CapturedBox().color", true, "blue", false],
    [
      "unknown class evaluation",
      "(class { static color = system.color; }).color",
      true,
      "blue",
      false
    ],
    ["tagged template", "tag`${system.color}`", true, "blue", false],
    [
      "readonly binary with unproven coercion",
      'system.color + ""',
      false,
      "red",
      false
    ],
    [
      "readonly unary with unproven coercion",
      "-system.spacing",
      false,
      -1,
      false
    ],
    ["literal binary", '"red" + ""', false, "red", true],
    ["literal unary", "-1", false, -1, true],
    ["unselected branch", 'false ? system.color : "safe"', true, "safe", true]
  ] as const)(
    "inspects computed argument operands: %s",
    (_name, argument, mutated, expected, extracted) => {
      const source = `import { tools, system } from "test-preset";
        ${mutated ? 'system.color = "blue"; system.enabled = true; system.spacing = 2;' : ""}
        function identity(value) { return value; }
        function tag(strings, value) { return value; }
        class Box { constructor(color) { this.color = color; } }
        class CapturedBox { constructor() { this.color = system.color; } }
        export const cls = tools.css({ color: ${argument} });`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: { color: unknown }) {
              return value.color;
            }
          },
          system: { color: "red", enabled: false, spacing: 1 }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(expected);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(extracted);
    }
  );

  it.each([
    ["a sequence result", "(1, system)", true],
    ["an aliased sequence result", "selected", true],
    ["a nested sequence result", "(1, (2, system))", true],
    ["a readonly sequence result", "(1, system)", false],
    ["a discarded readonly sequence value", '(system, "red")', false],
    ["a primitive sequence result", '(1, "red")', false]
  ] as const)(
    "preserves sequence argument execution for %s",
    (_name, argument, mutated) => {
      const source = `import { tools, system } from "test-preset";
        ${mutated ? 'system.color = "blue";' : ""}
        ${argument === "selected" ? "const selected = (1, system);" : ""}
        export const cls = tools.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: string | { color: string }) {
              return typeof value === "string" ? value : value.color;
            }
          },
          system: { color: "red" }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(mutated ? "blue" : "red");
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(!mutated);
    }
  );

  it.each([
    ["a property key", "{ [system.color]: 4 }", true],
    ["a method key", "{ [system.color]() { return 4; } }", true],
    ["a getter key", "{ get [system.color]() { return 4; } }", true],
    ["a readonly property key", "{ [system.color]: 4 }", false],
    ["a static computed key", '{ ["red"]: 4 }', false],
    ["a noncomputed property key", "{ red: 4 }", false]
  ] as const)(
    "preserves computed argument key execution for %s",
    (_name, argument, mutated) => {
      const source = `import { tools, system } from "test-preset";
        ${mutated ? 'system.color = "blue";' : ""}
        export const cls = tools.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: { css: (value: object) => Object.keys(value)[0] },
          system: { color: "red" }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(mutated ? "blue" : "red");
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(!mutated);
    }
  );

  it.each([
    ["a conditional consequent", "flag ? system : other", true],
    ["a conditional alternate", "!flag ? other : system", true],
    ["a truthy logical left value", "system || other", true],
    ["a logical fallback", "null || system", true],
    ["a logical right value", "flag && system", true],
    ["a non-nullish left value", "system ?? other", true],
    ["a nullish fallback", "null ?? system", true],
    ["an aliased conditional", "selected", true],
    ["safe conditional primitives", 'flag ? "blue" : "red"', false],
    ["safe logical primitives", 'flag && "blue"', false],
    ["safe nullish primitives", 'null ?? "blue"', false]
  ] as const)(
    "preserves conditional and logical module arguments for %s",
    (_name, argument, mutated) => {
      const source = `import { tools, system, other } from "test-preset";
        const flag = true;
        ${mutated ? 'system.color = "blue";' : ""}
        ${argument === "selected" ? "const selected = flag ? system : other;" : ""}
        export const cls = tools.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: string | { color: string }) {
              return `color-${typeof value === "string" ? value : value.color}`;
            }
          },
          system: { color: "red" },
          other: { color: "red" }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe("color-blue");
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(!mutated);
      expect(code.includes("tools.css(")).toBe(mutated);
    }
  );

  it.each([
    ["a readonly container", "", "tools.css(input)", "red", true],
    [
      "a replaced slot consumed by the factory",
      'input.nested = { color: "blue" };',
      "tools.css(input)",
      "blue",
      false
    ],
    [
      "a replaced slot through a container alias",
      'const alias = input; alias.nested = { color: "blue" };',
      "tools.css(input)",
      "blue",
      false
    ],
    [
      "an independent slot replacement",
      'input.nested = { color: "blue" };',
      "system.css()",
      "red",
      true
    ]
  ] as const)(
    "distinguishes consumed container mutation from receiver mutation: %s",
    (_name, setup, expression, color, extracted) => {
      const source = `import { tools, system } from "test-preset";
        const input = { nested: system };
        ${setup}
        export const cls = ${expression};`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css", "system.css"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: { nested: { color: string } }) {
              return `color-${value.nested.color}`;
            }
          },
          system: {
            color: "red",
            css() {
              return `color-${this.color}`;
            }
          }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(`color-${color}`);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes(expression)).toBe(extracted);
      expect(code.includes(expression)).toBe(!extracted);
    }
  );

  it.each([
    ["shared plain groups", false],
    ["a replaced module-containing group", true]
  ] as const)("checks component factory arguments for %s", (_name, mutated) => {
    const source = `import { base, system, dark, createComponents, tokens } from "test-preset";
        const panelGroups = {
          layout: { panel: ${mutated ? "tokens" : '{ color: "red" }'} }
        };
        ${mutated ? 'panelGroups.layout.panel = { color: "blue" };' : ""}
        export const panels = {
          base: base.components(panelGroups),
          system: system.components({ ...panelGroups }),
          dark: dark.components(panelGroups),
          custom: createComponents({ ...panelGroups })
        };`;
    const { code, result } = babelTransform(source, {
      extractCalls: {
        "test-preset": [
          "base.components",
          "system.components",
          "dark.components",
          "createComponents"
        ]
      }
    });
    const createModules = () => {
      const components = (groups: { layout: { panel: { color: string } } }) =>
        `color-${groups.layout.panel.color}`;
      return {
        "test-preset": {
          base: { components },
          system: { components },
          dark: { components },
          createComponents: components,
          tokens: { color: "red" }
        }
      };
    };
    const original = executeModule(source, createModules());
    const sidecar = executeModule(result[1], createModules());
    const runtime = executeModule(code, {
      ...createModules(),
      [result[0]]: sidecar
    });

    expect(original.panels).toEqual({
      base: mutated ? "color-blue" : "color-red",
      system: mutated ? "color-blue" : "color-red",
      dark: mutated ? "color-blue" : "color-red",
      custom: mutated ? "color-blue" : "color-red"
    });
    expect(runtime.panels).toEqual(original.panels);
    for (const factory of [
      "base.components",
      "system.components",
      "dark.components",
      "createComponents"
    ]) {
      expect(result[1].includes(`${factory}(`)).toBe(!mutated);
      expect(code.includes(`${factory}(`)).toBe(mutated);
    }
  });

  it.each([
    ["nested eager builders", "", "defineRules(themeSpec(tokens))", true],
    [
      "a shared runtime builder",
      "defineRules(themeSpec(tokens));",
      "defineRules(themeSpec(tokens))",
      false
    ],
    [
      "a separately bound builder dependency",
      "const definition = defineRules(themeSpec(tokens));",
      "definition",
      false
    ],
    [
      "a separately extracted dependency",
      "const definition = themeSpec(tokens);",
      "definition",
      true
    ],
    [
      "a deferred namespace call",
      "",
      "() => builders.defineRules(themeSpec(tokens))",
      false
    ],
    [
      "an ignored nested builder",
      "",
      "/* mincho-js-ignore */ defineRules(themeSpec(tokens))",
      false
    ]
  ] as const)(
    "preserves wrapper-owned evaluation for %s",
    (_name, setup, argument, extracted) => {
      const source = `import { createComponents } from "test-preset";
        import { defineRules, themeSpec, tokens, builders } from "builders";
        ${setup}
        export const component = createComponents(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: {
          "test-preset": ["createComponents"],
          ...(_name === "a separately extracted dependency"
            ? { builders: ["themeSpec"] }
            : {})
        }
      });
      const createModules = () => {
        const calls: string[] = [];
        const defineRules = (value: { color: string }) => {
          calls.push(`rules:${value.color}`);
          return value;
        };
        return {
          calls,
          modules: {
            "test-preset": {
              createComponents(
                value: { color: string } | (() => { color: string })
              ) {
                calls.push("components");
                const definition =
                  typeof value === "function" ? value() : value;
                return `component-${definition.color}`;
              }
            },
            builders: {
              defineRules,
              themeSpec(value: { color: string }) {
                calls.push(`theme:${value.color}`);
                return value;
              },
              tokens: { color: "red" },
              builders: { defineRules }
            }
          }
        };
      };
      const original = createModules();
      const expected = executeModule(source, original.modules);
      const compiled = createModules();
      const sidecar = executeModule(result[1], compiled.modules);
      const runtime = executeModule(code, {
        ...compiled.modules,
        [result[0]]: sidecar
      });

      expect(expected.component).toBe("component-red");
      expect(runtime.component).toBe(expected.component);
      expect(compiled.calls).toEqual(original.calls);
      expect(result[1].includes("createComponents(")).toBe(extracted);
      expect(code.includes("createComponents(")).toBe(!extracted);
      if (extracted) {
        expect(result[1]).toContain(
          _name === "a separately extracted dependency"
            ? "themeSpec(tokens)"
            : "defineRules(themeSpec(tokens))"
        );
        expect(code).not.toContain("defineRules(");
        expect(code).not.toContain("themeSpec(");
      }
    }
  );

  it.each([
    ["known consequent", 'true ? "red" : system', "red", true],
    ["known alternate", 'false ? system : "red"', "red", true],
    ["known truthy left", '"red" || system', "red", true],
    ["known non-nullish left", '"red" ?? system', "red", true],
    ["known falsy left", "false && system", "false", true],
    ["known aliased conditional", "input", "red", true],
    ["known ignored namespace", 'true ? "red" : system', "red", true],
    ["unknown consequent", 'flag ? "red" : system', "red", false],
    ["unknown alternate", 'flag ? system : "red"', "blue", false],
    ["unknown ignored namespace", 'flag ? system : "red"', "blue", false]
  ] as const)(
    "checks argument branch reachability for %s",
    (_name, argument, color, extracted) => {
      const source = `import { tools, system } from "test-preset";
        import { flag, mutate } from "outside";
        ${_name.includes("ignored") ? "/* mincho-js-ignore */ mutate(system);" : 'system.color = "blue";'}
        ${argument === "input" ? 'const input = true ? { color: "red" } : system;' : ""}
        export const cls = tools.css(${argument});`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.css"], outside: ["mutate"] }
      });
      const createModules = () => ({
        "test-preset": {
          tools: {
            css(value: string | boolean | { color: string }) {
              return `color-${typeof value === "object" ? value.color : String(value)}`;
            }
          },
          system: { color: "red" }
        },
        outside: {
          flag: true,
          mutate(value: { color: string }) {
            value.color = "blue";
          }
        }
      });
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(`color-${color}`);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("tools.css(")).toBe(extracted);
      expect(code.includes("tools.css(")).toBe(!extracted);
    }
  );

  it("extracts an unconditional registered namespace consumer", () => {
    const { code, result } = babelTransform(
      `import { system, tools } from "test-preset";
       tools.configure(system);
       export const cls = system.css({ color: "red" });`,
      {
        extractCalls: {
          "test-preset": ["system.css", "tools.configure"]
        },
        optimize: { pureFunctions: false }
      }
    );

    expect(result[1]).toContain("tools.configure(system)");
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
  });

  it.each([
    ["a configured cx reader", "cx(input);", "red", true],
    ["an arbitrary mutator", "mutate(input);", "blue", false],
    [
      "an ignored registered mutator",
      "/* mincho-js-ignore */ configure(input);",
      "blue",
      false
    ],
    [
      "an ignored configured cx call",
      "/* mincho-js-ignore */ cx(input);",
      "red",
      false
    ]
  ] as const)(
    "validates configured CSS argument consumers beside %s",
    (_name, setup, color, extracted) => {
      const source = `import { cx, configure } from "custom-preset";
        import { mutate } from "outside";
        const input = ["red"];
        ${setup}
        export const cls = cx(input);`;
      const { code, result } = babelTransform(source, {
        jsxCssProp: { importSource: "custom-preset" },
        extractCalls: { "custom-preset": ["cx", "configure"] }
      });
      const createModules = () => {
        const mutate = (value: string[]) => {
          value[0] = "blue";
        };
        return {
          "custom-preset": {
            cx: (value: string[]) => `color-${value[0]}`,
            configure: mutate
          },
          outside: { mutate }
        };
      };
      const original = executeModule(source, createModules());
      const sidecar = executeModule(result[1], createModules());
      const runtime = executeModule(code, {
        ...createModules(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe(`color-${color}`);
      expect(runtime.cls).toBe(original.cls);
      expect(result[1].includes("cx(input)")).toBe(extracted);
      expect(code.includes("export const cls = cx(input)")).toBe(!extracted);
    }
  );

  it.each([
    {
      name: "a false branch",
      usage: "if (false) tools.configure(system);",
      argument: "system",
      extracted: false,
      classExtracted: true,
      color: "red"
    },
    {
      name: "a deferred call",
      usage: "function later() { tools.configure(system); }",
      argument: "system",
      extracted: false,
      classExtracted: false,
      color: "red"
    },
    {
      name: "an unconditional call",
      usage: "tools.configure(system);",
      argument: "system",
      extracted: true,
      classExtracted: true,
      color: "blue"
    },
    {
      name: "a leaf function argument",
      usage: "if (false) tools.configure(system.css);",
      argument: "system.css",
      extracted: false,
      classExtracted: true,
      color: "red"
    }
  ])(
    "preserves flat-export namespace consumption in $name",
    ({ usage, argument, extracted, classExtracted, color }) => {
      const root = mkdtempSync(join(tmpdir(), "mincho-flat-namespace-"));
      const systemSource = `export const state = { color: "red" };
        export function css() { return state.color; }`;
      writeFileSync(join(root, "system.ts"), systemSource);

      try {
        const source = `import * as system from "./system.ts";
           import { tools } from "test-preset";
           ${usage}
           export const cls = system.css();`;
        const { code, result } = babelTransform(
          source,
          {
            extractCalls: {
              "./system.ts": ["css"],
              "test-preset": ["tools.configure"]
            },
            optimize: { pureFunctions: false }
          },
          { root, filename: join(root, "entry.ts") }
        );
        const call = `tools.configure(${argument})`;
        const createModules = () => {
          const system = executeModule(systemSource, {});
          const calls: string[] = [];
          return {
            system,
            calls,
            modules: {
              "./system.ts": system,
              "test-preset": {
                tools: {
                  configure(
                    receiver: { state: { color: string } } | (() => string)
                  ) {
                    calls.push(typeof receiver);
                    if (typeof receiver !== "function")
                      receiver.state.color = "blue";
                    return "configured";
                  }
                }
              }
            }
          };
        };
        const originalModules = createModules();
        const original = executeModule(source, originalModules.modules);
        const compiledModules = createModules();
        const sidecar = executeModule(result[1], compiledModules.modules);
        const runtime = executeModule(code, {
          ...compiledModules.modules,
          [result[0]]: sidecar
        });

        expect(original.cls).toBe(color);
        expect(runtime.cls).toBe(original.cls);
        expect(compiledModules.system.state).toEqual(
          originalModules.system.state
        );
        expect(compiledModules.calls).toEqual(originalModules.calls);
        expect(result[1].includes(call)).toBe(extracted);
        expect(code.includes(call)).toBe(!extracted);
        expect(result[1].includes("system.css()")).toBe(classExtracted);
        expect(code.includes("system.css()")).toBe(!classExtracted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("retains a live consumer after direct eval changes a local condition", () => {
    const root = mkdtempSync(join(tmpdir(), "mincho-live-eval-condition-"));
    const systemSource = `export function css() { return css.color || "red"; }`;
    writeFileSync(join(root, "system.ts"), systemSource);
    const source = `import * as system from "./system.ts";
      import { mutate } from "outside";
      let enabled = false;
      eval("enabled = true");
      if (enabled) mutate(system.css);
      export const cls = system.css();`;
    try {
      const { code, result } = babelTransform(
        source,
        {
          extractCalls: { "./system.ts": ["css"] },
          optimize: { pureFunctions: false }
        },
        { root, filename: join(root, "entry.ts") }
      );
      const createModules = () => ({
        "./system.ts": executeModule(systemSource, {}),
        outside: {
          mutate(value: { color?: string }) {
            value.color = "blue";
          }
        }
      });
      const original = executeModule(source, createModules());
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.cls).toBe("blue");
      expect(runtime.cls).toBe(original.cls);
      expect(result[1]).not.toContain("system.css(");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["if (false) system.configure();", true],
    ["false && system.configure();", true],
    ["const deferred = () => system.configure();", false],
    ["for (let index = 0; index < 0; index++) system.configure();", false],
    ["try { throw new Error(); system.configure(); } catch {}", false],
    ["class Deferred { value = system.configure(); }", false]
  ] as const)(
    "preserves a registered sibling's execution guard: %s",
    (guarded, classExtracted) => {
      const source = `import { system } from "test-preset";
      ${guarded}
      export const className = system.css({ color: "red" });`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["system.configure", "system.css"] },
        optimize: { pureFunctions: false }
      });

      const createModules = () => ({
        "test-preset": {
          system: {
            color: "red",
            configure() {
              this.color = "blue";
              return "configured";
            },
            css() {
              return this.color;
            }
          }
        }
      });
      const originalModules = createModules();
      const original = executeModule(source, originalModules);
      const modules = createModules();
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

      expect(original.className).toBe("red");
      expect(runtime.className).toBe(original.className);
      expect(modules["test-preset"].system.color).toBe(
        originalModules["test-preset"].system.color
      );
      expect(code).toContain("system.configure()");
      expect(code.includes("system.css(")).toBe(!classExtracted);
      expect(result[1].includes("system.css(")).toBe(classExtracted);
      expect(result[1]).not.toContain("system.configure()");
    }
  );

  it("keeps standalone component-local nested styles extractable", () => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       export function component() {
         return system.css({ color: "red" });
       }`,
      { extractCalls }
    );

    expect(code).not.toContain("system.css(");
    expect(result[1]).toContain("system.css({");
    expect(result[1]).toContain('color: "red"');
  });

  it.each([
    '{ root: system.css({ color: "red" }), title: system.css({ color: "blue" }) }',
    '[system.css({ color: "red" }), system.css({ color: "blue" })]'
  ])("extracts immediately evaluated grouped authoring: %s", (styles) => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
      export const styles = ${styles};`,
      { extractCalls, optimize: { pureFunctions: false } }
    );

    expect(code).not.toContain("system.css(");
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
  });

  it.each([
    '{ [system.css({ color: "red" })]: system.css({ color: "blue" }) }',
    '[...system.css({ color: "red" }), system.css({ color: "blue" })]'
  ])("keeps grouped result coercion or iteration runtime: %s", (styles) => {
    const source = `import { system } from "test-preset";
      export const styles = ${styles};`;
    const { code, result } = babelTransform(source, { extractCalls });
    const modules = {
      "test-preset": {
        system: {
          css({ color }: { color: string }) {
            return color;
          }
        }
      }
    };
    const original = executeModule(source, modules);
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });

    expect(runtime.styles).toEqual(original.styles);
    expect(code).toContain("system.css(");
    expect(result[1]).not.toContain("system.css(");
  });

  it.each([
    "function replaceBox(box) { box.owner.helper = replacement; } replaceBox({ owner: system });",
    "function replaceBox(box) { box.owner.helper = replacement; } const owner = system; replaceBox({ owner });",
    "function replaceBox(box) { box.nested.owner.helper = replacement; } const box = { nested: { owner: system } }; replaceBox(box);",
    "function replaceBox(box) { box.owner.helper = replacement; } replaceBox({ owner: flag ? system : other });",
    "function replaceBox(box) { box.owners[0].helper = replacement; } replaceBox({ owners: [system] });",
    "function replaceBox(box) { box.owner.helper = replacement; } replaceBox({ owner: other, owner: system });"
  ])("rejects receiver argument containers: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      "Cannot use escaped extractCalls receiver"
    );
  });

  it.each([
    "function replaceBox(box) { box.owner.helper = replacement; } replaceBox({ ...{ owner: system } });",
    "function replaceBox(box) { box.owner.helper = replacement; } const box = { owner: system }; replaceBox({ ...box });"
  ])("rejects receiver wrapper spreads: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      "Cannot use escaped extractCalls receiver"
    );
  });

  it.each([
    "replace(...[system]);",
    "const owners = [system]; replace(...owners);",
    "replace(...[...(flag ? [system] : [other])]);",
    "function replaceList(list) { list[0].helper = replacement; } replaceList([...[system]]);",
    "const owners = [system]; function replaceBox(box) { box.owners[0].helper = replacement; } replaceBox({ owners: [...owners] });",
    "new replace(...[system]);",
    "function replaceBox(box) { box.owner.helper = replacement; } replaceBox(...[{ ...{ owner: system } }]);"
  ])(
    "rejects receiver escapes through argument and array spreads: %s",
    (usage) => {
      expect(() => transformReceiverBranch(usage)).toThrow(
        "Cannot use escaped extractCalls receiver"
      );
    }
  );

  it.each([
    "const [owner] = [...[system]]; replace(owner);",
    "const owners = [system]; const [owner] = [...owners]; replace(owner);",
    "const [owner] = [...(flag ? [system] : [other])]; replace(owner);",
    "const { 0: omitted, ...copy } = [...[other, system]]; function replaceBox(box) { box[1].helper = replacement; } replaceBox(copy);"
  ])("rejects receiver escapes selected through array spreads: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      "Cannot use escaped extractCalls receiver"
    );
  });

  it.each([
    "const prefix = [other]; prefix.length = 0; const [owner] = [...prefix, system]; replace(owner);",
    "const prefix = [system]; prefix.unshift(other); const [, owner] = [...prefix, other]; replace(owner);",
    "const prefix = [other]; const alias = prefix; alias.length = 0; const [owner] = [...prefix, system]; replace(owner);",
    "const prefix = [other]; function shrink(values) { values.length = 0; } shrink(prefix); const [owner] = [...prefix, system]; replace(owner);"
  ])("rejects receiver escapes after mutable spread offsets: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      "Cannot use escaped extractCalls receiver"
    );
  });

  it.each([
    "replace?.(system);",
    "const caller = replace; caller?.(system);",
    "const box = { replace }; box?.replace(system);",
    "const box = { replace }; box.replace?.(system);",
    "replace?.(...[system]);",
    "const caller = flag ? replace : null; caller?.(system);",
    "(replace(system), null)?.(other);"
  ])(
    "rejects receiver escapes through executable optional calls: %s",
    (usage) => {
      expect(() => transformReceiverBranch(usage)).toThrow(
        "Cannot use escaped extractCalls receiver"
      );
    }
  );

  it.each([
    "replace(...[{ ...system }]);",
    "const { ...copy } = system; replace(...[copy]);",
    "identity(...[system.themeClass]);",
    "identity([...['other', system.themeClass]]);",
    "const [label] = [...[system.themeClass, system]]; identity(label);",
    "const prefix = [system.themeClass]; const alias = prefix; const [label] = [...alias, system]; identity(label);",
    "const prefix = [system.themeClass]; const length = prefix.length; const [label] = [...prefix, system]; identity(label + length);",
    "const [label] = [system.themeClass, ...(flag ? [system] : [other])]; identity(label);",
    "const { 0: omitted, ...copy } = [...[system, other]]; identity(copy);",
    "const skipped = null; skipped?.(system);",
    "const skipped = undefined; skipped?.(system);",
    "const skipped = null; skipped?.replace(system);",
    "(null as typeof replace | null)?.(system);",
    "const skipped = null; skipped?.(replace(system));",
    "const skipped = null; skipped?.(system.helper = replacement);",
    "const skipped = null; skipped?.replace(replace(system));",
    "replace?.({ ...system });",
    "identity?.(system.themeClass);"
  ])(
    "preserves copied, primitive, and skipped optional receiver arguments: %s",
    (usage) => {
      const transformed = transformReceiverBranch(
        `${usage} export const cls = system.css({ color: "red" });`
      );
      const executeModule = (
        source: string,
        modules: Record<string, unknown>
      ) => {
        const module = { exports: {} as Record<string, unknown> };
        const body = compileModule(source, { format: "cjs" }).code;
        new Function("module", "exports", "require", body)(
          module,
          module.exports,
          (id: string) => {
            if (id in modules) return modules[id];
            throw new Error(`Unexpected import: ${id}`);
          }
        );
        return module.exports;
      };
      const modules = {
        "@vanilla-extract/css": {
          style: (rule: { color: string }) => rule.color
        }
      };
      const sidecar = executeModule(transformed.result[1], modules);
      const runtime = executeModule(transformed.code, {
        ...modules,
        [transformed.result[0]]: sidecar
      });

      expect(runtime.cls).toBe("red");
      expect(transformed.result[1]).not.toContain("style(rule)");
    }
  );

  it.each([
    "identity({ ...{ owner: system }, owner: other });",
    "const box = { owner: system }; identity({ ...box, owner: other });"
  ])("preserves overridden receiver wrapper spreads: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "identity({ owner: system, ...{ owner: other } });",
    "identity({ owner: system, ...{ ...{ owner: other } } });",
    "identity({ ...{ owner: system }, ...{ owner: other } });",
    "identity({ owner: system, ...{ owner() { return other; } } });",
    "identity({ owner: system, ...({ owner: other } as const) });",
    "identity({ owner: system, ...({ owner: other } satisfies { owner: unknown }) });",
    "identity({ owner: system, ...({ owner: other }!) });"
  ])("preserves known receiver spread overrides: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "replaceBox({ owner: other, ...{ owner: system } });",
    "replaceBox({ owner: other, ...({ owner: system } as const) });",
    "replaceBox({ owner: other, ...({ owner: system } satisfies { owner: unknown }) });",
    "replaceBox({ owner: other, ...({ owner: system }!) });",
    'replaceBox({ owner: system, ...{ label: "other" } });',
    "replaceBox({ owner: system, ...(flag ? {} : { owner: other }) });",
    "let box = { owner: other }; box = {}; replaceBox({ owner: system, ...box });"
  ])("rejects remaining receiver spread escapes: %s", (usage) => {
    expect(() =>
      transformReceiverBranch(
        `function replaceBox(box) { box.owner.helper = replacement; } ${usage}`
      )
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it.each([
    "replaceBox({ owner: system, ...{ get owner() { return system; } } });",
    "replaceBox({ owner: system, ...({ get owner() { return system; } } as const) });",
    "replaceBox({ owner: system, ...{ ...{ get owner() { return system; } } } });",
    "replaceBox({ owner: system, ...{ owner: other, ...{ get owner() { return system; } } } });"
  ])("rejects receiver escapes through getter spreads: %s", (usage) => {
    expect(() =>
      transformReceiverBranch(
        `function replaceBox(box) { box.owner.helper = replacement; } ${usage}`
      )
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it.each([
    "identity({ owner: system, ...{ get owner() { return system; } }, owner: other });",
    "identity({ owner: system, ...{ get owner() { return system; } }, ...{ owner: other } });",
    'identity({ owner: system, ...{ get label() { return "other"; }, owner: other } });'
  ])("preserves data overrides around getter spreads: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "replaceBox({ owner: other, ...{ get owner() { return system; } } });",
    "const owner = system; replaceBox({ get owner() { return owner; } });",
    "replaceBox({ get owner() { return flag ? system : other; } });",
    "replaceBox({ get owner() { return system; } });"
  ])("rejects getter receiver returns: %s", (usage) => {
    expect(() =>
      transformReceiverBranch(
        `function replaceBox(box) { box.owner.helper = replacement; } ${usage}`
      )
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it.each([
    "const box = { get owner() { return system; }, set owner(value) {} }; box.owner.helper = replacement;",
    "const box = { set owner(value) {}, get owner() { return system; } }; box.owner.helper = replacement;",
    "const box = { get owner() { return system; }, set owner(value) {} }; replaceBox(box);",
    "for (const owner of [system]) { owner.helper = replacement; }",
    "for (let owner of [system]) { owner.helper = replacement; }",
    "let owner; for (owner of [system]) { owner.helper = replacement; }",
    "for (const { owner } of [{ owner: system }]) { owner.helper = replacement; }",
    "let owner; for ({ owner } of [{ owner: system }]) { owner.helper = replacement; }",
    "for (const [owner] of [[system]]) { owner.helper = replacement; }"
  ])("tracks receiver accessors and iteration bindings: %s", (usage) => {
    expect(() =>
      transformReceiverBranch(
        `function replaceBox(box) { box.owner.helper = replacement; } ${usage}`
      )
    ).toThrow(/Cannot use (mutated|escaped) extractCalls receiver/);
  });

  it.each([
    "identity({ get owner() { return system; }, owner: other, set owner(value) {} });",
    "identity({ get owner() { return system; }, set owner(value) {}, owner: other });",
    "for (const owner of [{ nested: system }]) { owner.helper = replacement; }",
    "for (const owner of [{ ...system }]) { owner.helper = replacement; }"
  ])("preserves independent accessor and iteration owners: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);
    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it("ignores nested-function getter receiver returns", () => {
    const transformed = transformReceiverBranch(
      "identity({ get owner() { function unused() { return system; } return other; } });"
    );

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "new replace(system);",
    "const owner = system; new replace(owner);",
    "new replace(flag ? system : other);",
    "class Replace { constructor(box) { box.owner.helper = replacement; } } new Replace({ owner: system });"
  ])("rejects receiver constructor arguments: %s", (usage) => {
    expect(() => transformReceiverBranch(usage)).toThrow(
      "Cannot use escaped extractCalls receiver"
    );
  });

  it.each([
    "identity({ label: system.themeClass });",
    "identity({ nested: { labels: [system.themeClass] } });",
    "identity({ owner: other });",
    "identity({ owner: system, owner: other });",
    "identity({ owner: system, owner() { return other; } });",
    "identity({ owner: system && other });",
    "identity({ ...system });",
    "const box = { owner: system }; box.label = 'text';",
    "new replace(other);",
    "class Label { constructor(value) { this.value = value; } } new Label({ label: system.themeClass });"
  ])("preserves harmless receiver argument values: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each(
    [
      "const alias = true ? system : {};",
      "const alias = false ? {} : system;",
      "const alias = flag && system;",
      "const alias = system || {};",
      "const alias = false || system;",
      "const alias = system ?? {};",
      "const alias = null ?? system;",
      "const { selected: alias } = flag ? { selected: system } : { selected: {} };",
      "let alias; alias = flag ? alias : system;"
    ].flatMap((selection) => [
      [selection, "alias.helper = replacement;", "mutated"],
      [selection, "replace(alias);", "escaped"]
    ])
  )(
    "rejects receiver branch %s with %s",
    (selection, operation, diagnostic) => {
      expect(() =>
        transformReceiverBranch(`${selection} ${operation}`)
      ).toThrow(`Cannot use ${diagnostic} extractCalls receiver`);
    }
  );

  it.each([
    "const alias = system ? other : {}; alias.helper = replacement;",
    "const alias = system && other; alias.helper = replacement;",
    "replace(system && other);",
    "const alias = flag ? other : {}; replace(alias);",
    "const label = flag ? system.themeClass : 'fallback'; identity(label);",
    "const label = (flag ? system : other).themeClass; identity(label);",
    "const label = system.themeClass || 'fallback'; identity(label);",
    "const label = system.themeClass ?? 'fallback'; identity(label);",
    "identity(system && system.themeClass);"
  ])("preserves harmless receiver branch values: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    'let label = preset.system.themeClass; label += " extra"; export const kind = typeof label;',
    'let { themeClass: label } = preset.system; label = "other"; export const kind = typeof label;',
    "let method = preset.system.css; method = replacement; export const kind = typeof method;"
  ])(
    "does not treat a copied binding reassignment as an owner write: %s",
    (copy) => {
      const { code, result } = transformDataPreset(
        `const preset = require("test-preset");
       ${copy}
       export const cls = preset.system.css({ color: "red" });`
      );

      expect(code).not.toContain('color: "red"');
      expect(result[1]).toContain('color: "red"');
    }
  );

  it.each([
    'const settings = preset.system.settings; settings.mode = "blue";',
    'const method = preset.system.css; method.settings.mode = "blue";'
  ])(
    "still rejects writes through copied object or function bindings: %s",
    (write) => {
      expect(() =>
        babelTransform(
          `const preset = require("test-preset");
         ${write}
         export const cls = preset.system.css({ color: "red" });`,
          { extractCalls }
        )
      ).toThrow("Cannot safely extract");
    }
  );

  it.each([false, true])(
    "extracts preset authoring beside generated className merging with pure functions %s",
    (pureFunctions) => {
      const { code, result } = babelTransform(
        `import { css, styled, rules, cx, themeClass } from "test-preset";
         const Button = styled.button({
           base: { text: "white", px: 2, py: 1 },
           variants: { tone: { solid: { bg: "blue-500" } } },
           defaultVariants: { tone: "solid" }
         });
         const Link = styled("a", { base: { text: "blue-700" } });
         const parent = rules({ base: { p: 1 } });
         const extended = rules.extends(parent, { base: { rounded: true } });
         const labels = rules.multiple({ label: { base: { font: "bold" } } });
         const labelClass = css({ text: "blue-700" });
         export function App() {
           return <main className={themeClass} css={{ p: 2 }}>
             <Button tone="solid" css={{ px: 3 }}>Grow</Button>
             <Link href="/docs">Documentation</Link>
             <span className={cx(extended(), labels.label(), labelClass)}>Label</span>
           </main>;
         }`,
        {
          jsxCssProp: { importSource: "test-preset" },
          extractCalls: {
            "test-preset": [
              "css",
              "rules",
              "rules.extends",
              "rules.multiple",
              "cx",
              "styled",
              "styled.button"
            ]
          },
          optimize: { pureFunctions }
        }
      );

      for (const authoring of [
        "styled.button(",
        'styled("a",',
        "rules({",
        "rules.extends(",
        "rules.multiple(",
        "css({"
      ]) {
        expect(result[1]).toContain(authoring);
        expect(code).not.toContain(authoring);
      }

      expect(code).toContain('from "@mincho-js/css/classname"');
      expect(code).toMatch(/className=\{_cx\(themeClass,/);
      expect(result[1]).not.toContain("_cx(themeClass,");
    }
  );

  it.each([
    [
      'import { cx } from "./runtime";',
      "<div className={cx(system.themeClass)} css={{ color: 'blue' }} />"
    ],
    [
      'import { cx as _cx } from "@mincho-js/css/classname";',
      "<div className={_cx(system.themeClass)} css={{ color: 'blue' }} />"
    ],
    ["", "<Component className={system.themeClass} css={{ color: 'blue' }} />"],
    ["", "<div className={system} css={{ color: 'blue' }} />"]
  ])("keeps unsafe className consumers at runtime: %s %s", (imports, jsx) => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       ${imports}
       export const cls = system.css({ color: "red" });
       export const view = () => ${jsx};`,
      { extractCalls, jsxCssProp: true }
    );

    expect(code).toContain('color: "red"');
    expect(result[1]).not.toContain('color: "red"');
  });

  it("keeps an unsafe registered cycle despite generated className merging", () => {
    const { code, result } = babelTransform(
      `import { first, second } from "test-preset";
       export const firstClass = first.css(second);
       export const secondClass = second.css(first);
       consume(second);
       export const view = () => <div className={first.themeClass} css={{ color: "blue" }} />;`,
      {
        extractCalls: { "test-preset": ["first.css", "second.css"] },
        jsxCssProp: true
      }
    );

    expect(code).toContain("first.css(second)");
    expect(code).toContain("second.css(first)");
    expect(result[1]).not.toContain("first.css(second)");
    expect(result[1]).not.toContain("second.css(first)");
  });

  it("bounds safety traversal across repeated registered sibling calls", ({
    onTestFinished
  }) => {
    const callCount = 12;
    const original = bindings.getExtractionModuleReference;
    const analysis = vi
      .spyOn(bindings, "getExtractionModuleReference")
      .mockImplementation((...args) => {
        // Count graph traversals instead of relying on machine-dependent timing.
        if (analysis.mock.calls.length > callCount * callCount * 4)
          throw new Error(
            "Registered-call safety traversal exceeded its bound"
          );

        return original(...args);
      });

    onTestFinished(() => analysis.mockRestore());

    const declarations = Array.from(
      { length: callCount },
      (_, index) =>
        `export const c${index} = system.css({ color: "color-${index}" });`
    ).join("\n");
    const { code, result } = babelTransform(
      `import { system } from "test-preset"; ${declarations}`,
      { extractCalls }
    );

    for (let index = 0; index < callCount; index++) {
      expect(result[1]).toContain(`color: "color-${index}"`);
      expect(code).not.toContain(`color: "color-${index}"`);
    }
    expect(analysis.mock.calls.length).toBeGreaterThan(0);
  });

  it.each([
    "",
    "consume(third);",
    "/* mincho-js-ignore */ third.css(first);",
    "third.configure = replacement; third.configure(first);"
  ])("propagates unsafe consumers through registered cycles: %s", (usage) => {
    const { code, result } = babelTransform(
      `import { first, second, third } from "test-preset";
       export const a = first.css(second);
       export const b = second.css(first);
       export const c = second.css(third);
       export const d = third.css(second);
       ${usage}`,
      {
        extractCalls: {
          "test-preset": [
            "first.css",
            "second.css",
            "third.css",
            "third.configure"
          ]
        }
      }
    );

    for (const call of [
      "first.css(second)",
      "second.css(first)",
      "second.css(third)",
      "third.css(second)"
    ]) {
      if (usage) {
        expect(code).toContain(call);
        expect(result[1]).not.toContain(call);
      } else {
        expect(result[1]).toContain(call);
        expect(code).not.toContain(call);
      }
    }
  });

  it.each([
    ['import { system as preset } from "test-preset";', "preset.css"],
    ['import * as presets from "test-preset";', "presets.system.css"],
    [
      'import { system } from "test-preset"; const local = system;',
      'local["css"]'
    ],
    [
      'import * as presets from "test-preset"; const { system: local } = presets;',
      "local.css"
    ],
    [
      'import { system } from "test-preset"; const { css: style } = system;',
      "style"
    ],
    [
      'import { system } from "test-preset"; const local = system satisfies { css: Function };',
      "local.css"
    ],
    ['const presets = require("test-preset");', "presets.system.css"],
    ['const presets = require("test-preset");', "(0, presets.system.css)"],
    ['const presets = require("test-preset");', "(0, 0, presets.system.css)"],
    ['const { system } = require("test-preset");', "(0, system.css)"],
    [
      'const { system } = require("test-preset"); const style = system.css;',
      "(0, style)"
    ],
    ['import { system } from "test-preset";', "(0, system.css)"],
    ['const { system } = require("test-preset");', "system.css"]
  ])("extracts supported static import paths: %s", (imports, callee) => {
    const { code, result } = babelTransform(
      `${imports} export const cls = ${callee}({ color: "red" });`,
      { extractCalls }
    );
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
    expect(code).toContain(result[0]);
  });

  it("keeps other exports, shadowed names and runtime recipe calls", () => {
    const { code, result } = babelTransform(
      `
      import { system, dark } from "test-preset";
      const button = system.rules({base: {color: "red"}});
      export const cls = button({active: true});
      export const other = dark.css({color: "blue"});
      export function local(system) { return system.css({color: "green"}); }
    `,
      { extractCalls }
    );
    expect(result[1]).toContain("system.rules");
    expect(result[1]).not.toContain("dark.css");
    expect(code).toContain("button({");
    expect(code).toContain("dark.css({");
    expect(code).toContain("system.css({");
  });

  it.each([true, false])(
    "extracts registered CommonJS default and nested calls in either order: nested first %s",
    (nestedFirst) => {
      const calls = [
        'export const nested = preset.system.css({ color: "red" });',
        'export const direct = preset({ color: "blue" });'
      ];
      const { code, result } = babelTransform(
        `const preset = require("test-preset");
         ${(nestedFirst ? calls : calls.toReversed()).join("\n")}`,
        { extractCalls: { "test-preset": ["system.css", "default"] } }
      );

      expect(result[1]).toContain("preset.system.css(");
      expect(result[1]).toContain("preset({");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
      expect(code).not.toContain("preset.system.css(");
      expect(code).not.toContain("preset({");
    }
  );

  it("still diagnoses unregistered CommonJS default calls as namespace escapes", () => {
    expect(() =>
      babelTransform(
        `const preset = require("test-preset");
         export const nested = preset.system.css({ color: "red" });
         preset({ color: "blue" });`,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract.*[Ee]scaped/);
  });

  it.each([
    "const kind = typeof system.preset;",
    "export const view = () => <div className={system.themeClass} />;",
    "const { preset } = system; if (preset) consume(true);",
    "type Preset = typeof system;",
    'let label = system.themeClass; label += " extra";',
    "if (system) consume(true);",
    "const available = !!system;"
  ])("preserves extraction alongside an unrelated use: %s", (usage) => {
    const { code, result } = transformDataPreset(
      `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`
    );

    expect(code).not.toContain('color: "red"');
    expect(result[1]).toContain('color: "red"');
  });

  it("keeps an unproven live receiver guard and its calls in runtime order", () => {
    const source = `import { system } from "test-preset";
      export const guarded = system && system.css({ color: "blue" });
      export const cls = system.css({ color: "red" });`;
    const { code, result } = babelTransform(source, { extractCalls });
    const createModules = () => {
      const calls: string[] = [];
      return {
        calls,
        modules: {
          "test-preset": {
            system: {
              css(rule: { color: string }) {
                calls.push(rule.color);
                return `color-${rule.color}`;
              }
            }
          }
        }
      };
    };
    const originalModules = createModules();
    const original = executeModule(source, originalModules.modules);
    const compiledModules = createModules();
    const sidecar = executeModule(result[1], compiledModules.modules);
    const runtime = executeModule(code, {
      ...compiledModules.modules,
      [result[0]]: sidecar
    });

    expect(runtime).toEqual(original);
    expect(compiledModules.calls).toEqual(originalModules.calls);
    expect(result[1]).not.toContain("system.css(");
    expect(code).toContain("system && system.css(");
  });

  it("rejects unsafe CommonJS namespaces and dynamic member access", () => {
    expect(() =>
      babelTransform(
        `
      const presets = require("test-preset");
      presets.system.css = replacement;
      export const cls = presets.system.css({color: "red"});
    `,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract/);
    expect(() =>
      babelTransform(
        `
      const presets = require("test-preset");
      export const cls = presets.system[method]({color: "red"});
    `,
        { extractCalls }
      )
    ).toThrow(/dynamic.*member/i);
  });

  it.each([
    "preset.dark.css = replacement;",
    'const dark = preset.dark; dark.settings.mode = "blue";',
    "const { dark } = preset; dark.css = replacement;"
  ])("extracts a CommonJS sibling beside unrelated writes: %s", (write) => {
    const { code, result } = transformDataPreset(
      `const preset = require("test-preset");
       ${write}
       export const first = preset.system.css({ color: "red" });
       export const second = preset.system.css({ color: "blue" });`
    );

    expect(code).not.toContain("preset.system.css(");
    expect(code).toMatch(/dark\.(?:css = replacement|settings\.mode = "blue")/);
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
  });

  it.each([
    "preset.system.css = replacement;",
    'preset.system.settings.mode = "blue";',
    "consume(preset.system);",
    "preset.base.css(preset.system); consume(preset.base);"
  ])("still rejects a CommonJS sibling with an unsafe owner: %s", (usage) => {
    expect(() =>
      babelTransform(
        `const preset = require("test-preset");
         preset.dark.css = replacement;
         ${usage}
         export const cls = preset.system.css({ color: "red" });`,
        { extractCalls }
      )
    ).toThrow("Cannot safely extract");
  });

  it.each([
    [
      'const changed = require("test-preset"); changed.system.css = replacement;',
      'const used = require("test-preset");',
      "used.system.css"
    ],
    [
      'const { system: changed } = require("test-preset"); changed.settings.mode = "blue";',
      'const { system: used } = require("test-preset");',
      "used.css"
    ],
    [
      'function configure() { const changed = require("test-preset"); changed.system.css = replacement; } configure();',
      'const used = require("test-preset");',
      "used.system.css"
    ]
  ])(
    "diagnoses shared CommonJS exports mutated through another binding: %s",
    (change, declaration, callee) => {
      expect(() =>
        babelTransform(
          `${change} ${declaration} export const cls = ${callee}({ color: "red" });`,
          { extractCalls }
        )
      ).toThrow(/Cannot safely extract.*[Mm]utated CommonJS namespace/);
    }
  );

  it.each([
    'const changed = require("test-preset"); changed.dark.css = replacement;',
    'const changed = require("other-preset"); changed.system.css = replacement;',
    'const { system: other } = require("test-preset"); const kind = typeof other.css;'
  ])(
    "preserves separate CommonJS bindings with unrelated writes or read-only uses: %s",
    (usage) => {
      const { code, result } = transformDataPreset(
        `${usage} const used = require("test-preset"); export const cls = used.system.css({ color: "red" });`
      );

      expect(result[1]).toContain('color: "red"');
      expect(code).not.toContain('color: "red"');
    }
  );

  it.each([
    "const ignored = (presets.system, 0);",
    '(initialize(), presets.system.css)({ color: "blue" });'
  ])("rejects unsupported CommonJS sequences: %s", (usage) => {
    expect(() =>
      babelTransform(
        `const presets = require("test-preset");
         ${usage}
         export const cls = presets.system.css({ color: "red" });`,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract.*[Ee]scaped/);
  });

  it("does not confuse a separate preset's alias with the method owner", () => {
    const { code, result } = transformDataPreset(
      `import * as presets from "test-preset";
       const { dark } = presets;
       const settings = dark.settings;
       settings.mode = "blue";
       export const cls = presets.system.css({ color: "red" });`
    );

    expect(code).not.toContain('color: "red"');
    expect(result[1]).toContain('color: "red"');
  });

  it.each([
    [
      "a namespace write before a named import call",
      `import * as presets from "test-preset";
       import { system } from "test-preset";
       presets.system.css = replacement;`,
      "system.css"
    ],
    [
      "a named import write before a namespace call",
      `import { system } from "test-preset";
       import * as presets from "test-preset";
       system.css = replacement;`,
      "presets.system.css"
    ],
    [
      "two named imports of the same export",
      `import { system as changed } from "test-preset";
       import { system as used } from "test-preset";
       changed.css = replacement;`,
      "used.css"
    ],
    [
      "two bindings in one import declaration",
      `import { system as changed, system as used } from "test-preset";
       changed.css = replacement;`,
      "used.css"
    ],
    [
      "a default import and a named default alias",
      `import changed, { default as used } from "test-preset";
       changed.css = replacement;`,
      "used.css"
    ],
    [
      "a sibling object mutated through another import's alias",
      `import * as presets from "test-preset";
       import { system } from "test-preset";
       const settings = presets.system.settings;
       settings.mode = "blue";`,
      "system.css"
    ],
    [
      "a function property mutated through another import's alias",
      `import * as presets from "test-preset";
       import { system } from "test-preset";
       const fn = presets.system.css;
       fn.settings.mode = "blue";`,
      "system.css"
    ],
    [
      "two namespace imports of the same module",
      `import * as changed from "test-preset";
       import * as used from "test-preset";
       changed.system.css = replacement;`,
      "used.system.css"
    ]
  ])("keeps %s at runtime", (_, imports, callee) => {
    const { code, result } = babelTransform(
      `${imports} export const cls = ${callee}({ color: "red" });`,
      {
        extractCalls: {
          "test-preset": [...extractCalls["test-preset"], "default.css"]
        }
      }
    );

    expect(result[1]).not.toContain('color: "red"');
    expect(code).toContain('color: "red"');
  });

  it.each([
    `import { dark } from "test-preset"; dark.css = replacement;`,
    `import * as presets from "test-preset"; presets.dark.css = replacement;`,
    `import other from "test-preset"; other.css = replacement;`,
    `import * as presets from "test-preset";
     let label = presets.system.themeClass; label += " extra";`,
    `import { system as other } from "test-preset";
     const kind = typeof other.css;`,
    `import { system as other } from "other-preset"; other.css = replacement;`
  ])("preserves extraction with a separate import's safe use: %s", (usage) => {
    const { code, result } = transformDataPreset(
      `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`
    );

    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
  });

  it.each([
    "system.configure({ mode: 'blue' });",
    "const configure = system.configure; configure({ mode: 'blue' });",
    "Object.assign(system.settings, { mode: 'blue' });",
    "const settings = system.settings; Object.assign(settings, { mode: 'blue' });",
    "const { settings } = system; Object.assign(settings, { mode: 'blue' });",
    "consume(system.settings || fallback);",
    "const settings = [system.settings]; consume(settings);"
  ])("keeps sibling calls and escaped objects at runtime: %s", (usage) => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
      ${usage}
      export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(result[1]).not.toContain('color: "red"');
    expect(code).toContain('color: "red"');
  });

  it.each([
    "const fn = system.css; fn.settings.mode = 'blue';",
    "const { css: fn } = system; const settings = fn.settings; settings.mode = 'blue';",
    "const fn = system.css; configure(fn);"
  ])("keeps mutated or escaped endpoint aliases at runtime: %s", (usage) => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(result[1]).not.toContain('color: "red"');
    expect(code).toContain('color: "red"');
  });

  it.each(["fn", "system.css"])(
    "diagnoses a mutated CommonJS endpoint alias used through %s",
    (callee) => {
      expect(() =>
        babelTransform(
          `const { system } = require("test-preset");
         const fn = system.css;
         fn.settings.mode = "blue";
         export const cls = ${callee}({ color: "red" });`,
          { extractCalls }
        )
      ).toThrow(/Cannot safely extract.*[Mm]utated/);
    }
  );

  it.each([
    'import { system } from "test-preset";',
    'const { system } = require("test-preset");'
  ])(
    "preserves registered endpoint aliases and read-only uses: %s",
    (imports) => {
      const { code, result } = babelTransform(
        `${imports}
       const { css: style } = system;
       const alias = style;
       const kind = typeof alias;
       export const cls = alias({ color: "red" });
       export const other = system.css({ color: "blue" });`,
        { extractCalls }
      );

      for (const color of ["red", "blue"]) {
        expect(result[1]).toContain(`color: "${color}"`);
        expect(code).not.toContain(`color: "${color}"`);
      }
      expect(code).toContain("typeof alias");
    }
  );

  it("still extracts registered sibling authoring calls", () => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
      const createRules = system.rules;
      export const button = createRules({ base: { color: "blue" } });
      export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "blue"');
    expect(code).not.toContain('color: "red"');
  });

  it.each([
    'import { system } from "test-preset";',
    'const { system } = require("test-preset");'
  ])("extracts successive nested preset calls: %s", (imports) => {
    const { code, result } = babelTransform(
      `${imports}
      export const root = system.cx(system.themeClass, system.css({ color: "red" }));
      export const button = system.rules({ base: { color: "blue" } });
      export const label = system.css({ color: "green" });`,
      { extractCalls }
    );

    for (const color of ["red", "blue", "green"]) {
      expect(result[1]).toContain(`color: "${color}"`);
      expect(code).not.toContain(`color: "${color}"`);
    }
    expect(code).not.toMatch(/system\.(?:css|rules|cx)\(/);
  });

  it("allows registered authoring calls to consume copied sibling values", () => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
      export const cls = system.cx(system.themeClass, system.css({ color: "red" }));`,
      { extractCalls }
    );

    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
  });

  it.each([
    "const { ...copy } = system[runtimeKey]; copy.palette.primary = 'blue';",
    "const [palette] = system[runtimeKey]; palette.primary = 'blue';"
  ])(
    "keeps unresolved destructuring aliases at runtime after a write: %s",
    (usage) => {
      const { code, result } = babelTransform(
        `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`,
        { extractCalls }
      );

      expect(result[1]).not.toContain('color: "red"');
      expect(code).toContain('color: "red"');
    }
  );

  it.each([
    "const { ...copy } = system[runtimeKey]; if (copy) consume(true);",
    "const [palette] = system[runtimeKey]; if (palette) consume(true);"
  ])(
    "does not assume unresolved read-only destructuring is safe: %s",
    (usage) => {
      const { code, result } = babelTransform(
        `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`,
        { extractCalls }
      );

      expect(result[1]).not.toContain('color: "red"');
      expect(code).toContain('color: "red"');
    }
  );

  it("keeps an unproven object selection at runtime even without writes", () => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       const { palette } = system[runtimeKey];
       if (palette) consume(true);
       export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(result[1]).not.toContain('color: "red"');
    expect(code).toContain('color: "red"');
  });

  it("diagnoses an unresolved CommonJS array alias that mutates shared data", () => {
    expect(() =>
      babelTransform(
        `const { system } = require("test-preset");
         const [palette] = system[runtimeKey];
         palette.primary = "blue";
         export const cls = system.css({ color: "red" });`,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract.*[Ee]scaped/);
  });

  it.each([
    "system.configure({ mode: 'blue' });",
    "Object.assign(system.settings, { mode: 'blue' });"
  ])("diagnoses an unsafe CommonJS sibling use: %s", (usage) => {
    expect(() =>
      babelTransform(
        `const { system } = require("test-preset");
        ${usage}
        export const cls = system.css({ color: "red" });`,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract.*[Ee]scaped/);
  });

  it.each([
    [
      "named ESM member assignment",
      `import { system } from "test-preset";
       system.css = replacement;
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a sibling write on the preset method's owner",
      `import { system } from "test-preset";
       system.mode = replacement;
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a sibling object's member write through an alias",
      `import { system } from "test-preset";
       const settings = system.settings;
       settings.mode = "blue";
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a sibling object's member write through a dynamic property alias",
      `import { system } from "test-preset";
       const settings = system[runtimeKey];
       settings.mode = "blue";
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a sibling object's member write through destructuring and an alias chain",
      `import { system } from "test-preset";
       const { settings } = system;
       const nested = settings.colors;
       const alias = nested;
       alias.primary = "blue";
       export const cls = system.css({ color: "red" });`
    ],
    [
      "an escaped named ESM object",
      `import { system } from "test-preset";
       replaceStyles(system);
       export const cls = system.css({ color: "red" });`
    ],
    [
      "an escaped named ESM object through a logical expression",
      `import { system } from "test-preset";
       replaceStyles(system || fallback);
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a mutated alias of a named ESM object",
      `import { system } from "test-preset";
       const local = system;
       local.css = replacement;
       export const cls = system.css({ color: "red" });`
    ],
    [
      "a mutated destructured ESM namespace member",
      `import * as presets from "test-preset";
       const { system } = presets;
       system.css = replacement;
       export const cls = presets.system.css({ color: "red" });`
    ],
    [
      "a mutated alias of an ESM namespace member",
      `import * as presets from "test-preset";
       const local = presets.system;
       local.css = replacement;
       export const cls = presets.system.css({ color: "red" });`
    ],
    [
      "an escaped ESM namespace member",
      `import * as presets from "test-preset";
       replaceStyles(presets.system);
       export const cls = presets.system.css({ color: "red" });`
    ],
    [
      "a function destructured from a mutated preset",
      `import { system } from "test-preset";
       system.css = replacement;
       const { css } = system;
       export const cls = css({ color: "red" });`
    ]
  ])("keeps %s at runtime", (_, source) => {
    const { code, result } = babelTransform(source, {
      extractCalls
    });

    expect(result[1]).not.toContain('color: "red"');
    expect(code).toContain('color: "red"');
  });

  it("diagnoses mutation of a destructured CommonJS preset in strict mode", () => {
    expect(() =>
      babelTransform(
        `const { system } = require("test-preset");
         system.css = replacement;
         export const cls = system.css({ color: "red" });`,
        { extractCalls }
      )
    ).toThrow(/Cannot safely extract.*[Mm]utated/);
  });

  it.each([false, true])(
    "tracks preserved parenthesized aliases with mutation=%s",
    (mutated) => {
      const options = { result: ["", ""] as [string, string], extractCalls };
      const output = transformSync(
        `import { system } from "test-preset";
         const local = (system);
         ${mutated ? "(local).css = replacement;" : ""}
         export const cls = (system).css({ color: "red" });`,
        {
          filename: "test.tsx",
          parserOpts: {
            plugins: ["typescript", "jsx"],
            createParenthesizedExpressions: true
          },
          plugins: [[minchoBabelPlugin(), options]]
        }
      );

      if (mutated) {
        expect(options.result[1]).not.toContain('color: "red"');
        expect(output?.code).toContain('color: "red"');
      } else {
        expect(options.result[1]).toContain('color: "red"');
        expect(output?.code).not.toContain('color: "red"');
      }
    }
  );
});

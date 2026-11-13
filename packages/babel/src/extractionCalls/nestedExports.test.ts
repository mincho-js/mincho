import { transformSync } from "@babel/core";
import { transformSync as compileModule } from "esbuild";
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

describe("nested preset extraction exports", () => {
  it.each([
    "if (false) system.configure();",
    "false && system.configure();",
    "const deferred = () => system.configure();",
    "for (let index = 0; index < 0; index++) system.configure();",
    "try { throw new Error(); system.configure(); } catch {}",
    "class Deferred { value = system.configure(); }"
  ])("preserves a registered sibling's execution guard: %s", (guarded) => {
    const source = `import { system } from "test-preset";
      ${guarded}
      export const className = system.css({ color: "red" });`;
    const { code, result } = babelTransform(source, {
      extractCalls: { "test-preset": ["system.configure", "system.css"] },
      optimize: { pureFunctions: false }
    });

    const preset = {
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
    };
    let sidecar: Record<string, unknown> = {};
    const execute = (text: string): Record<string, unknown> => {
      const module = { exports: {} };
      const compiled = compileModule(text, { format: "cjs" }).code;
      const require = (id: string) => {
        if (id === "test-preset") return preset;
        if (id === result[0]) return sidecar;
        throw new Error(`Unexpected module: ${id}`);
      };

      new Function("require", "module", "exports", compiled)(
        require,
        module,
        module.exports
      );
      return module.exports;
    };

    sidecar = execute(result[1]);
    expect(execute(code).className).toBe("red");
    expect(preset.system.color).toBe("red");
    expect(code).toContain("system.configure()");
    expect(code).toContain("system.css(");
    expect(result[1]).not.toContain("system.configure()");
  });

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
    '{ [system.css({ color: "red" })]: system.css({ color: "blue" }) }',
    '[...system.css({ color: "red" }), system.css({ color: "blue" })]'
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
    "identity({ owner: system, ...{ owner() { return other; } } });"
  ])("preserves known receiver spread overrides: %s", (usage) => {
    const transformed = transformReceiverBranch(usage);

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "replaceBox({ owner: other, ...{ owner: system } });",
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
      const { code, result } = babelTransform(
        `const preset = require("test-preset");
       ${copy}
       export const cls = preset.system.css({ color: "red" });`,
        { extractCalls }
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
    "const available = !!system;",
    "export const guarded = system && system.css({ color: 'blue' });"
  ])("preserves extraction alongside an unrelated use: %s", (usage) => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(code).not.toContain('color: "red"');
    expect(result[1]).toContain('color: "red"');
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
    const { code, result } = babelTransform(
      `const preset = require("test-preset");
       ${write}
       export const first = preset.system.css({ color: "red" });
       export const second = preset.system.css({ color: "blue" });`,
      { extractCalls }
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
      const { code, result } = babelTransform(
        `${usage} const used = require("test-preset"); export const cls = used.system.css({ color: "red" });`,
        { extractCalls }
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
    const { code, result } = babelTransform(
      `import * as presets from "test-preset";
       const { dark } = presets;
       const settings = dark.settings;
       settings.mode = "blue";
       export const cls = presets.system.css({ color: "red" });`,
      { extractCalls }
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
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       ${usage}
       export const cls = system.css({ color: "red" });`,
      { extractCalls }
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
       const kind = typeof alias.settings;
       export const cls = alias({ color: "red" });
       export const other = system.css({ color: "blue" });`,
        { extractCalls }
      );

      for (const color of ["red", "blue"]) {
        expect(result[1]).toContain(`color: "${color}"`);
        expect(code).not.toContain(`color: "${color}"`);
      }
      expect(code).toContain("typeof alias.settings");
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

  it("retains extraction for a resolved read-only object alias", () => {
    const { code, result } = babelTransform(
      `import { system } from "test-preset";
       const { palette } = system[runtimeKey];
       if (palette) consume(true);
       export const cls = system.css({ color: "red" });`,
      { extractCalls }
    );

    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
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

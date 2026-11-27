import { transformSync as compileModule } from "esbuild";
import { runInNewContext } from "node:vm";
import { transformSync, type PluginObj, types as t } from "@babel/core";
import { describe, expect, it } from "vitest";
import { minchoBabelPlugin } from "../index.js";
import {
  markBuildEvaluation,
  retainRuntimeInvocation
} from "../extractionCalls/index.js";
import type { PluginOptions } from "../types.js";

function transform(
  source: string,
  owner?: "build" | "runtime",
  ownerName = "css"
) {
  const options: PluginOptions = {
    result: ["", ""],
    extractCalls: { "test-preset": ["css", "configure", "cx"] },
    optimize: { pureFunctions: false }
  };
  const markOwner = (): PluginObj => ({
    visitor: {
      Program(path) {
        path.traverse({
          CallExpression(call) {
            if (!t.isIdentifier(call.node.callee, { name: ownerName })) return;
            if (owner === "build") markBuildEvaluation(call.node);
            if (owner === "runtime") retainRuntimeInvocation(call.node);
          }
        });
      }
    }
  });
  const result = transformSync(source, {
    filename: "owner.ts",
    configFile: false,
    babelrc: false,
    plugins: [markOwner, [minchoBabelPlugin(), options]]
  });
  return {
    code: result!.code!,
    sidecar: options.result[1],
    sidecarId: options.result[0]
  };
}

const unproven = `import { configure, css } from "test-preset";
import { enabled } from "flags";
if (enabled) configure();
export const cls = css({ color: "red" });`;

describe("compiler-owned build invocation boundary", () => {
  it("reports an unproven compiler-owned invocation instead of emitting runtime authoring", () => {
    expect(() => transform(unproven, "build")).toThrow(
      /Cannot safely extract compiler-owned build-time call/
    );
  });
  it("extracts a proven compiler-owned invocation", () => {
    const result = transform(
      'import { css } from "test-preset"; export const cls = css({ color: "red" });',
      "build"
    );
    expect(result.code).not.toContain("css({");
    expect(result.sidecar).toContain("css({");
  });
  it.each([undefined, "runtime"] as const)(
    "preserves unmarked or runtime-owned calls: %s",
    (owner) => {
      expect(transform(unproven, owner).code).toContain("css({");
    }
  );
  it("respects explicit ignore on a compiler-owned invocation", () => {
    expect(
      transform(
        unproven.replace("css({", "/* mincho-js-ignore */ css({"),
        "build"
      ).code
    ).toContain("css({");
  });
  it("allows unmarked leaves to move with their complete build owner", () => {
    const result = transform(
      'import { mincho$ } from "@mincho-js/css"; import { ordinary } from "runtime"; export const cls = mincho$(() => ordinary("value"));',
      "build",
      "mincho$"
    );
    expect(result.code).not.toContain("ordinary(");
    expect(result.sidecar).toContain('ordinary("value")');
  });
  it("does not classify ordinary values or runtime helpers as build-only", () => {
    const result = transform(
      'import { cx } from "test-preset"; export function render(value) { return ordinary(cx(value)); }'
    );
    expect(result.code).toContain("ordinary(cx(value))");
  });
});

describe("publication for a compound authored initializer", () => {
  it.each([
    "split",
    "compound",
    "later consumer",
    "prior alias",
    "same-statement second",
    "copy current output",
    "later consumer of output copy",
    "inert object destructuring",
    "alias of a prior inert object destructuring",
    "earlier closed module constant"
  ] as const)(
    "publishes the %s built-in CSS output before sidecar reads",
    (form) => {
      const declarations = {
        split:
          'const rule = { color: "red" }; const cls = css(rule); export { cls };',
        compound:
          'const rule = { color: "red" }, cls = css(rule); export { cls };',
        "later consumer":
          'const rule = { color: "red" }, cls = css(rule); export { cls }; export const animation = css({ animationName: cls });',
        "prior alias":
          'const rule = { color: "red" }, copy = rule; export const cls = css(rule); export { copy };',
        "same-statement second":
          'const rule = { color: "red" }, cls = css(rule), second = css({ color: "blue" }); export { cls, second };',
        "copy current output":
          'const rule = { color: "red" }, cls = css(rule), copy = cls; export { copy };',
        "later consumer of output copy":
          'const rule = { color: "red" }, cls = css(rule), copy = cls; export const animation = css({ animationName: copy });',
        "inert object destructuring":
          'const rule = { color: "red" }, {x} = {x: 1}; export const cls = css(rule); export {x};',
        "alias of a prior inert object destructuring":
          'const rule = {color:"red"}, {shade} = {shade:"blue"}, copy = shade; export const cls = css(rule); export {copy};',
        "earlier closed module constant":
          'const shade = "blue"; const rule = { color: "red" }, copy = shade; export const cls = css(rule); export { copy };'
      };
      const source = `import { css } from "@mincho-js/css"; ${declarations[form]}`;
      const transformed = transform(source);
      const values: Array<{ color?: string; animationName?: string }> = [];
      const modules: Record<string, unknown> = {
        "@mincho-js/css": {
          css(rule: { color?: string; animationName?: string }) {
            values.push(rule);
            return rule.color
              ? `class-${rule.color}`
              : `animation-${rule.animationName}`;
          }
        }
      };
      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(
          compileModule(code, { format: "cjs", target: "esnext" }).code,
          {
            module,
            exports: module.exports,
            require: (id: string) => modules[id]
          }
        );
        return module.exports;
      };
      const native = execute(source);
      const expectedValues = values.splice(0);
      modules[transformed.sidecarId] = execute(transformed.sidecar);
      expect(execute(transformed.code)).toEqual(native);
      expect(values).toEqual(expectedValues);
      expect(values[0]).toEqual({ color: "red" });
    }
  );
  it.each([
    'const rule={color:"red"}, read=()=>shade;',
    'const read=()=>shade, rule={color:"red"};'
  ])(
    "keeps the deferred sibling on the application side: %s",
    (declaration) => {
      const source = `import { css } from "@mincho-js/css";
      ${declaration} export const cls=css(rule); const shade="blue"; export {read};`;
      const result = transform(source);
      const observedCss: string[] = [];
      const modules: Record<string, unknown> = {
        "@mincho-js/css": {
          css({ color }: { color: string }) {
            observedCss.push(color);
            return `class-${color}`;
          }
        }
      };
      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(
          compileModule(code, { format: "cjs", target: "esnext" }).code,
          {
            module,
            exports: module.exports,
            require: (id: string) => modules[id]
          }
        );
        return module.exports as { cls: string; read(): string };
      };
      const native = execute(source);
      expect(native.read()).toBe("blue");
      expect(result.sidecar).not.toContain("shade");
      expect(result.sidecar).not.toContain("read");
      expect(result.sidecar).toContain('color: "red"');
      modules[result.sidecarId] = execute(result.sidecar);
      const application = execute(result.code);
      expect(application.cls).toBe(native.cls);
      expect(application.read()).toBe(native.read());
      expect(observedCss).toEqual(["red", "red"]);
    }
  );

  it.each(["local", "module", "switch"] as const)(
    "publishes a closed %s rule in an already selected execution branch",
    (placement) => {
      const declaration = 'const rule={color:"red"};';
      const source =
        placement === "switch"
          ? `import {css} from "@mincho-js/css";
            const trace=["before"];
            let cls;
            switch (0) { case 0: ${declaration}
              default: cls=css(rule); trace.push("after:"+cls); }
            export {cls, trace};`
          : `import {css} from "@mincho-js/css";
        const trace=[];
        ${placement === "module" ? declaration : ""}
        class Palette {
          static {
            trace.push("before");
            ${placement === "local" ? declaration : ""}
            this.className=css(rule);
            trace.push("after:"+this.className);
          }
        }
        export const cls=Palette.className;
        export {trace};`;
      const cssCalls: string[] = [];
      const modules: Record<string, unknown> = {
        "@mincho-js/css": {
          css({ color }: { color: string }) {
            cssCalls.push(color);
            return `class-${color}`;
          }
        }
      };
      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(
          compileModule(code, { format: "cjs", target: "esnext" }).code,
          {
            module,
            exports: module.exports,
            require: (id: string) => modules[id]
          }
        );
        return module.exports;
      };
      const expected = {
        cls: "class-red",
        trace: ["before", "after:class-red"]
      };
      expect(execute(source)).toEqual(expected);
      expect(cssCalls.splice(0)).toEqual(["red"]);

      const result = transform(source);
      modules[result.sidecarId] = execute(result.sidecar);
      expect(cssCalls).toEqual(["red"]);
      expect(execute(result.code)).toEqual(expected);
      expect(cssCalls).toEqual(["red"]);
    }
  );

  it.each([
    'const rule={color:"red"}; rule.color="blue"; this.cls=css(rule);',
    "const rule=readRule(); this.cls=css(rule);",
    'this.cls=css(rule); const rule={color:"red"};',
    'const rule={color:"red"}; this.read=()=>css(rule);'
  ])("does not publish an unproved static-block declaration: %s", (body) => {
    expect(() =>
      transform(`import { css } from "@mincho-js/css";
      export class Palette { static { ${body} } }`)
    ).toThrow(/captures runtime binding rule/);
  });

  it.each([
    'switch (n) { case 0: const rule={color:"red"}; default: css(rule); }',
    'switch (0) { case 0: const rule={color:"red"}; break; default: css(rule); }',
    "switch (0) { case 0: const rule=report(); default: css(rule); }"
  ])(
    "does not publish a declaration across unproved switch fallthrough: %s",
    (source) => {
      expect(() =>
        transform(`import {css} from "@mincho-js/css"; ${source}`)
      ).toThrow(/captures runtime binding rule/);
    }
  );

  it("does not treat an unrelated sibling call as the selected output", () => {
    expect(() =>
      transform(`import { css } from "@mincho-js/css";
        const rule = { color: "red" }, cls = css(rule), marker = report();
        export { cls, marker };`)
    ).toThrow(/repeat an unproved sibling initializer/);
  });
  it("does not treat later lexical initialization as an earlier sidecar read", () => {
    expect(() =>
      transform(`import { css } from "@mincho-js/css";
        const copy = rule, rule = { color: "red" };
        export const cls = css(rule);
        export { copy };`)
    ).toThrow(/captures runtime binding rule/);
  });
  it("does not require publication of an explicitly ignored sibling CSS call", () => {
    expect(() =>
      transform(`import { css } from "@mincho-js/css";
        const rule = { color: "red" }, cls = css(rule),
          second = /* mincho-js-ignore */ css({ color: "blue" });
        export { cls, second };`)
    ).toThrow(/repeat an unproved sibling initializer/);
  });
  it("does not admit an effectful destructuring sibling", () => {
    expect(() =>
      transform(`import { css } from "@mincho-js/css";
        const rule = { color: "red" }, {x = report()} = {};
        export const cls = css(rule);
        export { x };`)
    ).toThrow(/captures runtime binding rule/);
  });
  it.each(["forward", "effectful"] as const)(
    "does not treat an %s module value as initialized and closed",
    (form) => {
      const before = form === "effectful" ? "const shade = report();" : "";
      const after = form === "forward" ? 'const shade = "blue";' : "";
      expect(() =>
        transform(`import { css } from "@mincho-js/css"; ${before}
          const rule = { color: "red" }, copy = shade; ${after}
          export const cls = css(rule); export { copy };`)
      ).toThrow(/captures runtime binding rule/);
    }
  );
});

describe("activated deferred class field ownership", () => {
  it.each(["field = ordinary()", "#field = ordinary()"])(
    "keeps instance initialization deferred after whole-callback extraction: %s",
    (field) => {
      const source = `import {mincho$} from '@mincho-js/css'; import {ordinary} from 'runtime'; const C=mincho$(()=>class {${field}}); export const read=()=>new C();`;
      const output = transform(source, "build", "mincho$");
      const events: string[] = [];
      const modules: Record<string, unknown> = {
        "@mincho-js/css": { mincho$: (callback: () => unknown) => callback() },
        runtime: {
          ordinary: () => {
            events.push("field");
            return "blue";
          }
        }
      };
      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(
          compileModule(code, { format: "cjs", target: "esnext" }).code,
          {
            module,
            exports: module.exports,
            require: (name: string) => modules[name]
          }
        );
        return module.exports as { read: () => unknown };
      };
      const original = execute(source);
      expect(events).toEqual([]);
      original.read();
      expect(events).toEqual(["field"]);
      events.length = 0;
      modules[output.sidecarId] = execute(output.sidecar);
      const runtime = execute(output.code);
      expect(events).toEqual([]);
      runtime.read();
      expect(events).toEqual(["field"]);
      // Babel moves the class intact. This is not a claim that a raw class
      // can cross the downstream serializer's artifact boundary.
    }
  );
  it("retains the directly executed callback leaf as a normal build-owned contrast", () => {
    const result = transform(
      "import {mincho$} from '@mincho-js/css'; import {ordinary} from 'runtime'; export const cls=mincho$(()=>ordinary('red'));",
      "build",
      "mincho$"
    );
    expect(result.sidecar).toContain("ordinary('red')");
    expect(result.code).not.toContain("ordinary('red')");
  });
});

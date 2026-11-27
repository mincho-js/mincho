import { prepareModuleSourceFixture } from "../testUtils/moduleSourceFixture.js";
import { prepareSerializedRecipeProvider } from "../testUtils/serializedRecipeProvider.js";
import { build, type Loader, transformSync } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { css, defineRules, mincho$, rules } from "@mincho-js/css";
import { cx } from "@mincho-js/css/classname";
import { createCompiledDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { babelTransform } from "../testUtils/plugin.js";
import { types as t } from "@babel/core";
import { parseModuleProgram } from "../moduleGraph.js";
import type { ProgramScope } from "../types.js";
import type { PreparedExtractCalls } from "../extractionCalls/types.js";
import {
  canCaptureExtractionCallable,
  isExtractionCall,
  isRegisteredExtractionReference,
  markBuildEvaluation,
  retainRuntimeInvocation
} from "../extractionCalls/index.js";
import { hasExtractableBindings } from "../transforms/extractionBindings.js";

const jsxCssProp = { importSource: "custom-preset" };

function executeSidecar(source: string, modules: Record<string, unknown>) {
  return Object.values(executeModule(source, modules));
}

function executeModule(
  source: string,
  modules: Record<string, unknown>,
  automatic = false
) {
  const output = transformSync(source, {
    loader: "tsx",
    format: "cjs",
    ...(automatic
      ? { jsx: "automatic", jsxImportSource: "@mincho-js/react" }
      : { jsxFactory: "jsx" })
  }).code;
  const module = { exports: {} as Record<string, unknown> };
  const requireModule = (name: string) => {
    if (!Object.hasOwn(modules, name))
      throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  };
  new Function("require", "module", "exports", "jsx", output)(
    requireModule,
    module,
    module.exports,
    (type: string, props: unknown) => ({ type, props })
  );
  return module.exports;
}

describe("configured JSX callable values", () => {
  beforeEach(() =>
    setFileScope("jsx-callables.css.ts", "jsx-callable-fixture")
  );
  afterEach(() => endFileScope());

  it.each([
    [
      'css={cx(active && "selected")} className={(active = false, "base")}',
      "base selected",
      []
    ],
    [
      'css={cx(active && "selected")} data-mid={(events.push("middle"), active = false)} className={(events.push("class"), "base")}',
      "base selected",
      ["middle", "class"]
    ],
    [
      'className={(events.push("class"), "base")} data-mid={(events.push("middle"), active = false)} css={cx(active && "selected")}',
      "base",
      ["class", "middle"]
    ],
    [
      '{...{title: "before"}} css={cx(active && "selected")} data-mid={(events.push("middle"), active = false)} className={(events.push("class"), "base")}',
      "base selected",
      ["middle", "class"]
    ]
  ])(
    "preserves runtime class attribute evaluation order: %s",
    (attributes, expected, expectedEvents) => {
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      export const events = [];
      export const Box = () => {
        let active = true;
        return <div ${attributes} />;
      };
    `,
        { jsxCssProp, extractCalls: { "custom-preset": ["css", "cx"] } }
      );
      const modules = {
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css, cx }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(expected);
      expect(runtime.events).toEqual(expectedEvents);
    }
  );

  it.each([
    ["single await", "async function", false, "await"],
    ["compound await", "async function", true, "await"],
    ["compound yield", "function*", true, "yield"]
  ] as const)(
    "stages a runtime CSS class at its direct %s initializer",
    async (_name, declaration, compound, suspend) => {
      const { code } = babelTransform(
        `
      export const events = [];
      function mark(event, value) { events.push(event); return value; }
      function before(readLast) {
        try { readLast(); } catch (error) {
          if (!(error instanceof ReferenceError)) throw error;
          return mark('first', 1);
        }
        throw new Error('lost TDZ');
      }
      export ${declaration} Box(cls) {
        const ${compound ? "first = before(() => last), " : ""}element =
          <div css={cls} className={(cls = 'changed', mark('class', 'base'))}>
            {${suspend} mark('child', 'content')}
          </div>${compound ? ", last = mark('last', 2)" : ""};
        return element;
      }
      `,
        { jsxCssProp }
      );
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      });
      type Element = { props: { className: string } };
      const expectedEvents = [...(compound ? ["first"] : []), "class", "child"];
      let element: Element;
      if (suspend === "yield") {
        const Box = runtime.Box as (
          cls: string
        ) => Generator<string, Element, string>;
        const iterator = Box("selected");
        expect(iterator.next()).toEqual({ done: false, value: "content" });
        expect(runtime.events).toEqual(expectedEvents);
        const result = iterator.next("content");
        expect(result.done).toBe(true);
        element = result.value as Element;
      } else {
        const Box = runtime.Box as (cls: string) => Promise<Element>;
        element = await Box("selected");
      }

      expect(element.props.className).toBe("base selected");
      expect(runtime.events).toEqual(
        compound ? [...expectedEvents, "last"] : expectedEvents
      );
    }
  );

  it("keeps compound exported JSX bindings public and staging bindings private", () => {
    const { code } = babelTransform(
      `import { cx } from "custom-preset";
      import { active, before, after, child } from "./helpers.js";
      export const first = before(), element = <div css={cx(active && "selected")} className={after()}>
        {await child()}
      </div>, last = before();`,
      { jsxCssProp, extractCalls: { "custom-preset": ["css", "cx"] } }
    );
    const loader: Loader = "jsx";
    const emitted = transformSync(code, { loader, format: "esm" }).code;
    const exports = emitted
      .match(/export \{([^}]+)\}/)?.[1]
      .split(",")
      .map((name) => name.trim());
    expect(exports).toEqual(["element", "first", "last"]);
    expect(emitted).toMatch(
      /before\(\)[\s\S]*_minchoCssClassName = [\s\S]*after\(\)[\s\S]*await child\(\)[\s\S]*before\(\)/
    );
  });

  it("keeps nested JSX await on its async arrow, lazy and private per call", async () => {
    const { code, result } = babelTransform(
      `
      export const calls = [];
      const tags = { get Widget() { calls.push('type'); return 'widget'; } };
      function mark(event, value) { calls.push(event); return value; }
      export const Box = async (show, cls, child) => show &&
        <tags.Widget data-before={mark('before:' + cls, true)}
          css={cls} data-middle={mark('middle:' + cls, true)}
          className={(cls = 'changed', mark('class', 'base'))}>
          {await mark('child', child())}
        </tags.Widget>;
      `,
      { jsxCssProp }
    );
    expect(result[1]).toBe("");
    const runtime = executeModule(code, { "@mincho-js/css/classname": { cx } });
    type Result = { type: string; props: { className: string } };
    const Box = runtime.Box as (
      show: boolean,
      cls: string,
      child: () => Promise<string>
    ) => Promise<false | Result>;
    const child = vi.fn();
    expect(await Box(false, "unused", child)).toBe(false);
    expect(child).not.toHaveBeenCalled();
    expect(runtime.calls).toEqual([]);

    let release!: (value: string) => void;
    const firstChild = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = Box(true, "first", () => firstChild);
    const second = Box(true, "second", async () => "content");
    expect(await second).toMatchObject({
      type: "widget",
      props: { className: "base second" }
    });
    release("content");
    expect(await first).toMatchObject({
      type: "widget",
      props: { className: "base first" }
    });
    expect(runtime.calls).toEqual([
      "type",
      "before:first",
      "middle:first",
      "class",
      "child",
      "type",
      "before:second",
      "middle:second",
      "class",
      "child"
    ]);
  });

  it("keeps nested JSX yield on its conditional generator return", () => {
    const { code } = babelTransform(
      `
      export const calls = [];
      function mark(event, value) { calls.push(event); return value; }
      export function* Box(show, cls) {
        return show ? <div css={cls} key={mark('key','stable')}
          className={(cls = 'changed', mark('class','base'))}>
          {yield mark('child', 'pause')}
        </div> : null;
      }
      `,
      { jsxCssProp }
    );
    const runtime = executeModule(code, { "@mincho-js/css/classname": { cx } });
    type Result = { props: { className: string; key: string } };
    const Box = runtime.Box as (
      show: boolean,
      cls: string
    ) => Generator<string, Result | null, string>;
    expect(Box(false, "unused").next()).toEqual({ done: true, value: null });
    expect(runtime.calls).toEqual([]);
    const iterator = Box(true, "selected");
    expect(iterator.next()).toEqual({ done: false, value: "pause" });
    expect(runtime.calls).toEqual(["key", "class", "child"]);
    expect(iterator.next("content")).toMatchObject({
      done: true,
      value: { props: { className: "base selected", key: "stable" } }
    });
  });

  it("keeps top-level nested JSX await at its module branch", () => {
    const { code } = babelTransform(
      `import { cx } from "custom-preset";
      import { active, show, after, child } from "./helpers.js";
      export const element = show && <div css={cx(active && "selected")} className={after()}>
        {await child()}
      </div>;`,
      { jsxCssProp, extractCalls: { "custom-preset": ["css", "cx"] } }
    );
    const loader: Loader = "jsx";
    const emitted = transformSync(code, { loader, format: "esm" }).code;
    expect(emitted).toMatch(/let _minchoCssClassName/);
    expect(emitted).toMatch(
      /show && \(_minchoCssClassName = [\s\S]*after\(\)[\s\S]*await child\(\)/
    );
    expect(emitted.match(/export \{([^}]+)\}/)?.[1].trim()).toBe("element");
  });

  it.each([false, true])(
    "keeps awaited JSX within its module loop header with active=%s",
    (active) => {
      const { code, result } = babelTransform(
        `const report = [];
        const show = ${active};
        const cls = "selected";
        const base = "base";
        async function child() { report.push("child"); return "value"; }
        for (; show && <div css={cls} className={base}>{await child()}</div>;) {
          report.push("body");
          break;
        }
        console.log(JSON.stringify(report));`,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      );
      expect(result[1]).toBe("");
      const loader: Loader = "jsx";
      const emitted = transformSync(code, {
        loader,
        format: "esm",
        jsxFactory: "jsx"
      }).code.replace(
        /import \{ cx as (\w+) \} from ['"]@mincho-js\/css\/classname['"];/,
        "const $1 = (...args) => args.filter(Boolean).join(' ');"
      );
      const runtime = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const jsx = (type, props) => ({type, props});\n" + emitted
        ],
        { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
      );
      expect(runtime.status, runtime.stderr).toBe(0);
      expect(JSON.parse(runtime.stdout)).toEqual(
        active ? ["child", "body"] : []
      );
    }
  );

  it.each([
    ["ternary", false],
    ["ternary", true],
    ["logical", false],
    ["logical", true],
    ["asserted logical", false],
    ["asserted logical", true]
  ] as const)(
    "selects the custom style-only CSS %s branch before intervening JSX attributes: %s",
    (kind, active) => {
      const selection =
        kind === "ternary"
          ? "choose() ? { padding: 12 } : { padding: 4 }"
          : kind === "asserted logical"
            ? "choose() && ({ padding: 12 } as const)"
            : "choose() && { padding: 12 }";
      const authored = `export function Box(active, events) {
           const choose = () => { events.push("choose"); return active; };
           return <div css={${selection}}
             data-mid={(events.push("middle"), active = !active, "middle")}
             className={(events.push("class"), "base")} />;
         }`;
      const native = executeModule(authored, {}).Box as (
        active: boolean,
        events: string[]
      ) => { props: { css: false | { padding: number } } };
      const nativeEvents: string[] = [];
      expect(native(active, nativeEvents).props.css).toEqual(
        active ? { padding: 12 } : kind === "ternary" ? { padding: 4 } : false
      );
      expect(nativeEvents).toEqual(["choose", "middle", "class"]);
      const { code, result } = babelTransform(authored, { jsxCssProp });
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const configuredCss = vi.fn(definition.css);
      const modules = {
        "custom-preset": { css: configuredCss },
        "@mincho-js/css/classname": { cx }
      };
      const sidecar = executeModule(result[1], modules);
      expect(configuredCss.mock.calls).toEqual([
        [{ padding: 12 }],
        ...(kind === "ternary" ? [[{ padding: 4 }]] : [])
      ]);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          active: boolean,
          events: string[]
        ): {
          props: { className: string; "data-mid": string };
        };
      };
      const events: string[] = [];
      const props = Box(active, events).props;
      const selectedClass = active
        ? configuredCss.mock.results[0]!.value
        : kind === "ternary"
          ? configuredCss.mock.results[1]!.value
          : "";
      expect(props.className).toBe(cx("base", selectedClass));
      expect(props["data-mid"]).toBe("middle");
      expect(events).toEqual(["choose", "middle", "class"]);
      expect(configuredCss).toHaveBeenCalledTimes(kind === "ternary" ? 2 : 1);
    }
  );

  it.each([false, true])(
    "retains awaited JSX catch defaults in the visible enclosing scope: supplied=%s",
    (supplied) => {
      const { code, result } = babelTransform(
        `export {};
          const events = [];
          const child = async () => { events.push("child"); return "value"; };
          const cls = "a";
          try {
            throw ${supplied ? '{ view: { props: { className: "provided" } } }' : "{}"};
          } catch ({ view = <div css={cls} className="base">{await child()}</div> }) {
            events.push("catch");
            console.log(JSON.stringify({ events, value: view.props.className }));
          }`,
        { jsxCssProp: true }
      );
      expect(result[1]).toBe("");
      const loader: Loader = "tsx";
      const emitted = transformSync(code, {
        loader,
        format: "esm",
        jsxFactory: "jsx"
      }).code.replace(
        /import \{ cx as (\w+) \} from ['"]@mincho-js\/css\/classname['"];/,
        "const $1 = (...args) => args.filter(Boolean).join(' ');"
      );
      const runtime = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const jsx = (type, props) => ({type, props});\n" + emitted
        ],
        { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
      );
      expect(runtime.status, runtime.stderr).toBe(0);
      const observed = JSON.parse(runtime.stdout);
      expect(observed.events).toEqual(
        supplied ? ["catch"] : ["child", "catch"]
      );
      expect(observed.value.split(/\s+/).sort()).toEqual(
        supplied ? ["provided"] : ["a", "base"]
      );
    }
  );

  it.each([
    ["neither", false, false],
    ["leading", true, false],
    ["trailing", false, true],
    ["both", true, true]
  ] as const)(
    "reads the original CSS class reference and merges it after later props: %s spread",
    (_name, hasLeading, hasTrailing) => {
      const { code, result } = babelTransform(
        `export function Box(cls, events, mutate) {
          const leading = {
            get title() { events.push("leading"); return "label"; },
            get className() { events.push("leading class"); return "pre"; }
          };
          const trailing = {
            get id() { events.push("trailing"); return "after"; },
            get className() { events.push("trailing class"); return "post"; }
          };
          return <div ${hasLeading ? "{...leading}" : ""} css={cls}
            className={(events.push("class"), mutate ? cls.push("late") : cls = ["other"], "base")}
            ${hasTrailing ? "{...trailing}" : ""} />;
        }`,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      );
      expect(result[1]).toBe("");
      const { Box } = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      }) as {
        Box(
          input: string[],
          events: string[],
          mutate: boolean
        ): {
          props: { className: string; title?: string; id?: string };
        };
      };
      for (const mutate of [true, false]) {
        const input = ["selected"];
        const events: string[] = [];
        const props = Box(input, events, mutate).props;
        expect(props.className.split(/\s+/).sort()).toEqual(
          [
            ...(hasLeading ? ["pre"] : []),
            hasTrailing ? "post" : "base",
            "selected",
            ...(mutate ? ["late"] : [])
          ].sort()
        );
        if (hasLeading) expect(props.title).toBe("label");
        if (hasTrailing) expect(props.id).toBe("after");
        expect(input).toEqual(mutate ? ["selected", "late"] : ["selected"]);
        expect(events).toEqual([
          ...(hasLeading ? ["leading", "leading class"] : []),
          "class",
          ...(hasTrailing ? ["trailing", "trailing class"] : [])
        ]);
      }
    }
  );

  it.each(["staged-key", "authored-spread"] as const)(
    "keeps automatic JSX for %s while preserving attribute effects",
    (mode) => {
      const hasSpread = mode === "authored-spread";
      const lead = hasSpread
        ? 'key={mark("key", "one")} data-id={mark("data", "row")} css={input} {...mark("spread", {title: "row"})}'
        : 'data-id={mark("data", "row")} css={input} key={mark("key", "one")}';
      const { code, result } = babelTransform(
        "export function Box(input, trace) { const mark = (label, value) => (trace.push(label), value); return <div " +
          lead +
          ' className={mark("class", "base")} />; }',
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      );
      expect(result[1]).toBe("");
      const trace: string[] = [];
      const runtime = executeModule(
        code,
        {
          "@mincho-js/css/classname": { cx },
          "@mincho-js/react/jsx-runtime": {
            jsx: (type: string, props: unknown, key: string) => ({
              type,
              props,
              key
            })
          }
        },
        true
      ) as {
        Box(
          input: string,
          trace: string[]
        ): {
          key: string;
          props: { className: string; title?: string; "data-id": string };
        };
      };
      expect(runtime.Box("selected", trace)).toEqual({
        type: "div",
        key: "one",
        props: {
          "data-id": "row",
          className: hasSpread ? "selected base" : "base selected",
          ...(hasSpread ? { title: "row" } : {})
        }
      });
      expect(trace).toEqual(
        hasSpread
          ? ["key", "data", "spread", "class"]
          : ["data", "key", "class"]
      );
    }
  );

  it.each([false, true])(
    "lets the esbuild JSX host preserve a quoted staged prop (after CSS=%s)",
    (afterCss) => {
      const quoted = 'label="A\n  B"';
      const mark = 'data-row={(trace.push("prop"),"row")}';
      const cssProp = "css={shared}";
      const className = 'className={(trace.push("class"),"base")}';
      const attributes = afterCss
        ? [cssProp, quoted, mark, className]
        : [className, quoted, mark, cssProp];
      const source =
        "function Widget() {} export function Box(shared, trace) {return <Widget " +
        attributes.join(" ") +
        " />; }";
      const { code } = babelTransform(source, {
        jsxCssProp: true,
        optimize: { pureFunctions: false }
      });
      const run = (input: string, trace: string[]) => {
        const { Box } = executeModule(input, {
          "@mincho-js/css/classname": { cx }
        }) as {
          Box(
            shared: string,
            trace: string[]
          ): {
            props: { label: string; className: string; "data-row": string };
          };
        };
        return Box("selected", trace).props;
      };
      const nativeTrace: string[] = [];
      const emittedTrace: string[] = [];
      const native = run(source, nativeTrace);
      const emitted = run(code, emittedTrace);
      expect(native.label).toBe("A\n  B");
      expect(emitted.label).toBe(native.label);
      expect(emitted["data-row"]).toBe("row");
      expect(emitted.className).toBe("base selected");
      expect(emittedTrace).toEqual(nativeTrace);
    }
  );

  it.each([
    ["closure", false],
    ["closure", true],
    ["local", false],
    ["local", true]
  ] as const)(
    "preserves a %s lexical read before using a class: initialized=%s",
    (placement, initialized) => {
      const declaration = "const selected = getStyles({padding:12});";
      const use =
        placement === "local"
          ? "const view = <div css={selected} />;"
          : "export const element = read();";
      const ordered = initialized ? declaration + use : use + declaration;
      const source =
        'import {getStyles} from "./theme.css.js";' +
        (placement === "local"
          ? "export function Box() {" + ordered + "return view;}"
          : "const read = () => <div css={selected} />;" + ordered);
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const definition = defineRules({ properties: { padding: [12] } });
      const expected = definition.css({ padding: 12 });
      const modules = {
        "custom-preset": { css: definition.css, cx },
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./theme.css.js": { getStyles: (value: unknown) => value }
      };
      const sidecar = executeModule(result[1], modules);
      const run = () => {
        const app = executeModule(code, { ...modules, [result[0]]: sidecar });
        return placement === "local"
          ? (app.Box as () => unknown)()
          : app.element;
      };
      if (initialized)
        expect(run()).toEqual({
          type: "div",
          props: { className: expected }
        });
      else expect(run).toThrow(ReferenceError);
    }
  );

  it.each(["mutate", "reassign"] as const)(
    "keeps an ordinary class reference through a later attribute: %s",
    (action) => {
      const { code } = babelTransform(
        `export function Box(initial) {
          let cls = initial;
          return <div css={cls} className={(
            ${action === "mutate" ? 'cls.push("late")' : 'cls = ["other"]'},
            "base"
          )} />;
        }`,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      );
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      });
      const Box = runtime.Box as (input: string[]) => {
        props: { className: string };
      };
      expect(Box(["selected"]).props.className.split(/\s+/).sort()).toEqual(
        action === "mutate"
          ? ["base", "late", "selected"]
          : ["base", "selected"]
      );
    }
  );

  it.each(["mutate", "reassign"] as const)(
    "stages a raw flat class before trailing spreads, then merges it: %s",
    (mode) => {
      const { code, result } = babelTransform(
        `export function Box(cls, events) {
          const leading = { get className() { events.push("leading"); return "pre"; } };
          const trailing = {
            get title() {
              events.push("title");
              ${mode === "mutate" ? 'cls.push("late");' : 'cls = ["other"];'}
              return "label";
            },
            get className() { events.push("trailing class"); return "post"; }
          };
          return <div {...leading} css={cls} {...trailing} />;
        }`,
        { jsxCssProp: true }
      );
      expect(result[1]).toBe("");
      const { Box } = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      }) as {
        Box(
          cls: string[],
          events: string[]
        ): {
          props: { className: string; title: string };
        };
      };
      const input = ["initial"];
      const events: string[] = [];
      expect(Box(input, events).props).toMatchObject({
        className:
          mode === "mutate" ? "pre initial late post" : "pre initial post",
        title: "label"
      });
      expect(input).toEqual(
        mode === "mutate" ? ["initial", "late"] : ["initial"]
      );
      expect(events).toEqual(["leading", "title", "trailing class"]);
    }
  );

  it.each([
    ["invoked writer", "rule.color = 'blue'", true, true],
    ["uninvoked writer", "rule.color = 'blue'", false, false],
    ["invoked reader", "rule.color", true, false]
  ] as const)(
    "checks effects of captured style arguments in a returned local callback: %s",
    (_name, callback, invoked, rejects) => {
      const compile = () =>
        babelTransform(
          `const style = { color: "red" };
           const make = rule => () => { ${callback}; };
           const apply = make(style);
           const selected = apply;
           ${invoked ? "selected();" : ""}
           export const observed = style.color;
           export const Box = () => <div css={style} />;`,
          { jsxCssProp: true }
        );
      if (rejects) {
        expect(compile).toThrow(/same-file binding "style" is mutated/);
        return;
      }

      const { code, result } = compile();
      const css = vi.fn(({ color }: { color: string }) => `css-${color}`);
      const sidecar = executeModule(result[1], { "@mincho-js/css": { css } });
      expect(css.mock.calls).toEqual([[{ color: "red" }]]);
      const runtime = executeModule(code, { [result[0]]: sidecar }) as {
        observed: string;
        Box(): { props: { className: string } };
      };
      expect(runtime.observed).toBe("red");
      expect(runtime.Box().props.className).toBe("css-red");
    }
  );

  it.each([
    ["direct", "", "cls"],
    ["alias chain", "const first = cls; const alias = first;", "alias"]
  ] as const)(
    "keeps an opaque runtime class with a stable %s binding",
    (_name, aliases, binding) => {
      const { code, result } = babelTransform(
        `export function Box(readClass) {
        const cls = readClass();
        ${aliases}
        return <div css={${binding}} />;
      }`,
        { jsxCssProp: true }
      );
      expect(result[1]).toBe("");
      const { Box } = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      }) as {
        Box(read: () => string): { props: { className: string } };
      };
      const read = vi.fn(() => "runtime-class");
      expect(Box(read).props.className).toBe("runtime-class");
      expect(read).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [
      "invoked setter",
      "style",
      "set active(value) { rule.color = value; }",
      'holder.active = "blue";',
      true
    ],
    [
      "uninvoked setter",
      "style",
      "set active(value) { rule.color = value; }",
      "",
      false
    ],
    [
      "unrelated setter",
      "other",
      "set active(value) { rule.color = value; }",
      'holder.active = "blue";',
      false
    ],
    [
      "invoked method",
      "style",
      "paint(value) { rule.color = value; }",
      'holder.paint("blue");',
      true
    ],
    [
      "uninvoked method",
      "style",
      "paint(value) { rule.color = value; }",
      "",
      false
    ],
    [
      "unrelated method",
      "other",
      "paint(value) { rule.color = value; }",
      'holder.paint("blue");',
      false
    ],
    [
      "later data property replaces method",
      "style",
      "paint(value) { rule.color = value; }, paint: () => undefined",
      'holder.paint("blue");',
      false
    ]
  ] as const)(
    "checks effects on the exact captured style in a returned helper: %s",
    (_name, capture, member, effect, rejects) => {
      const compile = () =>
        babelTransform(
          `const style = { color: "red" }, other = { color: "green" };
           const wrap = rule => ({ ${member} });
           const holder = wrap(${capture});
           ${effect}
           export const observed = style.color;
           export const Box = () => <div css={style} />;`,
          { jsxCssProp: true }
        );
      if (rejects) {
        expect(compile).toThrow(/same-file binding "style" is mutated/);
        return;
      }
      const { code, result } = compile();
      const css = vi.fn(({ color }: { color: string }) => `css-${color}`);
      const sidecar = executeModule(result[1], { "@mincho-js/css": { css } });
      expect(css.mock.calls).toEqual([[{ color: "red" }]]);
      const runtime = executeModule(code, { [result[0]]: sidecar }) as {
        observed: string;
        Box(): { props: { className: string } };
      };
      expect(runtime.observed).toBe("red");
      expect(runtime.Box().props.className).toBe("css-red");
    }
  );

  it.each(
    (
      [
        ["direct", "", true],
        ["taken", "show && ", true],
        ["untaken", "show && ", false]
      ] as const
    ).flatMap(([name, prefix, chosen]) =>
      ([false, true] as const).map((directEval) => ({
        name,
        prefix,
        chosen,
        directEval
      }))
    )
  )(
    "keeps synchronous JSX initializer effects in the authored activation ($name, eval=$directEval)",
    ({ prefix, chosen, directEval }) => {
      const classExpression = directEval
        ? `eval(${JSON.stringify("var observed = 1; events.push('class'); 'base'")})`
        : '(events.push("class"), "base")';
      const { code, result } = babelTransform(
        `module.exports = function Box(cls, events, show) {
          const element = ${prefix}<div css={cls}
            data-mid={(events.push("middle"), "mid")}
            className={${classExpression}} />;
          return { observed: typeof observed, props: element ? element.props : null };
        };`,
        { jsxCssProp: true },
        { sourceType: "script" }
      );
      expect(result[1]).toBe("");
      const Box = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      }) as unknown as (
        cls: string[],
        events: string[],
        show: boolean
      ) => {
        observed: string;
        props: { className: string; "data-mid": string };
      };
      const events: string[] = [];
      expect(Box(["selected"], events, chosen)).toEqual({
        observed: chosen && directEval ? "number" : "undefined",
        props: chosen ? { className: "base selected", "data-mid": "mid" } : null
      });
      expect(events).toEqual(chosen ? ["middle", "class"] : []);
    }
  );

  it("reads a flat CSS class in its original TDZ before any trailing lookup", () => {
    const { code, result } = babelTransform(
      `export function Box(initial, trailing) {
         const render = () => <div css={cls} {...trailing} />;
         const value = render();
         let cls = initial;
         return value;
       }`,
      { jsxCssProp: true }
    );
    expect(result[1]).toBe("");
    const { Box } = executeModule(code, {
      "@mincho-js/css/classname": { cx }
    }) as { Box(initial: string[], trailing: { title: string }): unknown };
    const title = vi.fn(() => "label");
    expect(() =>
      Box(["initial"], {
        get title() {
          return title();
        }
      })
    ).toThrow(ReferenceError);
    expect(title).not.toHaveBeenCalled();
  });

  it.each([
    ["bare sync", false, false],
    ["bare await", false, true],
    ["braced sync", true, false],
    ["braced await", true, true]
  ] as const)(
    "keeps a staged JSX element in an attribute: %s",
    async (_name, braced, suspends) => {
      const element = `<div css={cls} key={mark("key", "stable")}
        className={(cls = "changed", mark("class", "base"))}>
        {${suspends ? "await " : ""}mark("child", "content")}
      </div>`;
      const { code } = babelTransform(
        `export const calls = [];
        const Root = () => null;
        const mark = (event, value) => { calls.push(event); return value; };
        export const Box = ${suspends ? "async " : ""}(cls) =>
          <Root slot=${braced ? "{" + element + "}" : element} />;`,
        { jsxCssProp }
      );
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      });
      type Element = {
        props: { slot: { props: { className: string; key: string } } };
      };
      const Box = runtime.Box as (cls: string) => Element | Promise<Element>;
      expect((await Box("selected")).props.slot.props).toMatchObject({
        className: "base selected",
        key: "stable"
      });
      expect(runtime.calls).toEqual(["key", "class", "child"]);
    }
  );

  it.each([false, true])(
    "preserves an ordinary configured cx package export condition require=%s",
    async (requireKind) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-cx-conditions-"));
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"custom-preset","exports":{"import":"./import.mjs","require":"./require.cjs"}}'
        );
        await writeFile(
          join(root, "import.mjs"),
          'export const cx = (value) => "esm-" + value;'
        );
        await writeFile(
          join(root, "require.cjs"),
          'exports.cx = (value) => "cjs-" + value;'
        );
        const source =
          (requireKind
            ? 'const { cx } = require("custom-preset");'
            : 'import { cx } from "custom-preset";') +
          "export const Box=(cls)=> <span css={cx(cls)} />;";
        const { code, result } = babelTransform(source, {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "cx"] }
        });
        const bundle = (
          contents: string,
          sourcefile: string,
          loader: Loader,
          external: string[]
        ) =>
          build({
            stdin: { contents, resolveDir: root, sourcefile, loader },
            jsxFactory: "jsx",
            bundle: true,
            write: false,
            platform: "node",
            format: "cjs",
            external
          });
        const loaded = await bundle(code, "fixture.jsx", "jsx", [
          "@mincho-js/css/classname",
          "@mincho-js/css",
          ...(result[0] ? [result[0]] : [])
        ]);
        const module = { exports: {} };
        const isolated = await bundle(result[1], "emitted.ts", "ts", [
          "@mincho-js/css"
        ]);
        const sidecar = { exports: {} };
        new Function(
          "require",
          "module",
          "exports",
          isolated.outputFiles[0]!.text
        )(
          (name: string) => {
            expect(name).toBe("@mincho-js/css");
            return { mincho$ };
          },
          sidecar,
          sidecar.exports
        );
        new Function(
          "require",
          "module",
          "exports",
          "jsx",
          loaded.outputFiles[0]!.text
        )(
          (name: string) =>
            name === "@mincho-js/css/classname"
              ? { cx }
              : name === result[0]
                ? sidecar.exports
                : { mincho$ },
          module,
          module.exports,
          (_type: unknown, props: unknown) => props
        );
        const Box = (
          module.exports as { Box: (cls: string) => { className: string } }
        ).Box;
        expect(Box("class").className).toBe(
          (requireKind ? "cjs-" : "esm-") + "class"
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["preset.cx", 'preset["cx"]'])(
    "keeps the receiver of a configured runtime %s call",
    (callee) => {
      const { code, result } = babelTransform(
        `import * as preset from "custom-preset";
        export const Box = (cls) => <div css={${callee}(cls)} />;`,
        { jsxCssProp, extractCalls: { "custom-preset": ["css", "cx"] } }
      );
      const preset = {
        theme: "theme",
        cx(this: { theme: string } | undefined, cls: string) {
          return this ? this.theme + " " + cls : "detached";
        }
      };
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": preset
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (cls: string) => {
        props: { className: string };
      };
      expect(Box("selected").props.className).toBe(preset.cx("selected"));
    }
  );

  it.each(["false", "true", "active"])(
    "preserves selected JSX CSS for the %s short-circuit operand",
    (left) => {
      const { code, result } = babelTransform(
        `import { makeStyle } from "./colors.css.ts";
         export const Box = (active) => <div css={${left} && makeStyle()} />;`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const makeStyle = vi.fn(() => ({ color: "red" }));
      const toClass = vi.fn((rule: { color: string }) => rule.color + "-class");
      const modules = {
        "./colors.css.ts": { makeStyle },
        "custom-preset": { css: toClass },
        "@mincho-js/css": { mincho$: <T>(callback: () => T) => callback() },
        "@mincho-js/css/classname": { cx }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (active: boolean) => {
        props: { className: string };
      };
      expect(Box(false).props.className).toBe(
        left === "true" ? "red-class" : ""
      );
      expect(Box(true).props.className).toBe(
        left === "false" ? "" : "red-class"
      );
      expect(makeStyle).toHaveBeenCalledTimes(left === "false" ? 0 : 1);
      expect(toClass).toHaveBeenCalledTimes(left === "false" ? 0 : 1);
    }
  );

  it.each([
    ["class array", '["external"]', "external"],
    ["empty class array", "[]", ""],
    ["style object", "{ padding: 4 }", "4-class"]
  ] as const)(
    "keeps an ordinary %s fallback in its own CSS mode",
    (kind, fallback, inactive) => {
      const authored = `import {getStyles} from "./theme.css.js";
         export const Box = active => <div css={active ? getStyles() : ${fallback}} className="base" />;`;
      const { code, result } = babelTransform(authored, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const getStyles = vi.fn(() => ({ padding: 12 }));
      const native = executeModule(authored, {
        "./theme.css.js": { getStyles }
      }).Box as (active: boolean) => { props: { css: unknown } };
      const raw = native(false).props.css;
      if (kind === "style object") expect(raw).toEqual({ padding: 4 });
      else expect(cx(raw as string[])).toBe(inactive);
      expect(getStyles).not.toHaveBeenCalled();
      const toClass = vi.fn((rule: { padding: number }) => {
        if (typeof rule.padding !== "number")
          throw new Error("the preset accepts only actual style rules");
        return `${rule.padding}-class`;
      });
      const modules = {
        "./theme.css.js": { getStyles },
        "custom-preset": { css: toClass },
        "@mincho-js/css": { mincho$: <T>(callback: () => T) => callback() },
        "@mincho-js/css/classname": { cx }
      };
      const sidecar = executeModule(result[1], modules);
      const Box = executeModule(code, { ...modules, [result[0]]: sidecar })
        .Box as (active: boolean) => { props: { className: string } };
      expect(Box(true).props.className).toBe("base 12-class");
      expect(Box(false).props.className).toBe(cx("base", inactive));
      expect(getStyles).toHaveBeenCalledOnce();
      expect(toClass.mock.calls).toContainEqual([{ padding: 12 }]);
      expect(toClass).toHaveBeenCalledTimes(kind === "style object" ? 2 : 1);
    }
  );

  it("leaves arguments of a closed nullish optional call unexecuted", () => {
    const { code, result } = babelTransform(
      `import {getStyles} from "./theme.css.js";
        import {readValue} from "./runtime.js";
        export const Box=()=> <div css={getStyles(null?.(readValue()))} />;`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const getStyles = vi.fn((size?: number) => ({ padding: size ?? 4 }));
    const readValue = vi.fn(() => 12);
    const modules = {
      "./theme.css.js": { getStyles },
      "./runtime.js": { readValue },
      "custom-preset": {
        css: (rule: { padding: number }) => `p${rule.padding}`
      },
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx }
    };
    const sidecar = executeModule(result[1], modules);
    const Box = executeModule(code, { ...modules, [result[0]]: sidecar })
      .Box as () => { props: { className: string } };
    expect(Box().props.className).toBe("p4");
    expect(getStyles.mock.calls).toEqual([[undefined]]);
    expect(readValue).not.toHaveBeenCalled();
    expect(result[1]).not.toContain("./runtime.js");
  });

  it.each(["true", "false"] as const)(
    "does not evaluate a dead ordinary stylesheet factory in a direct JSX ternary (%s)",
    (condition) => {
      const options = {
        jsxCssProp,
        optimize: { pureFunctions: false }
      };
      const selected =
        condition === "true"
          ? 'true ? "base" : getStyles(size)'
          : 'false ? getStyles(size) : "base"';
      const { code, result } = babelTransform(
        `import { getStyles } from "./styles.css.ts";
          export const App = (size) => <div css={${selected}} />;`,
        options
      );
      const getStyles = vi.fn((size: number) => ({ padding: size }));
      const modules = {
        "./styles.css.ts": { getStyles },
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const App = runtime.App as (size: number) => {
        props: { className: string };
      };
      expect(App(4).props.className).toBe("base");
      expect(getStyles).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("getStyles");
    }
  );

  it.each(["direct rest", "named rest", "direct ordinary"] as const)(
    "keeps JSX await staging local to the authored parameter list (%s)",
    async (mode) => {
      const run = (take: boolean) => {
        const operand = `${take} && <div css={styleA} className="base" data-child={await load()} />`;
        return mode === "named rest"
          ? `const render = async (...args) => ${operand}; export const output = render("arg");`
          : `export const output = (async (${mode === "direct rest" ? "...args" : ""}) => ${operand})("arg");`;
      };
      for (const take of [false, true]) {
        const load = vi.fn(async () => "child");
        const { code, result } = babelTransform(
          `import { load } from "./fixture"; const styleA = "style-a"; ${run(take)}`,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        const modules = {
          "./fixture": { load },
          "@mincho-js/css/classname": { cx },
          "custom-preset": { css: vi.fn() }
        };
        const sidecar = executeModule(result[1], modules);
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });
        if (!take) {
          expect(await runtime.output).toBe(false);
          expect(load).not.toHaveBeenCalled();
        } else {
          expect(await runtime.output).toMatchObject({
            props: { className: cx("base", "style-a"), "data-child": "child" }
          });
          expect(load).toHaveBeenCalledTimes(1);
        }
      }
    }
  );

  it.each(["computed object", "computed class", "deferred method"])(
    "keeps suspension in its authored JSX scope: %s",
    async (form) => {
      const operand =
        form === "computed class"
          ? "class { [await getKey()]() {} }"
          : form === "computed object"
            ? "{ [await getKey()]() {} }"
            : "{ async ordinary() { return await getKey(); } }";
      const { code } = babelTransform(
        `export const calls = [];
         function className() { calls.push("class"); return "base"; }
         export const Box = async (show, cls, getKey) => show &&
           <div css={cls} className={className()} data-value={${operand}} />;`,
        { jsxCssProp }
      );
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx }
      });
      type Element = { props: { className: string; "data-value": object } };
      const Box = runtime.Box as (
        show: boolean,
        cls: string,
        key: () => Promise<string>
      ) => Promise<false | Element>;
      const getKey = vi.fn(async () => {
        (runtime.calls as string[]).push("key");
        return "selected-key";
      });
      expect(await Box(false, "selected", getKey)).toBe(false);
      expect(runtime.calls).toEqual([]);
      const element = (await Box(true, "selected", getKey)) as Element;
      expect(element.props.className).toBe("base selected");
      const data = element.props["data-value"];
      if (form === "deferred method") {
        expect(runtime.calls).toEqual(["class"]);
        expect(getKey).not.toHaveBeenCalled();
        await (data as { ordinary: () => Promise<string> }).ordinary();
      } else {
        const target =
          typeof data === "function"
            ? (data as { prototype: object }).prototype
            : data;
        expect(Object.getOwnPropertyNames(target)).toContain("selected-key");
      }
      expect(runtime.calls).toEqual(["class", "key"]);
      expect(getKey).toHaveBeenCalledOnce();
    }
  );

  it("does not reuse a factory input receipt for a different mutating root", () => {
    expect(() =>
      babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      const input = { padding: 4 };
      const first = <div css={getStyles(input)} />;
      function mutate(value) { value.padding = 12; return value; }
      const second = mutate(input);
      export const element = <div css={second} />;
    `,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      )
    ).toThrow();
  });

  it.each([
    "Math.max({ valueOf() { input.padding = 12; return 1; } })",
    "Math.max(...{ *[Symbol.iterator]() { input.padding = 12; yield 1; } })"
  ])(
    "preserves coercion and spread effects despite primitive Math results: %s",
    (expression) => {
      const { code, result } = babelTransform(
        `
      const input = { padding: 4 };
      const size = ${expression};
      export const element = <div css={{ padding: input.padding + size }} />;
    `,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      );
      expect(result[1]).not.toContain("Math.max");
      expect(code).toContain("input.padding = 12");
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": {
          css: () => "class",
          createVar: () => "--padding",
          getVarName: (value: string) => value
        }
      });
      const runtime = executeModule(code, {
        [result[0]]: sidecar,
        "@mincho-js/transform-runtime": { vx: (value: number) => `${value}px` }
      });
      expect(
        (runtime.element as { props: { style: Record<string, string> } }).props
          .style["--padding"]
      ).toBe("13px");
    }
  );

  it("retains bound Math argument coercions outside native binding identity evidence", () => {
    const { code, result } = babelTransform(
      `
      const input = { padding: 4 };
      const max = Math.max.bind(Math, { valueOf() { input.padding = 12; return 1; } });
      const size = max();
      export const element = <div css={{ padding: input.padding + size }} />;
    `,
      { jsxCssProp: true, optimize: { pureFunctions: false } }
    );
    expect(result[1]).not.toContain("Math.max");
    expect(code).toContain("input.padding = 12");
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": {
        css: () => "class",
        createVar: () => "--padding",
        getVarName: (value: string) => value
      }
    });
    const runtime = executeModule(code, {
      [result[0]]: sidecar,
      "@mincho-js/transform-runtime": { vx: (value: number) => `${value}px` }
    });
    expect(
      (runtime.element as { props: { style: Record<string, string> } }).props
        .style["--padding"]
    ).toBe("13px");
  });

  it("does not replay an unknown closure result ahead of a captured mutation", () => {
    expect(() =>
      babelTransform(
        `
      function wrap(x) { return () => x; }
      const shared = { color: "red" };
      const get = wrap(shared);
      const style = get();
      shared.color = "blue";
      export const element = <div css={style} />;
    `,
        { jsxCssProp: true, optimize: { pureFunctions: false } }
      )
    ).toThrow(/Cannot statically evaluate css prop value/);
  });

  it("extracts JSX styles declared below their component", () => {
    const { code, result } = babelTransform(
      `export const Box = () => <div css={styles} />;
       const styles = { padding: 4 };`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "custom-preset": { css: (rule: { padding: number }) => `${rule.padding}` }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toBe("4");
    expect(code).not.toContain("css={");
  });

  it.each([
    ["direct callback", "styles()", "build", true],
    ["cloned owner", "styles()", "clone", true],
    [
      "descriptor observation",
      'Object.getOwnPropertyDescriptor(styles, "__recipe__")',
      "build",
      true
    ],
    ["unmarked callback", "styles()", "none", false],
    ["returned closure", "() => styles()", "build", false],
    ["deferred local", "(() => styles())", "build", false],
    ["ignored owner", "styles()", "ignore", false],
    ["ignored nested call", "/* mincho-js-ignore */ styles()", "build", false],
    ["runtime owner", "styles()", "runtime", false],
    ["runtime capture", "flag ? styles() : null", "build", false],
    ["reassigned alias", "alias()", "build", false],
    ["mutated namespace", "helper.styles()", "build", false]
  ] as const)(
    "checks the complete build owner for %s",
    (_, body, ownership, eligible) => {
      const setup =
        body === "alias()"
          ? "let alias = styles; alias = () => null;"
          : body === "helper.styles()"
            ? "helper.styles = () => null;"
            : "";
      const source = `import {mincho$} from "@mincho-js/css";
        import {merge} from "custom-api";
        import {styles} from "unknown-helper";
        import * as helper from "unknown-helper";
        ${setup}
        export const create = flag => mincho$(() => ${body});
        export const run = value => merge(value);`;
      const program = parseModuleProgram("/project/build-owner.ts", source);
      const scope = program.scope as ProgramScope;
      scope.minchoData = {
        imports: new Map(),
        bindings: [],
        nodes: [],
        cssFile: "",
        extractCalls: {
          imports: { "custom-api": ["merge"] },
          localBindings: [],
          protectedFunctions: [],
          dependencies: [],
          fingerprint: "build-owner",
          resolvedSources: {
            import: { "custom-api": "/api.ts", "unknown-helper": "/helper.ts" },
            require: {}
          },
          exportOrigins: {
            "/api.ts": {
              exports: {},
              esModule: true,
              unknownExports: ['["merge"]']
            },
            "/helper.ts": {
              exports: {},
              esModule: true,
              unknownExports: ["[]"]
            }
          }
        }
      };
      program.traverse({
        CallExpression(call) {
          if (!call.get("callee").isIdentifier({ name: "mincho$" })) return;
          if (ownership !== "none") markBuildEvaluation(call.node);
          if (ownership === "clone")
            call.replaceWith(t.cloneNode(call.node, true));
          if (ownership === "ignore")
            t.addComment(call.node, "leading", "mincho-js-ignore");
          if (ownership === "runtime") retainRuntimeInvocation(call.node);
          const before = JSON.stringify(scope.uids);
          expect(hasExtractableBindings(call)).toBe(
            body !== "flag ? styles() : null"
          );
          expect(JSON.stringify(scope.uids)).toBe(before);
          expect(scope.minchoData.bindings).toEqual([]);
          expect(scope.minchoData.nodes).toEqual([]);
          call.skip();
        }
      });
      let inspected = false;
      program.traverse({
        CallExpression(call) {
          const callee = call.get("callee");
          if (!callee.isIdentifier({ name: "merge" })) return;
          retainRuntimeInvocation(call.node);
          expect(canCaptureExtractionCallable(callee)).toBe(eligible);
          expect(isExtractionCall(callee)).toBe(false);
          inspected = true;
        }
      });
      expect(inspected).toBe(true);
    }
  );

  it.each([1, 2])(
    "retains the build owner beside %s runtime callable captures",
    (uses) => {
      // These unknown identities match a host-transformed stylesheet whose
      // export provenance is unavailable. They are not readonly certificates.
      const preparedExtractCalls: PreparedExtractCalls = {
        imports: { "custom-preset": ["css", "cx", "rules"] },
        requires: { "custom-preset": ["css", "cx", "rules"] },
        localBindings: [],
        protectedFunctions: [],
        dependencies: [],
        fingerprint: "static-factory-build-owner",
        resolvedSources: {
          import: {
            "custom-preset": "/fixture/preset.ts",
            "./theme.css": "/fixture/theme.css.ts"
          },
          require: {}
        },
        exportOrigins: {
          "/fixture/preset.ts": {
            exports: {},
            esModule: true,
            unknownExports: ['["css"]', '["cx"]', '["rules"]']
          },
          "/fixture/theme.css.ts": {
            exports: {},
            esModule: false,
            unknownExports: ["[]"]
          }
        }
      };
      const options = {
        jsxCssProp,
        preparedExtractCalls,
        optimize: { pureFunctions: false }
      };
      const { code, result } = babelTransform(
        `import {cx} from "custom-preset";
       import {getStyles} from "./theme.css";
       export const Static = () => <div css={getStyles()} />;
       export const Dynamic = ({active}) => <div css={cx(active && "active")} />;
       ${uses === 2 ? 'export const Other = ({active}) => <div css={cx(active && "other")} />;' : ""}`,
        options
      );
      const getStyles = vi.fn(() => ({ padding: 12 }));
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css, cx },
        "./theme.css": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Static = runtime.Static as () => { props: { className: string } };
      const Dynamic = runtime.Dynamic as (props: { active: boolean }) => {
        props: { className: string };
      };
      expect(Static().props.className).toEqual(expect.any(String));
      expect(Dynamic({ active: true }).props.className).toBe("active");
      expect(Dynamic({ active: false }).props.className).toBe("");
      if (uses === 2) {
        const Other = runtime.Other as typeof Dynamic;
        expect(Other({ active: true }).props.className).toBe("other");
        expect(Other({ active: false }).props.className).toBe("");
      }
      expect(getStyles).toHaveBeenCalledOnce();
      expect(result[1]).not.toContain("active");
      expect(Object.values(sidecar)).toContain(cx);
      expect(code).not.toContain("custom-preset");
      expect(code).not.toContain("getStyles()");
    }
  );

  it.each(["capture-first", "invocation-first"])(
    "keeps generic runtime invocation ownership after %s proofs and cloning",
    (order) => {
      const program = parseModuleProgram(
        "/project/runtime-call.ts",
        'import { merge } from "custom-api"; export const run = value => merge(value);'
      );
      (program.scope as ProgramScope).minchoData = {
        imports: new Map(),
        bindings: [],
        nodes: [],
        cssFile: "",
        extractCalls: {
          imports: { "custom-api": ["merge"] },
          localBindings: [],
          fingerprint: "runtime-call",
          protectedFunctions: [],
          dependencies: []
        }
      };
      let inspected = false;
      program.traverse({
        CallExpression(call) {
          if (!call.get("callee").isIdentifier({ name: "merge" })) return;
          retainRuntimeInvocation(call.node);
          const inspect = () => {
            const callee = call.get("callee");
            expect(isRegisteredExtractionReference(callee)).toBe(true);
            if (order === "invocation-first")
              expect(isExtractionCall(callee)).toBe(false);
            expect(canCaptureExtractionCallable(callee)).toBe(true);
            expect(isExtractionCall(callee)).toBe(false);
          };
          inspect();
          call.replaceWith(t.cloneNode(call.node, true));
          inspect();
          inspected = true;
          call.skip();
        }
      });
      expect(inspected).toBe(true);
    }
  );

  it.each([
    ["function property", 'merge.marker = "blue";'],
    ["escaped alias", "const alias = merge; mutate(alias);"]
  ])(
    "does not capture a constant local callable with a %s effect",
    (_, effect) => {
      const program = parseModuleProgram(
        "/project/local-runtime-call.ts",
        `const merge = value => value; ${effect}
       export const run = value => merge(value);`
      );
      (program.scope as ProgramScope).minchoData = {
        imports: new Map(),
        bindings: [],
        nodes: [],
        cssFile: "",
        extractCalls: {
          imports: {},
          localBindings: ["merge"],
          fingerprint: "local-runtime-call",
          protectedFunctions: [],
          dependencies: []
        }
      };
      let inspected = false;
      program.traverse({
        CallExpression(call) {
          const callee = call.get("callee");
          if (!callee.isIdentifier({ name: "merge" })) return;
          expect(callee.scope.getBinding("merge")?.constant).toBe(true);
          expect(isRegisteredExtractionReference(callee)).toBe(true);
          expect(canCaptureExtractionCallable(callee)).toBe(false);
          inspected = true;
        }
      });
      expect(inspected).toBe(true);
    }
  );

  it.each(["static-first", "runtime-first"])(
    "checks mixed generic callable uses independently in %s order",
    (order) => {
      for (const { setup, expression, registered, staticEligible } of [
        {
          setup: 'import { merge } from "custom-api";',
          expression: "merge",
          registered: "merge",
          staticEligible: true
        },
        {
          setup: 'import { merge } from "custom-api"; merge.marker = "blue";',
          expression: "merge",
          registered: "merge",
          staticEligible: false
        },
        {
          setup:
            'import { merge } from "custom-api"; const alias = merge; mutate(alias);',
          expression: "merge",
          registered: "merge",
          staticEligible: false
        },
        {
          setup: 'import { system } from "custom-api";',
          expression: "system.merge",
          registered: "system.merge",
          staticEligible: false
        }
      ]) {
        const statements = [
          `export const staticValue = ${expression}("static");`,
          `export const run = value => ${expression}(value);`
        ];
        if (order === "runtime-first") statements.reverse();
        const program = parseModuleProgram(
          "/project/mixed-runtime-call.ts",
          `${setup}\n${statements.join("\n")}`
        );
        (program.scope as ProgramScope).minchoData = {
          imports: new Map(),
          bindings: [],
          nodes: [],
          cssFile: "",
          extractCalls: {
            imports: { "custom-api": [registered] },
            localBindings: [],
            fingerprint: "mixed-runtime-call",
            protectedFunctions: [],
            dependencies: []
          }
        };
        program.traverse({
          CallExpression(call) {
            if (
              call.get("callee").toString() === expression &&
              call.get("arguments")[0]?.isIdentifier({ name: "value" })
            )
              retainRuntimeInvocation(call.node);
          }
        });
        let inspected = 0;
        program.traverse({
          CallExpression(call) {
            const callee = call.get("callee");
            if (callee.toString() !== expression) return;
            const isStatic = call
              .get("arguments")[0]
              ?.isStringLiteral({ value: "static" });
            expect(isExtractionCall(callee, false), setup).toBe(
              isStatic ? staticEligible : false
            );
            inspected++;
          }
        });
        expect(inspected).toBe(2);
      }
    }
  );

  it("does not turn a captured callable into a readonly namespace consumer", () => {
    const program = parseModuleProgram(
      "/project/runtime-consumer.ts",
      `import { merge, system } from "custom-api";
       merge(system); system.css({color: "red"});`
    );
    (program.scope as ProgramScope).minchoData = {
      imports: new Map(),
      bindings: [],
      nodes: [],
      cssFile: "",
      extractCalls: {
        imports: { "custom-api": ["merge", "system.css"] },
        localBindings: [],
        fingerprint: "runtime-consumer",
        protectedFunctions: [],
        dependencies: []
      }
    };
    const proofs: boolean[] = [];
    program.traverse({
      CallExpression(call) {
        const callee = call.get("callee");
        if (callee.isIdentifier({ name: "merge" })) {
          retainRuntimeInvocation(call.node);
          proofs.push(canCaptureExtractionCallable(callee));
        } else if (callee.matchesPattern("system.css")) {
          proofs.push(isExtractionCall(callee, false));
        }
      }
    });
    expect(proofs).toEqual([true, false]);
  });

  it.each([
    ["null?.[{ toString: null, valueOf: null }]", undefined],
    ['null?.["value"]', undefined],
    ['({ value: 4 })?.["value"]', 4]
  ])(
    "does not convert an unselected configured factory argument key: %s",
    (argument, expected) => {
      const authored = `
      import {getStyles} from "./theme.css.js";
      export const Box = () => <div css={getStyles(${argument})} />;
    `;
      const getStyles = vi.fn((value: number | undefined) => ({
        padding: value ?? 12
      }));
      const cssFor = vi.fn(
        (rule: { padding: number }) => `padding-${rule.padding}`
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: cssFor },
        "./theme.css.js": { getStyles }
      };
      const native = executeModule(authored, modules).Box as () => {
        props: { css: { padding: number } };
      };
      expect(native().props.css.padding).toBe(expected ?? 12);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(expected);
      getStyles.mockClear();

      const { code, result } = babelTransform(authored, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const sidecar = executeModule(result[1], modules);
      const rendered = executeModule(code, { ...modules, [result[0]]: sidecar })
        .Box as () => { props: { className: string; css?: unknown } };
      const props = rendered().props;
      expect(cssFor.mock.results[0]?.value).toEqual(expect.any(String));
      expect(props).toEqual({ className: cssFor.mock.results[0]?.value });
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(expected);
      expect(cssFor).toHaveBeenCalledExactlyOnceWith({
        padding: expected ?? 12
      });
    }
  );

  it("evaluates ordinary static CSS-file factories through the selected definition", () => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const configuredCss = vi.fn(css);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = () => <div css={getStyles()} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const values = executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css: configuredCss },
      "./theme.css.js": { getStyles }
    });

    expect(getStyles).toHaveBeenCalledOnce();
    expect(configuredCss).toHaveBeenCalledExactlyOnceWith(style);
    expect(values).toEqual([expect.any(String)]);
    expect(code).not.toContain("getStyles()");
    expect(code).not.toContain("custom-preset");
  });

  it.each([
    [
      "direct property",
      "const input = { padding: 4 }; input.padding = 12;",
      "input"
    ],
    [
      "object alias",
      "const input = { padding: 4 }; const alias = input; alias.padding = 12;",
      "input"
    ],
    [
      "nested alias",
      "const input = { style: { padding: 4 } }; const alias = input.style; alias.padding = 12;",
      "input.style"
    ],
    ["array element", "const input = [4]; input[0] = 12;", "input"],
    [
      "assign",
      "const input = { padding: 4 }; Object.assign(input, { padding: 12 });",
      "input"
    ],
    [
      "opaque consumer",
      "const input = { padding: 4 }; const mutate = value => { value.padding = 12; }; mutate(input);",
      "input"
    ],
    [
      "executed pattern default",
      "const input = { padding: 4 }; input.padding = 12; const { padding = input.padding } = {};",
      "padding"
    ],
    [
      "nested pattern default",
      "const input = { padding: 4 }; input.padding = 12; const { style: { padding = input.padding } = {} } = {};",
      "padding"
    ],
    [
      "array pattern default",
      "const input = { padding: 4 }; input.padding = 12; const [padding = input.padding] = [];",
      "padding"
    ],
    [
      "computed pattern key",
      'const input = { key: "small" }; input.key = "large"; const { [input.key]: padding } = { small: 4, large: 12 };',
      "padding"
    ],
    [
      "class property",
      "class Input { static padding = 4; } Input.padding = 12;",
      "Input.padding"
    ]
  ])(
    "rejects mutated ordinary factory arguments: %s",
    (_name, declaration, argument) => {
      const getStyles = vi.fn(() => ({ padding: 4 }));
      const { result } = babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      export const Box = () => {
        ${declaration}
        return <div css={getStyles(${argument})} />;
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );

      expect(() =>
        executeSidecar(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { getStyles }
        })
      ).toThrow(
        "runtime calls only to compiled Mincho or Vanilla Extract recipes"
      );
      expect(getStyles).not.toHaveBeenCalled();
    }
  );

  it("ignores mutations used only by unreachable pattern defaults", () => {
    const getStyles = vi.fn((padding: number) => ({ padding }));
    const { result } = babelTransform(
      `import { getStyles } from "./theme.css.js";
       export const Box = () => {
         const input = { padding: 4 }; input.padding = 12;
         const { padding = input.padding } = { padding: 4 };
         return <div css={getStyles(padding)} />;
       };`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );

    executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    });

    expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("preserves mutated compiled recipe arguments at runtime", () => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const { code, result } = babelTransform(
      `
      import { recipe } from "./theme.css.js";
      export const Box = () => {
        const input = { size: 4 };
        const alias = input;
        alias.size = 12;
        return <div css={recipe(input)} />;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { recipe }
    });
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toBe(recipe({ size: 12 }));
  });

  it.each([
    ["named import", 'import { input } from "./input.js";', "input", "input"],
    [
      "local alias",
      'import { input } from "./input.js"; const alias = input;',
      "alias",
      "alias"
    ],
    [
      "namespace member",
      'import * as values from "./input.js";',
      "values.input",
      "values.input"
    ],
    [
      "nested imported value",
      'import { input } from "./input.js";',
      "input",
      "{ size: input.size }"
    ]
  ])(
    "preserves imported factory argument identity: %s",
    (_name, declaration, receiver, argument) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      for (const mutated of [true, false]) {
        const { code, result } = babelTransform(
          `
        import { recipe } from "./theme.css.js";
        ${declaration}
        ${mutated ? `${receiver}.size = 12;` : ""}
        export const Box = () => <div css={recipe(${argument})} />;
        `,
          {
            jsxCssProp,
            optimize: { pureFunctions: false },
            preparedExtractCalls: {
              imports: { "custom-preset": ["css"] },
              localBindings: [],
              protectedFunctions: [],
              dependencies: [],
              fingerprint: "input-data",
              resolvedSources: {
                import: { "./input.js": "/input.js" },
                require: {}
              },
              exportOrigins: {
                "/input.js": {
                  esModule: true,
                  exports: { '["input"]': "input-object" },
                  ownDataPaths: ['["input","size"]'],
                  closedDataPaths: ['["input"]']
                }
              }
            }
          }
        );
        const createInput = () => ({ input: { size: 4 } });
        const sidecar = executeModule(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { recipe },
          "./input.js": createInput()
        });
        const runtime = executeModule(code, {
          "@mincho-js/css/classname": { cx },
          [result[0]]: sidecar,
          "./input.js": createInput()
        });
        const Box = runtime.Box as () => { props: { className: string } };

        expect(Box().props.className).toBe(recipe({ size: mutated ? 12 : 4 }));
        expect(result[1].includes('from "./input.js"')).toBe(!mutated);
      }
    }
  );

  it.each([
    [
      "local mutating helper",
      "const update = value => { value.size = 12; return value; };",
      "update(input)"
    ],
    [
      "inline mutating helper",
      "",
      "(value => { value.size = 12; return value; })(input)"
    ],
    [
      "opaque imported helper",
      'import { update } from "./runtime.js";',
      "update(input)"
    ]
  ])(
    "preserves mutation inside factory arguments: %s",
    (_, declaration, value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const input = { size: 4 };
      const update = vi.fn((value: typeof input) => {
        value.size = 12;
        return value;
      });
      const { code, result } = babelTransform(
        `
        import { recipe } from "./theme.css.js";
        import { input } from "./input.js";
        ${declaration}
        export const Box = () => <div css={recipe(${value})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./input.js": { input },
        "./runtime.js": { update }
      };
      const sidecar = executeModule(result[1], modules);

      expect(input.size).toBe(4);
      expect(update).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("./input.js");

      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(input.size).toBe(12);
    }
  );

  it.each([
    [
      "Object.assign",
      "const input = { padding: 4 };",
      "Object.assign(input, { padding: input.padding + 1 })"
    ],
    [
      "array receiver mutation",
      "const rows = [{ padding: 4 }, { padding: 12 }];",
      "rows.reverse()[0]"
    ]
  ])(
    "rejects mutating calls within factory inputs: %s",
    (_, declaration, value) => {
      const getStyles = vi.fn((input: { padding: number }) => css(input));
      const { result } = babelTransform(
        `
        import { getStyles } from "./theme.css.js";
        ${declaration}
        export const Box = () => <div css={getStyles(${value})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );

      expect(() =>
        executeSidecar(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { getStyles }
        })
      ).toThrow(/accepts runtime calls only to compiled/);
      expect(getStyles).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["shared runtime observation", "input.padding", true, true],
    [
      "shared opaque reader has no proof of purity",
      "input.padding",
      false,
      true
    ],
    ["isolated value", "-1", true, false],
    ["observable primitive", "input", false, false]
  ] as const)(
    "moves configured style arguments only when application reads stay independent: %s",
    (description, observation, mutate, rejected) => {
      const primitive = description === "observable primitive";
      const getStyles = vi.fn((input: number | { padding: number }) => {
        if (typeof input === "number") return { padding: input };
        if (mutate) input.padding = 12;
        return { padding: input.padding };
      });
      const authored = `
        import { getStyles } from "./theme.css.js";
        export const Box = () => {
          const input = ${primitive ? "4" : "{ padding: 4 }"};
          const element = <div css={getStyles(input)} />;
          return { element, observed: ${observation} };
        };
      `;
      const providers = { "./theme.css.js": { getStyles } };
      const native = executeModule(authored, providers);
      const nativeBox = native.Box as () => {
        element: { props: { css: { padding: number } } };
        observed: number;
      };
      const expected = nativeBox();
      expect(expected.observed).toBe(
        observation === "-1" ? -1 : mutate ? 12 : 4
      );
      const padding = mutate ? 12 : 4;
      expect(expected.element.props.css.padding).toBe(padding);
      getStyles.mockClear();

      const { code, result } = babelTransform(authored, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const modules = {
        ...providers,
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css }
      };
      if (rejected) {
        expect(() => executeModule(result[1], modules)).toThrow(
          /runtime calls only to compiled Mincho or Vanilla Extract recipes/
        );
        expect(getStyles).not.toHaveBeenCalled();
      } else {
        const sidecar = executeModule(result[1], modules);
        const app = executeModule(code, { ...modules, [result[0]]: sidecar });
        const Box = app.Box as () => {
          element: { props: { className: string } };
          observed: number;
        };
        const actual = Box();
        expect(actual.observed).toBe(expected.observed);
        expect(actual.element.props.className).toBe(Object.values(sidecar)[0]);
        expect(getStyles).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each([
    "const input = { padding: 4 };",
    "const input = { padding: 4 }; const copy = { ...input }; copy.padding = 12;",
    "const input = { padding: 4 }; const keys = Object.keys(input);"
  ])("keeps readonly factory arguments static: %s", (declaration) => {
    const getStyles = vi.fn((input: { padding: number }) => input);
    const { result } = babelTransform(
      `
      import { getStyles } from "./theme.css.js";
      export const Box = () => {
        ${declaration}
        return <div css={getStyles(input)} />;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const values = executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    });

    expect(values).toEqual([expect.any(String)]);
    expect(getStyles).toHaveBeenCalledExactlyOnceWith({ padding: 4 });
  });

  describe("runtime factory argument boundaries", () => {
    it.each([
      ["conditional", "", "false ? input : { padding: 4 }"],
      ["logical", "", "(false && input) || { padding: 4 }"],
      ["short-circuited or", "", "({ padding: 4 }) || input"],
      ["short-circuited nullish", "", "({ padding: 4 }) ?? input"],
      [
        "initializer",
        "const selected = false ? input : { padding: 4 };",
        "selected"
      ],
      [
        "nested value",
        "",
        "({ selected: false ? input : { padding: 4 } }).selected"
      ]
    ])("ignores unexecuted mutable inputs: %s", (_, declaration, argument) => {
      const getStyles = vi.fn((input: { padding: number }) => input);
      const { code, result } = babelTransform(
        `
          import {getStyles} from "./theme.css.js";
          const input = { padding: 4 };
          input.padding = 12;
          ${declaration}
          export const Box = () => <div css={getStyles(${argument})} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { getStyles }
      });
      expect(values).toEqual([expect.any(String)]);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith({ padding: 4 });
      expect(code).not.toContain("getStyles(");
    });

    it.each([false, true])(
      "keeps a skipped initializer and selected recipe effects in their execution frame (prefix %s)",
      (prefix) => {
        const recipe = rules({
          variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
        });
        const { code, result } = babelTransform(
          `
        import {recipe} from "./theme.css.js";
        import {tick, readSize} from "./values.js";
        if (false) { var enabled = true; }
        export const Box = () => <div css={recipe({size: ${prefix ? "(tick(), enabled)" : "enabled"} ? 0 : readSize()})} />;
      `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        const events: string[] = [];
        const modules = {
          "@mincho-js/css": { mincho$ },
          "@mincho-js/css/classname": { cx },
          "custom-preset": { css },
          "./theme.css.js": { recipe },
          "./values.js": {
            tick() {
              events.push("tick");
            },
            readSize() {
              const first = !events.includes("read");
              events.push("read");
              return first ? 4 : 12;
            }
          }
        };
        const sidecar = executeModule(result[1], modules);
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });
        const Box = runtime.Box as () => { props: { className: string } };
        expect(events).toEqual([]);
        expect([Box().props.className, Box().props.className]).toEqual([
          recipe({ size: 4 }),
          recipe({ size: 12 })
        ]);
        expect(events).toEqual(
          prefix ? ["tick", "read", "tick", "read"] : ["read", "read"]
        );
      }
    );

    it.each([
      ["selected alias", "const selected = false ? other : input;", "selected"],
      ["unknown branch", "", "enabled ? input : { padding: 4 }"]
    ])(
      "retains selected or possible input mutations: %s",
      (_, declaration, argument) => {
        const getStyles = vi.fn((input: { padding: number }) => input);
        const { result } = babelTransform(
          `
          import {getStyles} from "./theme.css.js";
          import {enabled} from "./values.js";
          const input = { padding: 4 };
          const other = { padding: 4 };
          input.padding = 12;
          ${declaration}
          export const Box = () => <div css={getStyles(${argument})} />;
        `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        expect(() =>
          executeSidecar(result[1], {
            "@mincho-js/css": { mincho$ },
            "custom-preset": { css },
            "./theme.css.js": { getStyles },
            "./values.js": { enabled: false }
          })
        ).toThrow(/accepts runtime calls only to compiled/);
        expect(getStyles).not.toHaveBeenCalled();
      }
    );

    it.each([
      ["max", "", "Math.max({ valueOf: readValue }, 0)"],
      ["min", "", "Math.min({ valueOf: readValue }, 20)"],
      [
        "aliased coercion object",
        "const value = { valueOf: readValue };",
        "Math.max(value, 0)"
      ],
      ["optional max", "", "Math?.max({ valueOf: readValue }, 0)"],
      ["repeat count", "", '"x".repeat({ valueOf: readValue }).length'],
      [
        "coercing fromIndex",
        "",
        "[0, 0, 0, 0, 1].includes(1, { valueOf: readValue }) ? 4 : 12"
      ],
      [
        "spread fromIndex",
        "const offset = { valueOf: readValue };",
        "[0, 0, 0, 0, 1].includes(...[1, offset]) ? 4 : 12"
      ]
    ])("defers imported numeric coercion: %s", (_, declaration, argument) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
          import {recipe} from "./theme.css.js";
          import {readValue} from "./runtime.js";
          ${declaration}
          export const Box = () => <div css={recipe({size: ${argument}})} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readValue }
      };
      const sidecar = executeModule(result[1], modules);
      expect(readValue).not.toHaveBeenCalled();
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };
      expect(Box().props.className).toBe(recipe({ size: 4 }));
      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(readValue).toHaveBeenCalledTimes(2);
      expect(result[1]).not.toContain("./runtime.js");
    });

    it.each([
      ["max", "", "Math.max(4, 0)"],
      [
        "max with unrelated redeclared var",
        "var count; var count;",
        "Math.max(4, 0)"
      ],
      [
        "max with initialized redeclared var",
        "var count = 1; var count = 2;",
        "Math.max(4, 0)"
      ],
      ["min", "", "Math.min(4, 12)"],
      ["primitive fromIndex", "", "[4].includes(4, 0) ? 4 : 12"],
      ["constant primitive", "const size = 4;", "Math.max(size, 0)"],
      [
        "local primitive helper",
        "const size = 4; function read(value) { return value; }",
        "read(size)"
      ]
    ])(
      "keeps primitive argument helpers static: %s",
      (_, declaration, argument) => {
        const getStyles = vi.fn((padding: number) => ({ padding }));
        const { code, result } = babelTransform(
          `
          import {getStyles} from "./theme.css.js";
          ${declaration}
          export const Box = () => <div css={getStyles(${argument})} />;
        `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        expect(
          executeSidecar(result[1], {
            "@mincho-js/css": { mincho$ },
            "custom-preset": { css },
            "./theme.css.js": { getStyles }
          })
        ).toEqual([expect.any(String)]);
        expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
        expect(code).not.toContain("getStyles(");
      }
    );

    it.each([
      ["literal primitive", "4", "export const spacing = 4;", true],
      [
        "resolved imported primitive",
        "spacing",
        "export const spacing = 4;",
        true
      ],
      ["unproved imported value", "spacing", "export let spacing = {};", false]
    ] as const)(
      "uses the resolved primitive proof at the local argument: %s",
      (_case, value, tokenModule, staticCall) => {
        const source = `
        import {getStyles} from "./theme.css.js";
        ${value === "spacing" ? 'import {spacing} from "./tokens.js";' : ""}
        const identity = value => value;
        export const Box = () => <div css={getStyles(identity(${value}))} />;
      `;
        const preparedExtractCalls = prepareModuleSourceFixture(
          source,
          { "./tokens.js": tokenModule },
          { "custom-preset": ["css"] },
          true
        );
        const { code, result } = babelTransform(source, {
          jsxCssProp,
          optimize: { pureFunctions: false },
          preparedExtractCalls
        });
        const definition = defineRules({ properties: { padding: [4] } });
        const getStyles = vi.fn((padding: number) => ({ padding }));
        const modules = {
          "@mincho-js/css": { mincho$ },
          "@mincho-js/css/classname": { cx },
          "custom-preset": { css: definition.css },
          "./theme.css.js": { getStyles },
          "./tokens.js": { spacing: staticCall ? 4 : {} }
        };
        if (!staticCall) {
          expect(() => executeModule(result[1], modules)).toThrow(
            /runtime calls only to compiled/
          );
          expect(getStyles).not.toHaveBeenCalled();
          return;
        }
        const sidecar = executeModule(result[1], modules);
        const { Box } = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        }) as {
          Box(): { props: { className: string } };
        };
        expect(Box().props.className).toBe(definition.css({ padding: 4 }));
        expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      }
    );

    it.each(["Math.max(size, 4)", '"x".repeat(size).length'])(
      "preserves imported primitive coercion at runtime: %s",
      (argument) => {
        const recipe = rules({
          variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
        });
        const { code, result } = babelTransform(
          `
            import {recipe} from "./theme.css.js";
            import {size} from "./values.js";
            export const Box = () => <div css={recipe({size: ${argument}})} />;
          `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        const values = { size: 4 };
        const modules = {
          "@mincho-js/css": { mincho$ },
          "@mincho-js/css/classname": { cx },
          "custom-preset": { css },
          "./theme.css.js": { recipe },
          "./values.js": values
        };
        const sidecar = executeModule(result[1], modules);
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });
        const Box = runtime.Box as () => { props: { className: string } };
        expect(Box().props.className).toBe(recipe({ size: 4 }));
        values.size = 12;
        expect(Box().props.className).toBe(recipe({ size: 12 }));
        expect(result[1]).not.toContain("./values.js");
      }
    );

    it.each([
      [
        "declaration",
        "function take(values) { return values.pop(); }",
        "take(choices)"
      ],
      [
        "aliased arrow",
        "const pop = values => values.pop(); const take = pop;",
        "take(choices)"
      ],
      ["inline helper", "", "(values => values.pop())(choices)"],
      [
        "mutating array callback",
        "",
        "[choices].map(values => values.pop())[0]"
      ],
      ["closed-over input", "const take = () => choices.pop();", "take()"]
    ])(
      "preserves mutating local helper execution: %s",
      (_, declaration, argument) => {
        const recipe = rules({
          variants: {
            tone: { square: { padding: 4 }, rounded: { padding: 12 } }
          }
        });
        const { code, result } = babelTransform(
          `
          import {recipe} from "./theme.css.js";
          const choices = [{tone: "square"}, {tone: "rounded"}];
          ${declaration}
          export const Box = () => <div css={recipe(${argument})} />;
        `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        const sidecar = executeModule(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { recipe }
        });
        const runtime = executeModule(code, {
          "@mincho-js/css/classname": { cx },
          [result[0]]: sidecar
        });
        const Box = runtime.Box as () => { props: { className: string } };
        expect(Box().props.className).toBe(recipe({ tone: "rounded" }));
        expect(Box().props.className).toBe(recipe({ tone: "square" }));
        expect(result[1]).not.toContain("values.pop()");
      }
    );
  });

  it.each([
    'function read() { const min = "max"; return Math[min](0, 1) ? window.innerWidth : 0; }',
    'function read() { const min = "max"; return Math[min](0, 1) && window.innerWidth; }',
    'function read() { const max = "min"; return Math[max](0, 1) || window.innerWidth; }',
    "function read(size = window.innerWidth) { return size; }",
    "const read = (size = window.innerWidth) => size;",
    "function read({ size = window.innerWidth } = {}) { return size; }",
    "function read([size = window.innerWidth] = []) { return size; }",
    "function read({ nested: [size = window.innerWidth] = [] } = {}) { return size; }",
    "function read({ [window.innerWidth]: size } = { 4: 4, 12: 12 }) { return size; }",
    "function read(size = window.innerWidth) { const window = { innerWidth: 99 }; return size; }",
    "function read() { const { size = window.innerWidth } = {}; return size; }",
    "const read = () => { const [size = window.innerWidth] = []; return size; };",
    "function read() { const { nested: [size = window.innerWidth] = [] } = {}; return size; }",
    "function read() { const { [window.innerWidth]: size } = { 4: 4, 12: 12 }; return size; }",
    "function read() { const { nested: { [window.innerWidth]: size } = window.unusedDefault } = { nested: { 4: 4, 12: 12 } }; return size; }"
  ])("preserves runtime helper parameter expressions: %s", (declaration) => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const { code, result } = babelTransform(
      `
      import { recipe } from "./theme.css.js";
      export const Box = () => {
        ${declaration}
        return <div css={recipe({ size: read() })} />;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    let width = 4;
    const readWidth = vi.fn(() => width);
    vi.stubGlobal("window", {
      get innerWidth() {
        return readWidth();
      }
    });
    try {
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe }
      });

      expect(readWidth).not.toHaveBeenCalled();

      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };
      expect(Box().props.className).toBe(recipe({ size: 4 }));
      width = 12;
      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(readWidth).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["no nested helper", "", "4", false, 4],
    [
      "dormant nested helper",
      "const readNested = () => readValue();",
      "4",
      false,
      4
    ],
    [
      "invoked nested helper",
      "const readNested = () => readValue();",
      "readNested()",
      true,
      12
    ]
  ] as const)(
    "classifies configured factory arguments by actual local helper activation: %s",
    (_name, nested, value, runtime, padding) => {
      const readValue = vi.fn(() => 12);
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const imported = {
        "./theme.css.js": { getStyles },
        "./measure.js": { readValue }
      };
      const authored = `
        import { getStyles } from "./theme.css.js";
        import { readValue } from "./measure.js";
        function read() { ${nested} return ${value}; }
        export const Box = () => <div css={getStyles(read())} />;
      `;

      const native = executeModule(authored, imported);
      const nativeBox = native.Box as () => {
        props: { css: { padding: number } };
      };
      expect(nativeBox().props.css.padding).toBe(padding);
      expect(readValue).toHaveBeenCalledTimes(runtime ? 1 : 0);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(padding);
      readValue.mockClear();
      getStyles.mockClear();

      const { code, result } = babelTransform(authored, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const modules = {
        ...imported,
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css }
      };
      if (runtime) {
        expect(() => executeModule(result[1], modules)).toThrow(
          /runtime calls only to compiled Mincho or Vanilla Extract recipes/
        );
        expect(getStyles).not.toHaveBeenCalled();
      } else {
        const sidecar = executeModule(result[1], modules);
        const app = executeModule(code, { ...modules, [result[0]]: sidecar });
        const Box = app.Box as () => { props: { className: string } };
        expect(Object.values(sidecar)).toEqual([expect.any(String)]);
        expect(Box().props.className).toBe(Object.values(sidecar)[0]);
        expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      }
      expect(readValue).not.toHaveBeenCalled();
    }
  );

  it.each([
    "function read(size = 4) { return size; }",
    "function read() { const { size = window.innerWidth } = { size: 4 }; return size; }",
    "const read = () => { const [size = window.innerWidth] = [4]; return size; };",
    "function read() { const { nested: [size = window.innerWidth] = [4] } = {}; return size; }",
    "const read = ({ nested: [size = 4] = [] } = {}) => size;",
    "function read({ ['size']: size = 4 } = {}) { return size; }"
  ])(
    "keeps static helper parameter expressions extractable: %s",
    (declaration) => {
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const { result } = babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      ${declaration}
      export const Box = () => <div css={getStyles(read())} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { getStyles }
      });

      expect(values).toEqual([expect.any(String)]);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
    }
  );

  it.each([
    ["", "Math.round(Math.random())"],
    ["", 'Math.round(Math["random"]())'],
    ["", "Math.round(Math.random?.())"],
    ["", "Math.round(Math?.random())"],
    ["", "[0].map(Math.random)[0]"],
    ["const read = () => Math.round(Math.random());", "read()"],
    [
      "const values = { read: () => Math.round(Math.random()) };",
      "values.read()"
    ],
    ["const read = Math.random;", "Math.round(read())"],
    ["const M = Math;", "Math.round(M.random())"],
    ["const { random } = Math;", "Math.round(random())"],
    ["const random = Math.random.bind(Math);", "Math.round(random())"]
  ])(
    "preserves non-deterministic global recipe arguments: %s %s",
    (declaration, value) => {
      const recipe = rules({
        variants: { size: { 0: { padding: 4 }, 1: { padding: 12 } } }
      });
      const { code, result } = babelTransform(
        `
        import { recipe } from "./theme.css.js";
        ${declaration}
        export const Box = () => <div css={recipe({ size: ${value} })} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const random = vi
        .spyOn(Math, "random")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1);
      try {
        const sidecar = executeModule(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { recipe }
        });
        expect(random).not.toHaveBeenCalled();

        const runtime = executeModule(code, {
          "@mincho-js/css/classname": { cx },
          [result[0]]: sidecar
        });
        const Box = runtime.Box as () => { props: { className: string } };

        expect(Box().props.className).toBe(recipe({ size: 0 }));
        expect(Box().props.className).toBe(recipe({ size: 1 }));
        expect(random).toHaveBeenCalledTimes(2);
      } finally {
        random.mockRestore();
      }
    }
  );

  it.each([
    ["", "Math.max(0, 1)"],
    ["", "Math?.max(0, 1)"],
    ["const read = () => Math.max(0, 1);", "read()"],
    ["const Math = { random: () => 1 };", "Math.random()"],
    ["const M = Math;", "M.max(0, 1)"],
    ["const { max } = Math;", "max(0, 1)"],
    ["const max = Math.max.bind(Math);", "max(0, 1)"],
    ['const random = "max";', "Math[random](0, 1)"],
    ["", "false ? Math.random() : 1"]
  ])(
    "keeps deterministic global recipe arguments static: %s %s",
    (declaration, value) => {
      const recipe = rules({
        variants: { size: { 1: { padding: 12 } } }
      });
      const { code, result } = babelTransform(
        `
        import { recipe } from "./theme.css.js";
        ${declaration}
        export const Box = () => <div css={recipe({ size: ${value} })} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 1 }));
      expect(result[1]).not.toContain("__recipe__");
    }
  );

  it.each([
    "false ? readValue() : 4",
    "true ? 4 : readValue()",
    "4 || readValue()",
    "4 ?? readValue()",
    "(false && readValue()) || 4",
    "({ value: false ? readValue() : 4 }).value",
    "false ? readValue?.() : 4"
  ])("ignores unreachable imported factory arguments: %s", (value) => {
    const getStyles = vi.fn((padding: number) => ({ padding }));
    const readValue = vi.fn(() => {
      throw new Error("Unreachable runtime call was executed");
    });
    const configuredCss = vi.fn(css);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      export const Box = () => <div css={getStyles(${value})} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css: configuredCss },
      "./theme.css.js": { getStyles },
      "./runtime.js": { readValue }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toEqual(expect.any(String));
    expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
    expect(configuredCss).toHaveBeenCalledExactlyOnceWith({ padding: 4 });
    expect(readValue).not.toHaveBeenCalled();
    expect(code).not.toContain("getStyles(");
  });

  it.each(
    [
      "false ? size : 4",
      "true ? 4 : size",
      "4 || size",
      "4 ?? size",
      "(false && size) || 4",
      "({ value: false ? size : 4 }).value"
    ].flatMap((value) => [
      { value, destructure: false },
      { value, destructure: true }
    ])
  )(
    "ignores unreachable component parameters: $value, destructure=$destructure",
    ({ value, destructure }) => {
      const getStyles = vi.fn((padding: number) =>
        destructure ? [{ padding }] : { padding }
      );
      const configuredCss = vi.fn(css);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      export const Box = ({size}) => {
        ${destructure ? `const [rule] = getStyles(${value});` : ""}
        return <div css={${destructure ? "rule" : `getStyles(${value})`}} />;
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      expect(configuredCss).toHaveBeenCalledExactlyOnceWith({ padding: 4 });
      getStyles.mockClear();

      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (props: { size: number }) => {
        props: { className: string };
      };

      expect(Box({ size: 12 }).props.className).toEqual(expect.any(String));
      // Destructuring previously left its producer at runtime and duplicated
      // the already-published build call. Both forms now share one build owner.
      expect(getStyles).not.toHaveBeenCalled();
      expect(code).not.toContain("getStyles(");
    }
  );

  it.each([
    "const [first, second] = active ? getStyles() : [{ padding: 4 }, { padding: 12 }];",
    "const { first, second } = active ? getStyles() : { first: { padding: 4 }, second: { padding: 12 } };",
    "const styles = active ? getStyles() : [{ padding: 4 }, { padding: 12 }]; const [first, second] = styles;",
    "const [one, two] = active ? getStyles() : [{ padding: 4 }, { padding: 12 }]; const first = one; const second = two;",
    "const [first, second] = (active ? getStyles() : [{ padding: 4 }, { padding: 12 }]) as const;",
    "const [first, second] = enabled() ? getStyles() : [{ padding: 4 }, { padding: 12 }];"
  ])(
    "rejects runtime factory destructuring without sharing a whole-value class: %s",
    (declaration) => {
      expect(() =>
        babelTransform(
          `
        import {getStyles, enabled} from "./theme.css.js";
        export const Box = ({active}) => {
          ${declaration}
          return { first: <div css={first} />, second: <span css={second} /> };
        };
        `,
          { jsxCssProp }
        )
      ).toThrow("Destructured CSS factory values must be statically evaluable");
    }
  );

  it.each([
    ["const [first, second] = getStyles();", [{ padding: 4 }, { padding: 12 }]],
    [
      "const { first, second } = getStyles();",
      { first: { padding: 4 }, second: { padding: 12 } }
    ],
    [
      "const styles = getStyles(); const [first, second] = styles;",
      [{ padding: 4 }, { padding: 12 }]
    ],
    [
      "const [one, two] = getStyles(); const first = one; const second = two;",
      [{ padding: 4 }, { padding: 12 }]
    ]
  ])(
    "compiles each static destructured factory selection: %s",
    (declaration, value) => {
      const getStyles = vi.fn(() => value);
      const configuredCss = vi.fn(css);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      export const Box = () => {
        ${declaration}
        return { first: <div css={first} />, second: <span css={second} /> };
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => {
        first: { props: { className: string } };
        second: { props: { className: string } };
      };
      const rendered = Box();

      expect(configuredCss.mock.calls).toEqual([
        [{ padding: 4 }],
        [{ padding: 12 }]
      ]);
      expect(rendered.first.props.className).toBe(
        configuredCss.mock.results[0].value
      );
      expect(rendered.second.props.className).toBe(
        configuredCss.mock.results[1].value
      );
      expect(rendered.first.props.className).not.toBe(
        rendered.second.props.className
      );
    }
  );

  it.each([
    "const [first, second] = active ? ['first-active', 'second-active'] : ['first-idle', 'second-idle'];",
    "const { first, second } = active ? { first: 'first-active', second: 'second-active' } : { first: 'first-idle', second: 'second-idle' };"
  ])("preserves runtime destructured class strings: %s", (declaration) => {
    const { code } = babelTransform(
      `
      export const Box = ({active}) => {
        ${declaration}
        return { first: <div css={first} />, second: <span css={second} /> };
      };
      `,
      { jsxCssProp }
    );
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx }
    });
    const Box = runtime.Box as (props: { active: boolean }) => {
      first: { props: { className: string } };
      second: { props: { className: string } };
    };

    for (const active of [false, true]) {
      const rendered = Box({ active });
      const suffix = active ? "active" : "idle";
      expect(rendered.first.props.className).toBe(`first-${suffix}`);
      expect(rendered.second.props.className).toBe(`second-${suffix}`);
    }
  });

  it.each([
    "[getStyles()]",
    "[[getStyles()]]",
    '["external", getStyles(), false, null, undefined]',
    "([getStyles()] as const)"
  ])(
    "prepares static factories in arrays with a css-only source: %s",
    (expression) => {
      const style = { padding: 12 } as const;
      const getStyles = vi.fn(() => style);
      const definition = defineRules({ properties: { padding: [12] } });
      const configuredCss = vi.fn(definition.css);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      export const Box = () => <div css={${expression}} />;
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(getStyles).toHaveBeenCalledOnce();
      expect(configuredCss).toHaveBeenCalledExactlyOnceWith(style);
      expect(Box().props.className).toBe(
        cx(expression.includes("external") && "external", definition.css(style))
      );
      expect(code).not.toContain("getStyles(");
    }
  );

  it("keeps plain cx out of serialized factory arrays", () => {
    const definition = defineRules({ properties: { padding: [12] } });
    const getStyles = vi.fn(() => ({ padding: 12 }));
    const plainCx = vi.fn(cx);
    const { code, result } = babelTransform(
      `
          import { getStyles } from "./theme.css.js";
          export const Box = () => <div css={["external", getStyles()]} />;
        `,
      {
        jsxCssProp,
        optimize: { pureFunctions: false }
      }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$, cx, css: definition.css },
      "custom-preset": { cx: plainCx, css: definition.css },
      "./theme.css.js": { getStyles }
    });
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toBe(
      cx("external", definition.css({ padding: 12 }))
    );
    expect(Object.values(sidecar)).not.toContain(plainCx);
    expect(Object.values(sidecar)).toContain(null);
    expect(getStyles).toHaveBeenCalledOnce();
    expect(plainCx).not.toHaveBeenCalled();
  });

  it.each([
    ["[getWide(), getNarrowLeft()]", false],
    ["[getNarrowLeft(), getWide()]", true],
    ["[[getWide()], getNarrowLeft()]", false]
  ])(
    "resolves atomic conflicts in factory arrays: %s",
    (expression, reversed) => {
      const definition = defineRules({
        properties: { paddingLeft: [4, 12], paddingRight: [4, 12] },
        shortcuts: { px: ["paddingLeft", "paddingRight"] }
      });
      const getWide = vi.fn(() => ({ px: 12 }) as const);
      const getNarrowLeft = vi.fn(() => ({ paddingLeft: 4 }) as const);
      const configuredCss = vi.fn(definition.css);
      const { code, result } = babelTransform(
        `
        import {getWide, getNarrowLeft} from "./theme.css.js";
        export const Box = () => <div css={${expression}} />;
      `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss, cx: definition.cx },
        "./theme.css.js": { getWide, getNarrowLeft }
      });
      const serializedCx = Reflect.get(definition.cx, "__recipe__") as {
        args: Parameters<typeof createCompiledDefineRulesCxRuntime>;
      };
      const compiledCx = createCompiledDefineRulesCxRuntime(
        ...serializedCx.args
      );
      const runtimeSidecar = Object.fromEntries(
        Object.entries(sidecar).map(([name, value]) => [
          name,
          value === definition.cx ? compiledCx : value
        ])
      );
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: runtimeSidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };
      const wide = definition.css({ px: 12 });
      const narrowLeft = definition.css({ paddingLeft: 4 });
      const expected = reversed
        ? compiledCx(narrowLeft, wide)
        : compiledCx(wide, narrowLeft);

      expect(Box().props.className).toBe(expected);
      expect(getWide).toHaveBeenCalledOnce();
      expect(getNarrowLeft).toHaveBeenCalledOnce();
      expect(configuredCss).toHaveBeenCalledTimes(2);
      expect(configuredCss.mock.calls).toEqual(
        reversed
          ? [[{ paddingLeft: 4 }], [{ px: 12 }]]
          : [[{ px: 12 }], [{ paddingLeft: 4 }]]
      );
    }
  );

  it.each([
    "selected.padding = 4;",
    "const alias = selected; alias.padding = 4;",
    "const alias = (selected as any); delete alias.padding;",
    "const alias = true ? selected : {}; alias.padding = 4;",
    "Object.assign(selected, {padding: 4});",
    "const update = value => { value.padding = 4; }; update(selected);",
    "const holder = {selected}; holder.selected.padding = 4;",
    "const holder = [selected]; holder[0].padding = 4;",
    "const copy = Object.assign({}, selected); copy.nested.padding = 4;",
    "const copy = {...selected}; copy.nested.padding = 4;",
    "mutate({selected, element: <div css={selected} />});"
  ])("rejects mutated factory results before extraction: %s", (mutation) => {
    expect(() =>
      babelTransform(
        `
        import {getStyles} from "./theme.css.js";
        export const Box = () => {
          const selected = getStyles();
          ${mutation}
          return <div css={selected} style={selected} />;
        };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(/CSS factory values must not be mutated/);
  });

  it("reports an unknown factory alias origin without claiming mutation", () => {
    expect(() =>
      babelTransform(
        `import { getStyles } from "./theme.css.js";
         export const Box = () => {
           const selected = getStyles();
           const holder = { selected, get value() { return this.selected; } };
           holder.value.padding = 4;
           return <div css={selected} style={selected} />;
         };`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(
      /Cannot prove CSS factory value selected is unmodified: getter-receiver/
    );
  });

  it.each([
    "update(selected)",
    "update?.(selected)",
    "new Update(selected)",
    "{ size: update(selected) }"
  ])("checks nested calls inside prepared recipe arguments: %s", (argument) => {
    expect(() =>
      babelTransform(
        `import { getStyles, recipe } from "./theme.css.js";
         import { update, Update } from "./runtime.js";
         export const Box = () => {
           const selected = getStyles();
           return <div css={[recipe(${argument}), selected]} />;
         };`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(/CSS factory values must not be mutated/);
  });

  it("does not exempt consumers that can mutate before a JSX callback", () => {
    expect(() =>
      babelTransform(
        `
        import {getStyles} from "./theme.css.js";
        export const Box = () => {
          const selected = getStyles();
          return mutate({selected, render: () => <div css={selected} />});
        };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(/CSS factory values must not be mutated/);
  });

  it("preserves readonly factory results when a separate copy is mutated", () => {
    const definition = defineRules({ properties: { padding: [4, 12] } });
    const getStyles = vi.fn(() => ({ padding: 12 }) as const);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = () => {
        const selected = getStyles();
        const copy = {...selected};
        const holder = {selected};
        const values = [selected];
        copy.padding = 4;
        return {selected, copy, holder, values, padding: selected.padding, element: <div css={selected} style={selected} />};
      };
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": definition,
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => {
      selected: unknown;
      copy: unknown;
      holder: { selected: unknown };
      values: unknown[];
      padding: number;
      element: { props: { className: string; style: unknown } };
    };
    getStyles.mockClear();
    const rendered = Box();

    expect(rendered.selected).toEqual({ padding: 12 });
    expect(rendered.copy).toEqual({ padding: 4 });
    expect(rendered.copy).not.toBe(rendered.selected);
    expect(rendered.holder.selected).toBe(rendered.selected);
    expect(rendered.values).toEqual([rendered.selected]);
    expect(rendered.padding).toBe(12);
    expect(rendered.element.props.style).toBe(rendered.selected);
    expect(rendered.element.props.className).toBe(
      definition.css({ padding: 12 })
    );
    expect(getStyles).toHaveBeenCalledOnce();
  });

  it.each([
    "[getStyles(), {padding: 4}]",
    "[{padding: 4}, getStyles()]",
    '[getStyles(), {padding: 4}, "rounded"]'
  ])("keeps the mixed style-array diagnostic: %s", (expression) => {
    expect(() =>
      babelTransform(
        `
        import {getStyles} from "./theme.css.js";
        export const Box = () => <div css={${expression}} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(/complete static style arrays/);
  });

  it.each(["template", "literal", "opaque"] as const)(
    "uses normal class merging for a recipe and a %s class-array member",
    (kind) => {
      const definition = defineRules({
        properties: { padding: [4, 12], color: ["red", "blue"] }
      });
      const recipe = definition.rules({
        variants: {
          tone: { quiet: { color: "red" }, strong: { color: "blue" } }
        }
      });
      const first = definition.css({ padding: 12 });
      const last = definition.css({ padding: 4 });
      const base = cx(first, last);
      const variantClass = recipe({ tone: "strong" });
      const genericJoin = cx(base, variantClass);
      const configuredJoin = definition.cx(base, variantClass);
      expect(genericJoin).not.toBe(configuredJoin);

      const element =
        kind === "template"
          ? "`${readBase()}`"
          : kind === "literal"
            ? JSON.stringify(base)
            : "base";
      const authored = `
        import {recipe} from "./theme.css.js";
        export const Box = ({base,readBase,readTone}) =>
          <div css={[${element},recipe({tone: readTone()})]} />;
      `;
      const trace: string[] = [];
      const properties = {
        base,
        readBase: () => {
          trace.push("base");
          return base;
        },
        readTone: () => {
          trace.push("tone");
          return "strong";
        }
      };
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: definition.css, cx: definition.cx },
        "./theme.css.js": { recipe }
      };
      const native = executeModule(authored, modules).Box as (
        props: typeof properties
      ) => { props: { css: string[] } };
      expect(definition.cx(native(properties).props.css)).toBe(configuredJoin);
      const expectedTrace = kind === "template" ? ["base", "tone"] : ["tone"];
      expect(trace.splice(0)).toEqual(expectedTrace);

      const { code, result } = babelTransform(authored, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const sidecar = result[1] ? executeModule(result[1], modules) : {};
      const compiled = executeModule(code, { ...modules, [result[0]]: sidecar })
        .Box as (props: typeof properties) => { props: { className: string } };
      expect(trace).toEqual([]);
      expect(compiled(properties).props).toEqual({
        className: kind === "opaque" ? genericJoin : configuredJoin
      });
      expect(trace).toEqual(expectedTrace);
      expect(code.includes("recipe(")).toBe(kind === "opaque");
    }
  );

  it("preserves runtime recipe arguments inside direct class arrays", () => {
    const definition = defineRules({ properties: { padding: [4, 12] } });
    const recipe = definition.rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
    const configuredCss = vi.fn(definition.css);
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      export const Box = ({active}) => <div css={["external", active && recipe({size: readValue()})]} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css: configuredCss, cx: definition.cx },
      "./theme.css.js": { recipe }
    });
    expect(readValue).not.toHaveBeenCalled();
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      "./runtime.js": { readValue },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as (props: { active: boolean }) => {
      props: { className: string };
    };

    expect(Box({ active: false }).props.className).toBe("external");
    expect(readValue).not.toHaveBeenCalled();
    expect([
      Box({ active: true }).props.className,
      Box({ active: true }).props.className
    ]).toEqual([
      cx("external", recipe({ size: 4 })),
      cx("external", recipe({ size: 12 }))
    ]);
    expect(readValue).toHaveBeenCalledTimes(2);
    expect(configuredCss).not.toHaveBeenCalled();
    expect(result[1]).not.toContain("./runtime.js");
    expect(result[1]).not.toContain("readValue()");
    expect(code).not.toContain("recipe(");
  });

  it("preserves shared factory values used by direct arrays and ordinary props", () => {
    const style = { padding: 12 } as const;
    const getStyles = vi.fn(() => style);
    const definition = defineRules({ properties: { padding: [12] } });
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = () => {
        const value = getStyles();
        const copy = value;
        return {
          value,
          first: <div style={value} css={[copy]} />,
          second: <span data-value={copy} css={[copy]} />
        };
      };
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": definition,
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => {
      value: unknown;
      first: { props: { style: unknown; className: string } };
      second: { props: { "data-value": unknown; className: string } };
    };

    for (let render = 0; render < 2; render++) {
      getStyles.mockClear();
      const rendered = Box();

      expect(rendered.value).toBe(style);
      expect(rendered.first.props.style).toBe(style);
      expect(rendered.second.props["data-value"]).toBe(style);
      expect(rendered.first.props.className).toBe(definition.css(style));
      expect(rendered.second.props.className).toBe(
        rendered.first.props.className
      );
      expect(getStyles).toHaveBeenCalledOnce();
    }
  });

  it.each(["recipe()", "[recipe()]"])(
    "keeps static recipe results as classes instead of interpreting them as tokens: %s",
    (expression) => {
      const recipe = rules({ base: { padding: 12 } });
      const configuredCss = vi.fn(css);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      export const Box = () => <div css={${expression}} />;
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss, cx },
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe());
      expect(configuredCss).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: "inline callback",
      declaration: "",
      argument: "[4, 12].map(padding => padding)"
    },
    {
      name: "callback-local alias",
      declaration: "",
      argument:
        "[4, 12].map(padding => { const value = padding; return value; })"
    },
    {
      name: "module-level alias",
      declaration: "const values = [4, 12].map(padding => padding);",
      argument: "values"
    }
  ])(
    "accepts callback-local parameters in static factories: $name",
    ({ declaration, argument }) => {
      const getStyles = vi.fn((values: number[]) => ({ padding: values[1] }));
      const configuredCss = vi.fn(css);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      ${declaration}
      export const Box = () => <div css={getStyles(${argument})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles }
      });

      expect(values).toEqual([expect.any(String)]);
      expect(getStyles).toHaveBeenCalledExactlyOnceWith([4, 12]);
      expect(configuredCss).toHaveBeenCalledExactlyOnceWith({ padding: 12 });
      expect(code).not.toContain("getStyles(");
    }
  );

  it("still rejects captured runtime parameters inside factory callbacks", () => {
    const getStyles = vi.fn((values: number[]) => ({ padding: values[1] }));
    const { result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = ({extra}) => <div css={getStyles([4, 12].map(padding => padding + extra))} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );

    expect(() =>
      executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      })
    ).toThrow(
      "runtime calls only to compiled Mincho or Vanilla Extract recipes"
    );
    expect(getStyles).not.toHaveBeenCalled();
    expect(result[1]).not.toContain("padding + extra");
  });

  it.each([
    "[4, 12].map(value => value)",
    "readValues()",
    "true ? readValues() : [4, 12]",
    "true && readValues()",
    "(readValues() as number[])",
    "readValues?.()",
    "new readValues()",
    "[...readValues()]",
    "({ values: readValues() }).values"
  ])(
    "keeps component-local call initializers out of static factories: %s",
    (initializer) => {
      const getStyles = vi.fn((values: number[]) => ({ padding: values[1] }));
      const readValues = vi.fn(() => [4, 12]);
      const { result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      import {readValues} from "./runtime.js";
      export const Box = () => {
        const values = ${initializer};
        return <div css={getStyles(values)} />;
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );

      expect(() =>
        executeSidecar(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { getStyles },
          "./runtime.js": { readValues }
        })
      ).toThrow(
        "runtime calls only to compiled Mincho or Vanilla Extract recipes"
      );
      expect(getStyles).not.toHaveBeenCalled();
      expect(readValues).not.toHaveBeenCalled();
      expect(result[1]).not.toContain(initializer);
    }
  );

  it("does not mistake deferred callback bodies for local initializer calls", () => {
    const getStyles = vi.fn((values: () => number[]) => ({
      padding: values()[1]
    }));
    const configuredCss = vi.fn(css);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = () => {
        const values = () => [4, 12].map(padding => padding);
        return <div css={getStyles(values)} />;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const values = executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css: configuredCss },
      "./theme.css.js": { getStyles }
    });

    expect(values).toEqual([expect.any(String)]);
    expect(getStyles).toHaveBeenCalledOnce();
    expect(configuredCss).toHaveBeenCalledExactlyOnceWith({ padding: 12 });
    expect(code).not.toContain("getStyles(");
  });

  it.each([
    "readValue()",
    "true ? readValue() : 4",
    "({ value: readValue() }).value"
  ])("preserves component-local recipe calls at runtime: %s", (initializer) => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      export const Box = () => {
        const size = ${initializer};
        return <div css={recipe({size})} />;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$ },
      "./theme.css.js": { recipe }
    });
    expect(readValue).not.toHaveBeenCalled();
    expect(result[1]).not.toContain("./runtime.js");
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      "./runtime.js": { readValue },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toBe(recipe({ size: 4 }));
    expect(Box().props.className).toBe(recipe({ size: 12 }));
    expect(readValue).toHaveBeenCalledTimes(2);
  });

  it.each([
    "const { size = readValue() } = {};",
    "const [size = readValue()] = [];",
    "const { values: [size = readValue()] = [] } = {};",
    "const { [readValue()]: size } = { 4: 4, 12: 12 };",
    "const read = readValue; const { size = read() } = {};"
  ])(
    "keeps executed module-pattern expressions at runtime: %s",
    (declaration) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      ${declaration}
      export const Box = () => <div css={recipe({size})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readValue }
      };
      const sidecar = executeModule(result[1], modules);

      expect(readValue).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("./runtime.js");

      // A module pattern executes once per module evaluation, not per render.
      for (const size of [4, 12] as const) {
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });
        const Box = runtime.Box as () => { props: { className: string } };
        expect(Box().props.className).toBe(recipe({ size }));
        expect(Box().props.className).toBe(recipe({ size }));
      }
      expect(readValue).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    "const { size = readValue() } = { size: 4 };",
    "const [size = readValue()] = [4];",
    "const { values: [size = readValue()] = [4] } = {};",
    "const { values: [size = readValue()] = readValue() } = { values: [4] };"
  ])("keeps unreachable module-pattern defaults static: %s", (declaration) => {
    const recipe = rules({ variants: { size: { 4: { padding: 4 } } } });
    const readValue = vi.fn(() => {
      throw new Error("Unreachable module pattern default");
    });
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      ${declaration}
      export const Box = () => <div css={recipe({size})} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    expect(
      executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readValue }
      })
    ).toEqual([recipe({ size: 4 })]);
    expect(readValue).not.toHaveBeenCalled();
    expect(code).not.toContain("recipe(");
  });

  it.each([
    ["unary plus", "", "+{ valueOf: readValue }"],
    ["inherited hook", "", "+{ __proto__: { valueOf: readValue } }"],
    [
      "inherited hook alias",
      "const prototype = { valueOf: readValue };",
      "+{ __proto__: prototype }"
    ],
    ["unary minus", "", "-(-{ valueOf: readValue })"],
    ["bitwise unary", "", "~(~{ valueOf: readValue })"],
    ["addition", "", "({ valueOf: readValue }) + 0"],
    ["multiplication", "", "({ valueOf: readValue }) * 1"],
    ["template", "", "`${{ toString: readValue }}`"],
    ["object alias", "const value = { valueOf: readValue };", "+value"],
    ["callback alias", "const read = readValue;", "+{ valueOf: read }"],
    ["namespace callback", "", "+{ valueOf: runtime.readValue }"],
    ["getter callback", "", "+{ get valueOf() { return readValue; } }"],
    ["computed hook alias", 'const key = "valueOf";', "+{ [key]: readValue }"],
    ["imported computed hook", "", "+{ [hookKey]: readValue }"],
    ["spread hook", "", "+{ ...{ valueOf: readValue } }"],
    ["array conversion", "", "+[{ toString: readValue }]"],
    [
      "in key conversion",
      "",
      "({ toString: readValue }) in { 4: true } ? 4 : 12"
    ],
    [
      "increment conversion",
      "",
      "(() => { let value = { valueOf: readValue }; return value++; })()"
    ],
    ["primitive symbol hook", "", "+{ [Symbol.toPrimitive]: readValue }"],
    ["member key", "", "({ 4: 4, 12: 12 })[{ toString: readValue }]"],
    [
      "optional member key",
      "",
      "({ 4: 4, 12: 12 })?.[{ toString: readValue }]"
    ],
    ["object key", "", "4 in { [{ toString: readValue }]: true } ? 4 : 12"],
    ["method key", "", "4 in { [{ toString: readValue }]() {} } ? 4 : 12"]
  ])("defers imported operator coercion: %s", (_, declaration, argument) => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {readValue, hookKey} from "./runtime.js";
      import * as runtime from "./runtime.js";
      ${declaration}
      export const Box = () => <div css={recipe({size: ${argument}})} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { recipe },
      "./runtime.js": { readValue, hookKey: "valueOf" }
    };
    const sidecar = executeModule(result[1], modules);

    expect(readValue).not.toHaveBeenCalled();
    const module = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = module.Box as () => { props: { className: string } };
    expect(Box().props.className).toBe(recipe({ size: 4 }));
    expect(Box().props.className).toBe(recipe({ size: 12 }));
    expect(readValue).toHaveBeenCalledTimes(2);
    expect(result[1]).not.toContain("./runtime.js");
  });

  it.each([
    "+size",
    "`${size}`",
    "+{ get valueOf() { return () => 4; } }",
    '+{ ["valueOf"]: () => 4 }',
    '+{ ["harmless"]: readValue, valueOf() { return 4; } }',
    "!!{ valueOf: readValue } ? size : 12",
    "false ? +{ valueOf: readValue } : size"
  ])("keeps non-callback operator coercion static: %s", (argument) => {
    const recipe = rules({ variants: { size: { 4: { padding: 4 } } } });
    const readValue = vi.fn(() => {
      throw new Error("Non-coercing operand invoked its callback");
    });
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {size, readValue} from "./values.js";
      export const Box = () => <div css={recipe({size: ${argument}})} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    expect(
      executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./values.js": { size: 4, readValue }
      })
    ).toEqual([recipe({ size: 4 })]);
    expect(readValue).not.toHaveBeenCalled();
    expect(code).not.toContain("recipe(");
  });

  it("preserves ordinary in lookup without a coercion callback", () => {
    const recipe = rules({ variants: { size: { 4: { padding: 4 } } } });
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {size} from "./values.js";
      export const Box = () => <div css={recipe({
        size: "size" in { size: 4 } ? size : 12
      })} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { recipe },
      "./values.js": { size: 4 }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => { props: { className: string } };
    expect(Box().props.className).toBe(recipe({ size: 4 }));
  });

  it.each([
    "const { size = readSize() } = {};",
    'const { "01": size = readSize() } = [4, 8];',
    "const { __proto__: size = readSize() } = { __proto__: null };",
    "const [size = readSize()] = [];",
    "const { values: [size = readSize()] = [] } = {};",
    "const [{ size = readSize() } = {}] = [];",
    "const fallback = readSize(); const { value: size = fallback } = {};",
    "const { size = readSize() } = { size: undefined };",
    "const [, size = readSize()] = [...[], 4];",
    "const { size = readSize() } = { size: 4, ...{ size: undefined } };",
    "const values = { size: 4 }; values.size = undefined; const { size = readSize() } = values;",
    "const { values: [size = readSize()] = [4] } = { ...{ values: [] } };",
    "const undefined = []; const { values: [size = readSize()] = [4] } = { values: undefined };",
    "const remaining = []; const [[size = readSize()] = [4]] = [[], ...remaining];",
    "const { values: [size = readSize()] = [4] } = { __proto__: { values: [] } };"
  ])(
    "keeps destructuring defaults in runtime recipe selection: %s",
    (declaration) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readSize = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      import {readSize} from "./runtime.js";
      export const Box = () => {
        ${declaration}
        return <div css={recipe({size})} />;
      };
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readSize }
      });

      expect(readSize).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("./runtime.js");

      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./runtime.js": { readSize },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 4 }));
      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(readSize).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    ["const { size = readSize() } = { size: 4 };", 4],
    ['const { "1": size = window.innerWidth } = [4, 8];', 8],
    [
      'const { __proto__: size = window.innerWidth } = { ["__proto__"]: 4 };',
      4
    ],
    ["const __proto__ = 4; const { __proto__: size = 12 } = { __proto__ };", 4],
    ["const [size = readSize()] = [4];", 4],
    [
      "const { values: [size = readSize()] = readSize() } = { values: [4] };",
      4
    ],
    ["const [{ size = readSize() } = readSize()] = [{ size: 4 }];", 4],
    ["const { value: size = readSize() } = { value: 4 };", 4],
    ["const { size = readSize() } = { size: 4 } as const;", 4],
    ["const { size = readSize() } = { size: 0 };", 0],
    ["const { size = readSize() } = { size: false };", false],
    ["const { size = readSize() } = { size: null };", null],
    ["const { size = window.innerWidth } = { size: 4 };", 4],
    ["const [size = window.innerWidth] = [4];", 4],
    [
      "const { values: [size = window.innerWidth] = document.values } = { values: [4] };",
      4
    ],
    [
      "const [{ size = window.innerWidth } = document.values] = [{ size: 4 }];",
      4
    ],
    ["const { size = window.innerWidth } = { size: 0 } as const;", 0],
    ["const { values: [size = readSize()] = [4] } = {};", 4],
    ["const [{ size = readSize() } = { size: 4 }] = [];", 4],
    ["const { values: { sizes: [size = readSize()] = [4] } = {} } = {};", 4],
    ["const { values: [size = readSize()] = [4] } = { values: undefined };", 4],
    ["const { values: [size = readSize()] = [4] } = { values: void 0 };", 4]
  ])(
    "ignores unexecuted destructuring defaults in static factories: %s",
    (declaration, expected) => {
      const getStyles = vi.fn((_size: unknown) => ({ padding: 4 }));
      const readSize = vi.fn(() => 12);
      const { code, result } = babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      import { readSize } from "./runtime.js";
      export const Box = () => {
        ${declaration}
        return <div css={getStyles(size)} />;
      };
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { getStyles },
        "./runtime.js": { readSize }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./runtime.js": { readSize },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(getStyles).toHaveBeenCalledExactlyOnceWith(expected);
      expect(Box().props.className).toBe(Box().props.className);
      expect(readSize).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("__recipe__");
    }
  );

  it.each([
    "const { size = 4 } = {};",
    "const [size = 2 + 2] = [];",
    "const { values: [size = 4] = [] } = {};",
    "const [{ size = 4 } = {}] = [];",
    "const { size = (0, 4) } = {};",
    "const { size = Math.max(2, 4) } = {};"
  ])(
    "keeps confident destructuring defaults on the static recipe path: %s",
    (declaration) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      export const Box = () => {
        ${declaration}
        return <div css={recipe({size})} />;
      };
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 4 }));
      expect(result[1]).not.toContain("__recipe__");
    }
  );

  it.each([
    ["const { size } = { size: spacing };", 4],
    ["const { values: { size } } = { values: { size: spacing } };", 4],
    ["const [{ size }] = [{ size: spacing }];", 4],
    [
      "const { values: { size } = spacing } = { values: { size: spacing } };",
      4
    ],
    ["const { size = spacing } = {};", 4],
    ["const { size = spacing * 2 } = {};", 8],
    ["const [size = spacing + spacing] = [];", 8],
    ["const { [spacing * 2]: size } = { 8: 8 };", 8],
    [
      "const { a, [spacing * 2]: ignored, a: { x: size = fallback() } } = { a: { x: 4 } };",
      4
    ],
    ["const { size = false ? missing() : spacing * 2 } = {};", 8],
    ["const { size = 4 || missing() } = {};", 4],
    ["const { size = (false ? window.innerWidth : 4) as number } = {};", 4],
    ["const { size = (4 || window.innerWidth) satisfies number } = {};", 4],
    ["const { size = (false ? window.innerWidth : 4)! } = {};", 4],
    ["const size = false ? missing() : spacing * 2;", 8]
  ])(
    "keeps imported constant pattern expressions on the static factory path: %s",
    (declaration, expected) => {
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const source = `
      import { getStyles } from "./theme.css.js";
      import { spacing } from "./tokens.js";
      export const Box = () => {
        ${declaration}
        return <div css={getStyles(size)} />;
      };
    `;
      const prepared = declaration.includes("[spacing * 2]")
        ? prepareModuleSourceFixture(
            source,
            { "./tokens.js": "export const spacing = 4;" },
            { "custom-preset": ["css"] },
            true
          )
        : undefined;
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false },
        preparedExtractCalls: prepared
      });
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { getStyles },
        "./tokens.js": { spacing: 4 }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./tokens.js": { spacing: 4 },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(getStyles).toHaveBeenCalledExactlyOnceWith(expected);
      expect(Box().props.className).toEqual(expect.any(String));
      expect(result[1]).not.toContain("__recipe__");
    }
  );

  it.each([undefined, "export const spacing = { unit: 4 };"])(
    "does not capture computed-key declarations without primitive token proof: %s",
    (tokens) => {
      const source = `
        import { getStyles } from "./theme.css.js";
        import { spacing } from "./tokens.js";
        export const Box = () => {
          const { [spacing * 2]: size } = { 8: 8 };
          return <div css={getStyles(size)} />;
        };
      `;
      const prepared =
        tokens === undefined
          ? undefined
          : prepareModuleSourceFixture(
              source,
              { "./tokens.js": tokens },
              { "custom-preset": ["css"] },
              true
            );
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false },
        preparedExtractCalls: prepared
      });
      expect(code).toContain("[spacing * 2]");
      expect(result[1]).not.toContain("[spacing * 2]");
      const getStyles = vi.fn();
      expect(() =>
        executeModule(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css },
          "./theme.css.js": { getStyles },
          "./tokens.js": { spacing: 4 }
        })
      ).toThrow("Use static token values for style factories");
      expect(getStyles).not.toHaveBeenCalled();
    }
  );

  it.each([
    "const { size = spacing } = {};",
    "const { [spacing * 2]: size } = { 8: 4 };",
    "const size = spacing;"
  ])(
    "resolves static factory declarations before consumer shadowing: %s",
    (declaration) => {
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const source = `
        import { getStyles } from "./theme.css.js";
        import { spacing } from "./tokens.js";
        ${declaration}
        export const Box = ({ spacing }) => <div css={getStyles(size)} />;
      `;
      const prepared = declaration.includes("[spacing * 2]")
        ? prepareModuleSourceFixture(
            source,
            { "./tokens.js": "export const spacing = 4;" },
            { "custom-preset": ["css"] },
            true
          )
        : undefined;
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false },
        preparedExtractCalls: prepared
      });
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { getStyles },
        "./tokens.js": { spacing: 4 }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./tokens.js": { spacing: 4 },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as (props: { spacing: number }) => {
        props: { className: string };
      };

      expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      expect(Box({ spacing: 100 }).props.className).toEqual(expect.any(String));
      expect(Box({ spacing: 100 }).props.className).toBe(
        Box({ spacing: 200 }).props.className
      );
      expect(result[1]).not.toContain("__recipe__");
    }
  );

  it.each([
    ["const { size = (readSize(), 4) } = {};", 4],
    ["const [size = void readSize()] = [];", undefined],
    ["const { [(readSize(), 'value')]: size } = { value: 4 };", 4],
    ["const size = (readSize(), 4);", 4],
    ["const size = void readSize();", undefined],
    ["const { size = Math.max((readSize(), 2), 4) } = {};", 4],
    ["const { size = (readSize(), false) ? 8 : 4 } = {};", 4],
    ["const { size = (readSize(), 4) || 8 } = {};", 4]
  ] as const)(
    "preserves executed calls hidden by confident evaluation: %s",
    (declaration, expected) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 } } },
        defaultVariants: { size: 4 }
      });
      const readSize = vi.fn();
      const { code, result } = babelTransform(
        `
      import { recipe } from "./theme.css.js";
      import { readSize } from "./runtime.js";
      export const Box = () => {
        ${declaration}
        return <div css={recipe({ size })} />;
      };
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readSize }
      });

      expect(readSize).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("./runtime.js");

      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./runtime.js": { readSize },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: expected }));
      expect(Box().props.className).toBe(recipe({ size: expected }));
      expect(readSize).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    "const { [readKey()]: size } = { small: 4, large: 12 };",
    "const key = { toString: readKey }; const { [key]: size } = { small: 4, large: 12 };",
    "const key = { __proto__: { toString: readKey } }; const { [key]: size } = { small: 4, large: 12 };",

    "const { values: { [readKey()]: size } } = { values: { small: 4, large: 12 } };"
  ])("keeps computed destructuring keys at runtime: %s", (declaration) => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const readKey = vi
      .fn()
      .mockReturnValueOnce("small")
      .mockReturnValueOnce("large");
    const { code, result } = babelTransform(
      `
      import { recipe } from "./theme.css.js";
      import { readKey } from "./runtime.js";
      export const Box = () => {
        ${declaration}
        return <div css={recipe({ size })} />;
      };
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { recipe },
      "./runtime.js": { readKey }
    });

    expect(readKey).not.toHaveBeenCalled();

    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      "./runtime.js": { readKey },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as () => { props: { className: string } };

    expect(Box().props.className).toBe(recipe({ size: 4 }));
    expect(Box().props.className).toBe(recipe({ size: 12 }));
    expect(readKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["named", "", "[0].map(readValue)[0]"],
    ["namespace member", "", "[0].map(runtime.readValue)[0]"],
    ["local alias", "const read = readValue;", "[0].map(read)[0]"],
    ["member alias", "const read = runtime.readValue;", "[0].map(read)[0]"],
    [
      "namespace alias",
      "const source = runtime;",
      "[0].map(source.readValue)[0]"
    ],
    [
      "destructured alias",
      "const {readValue: read} = runtime;",
      "[0].map(read)[0]"
    ],
    [
      "type assertion",
      "",
      "[0].map(readValue as (value: number) => number)[0]"
    ],
    ["optional map", "", "[0].map?.(readValue)[0]"],
    ["computed map", "", '[0]["map"](readValue)[0]'],
    ["reduce callback", "", "[0].reduce(readValue, 0)"],
    ["Array.from mapper", "", "Array.from([0], readValue)[0]"],
    ["String.replace callback", "", '"x".replace(/x/, readValue)'],
    [
      "local higher-order function",
      "function invoke(callback) { return callback(0); }",
      "invoke(readValue)"
    ],
    [
      "shadowed Math function",
      "const Math = { max: (callback) => callback(0) };",
      "Math.max(readValue)"
    ],
    [
      "custom includes function",
      "const values = { includes: (callback) => callback(0) };",
      "values.includes(readValue)"
    ],
    [
      "object callback argument",
      "function invoke(callbacks) { return callbacks.readValue(0); }",
      "invoke({ readValue })"
    ],
    [
      "array callback argument",
      "function invoke(callbacks) { return callbacks[0](0); }",
      "invoke([readValue])"
    ],
    [
      "aliased callback container",
      "const callbacks = { readValue }; function invoke(callbacks) { return callbacks.readValue(0); }",
      "invoke(callbacks)"
    ],
    ["optional namespace member", "", "[0].map(runtime?.readValue)[0]"],
    ["spread callback argument", "", "[0].map(...[readValue])[0]"],
    [
      "shared container after data intrinsic",
      "const callbacks = [readValue]; function invoke(callbacks) { return callbacks[0](0); }",
      "([0].includes(callbacks), invoke(callbacks))"
    ],
    [
      "shared container after Math intrinsic",
      "const holder = { readValue }; function invoke(callbacks) { return callbacks.readValue(0); }",
      "(Math.max(holder.missing ?? 0), invoke(holder))"
    ],
    [
      "callback returning imported function",
      "function invoke(getReader) { return getReader()(0); }",
      "invoke(() => readValue)"
    ]
  ])(
    "preserves imported callbacks in recipe arguments: %s",
    (_, declaration, value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
        import {recipe} from "./theme.css.js";
        import {readValue} from "./runtime.js";
        import * as runtime from "./runtime.js";
        ${declaration}
        export const Box = () => <div css={recipe({size: ${value}})} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readValue }
      };
      const sidecar = executeModule(result[1], modules);
      expect(readValue).not.toHaveBeenCalled();

      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 4 }));
      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(readValue).toHaveBeenCalledTimes(2);
      expect(result[1]).not.toContain("./runtime.js");
    }
  );

  it.each([
    ["named getter", "", "state.size"],
    ["namespace getter", "", "runtime.state.size"],
    ["optional getter", "", "state?.size"],
    ["aliased getter", "const read = () => state.size;", "read()"],
    ["array-held getter", "const values = [state];", "values[0].size"],
    ["object-held getter", "const box = {value:state};", "box.value.size"],
    [
      "inherited getter",
      "const inherited = { __proto__: state };",
      "inherited.size"
    ],
    [
      "string prototype setter",
      'const inherited = { "__proto__": state };',
      "inherited.size"
    ],
    [
      "nested inherited getter",
      "const base = { __proto__: state }; const inherited = { __proto__: base };",
      "inherited.size"
    ],
    ["returned owner", "const owner = () => state;", "owner().size"]
  ])("preserves imported recipe member reads: %s", (_, declaration, value) => {
    const recipe = rules({
      variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
    });
    const read = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
    const state = {
      get size() {
        return read();
      }
    };
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {state} from "./state.js";
      import * as runtime from "./state.js";
      ${declaration}
      export const Box = () => <div css={recipe({size: ${value}})} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { recipe },
      "./state.js": { state }
    };
    const sidecar = executeModule(result[1], modules);
    expect(read).not.toHaveBeenCalled();
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => { props: { className: string } };
    expect(Box().props.className).toBe(recipe({ size: 4 }));
    expect(Box().props.className).toBe(recipe({ size: 12 }));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["object spread", "", "{ ...state }"],
    [
      "helper parameter default",
      "function read({ size } = state) { return size; }",
      "{ size: read() }"
    ],
    [
      "helper nested parameter default",
      "function read({ values: { size } = state } = {}) { return size; }",
      "{ size: read() }"
    ],
    [
      "helper array parameter default",
      "function read([size] = state) { return size; }",
      "{ size: read() }"
    ],

    ["spread alias", "const owner = state;", "{ ...owner }"],
    ["spread held value", "const box = { owner: state };", "{ ...box.owner }"],
    ["object pattern", "const { size } = state;", "{ size }"],
    [
      "deleted own shadow",
      "const holder = { __proto__: state, size: 0 }; delete holder.size; const { size } = holder;",
      "{ size }"
    ],
    [
      "inherited object pattern",
      "const { size } = { __proto__: state };",
      "{ size }"
    ],
    [
      "pattern alias",
      "const owner = state; const { size } = owner;",
      "{ size }"
    ],
    [
      "nested pattern",
      "const { owner: { size } } = { owner: state };",
      "{ size }"
    ],
    ["array-held pattern", "const [{ size }] = [state];", "{ size }"],
    ["rest pattern", "const { ...value } = state;", "value"],
    ["defaulted pattern", "const { size = 0 } = state;", "{ size }"],
    ["nested default", "const { values: { size } = state } = {};", "{ size }"],
    ["array pattern", "const [size] = state;", "{ size }"],
    ["array spread", "", "{ size: [...state][0] }"]
  ])(
    "preserves implicit imported recipe reads: %s",
    (_, declaration, value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const read = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const state = {
        get size() {
          return read();
        },
        *[Symbol.iterator]() {
          yield read();
        }
      };
      const { code, result } = babelTransform(
        `import { recipe } from "./theme.css.js";
       import { state } from "./state.js";
       export const Box = () => {
         ${declaration}
         return <div css={recipe(${value})} />;
       };`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./state.js": { state }
      };
      const sidecar = executeModule(result[1], modules);
      expect(read).not.toHaveBeenCalled();

      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect(Box().props.className).toBe(recipe({ size: 4 }));
      expect(Box().props.className).toBe(recipe({ size: 12 }));
      expect(read).toHaveBeenCalledTimes(2);
      expect(result[1]).not.toContain("./state.js");
    }
  );

  it.each([
    "const holder = { __proto__: state, size: 4 };",
    "const holder = { size: 4, __proto__: state };",
    'const holder = { __proto__: state, ["size"]: 4 };',
    "const holder = { __proto__: state, ...{ size: 4 } };",
    "const holder = { __proto__: { __proto__: state, size: 4 } };"
  ])(
    "keeps own properties ahead of imported prototype getters: %s",
    (declaration) => {
      const read = vi.fn(() => 12);
      const state = {
        get size() {
          return read();
        }
      };
      const getStyles = vi.fn((size: number) => ({ padding: size }));
      const { code, result } = babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      import { state } from "./state.js";
      ${declaration}
      export const Box = () => <div css={getStyles(holder.size)} />;
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { getStyles },
        "./state.js": { state }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };
      expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      expect(Box().props.className).toBe(Box().props.className);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each([
    "size",
    "[size].map(value => value)[0]",
    "false ? [0].map(readValue)[0] : size",
    "[size].includes(4) ? size : 12",
    "[4].includes(size) ? size : 12"
  ])("keeps imported data in static recipe arguments: %s", (value) => {
    const recipe = rules({ variants: { size: { 4: { padding: 4 } } } });
    const readValue = vi.fn(() => {
      throw new Error("Unreachable callback was executed");
    });
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      import {size, readValue} from "./values.js";
      export const Box = () => <div css={recipe({size: ${value}})} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const values = executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { recipe },
      "./values.js": { size: 4, readValue }
    });

    expect(values).toEqual([recipe({ size: 4 })]);
    expect(readValue).not.toHaveBeenCalled();
    expect(code).not.toContain("recipe(");
  });

  it.each([
    ["named call", "readValue()"],
    ["namespace call", "runtime.readValue()"],
    ["optional call", "readValue?.()"],
    ["unbound call", "(0, readValue)()"],
    ["CommonJS call", 'require("./runtime.js").readValue()'],
    ["wrapped call", "(readValue() as number)"],
    ["conditional call", "true ? readValue() : 4"],
    ["logical and call", "true && readValue()"],
    ["logical or call", "false || readValue()"],
    ["nullish call", "null ?? readValue()"],
    ["callback call", "[0].map(() => readValue())[0]"],
    ["constructor call", "new runtime.RuntimeValue().value"]
  ])(
    "evaluates nested imported recipe arguments on each render: %s",
    (_, value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      import * as runtime from "./runtime.js";
      export const Box = () => <div css={recipe({size: ${value}})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": {
          readValue,
          RuntimeValue: class {
            value = readValue();
          }
        }
      };
      const sidecar = executeModule(result[1], modules);
      const callsBeforeRender = readValue.mock.calls.length;
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect([Box().props.className, Box().props.className]).toEqual([
        recipe({ size: 4 }),
        recipe({ size: 12 })
      ]);
      expect(callsBeforeRender).toBe(0);
      expect(readValue).toHaveBeenCalledTimes(2);
      expect(result[1]).not.toContain("./runtime.js");
      expect(code).not.toContain("__recipe__");
    }
  );

  it.each([
    ["const read = () => readValue();", "read()"],
    ["const read = function () { return readValue(); };", "read()"],
    ["function read() { return readValue(); }", "read()"],
    ["const source = () => readValue(); const read = source;", "read()"],
    [
      "const source = () => readValue(); const read = () => source();",
      "read()"
    ],
    ["const read = () => readValue();", "read?.()"],
    ["const read = () => readValue();", "[0].map(read)[0]"],
    ["const helpers = {read: () => readValue()};", "helpers.read()"],
    ["const helpers = {read() { return readValue(); }};", "helpers.read()"],
    [
      "const helpers = {nested: {read: () => readValue()}};",
      "helpers.nested.read()"
    ],
    [
      "const helpers = {read: () => readValue()}; const alias = helpers;",
      "alias.read()"
    ]
  ])(
    "preserves imported calls through local helpers: %s",
    (declaration, value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const readValue = vi.fn().mockReturnValueOnce(4).mockReturnValueOnce(12);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      ${declaration}
      export const Box = () => <div css={recipe({size: ${value}})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./runtime.js": { readValue }
      };
      const sidecar = executeModule(result[1], modules);
      const callsBeforeRender = readValue.mock.calls.length;
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } };

      expect([Box().props.className, Box().props.className]).toEqual([
        recipe({ size: 4 }),
        recipe({ size: 12 })
      ]);
      expect(callsBeforeRender).toBe(0);
      expect(readValue).toHaveBeenCalledTimes(2);
      expect(result[1]).not.toContain("./runtime.js");
      expect(code).not.toContain("__recipe__");
    }
  );

  it.each([
    "const read = () => 4;",
    "function read(depth = 0) { return depth ? 4 : read(1); }",
    "const helpers = {read: () => 4}; const read = () => helpers.read();",
    "const helpers = {read() { return 4; }}; const read = () => helpers.read();"
  ])(
    "still hoists a local helper with literal arguments: %s",
    (declaration) => {
      const recipe = rules({ variants: { size: { 4: { padding: 4 } } } });
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      import {readValue} from "./runtime.js";
      const unrelated = () => readValue();
      ${declaration}
      export const Box = () => <div css={recipe({size: read()})} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe }
      });

      expect(values).toEqual([recipe({ size: 4 })]);
      expect(code).not.toContain("recipe(");
      expect(result[1]).not.toContain("./runtime.js");
    }
  );

  it.each(["4", "size"])(
    "still hoists literal and identifier recipe arguments: %s",
    (value) => {
      const recipe = rules({
        variants: { size: { 4: { padding: 4 }, 12: { padding: 12 } } }
      });
      const { code, result } = babelTransform(
        `
        import {recipe} from "./theme.css.js";
        import {size} from "./values.js";
        export const Box = () => <div css={recipe({size: ${value}})} />;
        `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css },
        "./theme.css.js": { recipe },
        "./values.js": { size: 4 }
      });

      expect(values).toEqual([recipe({ size: 4 })]);
      expect(code).not.toContain("recipe(");
    }
  );

  it("preserves static helper values used outside the css prop", () => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      const selected = getStyles();
      export const Box = () => <div css={selected} style={selected} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => {
      props: { style: unknown; className: string };
    };
    const rendered = Box();

    expect(rendered.props.style).toBe(style);
    expect(rendered.props.className).toEqual(expect.any(String));
    expect(getStyles).toHaveBeenCalledTimes(2);
  });

  it("keeps mixed static factory/object branches on the existing authoring path", () => {
    const configuredCss = vi.fn(css);
    const getStyles = vi.fn(() => ({ padding: 12 }));
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = ({active}) => <div css={active ? getStyles() : {padding: 4}} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const values = executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css: configuredCss },
      "./theme.css.js": { getStyles }
    });

    expect(getStyles).toHaveBeenCalledOnce();
    expect(configuredCss).toHaveBeenCalledWith({ padding: 12 });
    expect(configuredCss).toHaveBeenCalledWith({ padding: 4 });
    expect(new Set(values).size).toBe(2);
    expect(code).toContain("active ?");
  });

  describe("mixed style fallback safety", () => {
    it.each([
      ["random call", "", "Math.round(Math.random())"],
      ["random alias", "const sample = Math.random;", "Math.round(sample())"],
      ["imported call", "", "readSize()"],
      ["local wrapper", "const read = () => readSize();", "read()"],
      [
        "object helper",
        "const helper = { read: () => readSize() };",
        "helper.read()"
      ]
    ])(
      "rejects render-time values in mixed style fallbacks: %s",
      (_name, declaration, padding) => {
        expect(() =>
          babelTransform(
            `
          import { recipe } from "./theme.css.js";
          import { readSize } from "./runtime.js";
          export const Box = ({ active }) => {
            ${declaration}
            return <div css={active ? recipe() : { padding: ${padding} }} />;
          };
          `,
            { jsxCssProp, optimize: { pureFunctions: false } }
          )
        ).toThrow(
          "Mixed JSX css prop style branches require static token values"
        );
      }
    );

    it.each([
      [
        "property write",
        "const input = { padding: 4 }; input.padding = 12;",
        "input.padding"
      ],
      [
        "alias write",
        "const input = { padding: 4 }; const alias = input; alias.padding = 12;",
        "input.padding"
      ],
      [
        "nested alias write",
        "const input = { style: { padding: 4 } }; const alias = input.style; alias.padding = 12;",
        "input.style.padding"
      ],
      [
        "known mutator",
        "const input = { padding: 4 }; Object.assign(input, { padding: 12 });",
        "input.padding"
      ],
      [
        "opaque consumer",
        "const input = { padding: 4 }; const update = value => { value.padding = 12; }; update(input);",
        "input.padding"
      ],
      [
        "local function",
        "const input = { padding: 4 }; input.padding = 12; function read() { return input.padding; }",
        "read()"
      ]
    ])(
      "rejects changed input in mixed style fallbacks: %s",
      (_name, declaration, padding) => {
        expect(() =>
          babelTransform(
            `
          import { recipe } from "./theme.css.js";
          export const Box = ({ active }) => {
            ${declaration}
            return <div css={active ? recipe() : { padding: ${padding} }} />;
          };
          `,
            { jsxCssProp, optimize: { pureFunctions: false } }
          )
        ).toThrow(
          "Mixed JSX css prop style branches require static token values"
        );
      }
    );

    it.each(["Math.random()", "input.padding"])(
      "rejects shared mixed style fallback aliases: %s",
      (padding) => {
        expect(() =>
          babelTransform(
            `
            import { recipe } from "./theme.css.js";
            export const Box = ({ active }) => {
              const input = { padding: 4 };
              input.padding = 12;
              const fallback = [{ padding: ${padding} }];
              const selected = active ? recipe() : fallback;
              const alias = selected;
              return { value: selected, element: <div css={alias} /> };
            };
            `,
            { jsxCssProp, optimize: { pureFunctions: false } }
          )
        ).toThrow(
          "Mixed JSX css prop style branches require static token values"
        );
      }
    );

    it.each([
      ["deterministic call", "", "Math.max(4, 12)", 12],
      [
        "unchanged property",
        "const input = { padding: 4 };",
        "input.padding",
        4
      ],
      [
        "readonly local function",
        "const input = { padding: 4 }; function read() { return input.padding; }",
        "read()",
        4
      ],
      [
        "independent copy",
        "const input = { padding: 4 }; const copy = { ...input }; copy.padding = 12;",
        "input.padding",
        4
      ],
      ["unreachable runtime call", "", "false ? Math.random() : 4", 4],
      [
        "unreachable changed input",
        "const input = { padding: 4 }; input.padding = 12;",
        "false ? input.padding : 4",
        4
      ]
    ] as const)(
      "preserves safe mixed style fallbacks: %s",
      (_name, declaration, padding, expected) => {
        const definition = defineRules({ properties: { padding: [4, 12] } });
        const recipe = definition.rules({ base: { padding: 12 } });
        const configuredCss = vi.fn(definition.css);
        const { code, result } = babelTransform(
          `
        import { recipe } from "./theme.css.js";
        export const Box = ({ active }) => {
          ${declaration}
          return <div css={active ? recipe() : { padding: ${padding} }} />;
        };
        `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        );
        const sidecar = executeModule(result[1], {
          "@mincho-js/css": { mincho$ },
          "custom-preset": { css: configuredCss },
          "./theme.css.js": { recipe }
        });
        const runtime = executeModule(code, {
          "@mincho-js/css/classname": { cx },
          [result[0]]: sidecar
        });
        const Box = runtime.Box as (props: { active: boolean }) => {
          props: { className: string };
        };

        expect(configuredCss).toHaveBeenCalledExactlyOnceWith({
          padding: expected
        });
        expect(Box({ active: false }).props.className).toBe(
          definition.css({ padding: expected })
        );
        expect(Box({ active: true }).props.className).toBe(recipe());
        expect(code).not.toContain("custom-preset");
      }
    );
  });

  it.each([
    ["static recipe", "enabled() ? recipe() : {padding: 4}"],
    ["reversed recipe", "enabled() ? {padding: 4} : recipe()"],
    ["dynamic recipe", "enabled() ? recipe({tone}) : {padding: 4}"],
    [
      "nested style",
      'enabled() ? recipe() : tone === "wide" ? {padding: 12} : {padding: 4}'
    ]
  ])("preserves mixed %s and style branches", (kind, expression) => {
    const definition = defineRules({ properties: { padding: [4, 12] } });
    const recipe = definition.rules({
      variants: { tone: { wide: { padding: 12 }, narrow: { padding: 4 } } },
      defaultVariants: { tone: "wide" }
    });
    const configuredCss = vi.fn(definition.css);
    const { code, result } = babelTransform(
      `
      import {recipe} from "./theme.css.js";
      export const Box = ({enabled, tone}) => <div css={${expression}} />;
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const sidecar = executeModule(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css: configuredCss },
      "./theme.css.js": { recipe }
    });
    const runtime = executeModule(code, {
      "@mincho-js/css/classname": { cx },
      [result[0]]: sidecar
    });
    const Box = runtime.Box as (props: {
      enabled: () => boolean;
      tone: "wide" | "narrow";
    }) => { props: { className: string } };

    for (const active of [false, true]) {
      for (const tone of ["wide", "narrow"] as const) {
        const enabled = vi.fn(() => active);
        const recipeSelected = kind === "reversed recipe" ? !active : active;
        expect(Box({ enabled, tone }).props.className).toBe(
          recipeSelected
            ? recipe(kind === "dynamic recipe" ? { tone } : undefined)
            : definition.css({
                padding: kind === "nested style" && tone === "wide" ? 12 : 4
              })
        );
        expect(enabled).toHaveBeenCalledOnce();
      }
    }

    expect(configuredCss.mock.calls).toEqual(
      kind === "nested style"
        ? [[{ padding: 12 }], [{ padding: 4 }]]
        : [[{ padding: 4 }]]
    );
    expect(code).not.toContain("custom-preset");
    expect(result[1]).not.toContain("enabled()");
  });

  it.each([
    ["literal", "{padding: 4}"],
    ["nested", 'tone === "wide" ? {padding: 4} : {padding: 12}']
  ])(
    "preserves shared mixed recipe/%s aliases and condition evaluation",
    (kind, fallback) => {
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const recipe = definition.rules({
        variants: { tone: { wide: { padding: 12 }, narrow: { padding: 4 } } }
      });
      const configuredCss = vi.fn(definition.css);
      const source = `
      import {recipe} from "./theme.css.js";
      export const Box = ({enabled, tone}) => {
        const fallback = ${fallback};
        const selected = enabled() ? recipe({tone}) : fallback;
        const alias = selected;
        return {
          value: selected,
          first: <div css={alias} />,
          second: <div css={alias} />
        };
      };
    `;
      const { code, result } = babelTransform(
        source,
        {
          jsxCssProp,
          optimize: { pureFunctions: false },
          preparedExtractCalls: prepareSerializedRecipeProvider(source, {
            recipe
          })
        },
        { filename: "/fixture/entry.tsx", root: "/fixture" }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        "./theme.css.js": { recipe },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as (props: {
        enabled: () => boolean;
        tone: "wide" | "narrow";
      }) => {
        value: unknown;
        first: { props: { className: string } };
        second: { props: { className: string } };
      };

      for (const active of [true, false, true]) {
        const enabled = vi.fn(() => active);
        const rendered = Box({ enabled, tone: "wide" });
        const selectedClass = active
          ? recipe({ tone: "wide" })
          : definition.css({ padding: 4 });
        expect(rendered.value).toEqual(
          active ? recipe({ tone: "wide" }) : { padding: 4 }
        );
        expect(rendered.first.props.className).toBe(selectedClass);
        expect(rendered.second.props.className).toBe(selectedClass);
        expect(enabled).toHaveBeenCalledOnce();
      }

      expect(configuredCss.mock.calls).toEqual(
        kind === "nested"
          ? [[{ padding: 4 }], [{ padding: 12 }]]
          : [[{ padding: 4 }]]
      );
      expect(code).not.toContain("custom-preset");
    }
  );

  it.each([
    ["direct", "getStyles()"],
    ["ternary", "enabled() ? getStyles() : false"],
    ["logical", "enabled() && getStyles()"]
  ])(
    "preserves shared %s helper aliases and runtime evaluation counts",
    (kind, initializer) => {
      const style = { padding: 12 };
      const getStyles = vi.fn(() => style);
      const enabled = vi.fn(() => true);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      export const Box = ({enabled}) => {
        const selected = ${initializer};
        const copy = selected;
        const alias = copy && (copy ? copy : false);
        return {
          first: <div css={selected} style={selected} />,
          second: <span css={alias} data-value={alias} />,
          value: selected
        };
      };
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      getStyles.mockClear();
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (props: { enabled: () => boolean }) => {
        first: { props: { style: unknown; className: string } };
        second: { props: { "data-value": unknown; className: string } };
        value: unknown;
      };
      const rendered = Box({ enabled });

      expect(rendered.value).toBe(style);
      expect(rendered.first.props.style).toBe(style);
      expect(rendered.second.props["data-value"]).toBe(style);
      expect(rendered.first.props.className).toEqual(expect.any(String));
      expect(rendered.second.props.className).toEqual(expect.any(String));
      expect(getStyles).toHaveBeenCalledOnce();
      expect(enabled).toHaveBeenCalledTimes(kind === "direct" ? 0 : 1);

      if (kind !== "direct") {
        enabled.mockClear().mockReturnValue(false);
        getStyles.mockClear();
        const disabled = Box({ enabled });
        expect(disabled.value).toBe(false);
        expect(disabled.first.props.style).toBe(false);
        expect(disabled.second.props["data-value"]).toBe(false);
        expect(disabled.first.props.className).toBe("");
        expect(disabled.second.props.className).toBe("");
        expect(getStyles).not.toHaveBeenCalled();
        expect(enabled).toHaveBeenCalledOnce();
      }
    }
  );

  it.each([
    ["ternary", 'active ? cx("base") : false'],
    ["logical", 'active && cx("base")'],
    ["namespace", 'active ? preset.cx("base") : false']
  ])(
    "reuses an ordinary configured cx result from a %s initializer",
    (kind, initializer) => {
      const namespace = kind === "namespace";
      for (const shared of [false, true]) {
        const source = `
        import ${namespace ? "* as preset" : "{ cx }"} from "custom-preset";
        export function Box(active) {
          const selected = ${initializer};
          return {
            ${shared ? "selected," : ""}
            first: <div css={selected} />${shared ? ", second: <span css={selected} />" : ""}
          };
        }
      `;
        const { code, result } = babelTransform(source, { jsxCssProp });
        let count = 0;
        const configuredCx = vi.fn(function (
          this: { prefix: string } | undefined,
          value: string
        ) {
          return (namespace ? this?.prefix : value) + "-" + ++count;
        });
        const modules = {
          "custom-preset": { css, cx: configuredCx, prefix: "base" },
          "@mincho-js/css/classname": { cx },
          "@mincho-js/css": { mincho$ }
        };
        const sidecar = executeModule(result[1], modules);
        const runtime = executeModule(code, {
          ...modules,
          [result[0]]: sidecar
        });
        const Box = runtime.Box as (active: boolean) => {
          selected?: string | false;
          first: { props: { className: string } };
          second?: { props: { className: string } };
        };

        for (const [active, selected] of [
          [true, "base-1"],
          [false, false],
          [true, "base-2"]
        ] as const) {
          configuredCx.mockClear();
          const rendered = Box(active);
          expect(configuredCx.mock.calls).toEqual(active ? [["base"]] : []);
          expect(rendered.selected).toBe(shared ? selected : undefined);
          expect(rendered.first.props.className).toBe(selected || "");
          if (shared)
            expect(rendered.second?.props.className).toBe(selected || "");
        }
      }
    }
  );

  it.each([
    ["style", "default", false, false],
    ["empty style", "default", false, false],
    ["null", "default", false, false],
    ["null", "", true, false],
    ["false", "default", true, false],
    ["style", "default", false, true],
    ["empty style", "default", false, true],
    ["null", "default", false, true],
    ["null", "", true, true],
    ["false", "default", true, true]
  ] as const)(
    "preserves separate authored nullish and truthy scalar cx decisions: %s %s",
    (kind, defaultValue, usesFallback, dynamic) => {
      const { code, result } = babelTransform(
        `import {cx} from "custom-preset";
         import {getStyles} from "./theme.css.js";
         export function Box(base, fallback, readDefault) {
           return <div css={cx(base, (getStyles() ?? ${dynamic ? "readDefault()" : JSON.stringify(defaultValue)}) || fallback())} />;
         }`,
        { jsxCssProp }
      );
      const definition = defineRules({ properties: { padding: [12] } });
      const rule = kind === "style" ? { padding: 12 } : {};
      const getStyles = vi.fn(() =>
        kind === "null" ? null : kind === "false" ? false : rule
      );
      const configuredCss = vi.fn(definition.css);
      const configuredCx = vi.fn(cx);
      const modules = {
        "custom-preset": { cx: configuredCx, css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          base: string,
          fallback: () => string,
          readDefault: () => string
        ): { props: { className: string } };
      };
      const trace: string[] = [];
      const fallback = vi.fn(() => {
        trace.push("fallback");
        return "fallback";
      });
      const readDefault = vi.fn(() => {
        trace.push("default");
        return defaultValue;
      });
      const selected = usesFallback
        ? "fallback"
        : kind === "null"
          ? defaultValue
          : configuredCss.mock.results[0]?.value;
      if (kind === "style" || kind === "empty style") {
        expect(configuredCss).toHaveBeenCalledExactlyOnceWith(rule);
        if (kind === "empty style") expect(selected).toBe("");
        else expect(selected).toMatch(/\S/);
      } else expect(configuredCss).not.toHaveBeenCalled();

      for (const base of ["first", "second"]) {
        expect(Box(base, fallback, readDefault).props.className).toBe(
          cx(base, selected)
        );
        expect(trace.splice(0)).toEqual([
          ...(dynamic && kind === "null" ? ["default"] : []),
          ...(usesFallback ? ["fallback"] : [])
        ]);
      }
      expect(configuredCx.mock.calls).toEqual([
        ["first", selected],
        ["second", selected]
      ]);
      expect(fallback).toHaveBeenCalledTimes(usesFallback ? 2 : 0);
      expect(getStyles).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["default rule", null, { padding: 12 }, ["primary", "default"], false],
    ["defined primary", { padding: 12 }, { padding: 12 }, ["primary"], false],
    ["empty default", null, {}, ["primary", "default"], false],
    ["false default", null, false, ["primary", "default"], true]
  ] as const)(
    "compiles only the selected static nullish factory: %s",
    (_case, primary, otherwise, buildTrace, usesFallback) => {
      const { code, result } = babelTransform(
        `import {cx} from "custom-preset";
       import {getPrimary, getDefault} from "./theme.css.js";
       export function Box(base, fallback) {
         return <div css={cx(base, (getPrimary() ?? getDefault()) || fallback())} />;
       }`,
        { jsxCssProp }
      );
      const trace: string[] = [];
      const definition = defineRules({ properties: { padding: [12] } });
      const compiled = definition.css({ padding: 12 });
      const configuredCss = vi.fn(definition.css);
      const modules = {
        "custom-preset": { css: configuredCss, cx },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": {
          getPrimary: () => {
            trace.push("primary");
            return primary;
          },
          getDefault: () => {
            trace.push("default");
            return otherwise;
          }
        }
      };
      const sidecar = executeModule(result[1], modules);
      expect(trace.splice(0)).toEqual(buildTrace);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          base: string,
          fallback: () => string
        ): { props: { className: string } };
      };
      const fallback = vi.fn(() => "fallback");
      const selected = primary ?? otherwise;
      const expected = usesFallback
        ? "fallback"
        : selected && "padding" in selected
          ? compiled
          : "";
      for (const base of ["first", "second"])
        expect(Box(base, fallback).props.className).toBe(cx(base, expected));
      expect(trace).toEqual([]);
      expect(fallback).toHaveBeenCalledTimes(usesFallback ? 2 : 0);
      expect(configuredCss).toHaveBeenCalledTimes(usesFallback ? 0 : 1);
    }
  );

  it.each(["fixed", "runtime-falsy"] as const)(
    "only prepares a runtime cx OR factory when reachable: %s",
    (form) => {
      const left = form === "fixed" ? '"fixed"' : "base";
      const { code, result } = babelTransform(
        'import {cx} from "custom-preset"; import {getStyles} from "./theme.css.js"; export function Box(base) { return <div css={cx(base, ' +
          left +
          " || getStyles())} />; }",
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const definition = defineRules({ properties: { padding: [12] } });
      const compiled = definition.css({ padding: 12 });
      const getStyles = vi.fn(() => {
        if (form === "fixed") throw Error("unselected stylesheet fallback");
        return { padding: 12 };
      });
      const modules = {
        "custom-preset": { css: definition.css, cx },
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(base: string): { props: { className: string } };
      };
      if (form === "fixed") {
        expect(Box("base").props.className).toBe("base fixed");
        expect(getStyles).not.toHaveBeenCalled();
      } else {
        expect(Box("").props.className).toBe(compiled);
        expect(getStyles).toHaveBeenCalledOnce();
      }
    }
  );

  it.each([false, true])(
    "selects a single static factory for a bare runtime cx nullish default: primary=%s",
    (hasPrimary) => {
      const { code, result } = babelTransform(
        'import {cx} from "custom-preset"; import {getPrimary, getDefault} from "./theme.css.js"; export function Box(base) { return <div css={cx(base, getPrimary() ?? getDefault())} />; }',
        { jsxCssProp }
      );
      const trace: string[] = [];
      const definition = defineRules({ properties: { padding: [12] } });
      const expected = definition.css({ padding: 12 });
      const modules = {
        "custom-preset": { css: definition.css, cx },
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./theme.css.js": {
          getPrimary: () => {
            trace.push("primary");
            return hasPrimary ? { padding: 12 } : null;
          },
          getDefault: () => {
            trace.push("default");
            if (hasPrimary) throw new Error("unselected default");
            return { padding: 12 };
          }
        }
      };
      const sidecar = executeModule(result[1], modules);
      expect(trace.splice(0)).toEqual(
        hasPrimary ? ["primary"] : ["primary", "default"]
      );
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(base: string): { props: { className: string } };
      };
      for (const base of ["first", "second"])
        expect(Box(base).props.className).toBe(cx(base, expected));
      expect(trace).toEqual([]);
    }
  );

  it.each([
    ["||", "empty", false],
    ["||", "falsy", true],
    ["||", "nonempty", false],
    ["??", "falsy", false]
  ] as const)(
    "selects runtime cx %s branches by the authored %s factory value",
    (operator, kind, usesFallback) => {
      const { code, result } = babelTransform(
        `import { cx } from "custom-preset";
           import { getStyles } from "./theme.css.js";
           export function Box(base, fallback) {
             return <div css={cx(base, getStyles() ${operator} fallback())} />;
           }`,
        { jsxCssProp }
      );
      const definition = defineRules({ properties: { padding: [12] } });
      const rule = kind === "empty" ? {} : { padding: 12 };
      const getStyles = vi.fn(() => (kind === "falsy" ? false : rule));
      const configuredCss = vi.fn(definition.css);
      const configuredCx = vi.fn(cx);
      const modules = {
        "custom-preset": { cx: configuredCx, css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      expect(getStyles).toHaveBeenCalledOnce();
      expect(configuredCss.mock.calls).toEqual(
        kind === "falsy" ? [] : [[rule]]
      );
      const value = usesFallback
        ? "fallback"
        : kind === "falsy"
          ? false
          : configuredCss.mock.results[0]!.value;
      if (kind === "empty") expect(value).toBe("");
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          base: string,
          fallback: () => string
        ): { props: { className: string } };
      };
      const fallback = vi.fn(() => "fallback");
      expect(Box("base", fallback).props.className).toBe(cx("base", value));
      expect(configuredCx).toHaveBeenCalledExactlyOnceWith("base", value);
      expect(fallback).toHaveBeenCalledTimes(usesFallback ? 1 : 0);
      expect(getStyles).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["check() && getStyles()", true, "nonempty", false],
    ["check() && getStyles()", true, "empty", false],
    ["check() && getStyles()", true, "falsy", true],
    ["check() && getStyles()", false, "nonempty", true],
    ["check() && getStyles()", 0, "nonempty", true],
    ["check() ? getStyles() : false", true, "nonempty", false],
    ["check() ? getStyles() : false", true, "empty", false],
    ["check() ? getStyles() : false", true, "falsy", true],
    ["check() ? getStyles() : false", false, "nonempty", true],
    ["check() ? false : getStyles()", false, "nonempty", false]
  ] as const)(
    "selects nested guarded cx branches (%s, guard=%s, factory=%s)",
    (branch, guard, kind, usesFallback) => {
      const { code, result } = babelTransform(
        `import { cx } from "custom-preset";
           import { getStyles } from "./theme.css.js";
           export function Box(base, check, fallback) {
             return <div css={cx(base, (${branch}) || fallback())} />;
           }`,
        { jsxCssProp }
      );
      const definition = defineRules({ properties: { padding: [12] } });
      const rule = kind === "empty" ? {} : { padding: 12 };
      const getStyles = vi.fn(() => (kind === "falsy" ? false : rule));
      const configuredCss = vi.fn(definition.css);
      const configuredCx = vi.fn(cx);
      const modules = {
        "custom-preset": { cx: configuredCx, css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      expect(getStyles).toHaveBeenCalledOnce();
      expect(configuredCss.mock.calls).toEqual(
        kind === "falsy" ? [] : [[rule]]
      );
      const value = usesFallback
        ? "fallback"
        : configuredCss.mock.results[0]!.value;
      if (kind === "empty") expect(value).toBe("");
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          base: string,
          check: () => boolean | number,
          fallback: () => string
        ): { props: { className: string } };
      };
      const trace: string[] = [];
      const check = vi.fn(() => {
        trace.push("guard");
        return guard;
      });
      const fallback = vi.fn(() => {
        trace.push("fallback");
        return "fallback";
      });
      expect(Box("base", check, fallback).props.className).toBe(
        cx("base", value)
      );
      expect(configuredCx).toHaveBeenCalledExactlyOnceWith("base", value);
      expect(trace).toEqual(usesFallback ? ["guard", "fallback"] : ["guard"]);
      expect(getStyles).toHaveBeenCalledOnce();
    }
  );

  it.each(["rule", "empty", "middle", "last"] as const)(
    "keeps the scalar OR chain lazy and class-valued: %s",
    (kind) => {
      const definition = defineRules({ properties: { padding: [12] } });
      const rule = kind === "empty" ? {} : { padding: 12 };
      const getStyles = vi.fn(() =>
        kind === "rule" || kind === "empty" ? rule : false
      );
      const configuredCss = vi.fn(definition.css);
      const { code, result } = babelTransform(
        `import {cx} from "custom-preset";
         import {getStyles} from "./theme.css.js";
         export const Box = (middle, last) =>
           <div css={cx("base", (getStyles() || middle()) || last())} />;`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "custom-preset": { cx, css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          middle: () => string,
          last: () => string
        ): { props: { className: string } };
      };
      const trace: string[] = [];
      const actual = Box(
        () => {
          trace.push("middle");
          return kind === "middle" ? "middle" : "";
        },
        () => {
          trace.push("last");
          return "last";
        }
      );
      expect(getStyles).toHaveBeenCalledOnce();
      const hasRule = kind === "rule" || kind === "empty";
      expect(configuredCss.mock.calls).toEqual(hasRule ? [[rule]] : []);
      const expected = hasRule ? configuredCss.mock.results[0]!.value : kind;
      expect(actual.props.className).toBe(cx("base", expected));
      expect(trace).toEqual(
        hasRule ? [] : kind === "middle" ? ["middle"] : ["middle", "last"]
      );
    }
  );

  it.each(["array", "iterable", "literal rule"] as const)(
    "preserves runtime cx spread arguments for %s",
    (mode) => {
      const expression =
        mode === "literal rule" ? "...[getRule()]" : "...getClasses()";
      const { code, result } = babelTransform(
        `import { cx } from "custom-preset";
         import { getClasses, getRule } from "./theme.css.js";
         export function Box(base, mark) {
           return <div css={cx(mark("before", base), ${expression},
                               mark("after", "tail"))} />;
         }`,
        { jsxCssProp }
      );
      const events: string[] = [];
      const definition = defineRules({ properties: { padding: [12] } });
      const rule = { padding: 12 } as const;
      const configuredCss = vi.fn((input: typeof rule | string[]) =>
        Array.isArray(input) ? cx(input) : definition.css(input)
      );
      const configuredCx = vi.fn((...args: Parameters<typeof cx>) => {
        events.push("cx");
        return cx(...args);
      });
      const getRule = vi.fn(() => rule);
      const getClasses = vi.fn(() => {
        events.push("get");
        if (mode === "array") return ["wide", "left"];
        return (function* () {
          events.push("iterate");
          yield "wide";
          yield "left";
        })();
      });
      const modules = {
        "custom-preset": { cx: configuredCx, css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getClasses, getRule }
      };
      const sidecar = executeModule(result[1], modules);
      expect(events).toEqual([]);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          base: string,
          mark: (event: string, value: string) => string
        ): {
          props: { className: string };
        };
      };
      const element = Box("base", (event, value) => {
        events.push(event);
        return value;
      });
      if (mode === "literal rule") {
        expect(configuredCss).toHaveBeenCalledExactlyOnceWith(rule);
        expect(getRule).toHaveBeenCalledOnce();
        expect(getClasses).not.toHaveBeenCalled();
        const renderedClass = configuredCss.mock.results[0]!.value;
        expect(configuredCx).toHaveBeenCalledExactlyOnceWith(
          "base",
          renderedClass,
          "tail"
        );
        expect(element.props.className).toBe(cx("base", renderedClass, "tail"));
        expect(events).toEqual(["before", "after", "cx"]);
      } else {
        expect(configuredCss).not.toHaveBeenCalled();
        expect(getRule).not.toHaveBeenCalled();
        expect(getClasses).toHaveBeenCalledOnce();
        expect(configuredCx).toHaveBeenCalledExactlyOnceWith(
          "base",
          "wide",
          "left",
          "tail"
        );
        expect(element.props.className).toBe("base wide left tail");
        expect(events).toEqual([
          "before",
          "get",
          ...(mode === "iterable" ? ["iterate"] : []),
          "after",
          "cx"
        ]);
      }
    }
  );

  it.each(['true ? "base" : getStyles()', 'false ? getStyles() : "base"'])(
    "does not build a dead factory of a shared JSX class: %s",
    (selection) => {
      const { code, result } = babelTransform(
        `import { getStyles } from "./theme.css.js";
          export function Box() {
            const selected = ${selection};
            return { selected, element: <div css={selected} /> };
          }`,
        { jsxCssProp }
      );
      const getStyles = vi.fn(() => ({ padding: 12 }));
      const configuredCss = vi.fn(css);
      const modules = {
        "custom-preset": { css: configuredCss },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(): { selected: string; element: { props: { className: string } } };
      };
      for (const frame of [Box(), Box()]) {
        expect(frame.selected).toBe("base");
        expect(frame.element.props.className).toBe("base");
      }
      expect(getStyles).not.toHaveBeenCalled();
      expect(configuredCss).not.toHaveBeenCalled();
    }
  );

  it("uses a runtime cx result once beside a shared extracted factory branch", () => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const configuredCss = vi.fn(css);
    let count = 0;
    const configuredCx = vi.fn((value: string) => value + "-" + ++count);
    const { code, result } = babelTransform(
      `import { cx } from "custom-preset";
       import { getStyles } from "./theme.css.js";
       export function Box(active) {
         const selected = active ? cx("base") : getStyles();
         return { selected, element: <div css={selected} /> };
       }`,
      { jsxCssProp }
    );
    const modules = {
      "custom-preset": { css: configuredCss, cx: configuredCx },
      "@mincho-js/css/classname": { cx },
      "@mincho-js/css": { mincho$ },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    expect(configuredCss).toHaveBeenCalledExactlyOnceWith(style);
    expect(getStyles).toHaveBeenCalledOnce();
    expect(configuredCx).not.toHaveBeenCalled();
    const styleClass = configuredCss.mock.results[0]!.value;
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as (active: boolean) => {
      selected: string | typeof style;
      element: { props: { className: string } };
    };
    getStyles.mockClear();
    const liveClass = Box(true);
    expect(liveClass.selected).toBe("base-1");
    expect(liveClass.element.props.className).toBe("base-1");
    expect(configuredCx.mock.calls).toEqual([["base"]]);
    expect(getStyles).not.toHaveBeenCalled();

    const liveStyle = Box(false);
    expect(liveStyle.selected).toBe(style);
    expect(liveStyle.element.props.className).toBe(styleClass);
    expect(configuredCx).toHaveBeenCalledOnce();
    expect(getStyles).toHaveBeenCalledOnce();
    expect(configuredCss).toHaveBeenCalledOnce();
  });

  it("projects only CSS truthy results while preserving predicate effects and falsy runtime identity", () => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = ({enabled}) => {
        const selected = enabled() && getStyles();
        return {value: selected, element: <div css={selected} style={selected} />};
      };
    `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as (props: { enabled: () => unknown }) => {
      value: unknown;
      element: { props: { style: unknown; className: string } };
    };
    // Do not Boolean-coerce the original result. The same untouched JS && also
    // preserves browser HTMLDDA; the generic mutation API keeps it unknown.
    expect(code).toContain("enabled() &&");
    for (const value of [false, 0, -0, "", null, undefined, NaN]) {
      const events: string[] = [];
      getStyles.mockClear();
      const observed = Box({
        enabled: () => {
          events.push("condition");
          return value;
        }
      });
      expect(Object.is(observed.value, value)).toBe(true);
      expect(Object.is(observed.element.props.style, value)).toBe(true);
      expect(observed.element.props.className).toBe("");
      expect(events).toEqual(["condition"]);
      expect(getStyles).not.toHaveBeenCalled();
    }
    getStyles.mockClear();
    expect(() =>
      Box({
        enabled: () => {
          throw new Error("condition");
        }
      })
    ).toThrow("condition");
    expect(getStyles).not.toHaveBeenCalled();
  });

  it("retains left-side alias writes when projecting CSS truthy result origins", () => {
    expect(() =>
      babelTransform(
        `
      const style = {padding: 4};
      const alias = style;
      const selected = (alias.padding = 12, true) && style;
      export const element = <div css={selected} />;
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow();
  });

  it("still extracts conditional factory aliases used only as CSS values", () => {
    const getStyles = vi.fn(() => ({ padding: 12 }));
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = ({active}) => {
        const selected = active ? getStyles() : false;
        const alias = selected;
        return <><div css={selected} /><span css={alias} /></>;
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    executeSidecar(result[1], {
      "@mincho-js/css": { mincho$ },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    });
    expect(getStyles).toHaveBeenCalledOnce();
    expect(code).not.toContain("getStyles()");
    expect(code).not.toContain("cssClass");
  });

  it("keeps shared var aliases visible outside their declaration block", () => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const { code, result } = babelTransform(
      `
      import {getStyles} from "./theme.css.js";
      export const Box = ({active}) => {
        if (active) {
          var selected = active ? getStyles() : false;
        }
        return {value: selected, element: <div css={selected} style={selected} />};
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    getStyles.mockClear();
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as (props: { active: boolean }) => {
      value: unknown;
      element: { props: { style: unknown; className: string } };
    };

    const active = Box({ active: true });
    expect(active.value).toBe(style);
    expect(active.element.props.style).toBe(style);
    expect(active.element.props.className).toEqual(expect.any(String));
    expect(getStyles).toHaveBeenCalledOnce();

    getStyles.mockClear();
    const inactive = Box({ active: false });
    expect(inactive.value).toBeUndefined();
    expect(inactive.element.props.style).toBeUndefined();
    expect(inactive.element.props.className).toBe("");
    expect(getStyles).not.toHaveBeenCalled();
  });

  it.each([
    "export const selected = enabled() ? getStyles() : false;",
    "const selected = enabled() ? getStyles() : false; export {selected};",
    "const selected = enabled() ? getStyles() : false; const alias = selected; export {alias as selected};"
  ])("preserves externally observable aliases: %s", (declaration) => {
    const style = { padding: 12 };
    const getStyles = vi.fn(() => style);
    const enabled = vi.fn(() => true);
    const { code, result } = babelTransform(
      `
      import {getStyles, enabled} from "./theme.css.js";
      ${declaration}
      export const Box = () => <div css={selected} />;
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles, enabled }
    };
    const sidecar = executeModule(result[1], modules);
    getStyles.mockClear();
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as () => { props: { className: string } };
    expect(runtime.selected).toBe(style);
    expect(Box().props.className).toEqual(expect.any(String));
    expect(getStyles).toHaveBeenCalledOnce();
    expect(enabled).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps shared CSS staging in a direct arrow body (rest=%s)",
    (rest) => {
      const style = { padding: 12 };
      const calls: string[] = [];
      const getStyles = vi.fn(() => {
        calls.push("style");
        return style;
      });
      const { code, result } = babelTransform(
        `import { getStyles } from "./theme.css.js";
       export const Box = (input) => ((${rest ? "...args" : "args"}) => {
         const selected = args.length ? getStyles() : false;
         return [selected, <div css={selected} />, args.length];
       })(${rest ? "...input" : "input"});`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const configuredCss = vi.fn((rule: typeof style) =>
        rule === style ? "padding-12" : "unexpected"
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles }
      };
      const sidecar = executeModule(result[1], modules);
      expect(configuredCss).toHaveBeenCalledOnce();
      calls.length = 0;
      getStyles.mockClear();
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          input: number[]
        ): [unknown, { props: { className: string } }, number];
      };
      const [selected, element, count] = Box([1, 2]);
      expect(selected).toBe(style);
      expect(element.props.className).toBe("padding-12");
      expect(count).toBe(2);
      expect(getStyles).toHaveBeenCalledOnce();
      expect(calls).toEqual(["style"]);
      const [absent, empty, zero] = Box([]);
      expect(absent).toBe(false);
      expect(empty.props.className).toBe("");
      expect(zero).toBe(0);
      expect(getStyles).toHaveBeenCalledOnce();
    }
  );

  it("keeps both factory branches and resets shared classes in loop declarations", () => {
    const styles = [{ padding: 12 }, { padding: 4 }];
    const getStyles = vi.fn(() => styles[0]);
    const getAlternateStyles = vi.fn(() => styles[1]);
    const choose = vi.fn((active: boolean) => active);
    const { code, result } = babelTransform(
      `
      import {getStyles, getAlternateStyles} from "./theme.css.js";
      export const Box = ({flags, choose}) => {
        const rows = [];
        for (const active of flags) {
          var selected = choose(active) && getStyles();
          rows.push({value: selected, element: <div css={selected} style={selected} />});
        }
        return rows;
      };
      export const Header = ({active, choose}) => {
        const selected = choose(active) ? getStyles() : getAlternateStyles();
        return {value: selected, element: <div css={selected} style={selected} />};
      };
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles, getAlternateStyles }
    };
    const sidecar = executeModule(result[1], modules);
    getStyles.mockClear();
    getAlternateStyles.mockClear();
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    type Row = {
      value: unknown;
      element: { props: { style: unknown; className: string } };
    };
    const Box = runtime.Box as (props: {
      flags: boolean[];
      choose: typeof choose;
    }) => Row[];
    const Header = runtime.Header as (props: {
      active: boolean;
      choose: typeof choose;
    }) => Row;
    const rows = Box({ flags: [true, false, true, false], choose });
    expect(rows.map((row) => row.value)).toEqual([
      styles[0],
      false,
      styles[0],
      false
    ]);
    expect(rows.map((row) => row.element.props.style)).toEqual([
      styles[0],
      false,
      styles[0],
      false
    ]);
    expect(rows.map((row) => row.element.props.className)).toEqual([
      expect.any(String),
      "",
      expect.any(String),
      ""
    ]);
    expect(getStyles).toHaveBeenCalledTimes(2);
    expect(choose).toHaveBeenCalledTimes(4);

    choose.mockClear();
    getStyles.mockClear();
    const primary = Header({ active: true, choose });
    const alternate = Header({ active: false, choose });
    expect(primary.value).toBe(styles[0]);
    expect(primary.element.props.style).toBe(styles[0]);
    expect(alternate.value).toBe(styles[1]);
    expect(alternate.element.props.style).toBe(styles[1]);
    expect(primary.element.props.className).toEqual(expect.any(String));
    expect(alternate.element.props.className).not.toBe(
      primary.element.props.className
    );
    expect(getStyles).toHaveBeenCalledOnce();
    expect(getAlternateStyles).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "publishes each shared class only after its retained value: caught throw=%s",
    (throws) => {
      const source = `
      import {getStyles, getAlternateStyles} from "./theme.css.js";
      export const Box = (flags, select) => {
        const rows = [];
        for (const active of flags) {
          try { var selected = select(active) ? getStyles() : getAlternateStyles(); }
          catch (error) { rows.push(error.message); }
          rows.push({value:selected, element:<div css={selected} style={selected} />});
        }
        return rows;
      };
    `;
      const { code, result } = babelTransform(source, { jsxCssProp });
      const firstStyle = { padding: 12 } as const;
      const secondStyle = { padding: 4 } as const;
      let runtime = false;
      const trace: string[] = [];
      const getStyles = () => {
        trace.push("primary");
        return firstStyle;
      };
      const getAlternateStyles = () => {
        trace.push("alternate");
        if (runtime && throws) throw new Error("alternate failed");
        return secondStyle;
      };
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: definition.css },
        "./theme.css.js": { getStyles, getAlternateStyles }
      };
      const sidecar = executeModule(result[1], modules);
      expect(trace.splice(0)).toEqual(["primary", "alternate"]);
      runtime = true;
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(
          flags: boolean[],
          select: (active: boolean) => boolean
        ): (
          | string
          | {
              value: object;
              element: { props: { style: object; className: string } };
            }
        )[];
      };
      const rows = Box([true, false], (active) => active);
      const expected = (style: { padding: 4 | 12 }) => ({
        value: style,
        element: {
          type: "div",
          props: { style, className: definition.css(style) }
        }
      });
      expect(rows).toEqual(
        throws
          ? [expected(firstStyle), "alternate failed", expected(firstStyle)]
          : [expected(firstStyle), expected(secondStyle)]
      );
      expect(trace).toEqual(["primary", "alternate"]);
    }
  );

  it.each(["const", "let"])(
    "diagnoses shared %s factory aliases in for initializers before changing closure scope",
    (kind) => {
      expect(() =>
        babelTransform(
          `
      import {getStyles} from "./theme.css.js";
      export const boxes = (choose, next) => {
        const callbacks = [];
        while (next())
          for (${kind} selected = choose() ? getStyles() : false; next();)
            callbacks.push(() => <div css={selected} style={selected} />);
        return callbacks;
      };
      `,
          { jsxCssProp, optimize: { pureFunctions: false } }
        )
      ).toThrow(
        "Shared conditional CSS factory aliases in for initializers are not supported"
      );
    }
  );

  it.each([
    ["ternary", "choose(active) ? getStyles() : getAlternateStyles()"],
    ["logical", "choose(active) && getStyles()"]
  ])(
    "captures %s companion classes with loop value aliases",
    (kind, initializer) => {
      const styles = [{ padding: 12 }, { padding: 4 }];
      const compiled = new Map<unknown, string>();
      const configuredCss = (style: { padding: number }) => {
        const className = css(style);
        compiled.set(style, className);
        return className;
      };
      const getStyles = vi.fn(() => styles[0]);
      const getAlternateStyles = vi.fn(() => styles[1]);
      const choose = vi.fn((active: boolean) => active);
      const { code, result } = babelTransform(
        `
      import {getStyles, getAlternateStyles} from "./theme.css.js";
      export const Box = ({flags, choose}) => {
        const callbacks = [];
        for (const active of flags) {
          var selected = ${initializer};
          const copy = selected;
          const captured = copy;
          callbacks.push(() => ({
            value: captured,
            first: <div css={captured} style={captured} />,
            second: <span css={captured} />
          }));
        }
        return callbacks;
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles, getAlternateStyles }
      };
      const sidecar = executeModule(result[1], modules);
      getStyles.mockClear();
      getAlternateStyles.mockClear();
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (props: {
        flags: boolean[];
        choose: typeof choose;
      }) => (() => {
        value: unknown;
        first: { props: { style: unknown; className: string } };
        second: { props: { className: string } };
      })[];
      const flags = [true, false, true, false];
      const callbacks = Box({ flags, choose });
      expect(getStyles).toHaveBeenCalledTimes(2);
      expect(getAlternateStyles).toHaveBeenCalledTimes(
        kind === "ternary" ? 2 : 0
      );
      expect(choose).toHaveBeenCalledTimes(4);

      for (const [index, callback] of callbacks.entries()) {
        const rendered = callback();
        const style = flags[index]
          ? styles[0]
          : kind === "ternary"
            ? styles[1]
            : false;
        const className = style ? compiled.get(style) : "";
        expect(rendered.value).toBe(style);
        expect(rendered.first.props.style).toBe(style);
        expect(rendered.first.props.className).toBe(className);
        expect(rendered.second.props.className).toBe(className);
      }

      expect(getStyles).toHaveBeenCalledTimes(2);
      expect(choose).toHaveBeenCalledTimes(4);
    }
  );

  it.each(["recipe({tone})", "selected"])(
    "serializes genuine recipes without evaluating runtime inputs: %s",
    (expression) => {
      const recipe = rules({
        variants: { tone: { solid: { color: "red" }, soft: { color: "blue" } } }
      });
      const { code, result } = babelTransform(
        `
        import {recipe} from "./theme.css.js";
        export const Box = ({tone}) => {
          ${expression === "selected" ? "const selected = recipe({tone});" : ""}
          return <><div css={${expression}} /><div css={${expression}} /></>;
        };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "./theme.css.js": { recipe }
      });

      expect(values.length).toBe(expression === "selected" ? 1 : 2);
      expect(values.every((value) => value === recipe)).toBe(true);
      expect(result[1]).not.toContain("({tone})");
      expect(code).not.toContain("__recipe__");
      expect(code).not.toContain("custom-preset");
      expect(recipe({ tone: "solid" })).not.toBe(recipe({ tone: "soft" }));
    }
  );

  it.each([
    ["undefined", "active ? recipe({tone}) : undefined", true],
    ["void zero", "active ? recipe({tone}) : void 0", true],
    ["reversed undefined", "active ? undefined : recipe({tone})", false],
    [
      "wrapped undefined",
      "active ? recipe({tone}) : (undefined as undefined)",
      true
    ]
  ] as const)(
    "preserves optional recipe branches with %s",
    (_name, expression, positive) => {
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const recipe = definition.rules({
        variants: { tone: { wide: { padding: 12 }, narrow: { padding: 4 } } }
      });
      const configuredCss = vi.fn(definition.css);
      const { code, result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      export const Box = ({active, tone}) => <div css={${expression}} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as (props: {
        active: boolean;
        tone: "wide" | "narrow";
      }) => { props: { className: string; css?: unknown } };

      for (const tone of ["wide", "narrow"] as const) {
        for (const active of [false, true]) {
          const element = Box({ active, tone });
          expect(element.props.className).toBe(
            active === positive ? recipe({ tone }) : ""
          );
          expect(element.props).not.toHaveProperty("css");
        }
      }

      expect(configuredCss).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("recipe({tone})");
    }
  );

  it.each([
    ["shadowed undefined", "undefined"],
    ["effectful void", "void effect()"]
  ])("does not classify %s as a static empty recipe branch", (_name, empty) => {
    expect(() =>
      babelTransform(
        `
      import {recipe} from "./theme.css.js";
      export const Box = ({active, tone, undefined, effect}) =>
        <div css={active ? recipe({tone}) : ${empty}} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(
      "Complex conditions are supported only when branch CSS shape is static"
    );
  });

  it.each(["plain", "foreign", "accessor"])(
    "rejects unproven dynamic factories without calling them: %s",
    (metadataKind) => {
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const getter = vi.fn(() => {
        throw new Error("Metadata getter must not run");
      });
      if (metadataKind === "foreign")
        Object.defineProperty(getStyles, "__recipe__", {
          value: {
            importPath: "another-runtime",
            importName: "createStyleFactory",
            args: []
          }
        });
      if (metadataKind === "accessor")
        Object.defineProperty(getStyles, "__recipe__", { get: getter });
      const { result } = babelTransform(
        `
        import {getStyles} from "./theme.css.js";
        export const Box = ({padding}) => <div css={getStyles(padding)} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );

      expect(() =>
        executeSidecar(result[1], {
          "@mincho-js/css": { mincho$ },
          "./theme.css.js": { getStyles }
        })
      ).toThrow(
        /runtime calls only to compiled Mincho or Vanilla Extract recipes/
      );
      expect(getStyles).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(result[1]).not.toContain("getStyles(padding)");
    }
  );

  it.each([
    ["parameter", "", "{tone, Error}", "Error"],
    ["local binding", "const Error = supplied;", "{tone, supplied}", "Error"],
    ["program binding", "", "{tone}", "Error"],
    ["nested parameter", "", "{tone, Error}", "Error"],
    ["nested local", "const Error = supplied;", "{tone, supplied}", "Error"]
  ])(
    "keeps recipe metadata guards hygienic with a shadowed Error %s",
    (kind, setup, params, reference) => {
      const button = rules({ variants: { tone: { loud: { padding: 12 } } } });
      const shadow = vi.fn(() => {
        throw new Error("source Error called");
      });
      const { code, result } = babelTransform(
        `
      import {button} from "./styles.css.js";
      ${kind === "program binding" || kind.startsWith("nested") ? 'import {Error} from "./shadow.js";' : ""}
      export const Box = (${params}) => {
        ${setup}
        return <button css={button({tone})} data-error={${reference}} />;
      };`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./styles.css.js": { button },
        "./shadow.js": { Error: shadow }
      };
      const sidecar = executeModule(result[1], modules);
      const entry = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = entry.Box as (props: Record<string, unknown>) => {
        props: Record<string, unknown>;
      };
      expect(
        Box({ tone: "loud", Error: shadow, supplied: shadow }).props
      ).toMatchObject({
        className: button({ tone: "loud" }),
        "data-error": shadow
      });
      expect(() =>
        executeModule(result[1], {
          ...modules,
          "./styles.css.js": { button: () => "invalid" }
        })
      ).toThrow(
        /runtime calls only to compiled Mincho or Vanilla Extract recipes/
      );
      expect(shadow).not.toHaveBeenCalled();
    }
  );

  it.each(["Error", "Local"])(
    "keeps the authored function's observable name with a valid compiled recipe (%s)",
    (name) => {
      const button = rules({ variants: { tone: { loud: { padding: 12 } } } });
      const source =
        'import {button} from "./styles.css.js";' +
        "export const Box = ({tone}) => { function " +
        name +
        "() {}" +
        "return <button css={button({tone})} data-name={" +
        name +
        ".name} />; };";
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./styles.css.js": { button }
      };
      const typeofBox = (entry: Record<string, unknown>) =>
        entry.Box as (p: { tone: string }) => {
          props: Record<string, unknown>;
        };
      const native = typeofBox(executeModule(source, modules))({
        tone: "loud"
      }).props;
      const sidecar = executeModule(result[1], modules);
      const compiled = typeofBox(
        executeModule(code, { ...modules, [result[0]]: sidecar })
      )({ tone: "loud" }).props;
      expect(native["data-name"]).toContain(name);
      expect(compiled).toMatchObject({
        "data-name": native["data-name"],
        className: button({ tone: "loud" })
      });
    }
  );

  it("does not rename a shadowed guard intrinsic across dynamic scope", () => {
    expect(() =>
      babelTransform(
        `
      import {button} from "./styles.css.js";
      export const Box = ({tone, Error}) => {
        const observed = eval("Error");
        return <button css={button({tone})} data-error={observed} />;
      };`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      )
    ).toThrow(/dynamic scope/);
  });

  it("ignores source bindings that shadow metadata lookup globals", () => {
    const button = rules({
      variants: { tone: { loud: { padding: 12 }, quiet: { padding: 4 } } }
    });
    const getOwnPropertyDescriptor = vi.fn(() => {
      throw new Error("Source Object binding must not be used");
    });
    const { code, result } = babelTransform(
      `
      import {button} from "./styles.css.js";
      import {Object, globalThis} from "./shadows.js";

      export const Box = ({tone}) => (
        <button css={button({tone})} data-object={Object} data-global={globalThis} />
      );
      `,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "./styles.css.js": { button },
      "./shadows.js": {
        Object: { getOwnPropertyDescriptor },
        globalThis: { Object: null }
      }
    };
    const sidecar = executeModule(result[1], modules);
    const entry = executeModule(code, {
      ...modules,
      [result[0]]: sidecar
    });
    const Box = entry.Box as (props: { tone: string }) => {
      props: Record<string, unknown>;
    };

    expect(Box({ tone: "loud" }).props).toMatchObject({
      className: button({ tone: "loud" }),
      "data-object": modules["./shadows.js"].Object,
      "data-global": modules["./shadows.js"].globalThis
    });
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  it.each(["custom-preset", "./theme.css.js"])(
    "preserves scoped atomic merging for dynamic cx from %s",
    (source) => {
      const definition = defineRules({
        properties: { paddingLeft: [4, 12], paddingRight: [4, 12] },
        shortcuts: { px: ["paddingLeft", "paddingRight"] }
      });
      const wide = definition.css({ px: 12 });
      const narrowLeft = definition.css({ paddingLeft: 4 });
      const { code, result } = babelTransform(
        `
      import {cx} from "${source}";
      export const Box = ({active, base, selected}) => <div css={cx(base, active && selected)} />;
    `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "rules", "cx"] }
        }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        [source]: definition
      });

      expect(values).toEqual([definition.cx]);
      expect(code).not.toContain("custom-preset");
      expect(result[1]).not.toContain("active");
      const runtimeCx = values[0] as typeof definition.cx;
      expect(runtimeCx(wide, false)).toBe(wide);
      expect(runtimeCx(wide, narrowLeft)).toBe(
        definition.cx(definition.css({ paddingRight: 12 }), narrowLeft)
      );
    }
  );

  it.each(
    [false, true].flatMap((optionalCapture) =>
      ['preset.cx.marker = "changed";', "const alias = cx; mutate(alias);"].map(
        (mutation) => ({ optionalCapture, mutation })
      )
    )
  )(
    "keeps user cx mutation checks with optionalCapture=$optionalCapture: $mutation",
    ({ optionalCapture, mutation }) => {
      const configuredCx: ((...values: Parameters<typeof cx>) => string) & {
        marker: string;
      } = Object.assign(
        (...values: Parameters<typeof cx>) =>
          cx(...values, configuredCx.marker),
        { marker: "" }
      );
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      import * as preset from "custom-preset";
      import {getStyles} from "./theme.css.js";
      import {mutate} from "./runtime.js";
      export const Before = ({active}) => <div css={${optionalCapture ? "[getStyles()]" : 'cx(active && "first")'}} />;
      ${mutation}
      export const After = ({active}) => <div css={cx(active && "second")} />;
      `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css, cx: configuredCx },
        "./theme.css.js": { getStyles: () => "factory" },
        "./runtime.js": {
          mutate(value: typeof configuredCx) {
            value.marker = "changed";
          }
        }
      };
      const sidecar = executeModule(result[1], modules);
      expect(Object.values(sidecar)).not.toContain(configuredCx);

      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const After = runtime.After as (props: { active: boolean }) => {
        props: { className: string };
      };

      expect(After({ active: true }).props.className).toBe("second changed");
      expect(After({ active: false }).props.className).toBe("changed");
      expect(code).toContain('from "custom-preset"');
    }
  );

  it.each([false, true])(
    "preserves dynamic cx beside a direct array with optional capture first=%s",
    (optionalFirst) => {
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const optional =
        "export const Before = () => <div css={[getStyles()]} />;";
      const required =
        'export const After = ({active}) => <div css={cx(active && "extra")} />;';
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      import {getStyles} from "./theme.css.js";
      ${optionalFirst ? optional + required : required + optional}
      `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": definition,
        "./theme.css.js": { getStyles: () => ({ padding: 4 }) }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const After = runtime.After as (props: { active: boolean }) => {
        props: { className: string };
      };

      expect(After({ active: true }).props.className).toBe("extra");
      expect(After({ active: false }).props.className).toBe("");
      expect(result[1]).not.toContain("active");
    }
  );

  it("preserves a failed callable capture when a class array clones runtime calls", () => {
    const definition = defineRules({ properties: { padding: [4] } });
    const recipe = definition.rules({
      variants: { tone: { any: { padding: 4 } } }
    });
    const configuredCx: ((...values: Parameters<typeof cx>) => string) & {
      marker: string;
    } = Object.assign(
      (...values: Parameters<typeof cx>) => cx(...values, configuredCx.marker),
      { marker: "" }
    );
    const { code, result } = babelTransform(
      `import { cx } from "custom-preset";
       import * as preset from "custom-preset";
       import { recipe } from "./theme.css.js";
       preset.cx.marker = "changed";
       export const Box = ({active, tone}) =>
         <div css={[cx(active && "extra"), recipe({tone})]} />;`,
      {
        jsxCssProp,
        extractCalls: { "custom-preset": ["css", "cx"] },
        optimize: { pureFunctions: false }
      }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css, cx: configuredCx },
      "./theme.css.js": { recipe }
    };
    const sidecar = executeModule(result[1], modules);
    expect(Object.values(sidecar)).not.toContain(configuredCx);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as (props: { active: boolean; tone: string }) => {
      props: { className: string };
    };
    for (const active of [false, true])
      expect(Box({ active, tone: "any" }).props.className).toBe(
        cx(configuredCx(active && "extra"), recipe({ tone: "any" }))
      );
    expect(code).toContain('from "custom-preset"');
    expect(result[1]).not.toContain("active");
  });

  it.each([
    '"external", active && recipe({tone})',
    '["external", active && recipe({tone})]',
    '...["external", ...[active && recipe({tone})]]',
    '(["external", active && recipe({tone})] as const)',
    '(["external", active && recipe({tone})] satisfies unknown[])'
  ])(
    "serializes recipes nested in registered runtime cx: %s",
    (argumentsCode) => {
      const definition = defineRules({
        properties: { padding: [4, 12] }
      });
      const recipe = definition.rules({
        variants: {
          tone: { wide: { padding: 12 }, narrow: { padding: 4 } }
        }
      });
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      import {recipe} from "./theme.css.js";
      export const Box = ({active, tone}) => <div css={cx(${argumentsCode})} />;
    `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "rules", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": definition,
        "./theme.css.js": { recipe }
      });
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as (props: {
        active: boolean;
        tone: "wide" | "narrow";
      }) => { props: { className: string } };

      expect(Box({ active: true, tone: "wide" }).props.className).toBe(
        definition.cx("external", recipe({ tone: "wide" }))
      );
      expect(Box({ active: true, tone: "narrow" }).props.className).toBe(
        definition.cx("external", recipe({ tone: "narrow" }))
      );
      expect(Box({ active: false, tone: "wide" }).props.className).toBe(
        "external"
      );
      expect(code).not.toContain("__recipe__");
      expect(result[1]).not.toContain("recipe({");
      expect(result[1]).not.toContain("active &&");
    }
  );

  it.each([
    ["static", "[getClass()]"],
    ["dynamic", "[getClass(), recipe({tone})]"],
    ["spread", "[...head, getClass(), recipe({tone})]"],
    ["static", "[getClass()] as const"],
    ["dynamic", "[getClass(), recipe({tone})] satisfies string[]"]
  ])(
    "preserves shared %s cx arrays and runtime calls: %s",
    (kind, initializer) => {
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const getClass = vi.fn(() => definition.css({ padding: 4 }));
      const originalRecipe = definition.rules({
        variants: { tone: { wide: { padding: 12 }, narrow: { padding: 4 } } }
      });
      const recipe = vi.fn(originalRecipe);
      Object.defineProperty(
        recipe,
        "__recipe__",
        Object.getOwnPropertyDescriptor(originalRecipe, "__recipe__")!
      );
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      import {getClass, recipe} from "./theme.css.js";
      export const Box = ({active, tone, head}) => {
        const entries = ${initializer};
        const copied = entries;
        return {
          entries,
          copied,
          first: <div css={cx(copied, active && "extra")} />,
          second: <span css={cx(...entries, active && "extra")} />
        };
      };
      `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "rules", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": definition,
        "./theme.css.js": { getClass, recipe }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (props: {
        active: boolean;
        tone: "wide" | "narrow";
        head: string[];
      }) => {
        entries: unknown[];
        copied: unknown[];
        first: { props: { className: string } };
        second: { props: { className: string } };
      };

      for (const active of [false, true]) {
        getClass.mockClear();
        recipe.mockClear();
        const rendered = Box({ active, tone: "wide", head: ["external"] });
        const expected = [
          ...(kind === "spread" ? ["external"] : []),
          definition.css({ padding: 4 }),
          ...(kind !== "static" ? [originalRecipe({ tone: "wide" })] : [])
        ];
        expect(rendered.entries).toEqual(expected);
        expect(rendered.copied).toBe(rendered.entries);
        expect(rendered.first.props.className).toBe(
          definition.cx(expected, active && "extra")
        );
        expect(rendered.second.props.className).toBe(
          rendered.first.props.className
        );
        expect(getClass).toHaveBeenCalledOnce();
        expect(recipe).toHaveBeenCalledTimes(kind === "static" ? 0 : 1);
      }
    }
  );

  it.each([
    ["static", "[getClass()]"],
    ["dynamic", "[getClass(), recipe({tone})]"],
    ["spread", "[...head, getClass(), recipe({tone})]"],
    ["static", "[getClass()] as const"],
    ["dynamic", "[getClass(), recipe({tone})] satisfies string[]"]
  ])(
    "still extracts %s arrays used only by cx CSS consumers: %s",
    (kind, initializer) => {
      const definition = defineRules({ properties: { padding: [4, 12] } });
      const getClass = vi.fn(() => definition.css({ padding: 4 }));
      const recipe = definition.rules({
        variants: { tone: { wide: { padding: 12 }, narrow: { padding: 4 } } }
      });
      const { code, result } = babelTransform(
        `
      import {cx} from "custom-preset";
      import {getClass, recipe} from "./theme.css.js";
      export const Box = ({active, tone, head}) => {
        const entries = ${initializer};
        const copied = entries;
        return {
          first: <div css={cx(copied, active && "extra")} />,
          second: <span css={cx(...entries, active && "extra")} />
        };
      };
      `,
        {
          jsxCssProp,
          extractCalls: { "custom-preset": ["css", "rules", "cx"] },
          optimize: { pureFunctions: false }
        }
      );
      const sidecar = executeModule(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": definition,
        "./theme.css.js": { getClass, recipe }
      });
      getClass.mockClear();
      const runtime = executeModule(code, {
        "@mincho-js/css/classname": { cx },
        [result[0]]: sidecar
      });
      const Box = runtime.Box as (props: {
        active: boolean;
        tone: "wide" | "narrow";
        head: string[];
      }) => {
        first: { props: { className: string } };
        second: { props: { className: string } };
      };

      for (const active of [false, true]) {
        const rendered = Box({ active, tone: "wide", head: ["external"] });
        const expected = definition.cx(
          kind === "spread" && "external",
          definition.css({ padding: 4 }),
          kind !== "static" && recipe({ tone: "wide" }),
          active && "extra"
        );
        expect(rendered.first.props.className).toBe(expected);
        expect(rendered.second.props.className).toBe(expected);
      }

      expect(getClass).not.toHaveBeenCalled();
      expect(code).not.toContain("getClass()");
    }
  );

  it("keeps mutated wrapped cx arrays and their factory calls at runtime", () => {
    const definition = defineRules({ properties: { padding: [4] } });
    const getClass = vi.fn(() => definition.css({ padding: 4 }));
    const { code, result } = babelTransform(
      `
      import {cx} from "custom-preset";
      import {getClass} from "./theme.css.js";
      export const Box = ({active}) => {
        const entries = [getClass()] satisfies string[];
        const copied = entries;
        copied.push("runtime");
        return <div css={cx(entries, active && "extra")} />;
      };
      `,
      {
        jsxCssProp,
        extractCalls: { "custom-preset": ["css", "rules", "cx"] },
        optimize: { pureFunctions: false }
      }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": definition,
      "./theme.css.js": { getClass }
    };
    const sidecar = executeModule(result[1], modules);
    expect(getClass).not.toHaveBeenCalled();
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    const Box = runtime.Box as (props: { active: boolean }) => {
      props: { className: string };
    };

    for (const active of [false, true]) {
      getClass.mockClear();
      expect(Box({ active }).props.className).toBe(
        definition.cx(
          definition.css({ padding: 4 }),
          "runtime",
          active && "extra"
        )
      );
      expect(getClass).toHaveBeenCalledOnce();
    }
  });
});

describe("owned destructuring read publication", () => {
  beforeEach(() => setFileScope("owned-pattern.css.ts", "owned-pattern"));
  afterEach(() => endFileScope());
  it("keeps factory and getter counts in one mandatory build group", () => {
    const events: string[] = [];
    const getStyles = () => {
      events.push("factory");
      return {
        get first() {
          events.push("first");
          return { padding: 4 };
        },
        get second() {
          events.push("second");
          return { padding: 8 };
        }
      };
    };
    const { code, result } = babelTransform(
      `import {getStyles} from './theme.css.js'; export const Box=()=>{const {first,second}=getStyles();return [<div css={first}/>,<div css={second}/>]}`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    expect(events).toEqual(["factory", "first", "second"]);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    (runtime.Box as () => unknown)();
    (runtime.Box as () => unknown)();
    expect(events).toEqual(["factory", "first", "second"]);
  });
  it.each(["observe(second);", "globalThis.saved=second;"])(
    "does not use an owned Get receipt with a runtime sibling: %s",
    (runtime) => {
      expect(() =>
        babelTransform(
          `import {getStyles} from './theme.css.js'; export const Box=()=>{const {first,second}=getStyles();${runtime}return <div css={first}/>}`,
          { jsxCssProp, optimize: { pureFunctions: false } }
        )
      ).toThrow();
    }
  );
  it.each(["getStyles()", "getStyles() as Pair"])(
    "fails closed when a mandatory factory extraction is explicitly ignored: %s",
    (initializer) => {
      expect(() =>
        babelTransform(
          `import {getStyles} from './theme.css.js'; export const Box=()=>{/* mincho-js-ignore */const {first,second}=${initializer};return [<div css={first}/>,<div css={second}/>]}`,
          { jsxCssProp, optimize: { pureFunctions: false } }
        )
      ).toThrow(/ignored/i);
    }
  );
});
describe("destructuring owner families", () => {
  beforeEach(() => setFileScope("owner-families.css.ts", "owner-families"));
  afterEach(() => endFileScope());
  it.each([
    "const [first,second]=getStyles();",
    "const [first,second]=getStyles() as [{padding:number}, {padding:number}];",
    "const styles=getStyles();const [first,second]=styles;",
    "const [one,two]=getStyles();const first=one;const second=two;"
  ])("removes the runtime producer across %s", (declaration) => {
    const getStyles = vi.fn(() => [{ padding: 4 }, { padding: 8 }]);
    const { code, result } = babelTransform(
      `import {getStyles} from './theme.css.js';export const Box=()=>{${declaration}return [<div css={first}/>,<div css={second}/>]}`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    (runtime.Box as () => unknown)();
    (runtime.Box as () => unknown)();
    expect(getStyles).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "publishes an ordinary first/second CSS producer compound=%s",
    (compound) => {
      const source = `import {getFirst} from "./first.css.js"; import {getSecond} from "./second.css.js";
    export const Box=()=> {
      const size=8;
      ${compound ? "const {first}=getFirst(), {second}=getSecond(size);" : "const {first}=getFirst(); const {second}=getSecond(size);"}
      return [<div css={first}/>,<div css={second}/>];
    }`;
      const getFirst = vi.fn(() => ({ first: { padding: 4 } }));
      const getSecond = vi.fn((n: number) => ({ second: { padding: n } }));
      const authoredCss = vi.fn(css);
      const { code, result } = babelTransform(source, {
        jsxCssProp,
        optimize: { pureFunctions: false }
      });
      const deps = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: authoredCss },
        "./first.css.js": { getFirst },
        "./second.css.js": { getSecond }
      };
      const sidecar = executeModule(result[1], deps);
      const runtime = executeModule(code, { ...deps, [result[0]]: sidecar });
      const Box = runtime.Box as () => { props: { className: string } }[];
      expect(authoredCss.mock.calls).toEqual([
        [{ padding: 4 }],
        [{ padding: 8 }]
      ]);
      expect(Box().map((x) => x.props.className)).toEqual(
        authoredCss.mock.results.map((r) => r.value)
      );
      expect(getFirst).toHaveBeenCalledTimes(1);
      expect(getSecond).toHaveBeenCalledTimes(1);
    }
  );

  it("does not copy or delete unrelated sibling initializers", () => {
    const events: string[] = [];
    const getStyles = vi.fn(() => ({
      first: { padding: 4 },
      second: { padding: 8 }
    }));
    const observe = (tag: string) => {
      events.push(tag);
      return tag;
    };
    const { code, result } = babelTransform(
      `import {getStyles} from './theme.css.js';import {observe} from './runtime.js';export const Box=()=>{const before=observe('before'),{first,second}=getStyles(),after=observe('after');return [before,<div css={first}/>,<div css={second}/>,after]}`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles },
      "./runtime.js": { observe }
    };
    const sidecar = executeModule(result[1], modules);
    expect(events).toEqual([]);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    (runtime.Box as () => unknown)();
    (runtime.Box as () => unknown)();
    expect(events).toEqual(["before", "after", "before", "after"]);
    expect(getStyles).toHaveBeenCalledTimes(1);
  });
  it("retains a referenced sibling dependency in the sidecar", () => {
    const getStyles = vi.fn((size: number) => ({
      first: { padding: size },
      second: { padding: size + 4 }
    }));
    const { code, result } = babelTransform(
      `import {getStyles} from './theme.css.js';export const Box=()=>{const size=4,{first,second}=getStyles(size);return [size,<div css={first}/>,<div css={second}/>]}`,
      { jsxCssProp, optimize: { pureFunctions: false } }
    );
    const modules = {
      "@mincho-js/css": { mincho$ },
      "@mincho-js/css/classname": { cx },
      "custom-preset": { css },
      "./theme.css.js": { getStyles }
    };
    const sidecar = executeModule(result[1], modules);
    const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
    expect((runtime.Box as () => unknown[])()[0]).toBe(4);
    expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
  });
});

describe("unreachable JSX CSS arms", () => {
  it.each([false, true])(
    "does not lower CSS operands in a dead JSX element (%s)",
    (reachable) => {
      const configuredCss = vi.fn(() => "compiled-padding");
      const { code, result } = babelTransform(
        `export const Box = () => ${reachable} && <div css={[false, {padding: 12}]} />;`,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "custom-preset": { css: configuredCss, cx },
        "@mincho-js/css/classname": { cx },
        "@mincho-js/css": { mincho$ }
      };
      const sidecar = executeModule(result[1], modules);
      const { Box } = executeModule(code, {
        ...modules,
        [result[0]]: sidecar
      }) as {
        Box(): false | { props: { className: string } };
      };
      const rendered = Box();
      if (reachable) {
        expect(rendered && rendered.props.className).toBe("compiled-padding");
        expect(configuredCss).toHaveBeenCalledExactlyOnceWith({ padding: 12 });
      } else {
        expect(rendered).toBe(false);
        expect(configuredCss).not.toHaveBeenCalled();
        expect(result[1]).toBe("");
      }
    }
  );

  it.each(["true", "false", "active"])(
    "classifies only reachable CSS when the condition is %s",
    (condition) => {
      const selection =
        condition === "false"
          ? 'false ? value : "base"'
          : condition + ' ? "base" : value';
      const source = `
      import { getStyles } from "./theme.css.js";
      export function Box(active) {
        const [value] = active ? getStyles() : [{padding: 4}];
        return <div css={${selection}} />;
      }
    `;
      const transform = () =>
        babelTransform(source, {
          jsxCssProp,
          optimize: { pureFunctions: false }
        });
      if (condition === "active") {
        expect(transform).toThrow(
          /Destructured CSS factory values must be statically evaluable/
        );
        return;
      }
      const { code, result } = transform();
      const getStyles = vi.fn(() => ["purple"]);
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "./theme.css.js": { getStyles },
        "custom-preset": { css, cx }
      };
      const sidecar = executeModule(result[1], modules);
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as (active: boolean) => {
        props: { className: string };
      };
      expect(Box(false).props.className).toBe("base");
      expect(Box(true).props.className).toBe("base");
      expect(getStyles).toHaveBeenCalledOnce();
    }
  );
});

describe("known JSX pattern factory selections", () => {
  beforeEach(() =>
    setFileScope("known-conditional.css.ts", "known-conditional-fixture")
  );
  afterEach(() => endFileScope());

  it.each([
    ["direct", "getStyles()"],
    ["then", "true ? getStyles() : []"],
    ["else", "false ? [] : getStyles()"],
    ["nested", "true ? (false ? [] : getStyles()) : []"],
    ["logical and", "true && getStyles()"],
    ["mixed nested", "true && (false ? [] : getStyles())"],
    ["selected alias", "true ? pair : []", "const pair = getStyles();"],
    [
      "selected reversed alias",
      "false ? [] : alias",
      "const pair = getStyles(); const alias = pair;"
    ]
  ])(
    "publishes the selected %s pattern initializer once",
    (_variant, init, aliases = "") => {
      const getStyles = vi.fn(() => [{ padding: 4 }, { padding: 12 }]);
      const unrelated = vi.fn(() => "retained");
      const configuredCss = vi.fn(css);
      const { code, result } = babelTransform(
        `
      import {getStyles} from "./theme.css.js";
      import {unrelated} from "./runtime.js";
      export const Box = () => {
        ${aliases}
        const [first, second] = ${init}, retained = unrelated();
        return { first: <div css={first} />, second: <span css={second} />, retained };
      };
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const modules = {
        "@mincho-js/css": { mincho$ },
        "@mincho-js/css/classname": { cx },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { getStyles },
        "./runtime.js": { unrelated }
      };
      const sidecar = executeModule(result[1], modules);
      expect(unrelated).not.toHaveBeenCalled();
      const runtime = executeModule(code, { ...modules, [result[0]]: sidecar });
      const Box = runtime.Box as () => {
        first: { props: { className: string } };
        second: { props: { className: string } };
        retained: string;
      };
      const result1 = Box();
      const result2 = Box();
      expect(configuredCss.mock.calls).toEqual([
        [{ padding: 4 }],
        [{ padding: 12 }]
      ]);
      for (const frame of [result1, result2]) {
        expect(frame.retained).toBe("retained");
        expect(frame.first.props.className).toBe(
          configuredCss.mock.results[0].value
        );
        expect(frame.second.props.className).toBe(
          configuredCss.mock.results[1].value
        );
      }
      expect(getStyles).toHaveBeenCalledOnce();
      expect(unrelated).toHaveBeenCalledTimes(2);
      expect(code).not.toContain("getStyles(");
    }
  );
});

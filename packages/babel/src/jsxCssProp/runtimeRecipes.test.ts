import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { css, defineRules, mincho$, rules } from "@mincho-js/css";
import { cx } from "@mincho-js/css/classname";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { babelTransform } from "../testUtils/plugin.js";

const jsxCssProp = { importSource: "custom-preset" };

function executeSidecar(source: string, modules: Record<string, unknown>) {
  return Object.values(executeModule(source, modules));
}

function executeModule(source: string, modules: Record<string, unknown>) {
  const output = transformSync(source, {
    loader: "tsx",
    format: "cjs",
    jsxFactory: "jsx"
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
      if (destructure) {
        expect(getStyles).toHaveBeenCalledExactlyOnceWith(4);
      } else {
        expect(getStyles).not.toHaveBeenCalled();
        expect(code).not.toContain("getStyles(");
      }
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
  ])("prepares static factories inside CSS-value arrays: %s", (expression) => {
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
      "custom-preset": { css: configuredCss },
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
      const { result } = babelTransform(
        `
      import {recipe} from "./theme.css.js";
      export const Box = () => <div css={${expression}} />;
    `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
      const values = executeSidecar(result[1], {
        "@mincho-js/css": { mincho$ },
        "custom-preset": { css: configuredCss },
        "./theme.css.js": { recipe }
      });

      expect(values).toEqual([recipe()]);
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
    "const { size = readSize() } = {};",
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
    ["const { size = spacing } = {};", 4],
    ["const { size = spacing * 2 } = {};", 8],
    ["const [size = spacing + spacing] = [];", 8],
    ["const { [spacing * 2]: size } = { 8: 8 };", 8],
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
      const { code, result } = babelTransform(
        `
      import { getStyles } from "./theme.css.js";
      import { spacing } from "./tokens.js";
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

  it.each([
    "const { size = spacing } = {};",
    "const { [spacing * 2]: size } = { 8: 4 };",
    "const size = spacing;"
  ])(
    "resolves static factory declarations before consumer shadowing: %s",
    (declaration) => {
      const getStyles = vi.fn((padding: number) => ({ padding }));
      const { code, result } = babelTransform(
        `
        import { getStyles } from "./theme.css.js";
        import { spacing } from "./tokens.js";
        ${declaration}
        export const Box = ({ spacing }) => <div css={getStyles(size)} />;
      `,
        { jsxCssProp, optimize: { pureFunctions: false } }
      );
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
      const { code, result } = babelTransform(
        `
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

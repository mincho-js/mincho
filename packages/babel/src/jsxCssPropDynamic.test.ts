import { describe, expect, it } from "vitest";
import { STATIC_CSS_EVAL_LIMITS } from "./staticCssEval/types.js";
import {
  babelTransform,
  captureJsxCssPropFailure,
  collectDynamicCssVariableRuleSnapshot,
  createUnsupportedReexportStaticCssEvalProvider,
  jsxCssPropErrorMessages,
  reactStyleGuidancePattern,
  runJsxCssPropRuntime,
  staticShapeDiagnosticPattern
} from "./testUtils/plugin.js";

describe("minchoBabelPlugin", () => {
  it("lowers simple dynamic css variable leaf into generated artifact and inline style", () => {
    const { result, code } = babelTransform(
      `
        function App(props) {
          return <div css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
    expect(result[1]).toMatch(/_minchoGetVarName\d*\(/);
    expect(result[1]).toContain("_css({");
    expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
    expect(code).toMatch(/from "extracted_[^"]+\.css\.ts"/);
    expect(code).toContain(
      'import { vx as _vx } from "@mincho-js/transform-runtime";'
    );
    expect(code).toContain("className=");
    expect(code).toMatch(
      /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
    );
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).not.toContain("ix");
    expect(code).not.toMatch(/vx[^\n]+from "@mincho-js\/css"/);
  });

  it("lowers static-shape array spread dynamic leaves through CSS variables and rejects runtime spreads", () => {
    const source = `
        const base = [{ display: "flex" }];

        function App(props: { gap: number }) {
          return <div css={[...base, { gap: props.gap }]} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App({ gap: 12 });
        return { props, hasCss: "css" in props };
      `
    );

    const runtimeSpreadFailure = captureJsxCssPropFailure(
      `
        function App(props: { styles: readonly Record<string, string>[]; color: string }) {
          return <div css={[...props.styles, { color: props.color }]} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toContain("_css([");
    expect(result[1]).toContain('display: "flex"');
    expect(result[1]).toMatch(/gap: _\$mincho\$\$App\w*GapVar/);
    expect(code).toContain(
      'import { vx as _vx } from "@mincho-js/transform-runtime";'
    );
    expect(code).toContain("_vx(props.gap)");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(observed).toEqual({
      hasCss: false,
      props: { className: "css-rule", style: { "css-rule": 12 } }
    });
    expect(runtimeSpreadFailure.error.message).toMatch(
      /Mincho `css` requires statically known CSS shape|array values do not support spread elements|spread operand is not statically reducible/
    );
    expect(runtimeSpreadFailure.code).not.toContain("_css(");
  });

  it("lowers dynamic css variable expression matrix into vx values", () => {
    const { result, code } = babelTransform(
      `
        function getValue(value: number) {
          return value;
        }

        class Card {
          size = 12;

          render() {
            return <div css={{ borderWidth: this.size }} />;
          }
        }

        function App(props: {
          enabled: boolean;
          fallback: number;
          frequency: number;
          gap: number;
          offset: number;
          percent: number;
          ratio: number;
          resolution: number;
          root?: { gap: number };
          size: number;
          value: number | null;
        }) {
          const enabled = props.enabled;
          const fallback = props.fallback;
          const frequency = props.frequency;
          const gap = props.gap;
          const offset = props.offset;
          const percent = props.percent;
          const ratio = props.ratio;
          const resolution = props.resolution;
          const root = props.root;
          const size = props.size;
          const value = props.value;

          return <>
            <div css={{ width: size + 100 }} />
            <div css={{ margin: \`${"${gap}"}px\` }} />
            <div css={{ inset: \`${"${percent}"}%\` }} />
            <div css={{ padding: \`${"${root?.gap}"}rem\` }} />
            <div css={{ marginBlock: \`${"${size}"}em\` }} />
            <div css={{ letterSpacing: \`${"${size}"}Q\` }} />
            <div css={{ blockSize: \`${"${size}"}svh\` }} />
            <div css={{ inlineSize: \`${"${size}"}cqw\` }} />
            <div css={{ rotate: \`${"${offset}"}deg\` }} />
            <div css={{ transitionDuration: \`${"${size}"}ms\` }} />
            <div css={{ pitch: \`${"${frequency}"}Hz\` }} />
            <div css={{ pitch: \`${"${frequency}"}KHz\` }} />
            <div css={{ gridTemplateColumns: \`${"${ratio}"}fr\` }} />
            <div css={{ imageResolution: \`${"${resolution}"}dpi\` }} />
            <div css={{ imageResolution: \`${"${resolution}"}x\` }} />
            <div css={{ color: enabled ? "red" : "blue" }} />
            <div css={{ opacity: value ?? fallback }} />
            <div css={{ height: +size }} />
            <div css={{ top: -offset }} />
            <div css={{ lineHeight: getValue(size) }} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(22);
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).toContain(
      'import { vx as _vx } from "@mincho-js/transform-runtime";'
    );
    expect(code).toContain("_vx(size + 100)");
    expect(code).toContain('_vx(gap, "px")');
    expect(code).toContain('_vx(percent, "%")');
    expect(code).toContain('_vx(root?.gap, "rem")');
    expect(code).toContain('_vx(size, "em")');
    expect(code).toContain('_vx(size, "Q")');
    expect(code).toContain('_vx(size, "svh")');
    expect(code).toContain('_vx(size, "cqw")');
    expect(code).toContain('_vx(offset, "deg")');
    expect(code).toContain('_vx(size, "ms")');
    expect(code).toContain('_vx(frequency, "Hz")');
    expect(code).toContain('_vx(frequency, "KHz")');
    expect(code).toContain('_vx(ratio, "fr")');
    expect(code).toContain('_vx(resolution, "dpi")');
    expect(code).toContain('_vx(resolution, "x")');
    expect(code).not.toContain('enabled ? _vx("red") : _vx("blue")');
    expect(code).toContain("_vx(value ?? fallback)");
    expect(code).toContain("_vx(+size)");
    expect(code).toContain("_vx(-offset)");
    expect(code).toContain("_vx(getValue(size))");
    expect(code).toContain("_vx(this.size)");
  });

  it("lowers static conditional declaration leaves to conditional class fragments", () => {
    const { result, code } = babelTransform(
      `
        function App(active: boolean) {
          return <div css={{ color: active ? "red" : "blue" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(2);
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).not.toContain("createVar");
    expect(result[1]).not.toContain("getVarName");
    expect(code).toContain("className={active ?");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("style=");
    expect(code).not.toContain("_vx(");
    expect(code).not.toContain("@mincho-js/transform-runtime");
  });

  it("lowers mixed and dynamic conditional declaration leaves through lazy branch fragments", () => {
    const source = `
        const events: string[] = [];
        const state = { active: true };
        const activeColor = {
          get value() {
            events.push("active");
            return "tomato";
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            throw new Error("inactive branch evaluated");
          }
        };

        function MixedApp() {
          return <div css={{ color: state.active ? "red" : inactiveColor.value }} />;
        }

        function DynamicApp() {
          return <section css={{ color: state.active ? activeColor.value : inactiveColor.value }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const mixed = MixedApp();
        const dynamic = DynamicApp();
        return { mixed, dynamic, events };
      `
    );

    expect(code).toContain(
      'import { vx as _vx } from "@mincho-js/transform-runtime";'
    );
    expect(code).toContain("const _minchoCssBranch = state.active;");
    expect(code).toContain("...(_minchoCssBranch ?");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain('_vx("red")');
    expect(observed).toEqual({
      mixed: { className: "css-rule", style: {} },
      dynamic: { className: "css-rule", style: { "css-rule": "tomato" } },
      events: ["active"]
    });
  });

  it("lowers nested conditional and logical declaration leaves without inactive style entries", () => {
    const source = `
        const events: string[] = [];
        const state = { active: true, primary: false };
        const guard = { enabled: false };
        const nested = {
          get value() {
            events.push("nested");
            return "purple";
          }
        };
        const guarded = {
          get value() {
            events.push("guarded");
            throw new Error("logical branch evaluated");
          }
        };
        const fallback = {
          get value() {
            events.push("fallback");
            return "blue";
          }
        };

        function NestedApp() {
          return <div css={{ color: state.active ? (state.primary ? "red" : nested.value) : "gray" }} />;
        }

        function LogicalApp() {
          return <section css={{ color: guard.enabled && guarded.value }} />;
        }

        function NullishApp(value: string | null | undefined) {
          return <article css={{ color: value ?? fallback.value }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const nestedProps = NestedApp();
        const logicalProps = LogicalApp();
        const nullishProps = NullishApp(null);
        return { nestedProps, logicalProps, nullishProps, events };
      `
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(/const _minchoCssBranch\d* = guard\.enabled;/);
    expect(code).toContain("...(_minchoCssBranch");
    expect(observed).toEqual({
      nestedProps: {
        className: "css-rule",
        style: { "css-rule": "purple" }
      },
      logicalProps: { className: "", style: {} },
      nullishProps: {
        className: "css-rule",
        style: { "css-rule": "blue" }
      },
      events: ["nested", "fallback"]
    });
  });

  it("lowers static conditional object fragments through branch classes", () => {
    const { result, code } = babelTransform(
      `
        function App(active: boolean, fallback: boolean) {
          return <div css={{
            display: "block",
            ...active && { color: "red" },
            ...fallback || { backgroundColor: "blue" }
          }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(4);
    expect(result[1]).toContain('display: "block"');
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('backgroundColor: "blue"');
    expect(result[1]).not.toContain("createVar");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("style=");
    expect(code).toContain("className={_cx(active ?");
    expect(code).toContain("fallback ?");
  });

  it("lowers mixed conditional object fragments without inactive getter reads", () => {
    const source = `
        const events: string[] = [];
        const state = { active: true, fallback: false, tone: true };
        const activeColor = {
          get value() {
            events.push("active");
            return "tomato";
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            throw new Error("inactive object fragment evaluated");
          }
        };
        const fallbackColor = {
          get value() {
            events.push("fallback");
            return "gold";
          }
        };

        function App() {
          return <div css={{
            padding: 4,
            ...state.active && { color: activeColor.value },
            borderColor: state.tone ? "black" : inactiveColor.value,
            ...state.fallback || { backgroundColor: fallbackColor.value },
            margin: 8
          }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style) };
      `
    ) as {
      props: Record<string, unknown>;
      events: string[];
      styleKeys: string[];
    };

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).toContain("const _minchoCssBranch = state.active;");
    expect(code).toMatch(
      /const _minchoCssBranch\d* = .* \? state\.fallback : void 0;/
    );
    expect(code).toContain("...(_minchoCssBranch ?");
    expect(observed.events).toEqual(["active", "fallback"]);
    expect(observed.styleKeys).toEqual(["css-rule"]);
    expect(observed.props).toMatchObject({
      className: "css-rule",
      style: { "css-rule": "gold" }
    });
  });

  it("lowers ternary conditional object fragments when both branches are statically shaped", () => {
    const source = `
        const events: string[] = [];
        const state = { active: false };
        const activeColor = {
          get value() {
            events.push("active");
            throw new Error("active object fragment evaluated");
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          return <div css={{
            ...(state.active ? { color: activeColor.value } : { backgroundColor: inactiveColor.value })
          }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App();
        return { props, events };
      `
    ) as { props: Record<string, unknown>; events: string[] };

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).toContain("className={_minchoCssBranch ?");
    expect(code).toContain("...(_minchoCssBranch ?");
    expect(observed.events).toEqual(["inactive"]);
    expect(observed.props).toMatchObject({
      className: "css-rule",
      style: { "css-rule": "blue" }
    });
  });

  it("rejects unsupported arbitrary spread conditional object fragments", () => {
    const fixtures = [
      {
        label: "logical arbitrary object spread",
        source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...active && props.styles, color: "red" }} />;
            }
          `
      },
      {
        label: "ternary arbitrary object spread",
        source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...(active ? props.styles : { color: "red" }) }} />;
            }
          `
      },
      {
        label: "direct arbitrary object spread remains rejected",
        source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape|Complex conditions are supported only when branch CSS shape is static/
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("rejects runtime-shape conditionals before CSS emission", () => {
    const failure = captureJsxCssPropFailure(
      `
        function App(active: boolean, props: { key: string }) {
          return <div css={active ? { [props.key]: "red" } : { color: "blue" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(failure.error.message).toMatch(
      /dynamic expression is unsupported|unsupported identifier-object-value|Mincho JSX css prop|Complex conditions are supported only when branch CSS shape is static/
    );
    expect(failure.code).not.toContain("_css(");
    expect(failure.code).not.toContain("style={{");
  });

  it("blocks inherited generated custom property values for nullish and boolean dynamic leaves without @property output", () => {
    const source = `
        function Parent(value: string) {
          return <div css={{ color: value }} />;
        }

        function Child(value: string | null | undefined | boolean) {
          return <div css={{ color: value }} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const parent = Parent("parent-color");
        const generatedKey = Object.keys(parent.style)[0];
        const parentValue = parent.style[generatedKey];
        const cases = [
          ["undefined", undefined],
          ["null", null],
          ["false", false],
          ["true", true]
        ];
        const resolveGeneratedColor = (childStyle) => {
          const childValue = childStyle[generatedKey];

          if (
            childValue === undefined ||
            childValue === null ||
            typeof childValue === "boolean"
          ) {
            return parentValue;
          }

          if (childValue === "var(--c-, )") {
            return null;
          }

          return childValue;
        };

        return cases.map(([label, value]) => {
          const child = Child(value);

          return {
            label,
            childCustomPropertyValue: child.style[generatedKey],
            inheritedParentValue:
              resolveGeneratedColor(child.style) === parentValue
          };
        });
      `
    );

    expect(
      result[1],
      "Mincho has no approved output-layer plan for StyleX @property generation; vx fallback is this scope's inheritance guard."
    ).not.toContain("@property");
    expect(code).not.toContain("@property");
    expect(code).toContain(
      'import { vx as _vx } from "@mincho-js/transform-runtime";'
    );
    expect(code).toContain("_vx(value)");
    expect(observed).toEqual([
      {
        label: "undefined",
        childCustomPropertyValue: "var(--c-, )",
        inheritedParentValue: false
      },
      {
        label: "null",
        childCustomPropertyValue: "var(--c-, )",
        inheritedParentValue: false
      },
      {
        label: "false",
        childCustomPropertyValue: "var(--c-, )",
        inheritedParentValue: false
      },
      {
        label: "true",
        childCustomPropertyValue: "var(--c-, )",
        inheritedParentValue: false
      }
    ]);
  });

  it("rejects unsupported dynamic css variable value expressions", () => {
    const fixtures = [
      {
        label: "assignment",
        source: `
            let size = 1;
            function App() {
              return <div css={{ width: (size = 2) }} />;
            }
          `
      },
      {
        label: "update",
        source: `
            let size = 1;
            function App() {
              return <div css={{ width: size++ }} />;
            }
          `
      },
      {
        label: "sequence",
        source: `
            function App(size: number, fallback: number) {
              return <div css={{ width: (size, fallback) }} />;
            }
          `
      },
      {
        label: "await",
        source: `
            async function App(size: Promise<number>) {
              return <div css={{ width: await size }} />;
            }
          `
      },
      {
        label: "yield",
        source: `
            function* App(size: number) {
              return <div css={{ width: yield size }} />;
            }
          `
      },
      {
        label: "new",
        source: `
            class Size {}
            function App() {
              return <div css={{ width: new Size() }} />;
            }
          `
      },
      {
        label: "array value",
        source: `
            function App(size: number) {
              return <div css={{ width: [size] }} />;
            }
          `
      },
      {
        label: "function value",
        source: `
            function App(size: number) {
              return <div css={{ width: () => size }} />;
            }
          `
      },
      {
        label: "class value",
        source: `
            function App() {
              return <div css={{ width: class Size {} }} />;
            }
          `
      },
      {
        label: "jsx value",
        source: `
            function App() {
              return <div css={{ width: <span /> }} />;
            }
          `
      },
      {
        label: "tagged template",
        source: `
            function unit(strings: TemplateStringsArray, value: number) {
              return value;
            }
            function App(size: number) {
              return <div css={{ width: unit\`${"${size}"}px\` }} />;
            }
          `
      },
      {
        label: "multi-hole template",
        source: `
            function App(size: number, unit: string) {
              return <div css={{ width: \`${"${size}"}${"${unit}"}\` }} />;
            }
          `
      },
      {
        label: "unsafe template affix",
        source: `
            function App(size: number) {
              return <div css={{ width: \`calc(${"${size}"}px)\` }} />;
            }
          `
      },
      {
        label: "unicode-folded template suffix",
        source: `
            function App(frequency: number) {
              return <div css={{ pitch: \`${"${frequency}"}KHz\` }} />;
            }
          `
      },
      {
        label: "comparison",
        source: `
            function App(size: number) {
              return <div css={{ width: size > 1 }} />;
            }
          `
      },
      {
        label: "bitwise",
        source: `
            function App(size: number) {
              return <div css={{ width: size | 1 }} />;
            }
          `
      },
      {
        label: "in operator",
        source: `
            function App(props: Record<string, unknown>) {
              return <div css={{ width: "size" in props }} />;
            }
          `
      },
      {
        label: "instanceof operator",
        source: `
            class Size {}
            function App(value: unknown) {
              return <div css={{ width: value instanceof Size }} />;
            }
          `
      },
      {
        label: "dynamic key",
        source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        /Cannot statically evaluate|Mincho JSX css prop/
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("rejects dynamic arrays in direct, conditional leaf, and conditional fragment contexts", () => {
    const fixtures = [
      {
        label: "direct dynamic property array",
        source: `
            function App(props: { gap: number }) {
              return <div css={{ margin: [props.gap, "auto"] }} />;
            }
          `
      },
      {
        label: "conditional dynamic property array",
        source: `
            function App(props: { compact: boolean; gap: number }) {
              return <div css={{ margin: props.compact ? [props.gap] : ["auto"] }} />;
            }
          `
      },
      {
        label: "conditional object fragment dynamic property array",
        source: `
            function App(props: { active: boolean; gap: number }) {
              return <div css={{ ...props.active && { margin: [props.gap, "auto"] } }} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape/
      );
      expect(failure.error.message, label).not.toMatch(
        reactStyleGuidancePattern
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("routes static-key render values through dynamic-leaf mode", () => {
    const { result, code } = babelTransform(
      `
        function App(props: { color: string }) {
          return <div css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
    expect(result[1]).toContain("_css({");
    expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("style={{ color: props.color }}");
    expect(code).toMatch(
      /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
    );
  });

  it("routes uncommon static keys through dynamic-leaf mode without a property allowlist", () => {
    const { result, code } = babelTransform(
      `
        function App(props: { accent: string; scrollbar: string }) {
          return <div css={{ "--brand-accent": props.accent, scrollbarColor: props.scrollbar }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toContain('_minchoCreateVar("--brand-accent")');
    expect(result[1]).toContain('_minchoCreateVar("scrollbarColor")');
    expect(result[1]).toContain(
      '"--brand-accent": _$mincho$$AppBrandAccentVar'
    );
    expect(result[1]).toContain(
      "scrollbarColor: _$mincho$$AppScrollbarColorVar"
    );
    expect(code).toContain("_vx(props.accent)");
    expect(code).toContain("_vx(props.scrollbar)");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain('style={{ "--brand-accent": props.accent');
  });

  it("dynamic CSS variable style custom property supports props.color and render-scope makeColor", () => {
    const { result, code } = babelTransform(
      `
        function App(props: {
          color: string;
          hoverColor: string;
          background: string;
        }) {
          function makeColor() {
            return props.color;
          }

          return <>
            <div css={{ _hover: { color: props.hoverColor } }} />
            <section css={[
              { color: makeColor() },
              { background: props.background }
            ]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const artifact = result[1];

    expect(artifact).toContain("_css({");
    expect(artifact).toContain("_css([");
    expect(artifact).toContain("_hover: {");
    expect(artifact).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
    expect(artifact).toMatch(/background: _\$mincho\$\$App\w*BackgroundVar/);
    expect(code).toContain("props.hoverColor");
    expect(code).toContain("makeColor()");
    expect(code).toContain("props.background");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).not.toContain("style={{ color:");
    expect(code.match(/style=\{\{/g) ?? []).toHaveLength(2);
  });

  it("lowers dynamic css variable and static css prop without duplicate css helper aliases", () => {
    const { result, code } = babelTransform(
      `
        function App(props) {
          return <>
            <div css={{ color: "red" }} />
            <section css={{ color: props.color }} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const artifact = result[1];

    expect(artifact.match(/css as _css/g) ?? []).toHaveLength(1);
    expect(artifact).toMatch(/_minchoCreateVar\d*\(/);
    expect(artifact).toMatch(/_minchoGetVarName\d*\(/);
    expect(artifact).toContain('color: "red"');
    expect(artifact).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
  });

  it("lowers dynamic css variable source helper imports without duplicate helper declarations", () => {
    const createVarCase = babelTransform(
      `
        import { createVar } from "@mincho-js/css";

        const external = createVar("external");

        function App(props) {
          return <div data-var={external} css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const getVarNameCase = babelTransform(
      `
        import { getVarName } from "@mincho-js/css";

        const external = getVarName("external");

        function App(props) {
          return <div data-var={external} css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(createVarCase.result[1].match(/css as _css/g) ?? []).toHaveLength(1);
    expect(createVarCase.result[1]).toContain('createVar("external")');
    expect(createVarCase.result[1]).toMatch(/createVar as _minchoCreateVar\d*/);
    expect(createVarCase.result[1]).toMatch(
      /getVarName as _minchoGetVarName\d*/
    );
    expect(createVarCase.result[1]).toMatch(
      /color: _\$mincho\$\$App\w*ColorVar/
    );
    expect(createVarCase.code).not.toContain("_css(");
    expect(createVarCase.code).not.toContain("createVar(");
    expect(createVarCase.code).not.toContain("getVarName(");

    expect(getVarNameCase.result[1].match(/css as _css/g) ?? []).toHaveLength(
      1
    );
    expect(getVarNameCase.result[1]).toMatch(
      /createVar as _minchoCreateVar\d*/
    );
    expect(getVarNameCase.result[1]).toMatch(
      /getVarName as _minchoGetVarName\d*/
    );
    expect(getVarNameCase.result[1]).toMatch(
      /color: _\$mincho\$\$App\w*ColorVar/
    );
    expect(getVarNameCase.code).toContain('getVarName("external")');
    expect(getVarNameCase.code).not.toContain("_css(");
  });

  it("emits dynamic css variable style merge without existing style", () => {
    const { code } = babelTransform(
      `
        function App(props) {
          return <div css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).toMatch(
      /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
    );
    expect(code).not.toContain(" css=");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).not.toContain("_css(");
  });

  it("merges dynamic css variable style merge after object and expression styles", () => {
    const objectStyle = babelTransform(
      `
        function App(props) {
          const baseStyle = props.baseStyle;
          return <div
            style={{ ...baseStyle, opacity: props.opacity }}
            css={{ color: props.color, backgroundColor: props.backgroundColor }}
          />;
        }
      `,
      { jsxCssProp: true }
    ).code;

    const expressionStyle = babelTransform(
      `
        function App(props) {
          return <section
            style={props.style}
            css={{ borderColor: props.borderColor }}
          />;
        }
      `,
      { jsxCssProp: true }
    ).code;

    expect(objectStyle).toMatch(
      /style=\{\{\s+\.\.\.baseStyle,\s+opacity: props\.opacity,\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\),\s+\[_\$mincho\$\$App\w*BackgroundColorVarKey\d*\]: _vx\(props\.backgroundColor\)\s+\}\}/
    );
    expect(expressionStyle).toMatch(
      /style=\{\{\s+\.\.\.props\.style,\s+\[_\$mincho\$\$App\w*BorderColorVarKey\d*\]: _vx\(props\.borderColor\)\s+\}\}/
    );

    for (const output of [objectStyle, expressionStyle]) {
      expect(output).not.toContain(" css=");
      expect(output).not.toContain('from "@mincho-js/css"');
      expect(output).not.toContain("createVar");
      expect(output).not.toContain("getVarName");
      expect(output).not.toContain("_css(");
    }
  });

  it("merges dynamic css variable style merge after existing className", () => {
    const { code } = babelTransform(
      `
        function App(props) {
          return <div className={props.className} css={{ color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).toMatch(
      /className=\{_\$mincho\$\$App\w*Cx\d*\(props\.className, _\$mincho\$\$App\d*\)\}/
    );
    expect(code).toMatch(
      /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
    );
    expect(code).not.toContain(" css=");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).not.toContain("_css(");
  });

  it("dynamic css variable spread aggregates pre and post styles before generated vars", () => {
    const source = `
        const pre = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre",
          style: { color: "pre" }
        };
        const post = {
          className: "from-post",
          css: "leak-post",
          title: "from-post",
          style: { backgroundColor: "post" }
        };

        function App() {
          const props = { color: "tomato" };
          return <div {...pre} css={{ color: props.color }} {...post} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
    );

    expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
    expect(result[1]).toMatch(/_minchoGetVarName\d*\(/);
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain("cx as");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain(" css=");
    expect(observed).toEqual({
      hasCss: false,
      styleKeys: ["color", "backgroundColor", "css-rule"],
      props: expect.objectContaining({
        className: "from-pre css-rule from-post",
        id: "from-pre",
        title: "from-post",
        style: {
          color: "pre",
          backgroundColor: "post",
          "css-rule": "tomato"
        }
      })
    });
  });

  it("dynamic css variable spread preserves explicit style before and after css", () => {
    const beforeCssStyle = runJsxCssPropRuntime(
      `
        const pre = {
          className: "from-pre",
          css: "leak-pre",
          style: { padding: 4 }
        };

        function App() {
          const props = { color: "tomato" };
          return <div {...pre} style={{ opacity: 0.5 }} css={{ color: props.color }} />;
        }
      `,
      `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
    );

    const afterCssStyle = runJsxCssPropRuntime(
      `
        const post = {
          className: "from-post",
          css: "leak-post",
          style: { margin: 8 }
        };

        function App() {
          const props = { color: "tomato" };
          return <div css={{ color: props.color }} style={{ opacity: 0.75 }} {...post} />;
        }
      `,
      `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
    );

    expect(beforeCssStyle).toEqual({
      hasCss: false,
      styleKeys: ["padding", "opacity", "css-rule"],
      props: expect.objectContaining({
        className: "from-pre css-rule",
        style: { padding: 4, opacity: 0.5, "css-rule": "tomato" }
      })
    });
    expect(afterCssStyle).toEqual({
      hasCss: false,
      styleKeys: ["opacity", "margin", "css-rule"],
      props: expect.objectContaining({
        className: "css-rule from-post",
        style: { opacity: 0.75, margin: 8, "css-rule": "tomato" }
      })
    });
  });

  it("style getter source order for dynamic css variable spread reads each contribution once", () => {
    const observed = runJsxCssPropRuntime(
      `
        const events: string[] = [];
        const reads = {
          preStyle: 0,
          preClassName: 0,
          preCss: 0,
          explicitStyle: 0,
          postStyle: 0,
          postClassName: 0,
          postCss: 0,
          dynamic: 0
        };
        const pre = {
          id: "from-pre",
          get style() {
            reads.preStyle += 1;
            events.push("pre.style");
            return { color: "pre" };
          },
          get className() {
            reads.preClassName += 1;
            events.push("pre.className");
            return "from-pre";
          },
          get css() {
            reads.preCss += 1;
            events.push("pre.css");
            return "leak-pre";
          }
        };
        const explicitStyle = {
          get value() {
            reads.explicitStyle += 1;
            events.push("explicit.style");
            return { opacity: 0.5 };
          }
        };
        const post = {
          title: "from-post",
          get style() {
            reads.postStyle += 1;
            events.push("post.style");
            return { backgroundColor: "post" };
          },
          get className() {
            reads.postClassName += 1;
            events.push("post.className");
            return "from-post";
          },
          get css() {
            reads.postCss += 1;
            events.push("post.css");
            return "leak-post";
          }
        };
        const model = {
          get color() {
            reads.dynamic += 1;
            events.push("dynamic");
            return "tomato";
          }
        };

        function App(props) {
          return <div {...pre} style={explicitStyle.value} css={{ color: props.color }} {...post} />;
        }
      `,
      `
        const props = App(model);
        return {
          props,
          events,
          reads,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
    );

    expect(observed).toEqual({
      events: [
        "pre.style",
        "pre.className",
        "pre.css",
        "explicit.style",
        "post.style",
        "post.className",
        "post.css",
        "dynamic"
      ],
      reads: {
        preStyle: 1,
        preClassName: 1,
        preCss: 1,
        explicitStyle: 1,
        postStyle: 1,
        postClassName: 1,
        postCss: 1,
        dynamic: 1
      },
      styleKeys: ["color", "opacity", "backgroundColor", "css-rule"],
      hasCss: false,
      props: expect.objectContaining({
        className: "from-pre css-rule from-post",
        id: "from-pre",
        title: "from-post",
        style: {
          color: "pre",
          opacity: 0.5,
          backgroundColor: "post",
          "css-rule": "tomato"
        }
      })
    });
  });

  it("rejects invalid dynamic css variable style merge values", () => {
    const fixtures = [
      `<div style css={{ color: props.color }} />`,
      `<div style="color:red" css={{ color: props.color }} />`,
      `<div style={"color:red"} css={{ color: props.color }} />`,
      `<div style={\`color:red\`} css={{ color: props.color }} />`
    ] as const;

    for (const fixture of fixtures) {
      const failure = captureJsxCssPropFailure(
        `
          function App(props) {
            return ${fixture};
          }
        `,
        { jsxCssProp: true }
      );

      expect(failure.error.message).toContain(
        jsxCssPropErrorMessages.styleValue
      );
      expect(failure.code).not.toContain("_css(");
    }
  });

  it("lowers dynamic css variable leaves across static object and array shapes", () => {
    const { result, code } = babelTransform(
      `
        function App(props) {
          return <>
            <div css={{
              color: props.color,
              backgroundColor: "white",
              borderColor: props.borderColor,
              selectors: {
                "&:hover": {
                  color: props.hoverColor
                }
              },
              "@media": {
                "screen and (min-width: 700px)": {
                  color: props.mediaColor
                }
              },
              opacity: {
                $disabled: props.disabledOpacity
              }
            }} />
            <section css={[
              { display: "block", color: props.sectionColor },
              { selectors: { "&:focus": { outlineColor: props.outlineColor } } }
            ]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const artifact = result[1];

    expect(artifact.match(/_minchoCreateVar\d*\(/g) ?? []).toHaveLength(7);
    expect(artifact.match(/_minchoGetVarName\d*\(/g) ?? []).toHaveLength(7);
    expect(artifact).toContain("_css({");
    expect(artifact).toContain("_css([");
    expect(artifact).toContain('backgroundColor: "white"');
    expect(artifact).toContain('display: "block"');
    expect(artifact).toContain("selectors: {");
    expect(artifact).toContain('"@media": {');
    expect(artifact).toContain('"&:hover": {');
    expect(artifact).toContain("$disabled: ");
    expect(artifact).not.toContain("props.");
    expect(code).toMatch(/from "extracted_[^"]+\.css\.ts"/);
    expect(code.match(/style=\{\{/g) ?? []).toHaveLength(2);
    expect(code).toContain("props.color");
    expect(code).toContain("props.borderColor");
    expect(code).toContain("props.hoverColor");
    expect(code).toContain("props.mediaColor");
    expect(code).toContain("props.disabledOpacity");
    expect(code).toContain("props.sectionColor");
    expect(code).toContain("props.outlineColor");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
  });

  it("keeps static css prop still unchanged without dynamic style emission", () => {
    const { result, code } = babelTransform(
      `
        function App() {
          return <>
            <div css={{
              color: "red",
              selectors: {
                "&:hover": {
                  color: "blue"
                }
              }
            }} />
            <section css={[{ display: "block" }, { color: "green" }]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("style=");
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain("_css([");
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('"&:hover": {');
    expect(result[1]).not.toContain("createVar(");
    expect(result[1]).not.toContain("getVarName(");
  });

  it("branch dynamic css variable evaluates once", () => {
    const source = `
        const events: string[] = [];
        const reads = {
          condition: 0,
          active: 0,
          inactive: 0
        };
        const state = {
          get condition() {
            reads.condition += 1;
            events.push("condition");
            return true;
          }
        };
        const active = {
          get color() {
            reads.active += 1;
            events.push("active");
            return "tomato";
          }
        };
        const inactive = {
          get color() {
            reads.inactive += 1;
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          return <div css={state.condition ? { color: active.color } : { color: inactive.color }} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const artifact = result[1];
    const observed = runJsxCssPropRuntime(
      source,
      "return { props: App(), events, reads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(artifact).toContain('import { css as _css } from "@mincho-js/css";');
    expect(artifact).toContain(
      'import { createVar as _minchoCreateVar, getVarName as _minchoGetVarName } from "@mincho-js/css";'
    );
    expect(
      artifact.match(
        /export var _\$mincho\$\$App\w*ColorVar\d* = _minchoCreateVar\("color"\);/g
      ) ?? []
    ).toHaveLength(2);
    expect(
      artifact.match(
        /export var _\$mincho\$\$App\w*ColorVarKey\d* = _minchoGetVarName\(_\$mincho\$\$App\w*ColorVar\d*\);/g
      ) ?? []
    ).toHaveLength(2);
    expect(
      artifact.match(
        /export var _\$mincho\$\$App\d* = _css\(\{\s+color: _\$mincho\$\$App\w*ColorVar\d*\s+\}\);/g
      ) ?? []
    ).toHaveLength(2);
    expect(code).toMatch(
      /import \{ _\$mincho\$\$App as _\$mincho\$\$App2, _\$mincho\$\$App3 as _\$mincho\$\$App4 \} from "extracted_[^"]+\.css\.ts";/
    );
    expect(code).toMatch(
      /import \{ _\$mincho\$\$App\w*ColorVarKey as _\$mincho\$\$App\w*ColorVarKey2, _\$mincho\$\$App\w*ColorVarKey3 as _\$mincho\$\$App\w*ColorVarKey4 \} from "extracted_[^"]+\.css\.ts";/
    );
    expect(code).toContain("const _minchoCssBranch = state.condition;");
    expect(code).toContain("className={_minchoCssBranch ?");
    expect(code).toContain("...(_minchoCssBranch ?");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code.match(/state\.condition/g) ?? []).toHaveLength(1);
    expect(observed.events).toEqual(["condition", "active"]);
    expect(observed.reads).toEqual({ condition: 1, active: 1, inactive: 0 });
    expect(observed.props).toMatchObject({
      className: "css-rule",
      style: { "css-rule": "tomato" }
    });
  });

  it("nested branch dynamic css variable decisions evaluate once", () => {
    const source = `
        const events: string[] = [];
        const reads = { outer: 0, inner: 0, inactive: 0 };
        const colors = { active: "tomato", other: "blue", fallback: "gray" };
        let inner = false;
        const decide = (name, value) => {
          reads[name] += 1;
          events.push(name);
          return value;
        };
        const flip = () => {
          events.push("flip");
          inner = true;
          return "flipped";
        };

        function App() {
          return <div css={decide("outer", true) ? decide("inner", inner) ? { color: colors.active } : { color: colors.other } : decide("inactive", false) && { color: colors.fallback }} data-flip={flip()} />;
        }
      `;

    const observed = runJsxCssPropRuntime(
      source,
      "return { props: App(), events, reads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(observed.events).toEqual(["outer", "inner", "flip"]);
    expect(observed.reads).toEqual({
      outer: 1,
      inner: 1,
      inactive: 0
    });
    expect(observed.props).toMatchObject({
      className: "css-rule",
      style: { "css-rule": "blue" },
      "data-flip": "flipped"
    });
  });

  it("conditional dynamic css variable style", () => {
    const source = `
        const events: string[] = [];
        const state = { condition: false };
        const primary = {
          get color() {
            events.push("primary");
            return "tomato";
          }
        };
        const fallback = {
          get color() {
            events.push("fallback");
            return "blue";
          }
        };

        function App() {
          return <div style={{ opacity: 0.5 }} css={state.condition ? { color: primary.color } : { color: fallback.color }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style) };
      `
    ) as {
      props: Record<string, unknown>;
      events: string[];
      styleKeys: string[];
    };

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(observed.events).toEqual(["fallback"]);
    expect(observed.styleKeys).toEqual(["opacity", "css-rule"]);
    expect(observed.props).toMatchObject({
      className: "css-rule",
      style: { opacity: 0.5, "css-rule": "blue" }
    });
  });

  it("logical dynamic css variable style", () => {
    const source = `
        const events: string[] = [];
        const reads = {
          condition: 0,
          guarded: 0,
          provided: 0,
          skippedFallback: 0,
          empty: 0,
          fallback: 0
        };
        const guard = {
          get condition() {
            reads.condition += 1;
            events.push("condition");
            return false;
          }
        };
        const provided = {
          get className() {
            reads.provided += 1;
            events.push("provided");
            return "provided";
          }
        };
        const empty = {
          get className() {
            reads.empty += 1;
            events.push("empty");
            return "";
          }
        };
        const guarded = {
          get color() {
            reads.guarded += 1;
            events.push("guarded");
            return "tomato";
          }
        };
        const skippedFallback = {
          get color() {
            reads.skippedFallback += 1;
            events.push("skipped-fallback");
            return "red";
          }
        };
        const fallback = {
          get color() {
            reads.fallback += 1;
            events.push("fallback");
            return "blue";
          }
        };

        function GuardedApp() {
          return <div css={guard.condition && { color: guarded.color }} />;
        }

        function ProvidedApp() {
          return <div css={provided.className || { color: skippedFallback.color }} />;
        }

        function FallbackApp() {
          return <div css={empty.className || { color: fallback.color }} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const guardedProps = GuardedApp();
        const providedProps = ProvidedApp();
        const fallbackProps = FallbackApp();
        return { guardedProps, providedProps, fallbackProps, events, reads };
      `
    ) as {
      guardedProps: Record<string, unknown>;
      providedProps: Record<string, unknown>;
      fallbackProps: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(code.match(/guard\.condition/g) ?? []).toHaveLength(1);
    expect(code.match(/provided\.className/g) ?? []).toHaveLength(1);
    expect(code.match(/empty\.className/g) ?? []).toHaveLength(1);
    expect(observed.events).toEqual([
      "condition",
      "provided",
      "empty",
      "fallback"
    ]);
    expect(observed.reads).toEqual({
      condition: 1,
      guarded: 0,
      provided: 1,
      skippedFallback: 0,
      empty: 1,
      fallback: 1
    });
    expect(observed.guardedProps.style).toEqual({});
    expect(observed.guardedProps.style).not.toBe(false);
    expect(observed.providedProps).toMatchObject({
      className: "provided",
      style: {}
    });
    expect(observed.fallbackProps).toMatchObject({
      className: "css-rule",
      style: { "css-rule": "blue" }
    });
  });

  it("branch dynamic css variable spread", () => {
    const source = `
        const events: string[] = [];
        const pre = {
          id: "from-pre",
          className: "from-pre",
          css: "leak-pre",
          style: { padding: 4 }
        };
        const post = {
          title: "from-post",
          className: "from-post",
          css: "leak-post",
          style: { margin: 8 }
        };
        const state = {
          get condition() {
            events.push("condition");
            return true;
          }
        };
        const active = {
          get color() {
            events.push("active");
            return "tomato";
          }
        };
        const inactive = {
          get color() {
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          const renderValue = () => <div {...pre} css={state.condition ? { color: active.color } : { color: inactive.color }} {...post} />;
          return renderValue();
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style), hasCss: "css" in props };
      `
    ) as {
      props: Record<string, unknown>;
      events: string[];
      styleKeys: string[];
      hasCss: boolean;
    };

    expect(code).toContain("(() =>");
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("createVar");
    expect(code).not.toContain("getVarName");
    expect(observed.events).toEqual(["condition", "active"]);
    expect(observed.styleKeys).toEqual(["padding", "margin", "css-rule"]);
    expect(observed.hasCss).toBe(false);
    expect(observed.props).toMatchObject({
      id: "from-pre",
      title: "from-post",
      className: "from-pre css-rule from-post",
      style: { padding: 4, margin: 8, "css-rule": "tomato" }
    });
  });

  it("collects conditional dynamic css variable branch rules at model level", () => {
    const fixtures = [
      {
        source: `
            const condition = true;
            function App(props) {
              return <div css={condition ? { color: props.color } : { color: "red" }} />;
            }
          `,
        leafProperties: ["color"],
        branchLeafProperties: [["color"], []]
      },
      {
        source: `
            const condition = true;
            function App(props) {
              return <div css={condition ? { color: props.color } : { color: props.fallbackColor }} />;
            }
          `,
        leafProperties: ["color", "color"],
        branchLeafProperties: [["color"], ["color"]]
      }
    ] as const;

    for (const { source, leafProperties, branchLeafProperties } of fixtures) {
      const snapshot = collectDynamicCssVariableRuleSnapshot(source);

      expect(snapshot).toMatchObject({
        kind: "branch",
        expressionType: "ConditionalExpression",
        leafProperties
      });
      expect(
        snapshot?.branches?.map((branch) => branch.leafProperties)
      ).toEqual(branchLeafProperties);
    }
  });

  it("collects logical dynamic css variable branch rules at model level", () => {
    const fixtures = [
      `
          const condition = true;
          function App(props) {
            return <div css={condition && { color: props.color }} />;
          }
        `,
      `
          const providedClass = "provided";
          function App(props) {
            return <div css={providedClass || { color: props.color }} />;
          }
        `
    ] as const;

    for (const source of fixtures) {
      const snapshot = collectDynamicCssVariableRuleSnapshot(source);

      expect(snapshot).toMatchObject({
        kind: "branch",
        expressionType: "LogicalExpression",
        leafProperties: ["color"]
      });
      expect(
        snapshot?.branches?.map((branch) => branch.leafProperties)
      ).toEqual([["color"]]);
    }
  });

  it("rejects unsupported branch dynamic css variable rules at collector level", () => {
    const templateLiteralFixture = `
        const condition = true;
        function App(props) {
          return <div css={condition ? { color: \`${"${props.color}"}\` } : { color: "red" }} />;
        }
      `;

    const fixtures = [
      `
          const condition = true;
          function App(props) {
            return <div css={condition ? { [props.key]: props.color } : { color: "red" }} />;
          }
        `,
      `
          const condition = true;
          function App(props) {
            return <div css={condition ? { ...props.styles, color: props.color } : { color: "red" }} />;
          }
        `,
      `
          const condition = true;
          function App(props) {
            return <div css={condition ? [...props.styles, { color: props.color }] : [{ color: "red" }]} />;
          }
        `,
      `
          const condition = true;
          function makeRule(color) {
            return { color };
          }
          function App(props) {
            return <div css={condition ? makeRule(props.color) : { color: "red" }} />;
          }
        `,
      `
          function App(props) {
            return <div css={() => ({ color: props.color })} />;
          }
        `,
      `
          const condition = true;
          function App(props) {
            return <div css={condition ? (props.touch(), { color: props.color }) : { color: "red" }} />;
          }
        `,
      templateLiteralFixture
    ] as const;

    for (const source of fixtures) {
      expect(collectDynamicCssVariableRuleSnapshot(source)).toBeNull();
    }

    const templateLiteralFailure = captureJsxCssPropFailure(
      templateLiteralFixture,
      { jsxCssProp: true }
    );

    expect(templateLiteralFailure.error.message).toContain(
      jsxCssPropErrorMessages.unsupportedDynamicCssRule
    );
    expect(templateLiteralFailure.code).not.toContain("_css(");
  });

  it("rejects unsupported dynamic css variable shapes with exact compile-away diagnostics", () => {
    const fixtures = [
      {
        label: "dynamic keys",
        source: `
            function App(props) {
              return <div css={{ [props.key]: props.color }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: computed member access is unsupported"
      },
      {
        label: "dynamic object spreads",
        source: `
            function App(props) {
              return <div css={{ ...props.styles, color: props.color }} />;
            }
          `,
        expectedFirstLine:
          "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`."
      },
      {
        label: "dynamic array spreads",
        source: `
            function App(props) {
              return <div css={[...props.styles, { color: props.color }]} />;
            }
          `,
        expectedFirstLine:
          "Mincho JSX css prop array values do not support spread elements in compile-away mode"
      },
      {
        label: "call-return CSS shapes",
        source: `
            function makeRule(color) {
              return { color };
            }
            function App(props) {
              return <div css={makeRule(props.color)} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
      },
      {
        label: "member call-return CSS shapes",
        source: `
            function App(props) {
              return <div css={props.ruleFactory()} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
      },
      {
        label: "optional dynamic member CSS shapes",
        source: `
            const styles = null;
            function App() {
              return <div css={styles?.button} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalMemberExpression"
      },
      {
        label: "function values",
        source: `
            function App(props) {
              return <div css={{ color: () => props.color }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: ArrowFunctionExpression"
      },
      {
        label: "sequence-wrapped CSS rules",
        source: `
            function App(props) {
              return <div css={(0, { color: props.color })} />;
            }
          `,
        expectedFirstLine:
          "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
      },
      {
        label: "template runtime property values",
        source: `
            function App(props) {
              return <div css={{ color: \`${"${props.color}"}\` }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: template interpolation references a render-scope member"
      },
      {
        label: "template optional-member runtime property values",
        source: `
            function App(props) {
              return <div css={{ color: \`${"${props?.color}"}\` }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: template interpolation references a render-scope member"
      },
      {
        label: "template call property values",
        source: `
            function getColor() {
              return "red";
            }
            function App() {
              return <div css={{ color: \`${"${getColor()}"}\` }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
      }
    ] as const;

    for (const { label, source, expectedFirstLine } of fixtures) {
      let failure: ReturnType<typeof captureJsxCssPropFailure>;

      try {
        failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
      } catch (error) {
        throw new Error(
          `${label}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      expect(failure.error.message.split("\n")[0], label).toBe(
        expectedFirstLine
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("explains runtime CSS object spreads require statically known CSS shape", () => {
    const fixtures = [
      {
        label: "identifier object spread",
        source: `
            function App(someRuntimeObject: Record<string, string>) {
              return <div css={{ ...someRuntimeObject, color: "red" }} />;
            }
          `
      },
      {
        label: "call object spread",
        source: `
            function App(getStyles: () => Record<string, string>) {
              return <div css={{ ...getStyles(), color: "red" }} />;
            }
          `
      },
      {
        label: "array-shaped object spread",
        source: `
            function App(arrayOfStyles: ReadonlyArray<Record<string, string>>) {
              return <div css={{ ...arrayOfStyles, color: "red" }} />;
            }
          `
      },
      {
        label: "member object spread",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        staticShapeDiagnosticPattern
      );
      expect(failure.error.message, label).toMatch(reactStyleGuidancePattern);
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("omits React style guidance for non-plain static-shape diagnostics", () => {
    const fixtures = [
      {
        label: "selector composition",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ selectors: { "&:hover": { ...props.styles } } }} />;
            }
          `
      },
      {
        label: "media composition",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ "@media": { "screen and (min-width: 700px)": { ...props.styles } } }} />;
            }
          `
      },
      {
        label: "token composition",
        source: `
            function App(props: { vars: Record<string, string> }) {
              return <div css={{ vars: { ...props.vars } }} />;
            }
          `
      },
      {
        label: "condition composition",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ color: { $dark: { ...props.styles } } }} />;
            }
          `
      },
      {
        label: "class composition",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={[{ ...props.styles }, "extra"]} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        staticShapeDiagnosticPattern
      );
      expect(failure.error.message, label).not.toMatch(
        reactStyleGuidancePattern
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("explains runtime-shape conditionals require static branch CSS shape", () => {
    const fixtures = [
      {
        label: "computed-key runtime branch",
        source: `
            function App(active: boolean, props: { key: string }) {
              return <div css={active ? { [props.key]: "red" } : { color: "blue" }} />;
            }
          `
      },
      {
        label: "object-fragment runtime branch",
        source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...(active ? props.styles : { color: "red" }) }} />;
            }
          `
      }
    ] as const;

    for (const { label, source } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message, label).toMatch(
        /Complex conditions are supported only when branch CSS shape is static/
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("rejects optional calls that can be undefined and lowers nested build-time calls", () => {
    const optionalCall = captureJsxCssPropFailure(
      `
        function App() {
          return <div css={makeRule?.("red")} />;
        }
      `,
      { jsxCssProp: true }
    );

    const nestedCall = babelTransform(
      `
        function makeColor() {
          return "red";
        }

        function App() {
          return <div css={{ color: makeColor() }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(optionalCall.error.message).toContain(
      "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
    );
    expect(optionalCall.code).not.toContain("_css(");
    expect(nestedCall.code).not.toContain(" css=");
    expect(nestedCall.code).not.toContain("style=");
    expect(nestedCall.code).not.toContain("_cx(makeColor");
    expect(nestedCall.code).not.toContain("_css(");
    expect(nestedCall.result[1]).toContain("_css({");
    expect(nestedCall.result[1]).toContain("color: makeColor()");
  });

  it("rejects dynamic key dynamic spread runtime rule shape before emission", () => {
    const fixtures = [
      {
        label: "render computed key",
        expected:
          "Cannot statically evaluate css prop value: computed member access is unsupported",
        source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
      },
      {
        label: "render spread object",
        expected:
          "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`.",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
      },
      {
        label: "render whole-rule call",
        expected:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
        source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `
      }
    ] as const;

    for (const { label, source, expected } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message.split("\n")[0], label).toBe(expected);
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  describe("Compiled/StyleX/Devup JSX css prop parity integration", () => {
    it("covers Compiled suffix/fallback/css variables and StyleX inheritance guards without the forbidden runtime helper", () => {
      const source = `
          const events: string[] = [];
          const activeColor = {
            get value() {
              events.push("active");
              return "tomato";
            }
          };
          const inactiveColor = {
            get value() {
              events.push("inactive");
              throw new Error("inactive branch evaluated");
            }
          };

          function CompiledSuffixApp(props: {
            gap: number;
            percent: number;
            size: number;
          }) {
            return <div css={{
              width: \`${"${props.size}"}px\`,
              inset: \`${"${props.percent}"}%\`,
              margin: \`${"${props.gap}"}rem\`
            }} />;
          }

          function StyleXChild(value: string | null | undefined | boolean) {
            return <span css={{ color: value }} />;
          }

          function DevupConditionalApp(active: boolean) {
            return <section css={{ color: active ? activeColor.value : inactiveColor.value }} />;
          }
        `;

      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
          const child = StyleXChild(null);
          const conditional = DevupConditionalApp(true);
          return {
            child,
            conditional,
            events
          };
        `
      );

      // Assembled so the bare-token assertion below cannot match its own fixture.
      const forbiddenRuntimeHelper = ["i", "x"].join("");

      expect(result[1]).toContain('from "@mincho-js/css"');
      expect(result[1]).toContain("css as _css");
      expect(result[1]).toMatch(/createVar as _minchoCreateVar\d*/);
      expect(result[1]).toMatch(/getVarName as _minchoGetVarName\d*/);
      expect(result[1]).toMatch(/_css\(\{/);
      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain('_vx(props.size, "px")');
      expect(code).toContain('_vx(props.percent, "%")');
      expect(code).toContain('_vx(props.gap, "rem")');
      expect(code).toContain("_vx(value)");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toMatch(new RegExp(`\\b${forbiddenRuntimeHelper}\\b`));
      expect(code).not.toMatch(/vx[^\n]+from "@mincho-js\/css"/);
      expect(observed).toEqual({
        child: {
          className: "css-rule",
          style: { "css-rule": "var(--c-, )" }
        },
        conditional: {
          className: "css-rule",
          style: { "css-rule": "tomato" }
        },
        events: ["active"]
      });
    });

    it("covers Compiled conditional spreads and Devup lazy class/style merge order with key/ref", () => {
      const source = `
          const events: string[] = [];
          const explicitRef = "explicit-ref";
          const state = { active: true, fallback: false };
          const pre = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre",
            style: { padding: 4 }
          };
          const post = {
            className: "from-post",
            css: "leak-post",
            title: "from-post",
            style: { margin: 8 }
          };
          const activeColor = {
            get value() {
              events.push("active-fragment");
              return "tomato";
            }
          };
          const fallbackColor = {
            get value() {
              events.push("fallback-fragment");
              return "gold";
            }
          };
          const inactiveColor = {
            get value() {
              events.push("inactive-fragment");
              throw new Error("inactive object fragment evaluated");
            }
          };

          function App() {
            return <div
              key="compiled-key"
              ref={explicitRef}
              {...pre}
              css={{
                display: "block",
                ...state.active && { color: activeColor.value },
                borderColor: state.active ? "black" : inactiveColor.value,
                ...state.fallback || { backgroundColor: fallbackColor.value }
              }}
              style={{ opacity: 0.5 }}
              {...post}
            />;
          }
        `;

      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
          const props = App();
          return {
            props,
            events,
            hasCss: "css" in props,
            styleKeys: Object.keys(props.style)
          };
        `
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toContain('key="compiled-key"');
      expect(code).toContain("ref={explicitRef}");
      expect(code).not.toContain('key: "compiled-key"');
      expect(code).toContain("...(_minchoCssBranch ?");
      expect(code).toMatch(
        /const _minchoCssBranch\d* = .* \? state\.fallback : void 0;/
      );
      expect(observed).toEqual({
        hasCss: false,
        styleKeys: ["padding", "opacity", "margin", "css-rule"],
        events: ["active-fragment", "fallback-fragment"],
        props: expect.objectContaining({
          key: "compiled-key",
          ref: "explicit-ref",
          id: "from-pre",
          title: "from-post",
          className: expect.stringMatching(/^from-pre .*css-rule.* from-post$/),
          style: expect.objectContaining({
            padding: 4,
            opacity: 0.5,
            margin: 8,
            "css-rule": "gold"
          })
        })
      });
    });

    it("covers Compiled/StyleX/Devup unsupported static-shape and dynamic-array diagnostics", () => {
      const fixtures = [
        {
          label: "StyleX static-shape boundary object spread",
          source: `
              function App(props: { styles: Record<string, string> }) {
                return <div css={{ ...props.styles, color: "red" }} />;
              }
            `,
          expected: staticShapeDiagnosticPattern
        },
        {
          label: "Compiled/Devup dynamic array remains unsupported",
          source: `
              function App(props: { gap: number }) {
                return <div css={{ margin: [props.gap, "auto"] }} />;
              }
            `,
          expected:
            /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape/
        }
      ] as const;

      for (const { label, source, expected } of fixtures) {
        const failure = captureJsxCssPropFailure(source, {
          jsxCssProp: true
        });

        expect(failure.error.message, label).toMatch(expected);
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });
  });

  it("maps partial evaluator deopt diagnostics and preserves unchanged diagnostics", () => {
    const depthBindingCount =
      STATIC_CSS_EVAL_LIMITS.maxObjectArrayRecursionDepth + 1;

    const depthBindings = Array.from(
      { length: depthBindingCount },
      (_, index) => {
        const next =
          index === depthBindingCount - 1
            ? `{ color: "red" }`
            : `style${index + 1}`;

        return `const style${index} = ${next};`;
      }
    ).join("\n");

    const largeStylePropertyCount =
      STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount + 1;

    const largeStyle = Array.from(
      { length: largeStylePropertyCount },
      (_, index) => `p${index}: "${index}"`
    ).join(",");

    const fixtures = [
      {
        reason: "mutated-binding",
        expected:
          'Cannot statically evaluate css prop value: same-file binding "style" is mutated',
        source: `
            const style = { color: "red" };
            style.color = "blue";
            function App() {
              return <div css={style} />;
            }
          `
      },
      {
        reason: "unsupported-call-expression",
        expected:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
        source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `
      },
      {
        reason: "non-static-object-key",
        expected:
          "Cannot statically evaluate css prop value: computed member access is unsupported",
        source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
      },
      {
        reason: "unsupported-spread",
        expected:
          "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`.",
        source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
      },
      {
        reason: "unsupported-computed-member",
        expected:
          "Cannot statically evaluate css prop value: computed member access is unsupported",
        source: `
            const styles = { button: { color: "red" } };
            function App(variant: string) {
              return <div css={styles[variant]} />;
            }
          `
      },
      {
        reason: "runtime-css-shape",
        expected:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: ObjectMethod",
        source: `
            function App() {
              return <div css={{ color() { return "red"; } }} />;
            }
          `
      },
      {
        reason: "unsupported-template-interpolation",
        expected:
          "Cannot statically evaluate css prop value: template interpolation references a render-scope member",
        source: `
            function App(props: { color: string }) {
              return <div css={{ color: \`${"${props.color}"}\` }} />;
            }
          `
      },
      {
        reason: "cycle-detected",
        expected:
          'Cannot statically evaluate css prop value: binding cycle detected while resolving "styleA"',
        source: `
            const styleA = styleB;
            const styleB = styleA;
            function App() {
              return <div css={styleA} />;
            }
          `
      },
      {
        reason: "depth-limit",
        expected:
          "Cannot statically evaluate css prop value: partial evaluator depth limit exceeded",
        source: `
            ${depthBindings}
            function App() {
              return <div css={style0} />;
            }
          `
      },
      {
        reason: "node-count-limit",
        expected:
          "Cannot statically evaluate css prop value: partial evaluator node count limit exceeded",
        source: `
            function App() {
              return <div css={{ ${largeStyle} }} />;
            }
          `
      }
    ] as const;

    for (const { reason, source, expected } of fixtures) {
      let failure: ReturnType<typeof captureJsxCssPropFailure>;

      try {
        failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
      } catch (error) {
        throw new Error(
          `${reason}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      expect(failure.error.message.split("\n")[0], reason).toBe(expected);
      expect(failure.code, reason).not.toContain("_css(");
      expect(failure.code, reason).not.toContain("style={{");
    }
  });

  it("preserves provider reexport diagnostic over partial evaluator deopt", () => {
    const failure = captureJsxCssPropFailure(
      `
          import { button } from "./barrel";
          function App() {
            return <div css={{ color: button }} />;
          }
        `,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createUnsupportedReexportStaticCssEvalProvider()
      }
    );

    expect(failure.error.message).toContain(
      'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
    );
    expect(failure.error.message).not.toContain(
      "imported binding must be resolved by the static css provider"
    );
    expect(failure.code).not.toContain("_css(");
  });

  it("fails closed for dynamic computed optional and template expression css rules", () => {
    const fixtures = [
      {
        label: "computed member rule",
        source: `
            const styles = { button: { color: "red" } };
            function App(variant) {
              return <div css={styles[variant]} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: computed member access is unsupported"
      },
      {
        label: "optional member rule",
        source: `
            const styles = null;
            function App() {
              return <div css={styles?.button} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalMemberExpression"
      },
      {
        label: "template call property value",
        source: `
            function getColor() {
              return "red";
            }
            function App() {
              return <div css={{ color: \`\${getColor()}\` }} />;
            }
          `,
        expectedFirstLine:
          "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
      }
    ] as const;

    for (const { label, source, expectedFirstLine } of fixtures) {
      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

      expect(failure.error.message.split("\n")[0], label).toBe(
        expectedFirstLine
      );
      expect(failure.code, label).not.toContain("_css(");
      expect(failure.code, label).not.toContain("style={{");
    }
  });

  it("keeps class-value array calls out of direct rule-call lowering", () => {
    const { result, code } = babelTransform(
      `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={["base", makeRule("red")]} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain('className={_cx("base", makeRule("red"))}');
    expect(code).not.toContain("_$mincho$$App");
    expect(result[1]).not.toContain("_css(");
  });

  it("keeps activeClass primitive and cx css props in class-value mode", () => {
    const { result, code } = babelTransform(
      `
        import { cx } from "@mincho-js/css";

        const activeClass = "active";

        function App() {
          return <>
            <div css={activeClass} />
            <div css={0} />
            <div css={cx(activeClass)} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(activeClass)}");
    expect(code).toContain("className={_cx(0)}");
    expect(code).toContain("className={_cx(cx(activeClass))}");
    expect(result[1]).not.toContain("_css(");
  });

  it("lowers identifier css result through cx without double wrapping", () => {
    const { result, code } = babelTransform(
      `
        import { css } from "@mincho-js/css";

        const styleA = css({ color: "red" });

        function App() {
          return <div css={styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(styleA)}");
    expect(code).not.toContain("_css(styleA)");
    expect(code).not.toContain("css(styleA)");
  });

  it("lowers non-null identifier css result through cx without double wrapping", () => {
    const { code } = babelTransform(
      `
        const styleA = "base";

        function App() {
          return <div css={styleA!} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(styleA)}");
    expect(code).not.toContain("_css(styleA)");
    expect(code).not.toContain("css(styleA)");
  });

  it("keeps inline object class dictionary syntax in css rule mode", () => {
    const { result, code } = babelTransform(
      `
        const isActive = true;

        function App() {
          return <div css={{ active: isActive }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(result[1]).toContain("active: isActive");
    expect(code).toContain("className={_$mincho$$App2}");
    expect(code).not.toContain("_cx({");
  });

  it("lowers custom component class-value jsx css prop through cx", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "base";

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).toContain("return <Button className={_cx(styleA)} />");
  });

  it("forwards expression css prop through custom component className", () => {
    const { code } = babelTransform(
      `
        const flag = true;

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={flag && "active"} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).toContain(
      'return <Button className={_cx(flag && "active")} />'
    );
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(flag &&");
  });

  it("lowers custom component inline object jsx css prop through css rule mode", () => {
    const { result, code } = babelTransform(
      `
        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={{ color: "red" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain(" css=");
    expect(code).toContain("return <Button className={_$mincho$$App2} />");
  });

  it("lowers member-expression class-value jsx css prop through cx", () => {
    const { result, code } = babelTransform(
      `
        const motion = { div: "div" };
        const styleA = "base";

        function App() {
          return <motion.div css={styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).toContain("return <motion.div className={_cx(styleA)} />");
  });

  it("lowers custom element class-value jsx css prop through className", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "base";

        function App() {
          return <my-element css={styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).toContain("return <my-element className={_cx(styleA)} />");
    expect(code).not.toContain("<my-element class=");
  });

  it("lowers mixed conditional rule branches across jsx target kinds", () => {
    const fixtures = [
      {
        fixture: `<div css={condition ? { color: "red" } : styleA} />`,
        expectedClassName:
          /return <div className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
      },
      {
        fixture: `<Button css={condition ? { color: "red" } : styleA} />`,
        expectedClassName:
          /return <Button className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
      },
      {
        fixture: `<motion.div css={condition ? { color: "red" } : styleA} />`,
        expectedClassName:
          /return <motion\.div className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
      },
      {
        fixture: `<my-element css={condition ? { color: "red" } : styleA} />`,
        expectedClassName:
          /return <my-element className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
      }
    ] as const;

    for (const { fixture, expectedClassName } of fixtures) {
      const { result, code } = babelTransform(
        `
          const condition = true;
          const styleA = "style-a";
          const motion = { div: "div" };

          function Button(props) {
            return <button {...props} />;
          }

          function App() {
            return ${fixture};
          }
        `,
        { jsxCssProp: true }
      );

      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(expectedClassName);
      expect(code).toMatch(/condition \? _\$mincho\$\$App\d+ : styleA/);
      expect(code).not.toContain("<my-element class=");
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("css(condition ?");
      expect(output).not.toContain("_css(styleA)");
      expect(output).not.toContain("css(styleA)");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
    }
  });
});

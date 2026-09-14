import { describe, expect, it } from "vitest";
import { supportedJsxCssPropTags } from "./jsxCssPropTags.js";
import {
  babelTransform,
  expectJsxCssPropError,
  expectNestedInvalidClassNameExpressionError,
  expectNestedJsxCssPropError,
  expectNestedUnsupportedJsxTargetError,
  expectUnsupportedSpreadAggregationContextError,
  jsxCssPropErrorMessages,
  runJsxCssPropRuntime
} from "./testUtils/plugin.js";

describe("minchoBabelPlugin", () => {
  it("css before a spread lowers explicit css before post-spread className", () => {
    const source = `
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const output = `${code}\n${result.join("\n")}`;
    const observed = runJsxCssPropRuntime(source, "return App();") as Record<
      string,
      unknown
    >;

    expect(result[1]).toBe("");
    expect(code).not.toContain(" css=");
    expect(code).toContain("css: _minchoCssProp");
    expect(code).not.toContain("(() =>");
    expect(code).toContain("className: _minchoClassName");
    expect(code).toContain("..._minchoRest");
    expect(code).toContain("className={_cx(styleA, _minchoClassName)}");
    expect(output).not.toContain("className={_cx(_minchoClassName, styleA)}");
    expect(observed).toMatchObject({
      className: "style-a base",
      id: "root"
    });
    expect("css" in observed).toBe(false);

    const spreadOnly = babelTransform(
      `
        const styleA = "style-a";

        function App() {
          return <div {...{ css: styleA }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(spreadOnly.code).toContain("css: styleA");
    expect(spreadOnly.code).not.toContain("className=");
    expect(spreadOnly.code).not.toContain("_cx");
  });

  it("mixed spread around css preserves source-group className and prop overrides", () => {
    const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a",
          title: "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          title: "from-b"
        };

        function App() {
          return <div {...a} css={styleA} {...b} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(source, "return App();") as Record<
      string,
      unknown
    >;

    expect(result[1]).toBe("");
    expect(code).not.toContain(" css=");
    expect(observed).toMatchObject({
      className: "from-a style-a from-b",
      id: "from-a",
      title: "from-b"
    });
    expect("css" in observed).toBe(false);
  });

  it("multiple post-css spreads use the final post group className", () => {
    const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          id: "from-b",
          title: "from-b"
        };

        function App() {
          return <div css={styleA} {...a} {...b} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(source, "return App();") as Record<
      string,
      unknown
    >;

    expect(result[1]).toBe("");
    expect(code).not.toContain(" css=");
    expect(observed).toMatchObject({
      className: "style-a from-b",
      id: "from-b",
      title: "from-b"
    });
    expect("css" in observed).toBe(false);
  });

  it("interleaved post-css attributes preserve object-spread overrides", () => {
    const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a",
          title: "from-a",
          "data-source": "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          title: "from-b",
          "data-source": "from-b"
        };

        function App() {
          return <div css={styleA} {...a} id="later" data-source="later" {...b} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(source, "return App();") as Record<
      string,
      unknown
    >;

    expect(result[1]).toBe("");
    expect(code).not.toContain(" css=");
    expect(observed).toMatchObject({
      className: "style-a from-b",
      id: "later",
      title: "from-b"
    });
    expect(observed["data-source"]).toBe("from-b");
    expect("css" in observed).toBe(false);
  });

  it("aggregates spread props before explicit class-value css prop", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).toContain("css: _minchoCssProp");
    expect(code).toContain("..._minchoRest");
    expect(code).toContain("className={_cx(_minchoClassName, styleA)}");
  });

  it("aggregates multiple spreads and className before inline object css prop", () => {
    const { result, code } = babelTransform(
      `
        const a = { id: "a" };
        const b = { className: "from-b" };

        function App() {
          return <div {...a} className="base" {...b} css={{ color: "red" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain(" css=");
    expect(code).toContain("...a");
    expect(code).toContain('className: "base"');
    expect(code).toContain("...b");
    expect(code).toContain("className={_cx(_minchoClassName, _$mincho$$App2)}");
  });

  it("aggregates spread props before conditional object css prop branches", () => {
    const { result, code } = babelTransform(
      `
        const condition = true;
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={condition ? { color: "red" } : styleA} />;
        }
      `,
      { jsxCssProp: true }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).toContain("css: _minchoCssProp");
    expect(code).toContain("className: _minchoClassName");
    expect(code).toContain("..._minchoRest");
    expect(code).toContain("<div {..._minchoRest} className=");
    expect(code).toMatch(
      /className=\{_cx\(_minchoClassName, condition \? _\$mincho\$\$App\d+ : styleA\)\}/
    );
    expect(output).not.toContain("_css(condition ?");
    expect(output).not.toContain("css(condition ?");
    expect(output).not.toContain("_css(styleA)");
    expect(output).not.toContain("css(styleA)");
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
  });

  it("evaluates explicit css before post-css spread in source order", () => {
    const observed = runJsxCssPropRuntime(
      `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const style = () => {
          events.push("style");
          return "style-a";
        };
        const spread = () => {
          events.push("spread");
          return { className: "from-spread", css: "leak", id: "root" };
        };

        function App() {
          return <div css={cx(style())} {...spread()} />;
        }
      `,
      "return { props: App(), events };"
    ) as { props: Record<string, unknown>; events: string[] };

    expect(observed.events).toEqual(["style", "spread"]);
    expect(observed.props).toMatchObject({
      className: "style-a from-spread",
      id: "root"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads explicit css getter before post-css spread once in source order", () => {
    const observed = runJsxCssPropRuntime(
      `
        const events: string[] = [];
        let styleReads = 0;
        const style = {
          get value() {
            styleReads += 1;
            events.push("style");
            return "style-a";
          }
        };
        const spread = () => {
          events.push("spread");
          return { className: "from-spread", css: "leak", id: "root" };
        };

        function App() {
          return <div css={style.value} {...spread()} />;
        }
      `,
      "return { props: App(), events, styleReads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      styleReads: number;
    };

    expect(observed.events).toEqual(["style", "spread"]);
    expect(observed.styleReads).toBe(1);
    expect(observed.props).toMatchObject({
      className: "style-a from-spread",
      id: "root"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads post-spread className getter once through aggregate props", () => {
    const observed = runJsxCssPropRuntime(
      `
        const styleA = "style-a";
        let classNameReads = 0;
        const props = {
          get className() {
            classNameReads += 1;
            return "from-spread";
          },
          css: "leak",
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `,
      "return { props: App(), classNameReads };"
    ) as { props: Record<string, unknown>; classNameReads: number };

    expect(observed.classNameReads).toBe(1);
    expect(observed.props).toMatchObject({
      className: "style-a from-spread",
      id: "root"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads stripped post-spread css getter once through aggregate props", () => {
    const observed = runJsxCssPropRuntime(
      `
        const styleA = "style-a";
        let cssReads = 0;
        const props = {
          className: "from-spread",
          get css() {
            cssReads += 1;
            return "leak";
          },
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `,
      "return { props: App(), cssReads };"
    ) as { props: Record<string, unknown>; cssReads: number };

    expect(observed.cssReads).toBe(1);
    expect(observed.props).toMatchObject({
      className: "style-a from-spread",
      id: "root"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads mixed pre and post spread getters once in source order", () => {
    const observed = runJsxCssPropRuntime(
      `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const reads = {
          preClassName: 0,
          preCss: 0,
          style: 0,
          postClassName: 0,
          postCss: 0
        };
        const pre = {
          id: "from-pre",
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
        const style = () => {
          reads.style += 1;
          events.push("style");
          return "style-a";
        };
        const post = {
          title: "from-post",
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

        function App() {
          return <div {...pre} css={cx(style())} {...post} />;
        }
      `,
      "return { props: App(), events, reads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(observed.events).toEqual([
      "pre.className",
      "pre.css",
      "style",
      "post.className",
      "post.css"
    ]);
    expect(observed.reads).toEqual({
      preClassName: 1,
      preCss: 1,
      style: 1,
      postClassName: 1,
      postCss: 1
    });
    expect(observed.props).toMatchObject({
      className: "from-pre style-a from-post",
      id: "from-pre",
      title: "from-post"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("evaluates spread aggregation inputs once in source order", () => {
    const observed = runJsxCssPropRuntime(
      `
        const styleA = "style-a";
        const events: string[] = [];
        const spreadA = () => {
          events.push("spread-a");
          return { id: "a", className: "from-a", css: "leak-a" };
        };
        const spreadB = () => {
          events.push("spread-b");
          return { title: "b", className: "from-b", css: "leak-b" };
        };
        const named = () => {
          events.push("className");
          return "base";
        };

        function App() {
          return <div {...spreadA()} className={named()} {...spreadB()} css={styleA} />;
        }
      `,
      "return { props: App(), events };"
    ) as { props: Record<string, unknown>; events: string[] };

    expect(observed.events).toEqual(["spread-a", "className", "spread-b"]);
    expect(observed.props).toMatchObject({
      id: "a",
      title: "b",
      className: "from-b style-a"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads spread-provided className once through aggregate props", () => {
    const observed = runJsxCssPropRuntime(
      `
        const styleA = "style-a";
        let classNameReads = 0;
        const props = {
          get className() {
            classNameReads += 1;
            return "base";
          },
          css: "leak",
          id: "root"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
      "return { props: App(), classNameReads };"
    ) as { props: Record<string, unknown>; classNameReads: number };

    expect(observed.classNameReads).toBe(1);
    expect(observed.props).toMatchObject({
      id: "root",
      className: "base style-a"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("reads branch-lowered spread and className getters once in source order", () => {
    const observed = runJsxCssPropRuntime(
      `
        const condition = true;
        const styleA = "style-a";
        const events: string[] = [];
        const reads = {
          spreadA: 0,
          explicit: 0,
          spreadB: 0
        };
        const spreadA = {
          id: "a",
          get className() {
            reads.spreadA += 1;
            events.push("spread-a.className");
            return "from-a";
          },
          css: "leak-a"
        };
        const explicitClassName = {
          get value() {
            reads.explicit += 1;
            events.push("explicit.className");
            return "base";
          }
        };
        const spreadB = {
          title: "b",
          get className() {
            reads.spreadB += 1;
            events.push("spread-b.className");
            return "from-b";
          },
          css: "leak-b"
        };

        function App() {
          return <div {...spreadA} className={explicitClassName.value} {...spreadB} css={condition ? { color: "red" } : styleA} />;
        }
      `,
      "return { props: App(), events, reads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(observed.events).toEqual([
      "spread-a.className",
      "explicit.className",
      "spread-b.className"
    ]);
    expect(observed.reads).toEqual({
      spreadA: 1,
      explicit: 1,
      spreadB: 1
    });
    expect(observed.props).toMatchObject({
      id: "a",
      title: "b",
      className: "from-b css-rule"
    });
    expect("css" in observed.props).toBe(false);
  });

  it("preserves explicit key/ref attributes during spread aggregation", () => {
    const source = `
        const styleA = "style-a";
        const explicitRef = "explicit-ref";
        const pre = { className: "from-pre", css: "leak-pre", id: "from-pre" };
        const post = { className: "from-post", css: "leak-post", title: "from-post" };
        const keyedPre = { key: "spread-pre-key", ref: "spread-pre-ref" };
        const keyedPost = { key: "spread-post-key", ref: "spread-post-ref" };

        function BeforeApp() {
          return <div key="before-key" ref={explicitRef} {...pre} css={styleA} />;
        }

        function AfterApp() {
          return <section {...pre} css={styleA} key="after-key" ref={explicitRef} {...post} />;
        }

        function LateBeforeApp() {
          return <aside {...keyedPre} key="late-before-key" ref={explicitRef} css={styleA} />;
        }

        function LateAfterApp() {
          return <main css={styleA} {...keyedPost} key="late-after-key" ref={explicitRef} />;
        }

        function DynamicApp(color: string) {
          return <article css={{ color }} {...keyedPost} key="dynamic-key" ref={explicitRef} />;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `
        return {
          before: BeforeApp(),
          after: AfterApp(),
          lateBefore: LateBeforeApp(),
          lateAfter: LateAfterApp(),
          dynamic: DynamicApp("red")
        };
      `
    ) as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      lateBefore: Record<string, unknown>;
      lateAfter: Record<string, unknown>;
      dynamic: Record<string, unknown>;
    };

    expect(code).not.toContain(" css=");
    expect(code).toContain('key="before-key"');
    expect(code).toContain("ref={explicitRef}");
    expect(code).toContain('key="after-key"');
    expect(code).not.toContain('key: "before-key"');
    expect(code).not.toContain('key: "after-key"');
    expect(observed.before).toMatchObject({
      key: "before-key",
      ref: "explicit-ref",
      id: "from-pre",
      className: "from-pre style-a"
    });
    expect(observed.after).toMatchObject({
      key: "after-key",
      ref: "explicit-ref",
      id: "from-pre",
      title: "from-post",
      className: "from-pre style-a from-post"
    });
    expect(observed.lateBefore).toMatchObject({
      key: "late-before-key",
      ref: "explicit-ref"
    });
    expect(observed.lateAfter).toMatchObject({
      key: "late-after-key",
      ref: "explicit-ref"
    });
    expect(observed.dynamic).toMatchObject({
      key: "dynamic-key",
      ref: "explicit-ref"
    });
    expect(observed.before).not.toHaveProperty("css");
    expect(observed.after).not.toHaveProperty("css");
  });

  it("keeps spread-contained key/ref semantics during spread aggregation", () => {
    const observed = runJsxCssPropRuntime(
      `
        const styleA = "style-a";
        const props = {
          className: "from-spread",
          css: "leak",
          id: "root",
          key: "spread-key",
          ref: "spread-ref"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
      "return App();"
    ) as Record<string, unknown>;

    expect(observed).toMatchObject({
      key: "spread-key",
      ref: "spread-ref",
      id: "root",
      className: "from-spread style-a"
    });
    expect(observed).not.toHaveProperty("css");
  });

  it("reads nested mixed pre css post aggregation once in source order", () => {
    const source = `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const reads = {
          preClassName: 0,
          preCss: 0,
          style: 0,
          postClassName: 0,
          postCss: 0
        };
        const pre = {
          id: "from-pre",
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
        const style = () => {
          reads.style += 1;
          events.push("style");
          return "style-a";
        };
        const post = {
          title: "from-post",
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

        function App() {
          const renderValue = () => <div {...pre} css={cx(style())} {...post} />;
          return renderValue();
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      "return { props: App(), events, reads };"
    ) as {
      props: Record<string, unknown>;
      events: string[];
      reads: Record<string, number>;
    };

    expect(code).not.toContain(" css=");
    expect(code).toContain("(() =>");
    expect(observed.events).toEqual([
      "pre.className",
      "pre.css",
      "style",
      "post.className",
      "post.css"
    ]);
    expect(observed.reads).toEqual({
      preClassName: 1,
      preCss: 1,
      style: 1,
      postClassName: 1,
      postCss: 1
    });
    expect(observed.props).toMatchObject({
      className: "from-pre style-a from-post",
      id: "from-pre",
      title: "from-post"
    });
    expect("css" in observed.props).toBe(false);
  });

  const nestedUntakenBranchLazinessFixtures = [
    {
      name: "keeps conditional untaken nested spread aggregation lazy",
      body: `return false ? <div css={style()} {...post()} /> : "alternate";`,
      expectedValue: "alternate"
    },
    {
      name: "keeps logical AND untaken nested spread aggregation lazy",
      body: `return false && <div css={style()} {...post()} />;`,
      expectedValue: false
    },
    {
      name: "keeps logical OR untaken nested spread aggregation lazy",
      body: `return "fallback" || <div css={style()} {...post()} />;`,
      expectedValue: "fallback"
    },
    {
      name: "keeps nullish untaken nested spread aggregation lazy",
      body: `return "fallback" ?? <div css={style()} {...post()} />;`,
      expectedValue: "fallback"
    }
  ] as const;

  for (const {
    name,
    body,
    expectedValue
  } of nestedUntakenBranchLazinessFixtures) {
    it(name, () => {
      const source = `
          const events: string[] = [];
          const style = () => {
            events.push("style");
            return "style-a";
          };
          const post = () => {
            events.push("post");
            return { className: "from-post", css: "leak-post" };
          };

          function App() {
            ${body}
          }
        `;

      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        "return { value: App(), events };"
      ) as { value: unknown; events: string[] };

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
      expect(observed.value).toBe(expectedValue);
      expect(observed.events).toEqual([]);
    });
  }

  it("preserves lexical this and arguments in nested moved expressions", () => {
    const source = `
        function App() {
          const renderValue = () => (
            <div
              {...this.preProps}
              className={arguments[0]}
              css={this.style}
              {...this.postProps}
            />
          );
          return renderValue();
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      `return App.call({
          preProps: { className: "from-this-pre", css: "leak-pre", id: "from-this" },
          style: "style-from-this",
          postProps: { className: "from-this-post", css: "leak-post", title: "post" }
        }, "from-arguments");`
    ) as Record<string, unknown>;

    expect(code).not.toContain(" css=");
    expect(code).toContain("(() =>");
    expect(observed).toMatchObject({
      className: "from-arguments style-from-this from-this-post",
      id: "from-this",
      title: "post"
    });
    expect("css" in observed).toBe(false);
  });

  const nestedAsyncGeneratorRejectionFixtures = [
    {
      name: "rejects nested await inside moved css expression",
      source: `
          async function getStyle() {
            return "style-a";
          }
          const props = { className: "base" };

          async function App(ok) {
            return ok ? <div css={await getStyle()} {...props} /> : null;
          }
        `
    },
    {
      name: "rejects nested yield inside moved spread expression",
      source: `
          const styleA = "style-a";

          function* App(ok) {
            return ok ? <div {...(yield getProps())} css={styleA} /> : null;
          }
        `
    },
    {
      name: "rejects nested yield inside moved className expression",
      source: `
          const styleA = "style-a";
          const props = { className: "from-post" };

          function* App(ok) {
            return ok ? <div className={(yield getClassName())} css={styleA} {...props} /> : null;
          }
        `
    }
  ] as const;

  for (const { name, source } of nestedAsyncGeneratorRejectionFixtures) {
    it(name, () => {
      expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
        jsxCssPropErrorMessages.nestedAsyncGenerator
      );
    });
  }

  it("keeps direct await and yield spread aggregation on statement hoist path", () => {
    const directAsync = babelTransform(
      `
          async function getStyle() {
            return "style-a";
          }
          const props = { className: "base" };

          async function App() {
            return <div css={await getStyle()} {...props} />;
          }
        `,
      { jsxCssProp: true }
    );

    const directGenerator = babelTransform(
      `
          const styleA = "style-a";

          function* App() {
            return <div {...(yield getProps())} css={styleA} />;
          }
        `,
      { jsxCssProp: true }
    );

    expect(directAsync.code).not.toContain(" css=");
    expect(directAsync.code).not.toContain("(() =>");
    expect(directAsync.code).toContain("await getStyle()");
    expect(directGenerator.code).not.toContain(" css=");
    expect(directGenerator.code).not.toContain("(() =>");
    expect(directGenerator.code).toContain("yield getProps()");
  });

  it("leaves spread-only runtime css props untransformed", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "style-a";

        function App() {
          return <div {...{ css: styleA }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).toContain("css: styleA");
    expect(code).not.toContain("className=");
    expect(code).not.toContain("_cx");
  });

  it("leaves nested spread-only runtime css props untransformed", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "style-a";

        function App() {
          const renderValue = () => <div {...{ css: styleA }} />;
          return renderValue();
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toBe("");
    expect(code).toContain("css: styleA");
    expect(code).not.toContain("className=");
    expect(code).not.toContain("_cx");
    expect(code).not.toContain("(() =>");
  });

  it("accepts direct post-css expression statement aggregation before unsupported context checks", () => {
    const { result, code } = babelTransform(
      `
        const styleA = "style-a";
        const props = { className: "base", css: "leaked", id: "root" };

        function App() {
          <div css={styleA} {...props} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result[1]).toBe("");
    expect(code).not.toContain(" css=");
    expect(code).toContain("css: _minchoCssProp");
    expect(code).toContain("..._minchoRest");
    expect(code).toContain("className={_cx(styleA, _minchoClassName)}");
    expect(code).not.toContain("(() =>");
  });

  it("accepts unbraced if return consequent mixed spread aggregation through arrow IIFE", () => {
    const source = `
        const styleA = "style-a";
        const preProps = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre"
        };
        const postProps = {
          className: "from-post",
          css: "leak-post",
          title: "from-post"
        };

        function App(ok) {
          if (ok) return <div {...preProps} css={styleA} {...postProps} />;
          return null;
        }
      `;

    const { code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(source, "return App(true);");

    expect(code).not.toContain(" css=");
    expect(code).toContain("(() =>");
    expect(observed).toMatchObject({
      className: "from-pre style-a from-post",
      id: "from-pre",
      title: "from-post"
    });
    expect(observed).not.toHaveProperty("css");
  });

  it("accepts unbraced if expression-statement mixed spread aggregation through arrow IIFE", () => {
    const { code } = babelTransform(
      `
        const styleA = "style-a";
        const preProps = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre"
        };
        const postProps = {
          className: "from-post",
          css: "leak-post",
          title: "from-post"
        };

        function App(ok) {
          if (ok) <div {...preProps} css={styleA} {...postProps} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("(() =>");
  });

  const nestedSpreadAggregationRuntimeFixtures = [
    {
      name: "accepts expression-bodied arrow post-css spread aggregation",
      body: `const renderValue = () => <div css={styleA} {...postProps} />;
          return renderValue();`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts expression-bodied arrow mixed spread aggregation",
      body: `const renderValue = () => <div {...preProps} css={styleA} {...postProps} />;
          return renderValue();`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts conditional post-css spread aggregation",
      body: `return ok ? <div css={styleA} {...postProps} /> : null;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts conditional mixed spread aggregation",
      body: `return ok ? <div {...preProps} css={styleA} {...postProps} /> : null;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts logical post-css spread aggregation",
      body: `return ok && <div css={styleA} {...postProps} />;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts logical mixed spread aggregation",
      body: `return ok && <div {...preProps} css={styleA} {...postProps} />;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts logical-or post-css spread aggregation",
      body: `return fallback || <div css={styleA} {...postProps} />;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts nullish coalescing post-css spread aggregation",
      body: `return fallback ?? <div css={styleA} {...postProps} />;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts sequence expression post-css spread aggregation",
      body: `return (0, <div css={styleA} {...postProps} />);`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts call argument post-css spread aggregation",
      body: `return render(<div css={styleA} {...postProps} />);`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts call argument mixed spread aggregation",
      body: `return render(<div {...preProps} css={styleA} {...postProps} />);`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts first new argument post-css spread aggregation",
      body: `return new FirstBox(<div css={styleA} {...postProps} />).value;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts first new argument mixed spread aggregation",
      body: `return new FirstBox(<div {...preProps} css={styleA} {...postProps} />).value;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts later new argument post-css spread aggregation",
      body: `return new SecondBox("label", <div css={styleA} {...postProps} />).value;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts later new argument mixed spread aggregation",
      body: `return new SecondBox("label", <div {...preProps} css={styleA} {...postProps} />).value;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts direct variable initializer post-css spread aggregation",
      body: `const value = <div css={styleA} {...postProps} />;
          return value;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts direct variable initializer mixed spread aggregation",
      body: `const value = <div {...preProps} css={styleA} {...postProps} />;
          return value;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts assignment RHS post-css spread aggregation",
      body: `let value = null;
          value = <div css={styleA} {...postProps} />;
          return value;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts assignment RHS mixed spread aggregation",
      body: `let value = null;
          value = <div {...preProps} css={styleA} {...postProps} />;
          return value;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts array expression member post-css spread aggregation",
      body: `const values = [<div css={styleA} {...postProps} />];
          return values[0];`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts array expression member mixed spread aggregation",
      body: `const values = [<div {...preProps} css={styleA} {...postProps} />];
          return values[0];`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts object property value post-css spread aggregation",
      body: `const values = { item: <div css={styleA} {...postProps} /> };
          return values.item;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts object property value mixed spread aggregation",
      body: `const values = { item: <div {...preProps} css={styleA} {...postProps} /> };
          return values.item;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    },
    {
      name: "accepts JSX attribute expression container post-css spread aggregation",
      body: `return (<Wrapper child={<div css={styleA} {...postProps} />} />).child;`,
      expectedProps: {
        className: "style-a from-post",
        title: "from-post"
      }
    },
    {
      name: "accepts JSX attribute expression container mixed spread aggregation",
      body: `return (<Wrapper child={<div {...preProps} css={styleA} {...postProps} />} />).child;`,
      expectedProps: {
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      }
    }
  ] as const;

  for (const {
    name,
    body,
    expectedProps
  } of nestedSpreadAggregationRuntimeFixtures) {
    it(name, () => {
      const source = `
          const styleA = "style-a";
          const preProps = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre"
          };
          const postProps = {
            className: "from-post",
            css: "leak-post",
            title: "from-post"
          };
          const fallback = null;

          function render(value) {
            return value;
          }

          function Wrapper() {}

          function FirstBox(value) {
            this.value = value;
          }

          function SecondBox(_label, value) {
            this.value = value;
          }

          function App(ok) {
            ${body}
          }
        `;

      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(source, "return App(true);");

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
      expect(observed).toMatchObject(expectedProps);
      expect(observed).not.toHaveProperty("css");
    });
  }

  it("executes fragment-wrapped JSX css prop output", () => {
    expect(
      runJsxCssPropRuntime(
        `
            function App() {
              return <><div css="base" /></>;
            }
          `,
        "return App();"
      )
    ).toEqual({});
  });

  const nestedSpreadAggregationCodeFixtures = [
    {
      name: "accepts fragment child post-css spread aggregation",
      body: `return <><div css={styleA} {...postProps} /></>;`,
      expectedCodeSubstrings: [
        "{(() =>",
        "css: _minchoCssProp",
        "className: _minchoClassName",
        "..._minchoRest"
      ]
    },
    {
      name: "accepts fragment child mixed spread aggregation",
      body: `return <><div {...preProps} css={styleA} {...postProps} /></>;`,
      expectedCodeSubstrings: [
        "{(() =>",
        "css: _minchoPreCssProp",
        "className: _minchoPreClassName",
        "..._minchoPreRest",
        "css: _minchoPostCssProp",
        "className: _minchoPostClassName",
        "..._minchoPostRest"
      ]
    },
    {
      name: "accepts normal element child post-css spread aggregation",
      body: `return <section><div css={styleA} {...postProps} /></section>;`,
      expectedCodeSubstrings: [
        "{(() =>",
        "css: _minchoCssProp",
        "className: _minchoClassName",
        "..._minchoRest"
      ]
    },
    {
      name: "accepts normal element child mixed spread aggregation",
      body: `return <section><div {...preProps} css={styleA} {...postProps} /></section>;`,
      expectedCodeSubstrings: [
        "{(() =>",
        "css: _minchoPreCssProp",
        "className: _minchoPreClassName",
        "..._minchoPreRest",
        "css: _minchoPostCssProp",
        "className: _minchoPostClassName",
        "..._minchoPostRest"
      ]
    },
    {
      name: "accepts template interpolation post-css spread aggregation",
      body: "const label = `${<div css={styleA} {...postProps} />}`;\n          return label;",
      expectedCodeSubstrings: [
        "${(() =>",
        "css: _minchoCssProp",
        "className: _minchoClassName",
        "..._minchoRest"
      ]
    }
  ] as const;

  for (const {
    name,
    body,
    expectedCodeSubstrings
  } of nestedSpreadAggregationCodeFixtures) {
    it(name, () => {
      const { code } = babelTransform(
        `
          const styleA = "style-a";
          const preProps = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre"
          };
          const postProps = {
            className: "from-post",
            css: "leak-post",
            title: "from-post"
          };

          function App() {
            ${body}
          }
        `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");

      for (const expectedCodeSubstring of expectedCodeSubstrings) {
        expect(code).toContain(expectedCodeSubstring);
      }
    });
  }

  it("accepts braced JSX expression child spread aggregation", () => {
    const { code } = babelTransform(
      `
          const props = { className: "base", css: "leaked" };
          const styleA = "style-a";

          function App() {
            return <section>{<div css={styleA} {...props} />}</section>;
          }
        `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("{(() =>");
    expect(code).toContain("css: _minchoCssProp");
    expect(code).toContain("className: _minchoClassName");
    expect(code).toContain("..._minchoRest");
  });

  describe("jsx css prop split characterization", () => {
    it("removes unused jsx css prop helper imports as whole imports and pruned specifiers", () => {
      const wholeImport = babelTransform(
        `
          import { css } from "@mincho-js/css";

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <div css={makeRule("red")} />;
          }
        `,
        { jsxCssProp: true }
      );

      const prunedImport = babelTransform(
        `
          import { css, defineRules } from "@mincho-js/css";

          defineRules({
            properties: { color: String }
          });

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <div css={makeRule("red")} />;
          }
        `,
        { jsxCssProp: true }
      );

      expect(wholeImport.code).not.toContain("@mincho-js/css");
      expect(wholeImport.code).not.toContain("_css(");
      expect(prunedImport.code).toContain(
        'import { defineRules } from "@mincho-js/css";'
      );
      expect(prunedImport.code).not.toContain("css, defineRules");
      expect(prunedImport.code).not.toContain("_css(");
    });

    it("characterizes jsx css prop spread aggregation statement-list and nested IIFE rewrites", () => {
      const directStatementList = babelTransform(
        `
          const props = { className: "base", css: "leaked", id: "root" };
          const styleA = "style-a";

          function App() {
            return <div {...props} css={styleA} />;
          }
        `,
        { jsxCssProp: true }
      );

      const nestedIife = babelTransform(
        `
          const props = { className: "base", css: "leaked", id: "root" };
          const styleA = "style-a";

          function App() {
            const renderValue = () => <div {...props} css={styleA} />;
            return renderValue();
          }
        `,
        { jsxCssProp: true }
      );

      expect(directStatementList.code).not.toContain("(() =>");
      expect(directStatementList.code).toContain("css: _minchoCssProp");
      expect(directStatementList.code).toContain(
        "className={_cx(_minchoClassName, styleA)}"
      );
      expect(nestedIife.code).toContain("(() =>");
      expect(nestedIife.code).toContain("css: _minchoCssProp");
      expect(nestedIife.code).toContain(
        "className={_cx(_minchoClassName, styleA)}"
      );
    });

    it("leaves representative jsx css prop class-value expressions untouched except className lowering", () => {
      const { result, code } = babelTransform(
        `
          const maybeClass = "dynamic";

          function App() {
            return <>
              <div css={new String("boxed")} />
              <div css={void maybeClass} />
            </>;
          }
        `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx(new String("boxed"))}');
      expect(code).toContain("className={_cx(void maybeClass)}");
      expect(result[1]).not.toContain("_css(");
    });

    const exactJsxCssPropErrorFixtures = [
      {
        name: "fragment target",
        fixture: `<React.Fragment css={{ color: "red" }} />`,
        message:
          "Mincho JSX css prop does not support fragments because fragments cannot receive className"
      },
      {
        name: "namespaced target",
        fixture: `<svg:path css={{ color: "red" }} />`,
        message: "Mincho JSX css prop does not support namespaced JSX elements"
      },
      {
        name: "missing expression value",
        fixture: `<div css />`,
        message: "Mincho JSX css prop requires an expression value"
      },
      {
        name: "non-expression JSX value",
        fixture: `<div css=<span /> />`,
        message: "Mincho JSX css prop expects a Mincho CSS object/expression"
      },
      {
        name: "function value",
        fixture: `<div css={() => ({ color: "red" })} />`,
        message:
          "Mincho JSX css prop does not support function values in compile-away mode"
      },
      {
        name: "logical arrow function value",
        fixture: `<div css={{ color: "red" } && (() => ({ color: "blue" }))} />`,
        message:
          "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
      },
      {
        name: "logical function expression value",
        fixture: `<div css={{ color: "red" } && function () { return { color: "blue" }; }} />`,
        message:
          "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
      },
      {
        name: "dynamic CSS rule value",
        fixture: `<div css={(0, { color: "red" })} />`,
        message:
          "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
      },
      {
        name: "array spread value",
        fixture: `<div css={["base", ...classes]} />`,
        message:
          "Mincho JSX css prop array values do not support spread elements in compile-away mode"
      },
      {
        name: "duplicate css",
        fixture: `<div css={{ color: "red" }} css={{ color: "blue" }} />`,
        message: "Mincho JSX css prop must appear only once"
      },
      {
        name: "duplicate className",
        fixture: `<div className="base" className="extra" css={{ color: "red" }} />`,
        message:
          "Mincho JSX css prop cannot merge duplicate className attributes"
      },
      {
        name: "invalid className value",
        fixture: `<div className css={{ color: "red" }} />`,
        message:
          "Mincho JSX css prop requires className to be a string literal or expression"
      }
    ] as const;

    for (const { name, fixture, message } of exactJsxCssPropErrorFixtures) {
      it(`throws exact jsx css prop error for ${name}`, () => {
        expectJsxCssPropError(fixture, message);
      });
    }

    it("throws exact jsx css prop error for unsupported target", () => {
      expectNestedUnsupportedJsxTargetError(
        "Mincho JSX css prop only supports JSX identifiers and member expressions"
      );
    });

    it("throws exact jsx css prop error for unsupported spread aggregation context", () => {
      expectUnsupportedSpreadAggregationContextError(
        "Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode"
      );
    });

    it("throws exact jsx css prop error for nested await or yield spread aggregation", () => {
      expect(() =>
        babelTransform(
          `
            async function getStyle() {
              return "style-a";
            }
            const props = { className: "base" };

            async function App(ok) {
              return ok ? <div css={await getStyle()} {...props} /> : null;
            }
          `,
          { jsxCssProp: true }
        )
      ).toThrow(
        "Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode"
      );
    });
  });

  const unsupportedJsxCssPropFixtures = [
    {
      name: "rejects React.Fragment css prop targets",
      fixture: `<React.Fragment css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.fragmentTarget
    },
    {
      name: "rejects Fragment identifier css prop targets",
      fixture: `<Fragment css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.fragmentTarget
    },
    {
      name: "rejects namespaced JSX css prop targets",
      fixture: `<svg:path css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.namespacedTarget
    },
    {
      name: "rejects shorthand css",
      fixture: `<div css />`,
      message: jsxCssPropErrorMessages.expressionValue
    },
    {
      name: "rejects inline arrow function css values",
      fixture: `<div css={() => ({ color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedFunction
    },
    {
      name: "rejects inline function expression css values",
      fixture: `<div css={function () { return { color: "red" }; }} />`,
      message: jsxCssPropErrorMessages.unsupportedFunction
    },
    {
      name: "rejects sequence object literal css rule values",
      fixture: `<div css={(0, { color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence array literal css rule values",
      fixture: `<div css={(0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence object literal css rule values inside arrays",
      fixture: `<div css={["base", (0, { color: "red" })]} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence array literal css rule values inside arrays",
      fixture: `<div css={["base", (0, [{ color: "red" }])]} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence object literal css rule values inside conditional branches",
      fixture: `<div css={condition ? (0, { color: "red" }) : "fallback"} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence array literal css rule values inside conditional branches",
      fixture: `<div css={condition ? "active" : (0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence object literal css rule values inside logical branches",
      fixture: `<div css={condition && (0, { color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects sequence array literal css rule values inside logical branches",
      fixture: `<div css={condition || (0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects array spread css prop array values",
      fixture: `<div css={["base", ...classes]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects array spread css prop array values inside conditional branches",
      fixture: `<div css={condition ? ["active", ...classes] : "fallback"} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects array spread css prop array values inside logical branches",
      fixture: `<div css={condition && ["active", ...classes]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects array spread css prop array values at nested depth",
      fixture: `<div css={["base", ["nested", ...classes]]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects array spread css prop array values inside nested dynamic branches",
      fixture: `<div css={["base", condition && ["active", ...classes]]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects duplicate css attributes",
      fixture: `<div css={{ color: "red" }} css={{ color: "blue" }} />`,
      message: jsxCssPropErrorMessages.duplicateCss
    },
    {
      name: "rejects duplicate className attributes",
      fixture: `<div className="base" className="extra" css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.duplicateClassName
    },
    {
      name: "rejects shorthand className on css-prop elements",
      fixture: `<div className css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.classNameValue
    }
  ] as const;

  for (const { name, fixture, message } of unsupportedJsxCssPropFixtures) {
    it(name, () => {
      expectJsxCssPropError(fixture, message);
    });
  }

  const nestedUnsupportedJsxCssPropFixtures = [
    {
      name: "rejects nested React.Fragment css prop targets",
      fixture: `<React.Fragment {...props} css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.fragmentTarget
    },
    {
      name: "rejects nested Fragment identifier css prop targets",
      fixture: `<Fragment {...props} css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.fragmentTarget
    },
    {
      name: "rejects nested namespaced JSX css prop targets",
      fixture: `<svg:path {...props} css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.namespacedTarget
    },
    {
      name: "rejects nested unsupported JSX css prop targets",
      fixture: null,
      message: jsxCssPropErrorMessages.unsupportedTarget
    },
    {
      name: "rejects nested shorthand css on spread-aggregated elements",
      fixture: `<div {...props} css />`,
      message: jsxCssPropErrorMessages.expressionValue
    },
    {
      name: "rejects nested inline arrow function css values",
      fixture: `<div {...props} css={() => ({ color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedFunction
    },
    {
      name: "rejects nested inline function expression css values",
      fixture: `<div {...props} css={function () { return { color: "red" }; }} />`,
      message: jsxCssPropErrorMessages.unsupportedFunction
    },
    {
      name: "rejects nested sequence object literal css rule values",
      fixture: `<div {...props} css={(0, { color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence array literal css rule values",
      fixture: `<div {...props} css={(0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence object literal css rule values inside arrays",
      fixture: `<div {...props} css={["base", (0, { color: "red" })]} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence array literal css rule values inside arrays",
      fixture: `<div {...props} css={["base", (0, [{ color: "red" }])]} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence object literal css rule values inside conditional branches",
      fixture: `<div {...props} css={condition ? (0, { color: "red" }) : "fallback"} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence array literal css rule values inside conditional branches",
      fixture: `<div {...props} css={condition ? "active" : (0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence object literal css rule values inside logical branches",
      fixture: `<div {...props} css={condition && (0, { color: "red" })} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested sequence array literal css rule values inside logical branches",
      fixture: `<div {...props} css={condition || (0, [{ color: "red" }])} />`,
      message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
    },
    {
      name: "rejects nested array spread css prop array values",
      fixture: `<div {...props} css={["base", ...dynamicClasses]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects nested array spread css prop array values inside conditional branches",
      fixture: `<div {...props} css={condition ? ["active", ...dynamicClasses] : "fallback"} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects nested array spread css prop array values inside logical branches",
      fixture: `<div {...props} css={condition && ["active", ...dynamicClasses]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects nested array spread css prop array values at nested depth",
      fixture: `<div {...props} css={["base", ["nested", ...dynamicClasses]]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects nested array spread css prop array values inside nested dynamic branches",
      fixture: `<div {...props} css={["base", condition && ["active", ...dynamicClasses]]} />`,
      message: jsxCssPropErrorMessages.unsupportedArraySpread
    },
    {
      name: "rejects nested duplicate css attributes",
      fixture: `<div {...props} css={{ color: "red" }} css={{ color: "blue" }} />`,
      message: jsxCssPropErrorMessages.duplicateCss
    },
    {
      name: "rejects nested duplicate className attributes",
      fixture: `<div {...props} className="base" className="extra" css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.duplicateClassName
    },
    {
      name: "rejects nested shorthand className on css-prop elements",
      fixture: `<div {...props} className css={{ color: "red" }} />`,
      message: jsxCssPropErrorMessages.classNameValue
    }
  ] as const;

  for (const {
    name,
    fixture,
    message
  } of nestedUnsupportedJsxCssPropFixtures) {
    it(name, () => {
      if (fixture === null) {
        expectNestedUnsupportedJsxTargetError();

        return;
      }

      expectNestedJsxCssPropError(fixture, message);
    });
  }

  it("rejects nested invalid className expression on css-prop elements", () => {
    expectNestedInvalidClassNameExpressionError();
  });

  it("keeps Babel css prop tag literals mirrored from React tags", () => {
    const babelTags = [...supportedJsxCssPropTags];

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
    const reactTagModules = import.meta.glob("../../react/src/tags.ts", {
      query: "?raw",
      import: "default",
      eager: true
    });

    const reactTagsSource = Object.values(reactTagModules)[0] as string;
    const [, reactTagsLiteral = ""] =
      /export const tags = \[([\s\S]*?)\] as const/.exec(reactTagsSource) ?? [];

    const reactTags = Array.from(
      reactTagsLiteral.matchAll(/"([^"]+)"/g),
      ([, tag]) => tag
    );

    expect(babelTags).toEqual(reactTags);
  });
});

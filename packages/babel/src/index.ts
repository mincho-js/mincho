import { type PluginObj, transformSync, types as t } from "@babel/core";
import { transformCallExpression } from "./transforms/callExpression.js";
import {
  preprocessJsxCssProp,
  removeUnusedJsxCssPropCssModuleImports
} from "./jsxCssProp.js";
import { supportedJsxCssPropTags } from "./jsxCssPropTags.js";
import postprocess from "./transforms/postprocess.js";
import basePreprocess from "./transforms/preprocess.js";
import type { PluginOptions, PluginState } from "./types.js";
import { styledComponentPlugin } from "./styled.js";

const preprocess = basePreprocess as (
  path: Parameters<typeof basePreprocess>[0],
  state: PluginState
) => void;

export function minchoBabelPlugin(): PluginObj<PluginState> {
  return {
    name: "mincho-babel-plugin",
    visitor: {
      Program: {
        enter(path, state) {
          preprocess(path, state);
          state.opts.jsxCssPropTransformed = preprocessJsxCssProp(path, state);
        },
        exit(path, state) {
          removeUnusedJsxCssPropCssModuleImports(path);
          postprocess(path, state);
        }
      },
      CallExpression: transformCallExpression
    }
  };
}

export { styledComponentPlugin as minchoStyledComponentPlugin } from "./styled.js";
export type { PluginOptions } from "./types.js";

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  function babelTransform(
    code: string,
    pluginOptions: Partial<Pick<PluginOptions, "jsxCssProp">> = {}
  ) {
    const options: PluginOptions = { result: ["", ""], ...pluginOptions };
    const result = transformSync(code, {
      plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]],
      presets: ["@babel/preset-typescript"],
      filename: "test.tsx"
    });

    if (result === null || result.code == null) {
      throw new Error("Failed to transform code");
    }

    return { result: options.result, code: result.code };
  }

  type RuntimeJsx = (
    tag: unknown,
    props?: Record<string, unknown>
  ) => Record<string, unknown>;
  type RuntimeCx = (...values: unknown[]) => string;
  type RuntimeCss = (styles: unknown) => string;

  function runJsxCssPropRuntime(
    source: string,
    returnStatement: string
  ): unknown {
    const { code } = babelTransform(source, { jsxCssProp: true });
    const result = transformSync(code, {
      plugins: [jsxRuntimeTransformPlugin()],
      presets: ["@babel/preset-typescript"],
      filename: "runtime-test.tsx"
    });

    if (result === null) {
      throw new Error("Failed to transform runtime test code");
    }

    const runtimeCode = result.code;

    if (runtimeCode == null) {
      throw new Error("Failed to transform runtime test code");
    }

    const execute = new Function(
      "__minchoJsx",
      "__minchoCx",
      "__minchoCss",
      `${runtimeCode}\n${returnStatement}`
    ) as (jsx: RuntimeJsx, cx: RuntimeCx, css: RuntimeCss) => unknown;

    return execute(
      (_tag, props = {}) => props,
      (...values) => values.filter(Boolean).join(" "),
      () => "css-rule"
    );
  }

  function jsxRuntimeTransformPlugin(): PluginObj {
    return {
      visitor: {
        ImportDeclaration(importPath) {
          if (importPath.node.source.value.endsWith(".css.ts")) {
            const declarations = importPath.node.specifiers.flatMap(
              (specifier) => {
                if (!t.isImportSpecifier(specifier)) {
                  return [];
                }

                return t.variableDeclaration("const", [
                  t.variableDeclarator(
                    t.cloneNode(specifier.local),
                    t.stringLiteral("css-rule")
                  )
                ]);
              }
            );

            if (declarations.length === 0) {
              importPath.remove();
              return;
            }

            importPath.replaceWithMultiple(declarations);
            return;
          }

          if (importPath.node.source.value !== "@mincho-js/css") {
            return;
          }

          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
              if (
                !t.isImportSpecifier(specifier) ||
                !t.isIdentifier(specifier.imported)
              ) {
                return [];
              }

              const runtimeIdentifier = getRuntimeImportIdentifier(
                specifier.imported.name
              );

              if (!runtimeIdentifier) {
                return [];
              }

              return t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.cloneNode(specifier.local),
                  runtimeIdentifier
                )
              ]);
            }
          );

          if (declarations.length === 0) {
            importPath.remove();
            return;
          }

          importPath.replaceWithMultiple(declarations);
        },
        JSXElement(jsxPath) {
          jsxPath.replaceWith(
            t.callExpression(t.identifier("__minchoJsx"), [
              createRuntimeJsxTagExpression(jsxPath.node.openingElement.name),
              createRuntimeJsxPropsExpression(jsxPath.node.openingElement)
            ])
          );
        }
      }
    };
  }

  function getRuntimeImportIdentifier(methodName: string): t.Identifier | null {
    if (methodName === "cx") {
      return t.identifier("__minchoCx");
    }

    if (methodName === "css") {
      return t.identifier("__minchoCss");
    }

    return null;
  }

  function createRuntimeJsxTagExpression(
    name: t.JSXOpeningElement["name"]
  ): t.Expression {
    if (t.isJSXIdentifier(name)) {
      if (/^[a-z]/.test(name.name)) {
        return t.stringLiteral(name.name);
      }

      return t.identifier(name.name);
    }

    if (t.isJSXMemberExpression(name)) {
      return t.memberExpression(
        createRuntimeJsxTagExpression(name.object),
        t.identifier(name.property.name)
      );
    }

    return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
  }

  function createRuntimeJsxPropsExpression(
    openingElement: t.JSXOpeningElement
  ): t.ObjectExpression {
    return t.objectExpression(
      openingElement.attributes.map((attribute) => {
        if (t.isJSXSpreadAttribute(attribute)) {
          return t.spreadElement(t.cloneNode(attribute.argument));
        }

        return t.objectProperty(
          createRuntimeJsxAttributeKey(attribute.name),
          createRuntimeJsxAttributeValue(attribute)
        );
      })
    );
  }

  function createRuntimeJsxAttributeKey(
    name: t.JSXAttribute["name"]
  ): t.Identifier | t.StringLiteral {
    if (t.isJSXNamespacedName(name)) {
      return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
    }

    if (t.isValidIdentifier(name.name)) {
      return t.identifier(name.name);
    }

    return t.stringLiteral(name.name);
  }

  function createRuntimeJsxAttributeValue(
    attribute: t.JSXAttribute
  ): t.Expression {
    if (attribute.value === null) {
      return t.booleanLiteral(true);
    }

    if (t.isStringLiteral(attribute.value)) {
      return t.cloneNode(attribute.value);
    }

    if (t.isJSXExpressionContainer(attribute.value)) {
      const { expression } = attribute.value;

      if (t.isJSXEmptyExpression(expression)) {
        return t.identifier("undefined");
      }

      return t.cloneNode(expression);
    }

    return t.identifier("undefined");
  }

  const jsxCssPropErrorMessages = {
    fragmentTarget:
      "Mincho JSX css prop does not support fragments because fragments cannot receive className",
    namespacedTarget:
      "Mincho JSX css prop does not support namespaced JSX elements",
    spreadAfterCss:
      "Mincho JSX css prop does not support spreads after css in compile-away mode",
    keyRefSpread:
      "Mincho JSX css prop does not support key/ref on spread elements in compile-away mode",
    spreadAggregationContext:
      "Mincho JSX css prop spread aggregation only supports direct return or expression statement JSX in compile-away mode",
    expressionValue: "Mincho JSX css prop requires an expression value",
    cssValue: "Mincho JSX css prop expects a Mincho CSS object/expression",
    unsupportedFunction:
      "Mincho JSX css prop does not support function values in compile-away mode",
    unsupportedDynamicCssRule:
      "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode",
    duplicateCss: "Mincho JSX css prop must appear only once",
    duplicateClassName:
      "Mincho JSX css prop cannot merge duplicate className attributes",
    classNameValue:
      "Mincho JSX css prop requires className to be a string literal or expression"
  } as const;

  function expectJsxCssPropError(fixture: string, message: string) {
    expect(() =>
      babelTransform(
        `
          function App() {
            return ${fixture};
          }
        `,
        { jsxCssProp: true }
      )
    ).toThrow(message);
  }

  describe("minchoBabelPlugin", () => {
    it("export default style", () => {
      const { result, code } = babelTransform(`
        import { style } from "@mincho-js/css";

        export default style({
          color: "red",
        });
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }, 10_000);

    it("inside jsx expression", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function App() {
          return <div class={style({
            color: 'red'
          })}>Hello</div>
        }

        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("leaves jsx css prop unchanged when css prop lowering is disabled", () => {
      const source = `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `;
      const omitted = babelTransform(source);
      const explicitFalse = babelTransform(source, { jsxCssProp: false });

      expect(omitted.result).toMatchSnapshot();
      expect(omitted.code).toMatchSnapshot();
      expect(explicitFalse.result).toEqual(omitted.result);
      expect(explicitFalse.code).toBe(omitted.code);
    });

    it("accepts enabled jsx css prop mode when JSX has no css prop", () => {
      const source = `
        import { style } from '@mincho-js/css';

        function App() {
          return <div class={style({ color: "red" })}>Hello</div>;
        }
      `;
      const disabled = babelTransform(source);
      const enabled = babelTransform(source, { jsxCssProp: true });

      expect(enabled.result).toEqual(disabled.result);
      expect(enabled.code).toBe(disabled.code);
      expect(enabled.result).toMatchSnapshot();
      expect(enabled.code).toMatchSnapshot();
    });

    it("lowers inline object jsx css prop through css rule mode", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_$mincho$$App2}");
    });

    it("merges string literal className before generated css rule class", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div className="base" css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx("base", _$mincho$$App2)}');
    });

    it("merges expression className before class-value css prop", () => {
      const { result, code } = babelTransform(
        `
        const base = "base";
        const styles = {
          root: "root"
        };

        function App() {
          return <div className={base} css={styles.root} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(base, styles.root)}");
      expect(code).not.toContain("_css(styles.root)");
    });

    it("merges expression className before conditional string css prop", () => {
      const { code } = babelTransform(
        `
        const base = "base";
        const condition = true;

        function App() {
          return <div className={base} css={condition ? "active" : "inactive"} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toMatch(
        /className=\{_cx\(base, condition \? "active" : "inactive"\)\}/
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(condition ?");
    });

    it("keeps conditional string css prop in class-value mode", () => {
      const { code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <div css={condition ? "active" : "inactive"} />;
        }
        `,
        { jsxCssProp: true }
      );

      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
      expect(code).not.toContain("_css(condition ?");
    });

    it("keeps intrinsic expression css props in class-value mode", () => {
      const { code } = babelTransform(
        `
        const condition = true;
        const flag = true;
        const providedClass = "provided";
        const maybeClass = null;

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={condition ? "active" : "inactive"} />
            <div css={flag && "active"} />
            <div css={providedClass || "fallback"} />
            <div css={maybeClass ?? "fallback"} />
            <div css={getClassName()} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
      expect(code).toContain('className={_cx(flag && "active")}');
      expect(code).toContain('className={_cx(providedClass || "fallback")}');
      expect(code).toContain('className={_cx(maybeClass ?? "fallback")}');
      expect(code).toContain("className={_cx(getClassName())}");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("_css(condition");
      expect(code).not.toContain("_css(flag");
      expect(code).not.toContain("_css(providedClass");
      expect(code).not.toContain("_css(maybeClass");
      expect(code).not.toContain("_css(getClassName");
    });

    it("direct-emits string-literal class-value jsx css props", () => {
      const { result, code } = babelTransform(
        `
        const motion = { div: "div" };

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <>
            <div css="base" />
            <div css={"base"} />
            <div css="" />
            <div css=" " />
            <div css="base active" />
            <Button css="base" />
            <motion.div css="base" />
            <my-element css="base" />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code.match(/<div className="base" \/>/g) ?? []).toHaveLength(2);
      expect(code).toContain('<div className="" />');
      expect(code).toContain('<div className=" " />');
      expect(code).toContain('<div className="base active" />');
      expect(code).toContain('<Button className="base" />');
      expect(code).toContain('<motion.div className="base" />');
      expect(code).toContain('<my-element className="base" />');
      expect(code).not.toContain("<my-element class=");
    });

    it("keeps non-string literal class-value jsx css props through cx", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <>
            <div css={1} />
            <div css={false} />
            <div css={null} />
            <div css={undefined} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(1)}");
      expect(code).toContain("className={_cx(false)}");
      expect(code).toContain("className={_cx(null)}");
      expect(code).toContain("className={_cx(undefined)}");
    });

    it("keeps mixed literal class-value jsx css props in direct and cx modes", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";

        function App() {
          return <>
            <div css="base" />
            <div css={styleA} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain('import { cx as _cx } from "@mincho-js/css"');
      expect(code).toContain('<div className="base" />');
      expect(code).toContain("<div className={_cx(styleA)} />");
      expect(code).not.toContain('_cx("base")');
    });

    it("lowers array literal jsx css prop through css rule mode", () => {
      const { result, code } = babelTransform(
        `
        const base = "base";

        function App() {
          return <div css={[base, { color: "red" }]} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(result[1]).toContain("_css([base, {");
      expect(result[1]).toContain('color: "red"');
      expect(code).toContain("className={_$mincho$$App2}");
      expect(code).not.toContain("_cx([base");
    });

    it("lowers transparent wrapped direct jsx css prop rules through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={{ color: "red" }!} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }]!} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={{ color: "red" } as const} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }] as const} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={{ color: "red" } satisfies ComplexCSSRule} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }] satisfies ComplexCSSRule} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={({ color: "red" })} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={([base, { color: "red" }])} />`,
          expectedRule: "_css([base, {"
        }
      ] as const;

      for (const { fixture, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;
          const base = "base";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );

        expect(code).not.toContain(" css=");
        expect(code).toContain("className={_$mincho$$App2}");
        expect(code).not.toContain("_cx(");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers conditional object and array jsx css prop branches through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={condition ? { color: "red" } : { color: "blue" }} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? [{ color: "red" }] : [{ color: "blue" }]} />`,
          expectedRule: "_css([{"
        }
      ] as const;

      for (const { fixture, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          const condition = true;

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(
          /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
        );
        expect(code).not.toContain("_cx(condition ?");
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
        expect(result[1]).toContain('color: "blue"');
      }
    });

    it("merges explicit className before pure conditional css rule branches", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <div className="base" css={condition ? { color: "red" } : { color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      );
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("css(condition ?");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
    });

    it("lowers mixed and nullable conditional jsx css prop branches through cx", () => {
      const fixtures = [
        {
          fixture: `<div css={condition ? styleA : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? styleA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? classNameA : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? classNameA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? { color: "red" } : null} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : null\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? { color: "red" } : false} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : false\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? null : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? null : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? false : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? false : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ({ color: "red" } as const) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ({ color: "red" }!) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ([{ color: "red" }] as const) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition ? styleA : ({ color: "red" } satisfies ComplexCSSRule)} />`,
          expectedClassName:
            /className=\{_cx\(condition \? styleA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;
          const condition = true;
          const styleA = "style-a";
          const classNameA = "class-name-a";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(output).not.toContain("_css(styleA)");
        expect(output).not.toContain("_css(classNameA)");
        expect(output).not.toContain("css(styleA)");
        expect(output).not.toContain("css(classNameA)");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers logical and jsx css prop branches through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition && [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition && ([{ color: "red" }] as const)} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition && ({ color: "red" } as const)} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div className="base" css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div {...props} css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(_minchoClassName, condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          const condition = true;
          const props = { className: "base" };

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition &&");
        expect(output).not.toContain("css(condition &&");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers logical OR and nullish right-side css rule fallbacks", () => {
      const fixtures = [
        {
          fixture: `<div css={providedClass || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={providedClass || [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={maybeClass ?? { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={maybeClass ?? [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={providedClass || ({ color: "red" } as const)} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={maybeClass ?? ([{ color: "red" }] satisfies ComplexCSSRule)} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;
          const providedClass = "provided";
          const maybeClass = null;

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(code).not.toMatch(/_cx\((providedClass|maybeClass), _\$mincho/);
        expect(output).not.toContain("_css(providedClass");
        expect(output).not.toContain("_css(maybeClass");
        expect(output).not.toContain("css(providedClass");
        expect(output).not.toContain("css(maybeClass");
        expect(result[1]).toContain(expectedRule);
        expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
      }
    });

    it("simplifies static-left logical OR and nullish css rule operands", () => {
      const fixtures = [
        {
          fixture: `<div css={{ color: "red" } || providedClass} />`,
          expectedRule: "_css({",
          forbiddenValues: ["providedClass", 'color: "blue"']
        },
        {
          fixture: `<div css={[{ color: "red" }] || providedClass} />`,
          expectedRule: "_css([{",
          forbiddenValues: ["providedClass", 'color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } ?? maybeClass} />`,
          expectedRule: "_css({",
          forbiddenValues: ["maybeClass", 'color: "blue"']
        },
        {
          fixture: `<div css={[{ color: "red" }] ?? maybeClass} />`,
          expectedRule: "_css([{",
          forbiddenValues: ["maybeClass", 'color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } || { color: "blue" }} />`,
          expectedRule: "_css({",
          forbiddenValues: ['color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } ?? { color: "blue" }} />`,
          expectedRule: "_css({",
          forbiddenValues: ['color: "blue"']
        }
      ] as const;

      for (const { fixture, expectedRule, forbiddenValues } of fixtures) {
        const { result, code } = babelTransform(
          `
          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
        expect(code).not.toMatch(/className=\{_cx\(_\$mincho\$\$App\d+\)\}/);
        expect(code).not.toContain("_cx(");
        expect(result[1]).toContain(expectedRule);
        expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);

        for (const forbiddenValue of forbiddenValues) {
          expect(output).not.toContain(forbiddenValue);
        }
      }
    });

    it("treats static-left logical AND css rule operands as truthy guards", () => {
      const fixtures = [
        `<div css={{ color: "red" } && providedClass} />`,
        `<div css={[{ color: "red" }] && providedClass} />`,
        `<div css={({ color: "red" } as const) && providedClass} />`
      ] as const;

      for (const fixture of fixtures) {
        const { result, code } = babelTransform(
          `
          const providedClass = "provided";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(/className=\{_cx\(providedClass\)\}/);
        expect(result[1]).not.toContain("_css(");
        expect(output).not.toContain('color: "red"');
      }
    });

    it("extracts only the right css rule for both-side static logical AND", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div css={{ color: "red" } && { color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(code).not.toMatch(/className=\{_cx\(_\$mincho\$\$App\d+\)\}/);
      expect(code).not.toContain("_cx(");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(1);
      expect(output).not.toContain('color: "red"');
    });

    it("merges explicit className before generated-only static logical css rule", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div className="base" css={{ color: "red" } || providedClass} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_cx\("base", _\$mincho\$\$App\d+\)\}/);
      expect(output).not.toContain("providedClass");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
    });

    it("aggregates spread props before generated-only static logical css rule", () => {
      const { result, code } = babelTransform(
        `
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={{ color: "red" } || providedClass} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
      expect(code).toMatch(
        /className=\{_cx\(_minchoClassName, _\$mincho\$\$App\d+\)\}/
      );
      expect(output).not.toContain("providedClass");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
    });

    it("omits cx import for generated-only static logical css rules", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <>
            <div css={{ color: "red" } || providedClass} />
            <div css={[{ color: "green" }] ?? maybeClass} />
            <div css={{ color: "blue" } && { color: "purple" }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;
      const generatedClassNames = code.match(
        /className=\{_\$mincho\$\$App\d+\}/g
      );

      expect(code).not.toContain(" css=");
      expect(generatedClassNames ?? []).toHaveLength(3);
      expect(code).not.toContain("_cx(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('color: "purple"');
      expect(output).not.toContain('color: "blue"');
      expect(output).not.toContain("providedClass");
      expect(output).not.toContain("maybeClass");
    });

    it("preserves static-left logical css branch runtime side effects", () => {
      const observed = runJsxCssPropRuntime(
        `
        let fallbackCalls = 0;
        let providedCalls = 0;

        function getFallback() {
          fallbackCalls += 1;
          return "fallback";
        }

        function getProvided() {
          providedCalls += 1;
          return "provided";
        }

        function App() {
          const orProps = <div css={{ color: "red" } || getFallback()} />;
          const nullishProps = <div css={[{ color: "green" }] ?? getFallback()} />;
          const andProps = <div css={{ color: "blue" } && getProvided()} />;
          return { orProps, nullishProps, andProps };
        }
      `,
        "return { result: App(), fallbackCalls, providedCalls };"
      ) as {
        result: {
          orProps: Record<string, unknown>;
          nullishProps: Record<string, unknown>;
          andProps: Record<string, unknown>;
        };
        fallbackCalls: number;
        providedCalls: number;
      };

      expect(observed.fallbackCalls).toBe(0);
      expect(observed.providedCalls).toBe(1);
      expect(observed.result.orProps.className).toBe("css-rule");
      expect(observed.result.nullishProps.className).toBe("css-rule");
      expect(observed.result.andProps.className).toBe("provided");
    });

    it("lowers transparent wrapped branch jsx css prop expressions", () => {
      const fixtures = [
        {
          fixture: `<div css={(condition ? { color: "red" } : { color: "blue" }) as const} />`,
          expectedClassName:
            /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/,
          expectedRule: "_css({",
          expectedBlueRule: true
        },
        {
          fixture: `<div css={(condition && { color: "red" }) as unknown} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({",
          expectedBlueRule: false
        }
      ] as const;

      for (const {
        fixture,
        expectedClassName,
        expectedRule,
        expectedBlueRule
      } of fixtures) {
        const { result, code } = babelTransform(
          `
          const condition = true;

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(output).not.toContain("_css(condition &&");
        expect(output).not.toContain("css(condition &&");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');

        if (expectedBlueRule) {
          expect(result[1]).toContain('color: "blue"');
        }
      }
    });

    it("lowers explicit cx array class values through class-value mode", () => {
      const { result, code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const isActive = true;

        function App() {
          return <div css={cx(["base", isActive && "active"])} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain(
        'className={_cx(cx(["base", isActive && "active"]))}'
      );
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
      expect(code).toContain(
        "className={_cx(_minchoClassName, _$mincho$$App2)}"
      );
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

    it("rejects unbraced if return spread aggregation", () => {
      expect(() =>
        babelTransform(
          `
          const styleA = "style-a";

          function App(props, ok) {
            if (ok) return <div {...props} css={styleA} />;
            return null;
          }
        `,
          { jsxCssProp: true }
        )
      ).toThrow(jsxCssPropErrorMessages.spreadAggregationContext);
    });

    it("rejects unbraced if expression statement spread aggregation", () => {
      expect(() =>
        babelTransform(
          `
          const styleA = "style-a";

          function App(props, ok) {
            if (ok) <div {...props} css={styleA} />;
          }
        `,
          { jsxCssProp: true }
        )
      ).toThrow(jsxCssPropErrorMessages.spreadAggregationContext);
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
        name: "rejects spreads after css on css-prop elements",
        fixture: `<div css={styleA} {...props} />`,
        message: jsxCssPropErrorMessages.spreadAfterCss
      },
      {
        name: "rejects spreads after css even when earlier spreads exist",
        fixture: `<div {...a} css={styleA} {...b} />`,
        message: jsxCssPropErrorMessages.spreadAfterCss
      },
      {
        name: "rejects explicit key on spread-aggregated css-prop elements",
        fixture: `<div key="x" {...props} css={styleA} />`,
        message: jsxCssPropErrorMessages.keyRefSpread
      },
      {
        name: "rejects explicit ref on spread-aggregated css-prop components",
        fixture: `<Component ref={ref} {...props} css={styleA} />`,
        message: jsxCssPropErrorMessages.keyRefSpread
      },
      {
        name: "rejects expression-bodied arrow spread aggregation",
        fixture: `(() => {
          const App = (props) => <div {...props} css={styleA} />;
          return <App />;
        })()`,
        message: jsxCssPropErrorMessages.spreadAggregationContext
      },
      {
        name: "rejects conditional spread aggregation",
        fixture: `ok ? <div {...props} css={styleA} /> : null`,
        message: jsxCssPropErrorMessages.spreadAggregationContext
      },
      {
        name: "rejects logical spread aggregation",
        fixture: `ok && <div {...props} css={styleA} />`,
        message: jsxCssPropErrorMessages.spreadAggregationContext
      },
      {
        name: "rejects call-argument spread aggregation",
        fixture: `render(<div {...props} css={styleA} />)`,
        message: jsxCssPropErrorMessages.spreadAggregationContext
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
        name: "rejects chained logical object literal css rule values",
        fixture: `<div css={condition && flag && { color: "red" }} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested logical object literal css rule fallback values",
        fixture: `<div css={(condition && flag) || { color: "red" }} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects chained OR logical object literal css rule values",
        fixture: `<div css={a || b || { color: "red" }} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested conditional object literal css rule values",
        fixture: `<div css={outer ? inner ? { color: "red" } : { color: "blue" } : styleA} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
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

    it("keeps Babel css prop tag literals mirrored from React tags", () => {
      const babelTags = [...supportedJsxCssPropTags];
      const reactTagModules = import.meta.glob("../../react/src/tags.ts", {
        query: "?raw",
        import: "default",
        eager: true
      });
      const reactTagsSource = Object.values(reactTagModules)[0] as string;
      const [, reactTagsLiteral = ""] =
        /export const tags = \[([\s\S]*?)\] as const/.exec(reactTagsSource) ??
        [];
      const reactTags = Array.from(
        reactTagsLiteral.matchAll(/"([^"]+)"/g),
        ([, tag]) => tag
      );

      expect(babelTags).toEqual(reactTags);
    });

    it("hoists inline expression", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const str = \`abc \${style({ color: "red" })}\`;
        console.log(str);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("hoists object property", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const obj = {
          nested: {
            key: style({ color: "red" })
          }
        };
        console.log(obj);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("hoists array member", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const arr = [1, 2, style({ color: "red" }), 4, style({ color: "blue" })];
        console.log(arr);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("extracts style function", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const red = style({ color: "red" });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("leaves defineRules call shape untouched", () => {
      const { code } = babelTransform(`
        import { defineRules } from '@mincho-js/css';

        defineRules({
          properties: {
            color: String,
          },
          shortcuts: {
            text: {
              color: 'red',
            },
          },
        });
      `);

      expect(code).toContain("defineRules({");
    });

    it("extracts $mincho function", () => {
      const { result, code } = babelTransform(`
        import { style, mincho$ } from '@mincho-js/css';
        const red = mincho$(() => {
          return 2 + 2;
        });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("multiple variable declarators in one declaration", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' }),
        blue = style({ color: 'blue' }),
        green = style({ color: 'green' });

      console.log(red, blue, green);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("move bindings along with extracted style", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      const redColor = 'red';
      const red = style({ color: redColor });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("inside block scope", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      {
        const red = style({ color: 'red' });
        console.log(red);
      }
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("already exported", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      export const red = style({ color: 'red' });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // doesn't work
    it("hoisting same variable name in different scope", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' });
      console.log(red);

      function SomeComponent() {
        const red = style({ color: 'blue' });
        console.log(red)
      }
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // it("array pattern hoisting", () => {
    //   const { result, code } = babelTransform(`
    //   import { createTheme } from '@mincho-js/css';

    //   const [themeClass, vars] = createTheme({
    //     colors: {
    //       brand: 'red'
    //     }
    //   });
    //   console.log(themeClass, vars);
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("same binding in multiple declarations", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const foreground = style({ color });
      const background = style({ background: color });

      console.log(foreground, background)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("binding ordering", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const red = style({ color });
      const longClass = \`abc \${red}\`;
      console.log(longClass)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("nested bindings", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const theme = { color: 'red' };
      const themeColor = theme.color;
      const color = themeColor;

      const red = style({ color });
      console.log(red)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // it("css variables", () => {
    //   const { result, code } = babelTransform(`
    //   import { style, createVar } from '@mincho-js/css';

    //   const colorVar = createVar();

    //   const red = style({
    //     color: 'red',
    //     vars: {
    //       [colorVar]: 'red'
    //     }
    //   });
    //   console.log(red)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("global styles", () => {
      const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      globalStyle('html, body', {
        color: 'red',
      });
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("arrow function bindings", () => {
      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const utility = { gap: (size) => ({ gap: size }) }
        const red = style({ ...utility.gap('10px') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }

      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const getStyles = (color) => ({ color })
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }
    });

    it("function declaration bindings", () => {
      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getColor() { return 'red' }
        const red = style({ color: getColor() });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }

      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getStyles(color) { return { color } }
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }
    });

    it("mincho-ignore doesn't extract expression", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = /* mincho-ignore */ style({ color: "red" });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // it("react styled components get converted to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/react';

    //   const Button = styled("button", {
    //     base: { color: 'red' }
    //   })
    //   console.log(Button)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    // it("solid styled components get converted to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/solid';

    //   const Button = styled("button", {
    //     base: { color: 'red' }
    //   })
    //   console.log(Button)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    // it("leading comments of `styled` get passed to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/solid';
    //   import {macaron$} from '@mincho-js/css';

    //   const fn = () => {
    //     const arr = [1,2]
    //     for (const _ of arr) {
    //       const Button = /* macaron-ignore */ styled("button", {
    //         base: { color: _ }
    //       })
    //     }
    //     return Button;
    //   }
    //   const test = macaron$(() => {
    //     console.log(fn())
    //     return "test"
    //   })
    //   console.log(test)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("mincho-ignore on parent node", () => {
      const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      /* mincho-ignore */ globalStyle("html", { color: 'red' })
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });
  });
}

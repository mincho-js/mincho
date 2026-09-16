import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { createImportedStaticCssEvalProvider } from "./staticCssEval/importedModules.js";
import { typescriptPresetPath } from "./testUtils/babel.js";
import {
  babelTransform,
  captureJsxCssPropFailure,
  createResolvedStaticCssEvalProvider,
  createUnsupportedReexportStaticCssEvalProvider,
  reactStyleGuidancePattern,
  runJsxCssPropRuntime,
  staticShapeDiagnosticPattern
} from "./testUtils/plugin.js";

describe("minchoBabelPlugin", () => {
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

  it("lowers same-file const object jsx css prop like an inline object", () => {
    const inline = babelTransform(
      `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const sameFileConst = babelTransform(
      `
        const style = { color: "red" };

        function App() {
          return <div css={style} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(sameFileConst.code).not.toContain(" css=");
    expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
    expect(sameFileConst.code).not.toContain("_cx(style)");
    expect(sameFileConst.result[1]).toBe(inline.result[1]);
  });

  it("lowers same-file const member jsx css prop like an inline object", () => {
    const { result, code } = babelTransform(
      `
        const styles = {
          button: { color: "red" }
        };

        function App() {
          return <div css={styles.button} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_$mincho$$App2}");
    expect(code).not.toContain("_cx(styles.button)");
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
  });

  it("lowers static computed keys and optional members like inline css rules", () => {
    const { result, code } = babelTransform(
      `
        const colorKey = "color" as const;
        const variantKey = "button" as const;
        const styles = {
          button: { color: "blue" },
          optional: { card: { padding: 16 } }
        } as const;

        function App() {
          return <>
            <div css={{ [colorKey]: "red" }} />
            <div css={styles[variantKey]} />
            <div css={styles.optional?.card} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_cx(");
    expect(code.match(/className=\{_\$mincho\$\$App\d+\}/g)).toHaveLength(3);
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).toContain("padding: 16");
  });

  it("lowers provider-resolved imported css props like inline object and array literals", () => {
    const inline = babelTransform(
      `
        function App() {
          return <>
            <div css={{ color: "red" }} />
            <div css={["base", { color: "blue" }]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const imported = babelTransform(
      `
        import { button, stack } from "./styles";

        function App() {
          return <>
            <div css={button} />
            <div css={stack} />
          </>;
        }
      `,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          button: { color: "red" },
          stack: ["base", { color: "blue" }]
        })
      }
    );

    expect(imported.result[1]).toBe(inline.result[1]);
    expect(imported.code).not.toContain(" css=");
    expect(imported.code).not.toContain("_cx(button)");
    expect(imported.code).not.toContain("_cx(stack)");
    expect(
      imported.code.match(/className=\{_\$mincho\$\$App\d+\}/g)
    ).toHaveLength(2);
  });

  it("records imported static css eval metadata during css prop lowering", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const source = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;

    const { result, code, metadata } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `export const button = { color: "red" } as const;`
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    const staticCssEvalMetadata = metadata.minchoStaticCssEval;

    expect(staticCssEvalMetadata?.dependencies[0]?.file).toBe(stylesFile);
    expect(staticCssEvalMetadata?.dependencies[0]?.contributed).toBe(true);
    expect(staticCssEvalMetadata?.diagnostics).toEqual([]);
    expect(staticCssEvalMetadata?.cacheKeys[0]?.resolvedId).toBe(stylesFile);
    expect(staticCssEvalMetadata?.resolvedModuleIds).toContain(stylesFile);
    expect(code).not.toContain(" css=");
    expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
    expect(code).not.toContain("_cx(button)");
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
  });

  it("lowers whole namespace object imported css prop through static provider", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const source = `
        import * as styles from "./styles";

        function App() {
          return <div css={styles} />;
        }
      `;

    const { result, code } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `export const button = { color: "red" } as const;
                         export const card = { color: "blue" } as const;`
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
    expect(code).not.toContain("_cx(styles)");
    expect(result[1]).toContain("button: {");
    expect(result[1]).toContain("card: {");
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
  });

  it("keeps local lexical shadowing ahead of whole namespace css prop resolution", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const source = `
        import * as styles from "./styles";

        function App() {
          const styles = { color: "blue" };
          return <div css={styles} />;
        }
      `;

    const { result, code } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `export const remote = { color: "red" } as const;`
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
    expect(code).not.toContain("_cx(styles)");
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).not.toContain('color: "red"');
  });

  it("merges expression className before provider-resolved css rule class", () => {
    const { result, code } = babelTransform(
      `
        import { button } from "./styles";

        const base = "base";

        function App() {
          return <div className={base} css={button} />;
        }
      `,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          button: { color: "red" }
        })
      }
    );

    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain(" css=");
    expect(code).toMatch(/className=\{_cx\(base, _\$mincho\$\$App\d+\)\}/);
    expect(code).not.toMatch(/className=\{_cx\(_\$mincho\$\$App\d+, base\)\}/);
    expect(code).not.toContain("_cx(button)");
  });

  it("preserves provider reexport fallback for whole css values but rejects them inside static rules", () => {
    const provider = createUnsupportedReexportStaticCssEvalProvider();
    const wholeExpression = babelTransform(
      `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `,
      { jsxCssProp: true, staticCssEvalProvider: provider }
    );

    expect(wholeExpression.result[1]).toBe("");
    expect(wholeExpression.code).not.toContain(" css=");
    expect(wholeExpression.code).toContain("className={_cx(button)}");
    expect(wholeExpression.code).not.toContain("_css(button)");

    expect(() =>
      babelTransform(
        `
          import { button } from "./barrel";

          function App() {
            return <div css={{ color: button }} />;
          }
        `,
        { jsxCssProp: true, staticCssEvalProvider: provider }
      )
    ).toThrow(
      'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
    );
  });

  it("respects Babel scope when same-file const css prop bindings shadow", () => {
    const { result, code } = babelTransform(
      `
        const style = { color: "red" };

        function App() {
          const style = { color: "blue" };
          return <div css={style} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_$mincho$$App2}");
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).not.toContain('color: "red"');
  });

  it("preserves dynamic and mutable identifier css props as class values", () => {
    const { result, code } = babelTransform(
      `
        const className = getClassName();
        let style = { color: "red" };

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={className} />
            <div css={style} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(className)}");
    expect(code).toContain("className={_cx(style)}");
    expect(code).not.toContain("_css(className)");
    expect(code).not.toContain("_css(style)");
    expect(result[1]).not.toContain("_css(");
  });

  it("rejects mutated same-file const object jsx css prop bindings", () => {
    expect(() =>
      babelTransform(
        `
          const style = { color: "red" };
          style.color = "blue";

          function App() {
            return <div css={style} />;
          }
        `,
        { jsxCssProp: true }
      )
    ).toThrow(
      'Cannot statically evaluate css prop value: same-file binding "style" is mutated'
    );
  });

  it("lowers same-file const practical literal grammar like an inline object", () => {
    const inline = babelTransform(
      `
        function App() {
          return <div css={{
            color: "red",
            opacity: -1,
            zIndex: +2,
            enabled: true,
            empty: null,
            fallbacks: ["red", "blue"],
            selectors: {
              "&:hover": {
                color: "blue"
              }
            }
          }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const sameFileConst = babelTransform(
      `
        const style = {
          color: \`red\`,
          opacity: -1,
          zIndex: +2,
          enabled: true,
          empty: null,
          fallbacks: ["red", \`blue\`],
          selectors: {
            "&:hover": {
              color: \`blue\`
            }
          }
        };

        function App() {
          return <div css={style} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(sameFileConst.code).not.toContain(" css=");
    expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
    expect(sameFileConst.code).not.toContain("_cx(style)");
    expect(sameFileConst.result[1]).toBe(inline.result[1]);
    expect(sameFileConst.result[1]).toContain('color: "red"');
    expect(sameFileConst.result[1]).toContain("opacity: -1");
    expect(sameFileConst.result[1]).toContain("zIndex: 2");
  });

  it("normalizes direct inline object spreads and extracts static array spreads before jsx css prop classification", () => {
    const inlineObject = babelTransform(
      `
        function App() {
          return <div css={{ display: "flex", color: "blue" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const spreadObject = babelTransform(
      `
        const base = { display: "flex", color: "red" } as const;

        function App() {
          return <div css={{ ...base, color: "blue" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const spreadArray = babelTransform(
      `
        const stack = [{ display: "flex" }] as const;

        function App() {
          return <div css={[...stack, { gap: 8 }]} />;
        }
      `,
      { jsxCssProp: true }
    );

    const objectOutput = `${spreadObject.code}\n${spreadObject.result.join("\n")}`;

    expect(spreadObject.result[1]).toBe(inlineObject.result[1]);
    expect(spreadObject.code).not.toContain(" css=");
    expect(spreadObject.code).not.toContain("...base");
    expect(spreadObject.code).not.toContain("_cx(base)");
    expect(spreadArray.code).not.toContain(" css=");
    expect(spreadArray.code).not.toContain("...stack");
    expect(spreadArray.code).not.toContain("_cx(stack)");
    expect(spreadArray.code).not.toContain("unsupported-array-spread");
    expect(spreadArray.result[1]).toContain("_css([...stack,");
    expect(spreadArray.result[1]).toContain('display: "flex"');
    expect(spreadArray.result[1]).toContain("gap: 8");
    expect(objectOutput).not.toContain("...base");
    expect(spreadArray.result[1]).toContain("...stack");
  });

  it("normalizes direct inline provider imported operands with metadata", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const source = `
        import { base, stack, tokens } from "./styles";
        const isActive = true;

        function App() {
          return <>
            <div css={{ ...base, color: tokens.color, active: isActive }} />
            <div css={[...stack, { gap: 8 }]} />
          </>;
        }
      `;

    const { result, code, metadata } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `
                  export const base = { display: "flex", color: "red" } as const;
                  export const stack = [{ alignItems: "center" }] as const;
                  export const tokens = { color: "blue" } as const;
                `
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    const staticCssEvalMetadata = metadata.minchoStaticCssEval;
    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("...base");
    expect(code).not.toContain("...stack");
    expect(code).not.toContain("_cx(base)");
    expect(code).not.toContain("_cx(stack)");
    expect(result[1]).toContain("_css({");
    expect(result[1]).toContain("_css([{");
    expect(result[1]).toContain('display: "flex"');
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).toContain("active: isActive");
    expect(result[1]).toContain('alignItems: "center"');
    expect(result[1]).toContain("gap: 8");
    expect(output).not.toContain("...base");
    expect(output).not.toContain("...stack");
    expect(staticCssEvalMetadata?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: stylesFile,
          exportName: "base",
          inspected: true,
          contributed: true
        }),
        expect.objectContaining({
          file: stylesFile,
          exportName: "tokens",
          memberPath: ["color"],
          inspected: true,
          contributed: true
        }),
        expect.objectContaining({
          file: stylesFile,
          exportName: "stack",
          inspected: true,
          contributed: true
        })
      ])
    );
    expect(staticCssEvalMetadata?.cacheKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resolvedId: stylesFile,
          staticEvalSupportVersion: "static-css-module-export-graph:v6"
        })
      ])
    );
    expect(staticCssEvalMetadata?.resolvedModuleIds).toContain(stylesFile);
  });

  it("preserves inline fallback booleans without overriding spread precedence", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const source = `
        import { base, flags } from "./styles";
        const isActive = true;

        function App() {
          return <>
            <div css={{ ...base, active: isActive }} />
            <div css={{ active: isActive, ...base }} />
            <div css={{ nested: { active: isActive, ...base } }} />
            <div css={[...flags, isActive]} />
          </>;
        }
      `;

    const { result, code } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `
                  export const base = { display: "flex", active: false } as const;
                  export const flags = [false, false, { color: "red" }] as const;
                `
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    expect(result[1]).toContain("active: isActive");
    expect(result[1]).toContain("active: false");
    expect(result[1]).toMatch(
      /nested: \{\s+active: false,\s+display: "flex"\s+\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(false, false, _\$mincho\$\$App\d+, isActive\)\}/
    );
  });

  it("does not count shallow alias hops as object recursion depth", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const aliases = Array.from(
      { length: 50 },
      (_, index) => `const a${index + 1} = a${index};`
    ).join("\n");

    const source = `
        import { base } from "./styles";
        const a0 = { color: "red" };
        ${aliases}

        function App() {
          return <div css={{ ...base, nested: a50 }} />;
        }
      `;

    const { result } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: stylesFile,
              source: `export const base = { display: "flex" } as const;`
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "./styles",
              resolvedId: stylesFile
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    expect(result[1]).toContain('color: "red"');
  });

  it("rejects over-depth direct inline provider operands", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const nestedRule = Array.from({ length: 51 }).reduce<string>(
      (value) => `{ nested: ${value} }`,
      '"leaf"'
    );

    const source = `
        import { base } from "./styles";

        function App() {
          return <div css={{ ...base, nested: ${nestedRule} }} />;
        }
      `;

    expect(() =>
      babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const base = { display: "flex" } as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      )
    ).toThrow("max object/array recursion depth exceeded");
  });

  it("rejects over-node-count direct inline provider operands", () => {
    const ownerFile = "/project/src/App.tsx";
    const stylesFile = "/project/src/styles.ts";
    const classValues = Array.from({ length: 10_000 }, () => "true").join(", ");
    const source = `
        import { stack } from "./styles";

        function App() {
          return <div css={[...stack, ${classValues}]} />;
        }
      `;

    expect(() =>
      babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const stack = ["base"] as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      )
    ).toThrow("max static literal node count exceeded");
  });

  it("records package data and virtual provider metadata for direct inline operands", () => {
    const ownerFile = "/project/src/App.tsx";
    const packageBarrelFile = "pkg:@scope/styles";
    const packageDataFile = "data:@scope/styles/tokens";
    const virtualFile = "virtual:mincho-styles";
    const source = `
        import { base } from "@scope/styles";
        import virtualTokens from "virtual:mincho-styles";

        function App() {
          return <div css={{ ...base, accent: virtualTokens.accent }} />;
        }
      `;

    const { result, code, metadata } = babelTransform(
      source,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createImportedStaticCssEvalProvider({
          modules: [
            { id: ownerFile, source },
            {
              id: packageBarrelFile,
              source: `export { base } from "@scope/styles/tokens";`,
              sourceKind: "package-source",
              sourceOrigin: "package"
            },
            {
              id: packageDataFile,
              source: `export const base = { color: "green" } as const;`,
              sourceKind: "static-data",
              sourceOrigin: "data"
            },
            {
              id: virtualFile,
              source: `export default { accent: "purple" } as const;`,
              sourceKind: "provider-virtual",
              sourceOrigin: "provider"
            }
          ],
          importResolutions: [
            {
              importerId: ownerFile,
              importPath: "@scope/styles",
              resolvedId: packageBarrelFile,
              sourceKind: "package-source",
              sourceOrigin: "package"
            },
            {
              importerId: packageBarrelFile,
              importPath: "@scope/styles/tokens",
              resolvedId: packageDataFile,
              sourceKind: "static-data",
              sourceOrigin: "data"
            },
            {
              importerId: ownerFile,
              importPath: "virtual:mincho-styles",
              resolvedId: virtualFile,
              sourceKind: "provider-virtual",
              sourceOrigin: "provider"
            }
          ]
        })
      },
      { filename: ownerFile }
    );

    const staticCssEvalMetadata = metadata.minchoStaticCssEval;

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("...base");
    expect(result[1]).toContain('color: "green"');
    expect(result[1]).toContain('accent: "purple"');
    expect(staticCssEvalMetadata?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: packageDataFile,
          sourceKind: "static-data",
          sourceOrigin: "data",
          contributed: true
        }),
        expect.objectContaining({
          file: virtualFile,
          sourceKind: "provider-virtual",
          sourceOrigin: "provider",
          contributed: true
        })
      ])
    );
    expect(staticCssEvalMetadata?.resolvedModuleIds).toEqual(
      expect.arrayContaining([packageDataFile, virtualFile])
    );
  });

  it("resolves same-file const object member path grammar", () => {
    const fixtures = [
      {
        expression: "styles.button.primary",
        inlineCss: `{ color: "blue" }`,
        expectedColor: 'color: "blue"'
      },
      {
        expression: 'styles["button"]',
        inlineCss: `{ color: "red", primary: { color: "blue" } }`,
        expectedColor: 'color: "red"'
      },
      {
        expression: 'styles["button"].primary',
        inlineCss: `{ color: "blue" }`,
        expectedColor: 'color: "blue"'
      }
    ] as const;

    for (const { expression, inlineCss, expectedColor } of fixtures) {
      const inline = babelTransform(
        `
          function App() {
            return <div css={${inlineCss}} />;
          }
        `,
        { jsxCssProp: true }
      );

      const sameFileConst = babelTransform(
        `
          const styles = {
            button: {
              color: "red",
              primary: { color: "blue" }
            }
          };

          function App() {
            return <div css={${expression}} />;
          }
        `,
        { jsxCssProp: true }
      );

      expect(sameFileConst.code).not.toContain(" css=");
      expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
      expect(sameFileConst.code).not.toContain(`_cx(${expression})`);
      expect(sameFileConst.result[1]).toBe(inline.result[1]);
      expect(sameFileConst.result[1]).toContain(expectedColor);
    }
  });

  it("rejects unsupported same-file static css literal grammar deterministically", () => {
    const fixtures = [
      {
        setup: `const tokens = { primary: "red" }; const style = { color: \`\${tokens}\` };`,
        expression: "style",
        reason: "dynamic expression is unsupported"
      },
      {
        setup: `const styles = null;`,
        expression: "styles?.button",
        reason: "dynamic expression is unsupported"
      },
      {
        setup: `function getKey() { return "button"; } const styles = { button: { color: "red" } };`,
        expression: "styles[getKey()]",
        reason: "dynamic expression is unsupported"
      }
    ] as const;

    for (const { setup, expression, reason } of fixtures) {
      expect(() =>
        babelTransform(
          `
            ${setup}

            function App() {
              return <div css={${expression}} />;
            }
          `,
          { jsxCssProp: true }
        )
      ).toThrow("Cannot statically evaluate css prop value");
      expect(() =>
        babelTransform(
          `
            ${setup}

            function App() {
              return <div css={${expression}} />;
            }
          `,
          { jsxCssProp: true }
        )
      ).toThrow(reason);
    }
  });

  it("records dynamic expression types without weakening computed member errors", () => {
    const source = `
        function getRule() {
          return { color: "red" };
        }
        const styles = { button: getRule() };

        function App() {
          return <div css={styles["button"]} />;
        }
      `;

    expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
      "dynamic expression is unsupported: CallExpression"
    );

    const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

    expect(
      failure.metadata.minchoStaticCssEval?.diagnostics.map(
        ({ expressionType }) => expressionType
      )
    ).toContain("CallExpression");
  });

  it("records static css eval metadata before unsupported css prop failures", () => {
    const source = `
        const styles = {
          button: { color: "red" }
        };

        function App(variant) {
          return <div css={styles[variant]} />;
        }
      `;

    expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
      "computed member access is unsupported"
    );

    const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
    const staticCssEvalMetadata = failure.metadata.minchoStaticCssEval;

    expect(failure.error.message).toContain(
      "computed member access is unsupported"
    );
    expect(staticCssEvalMetadata?.diagnostics.map(({ id }) => id)).toContain(
      "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
    );
    expect(
      staticCssEvalMetadata?.diagnostics.map(({ reason }) => reason)
    ).toContain("dynamic-member-path");
    expect(failure.code).not.toContain('from "@mincho-js/css"');
    expect(failure.code).not.toContain("_css(");
    expect(failure.code).not.toContain("_cx(");
  });

  it("preserves class-value fallback when static css rule candidacy is unproven", () => {
    const { result, code } = babelTransform(
      `
        import { cx } from "@mincho-js/css";

        const key = "root";
        const styles = { root: "root" };
        let mutable = { button: { color: "red" } };

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={styles[key]} />
            <div css={styles?.root} />
            <div css={styles[0]} />
            <div css={mutable.button} />
            <div css={cx(getClassName())} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(styles[key])}");
    expect(code).toContain("className={_cx(styles?.root)}");
    expect(code).toContain("className={_cx(styles[0])}");
    expect(code).toContain("className={_cx(mutable.button)}");
    expect(code).toContain("className={_cx(cx(getClassName()))}");
    expect(result[1]).not.toContain("_css(");
  });

  it("preserves unresolved top-level css prop references as class values", () => {
    const { result, code } = babelTransform(
      `
        const className = "panel";

        function App() {
          return <>
            <div css={className} />
            <div css={unknownClassName} />
            <div css={externalStyles.button} />
          </>;
        }
      `,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({})
      }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(className)}");
    expect(code).toContain("className={_cx(unknownClassName)}");
    expect(code).toContain("className={_cx(externalStyles.button)}");
    expect(code).not.toContain("_css(className)");
    expect(result[1]).not.toContain("_css(");
  });

  it("lowers direct inline css rule calls and rejects functions through static eval diagnostics", () => {
    const callRule = babelTransform(
      `
        function getColor() {
          return "red";
        }

        function App() {
          return <div css={{ color: getColor() }} />;
        }
      `,
      { jsxCssProp: true }
    );

    const functionFailure = captureJsxCssPropFailure(
      `
        function App() {
          return <div css={{ color: () => "red" }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(callRule.code).not.toContain(" css=");
    expect(callRule.code).not.toContain("style=");
    expect(callRule.code).not.toContain("_css(");
    expect(callRule.result[1]).toContain("_css({");
    expect(callRule.result[1]).toContain("color: getColor()");
    expect(functionFailure.error.message).toContain(
      "dynamic expression is unsupported: ArrowFunctionExpression"
    );
    expect(
      functionFailure.metadata.minchoStaticCssEval?.diagnostics.map(
        ({ id }) => id
      )
    ).toContain("STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED");
    expect(
      functionFailure.metadata.minchoStaticCssEval?.diagnostics.map(
        ({ reason }) => reason
      )
    ).toContain("runtime-dynamic-value");
  });

  it("evaluates explicit cx class-value css prop calls once", () => {
    const source = `
        import { cx } from "@mincho-js/css";

        let callCount = 0;

        function getClassName() {
          callCount += 1;
          return "dynamic";
        }

        function App() {
          return <div css={cx(getClassName())} />;
        }
      `;

    const { result, code } = babelTransform(source, { jsxCssProp: true });
    const observed = runJsxCssPropRuntime(
      source,
      "return { props: App(), callCount };"
    ) as { props: Record<string, unknown>; callCount: number };

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(cx(getClassName()))}");
    expect(code).not.toContain("_css(getClassName())");
    expect(result[1]).not.toContain("_css(");
    expect(observed.callCount).toBe(1);
    expect(observed.props.className).toBe("dynamic");
    expect("css" in observed.props).toBe(false);
  });

  it("normalizes same-file static css rule member-expression object values", () => {
    const { result, code } = babelTransform(
      `
        const theme = { color: "red" };
        const style = { color: theme.color };

        function App() {
          return <div css={style} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_$mincho$$App2}");
    expect(code).not.toContain("_cx(style)");
    expect(result[1]).toContain('color: "red"');
  });

  it("keeps conditional const object css prop values in class-value mode", () => {
    const { result, code } = babelTransform(
      `
        const condition = true;
        const style = condition ? { color: "red" } : {};

        function App() {
          return <div css={style} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toContain("className={_cx(style)}");
    expect(code).not.toContain("_$mincho$$App");
    expect(result[1]).not.toContain("_css(");
    expect(result[1]).not.toContain('color: "red"');
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
        import { cx } from "@mincho-js/css";

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
            <div css={cx(getClassName())} />
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
    expect(code).toContain("className={_cx(cx(getClassName()))}");
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
      {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          button: { color: "red" }
        })
      }
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
        function App() {
          return <div css={["base", { color: "red" }]} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(result[1]).toContain('_css(["base", {');
    expect(result[1]).toContain('color: "red"');
    expect(code).toContain("className={_$mincho$$App2}");
    expect(code).not.toContain("_cx([base");
  });

  it("classifies first-level primitive jsx css prop array branches", () => {
    const { result, code } = babelTransform(
      `
        const activeClass = "active-class";
        const styles = { active: "styles-active" };
        const condition = true;
        const providedClass = "";
        const maybeClass = null;
        const suffix = "suffix";

        function getClassName() {
          return "called";
        }

        function App() {
          return <>
            <div css={["base", "active"]} />
            <div css={["base", ""]} />
            <div css={["base", false]} />
            <div css={["base", true]} />
            <div css={["base", null]} />
            <div css={["base", undefined]} />
            <div css={["base", 0]} />
            <div css={["base", 1]} />
            <div css={["base", 0n]} />
            <div css={["base", 1n]} />
            <div css={["base", activeClass]} />
            <div css={["base", "", activeClass]} />
            <div css={["base", styles.active]} />
            <div css={["base", getClassName()]} />
            <div css={["base", \`active \${suffix}\`]} />
            <div css={["base", condition && "active"]} />
            <div css={["base", providedClass || "fallback"]} />
            <div css={["base", maybeClass ?? "fallback"]} />
            <div css={["base", condition ? "active" : "inactive"]} />
            <div className="external" css={["base", condition && "active"]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).not.toContain('_cx(["base"');
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(2);
    expect(result[1]).toContain('_css(["base", "active"])');
    expect(result[1]).toContain('_css(["base", ""])');
    expect(result[1]).not.toContain("activeClass");
    expect(result[1]).not.toContain("getClassName");
    expect(result[1]).not.toContain("suffix");
    expect(code).toContain('className={_cx("base", false)}');
    expect(code).toContain('className={_cx("base", true)}');
    expect(code).toContain('className={_cx("base", null)}');
    expect(code).toContain('className={_cx("base", undefined)}');
    expect(code).toContain('className={_cx("base", 0)}');
    expect(code).toContain('className={_cx("base", 1)}');
    expect(code).toContain('className={_cx("base", 0n)}');
    expect(code).toContain('className={_cx("base", 1n)}');
    expect(code).toContain('className={_cx("base", activeClass)}');
    expect(code).toContain('className={_cx("base", "", activeClass)}');
    expect(code).toContain('className={_cx("base", styles.active)}');
    expect(code).toContain('className={_cx("base", getClassName())}');
    expect(code).toContain('className={_cx("base", `active ${suffix}`)}');
    expect(code).toContain('className={_cx("base", condition && "active")}');
    expect(code).toContain(
      'className={_cx("base", providedClass || "fallback")}'
    );
    expect(code).toContain('className={_cx("base", maybeClass ?? "fallback")}');
    expect(code).toContain(
      'className={_cx("base", condition ? "active" : "inactive")}'
    );
    expect(code).toContain(
      'className={_cx("external", "base", condition && "active")}'
    );
  });

  it("extracts first-level CSS-rule branch array branches through cx", () => {
    const { result, code } = babelTransform(
      `
        const activeClass = "active-class";
        const condition = true;
        const providedClass = "";
        const maybeClass = null;

        function App() {
          return <>
            <div css={["base", condition && { color: "red" }]} />
            <div css={["base", providedClass || { color: "red" }]} />
            <div css={["base", maybeClass ?? { color: "red" }]} />
            <div css={["base", providedClass || [{ color: "red" }]]} />
            <div css={["base", maybeClass ?? ["active", { color: "red" }]]} />
            <div css={["base", condition && [{ color: "red" }]]} />
            <div css={["base", condition && ["active", { color: "red" }]]} />
            <div css={["base", { color: "red" }, activeClass]} />
            <div css={["base", [{ color: "red" }], condition && "active"]} />
            <div css={["base", condition ? { color: "red" } : "inactive"]} />
            <div css={["base", condition ? [{ color: "red" }] : "inactive"]} />
            <div css={["base", condition ? "active" : { color: "blue" }]} />
            <div css={["base", condition ? "active" : ["fallback", { color: "blue" }]]} />
            <div css={["base", condition ? { color: "red" } : { color: "blue" }]} />
            <div css={["base", condition ? ["red", { color: "red" }] : ["blue", { color: "blue" }]]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const expectedClassNames = [
      /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/,
      /className=\{_cx\("base", providedClass \|\| _\$mincho\$\$App\d+\)\}/,
      /className=\{_cx\("base", maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
      /className=\{_cx\("base", _\$mincho\$\$App\d+, activeClass\)\}/,
      /className=\{_cx\("base", _\$mincho\$\$App\d+, condition && "active"\)\}/,
      /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : "inactive"\)\}/,
      /className=\{_cx\("base", condition \? "active" : _\$mincho\$\$App\d+\)\}/,
      /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
    ] as const;

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
    expect(code).not.toContain(" css=");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain('color: "red"');
    expect(code).not.toContain('color: "blue"');
    expect(code).not.toContain("[{");
    expect(code).not.toContain('["active", {');
    expect(code).not.toContain('["fallback", {');
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(17);
    expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(8);
    expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(9);
    expect(result[1]).toContain('_css(["active", {');
    expect(result[1]).toContain('_css(["fallback", {');
    expect(result[1]).toContain('_css(["red", {');
    expect(result[1]).toContain('_css(["blue", {');

    for (const expectedClassName of expectedClassNames) {
      expect(code).toMatch(expectedClassName);
    }
  });

  it("supports first-level dynamic branches with static array CSS-rule units", () => {
    const { result, code } = babelTransform(
      `
        const condition = true;

        function App() {
          return <>
            <div css={["base", condition && [{ color: "red" }]]} />
            <div css={["base", condition && ["active", { color: "red" }]]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(
      code.match(
        /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/g
      ) ?? []
    ).toHaveLength(2);
    expect(code).not.toContain("[{");
    expect(code).not.toContain('["active", {');
    expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(2);
    expect(result[1]).toContain("_css([{");
    expect(result[1]).toContain('_css(["active", {');
  });

  it("lowers nested dynamic css prop array literals", () => {
    const { result, code } = babelTransform(
      `
        const condition = true;
        const nested = true;
        const props = {
          className: "spread-base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <>
            <div css={["base", ["nested", condition && { color: "red" }]]} />
            <div css={["base", condition && ["active", nested && { color: "red" }]]} />
            <div css={["base", condition ? ["active", { color: "red" }] : ["fallback", { color: "blue" }]]} />
            <div css={["base", ["nested", condition ? { color: "red" } : "inactive"]]} />
            <div className="base" css={["outer", ["nested", condition && { color: "red" }]]} />
          </>;
        }

        function SpreadApp() {
          return <div {...props} css={["outer", ["nested", condition && { color: "red" }]]} />;
        }
      `,
      { jsxCssProp: true }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).toMatch(
      /className=\{_cx\("base", _cx\("nested", condition && _\$mincho\$\$App\d+\)\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", condition && _cx\("active", nested && _\$mincho\$\$App\d+\)\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", _cx\("nested", condition \? _\$mincho\$\$App\d+ : "inactive"\)\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", "outer", _cx\("nested", condition && _\$mincho\$\$App\d+\)\)\}/
    );
    expect(code).toContain("css: _minchoCssProp");
    expect(code).toContain("className: _minchoClassName");
    expect(code).toContain("..._minchoRest");
    expect(code).toMatch(
      /className=\{_cx\(_minchoClassName, "outer", _cx\("nested", condition && _\$mincho\$\$(?:App|SpreadApp)\d+\)\)\}/
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(7);
    expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(5);
    expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(2);
    expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(6);
    expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(1);
    expect(result[1]).toContain('_css(["active", {');
    expect(result[1]).toContain('_css(["fallback", {');
    expect(output).not.toContain("_css(condition &&");
    expect(output).not.toContain("_css(nested &&");
    expect(output).not.toContain("_css(condition ?");
    expect(output).not.toContain('["nested", condition && {');
    expect(output).not.toContain('["active", nested && {');
  });

  it("preserves direct CSS-rule array branch units", () => {
    const { result, code } = babelTransform(
      `
        const condition = true;

        function App() {
          return <>
            <div css={["base", condition && ["active", { color: "red" }]]} />
            <div css={["base", condition ? ["active", { color: "red" }] : ["fallback", { color: "blue" }]]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(
      /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).not.toContain('["active", {');
    expect(code).not.toContain('["fallback", {');
    expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(3);
    expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(0);
    expect(result[1]).toContain('_css(["active", {');
    expect(result[1]).toContain('_css(["fallback", {');
  });

  it("evaluates first-level array call branches once", () => {
    const observed = runJsxCssPropRuntime(
      `
        let callCount = 0;

        function getClassName() {
          callCount += 1;
          return "dynamic";
        }

        function App() {
          return <div css={["base", getClassName()]} />;
        }
      `,
      "return { props: App(), callCount };"
    ) as { props: Record<string, unknown>; callCount: number };

    expect(observed.callCount).toBe(1);
    expect(observed.props.className).toBe("base dynamic");
    expect("css" in observed.props).toBe(false);
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
        fixture: `<div css={(["base", { color: "red" }])} />`,
        expectedRule: '_css(["base", {'
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

  it("lowers recursive conditional jsx css prop branches", () => {
    const { result, code } = babelTransform(
      `
        type ComplexCSSRule = unknown;
        const outer = true;
        const inner = false;
        const styleA = "style-a";

        function App() {
          return <>
            <div css={outer ? inner ? { color: "red" } : { color: "blue" } : styleA} />
            <div css={outer ? styleA : inner ? { color: "red" } : { color: "blue" }} />
            <div css={outer ? inner ? [{ color: "red" }] : [{ color: "blue" }] : null} />
            <div css={outer ? inner ? ({ color: "red" } as const) : ([{ color: "blue" }]! satisfies ComplexCSSRule) : styleA} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code.match(/className=\{_cx\(/g) ?? []).toHaveLength(4);
    expect(
      code.match(
        /className=\{_cx\(outer \? inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+ : styleA\)\}/g
      ) ?? []
    ).toHaveLength(2);
    expect(code).toMatch(
      /className=\{_cx\(outer \? styleA : inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(outer \? inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+ : null\)\}/
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(8);
    expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(5);
    expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(3);
    expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(4);
    expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(4);
    expect(output).not.toContain("_css(outer ?");
    expect(output).not.toContain("_css(inner ?");
    expect(output).not.toContain("_css(condition ?");
    expect(output).not.toContain("_css(styleA)");
    expect(output).not.toContain("css(styleA)");
  });

  it("does not static-evaluate branch-internal conditional identifiers", () => {
    const { result, code, metadata } = babelTransform(
      `
        import { styles } from "./styles";

        const outer = true;
        const palette = { card: "card-class" };

        function makeRule(color: string) {
          return { color };
        }

        const ruleFactory = {
          card(color: string) {
            return { color };
          }
        };

        function App() {
          return <>
            <div css={outer ? styles.red : { color: "blue" }} />
            <div css={({ color: "red" }) ? { color: "green" } : styles.red} />
            <div css={outer ? palette.card : { color: "purple" }} />
            <div css={outer ? makeRule("red") : { color: "orange" }} />
            <div css={outer ? ruleFactory.card("green") : styles.red} />
          </>;
        }
      `,
      {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          "styles.red": { color: "red" }
        })
      }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).toMatch(
      /className=\{_cx\(outer \? styles\.red : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(\{\s+color: "red"\s+\} \? _\$mincho\$\$App\d+ : styles\.red\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(outer \? palette\.card : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{outer \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(outer \? _\$mincho\$\$App\d+ : styles\.red\)\}/
    );
    expect(output).not.toContain("_css(styles.red)");
    expect(output).not.toContain("css(styles.red)");
    expect(metadata.minchoStaticCssEval?.dependencies ?? []).toEqual([]);
    expect(metadata.minchoStaticCssEval?.resolvedModuleIds ?? []).toEqual([]);
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
    expect(result[1]).toContain('_css(makeRule("red"))');
    expect(result[1]).toContain('_css(ruleFactory.card("green"))');
    expect(result[1]).not.toContain('color: "red"');
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).toContain('color: "green"');
    expect(result[1]).toContain('color: "purple"');
    expect(result[1]).toContain('color: "orange"');
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
          const props = { className: "base" };

          function App(condition: boolean) {
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

          function App(providedClass: string, maybeClass: string | null) {
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

  it("lowers recursive logical jsx css prop branches", () => {
    const fixtures = [
      {
        fixture: `<div css={condition && flag && { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\(condition && flag && _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={(condition && flag) || { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\(\(?condition && flag\)? \|\| _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={a || b || { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\(a \|\| b \|\| _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={a ?? b ?? { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\(a \?\? b \?\? _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={condition && (flag ? { color: "red" } : { color: "blue" })} />`,
        expectedClassName:
          /className=\{_cx\(condition && \(flag \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\)\}/,
        expectedColors: ["red", "blue"]
      },
      {
        fixture: `<div css={condition && (flag && { color: "red" })} />`,
        expectedClassName:
          /className=\{_cx\(condition && \(?flag && _\$mincho\$\$App\d+\)?\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={outer ? condition && { color: "red" } : styleA} />`,
        expectedClassName:
          /className=\{_cx\(outer \? condition && _\$mincho\$\$App\d+ : styleA\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div css={{ color: "red" } && (condition && { color: "blue" })} />`,
        expectedClassName:
          /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["blue"],
        forbiddenColors: ["red"]
      },
      {
        fixture: `<div className="base" css={condition && flag && { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\("base", condition && flag && _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div className="base" css={(condition && flag) || { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\("base", \(?condition && flag\)? \|\| _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div className="base" css={a || b || { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\("base", a \|\| b \|\| _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div className="base" css={a ?? b ?? { color: "red" }} />`,
        expectedClassName:
          /className=\{_cx\("base", a \?\? b \?\? _\$mincho\$\$App\d+\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div className="base" css={condition && (flag ? { color: "red" } : { color: "blue" })} />`,
        expectedClassName:
          /className=\{_cx\("base", condition && \(flag \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\)\}/,
        expectedColors: ["red", "blue"]
      },
      {
        fixture: `<div className="base" css={condition && (flag && { color: "red" })} />`,
        expectedClassName:
          /className=\{_cx\("base", condition && \(?flag && _\$mincho\$\$App\d+\)?\)\}/,
        expectedColors: ["red"]
      },
      {
        fixture: `<div className="base" css={outer ? condition && { color: "red" } : styleA} />`,
        expectedClassName:
          /className=\{_cx\("base", outer \? condition && _\$mincho\$\$App\d+ : styleA\)\}/,
        expectedColors: ["red"]
      }
    ] as const;

    for (const fixtureCase of fixtures) {
      const { fixture, expectedClassName, expectedColors } = fixtureCase;
      const forbiddenColors =
        "forbiddenColors" in fixtureCase ? fixtureCase.forbiddenColors : [];

      const { result, code } = babelTransform(
        `
          const styleA = "style-a";

          function App(
            condition: boolean,
            flag: boolean,
            outer: boolean,
            a: string | null,
            b: string | null
          ) {
            return ${fixture};
          }
        `,
        { jsxCssProp: true }
      );

      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(expectedClassName);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(
        expectedColors.length
      );

      for (const color of expectedColors) {
        expect(result[1]).toContain(`color: "${color}"`);
      }

      for (const color of forbiddenColors ?? []) {
        expect(result[1]).not.toContain(`color: "${color}"`);
      }

      expect(code).not.toMatch(/_cx\(condition && flag, _\$mincho/);
      expect(code).not.toMatch(/_cx\(a \|\| b, _\$mincho/);
      expect(code).not.toMatch(/_cx\(a \?\? b, _\$mincho/);
      expect(output).not.toContain("_css(condition &&");
      expect(output).not.toContain("_css(condition ||");
      expect(output).not.toContain("_css(condition ??");
      expect(output).not.toContain("_css(a ||");
      expect(output).not.toContain("_css(a ??");
      expect(output).not.toContain("_css(condition ?");
    }
  });

  it("preserves recursive logical css prop call counts", () => {
    const observed = runJsxCssPropRuntime(
      `
        let conditionCalls = 0;
        let flagCalls = 0;
        let aCalls = 0;
        let bCalls = 0;

        function getCondition() {
          conditionCalls += 1;
          return true;
        }

        function getFlag() {
          flagCalls += 1;
          return true;
        }

        function getA() {
          aCalls += 1;
          return "";
        }

        function getB() {
          bCalls += 1;
          return "";
        }

        function App() {
          const andProps = <div css={getCondition() && getFlag() && { color: "red" }} />;
          const orProps = <div css={(getA() || getB()) || { color: "blue" }} />;
          return { andProps, orProps };
        }
      `,
      "return { result: App(), conditionCalls, flagCalls, aCalls, bCalls };"
    );

    expect(observed).toEqual({
      result: {
        andProps: { className: "css-rule" },
        orProps: { className: "css-rule" }
      },
      conditionCalls: 1,
      flagCalls: 1,
      aCalls: 1,
      bCalls: 1
    });
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

        import { cx } from "@mincho-js/css";

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
          const andProps = <div css={{ color: "blue" } && cx(getProvided())} />;
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

  it("lowers top-level call factory and mixin jsx css prop rules through extraction", () => {
    const { result, code } = babelTransform(
      `
        function makeRule(color: string) {
          return { color };
        }

        function getClassName() {
          return { color: "green" };
        }

        const rules = {
          card(variant: string) {
            return { color: variant };
          }
        };

        function App() {
          return <>
            <div css={makeRule("red")} />
            <div css={getClassName()} />
            <div css={rules.card("primary")} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).not.toContain('from "@mincho-js/css"');
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("_cx(makeRule");
    expect(code).not.toContain("_cx(getClassName");
    expect(code).not.toContain("_cx(rules.card");
    expect(code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []).toHaveLength(
      3
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
    expect(result[1]).toContain("function makeRule");
    expect(result[1]).toContain("function getClassName");
    expect(result[1]).toContain("const rules");
    expect(result[1]).toContain('_css(makeRule("red"))');
    expect(result[1]).toContain("_css(getClassName())");
    expect(result[1]).toContain('_css(rules.card("primary"))');
  });

  it("emits parseable sidecar output without duplicate local factory declarations", () => {
    const { result } = babelTransform(
      `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={makeRule("green")} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(() =>
      transformSync(result[1], {
        presets: [typescriptPresetPath],
        filename: "generated.css.ts"
      })
    ).not.toThrow();
    expect(result[1].match(/function makeRule/g) ?? []).toHaveLength(1);
  });

  it("emits parseable sidecar output with sibling factories using one root dedupe", () => {
    const { result } = babelTransform(
      `
        const makeColor = (color: string) => ({ color }),
          makeBackground = (background: string) => ({ background });

        function App() {
          return <>
            <div css={makeColor("green")} />
            <div css={makeBackground("black")} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(() =>
      transformSync(result[1], {
        presets: [typescriptPresetPath],
        filename: "generated.css.ts"
      })
    ).not.toThrow();
    expect(result[1].match(/const makeColor/g) ?? []).toHaveLength(1);
    expect(result[1]).toContain('_css(makeColor("green"))');
    expect(result[1]).toContain('_css(makeBackground("black"))');
  });

  it("routes hoistable build-time css prop shapes through sidecar mode", () => {
    const { result, code } = babelTransform(
      `
        const base = { padding: 4 };

        function getBase() {
          return base;
        }

        function getKey() {
          return "color";
        }

        function getStack() {
          return [{ display: "grid" }];
        }

        function makeColor() {
          return "teal";
        }

        function makeRule(color: string) {
          return { color };
        }

        function App(condition: boolean) {
          return <>
            <div css={{ ...getBase(), color: "red" }} />
            <div css={[...getStack(), { gap: 8 }]} />
            <div css={{ [getKey()]: "blue" }} />
            <div css={{ color: makeColor() }} />
            <div css={makeRule("green")} />
            <div css={condition ? makeRule("purple") : { color: "orange" }} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("style=");
    expect(code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []).toHaveLength(
      5
    );
    expect(code).toMatch(
      /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(7);
    expect(result[1]).toMatch(
      /_css\(\{\s+\.\.\.getBase\(\),\s+color: "red"\s+\}\)/
    );
    expect(result[1]).toMatch(
      /_css\(\[\s*\.\.\.getStack\(\),\s+\{\s+gap: 8\s+\}\s*\]\)/
    );
    expect(result[1]).toMatch(/_css\(\{\s+\[getKey\(\)\]: "blue"\s+\}\)/);
    expect(result[1]).toMatch(/_css\(\{\s+color: makeColor\(\)\s+\}\)/);
    expect(result[1]).toContain('_css(makeRule("green"))');
    expect(result[1]).toContain('_css(makeRule("purple"))');
    expect(output).not.toContain("padding: 4, color");
  });

  it("keeps nested rule returns with branch locals and stable globals on the sidecar path", () => {
    const { result, code } = babelTransform(
      `
        function makeRule(condition: boolean) {
          if (condition) {
            const color = String(Math.max(1, 2));
            return { color };
          }
          return "fallback";
        }

        function App() {
          return <div css={makeRule(true)} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(result[1]).toContain("_css(makeRule(true))");
  });

  it("rejects unresolved browser globals from sidecar evaluation", () => {
    const failure = captureJsxCssPropFailure(
      `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={makeRule(window.location.href)} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(failure.error.message).toContain(
      "call expressions are not evaluated by Babel"
    );
    expect(failure.code).not.toContain("_css(makeRule(");
  });

  it("locks hoistable static array spread on the extracted css path", () => {
    const { result, code } = babelTransform(
      `
        const base = [{ display: "grid" }];
        const extra = { gap: 8 };

        function App() {
          return <div css={[...base, extra]} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(
      /import\s+\{\s*_\$mincho\$\$App\d*(?:\s+as\s+_\$mincho\$\$App\d+)?\s*\}\s+from "(?:\.\/)?extracted_[^"]+\.css\.ts";/
    );
    expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(1);
    expect(result[1]).toContain("const base");
    expect(result[1]).toContain("const extra");
    expect(result[1]).toMatch(
      /export var _\$mincho\$\$App\d* = _css\(\[\s*\.\.\.base,\s+extra\s*\]\);/
    );
  });

  it("routes sidecar-safe partial-reduced factories, computed keys, and object spreads", () => {
    const { result, code } = babelTransform(
      `
          const baseRule = getBase();
          const computedRule = { [getKey()]: "blue" };
          const moduleRule = makeRule("green");
          const spreadRule = { ...getBase(), color: "red" };

          function getBase() {
            return { padding: 4 };
          }

          function getKey() {
            return "color";
          }

          function makeRule(color: string) {
            return { color };
          }

          function App(condition: boolean) {
            const branchRule = condition ? makeRule("purple") : { color: "orange" };

            return <>
              <div css={baseRule} />
              <div css={computedRule} />
              <div css={moduleRule} />
              <div css={spreadRule} />
              <div css={branchRule} />
            </>;
          }
        `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("style=");
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
    expect(result[1]).toContain("_css(getBase())");
    expect(result[1]).toMatch(/_css\(\{\s+\[getKey\(\)\]: "blue"\s+\}\)/);
    expect(result[1]).toContain('_css(makeRule("green"))');
    expect(result[1]).toMatch(
      /_css\(\{\s+\.\.\.getBase\(\),\s+color: "red"\s+\}\)/
    );
    expect(result[1]).toContain('_css(makeRule("purple"))');
    expect(result[1]).toContain('color: "orange"');
  });

  it("rejects sidecar candidate css props with render-scope declaration leaves", () => {
    const failure = captureJsxCssPropFailure(
      `
        const base = { padding: 4 };

        function getBase() {
          return base;
        }

        function App(props: { color: string }) {
          return <div css={{ ...getBase(), color: props.color }} />;
        }
      `,
      { jsxCssProp: true }
    );

    expect(failure.error.message).toMatch(staticShapeDiagnosticPattern);
    expect(failure.error.message).toMatch(reactStyleGuidancePattern);
    expect(failure.code).not.toContain("_css(");
    expect(failure.code).not.toContain("style={{");
  });

  it("lowers computed optional and template jsx css prop static rules", () => {
    const { result, code } = babelTransform(
      `
        const buttonKey = "button";
        const colorKey = "color";
        const brand = "red";
        const styles = {
          button: { color: "blue" }
        } as const;

        function App() {
          return <>
            <div css={styles["button"]} />
            <div css={styles[buttonKey]} />
            <div css={styles?.button} />
            <div css={styles?.[buttonKey]} />
            <div css={{ ["color"]: "red" }} />
            <div css={{ [colorKey]: \`\${brand}\` }} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []).toHaveLength(
      6
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
    expect(result[1]).toContain('color: "red"');
    expect(result[1]).not.toContain("[colorKey]");
    expect(result[1]).not.toContain("`${brand}`");
  });

  describe("css prop partial evaluator red baseline", () => {
    type PartialEvalTransformOutcome =
      | {
          readonly kind: "ok";
          readonly transform: ReturnType<typeof babelTransform>;
        }
      | { readonly kind: "error"; readonly message: string };

    function tryPartialEvalTransform(
      source: string
    ): PartialEvalTransformOutcome {
      try {
        return {
          kind: "ok",
          transform: babelTransform(source, { jsxCssProp: true })
        };
      } catch (error) {
        return {
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }

    function expectPartialEvalTransformOk(
      label: string,
      source: string
    ): ReturnType<typeof babelTransform> {
      const outcome = tryPartialEvalTransform(source);

      if (outcome.kind === "error") {
        expect(outcome.message, label).not.toContain("BABEL_EXECUTED_");
      }

      expect(
        outcome.kind,
        outcome.kind === "error"
          ? `${label}: ${outcome.message.split("\n")[0]}`
          : label
      ).toBe("ok");

      if (outcome.kind === "error") {
        throw new Error(`${label}: expected transform success`);
      }

      return outcome.transform;
    }

    it("routes static computed key runtime leaf through css prop partial evaluator dynamic-leaf mode", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "static computed key dynamic leaf",
        `
          const keys = { foreground: "color" } as const;
          const colorKey = keys.foreground;

          function App(props: { color: string }) {
            return <div css={{ [colorKey]: props.color }} />;
          }
        `
      );

      expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
    });

    it("normalizes same-file const object spreads, static computed keys, and shorthand on the extraction path", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "same-file const object spread static normalization",
        `
          const color = "gold";
          const display = "grid";
          const colorKey = "color";
          const numericKey = 1;
          const base = { color: "red", margin: 1 } as const;
          const override = { color: "blue", [numericKey]: "one" } as const;

          function App() {
            return <div css={{ ...base, [colorKey]: "green", ...override, color, display }} />;
          }
        `
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(code).not.toContain("...override");
      expect(code).not.toContain("[colorKey]");
      expect(result[1]).toContain("margin: 1");
      expect(result[1]).toContain('"1": "one"');
      expect(result[1]).toContain('color: "gold"');
      expect(result[1]).toContain('display: "grid"');
      expect(result[1]).not.toMatch(/color: "(?:red|blue|green)"/);
    });

    it("normalizes object spread override order and shorthand before dynamic-leaf lowering", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "same-file object spread last-wins dynamic leaf",
        `
          const colorKey = "color";
          const opacity = 1;
          const base = { color: "red", display: "grid" } as const;
          const override = { color: "blue", gap: 4 } as const;

          function App(props: { color: string; margin: number }) {
            return <div css={{ color: "green", ...base, ...override, [colorKey]: props.color, opacity, margin: props.margin }} />;
          }
        `
      );

      expect(result[1]).toContain('display: "grid"');
      expect(result[1]).toContain("gap: 4");
      expect(result[1]).toContain("opacity: 1");
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(result[1]).toMatch(/margin: _\$mincho\$\$App\w*MarginVar/);
      expect(result[1]).not.toMatch(/color: "(?:red|blue|green)"/);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(code).not.toContain("...override");
      expect(code).not.toContain("[colorKey]");
      expect(code).not.toContain("_css(");
      expect(code).toContain("_vx(props.color)");
      expect(code).toContain("_vx(props.margin)");
    });

    it("routes static object spreads through css prop partial evaluator dynamic-leaf mode", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "static object spread dynamic leaf",
        `
          const base = { display: "grid" } as const;

          function App(props: { color: string }) {
            return <div css={{ ...base, color: props.color }} />;
          }
        `
      );

      expect(result[1]).toContain('display: "grid"');
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(code).not.toContain("style={{ color: props.color }}");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
    });

    it("routes static spread before static key through dynamic-leaf mode", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "static object spread before computed key dynamic leaf",
        `
          const base = { display: "grid" } as const;
          const keys = { foreground: "color" } as const;

          function App(props: { color: string }) {
            return <div css={{ ...base, [keys.foreground]: props.color }} />;
          }
        `
      );

      expect(result[1]).toContain('display: "grid"');
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(code).not.toContain("[keys.foreground]");
      expect(code).not.toContain("style={{ color: props.color }}");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
    });

    it("routes same-file member paths, sidecar-safe whole-rule calls, and class-value fallback in the css prop partial evaluator matrix", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "same-file member sidecar class-value matrix",
        `
          const activeClass = "active";
          const styles = {
            button: { color: "red" }
          } as const;

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <>
              <div css={styles.button} />
              <div css={makeRule("blue")} />
              <div css={activeClass} />
            </>;
          }
        `
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(activeClass)}");
      expect(code).not.toContain("_cx(styles.button)");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('_css(makeRule("blue"))');
      expect(result[1]).not.toContain("activeClass");
    });

    it("preserves jsx css prop className dynamic CSS variable sidecar and spread aggregation router outputs", () => {
      const { result, code } = expectPartialEvalTransformOk(
        "router supported mode matrix",
        `
          const props = { className: "spread-base", css: "leaked", id: "root" };
          const activeClass = "active";
          const styles = { button: { color: "red" } } as const;

          function makeRule(color: string) {
            return { color };
          }

          function App(propsInput: { color: string }) {
            return <>
              <div css={styles.button} />
              <div css={makeRule("blue")} />
              <div css={{ color: propsInput.color }} />
              <div css={activeClass} />
              <div {...props} css={{ display: "grid" }} />
            </>;
          }
        `
      );

      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toContain("className={_cx(activeClass)}");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(propsInput\.color\)\s+\}\}/
      );
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('_css(makeRule("blue"))');
      expect(result[1]).toContain('display: "grid"');
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(output).not.toContain("_css(activeClass)");
      expect(output).not.toContain("propsInput.color }}");
    });

    it("keeps mutated bindings, runtime keys, runtime spreads, and props member calls unsupported in the css prop partial evaluator matrix", () => {
      const fixtures = [
        {
          label: "mutated binding",
          source: `
            const style = { color: "red" };
            style.color = "blue";

            function App() {
              return <div css={style} />;
            }
          `,
          expected:
            'Cannot statically evaluate css prop value: same-file binding "style" is mutated'
        },
        {
          label: "runtime key",
          source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `,
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported"
        },
        {
          label: "runtime computed key dynamic value",
          source: `
            function App(props: { key: string; value: string }) {
              return <div css={{ [props.key]: props.value }} />;
            }
          `,
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported"
        },
        {
          label: "runtime spread",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `,
          expected:
            "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`."
        },
        {
          label: "props member call",
          source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `,
          expected:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
        }
      ] as const;

      for (const { label, source, expected } of fixtures) {
        const failure = captureJsxCssPropFailure(source, {
          jsxCssProp: true
        });

        expect(failure.error.message.split("\n")[0], label).toBe(expected);
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("keeps partial-reduced props member call aliases unsupported sidecar", () => {
      const fixtures = [
        {
          label: "aliased props member call",
          expected:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
          source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              const rule = props.makeRule();

              return <div css={rule} />;
            }
          `
        },
        {
          label: "aliased props computed key",
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported",
          source: `
            function App(props: { key: string }) {
              const rule = { [props.key]: "red" };

              return <div css={rule} />;
            }
          `
        },
        {
          label: "aliased props object spread",
          expected: "Mincho `css` requires statically known CSS shape",
          source: `
            function App(props: { styles: Record<string, string> }) {
              const rule = { ...props.styles, color: "red" };

              return <div css={rule} />;
            }
          `
        }
      ] as const;

      for (const { label, source, expected } of fixtures) {
        const failure = captureJsxCssPropFailure(source, {
          jsxCssProp: true
        });

        expect(failure.error.message.split("\n")[0], label).toBe(expected);
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("keeps sidecar no execution for throwing factory and getter css prop fixtures", () => {
      const outcome = tryPartialEvalTransform(`
          const colorKey = "color";

          function throwingRule() {
            throw new Error("BABEL_EXECUTED_FUNCTION");
          }

          const throwingGetter = {
            get color() {
              throw new Error("BABEL_EXECUTED_GETTER");
            }
          };

          class ThrowingClass {
            constructor() {
              throw new Error("BABEL_EXECUTED_CLASS");
            }
          }

          function App(props: { color: string }) {
            return <>
              <div css={{ [colorKey]: props.color, background: throwingGetter.color }} />
              <div css={throwingRule()} />
              <div css={ThrowingClass} />
            </>;
          }
        `);

      if (outcome.kind === "error") {
        expect(outcome.message).not.toContain("BABEL_EXECUTED_");
        expect(outcome.message).toMatch(
          /Cannot statically evaluate|Mincho JSX css prop/
        );
      }

      expect(
        outcome.kind,
        outcome.kind === "error"
          ? `no-execution failure stayed in Mincho diagnostics: ${outcome.message.split("\n")[0]}`
          : "transform succeeded"
      ).toBe("ok");

      if (outcome.kind === "error") {
        return;
      }

      const { result, code } = outcome.transform;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toContain("props.color");
      expect(code).toContain("throwingGetter.color");
      expect(code).toContain("className={_cx(ThrowingClass)}");
      expect(result[1]).toContain("_css(throwingRule())");
    });
  });

  it("lowers first-level call branch jsx css prop rules through extraction", () => {
    const { result, code } = babelTransform(
      `
        function makeRule(color: string) {
          return { color };
        }

        function App(
          condition: boolean,
          providedClass: string,
          maybeClass: string | null
        ) {
          return <>
            <div css={condition ? makeRule("red") : { color: "blue" }} />
            <div css={condition && makeRule("red")} />
            <div css={providedClass || makeRule("red")} />
            <div css={maybeClass ?? makeRule("red")} />
            <div css={["base", condition && makeRule("red")]} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    const output = `${code}\n${result.join("\n")}`;

    expect(code).not.toContain(" css=");
    expect(code).not.toContain("css as _css");
    expect(code).not.toContain("_css(");
    expect(code).not.toContain("condition ? makeRule");
    expect(code).not.toContain("condition && makeRule");
    expect(code).not.toContain("providedClass || makeRule");
    expect(code).not.toContain("maybeClass ?? makeRule");
    expect(code).toMatch(
      /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
    expect(result[1]).toContain('_css(makeRule("red"))');
    expect(result[1]).toContain('color: "blue"');
    expect(output).not.toContain("_css(condition");
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
          function App(condition: boolean) {
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

  it("lowers explicit cx array and dictionary class values through class-value mode", () => {
    const { result, code } = babelTransform(
      `
        import { cx } from "@mincho-js/css";

        const isActive = true;

        function App() {
          return <>
            <div css={cx(["base", isActive && "active"])} />
            <div css={cx({ active: isActive })} />
            <div css={cx(["base", { active: isActive }])} />
          </>;
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
    expect(code).toMatch(
      /className=\{_cx\(cx\(\{\s+active: isActive\s+\}\)\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(cx\(\["base", \{\s+active: isActive\s+\}\]\)\)\}/
    );
    expect(result[1]).not.toContain("_css(");
  });

  it("keeps explicit cx call operands in class-value mode", () => {
    const { result, code } = babelTransform(
      `
        import { cx } from "@mincho-js/css";

        const condition = true;

        function makeRule(color: string) {
          return { color };
        }

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={cx({ color: "red" })} />
            <div css={cx(makeRule("red"))} />
            <div css={cx(getClassName())} />
            <div css={condition ? cx({ color: "red" }) : { color: "blue" }} />
            <div css={condition && cx([{ color: "red" }])} />
          </>;
        }
      `,
      { jsxCssProp: true }
    );

    expect(code).not.toContain(" css=");
    expect(code).toMatch(/className=\{_cx\(cx\(\{\s+color: "red"\s+\}\)\)\}/);
    expect(code).toContain('className={_cx(cx(makeRule("red")))}');
    expect(code).toContain("className={_cx(cx(getClassName()))}");
    expect(code).toMatch(
      /className=\{_cx\(condition \? cx\(\{\s+color: "red"\s+\}\) : _\$mincho\$\$App\d+\)\}/
    );
    expect(code).toMatch(
      /className=\{_cx\(condition && cx\(\[\{\s+color: "red"\s+\}\]\)\)\}/
    );
    expect(result[1].match(/_css\(/g) ?? []).toHaveLength(1);
    expect(result[1]).toContain('color: "blue"');
    expect(result[1]).not.toContain('color: "red"');
    expect(result[1]).not.toContain("makeRule");
    expect(result[1]).not.toContain("getClassName");
  });
});

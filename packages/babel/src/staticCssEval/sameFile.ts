export type {
  ResolveSameFileStaticCssEvalOptions,
  SameFileStaticCssEvalResult
} from "./sameFile/types.js";
export { resolveSameFileStaticCssEvalExpression } from "./sameFile/entry.js";
export { getStaticCssEvalConstBindingInitExpression } from "./sameFile/shapes.js";
export { hasStaticCssEvalBindingMutation } from "./sameFile/mutation.js";

import { transformSync, types as t } from "@babel/core";
import type { PluginObj } from "@babel/core";
import { getStaticObjectPropertyName } from "./ast.js";
import { resolveSameFileStaticCssEvalExpression } from "./sameFile/entry.js";
import type { SameFileStaticCssEvalResult } from "./sameFile/types.js";
import type { StaticCssEvalDiagnostic } from "./types.js";

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const ownerFile = "/project/src/App.tsx";

  function resolveSameFileFixture(
    source: string
  ): SameFileStaticCssEvalResult[] {
    const results: SameFileStaticCssEvalResult[] = [];
    const result = transformSync(source, {
      filename: ownerFile,
      ast: true,
      code: false,
      sourceType: "module",
      configFile: false,
      babelrc: false,
      parserOpts: {
        plugins: ["jsx", "typescript"]
      },
      plugins: [
        function sameFileStaticCssEvalFixturePlugin(): PluginObj {
          return {
            visitor: {
              Program(programPath) {
                programPath.traverse({
                  JSXAttribute(attributePath) {
                    const expression = getCssFixtureExpression(
                      attributePath.node
                    );

                    if (!expression) {
                      return;
                    }

                    results.push(
                      resolveSameFileStaticCssEvalExpression({
                        expression,
                        ownerFile,
                        programPath,
                        scope: attributePath.scope
                      })
                    );
                  }
                });
              }
            }
          };
        }
      ]
    });

    if (result === null) {
      throw new Error("Failed to parse same-file static css eval fixture");
    }

    return results;
  }

  function getCssFixtureExpression(
    attribute: t.JSXAttribute
  ): t.Expression | null {
    if (!t.isJSXIdentifier(attribute.name) || attribute.name.name !== "css") {
      return null;
    }

    if (!t.isJSXExpressionContainer(attribute.value)) {
      return null;
    }

    const { expression } = attribute.value;

    return t.isJSXEmptyExpression(expression) ? null : expression;
  }

  function expectSingleResolved(
    source: string
  ): Extract<SameFileStaticCssEvalResult, { kind: "resolved" }> {
    const [result] = resolveSameFileFixture(source);
    expect(result?.kind).toBe("resolved");

    if (!result || result.kind !== "resolved") {
      throw new Error("Expected same-file fixture to resolve");
    }

    return result;
  }

  function expectSingleNotCandidate(
    source: string
  ): Extract<SameFileStaticCssEvalResult, { kind: "not-candidate" }> {
    const [result] = resolveSameFileFixture(source);
    expect(result?.kind).toBe("not-candidate");

    if (!result || result.kind !== "not-candidate") {
      throw new Error("Expected same-file fixture to remain a class value");
    }

    return result;
  }

  function expectSingleDiagnosticId(
    source: string,
    diagnosticId: NonNullable<StaticCssEvalDiagnostic["id"]>
  ): void {
    const [result] = resolveSameFileFixture(source);
    const diagnostic =
      result?.kind === "error" ||
      (result?.kind === "not-candidate" && result.status === "unsupported")
        ? result.diagnostic
        : undefined;
    const diagnostics =
      result?.kind === "error" ||
      (result?.kind === "not-candidate" && result.status === "unsupported")
        ? result.diagnostics
        : undefined;

    if (!diagnostic || !diagnostics) {
      throw new Error("Expected same-file fixture to return a diagnostic");
    }

    expect(diagnostic.id).toBe(diagnosticId);
    expect(diagnostics.map((item) => item.id)).toEqual([diagnosticId]);
  }

  function getStringObjectProperty(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): string | null {
    const value = getObjectPropertyExpression(expression, propertyName);

    return value && t.isStringLiteral(value) ? value.value : null;
  }

  function getNumericObjectProperty(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): number | null {
    const value = getObjectPropertyExpression(expression, propertyName);

    return value && t.isNumericLiteral(value) ? value.value : null;
  }

  function getObjectPropertyExpression(
    expression: t.ObjectExpression | t.ArrayExpression,
    propertyName: string
  ): t.Expression | null {
    if (!t.isObjectExpression(expression)) {
      return null;
    }

    for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
      const property = expression.properties[index];

      if (!t.isObjectProperty(property) || property.computed) {
        continue;
      }

      if (getStaticObjectPropertyName(property.key) !== propertyName) {
        continue;
      }

      return t.isExpression(property.value) ? property.value : null;
    }

    return null;
  }

  function expectNoSpreadElement(
    expression: t.ObjectExpression | t.ArrayExpression
  ): void {
    if (t.isObjectExpression(expression)) {
      expect(
        expression.properties.some((property) => t.isSpreadElement(property))
      ).toBe(false);
      return;
    }

    expect(
      expression.elements.some((element) =>
        Boolean(element && t.isSpreadElement(element))
      )
    ).toBe(false);
  }

  describe("same-file static css eval resolver", () => {
    it("keeps top-level primitive identifiers as class values", () => {
      const result = expectSingleNotCandidate(`
        const className = "btn-primary";
        function App() {
          return <button css={className} />;
        }
      `);

      expect(result.status).toBeUndefined();
    });

    it("resolves local const objects with local provenance and dependencies", () => {
      const resolved = expectSingleResolved(`
        const button = { color: "red" };
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved).toMatchObject({
        status: "resolved",
        provenance: {
          kind: "local",
          file: ownerFile,
          bindingName: "button",
          declarationKind: "const"
        },
        dependencies: [
          {
            file: ownerFile,
            kind: "local",
            importer: ownerFile,
            specifier: "<local>",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          {
            importer: ownerFile,
            source: ownerFile,
            exportName: "button",
            memberPath: []
          }
        ],
        diagnostics: []
      });
    });

    it("resolves local object spreads with last-key-wins semantics", () => {
      const resolved = expectSingleResolved(`
        const base = { color: "red", padding: 4 };
        const button = { ...base, color: "blue" };
        function App() {
          return <button css={button} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(
        t.isObjectExpression(resolved.expression)
          ? resolved.expression.properties.filter(
              (property) =>
                t.isObjectProperty(property) &&
                !property.computed &&
                getStaticObjectPropertyName(property.key) === "color"
            )
          : []
      ).toHaveLength(1);
      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "blue"
      );
      expect(getNumericObjectProperty(resolved.expression, "padding")).toBe(4);
    });

    it("resolves direct object spreads through the same-file resolver API", () => {
      const resolved = expectSingleResolved(`
        const base = { color: "red", padding: 4 };
        function App() {
          return <button css={{ ...base, color: "blue" }} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "blue"
      );
      expect(getNumericObjectProperty(resolved.expression, "padding")).toBe(4);
    });

    it("resolves local array spreads in order", () => {
      const resolved = expectSingleResolved(`
        const stack = [{ display: "grid" }];
        const rule = [...stack, { gap: 8 }];
        function App() {
          return <button css={rule} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(t.isArrayExpression(resolved.expression)).toBe(true);

      if (!t.isArrayExpression(resolved.expression)) {
        throw new Error(
          "Expected same-file array spread to resolve to an array"
        );
      }

      expect(resolved.expression.elements).toHaveLength(2);
      const [firstRule, secondRule] = resolved.expression.elements;
      expect(
        firstRule && t.isObjectExpression(firstRule)
          ? getStringObjectProperty(firstRule, "display")
          : null
      ).toBe("grid");
      expect(
        secondRule && t.isObjectExpression(secondRule)
          ? getNumericObjectProperty(secondRule, "gap")
          : null
      ).toBe(8);
    });

    it("resolves direct array spreads through the same-file resolver API", () => {
      const resolved = expectSingleResolved(`
        const stack = [{ display: "grid" }];
        function App() {
          return <button css={[...stack, { gap: 8 }]} />;
        }
      `);

      expectNoSpreadElement(resolved.expression);
      expect(t.isArrayExpression(resolved.expression)).toBe(true);

      if (!t.isArrayExpression(resolved.expression)) {
        throw new Error(
          "Expected direct same-file array spread to resolve to an array"
        );
      }

      expect(resolved.expression.elements).toHaveLength(2);
      const [firstRule, secondRule] = resolved.expression.elements;
      expect(
        firstRule && t.isObjectExpression(firstRule)
          ? getStringObjectProperty(firstRule, "display")
          : null
      ).toBe("grid");
      expect(
        secondRule && t.isObjectExpression(secondRule)
          ? getNumericObjectProperty(secondRule, "gap")
          : null
      ).toBe(8);
    });

    it("resolves local identifier and member values inside object literals", () => {
      const resolved = expectSingleResolved(`
        const color = "red";
        const tokens = { primary: "blue" };
        const button = { color, backgroundColor: tokens.primary };
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(
        getStringObjectProperty(resolved.expression, "backgroundColor")
      ).toBe("blue");
    });

    it("resolves safe local aliases through transparent TypeScript wrappers", () => {
      const resolved = expectSingleResolved(`
        const base = ({ color: "red" } as const)!;
        const button = (base satisfies unknown)!;
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved.resolutionChain.map((entry) => entry.exportName)).toEqual(
        ["button", "base"]
      );
      expect(
        resolved.dependencies.map((dependency) => dependency.exportName)
      ).toEqual(["button", "base"]);
    });

    it("resolves local shadowing before imported bindings with the same name", () => {
      const resolved = expectSingleResolved(`
        import { button } from "./styles";
        function App() {
          const button = { color: "local" } as const;
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe(
        "local"
      );
      expect(resolved.provenance).toMatchObject({
        kind: "local",
        file: ownerFile,
        bindingName: "button"
      });
    });

    it("records literal member paths in local resolution metadata", () => {
      const resolved = expectSingleResolved(`
        const styles = {
          buttons: {
            primary: { color: "red" }
          }
        } as const;
        function App() {
          return <button css={styles.buttons.primary} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(resolved.dependencies[0]?.memberPath).toEqual([
        "buttons",
        "primary"
      ]);
      expect(resolved.resolutionChain[0]?.memberPath).toEqual([
        "buttons",
        "primary"
      ]);
    });

    it("resolves computed and optional same-file static css eval resolver members", () => {
      const resolved = expectSingleResolved(`
        const buttonKey = "button";
        const styles = {
          button: { color: "red" },
          1: { color: "blue" }
        } as const;
        function App() {
          return <button css={styles?.[buttonKey]} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(
        resolved.dependencies.map((dependency) => dependency.exportName)
      ).toContain("buttonKey");

      const numericResolved = expectSingleResolved(`
        const styles = {
          1: { color: "blue" }
        } as const;
        function App() {
          return <button css={styles[1]} />;
        }
      `);

      expect(getStringObjectProperty(numericResolved.expression, "color")).toBe(
        "blue"
      );
    });

    it("rejects non-canonical same-file array member names", () => {
      expectSingleDiagnosticId(
        `
          const button = { color: ["red", "blue"]["01"] } as const;
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("normalizes computed object keys and template expressions", () => {
      const resolved = expectSingleResolved(`
        const colorKey = "color";
        const brand = "red";
        const enabled = true;
        const button = {
          color: "blue",
          [colorKey]: \`\${brand}\`,
          content: \`value-\${enabled}-\${null}\`
        } as const;
        function App() {
          return <button css={button} />;
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
      expect(getStringObjectProperty(resolved.expression, "content")).toBe(
        "value-true-null"
      );
      expect(
        resolved.dependencies.map((dependency) => dependency.exportName)
      ).toContain("colorKey");
    });

    it("returns exact diagnostics for unsafe same-file bindings", () => {
      expectSingleDiagnosticId(
        `
          let button = { color: "red" };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          let styles = { button: { color: "red" } };
          function App() {
            return <button css={styles.button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          var styles = { button: { color: "red" } };
          function App() {
            return <button css={styles.button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: "red" };
          button.color = "blue";
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTATED_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const styles = { button: { color: "red" } };
          function App(variant) {
            return <button css={styles[variant]} />;
          }
        `,
        "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const styles = null;
          function App() {
            return <button css={styles?.button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: getColor() };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("rejects unsafe spread operands deterministically", () => {
      expectSingleDiagnosticId(
        `
          const base = [{ color: "red" }];
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const base = { color: "red" };
          const rule = [...base];
          function App() {
            return <button css={rule} />;
          }
        `,
        "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          let base = { color: "red" };
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTABLE_BINDING"
      );
      expectSingleDiagnosticId(
        `
          const base = { color: "red" };
          base.color = "blue";
          const button = { ...base };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_MUTATED_BINDING"
      );
    });

    it("rejects computed and optional member values deterministically", () => {
      expectSingleDiagnosticId(
        `
          const tokens = { primary: "red" };
          function getTokenName() {
            return "primary";
          }
          const button = { color: tokens[getTokenName()] };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const tokens = null;
          const button = { color: tokens?.primary };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("rejects unsupported template expression values deterministically", () => {
      expectSingleDiagnosticId(
        `
          const tokens = { primary: "red" };
          const button = { color: \`\${tokens}\` };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          function getColor() {
            return "red";
          }
          const button = { color: \`\${getColor()}\` };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("rejects function values and calls deterministically", () => {
      expectSingleDiagnosticId(
        `
          const button = { color: getColor() };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
      expectSingleDiagnosticId(
        `
          const button = { color: () => "red" };
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
      );
    });

    it("guards local alias cycles deterministically", () => {
      expectSingleDiagnosticId(
        `
          const button = base;
          const base = button;
          function App() {
            return <button css={button} />;
          }
        `,
        "STATIC_CSS_EVAL_LOCAL_ALIAS_CYCLE"
      );
    });

    it("distinguishes shadowed aliases with the same name", () => {
      const resolved = expectSingleResolved(`
        const leaf = { color: "red" };
        const value = leaf;
        function App() {
          {
            const leaf = value;
            return <button css={leaf} />;
          }
        }
      `);

      expect(getStringObjectProperty(resolved.expression, "color")).toBe("red");
    });
  });
}

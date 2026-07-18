import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type {
  StaticCssEvalQuery,
  StaticCssEvalUnsupportedReason
} from "./types.js";

const cssAttributeName = "css";

export type StaticCssEvalCandidate = StaticCssEvalQuery;

export interface CollectJsxCssPropStaticCssEvalCandidatesOptions {
  importerId: string;
}

export type StaticMemberReference =
  | SupportedStaticMemberReference
  | UnsupportedStaticMemberReference;

interface SupportedStaticMemberReference {
  kind: "supported";
  bindingName: string;
  memberPath: string[];
}

interface UnsupportedStaticMemberReference {
  kind: "unsupported";
  bindingName: string;
  memberPath: string[];
  reason: StaticCssEvalUnsupportedReason;
  detail: string;
  unsupportedPropertyName?: string;
}

type TransparentCssRuleWrapperExpression = t.Expression & {
  expression: t.Expression;
};

export function collectJsxCssPropStaticCssEvalCandidates(
  path: NodePath<t.Program>,
  options: CollectJsxCssPropStaticCssEvalCandidatesOptions
): StaticCssEvalCandidate[] {
  const candidates: StaticCssEvalCandidate[] = [];

  path.traverse({
    JSXAttribute(attributePath) {
      if (!isCssPropAttribute(attributePath.node)) {
        return;
      }

      const expression = getJsxExpressionContainerValue(attributePath.node);

      if (!expression) {
        return;
      }

      const candidate = createStaticCssEvalCandidate(
        expression,
        options.importerId
      );

      if (candidate) {
        candidates.push(candidate);
      }
    }
  });

  return candidates;
}

export function createStaticCssEvalCandidate(
  expression: t.Expression,
  importerId: string
): StaticCssEvalCandidate | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);
  const range = getExpressionRange(unwrappedExpression);
  const reference = getStaticCssEvalMemberReference(unwrappedExpression);

  if (!range || !reference || reference.kind !== "supported") {
    return null;
  }

  return {
    importerId,
    expressionStart: range.start,
    expressionEnd: range.end,
    bindingName: reference.bindingName,
    ...(reference.memberPath.length > 0
      ? { memberPath: reference.memberPath }
      : {})
  };
}

export function unwrapTransparentCssRuleExpression(
  expression: t.Expression
): t.Expression {
  let currentExpression = expression;

  while (isTransparentCssRuleWrapperExpression(currentExpression)) {
    currentExpression = currentExpression.expression;
  }

  return currentExpression;
}

export function isTransparentCssRuleWrapperExpression(
  expression: t.Expression
): expression is TransparentCssRuleWrapperExpression {
  return (
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TypeCastExpression" ||
    expression.type === "TSTypeAssertion"
  );
}

function isCssPropAttribute(attribute: t.JSXAttribute): boolean {
  return (
    t.isJSXIdentifier(attribute.name) &&
    attribute.name.name === cssAttributeName
  );
}

function getJsxExpressionContainerValue(
  attribute: t.JSXAttribute
): t.Expression | null {
  if (!t.isJSXExpressionContainer(attribute.value)) {
    return null;
  }

  const { expression } = attribute.value;

  if (t.isJSXEmptyExpression(expression)) {
    return null;
  }

  return expression;
}

function getExpressionRange(
  expression: t.Expression
): { start: number; end: number } | null {
  const { start, end } = expression;

  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }

  return { start, end };
}

export function getStaticCssEvalMemberReference(
  expression: t.Expression
): StaticMemberReference | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(expression);

  if (t.isIdentifier(unwrappedExpression)) {
    return {
      kind: "supported",
      bindingName: unwrappedExpression.name,
      memberPath: []
    };
  }

  if (t.isMemberExpression(unwrappedExpression)) {
    return getMemberExpressionReference(unwrappedExpression);
  }

  if (t.isOptionalMemberExpression(unwrappedExpression)) {
    return getOptionalMemberExpressionReference(unwrappedExpression);
  }

  return null;
}

function getMemberExpressionReference(
  expression: t.MemberExpression
): StaticMemberReference | null {
  if (t.isSuper(expression.object)) {
    return null;
  }

  const objectReference = getStaticCssEvalMemberReference(expression.object);

  if (!objectReference) {
    return null;
  }

  if (objectReference.kind === "unsupported") {
    return objectReference;
  }

  const propertyName = getStaticMemberPropertyName(expression);

  if (!propertyName) {
    return createUnsupportedMemberPathReference(objectReference, expression);
  }

  return {
    kind: "supported",
    bindingName: objectReference.bindingName,
    memberPath: [...objectReference.memberPath, propertyName]
  };
}

function getOptionalMemberExpressionReference(
  expression: t.OptionalMemberExpression
): StaticMemberReference | null {
  if (t.isSuper(expression.object)) {
    return null;
  }

  const objectReference = getStaticCssEvalMemberReference(expression.object);

  if (!objectReference) {
    return null;
  }

  if (objectReference.kind === "unsupported") {
    return objectReference;
  }

  return {
    kind: "unsupported",
    bindingName: objectReference.bindingName,
    memberPath: objectReference.memberPath,
    reason: "optional-member-path",
    detail: "optional member paths are unsupported"
  };
}

function createUnsupportedMemberPathReference(
  objectReference: SupportedStaticMemberReference,
  expression: t.MemberExpression
): UnsupportedStaticMemberReference {
  if (expression.computed && t.isNumericLiteral(expression.property)) {
    return {
      kind: "unsupported",
      bindingName: objectReference.bindingName,
      memberPath: objectReference.memberPath,
      reason: "numeric-member-path",
      detail: "numeric member paths are unsupported",
      unsupportedPropertyName: String(expression.property.value)
    };
  }

  return {
    kind: "unsupported",
    bindingName: objectReference.bindingName,
    memberPath: objectReference.memberPath,
    reason: "dynamic-member-path",
    detail: "dynamic computed member paths are unsupported"
  };
}

function getStaticMemberPropertyName(
  expression: t.MemberExpression
): string | null {
  const { computed, property } = expression;

  if (!computed && t.isIdentifier(property)) {
    return property.name;
  }

  if (computed && t.isStringLiteral(property)) {
    return property.value;
  }

  return null;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const importerId = "/project/src/App.tsx";

  function collectCandidateFixture(source: string): StaticCssEvalCandidate[] {
    const candidates: StaticCssEvalCandidate[] = [];
    const result = transformSync(source, {
      filename: importerId,
      plugins: [
        function collectCandidatesPlugin(): PluginObj {
          return {
            visitor: {
              Program(path) {
                candidates.push(
                  ...collectJsxCssPropStaticCssEvalCandidates(path, {
                    importerId
                  })
                );
              }
            }
          };
        }
      ],
      presets: ["@babel/preset-typescript"]
    });

    if (result === null) {
      throw new Error("Failed to parse candidate fixture");
    }

    return candidates;
  }

  function formatCandidate(
    source: string,
    candidate: StaticCssEvalCandidate
  ): StaticCssEvalCandidate & { expression: string } {
    return {
      ...candidate,
      expression: source.slice(
        candidate.expressionStart,
        candidate.expressionEnd
      )
    };
  }

  describe("static css eval candidate collector", () => {
    it("collects identifier and member JSX css prop candidates", () => {
      const source = `
        const style = { color: "red" };
        const styles = {
          button: { color: "blue" }
        };

        function App() {
          return <>
            <div css={style} />
            <Component css={styles.button} />
            <Component css={styles["button"]} />
          </>;
        }
      `;

      expect(
        collectCandidateFixture(source).map((candidate) =>
          formatCandidate(source, candidate)
        )
      ).toEqual([
        {
          importerId,
          expressionStart: source.indexOf("style} />"),
          expressionEnd: source.indexOf("style} />") + "style".length,
          bindingName: "style",
          expression: "style"
        },
        {
          importerId,
          expressionStart: source.indexOf("styles.button"),
          expressionEnd:
            source.indexOf("styles.button") + "styles.button".length,
          bindingName: "styles",
          memberPath: ["button"],
          expression: "styles.button"
        },
        {
          importerId,
          expressionStart: source.indexOf('styles["button"]'),
          expressionEnd:
            source.indexOf('styles["button"]') + 'styles["button"]'.length,
          bindingName: "styles",
          memberPath: ["button"],
          expression: 'styles["button"]'
        }
      ]);
    });

    it("collects candidates through transparent TypeScript css prop wrappers", () => {
      const source = `
        type ComplexCSSRule = unknown;
        const style = { color: "red" };
        const styles = {
          button: { color: "blue" }
        };

        function App() {
          return <>
            <div css={style as const} />
            <Component css={styles.button satisfies ComplexCSSRule} />
          </>;
        }
      `;

      expect(
        collectCandidateFixture(source).map((candidate) =>
          formatCandidate(source, candidate)
        )
      ).toEqual([
        {
          importerId,
          expressionStart: source.indexOf("style as const"),
          expressionEnd: source.indexOf("style as const") + "style".length,
          bindingName: "style",
          expression: "style"
        },
        {
          importerId,
          expressionStart: source.indexOf("styles.button satisfies"),
          expressionEnd:
            source.indexOf("styles.button satisfies") + "styles.button".length,
          bindingName: "styles",
          memberPath: ["button"],
          expression: "styles.button"
        }
      ]);
    });

    it("ignores non-css JSX expressions and unrelated imports", () => {
      const source = `
        import { style as cssStyle } from "@mincho-js/css";

        const style = { color: "red" };
        const styles = {
          button: { color: "blue" }
        };
        const unused = cssStyle;

        function App() {
          return <div style={style} data-css={styles.button}>{style}</div>;
        }
      `;

      expect(collectCandidateFixture(source)).toEqual([]);
    });
  });
}

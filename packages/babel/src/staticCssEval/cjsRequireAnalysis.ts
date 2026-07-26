import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import { isStaticCssEvalRequireCallExpression } from "./cjsBindings.js";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export function containsStaticCssEvalRequireCallExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): boolean {
  const unwrappedExpression = unwrapTransparentExpression(expression);

  if (isStaticCssEvalRequireCallExpression(unwrappedExpression, scope)) {
    return true;
  }

  if (
    t.isFunctionExpression(unwrappedExpression) ||
    t.isArrowFunctionExpression(unwrappedExpression) ||
    t.isClassExpression(unwrappedExpression)
  ) {
    return false;
  }

  if (t.isTemplateLiteral(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((item) =>
      containsExpressionNode(item, scope)
    );
  }

  if (t.isTaggedTemplateExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.tag, scope) ||
      containsExpressionNode(unwrappedExpression.quasi, scope)
    );
  }

  if (
    t.isCallExpression(unwrappedExpression) ||
    t.isOptionalCallExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.callee, scope) ||
      unwrappedExpression.arguments.some((argument) =>
        containsExpressionNode(argument, scope)
      )
    );
  }

  if (t.isNewExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.callee, scope) ||
      unwrappedExpression.arguments.some((argument) =>
        containsExpressionNode(argument, scope)
      )
    );
  }

  if (t.isAwaitExpression(unwrappedExpression)) {
    return containsExpressionNode(unwrappedExpression.argument, scope);
  }

  if (t.isAssignmentExpression(unwrappedExpression)) {
    return (
      containsExpressionNode(unwrappedExpression.left, scope) ||
      containsExpressionNode(unwrappedExpression.right, scope)
    );
  }

  if (t.isTSInstantiationExpression(unwrappedExpression)) {
    return containsExpressionNode(unwrappedExpression.expression, scope);
  }

  if (
    t.isMemberExpression(unwrappedExpression) ||
    t.isOptionalMemberExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.object, scope) ||
      (unwrappedExpression.computed &&
        containsExpressionNode(unwrappedExpression.property, scope))
    );
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return (
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.test,
        scope
      ) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.consequent,
        scope
      ) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.alternate,
        scope
      )
    );
  }

  if (
    t.isLogicalExpression(unwrappedExpression) ||
    t.isBinaryExpression(unwrappedExpression)
  ) {
    return (
      containsExpressionNode(unwrappedExpression.left, scope) ||
      containsStaticCssEvalRequireCallExpression(
        unwrappedExpression.right,
        scope
      )
    );
  }

  if (t.isSequenceExpression(unwrappedExpression)) {
    return unwrappedExpression.expressions.some((item) =>
      containsStaticCssEvalRequireCallExpression(item, scope)
    );
  }

  if (t.isArrayExpression(unwrappedExpression)) {
    return unwrappedExpression.elements.some((element) =>
      containsExpressionNode(element, scope)
    );
  }

  if (t.isObjectExpression(unwrappedExpression)) {
    return unwrappedExpression.properties.some((property) =>
      containsObjectPropertyRequireCall(property, scope)
    );
  }

  if (t.isUnaryExpression(unwrappedExpression)) {
    return containsStaticCssEvalRequireCallExpression(
      unwrappedExpression.argument,
      scope
    );
  }

  return false;
}

function containsObjectPropertyRequireCall(
  property: t.ObjectExpression["properties"][number],
  scope: StaticCssEvalBabelScope
): boolean {
  if (t.isSpreadElement(property)) {
    return containsExpressionNode(property.argument, scope);
  }

  if (!t.isObjectProperty(property)) {
    return false;
  }

  return (
    (property.computed && containsExpressionNode(property.key, scope)) ||
    containsExpressionNode(property.value, scope)
  );
}

function containsExpressionNode(
  node: t.Node | null | undefined,
  scope: StaticCssEvalBabelScope
): boolean {
  if (t.isSpreadElement(node)) {
    return containsExpressionNode(node.argument, scope);
  }

  return t.isExpression(node)
    ? containsStaticCssEvalRequireCallExpression(node, scope)
    : false;
}

function unwrapTransparentExpression(expression: t.Expression): t.Expression {
  let currentExpression = expression;

  while (
    t.isParenthesizedExpression(currentExpression) ||
    t.isTSAsExpression(currentExpression) ||
    t.isTSSatisfiesExpression(currentExpression) ||
    t.isTSNonNullExpression(currentExpression) ||
    t.isTSTypeAssertion(currentExpression) ||
    t.isTypeCastExpression(currentExpression)
  ) {
    currentExpression = currentExpression.expression;
  }

  return currentExpression;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  function analyzeInitializer(source: string, bindingName: string): boolean {
    let result: boolean | null = null;

    transformSync(source, {
      ast: false,
      babelrc: false,
      code: false,
      configFile: false,
      filename: "/project/src/App.tsx",
      parserOpts: { sourceType: "module" },
      plugins: [
        createProgramVisitorPlugin((programPath) => {
          const binding = programPath.scope.getBinding(bindingName);
          const initPath = binding?.path.isVariableDeclarator()
            ? binding.path.get("init")
            : null;

          result = initPath?.isExpression()
            ? containsStaticCssEvalRequireCallExpression(
                initPath.node,
                programPath.scope
              )
            : false;
        })
      ]
    });

    if (result === null) {
      throw new Error("Expected Babel transform to visit Program");
    }

    return result;
  }

  function createProgramVisitorPlugin(
    visit: (programPath: NodePath<t.Program>) => void
  ): PluginObj {
    return {
      visitor: {
        Program(programPath) {
          visit(programPath);
        }
      }
    };
  }

  describe("CommonJS require reachability analysis", () => {
    it("finds require calls that use same-file const path operands", () => {
      expect(
        analyzeInitializer(
          `const path = "./styles"; const styles = require(path);`,
          "styles"
        )
      ).toBe(true);
    });

    it("fails closed when require is shadowed", () => {
      expect(
        analyzeInitializer(
          `const require = makeRequire(); const path = "./styles"; const styles = require(path);`,
          "styles"
        )
      ).toBe(false);
    });
  });
}

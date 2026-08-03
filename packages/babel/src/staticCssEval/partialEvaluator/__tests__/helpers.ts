import { transformSync, types as t } from "@babel/core";
import type { PluginObj } from "@babel/core";
import type { PartialEvalLimits } from "../context.js";
import { createPartialEvalContext } from "../context.js";
import type { PartialEvalDeoptResult, PartialEvalResult } from "../result.js";
import { reducePartialEvalExpression } from "../reducer.js";
import type { StaticCssEvalSourceLocation } from "../../types.js";

export const owner: StaticCssEvalSourceLocation = {
  file: "/project/src/App.tsx",
  start: 42,
  end: 55
};

type PartialEvalTestExpect = NonNullable<ImportMeta["vitest"]>["expect"];

let partialEvalTestExpect: PartialEvalTestExpect | undefined;

export function setPartialEvalTestExpect(expect: PartialEvalTestExpect): void {
  partialEvalTestExpect = expect;
}

export function reduceForTest(expression: t.Expression): PartialEvalResult {
  return reducePartialEvalExpression({
    expression,
    context: createPartialEvalContext({ owner })
  });
}

export function expectConfidentExpression(
  result: PartialEvalResult
): t.Expression {
  const expect = getExpect();
  expect(result.kind).toBe("confident");

  if (result.kind !== "confident") {
    throw new Error(`expected confident result, got ${result.kind}`);
  }

  return result.expression;
}

export function expectDeoptResult(
  result: PartialEvalResult
): PartialEvalDeoptResult {
  const expect = getExpect();
  expect(result.kind).toBe("deopt");

  if (result.kind !== "deopt") {
    throw new Error(`expected deopt result, got ${result.kind}`);
  }

  return result;
}

export function expectStringLiteralExpression(
  expression: t.Expression,
  value: string
): void {
  const expect = getExpect();
  expect(t.isStringLiteral(expression)).toBe(true);

  if (!t.isStringLiteral(expression)) {
    throw new Error(`expected string literal, got ${expression.type}`);
  }

  expect(expression.value).toBe(value);
}

export function expectNumericLiteralExpression(
  expression: t.Expression,
  value: number
): void {
  const expect = getExpect();
  expect(t.isNumericLiteral(expression)).toBe(true);

  if (!t.isNumericLiteral(expression)) {
    throw new Error(`expected numeric literal, got ${expression.type}`);
  }

  expect(expression.value).toBe(value);
}

export function expectBooleanLiteralExpression(
  expression: t.Expression,
  value: boolean
): void {
  const expect = getExpect();
  expect(t.isBooleanLiteral(expression)).toBe(true);

  if (!t.isBooleanLiteral(expression)) {
    throw new Error(`expected boolean literal, got ${expression.type}`);
  }

  expect(expression.value).toBe(value);
}

export function expectNullLiteralExpression(expression: t.Expression): void {
  const expect = getExpect();
  expect(t.isNullLiteral(expression)).toBe(true);

  if (!t.isNullLiteral(expression)) {
    throw new Error(`expected null literal, got ${expression.type}`);
  }
}

export function createTemplateElement(
  value: string,
  tail: boolean
): t.TemplateElement {
  return t.templateElement({ raw: value, cooked: value }, tail);
}

export function reduceFixture(
  source: string,
  limits?: Partial<PartialEvalLimits>
): PartialEvalResult[] {
  const results: PartialEvalResult[] = [];
  const transformResult = transformSync(source, {
    filename: owner.file,
    ast: true,
    code: false,
    sourceType: "module",
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [partialEvaluatorFixturePlugin(results, limits)]
  });

  if (transformResult === null) {
    throw new Error("failed to parse partial evaluator fixture");
  }

  return results;
}

export function expectFixtureConfidentExpression(
  results: readonly PartialEvalResult[],
  index: number
): t.Expression {
  const result = results[index];

  if (!result) {
    throw new Error(`expected fixture result at index ${index}`);
  }

  return expectConfidentExpression(result);
}

export function expectFixtureDeoptResult(
  results: readonly PartialEvalResult[],
  index: number
): PartialEvalDeoptResult {
  const result = results[index];

  if (!result) {
    throw new Error(`expected fixture result at index ${index}`);
  }

  return expectDeoptResult(result);
}

export function expectObjectExpression(
  expression: t.Expression
): t.ObjectExpression {
  const expect = getExpect();
  expect(t.isObjectExpression(expression)).toBe(true);

  if (!t.isObjectExpression(expression)) {
    throw new Error(`expected object expression, got ${expression.type}`);
  }

  return expression;
}

export function expectArrayExpression(
  expression: t.Expression
): t.ArrayExpression {
  const expect = getExpect();
  expect(t.isArrayExpression(expression)).toBe(true);

  if (!t.isArrayExpression(expression)) {
    throw new Error(`expected array expression, got ${expression.type}`);
  }

  return expression;
}

export function expectArrayElementExpression(
  expression: t.ArrayExpression,
  index: number
): t.Expression {
  const element = expression.elements[index];

  if (!element || t.isSpreadElement(element)) {
    throw new Error(`expected array expression element at index ${index}`);
  }

  return element;
}

export function expectObjectPropertyExpression(
  expression: t.ObjectExpression,
  propertyName: string
): t.Expression {
  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index];

    if (!t.isObjectProperty(property) || property.computed) {
      continue;
    }
    if (getStaticObjectPropertyName(property.key) !== propertyName) {
      continue;
    }
    if (t.isExpression(property.value)) {
      return property.value;
    }
  }

  throw new Error(`expected object property ${propertyName}`);
}

export function expectNoSpreadElement(
  expression: t.ObjectExpression | t.ArrayExpression
): void {
  const expect = getExpect();

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

function partialEvaluatorFixturePlugin(
  results: PartialEvalResult[],
  limits?: Partial<PartialEvalLimits>
): PluginObj {
  return {
    visitor: {
      Program(programPath) {
        programPath.traverse({
          CallExpression(callPath) {
            if (!t.isIdentifier(callPath.node.callee, { name: "capture" })) {
              return;
            }

            const [argument] = callPath.node.arguments;

            if (!argument || !t.isExpression(argument)) {
              return;
            }

            results.push(
              reducePartialEvalExpression({
                expression: argument,
                context: createPartialEvalContext({ owner, limits }),
                programPath,
                scope: callPath.scope
              })
            );
          }
        });
      }
    }
  };
}

export function getStaticObjectPropertyName(
  key: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(key)) {
    return key.name;
  }
  if (t.isStringLiteral(key)) {
    return key.value;
  }
  if (t.isNumericLiteral(key)) {
    return String(key.value);
  }
  return null;
}

function getExpect() {
  if (!partialEvalTestExpect) {
    throw new Error("partial evaluator test helper used outside Vitest");
  }

  return partialEvalTestExpect;
}

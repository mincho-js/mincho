import { types as t } from "@babel/core";
import { getStaticCssEvalMemberReference } from "./candidates.js";

export type StaticCssEvalCjsDescriptorExpressionResult =
  | { readonly kind: "supported"; readonly expression: t.Expression }
  | { readonly kind: "unsupported"; readonly mutation: string };

export function getDefinePropertyDescriptorExpression(
  expression: t.CallExpression
): StaticCssEvalCjsDescriptorExpressionResult {
  const descriptor = expression.arguments[2];

  if (!descriptor || !t.isObjectExpression(descriptor)) {
    return {
      kind: "unsupported",
      mutation: "Object.defineProperty descriptor is dynamic"
    };
  }

  let valueExpression: t.Expression | null = null;
  let getterExpression: t.Expression | null = null;

  for (const property of descriptor.properties) {
    if (t.isSpreadElement(property)) {
      return {
        kind: "unsupported",
        mutation: "Object.defineProperty descriptor spread"
      };
    }

    if (!t.isObjectProperty(property) || property.computed) {
      return {
        kind: "unsupported",
        mutation: "Object.defineProperty descriptor has unsupported key"
      };
    }

    const keyName = getObjectKeyName(property.key);

    if (keyName === "set") {
      return {
        kind: "unsupported",
        mutation: "Object.defineProperty setter descriptor"
      };
    }

    if (keyName === "value" && t.isExpression(property.value)) {
      valueExpression = property.value;
      continue;
    }

    if (keyName === "get") {
      if (
        !t.isFunctionExpression(property.value) ||
        property.value.async ||
        property.value.generator
      ) {
        return {
          kind: "unsupported",
          mutation: "Object.defineProperty getter is dynamic"
        };
      }

      getterExpression = getStaticGetterReturnExpression(property.value);

      if (!getterExpression) {
        return {
          kind: "unsupported",
          mutation:
            "Object.defineProperty getter must return one identifier or member expression"
        };
      }
    }
  }

  if (valueExpression && getterExpression) {
    return {
      kind: "unsupported",
      mutation: "Object.defineProperty descriptor mixes value and getter"
    };
  }

  if (valueExpression) {
    return { kind: "supported", expression: valueExpression };
  }

  return getterExpression
    ? { kind: "supported", expression: getterExpression }
    : {
        kind: "unsupported",
        mutation: "Object.defineProperty descriptor has no static value"
      };
}

export function getObjectKeyName(key: t.ObjectProperty["key"]): string | null {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  return t.isStringLiteral(key) ? key.value : null;
}

function getStaticGetterReturnExpression(
  expression: t.FunctionExpression
): t.Expression | null {
  const [statement] = expression.body.body;

  if (
    expression.params.length !== 0 ||
    expression.body.body.length !== 1 ||
    !statement ||
    !t.isReturnStatement(statement) ||
    !statement.argument ||
    !t.isExpression(statement.argument)
  ) {
    return null;
  }

  const reference = getStaticCssEvalMemberReference(statement.argument);

  return reference?.kind === "supported" ? statement.argument : null;
}

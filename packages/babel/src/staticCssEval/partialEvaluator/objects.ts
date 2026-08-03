import { types as t } from "@babel/core";
import type { PartialEvalResult } from "./result.js";
import type {
  PartialEvalReducerNodeOptions,
  PendingPartialEvalDeopt
} from "./reduction.js";
import { getStaticStringOrNumberMemberName } from "./literals.js";

export function reduceObjectExpression(
  options: PartialEvalReducerNodeOptions<t.ObjectExpression>
): PartialEvalResult {
  const properties: t.ObjectExpression["properties"] = [];
  const propertyKeyIndexes = new Map<string, number>();
  let pendingDeopt: PendingPartialEvalDeopt | null = null;

  for (const property of options.node.properties) {
    if (t.isSpreadElement(property)) {
      const spreadResult = options.runtime.reduceExpression({
        expression: property.argument,
        depth: options.depth + 1,
        reductionContext: options.reductionContext
      });

      if (spreadResult.kind === "deopt") {
        pendingDeopt ??= options.runtime.createPendingDeoptFromChild({
          result: spreadResult,
          reason: options.runtime.getContextualDeoptReason(
            spreadResult,
            "unsupported-spread"
          )
        });
        properties.push(
          t.spreadElement(t.cloneNode(spreadResult.fallbackExpression))
        );
        continue;
      }

      const spreadExpression = spreadResult.expression;

      if (!t.isObjectExpression(spreadExpression)) {
        pendingDeopt ??= {
          reason: "unsupported-spread",
          details: { deoptPath: [{ kind: "spread" }] }
        };
        properties.push(t.cloneNode(property));
        continue;
      }

      if (
        pushObjectSpreadProperties({
          properties,
          property,
          spreadExpression,
          propertyKeyIndexes
        })
      ) {
        pendingDeopt ??= {
          reason: "unsupported-spread",
          details: { deoptPath: [{ kind: "spread" }] }
        };
      }
      continue;
    }

    if (!t.isObjectProperty(property) || !t.isExpression(property.value)) {
      pendingDeopt ??= { reason: "runtime-css-shape", details: {} };
      properties.push(t.cloneNode(property));
      continue;
    }

    const keyResult = reduceObjectPropertyKey({ property, ...options });

    if (keyResult.kind === "deopt") {
      pendingDeopt ??= options.runtime.createPendingDeoptFromChild({
        result: keyResult.result
      });
      properties.push(t.cloneNode(property));
      continue;
    }

    const valueResult = options.runtime.reduceExpression({
      expression: property.value,
      depth: options.depth + 1,
      reductionContext: options.reductionContext
    });
    const nextProperty = t.cloneNode(property);
    nextProperty.key = createStaticObjectPropertyKey(keyResult.name);
    nextProperty.computed = false;
    nextProperty.shorthand = false;

    if (valueResult.kind === "deopt") {
      pendingDeopt ??= options.runtime.createPendingDeoptFromChild({
        result: valueResult
      });
      nextProperty.value = t.cloneNode(valueResult.fallbackExpression);
      properties.push(nextProperty);
      continue;
    }

    nextProperty.value = valueResult.expression;
    pushObjectPropertyWithOverride({
      properties,
      property: nextProperty,
      propertyKeyIndexes
    });
  }

  const reducedExpression = t.objectExpression(properties);

  return pendingDeopt
    ? options.runtime.createDeoptResult({
        expression: options.expression,
        reason: pendingDeopt.reason,
        details: {
          ...pendingDeopt.details,
          fallbackExpression: reducedExpression
        }
      })
    : options.runtime.createConfidentResult(reducedExpression);
}

export function getStaticObjectMemberValue(
  expression: t.ObjectExpression,
  memberName: string
): t.Expression | null {
  for (let index = expression.properties.length - 1; index >= 0; index -= 1) {
    const property = expression.properties[index];

    if (!t.isObjectProperty(property) || property.computed) {
      return null;
    }

    if (getStaticObjectPropertyName(property.key) !== memberName) {
      continue;
    }

    return t.isExpression(property.value) ? property.value : null;
  }

  return null;
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

type StaticNameResult =
  | { readonly kind: "resolved"; readonly name: string }
  | {
      readonly kind: "deopt";
      readonly result: PartialEvalResult & { kind: "deopt" };
    };

interface ReduceObjectPropertyKeyOptions extends PartialEvalReducerNodeOptions<t.ObjectExpression> {
  readonly property: t.ObjectProperty;
}

function reduceObjectPropertyKey(
  options: ReduceObjectPropertyKeyOptions
): StaticNameResult {
  const staticName = getStaticObjectPropertyName(options.property.key);

  if (!options.property.computed) {
    return staticName
      ? { kind: "resolved", name: staticName }
      : {
          kind: "deopt",
          result: options.runtime.createDeoptResult({
            expression: options.expression,
            reason: "non-static-object-key"
          })
        };
  }

  if (!t.isExpression(options.property.key)) {
    return {
      kind: "deopt",
      result: options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "non-static-object-key"
      })
    };
  }

  const keyResult = options.runtime.reduceExpression({
    expression: options.property.key,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (keyResult.kind === "deopt") {
    return {
      kind: "deopt",
      result: options.runtime.createDeoptFromChild({
        expression: options.expression,
        result: keyResult,
        reason: options.runtime.getContextualDeoptReason(
          keyResult,
          "non-static-object-key"
        )
      })
    };
  }

  const keyName = getStaticStringOrNumberMemberName(keyResult.expression);

  return keyName === null
    ? {
        kind: "deopt",
        result: options.runtime.createDeoptResult({
          expression: options.expression,
          reason: "non-static-object-key"
        })
      }
    : { kind: "resolved", name: String(keyName) };
}

interface PushObjectSpreadPropertiesOptions {
  readonly properties: t.ObjectExpression["properties"];
  readonly property: t.SpreadElement;
  readonly spreadExpression: t.ObjectExpression;
  readonly propertyKeyIndexes: Map<string, number>;
}

function pushObjectSpreadProperties(
  options: PushObjectSpreadPropertiesOptions
): boolean {
  for (const spreadProperty of options.spreadExpression.properties) {
    if (t.isSpreadElement(spreadProperty)) {
      options.properties.push(t.cloneNode(options.property));
      return true;
    }
    pushObjectPropertyWithOverride({
      properties: options.properties,
      property: t.cloneNode(spreadProperty),
      propertyKeyIndexes: options.propertyKeyIndexes
    });
  }
  return false;
}

function pushObjectPropertyWithOverride(options: {
  readonly properties: t.ObjectExpression["properties"];
  readonly property: t.ObjectExpression["properties"][number];
  readonly propertyKeyIndexes: Map<string, number>;
}): void {
  const keyName = t.isObjectProperty(options.property)
    ? getStaticObjectPropertyName(options.property.key)
    : null;

  if (keyName) {
    const existingIndex = options.propertyKeyIndexes.get(keyName);

    if (existingIndex !== undefined) {
      options.properties[existingIndex] = options.property;
      return;
    }
    options.propertyKeyIndexes.set(keyName, options.properties.length);
  }

  options.properties.push(options.property);
}

function createStaticObjectPropertyKey(
  propertyName: string
): t.Identifier | t.StringLiteral {
  return t.isValidIdentifier(propertyName)
    ? t.identifier(propertyName)
    : t.stringLiteral(propertyName);
}

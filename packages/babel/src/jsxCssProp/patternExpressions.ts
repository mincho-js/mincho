import { types as t, type NodePath } from "@babel/core";
import { staticMemberName } from "../commonjs/bindings.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { resolveStaticMemberPath } from "../staticCssEval/partialEvaluator/destructuring.js";

/** Check computed keys and defaults that may execute during destructuring. */
export function everyPatternExpression(
  pattern: NodePath<t.Node | null | undefined>,
  predicate: (expression: NodePath<t.Node | null | undefined>) => boolean,
  selected?: t.Expression | null
): boolean {
  const value = selected && unwrapTransparentCssRuleExpression(selected);

  if (pattern.isAssignmentPattern()) {
    // Only fresh literal selections prove that a default cannot execute.
    // Referenced objects may have changed since their declaration.
    const defined =
      t.isLiteral(value) ||
      t.isObjectExpression(value) ||
      t.isArrayExpression(value) ||
      t.isFunctionExpression(value) ||
      t.isArrowFunctionExpression(value);
    const defaulted =
      t.isUnaryExpression(value, { operator: "void" }) ||
      (t.isIdentifier(value, { name: "undefined" }) &&
        !pattern.scope.getBinding("undefined"));

    return (
      (defined || predicate(pattern.get("right"))) &&
      everyPatternExpression(
        pattern.get("left"),
        predicate,
        defaulted ? pattern.node.right : value
      )
    );
  }

  if (pattern.isObjectPattern()) {
    return pattern.get("properties").every((property) => {
      if (property.isRestElement()) {
        return everyPatternExpression(property.get("argument"), predicate);
      }
      if (!property.isObjectProperty()) return false;

      return (
        (!property.node.computed || predicate(property.get("key"))) &&
        everyPatternExpression(
          property.get("value"),
          predicate,
          selectPatternValue(value, staticMemberName(property.node))
        )
      );
    });
  }

  if (pattern.isArrayPattern()) {
    return pattern
      .get("elements")
      .every(
        (element, index) =>
          !element.node ||
          everyPatternExpression(
            element,
            predicate,
            selectPatternValue(value, String(index))
          )
      );
  }

  if (pattern.isRestElement()) {
    return everyPatternExpression(pattern.get("argument"), predicate);
  }

  return true;
}

function selectPatternValue(
  value: t.Expression | null | undefined,
  member: string | null
): t.Expression | null {
  if (!value || member === null) return null;
  if (
    t.isArrayExpression(value) &&
    value.elements
      .slice(0, Number(member) + 1)
      .some((element) => t.isSpreadElement(element))
  )
    return null;

  const selected = resolveStaticMemberPath(value, [member]);
  if (selected) return selected;

  // Preserve known absence separately from unknown spread/accessor values so
  // a nested pattern can use the default that definitely supplies its value.
  const missing =
    (t.isArrayExpression(value) &&
      /^\d+$/.test(member) &&
      !value.elements[Number(member)]) ||
    (t.isObjectExpression(value) &&
      !(member in Object.prototype) &&
      value.properties.every(
        (property) =>
          t.isObjectProperty(property) &&
          !property.computed &&
          staticMemberName(property) !== "__proto__"
      ));

  return missing ? t.unaryExpression("void", t.numericLiteral(0)) : null;
}

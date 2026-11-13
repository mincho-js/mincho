import { types as t, type NodePath } from "@babel/core";
import { staticMemberName } from "../commonjs/bindings.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { resolveStaticMemberPath } from "../staticCssEval/partialEvaluator/destructuring.js";
import {
  isCanonicalArrayIndex,
  selectObjectLiteralMember
} from "../staticCssEval/propertySelection.js";

/** Check computed keys and defaults that may execute during destructuring. */
export function everyPatternExpression(
  pattern: NodePath<t.Node | null | undefined>,
  predicate: (expression: NodePath<t.Node | null | undefined>) => boolean,
  selected?: t.Expression | null
): boolean {
  return everyPatternNodeExpression(
    pattern.node,
    (_, path) => predicate(pattern.get(path) as NodePath<t.Node>),
    selected,
    !pattern.scope.getBinding("undefined")
  );
}

/** The node form shares selection semantics with lexical NodePath callers. */
export function everyPatternNodeExpression(
  pattern: t.Node | null | undefined,
  predicate: (expression: t.Expression, path: string) => boolean,
  selected?: t.Expression | null,
  unboundUndefined = false,
  path = ""
): boolean {
  const value = selected && unwrapTransparentCssRuleExpression(selected);
  const child = (key: string) => (path ? `${path}.${key}` : key);
  const visit = (
    node: t.Node | null,
    key: string,
    selected?: t.Expression | null
  ) =>
    everyPatternNodeExpression(
      node,
      predicate,
      selected,
      unboundUndefined,
      child(key)
    );

  if (t.isAssignmentPattern(pattern)) {
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
      (t.isIdentifier(value, { name: "undefined" }) && unboundUndefined);
    return (
      (defined || predicate(pattern.right, child("right"))) &&
      visit(pattern.left, "left", defaulted ? pattern.right : value)
    );
  }

  if (t.isObjectPattern(pattern)) {
    return pattern.properties.every((property, index) => {
      const key = `properties.${index}`;
      if (t.isRestElement(property))
        return visit(property.argument, `${key}.argument`);
      return (
        (!property.computed ||
          (t.isExpression(property.key) &&
            predicate(property.key, child(`${key}.key`)))) &&
        visit(
          property.value,
          `${key}.value`,
          selectPatternValue(value, staticMemberName(property))
        )
      );
    });
  }
  if (t.isArrayPattern(pattern))
    return pattern.elements.every(
      (element, index) =>
        !element ||
        visit(
          element,
          `elements.${index}`,
          selectPatternValue(value, String(index))
        )
    );
  if (t.isRestElement(pattern)) return visit(pattern.argument, "argument");
  return true;
}

function selectPatternValue(
  value: t.Expression | null | undefined,
  member: string | null
): t.Expression | null {
  if (!value || member === null) return null;
  const selected = resolveStaticMemberPath(value, [member]);
  if (selected) return selected;

  // Preserve absence separately from unknown spread/accessor values so a
  // nested pattern can use the default that definitely supplies its value.
  const property = t.isObjectExpression(value)
    ? selectObjectLiteralMember(value, member)
    : undefined;
  const missing =
    (t.isArrayExpression(value) &&
      isCanonicalArrayIndex(member) &&
      !value.elements[Number(member)] &&
      !value.elements.some((element) => t.isSpreadElement(element))) ||
    (property?.kind === "missing" && !(member in Object.prototype)) ||
    (property?.kind === "prototype" && t.isNullLiteral(property.value));
  return missing ? t.unaryExpression("void", t.numericLiteral(0)) : null;
}

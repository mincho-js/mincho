import ts from "typescript";

export function rootIdentifierName(
  expression: ts.Expression
): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression))
    return rootIdentifierName(expression.expression);
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return rootIdentifierName(expression.expression);
  }
}

export function referencedIdentifierNames(
  expression: ts.Expression
): readonly string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      ) {
        return;
      }
      names.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...names];
}

export function assignmentTargetNames(
  expression: ts.Expression
): readonly string[] {
  const root = rootIdentifierName(expression);
  if (root !== undefined) return [root];
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? assignmentTargetNames(element.expression)
        : assignmentTargetNames(element)
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name.text];
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetNames(property.initializer);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetNames(property.expression);
      }
      return [];
    });
  }
  return referencedIdentifierNames(expression);
}

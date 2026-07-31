import { types as t } from "@babel/core";
import type { SidecarSafetyState } from "./sidecarSafety.js";

export type SidecarSafeExpression = (
  expression: t.Expression | t.Super,
  state: SidecarSafetyState
) => boolean;

export function isSidecarSafeFunctionLike(
  node: t.Function | t.ArrowFunctionExpression,
  state: SidecarSafetyState,
  isSidecarSafeExpression: SidecarSafeExpression
): boolean {
  const localNames = new Set(state.localNames);
  collectPatternNames(node.params, localNames);
  collectStatementLocalNames(node.body, localNames);
  const nextState = { ...state, localNames };

  return t.isBlockStatement(node.body)
    ? node.body.body.every((statement) =>
        isSidecarSafeStatement(statement, nextState, isSidecarSafeExpression)
      )
    : isSidecarSafeExpression(node.body, nextState);
}

function isSidecarSafeStatement(
  statement: t.Statement,
  state: SidecarSafetyState,
  isSidecarSafeExpression: SidecarSafeExpression
): boolean {
  if (t.isBlockStatement(statement)) {
    return statement.body.every((item) =>
      isSidecarSafeStatement(item, state, isSidecarSafeExpression)
    );
  }

  if (t.isReturnStatement(statement)) {
    return statement.argument
      ? isSidecarSafeExpression(statement.argument, state)
      : true;
  }

  if (t.isVariableDeclaration(statement)) {
    return statement.declarations.every(
      (declaration) =>
        !declaration.init ||
        (t.isExpression(declaration.init) &&
          isSidecarSafeExpression(declaration.init, state))
    );
  }

  if (t.isFunctionDeclaration(statement)) {
    return isSidecarSafeFunctionLike(statement, state, isSidecarSafeExpression);
  }

  if (t.isExpressionStatement(statement)) {
    return isSidecarSafeExpression(statement.expression, state);
  }

  if (t.isIfStatement(statement)) {
    return (
      isSidecarSafeExpression(statement.test, state) &&
      isSidecarSafeStatement(
        statement.consequent,
        state,
        isSidecarSafeExpression
      ) &&
      (!statement.alternate ||
        isSidecarSafeStatement(
          statement.alternate,
          state,
          isSidecarSafeExpression
        ))
    );
  }

  return false;
}

function collectStatementLocalNames(node: t.Node, names: Set<string>): void {
  if (t.isFunctionDeclaration(node) && node.id) {
    names.add(node.id.name);
  }

  if (t.isVariableDeclaration(node)) {
    for (const declaration of node.declarations) {
      collectPatternNames([declaration.id], names);
    }
  }

  if (t.isBlockStatement(node)) {
    for (const statement of node.body) {
      collectStatementLocalNames(statement, names);
    }
  }

  if (t.isIfStatement(node)) {
    collectStatementLocalNames(node.consequent, names);

    if (node.alternate) {
      collectStatementLocalNames(node.alternate, names);
    }
  }
}

function collectPatternNames(
  patterns: readonly t.Node[],
  names: Set<string>
): void {
  for (const pattern of patterns) {
    if (t.isIdentifier(pattern)) {
      names.add(pattern.name);
      continue;
    }

    if (t.isAssignmentPattern(pattern)) {
      collectPatternNames([pattern.left], names);
      continue;
    }

    if (t.isRestElement(pattern)) {
      collectPatternNames([pattern.argument], names);
      continue;
    }

    if (t.isArrayPattern(pattern)) {
      collectPatternNames(
        pattern.elements.filter((item) => item !== null),
        names
      );
      continue;
    }

    if (t.isObjectPattern(pattern)) {
      for (const property of pattern.properties) {
        if (t.isObjectProperty(property) && t.isPatternLike(property.value)) {
          collectPatternNames([property.value], names);
          continue;
        }

        if (t.isRestElement(property)) {
          collectPatternNames([property.argument], names);
        }
      }
    }
  }
}

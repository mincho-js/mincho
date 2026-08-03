import { types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";
import type { SameFileDeclarationKind } from "../sameFile/types.js";
import { getStaticArrayMemberValue } from "./arrays.js";
import {
  getStaticObjectMemberValue,
  getStaticObjectPropertyName
} from "./objects.js";

export interface PartialEvalBindingSource {
  readonly declarationKind: SameFileDeclarationKind;
  readonly init: t.Expression;
  readonly memberPath: readonly string[];
}

type DestructuredPattern =
  | t.Identifier
  | t.ObjectPattern
  | t.ArrayPattern
  | t.VoidPattern;

export function getDestructuredBindingSource(
  binding: Binding,
  bindingName: string
): PartialEvalBindingSource | null {
  const declaratorPath = binding.path.isVariableDeclarator()
    ? binding.path
    : binding.path.findParent((path) => {
        return path.isVariableDeclarator();
      });

  if (!declaratorPath?.isVariableDeclarator()) {
    return null;
  }

  const declarationPath = declaratorPath.parentPath;

  if (!declarationPath.isVariableDeclaration()) {
    return null;
  }

  const init = declaratorPath.node.init;
  const pattern = declaratorPath.node.id;

  if (!isDestructuredPattern(pattern)) {
    return null;
  }

  const memberPath = getDestructuredMemberPath(pattern, bindingName);
  const declarationKind = declarationPath.node.kind;

  if (
    !init ||
    !t.isExpression(init) ||
    !memberPath ||
    !isSupportedVariableDeclarationKind(declarationKind)
  ) {
    return null;
  }

  return { declarationKind, init, memberPath };
}

export function resolveStaticMemberPath(
  expression: t.Expression,
  memberPath: readonly string[]
): t.Expression | null {
  let currentExpression: t.Expression | null = expression;

  for (const memberName of memberPath) {
    if (t.isObjectExpression(currentExpression)) {
      currentExpression = getStaticObjectMemberValue(
        currentExpression,
        memberName
      );
      continue;
    }

    if (t.isArrayExpression(currentExpression)) {
      currentExpression = getStaticArrayMemberValue(
        currentExpression,
        memberName
      );
      continue;
    }

    return null;
  }

  return currentExpression;
}

function isSupportedVariableDeclarationKind(
  kind: t.VariableDeclaration["kind"]
): kind is "const" | "let" | "var" {
  return kind === "const" || kind === "let" || kind === "var";
}

function getDestructuredMemberPath(
  pattern: DestructuredPattern,
  bindingName: string
): readonly string[] | null {
  if (t.isIdentifier(pattern)) {
    return pattern.name === bindingName ? [] : null;
  }

  if (t.isObjectPattern(pattern)) {
    return getObjectPatternMemberPath(pattern, bindingName);
  }

  if (t.isArrayPattern(pattern)) {
    return getArrayPatternMemberPath(pattern, bindingName);
  }

  return null;
}

function isDestructuredPattern(
  pattern: unknown
): pattern is DestructuredPattern {
  if (typeof pattern !== "object" || pattern === null || !("type" in pattern)) {
    return false;
  }

  return (
    pattern.type === "Identifier" ||
    pattern.type === "ObjectPattern" ||
    pattern.type === "ArrayPattern" ||
    pattern.type === "VoidPattern"
  );
}

function getObjectPatternMemberPath(
  pattern: t.ObjectPattern,
  bindingName: string
): readonly string[] | null {
  for (const property of pattern.properties) {
    if (!t.isObjectProperty(property)) {
      continue;
    }

    const propertyName = getPatternPropertyName(property);
    const value = property.value;

    if (!isDestructuredPattern(value)) {
      continue;
    }

    const childPath = getDestructuredMemberPath(value, bindingName);

    if (propertyName && childPath) {
      return [propertyName, ...childPath];
    }
  }

  return null;
}

function getArrayPatternMemberPath(
  pattern: t.ArrayPattern,
  bindingName: string
): readonly string[] | null {
  for (const [index, element] of pattern.elements.entries()) {
    if (!isDestructuredPattern(element)) {
      continue;
    }

    const childPath = getDestructuredMemberPath(element, bindingName);

    if (childPath) {
      return [String(index), ...childPath];
    }
  }

  return null;
}

function getPatternPropertyName(property: t.ObjectProperty): string | null {
  return property.computed && !t.isStringLiteral(property.key)
    ? null
    : getStaticObjectPropertyName(property.key);
}

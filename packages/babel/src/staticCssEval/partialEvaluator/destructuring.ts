import { hasObservableArrayMapMutation } from "../../optimizations/arrayMapIntrinsic.js";
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
  readonly arrayIterationOffsets?: readonly number[];
}

type DestructuredPattern =
  t.Identifier | t.ObjectPattern | t.ArrayPattern | t.VoidPattern;

export function getDestructuredBindingSource(
  binding: Binding,
  bindingName: string,
  environment?: {
    readonly nativeArrayIteration?: boolean;
    readonly deferArrayReceiverCheck?: boolean;
  }
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
  const arrayIterationOffsets = getArrayIterationOffsets(pattern, bindingName);
  if (arrayIterationOffsets.length) {
    const program = binding.scope.getProgramParent().path;
    if (
      environment?.nativeArrayIteration === false ||
      !program.isProgram() ||
      hasObservableArrayMapMutation(program, "iteration")
    )
      return null;
  }
  const declarationKind = declarationPath.node.kind;

  if (
    !init ||
    !t.isExpression(init) ||
    !memberPath ||
    !isSupportedVariableDeclarationKind(declarationKind)
  ) {
    return null;
  }

  // Non-reducer callers may only consume an indexed path once its receivers
  // are demonstrably arrays. The reducer checks again after reducing aliases.
  if (
    arrayIterationOffsets.length &&
    !environment?.deferArrayReceiverCheck &&
    !resolveStaticMemberPath(init, memberPath, arrayIterationOffsets)
  )
    return null;
  return { declarationKind, init, memberPath, arrayIterationOffsets };
}

export function resolveStaticMemberPath(
  expression: t.Expression,
  memberPath: readonly string[],
  arrayIterationOffsets: readonly number[] = []
): t.Expression | null {
  let currentExpression: t.Expression | null = expression;

  for (const [offset, memberName] of memberPath.entries()) {
    if (
      arrayIterationOffsets.includes(offset) &&
      !t.isArrayExpression(currentExpression)
    )
      return null;
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

/** Preserve iteration operations separately from ordinary property access. */
function getArrayIterationOffsets(
  pattern: DestructuredPattern,
  bindingName: string,
  depth = 0
): number[] {
  if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (
        !isDestructuredPattern(element) ||
        !getDestructuredMemberPath(element, bindingName)
      )
        continue;
      return [
        depth,
        ...getArrayIterationOffsets(element, bindingName, depth + 1)
      ];
    }
  }
  if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) {
      if (
        !t.isObjectProperty(property) ||
        !isDestructuredPattern(property.value) ||
        !getDestructuredMemberPath(property.value, bindingName)
      )
        continue;
      return getArrayIterationOffsets(property.value, bindingName, depth + 1);
    }
  }
  return [];
}

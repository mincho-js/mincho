import ts from "typescript";
import {
  assignmentTargetNames,
  referencedIdentifierNames,
  rootIdentifierName
} from "./static-identifiers.js";

export type StaticBindings = {
  readonly expressions: ReadonlyMap<string, ts.Expression>;
  readonly written: ReadonlySet<string>;
};

const defineRulesCssRuntimeModule =
  "@mincho-js/css/defineRules/createDefineRulesCssRuntime";
const defineRulesCssRuntimeExport = "createDefineRulesCssRuntime";

type ReadonlyCalleeKind = "direct" | "namespace";

function trustedReadonlyCallees(
  sourceFile: ts.SourceFile
): ReadonlyMap<string, ReadonlyCalleeKind> {
  const callees = new Map<string, ReadonlyCalleeKind>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === defineRulesCssRuntimeModule
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (
            (element.propertyName ?? element.name).text ===
            defineRulesCssRuntimeExport
          ) {
            callees.set(element.name.text, "direct");
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        callees.set(bindings.name.text, "namespace");
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "require" &&
        declaration.initializer.arguments[0] !== undefined &&
        ts.isStringLiteral(declaration.initializer.arguments[0]) &&
        declaration.initializer.arguments[0].text === defineRulesCssRuntimeModule
      ) {
        callees.set(declaration.name.text, "namespace");
      }
    }
  }
  return callees;
}

function isTrustedReadonlyCall(
  node: ts.CallExpression,
  callees: ReadonlyMap<string, ReadonlyCalleeKind>,
  written: ReadonlySet<string>
): boolean {
  if (ts.isIdentifier(node.expression)) {
    return (
      callees.get(node.expression.text) === "direct" &&
      !written.has(node.expression.text)
    );
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression)
  ) {
    return (
      callees.get(node.expression.expression.text) === "namespace" &&
      !written.has(node.expression.expression.text) &&
      node.expression.name.text === defineRulesCssRuntimeExport
    );
  }
  return false;
}

function callWrittenNames(
  node: ts.CallExpression,
  readonlyCallees: ReadonlyMap<string, ReadonlyCalleeKind>,
  written: ReadonlySet<string>
): string[] {
  if (isTrustedReadonlyCall(node, readonlyCallees, written)) return [];
  if (
    ts.isPropertyAccessExpression(node.expression) ||
    ts.isElementAccessExpression(node.expression)
  ) {
    const calleeRoot = rootIdentifierName(node.expression.expression);
    if (calleeRoot !== "Object" && calleeRoot !== "Reflect") {
      return [
        ...(calleeRoot === undefined ? [] : [calleeRoot]),
        ...node.arguments.flatMap(assignmentTargetNames)
      ];
    }
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ((ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      [
        "assign",
        "defineProperties",
        "defineProperty",
        "setPrototypeOf"
      ].includes(node.expression.name.text)) ||
      (ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Reflect" &&
        ["defineProperty", "deleteProperty", "set", "setPrototypeOf"].includes(
          node.expression.name.text
        )))
  ) {
    const target = node.arguments[0];
    const targetName =
      target === undefined ? undefined : rootIdentifierName(target);
    return targetName === undefined ? [] : [targetName];
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return [];
  }
  return node.arguments.flatMap(assignmentTargetNames);
}

export function collectBindings(sourceFile: ts.SourceFile): StaticBindings {
  const bindings = new Map<string, ts.Expression>();
  const futureVarInitializers = new Map<string, number>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined
      ) {
        bindings.set(declaration.name.text, declaration.initializer);
        if (
          (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
        ) {
          futureVarInitializers.set(
            declaration.name.text,
            declaration.initializer.getStart(sourceFile)
          );
        }
      }
    }
  }
  const written = new Set<string>();
  const calls: ts.CallExpression[] = [];
  const readonlyCallees = trustedReadonlyCallees(sourceFile);
  const markWritten = (
    names: readonly string[],
    evaluationPosition?: number
  ): void => {
    for (const name of names) {
      const initializedAt = futureVarInitializers.get(name);
      if (
        evaluationPosition !== undefined &&
        initializedAt !== undefined &&
        evaluationPosition < initializedAt
      ) {
        continue;
      }
      if (bindings.has(name)) written.add(name);
    }
  };
  const topLevelEvaluationPosition = (node: ts.Node): number | undefined => {
    for (let parent = node.parent; parent !== sourceFile; parent = parent.parent) {
      if (parent === undefined || ts.isFunctionLike(parent)) return undefined;
    }
    return node.getStart(sourceFile);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      markWritten(assignmentTargetNames(node.left));
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markWritten(assignmentTargetNames(node.operand));
    } else if (ts.isDeleteExpression(node)) {
      markWritten(assignmentTargetNames(node.expression));
    } else if (ts.isCallExpression(node)) {
      calls.push(node);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          if (ts.isIdentifier(declaration.name))
            markWritten([declaration.name.text]);
        }
      } else {
        markWritten(assignmentTargetNames(node.initializer));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  for (const call of calls) {
    markWritten(
      callWrittenNames(call, readonlyCallees, written),
      topLevelEvaluationPosition(call)
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [alias, expression] of bindings) {
      if (!written.has(alias)) continue;
      for (const source of referencedIdentifierNames(expression)) {
        if (bindings.has(source) && !written.has(source)) {
          written.add(source);
          changed = true;
        }
      }
    }
  }
  return { expressions: bindings, written };
}

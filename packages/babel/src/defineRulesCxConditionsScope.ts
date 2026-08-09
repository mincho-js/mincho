import { type NodePath, types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";

export function collectTopLevelDependencies(
  paths: readonly NodePath<t.Expression>[]
): readonly NodePath<t.Statement>[] | null {
  const statements: NodePath<t.Statement>[] = [];
  const seen = new Set<t.Statement>();

  for (const path of paths) {
    const bindings = collectReferencedBindings(path);

    for (const binding of bindings) {
      const statement = getTopLevelBindingStatement(binding);

      if (statement === null) {
        return null;
      }

      if (!seen.has(statement.node)) {
        seen.add(statement.node);
        statements.push(statement);
      }
    }
  }

  return statements;
}

export function dependenciesPrecedeStatement(
  dependencies: readonly NodePath<t.Statement>[],
  statement: NodePath<t.Statement>
): boolean {
  const statementStart = statement.node.start;

  if (typeof statementStart !== "number") {
    return false;
  }

  return dependencies.every((dependency) => {
    if (dependency.node === statement.node) {
      return false;
    }

    const dependencyStart = dependency.node.start;
    return (
      typeof dependencyStart === "number" && dependencyStart < statementStart
    );
  });
}

export function getEnclosingProgramStatement(
  path: NodePath<t.Node>
): NodePath<t.Statement> | null {
  let current: NodePath<t.Node> | null = path;

  while (current !== null && current.parentPath?.isProgram() !== true) {
    current = current.parentPath;
  }

  return current !== null && current.isStatement() ? current : null;
}

export function getProgramInsertionPoint(
  path: NodePath<t.Node>,
  dependencyPaths: readonly NodePath<t.Expression>[]
): {
  readonly programStatement: NodePath<t.Statement>;
  readonly programPath: NodePath<t.Program>;
} | null {
  const programStatement = getEnclosingProgramStatement(path);

  if (programStatement === null) {
    return null;
  }

  const dependencies = collectTopLevelDependencies(dependencyPaths);

  if (
    dependencies === null ||
    !dependenciesPrecedeStatement(dependencies, programStatement)
  ) {
    return null;
  }

  const programPath = programStatement.findParent((parentPath) =>
    parentPath.isProgram()
  );

  return programPath !== null && programPath.isProgram()
    ? { programStatement, programPath }
    : null;
}

function collectReferencedBindings(
  path: NodePath<t.Expression>
): readonly Binding[] {
  const bindings: Binding[] = [];
  const seen = new Set<Binding>();

  collectReferencedBinding(path, bindings, seen);
  path.traverse({
    Identifier(identifierPath) {
      if (identifierPath.isReferencedIdentifier()) {
        collectReferencedBinding(identifierPath, bindings, seen);
      }
    }
  });

  return bindings;
}

function collectReferencedBinding(
  path: NodePath<t.Node>,
  bindings: Binding[],
  seen: Set<Binding>
): void {
  if (!path.isIdentifier() || !path.isReferencedIdentifier()) {
    return;
  }

  const binding = path.scope.getBinding(path.node.name);

  if (binding === undefined || seen.has(binding)) {
    return;
  }

  seen.add(binding);
  bindings.push(binding);
}

function getTopLevelBindingStatement(
  binding: Binding
): NodePath<t.Statement> | null {
  const statement = binding.path.getStatementParent();

  if (statement === null || statement.parentPath?.isProgram() !== true) {
    return null;
  }

  return statement;
}

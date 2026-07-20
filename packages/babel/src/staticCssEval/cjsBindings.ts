import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";

type StaticCssEvalBabelScope = NodePath<t.Node>["scope"];

export type ImportedStaticCssEvalCjsBinding = {
  readonly kind: "cjs-module" | "cjs-member" | "cjs-destructured";
  readonly localName: string;
  readonly importPath: string;
  readonly propertyPath: readonly string[];
};

export type StaticCssEvalCjsRequireSource = {
  readonly importPath: string;
  readonly propertyPath: readonly string[];
};

export function collectStaticCssEvalCjsRequireBindings(
  programPath: NodePath<t.Program>
): Map<string, ImportedStaticCssEvalCjsBinding> {
  const cjsImports = new Map<string, ImportedStaticCssEvalCjsBinding>();

  for (const statementPath of programPath.get("body")) {
    collectStaticCssEvalCjsRequireStatementBindings(statementPath, cjsImports);
  }

  return cjsImports;
}

export function isStaticCssEvalRequireCallExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): expression is t.CallExpression {
  return (
    t.isCallExpression(expression) &&
    t.isIdentifier(expression.callee) &&
    expression.callee.name === "require" &&
    !hasRequireValueBinding(scope)
  );
}

export function isStaticCssEvalLiteralRequireCallExpression(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): boolean {
  return getStaticCssEvalLiteralRequireImportPath(expression, scope) !== null;
}

function collectStaticCssEvalCjsRequireStatementBindings(
  statementPath: NodePath<t.Statement>,
  cjsImports: Map<string, ImportedStaticCssEvalCjsBinding>
): void {
  if (!statementPath.isVariableDeclaration({ kind: "const" })) {
    return;
  }

  for (const declaration of statementPath.node.declarations) {
    collectStaticCssEvalCjsRequireDeclarator(
      declaration,
      statementPath.scope,
      cjsImports
    );
  }
}

function collectStaticCssEvalCjsRequireDeclarator(
  declaration: t.VariableDeclarator,
  scope: StaticCssEvalBabelScope,
  cjsImports: Map<string, ImportedStaticCssEvalCjsBinding>
): void {
  if (t.isIdentifier(declaration.id)) {
    const source = getStaticCssEvalCjsRequireSource(declaration.init, scope);

    if (!source) {
      return;
    }

    cjsImports.set(declaration.id.name, {
      kind: source.propertyPath.length === 0 ? "cjs-module" : "cjs-member",
      localName: declaration.id.name,
      importPath: source.importPath,
      propertyPath: source.propertyPath
    });
    return;
  }

  if (!t.isObjectPattern(declaration.id)) {
    return;
  }

  const importPath = getStaticCssEvalLiteralRequireImportPath(
    declaration.init,
    scope
  );

  if (!importPath) {
    return;
  }

  for (const property of declaration.id.properties) {
    collectStaticCssEvalCjsDestructuredBinding(
      property,
      importPath,
      cjsImports
    );
  }
}

function collectStaticCssEvalCjsDestructuredBinding(
  property: t.ObjectPattern["properties"][number],
  importPath: string,
  cjsImports: Map<string, ImportedStaticCssEvalCjsBinding>
): void {
  if (!t.isObjectProperty(property) || property.computed) {
    return;
  }

  const propertyName = getStaticCssEvalObjectPatternPropertyName(property.key);
  const localName = t.isIdentifier(property.value) ? property.value.name : null;

  if (!propertyName || !localName) {
    return;
  }

  cjsImports.set(localName, {
    kind: "cjs-destructured",
    localName,
    importPath,
    propertyPath: [propertyName]
  });
}

export function getStaticCssEvalCjsRequireSource(
  expression: t.Expression | null | undefined,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsRequireSource | null {
  const importPath = getStaticCssEvalLiteralRequireImportPath(
    expression,
    scope
  );

  if (importPath) {
    return { importPath, propertyPath: [] };
  }

  return expression
    ? getStaticCssEvalLiteralRequireMemberSource(expression, scope)
    : null;
}

function getStaticCssEvalLiteralRequireMemberSource(
  expression: t.Expression,
  scope: StaticCssEvalBabelScope
): StaticCssEvalCjsRequireSource | null {
  const propertyPath: string[] = [];
  let currentExpression: t.Expression = expression;

  while (t.isMemberExpression(currentExpression)) {
    const propertyName = getStaticCssEvalMemberPropertyName(currentExpression);

    if (!propertyName || !t.isExpression(currentExpression.object)) {
      return null;
    }

    propertyPath.unshift(propertyName);
    currentExpression = currentExpression.object;
  }

  const importPath = getStaticCssEvalLiteralRequireImportPath(
    currentExpression,
    scope
  );

  return importPath && propertyPath.length > 0
    ? { importPath, propertyPath }
    : null;
}

export function getStaticCssEvalLiteralRequireImportPath(
  expression: t.Expression | null | undefined,
  scope: StaticCssEvalBabelScope
): string | null {
  if (!expression || !isStaticCssEvalRequireCallExpression(expression, scope)) {
    return null;
  }

  const [specifier] = expression.arguments;

  return expression.arguments.length === 1 && t.isStringLiteral(specifier)
    ? specifier.value
    : null;
}

function getStaticCssEvalMemberPropertyName(
  expression: t.MemberExpression
): string | null {
  return !expression.computed && t.isIdentifier(expression.property)
    ? expression.property.name
    : null;
}

function getStaticCssEvalObjectPatternPropertyName(
  propertyKey: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(propertyKey)) {
    return propertyKey.name;
  }

  return t.isStringLiteral(propertyKey) ? propertyKey.value : null;
}

function hasRequireValueBinding(scope: StaticCssEvalBabelScope): boolean {
  const binding = scope.getBinding("require");

  if (!binding) {
    return false;
  }

  if (
    (binding.path.isImportSpecifier() ||
      binding.path.isImportDefaultSpecifier() ||
      binding.path.isImportNamespaceSpecifier()) &&
    binding.path.parentPath.isImportDeclaration()
  ) {
    return (
      binding.path.parentPath.node.importKind !== "type" &&
      (!binding.path.isImportSpecifier() ||
        binding.path.node.importKind !== "type")
    );
  }

  return true;
}

import ts from "typescript";
import type { StaticBindings } from "./static-bindings.js";
import { PackageContractError } from "./types.js";

export type StaticEsmReexport = {
  readonly exportName: string;
  readonly memberName: string;
  readonly moduleSpecifier: string;
};

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return (
    statement.modifiers?.some(
      ({ kind }) => kind === ts.SyntaxKind.ExportKeyword
    ) ?? false
  );
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
}

function isModuleExports(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "module" &&
    expression.name.text === "exports"
  );
}

function cjsExportName(expression: ts.Expression): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "exports"
  ) {
    return expression.name.text;
  }
}

function unsupportedCjsExportName(
  expression: ts.Expression
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      (ts.isIdentifier(expression.expression) &&
        expression.expression.text === "exports") ||
      isModuleExports(expression.expression)
    ) {
      return expression.name.text;
    }
  }
  if (ts.isElementAccessExpression(expression)) {
    if (
      ((ts.isIdentifier(expression.expression) &&
        expression.expression.text === "exports") ||
        isModuleExports(expression.expression)) &&
      expression.argumentExpression !== undefined &&
      ts.isStringLiteralLike(expression.argumentExpression)
    ) {
      return expression.argumentExpression.text;
    }
  }
}

function hasPresetProperty(expression: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(expression) &&
    expression.properties.some((property) => {
      if (
        ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)
      ) {
        const name = propertyName(property.name);
        return name !== undefined && /preset/i.test(name);
      }
      return false;
    })
  );
}

export function assertSupportedPresetExports(
  sourceFile: ts.SourceFile,
  label: string
): void {
  const unsupported = (name: string): never => {
    throw new PackageContractError(
      `${label} export ${name} uses an unsupported static export shape`
    );
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined
    ) {
      const exportClause = statement.exportClause;
      if (exportClause === undefined) {
        unsupported("preset");
      } else if (
        ts.isNamedExports(exportClause) &&
        exportClause.elements.some((element) =>
          /preset/i.test(element.name.text)
        ) &&
        (!ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.startsWith("."))
      ) {
        unsupported("preset");
      }
      continue;
    }

    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const unsupportedName = unsupportedCjsExportName(expression.left);
      if (
        unsupportedName !== undefined &&
        /preset/i.test(unsupportedName) &&
        cjsExportName(expression.left) === undefined
      ) {
        unsupported(unsupportedName);
      }
      if (
        isModuleExports(expression.left) &&
        hasPresetProperty(expression.right)
      ) {
        unsupported("preset");
      }
      continue;
    }

    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Object" &&
      expression.expression.name.text === "defineProperty" &&
      expression.arguments[0] !== undefined &&
      ((ts.isIdentifier(expression.arguments[0]) &&
        expression.arguments[0].text === "exports") ||
        isModuleExports(expression.arguments[0])) &&
      expression.arguments[1] !== undefined &&
      ts.isStringLiteralLike(expression.arguments[1]) &&
      /preset/i.test(expression.arguments[1].text)
    ) {
      unsupported(expression.arguments[1].text);
    }
  }
}

export function collectExportExpressions(
  sourceFile: ts.SourceFile,
  bindings: StaticBindings
): ReadonlyMap<string, ts.Expression> {
  const exports = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined
        ) {
          exports.set(declaration.name.text, declaration.name);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const bindingName = element.propertyName ?? element.name;
        if (bindings.expressions.has(bindingName.text)) {
          exports.set(element.name.text, bindingName);
        }
      }
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = cjsExportName(statement.expression.left);
      if (name !== undefined) exports.set(name, statement.expression.right);
    }
  }
  return exports;
}

export function collectEsmImportedExports(
  source: string,
  label: string
): readonly StaticEsmReexport[] {
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const imports = new Map<
    string,
    { readonly memberName: string; readonly moduleSpecifier: string }
  >();
  const reexports: StaticEsmReexport[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      for (const element of statement.exportClause.elements) {
        reexports.push({
          exportName: element.name.text,
          memberName: (element.propertyName ?? element.name).text,
          moduleSpecifier: statement.moduleSpecifier.text
        });
      }
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".") ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        memberName: (element.propertyName ?? element.name).text,
        moduleSpecifier: statement.moduleSpecifier.text
      });
    }
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier !== undefined ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const imported = imports.get((element.propertyName ?? element.name).text);
      if (imported !== undefined) {
        reexports.push({ exportName: element.name.text, ...imported });
      }
    }
  }
  return reexports;
}

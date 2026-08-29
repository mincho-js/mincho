import ts from "typescript";
import { propertyName } from "./static-properties.js";
import { collectBindings, type StaticBindings } from "./static-bindings.js";
import {
  assertSupportedPresetExports,
  collectExportExpressions
} from "./static-exports.js";
import { PackageContractError } from "./types.js";

export type StaticRecord = { readonly [key: string]: StaticValue };
export type StaticValue =
  | null
  | boolean
  | number
  | string
  | readonly StaticValue[]
  | StaticRecord;

export type StaticExport = {
  readonly name: string;
  readonly value: StaticValue;
};

export type StaticReexport = {
  readonly memberName: string;
  readonly moduleSpecifier: string;
};

type DecodeContext = StaticBindings & {
  readonly resolving: ReadonlySet<string>;
};

const unsupportedStaticObjectKeys = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

export function isStaticRecord(value: StaticValue): value is StaticRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativeCjsReexport(
  expression: ts.Expression,
  bindings: StaticBindings
): StaticReexport | undefined {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression)
  ) {
    return;
  }
  const initializer = bindings.expressions.get(expression.expression.text);
  if (
    initializer === undefined ||
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== "require"
  ) {
    return;
  }
  const moduleSpecifier = initializer.arguments[0];
  if (
    moduleSpecifier === undefined ||
    !ts.isStringLiteral(moduleSpecifier) ||
    !moduleSpecifier.text.startsWith(".")
  ) {
    return;
  }
  return {
    memberName: expression.name.text,
    moduleSpecifier: moduleSpecifier.text
  };
}

function decodeExpression(
  expression: ts.Expression,
  context: DecodeContext
): StaticValue | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return decodeExpression(expression.expression, context);
  }
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expression)) {
    const initializer = context.expressions.get(expression.text);
    if (
      initializer === undefined ||
      context.written.has(expression.text) ||
      context.resolving.has(expression.text)
    ) {
      return;
    }
    const nextResolving = new Set(context.resolving);
    nextResolving.add(expression.text);
    return decodeExpression(initializer, {
      ...context,
      resolving: nextResolving
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: StaticValue[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) return;
      const value = decodeExpression(element, context);
      if (value === undefined) return;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value = Object.create(null) as Record<string, StaticValue>;
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name === undefined) return;
        if (unsupportedStaticObjectKeys.has(name)) {
          throw new PackageContractError(
            `unsupported static object key ${name}`
          );
        }
        const propertyValue = decodeExpression(property.initializer, context);
        if (propertyValue === undefined) return;
        value[name] = propertyValue;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        if (unsupportedStaticObjectKeys.has(property.name.text)) {
          throw new PackageContractError(
            `unsupported static object key ${property.name.text}`
          );
        }
        const propertyValue = decodeExpression(property.name, context);
        if (propertyValue === undefined) return;
        value[property.name.text] = propertyValue;
      } else {
        return;
      }
    }
    return value;
  }
}

export function exportedStaticValues(
  source: string,
  label: string,
  resolveReexport?: (reexport: StaticReexport) => StaticValue | undefined
): readonly StaticExport[] {
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  assertSupportedPresetExports(sourceFile, label);
  const bindings = collectBindings(sourceFile);
  const exports = collectExportExpressions(sourceFile, bindings);
  const values: StaticExport[] = [];
  for (const [name, expression] of exports) {
    const value = decodeExpression(expression, {
      ...bindings,
      resolving: new Set()
    });
    if (value === undefined) {
      if (/preset/i.test(name)) {
        const reexport = relativeCjsReexport(expression, bindings);
        const reexportedValue =
          reexport === undefined ? undefined : resolveReexport?.(reexport);
        if (reexportedValue !== undefined) {
          values.push({ name, value: reexportedValue });
          continue;
        }
        throw new PackageContractError(
          `${label} export ${name} is not statically resolvable: ${expression.getText(sourceFile)}`
        );
      }
      continue;
    }
    values.push({ name, value });
  }
  return values;
}

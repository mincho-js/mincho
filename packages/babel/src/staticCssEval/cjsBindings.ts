import { transformSync, types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";

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

  return expression.arguments.length === 1
    ? getStaticCssEvalRequireSpecifierImportPath(specifier, scope)
    : null;
}

function getStaticCssEvalRequireSpecifierImportPath(
  specifier: t.CallExpression["arguments"][number] | undefined,
  scope: StaticCssEvalBabelScope
): string | null {
  if (t.isStringLiteral(specifier)) {
    return specifier.value;
  }

  return t.isIdentifier(specifier)
    ? getStaticCssEvalConstRequireSpecifierImportPath(specifier, scope)
    : null;
}

function getStaticCssEvalConstRequireSpecifierImportPath(
  specifier: t.Identifier,
  scope: StaticCssEvalBabelScope
): string | null {
  const binding = scope.getBinding(specifier.name);

  if (!binding || binding.constantViolations.length > 0) {
    return null;
  }

  const bindingPath = binding.path;

  if (
    !bindingPath.isVariableDeclarator() ||
    !t.isIdentifier(bindingPath.node.id) ||
    bindingPath.node.id.name !== specifier.name ||
    !bindingPath.parentPath.isVariableDeclaration({ kind: "const" })
  ) {
    return null;
  }

  const { init } = bindingPath.node;

  return t.isExpression(init)
    ? getStaticCssEvalStaticRequireSpecifierValue(init)
    : null;
}

function getStaticCssEvalStaticRequireSpecifierValue(
  expression: t.Expression
): string | null {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  }

  if (!t.isTemplateLiteral(expression) || expression.expressions.length > 0) {
    return null;
  }

  const [quasi] = expression.quasis;

  return quasi?.value.cooked ?? quasi?.value.raw ?? "";
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

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  function collectBindings(
    source: string
  ): Map<string, ImportedStaticCssEvalCjsBinding> {
    let cjsImports: Map<string, ImportedStaticCssEvalCjsBinding> | null = null;

    transformSync(source, {
      ast: false,
      babelrc: false,
      code: false,
      configFile: false,
      filename: "/project/src/App.tsx",
      parserOpts: { sourceType: "module" },
      plugins: [
        createProgramVisitorPlugin((programPath) => {
          cjsImports = collectStaticCssEvalCjsRequireBindings(programPath);
        })
      ]
    });

    if (!cjsImports) {
      throw new Error("Expected Babel transform to visit Program");
    }

    return cjsImports;
  }

  function createProgramVisitorPlugin(
    visit: (programPath: NodePath<t.Program>) => void
  ): PluginObj {
    return {
      visitor: {
        Program(programPath) {
          visit(programPath);
        }
      }
    };
  }

  describe("CommonJS require binding collection", () => {
    it("collects same-file const path CommonJS require bindings", () => {
      const bindings = collectBindings(`
        const path = "./styles";
        const templatePath = \`./styles\`;
        const styles = require(path);
        const directButton = require(path).button;
        const templateCard = require(templatePath).card;
        const { button, card: cardStyle } = require(path);
      `);

      expect([...bindings.entries()]).toEqual([
        [
          "styles",
          {
            kind: "cjs-module",
            localName: "styles",
            importPath: "./styles",
            propertyPath: []
          }
        ],
        [
          "directButton",
          {
            kind: "cjs-member",
            localName: "directButton",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "templateCard",
          {
            kind: "cjs-member",
            localName: "templateCard",
            importPath: "./styles",
            propertyPath: ["card"]
          }
        ],
        [
          "button",
          {
            kind: "cjs-destructured",
            localName: "button",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "cardStyle",
          {
            kind: "cjs-destructured",
            localName: "cardStyle",
            importPath: "./styles",
            propertyPath: ["card"]
          }
        ]
      ]);
    });

    it("rejects unsafe CommonJS require path bindings", () => {
      const cases: readonly string[] = [
        `let path = "./styles"; const styles = require(path);`,
        `const path = "./styles"; path = "./other"; const styles = require(path);`,
        `import { path } from "./paths"; const styles = require(path);`,
        "const path = `./${name}`; const styles = require(path);",
        `const path = "./" + "styles"; const styles = require(path);`,
        `const path = enabled ? "./styles" : "./fallback"; const styles = require(path);`,
        `const styles = require(path);`,
        `const path = process.env.STYLES; const styles = require(path);`,
        `const require = makeRequire(); const path = "./styles"; const styles = require(path);`,
        `const path = "./styles"; const { [buttonKey]: button } = require(path);`
      ];

      for (const source of cases) {
        expect([...collectBindings(source).entries()]).toEqual([]);
      }
    });
  });
}

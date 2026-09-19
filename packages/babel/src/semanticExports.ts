import { createHash } from "node:crypto";
import { types as t, traverse, type NodePath } from "@babel/core";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";
import { syntaxKey } from "./optimizations/pureFunctionMemo.js";

export interface SemanticExportRequest {
  readonly name: string | null;
  readonly members: readonly string[];
}

/** A closed, declarative ESM subset. Unknown effects and CommonJS retain file invalidation. */
export function semanticExports(
  filename: string,
  source: string,
  requests: readonly SemanticExportRequest[],
  cache?: SourceAstCache
): string | null {
  const jsx = !/\.[cm]?ts$/.test(filename);

  try {
    return (cache ?? new SourceAstCache(undefined, 0, 0)).analyze(
      {
        resolvedFile: filename,
        source,
        parserOptions: {
          plugins: jsx ? ["jsx", "typescript"] : ["typescript"],
          sourceType: "unambiguous",
          jsx,
          typescript: true
        }
      },
      `semantic-exports:v1:${JSON.stringify(requests)}`,
      (ast) => {
        const locals = new Map<string, t.Node>();
        const exports = new Map<string, t.Node>();
        const imports = new Map<string, unknown>();
        const boundaries: t.Node[] = [];
        const initializers: t.Node[] = [];

        function declaration(node: t.Node): boolean {
          if (
            t.isTSTypeAliasDeclaration(node) ||
            t.isTSInterfaceDeclaration(node)
          )
            return true;

          if (t.isFunctionDeclaration(node) && node.id) {
            locals.set(node.id.name, node);

            return true;
          }

          if (!t.isVariableDeclaration(node, { kind: "const" })) return false;

          for (const item of node.declarations) {
            if (!t.isIdentifier(item.id) || !item.init) return false;

            locals.set(item.id.name, item.init);
            initializers.push(item.init);
          }

          return true;
        }

        for (const statement of ast.program.body) {
          if (t.isImportDeclaration(statement)) {
            if (statement.importKind === "type") continue;
            if (!statement.specifiers.length) return null;

            boundaries.push(statement);

            for (const specifier of statement.specifiers)
              imports.set(specifier.local.name, [
                statement.source.value,
                specifier
              ]);
          } else if (t.isExportNamedDeclaration(statement)) {
            if (statement.exportKind === "type") continue;

            if (statement.source) {
              boundaries.push(statement);
            } else if (statement.declaration) {
              if (!declaration(statement.declaration)) return null;

              for (const name of Object.keys(
                t.getOuterBindingIdentifiers(statement.declaration)
              ))
                exports.set(name, t.identifier(name));
            } else
              for (const specifier of statement.specifiers) {
                if (!t.isExportSpecifier(specifier)) return null;

                exports.set(
                  t.isIdentifier(specifier.exported)
                    ? specifier.exported.name
                    : specifier.exported.value,
                  specifier.local
                );
              }
          } else if (t.isExportDefaultDeclaration(statement)) {
            if (t.isFunctionDeclaration(statement.declaration)) {
              if (statement.declaration.id) declaration(statement.declaration);
            } else if (!t.isExpression(statement.declaration)) return null;

            exports.set("default", statement.declaration);
            initializers.push(statement.declaration);
          } else if (!t.isEmptyStatement(statement) && !declaration(statement))
            return null;
        }

        const checking = new Set<string>();

        function inert(node: t.Node): boolean {
          if (
            t.isTSAsExpression(node) ||
            t.isTSSatisfiesExpression(node) ||
            t.isTSNonNullExpression(node) ||
            t.isTSTypeAssertion(node)
          )
            return inert(node.expression);
          if (
            t.isLiteral(node) &&
            !t.isTemplateLiteral(node) &&
            !t.isRegExpLiteral(node)
          )
            return true;
          if (t.isFunction(node)) return true;

          if (t.isIdentifier(node)) {
            if (imports.has(node.name)) return true;
            if (!locals.has(node.name)) return node.name === "undefined";

            const target = locals.get(node.name)!;
            if (
              !t.isFunctionDeclaration(target) &&
              node.start != null &&
              target.start != null &&
              node.start < target.start
            )
              return false;
            if (checking.has(node.name)) return false;

            checking.add(node.name);

            const result = inert(locals.get(node.name)!);
            checking.delete(node.name);

            return result;
          }

          if (
            t.isUnaryExpression(node) &&
            ["-", "+", "!", "~", "void"].includes(node.operator)
          )
            return (
              t.isNumericLiteral(node.argument) ||
              t.isBooleanLiteral(node.argument)
            );
          if (t.isArrayExpression(node))
            return node.elements.every((item) => !item || inert(item));

          return (
            t.isObjectExpression(node) &&
            node.properties.every(
              (item) =>
                t.isObjectProperty(item) && !item.computed && inert(item.value)
            )
          );
        }

        if (initializers.some((node) => !inert(node))) return null;

        let program: NodePath<t.Program> | undefined;
        const active = new Set<t.Node>();
        let count = 0;

        function value(node: t.Node, members: readonly string[] = []): unknown {
          if (++count > 512 || active.has(node))
            throw new Error("cyclic or oversized semantic export");

          active.add(node);

          try {
            if (
              t.isTSAsExpression(node) ||
              t.isTSSatisfiesExpression(node) ||
              t.isTSNonNullExpression(node) ||
              t.isTSTypeAssertion(node)
            )
              return value(node.expression, members);

            if (t.isIdentifier(node)) {
              const local = locals.get(node.name);
              if (local) return value(local, members);
              if (imports.has(node.name))
                return ["import", imports.get(node.name), members];
              if (node.name === "undefined" && !members.length)
                return ["undefined"];

              throw new Error("unknown binding");
            }

            if (members.length) {
              if (!t.isObjectExpression(node))
                throw new Error("unknown member");

              const property = node.properties.findLast(
                (item) =>
                  t.isObjectProperty(item) &&
                  !item.computed &&
                  (t.isIdentifier(item.key)
                    ? item.key.name
                    : t.isStringLiteral(item.key)
                      ? item.key.value
                      : undefined) === members[0]
              );
              if (!property || !t.isObjectProperty(property))
                throw new Error("unknown member");

              return value(property.value, members.slice(1));
            }

            if (t.isFunction(node)) {
              if (!program)
                traverse(ast, {
                  Program(path) {
                    program = path;
                    path.stop();
                  }
                });

              let functionPath: NodePath<t.Node> | undefined;
              program!.traverse({
                Function(path) {
                  if (path.node === node) {
                    functionPath = path;
                    path.stop();
                  }
                }
              });

              if (!functionPath) throw new Error("unknown function");

              const captures = new Set<string>();
              functionPath.traverse({
                ReferencedIdentifier(path) {
                  const binding = path.scope.getBinding(path.node.name);
                  if (
                    binding &&
                    (binding.path === functionPath ||
                      binding.path.findParent(
                        (parent) => parent === functionPath
                      ))
                  )
                    return;

                  captures.add(path.node.name);
                }
              });

              return [
                "function",
                node,
                [...captures]
                  .sort()
                  .map((name) => [name, value(t.identifier(name))])
              ];
            }

            if (t.isObjectExpression(node))
              return [
                "object",
                node.properties.map((item) => {
                  if (!t.isObjectProperty(item))
                    throw new Error("unknown property");

                  return [item.key, value(item.value)];
                })
              ];
            if (t.isArrayExpression(node))
              return [
                "array",
                node.elements.map((item) => (item ? value(item) : ["hole"]))
              ];

            return node;
          } finally {
            active.delete(node);
          }
        }

        let selected: unknown[];

        try {
          selected = requests.map(({ name, members }) => {
            const node = name === null ? undefined : exports.get(name);
            if (!node) throw new Error("unknown export");

            return [name, members, value(node, members)];
          });
        } catch {
          return null;
        }

        return createHash("sha256")
          .update(syntaxKey([boundaries, selected]))
          .digest("hex");
      }
    );
  } catch {
    return null;
  }
}

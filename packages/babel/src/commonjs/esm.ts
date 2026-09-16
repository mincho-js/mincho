import {
  parseSync,
  traverse,
  types as t,
  type NodePath,
  type PluginObj
} from "@babel/core";
import { getModuleReference } from "./bindings.js";
import {
  commonJsExports,
  findNodePath,
  normalizeTypeScriptCommonJs
} from "./modules.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";

export interface CommonJsDescription {
  commonjs: boolean;
  exportsObject: boolean;
  requires: string[];
  topLevelRequires: string[];
  exports: string[];
  stars: string[];
  esmStars: string[];
  reexports: { name: string; source: string; imported: string }[];
  localGetters: { name: string; local: string }[];
  diagnostics: string[];
}

export function inspectCommonJs(
  source: string,
  filename: string
): CommonJsDescription {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: {
      sourceType: "unambiguous",
      plugins: [
        "typescript",
        ...(/\.[cm]?[jt]s$/.test(filename) ? [] : ["jsx" as const])
      ]
    }
  });

  let program!: NodePath<t.Program>;

  if (ast)
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      }
    });
  if (!program) throw new Error(`Cannot parse CommonJS module ${filename}`);

  normalizeTypeScriptCommonJs(program);

  const shape = commonJsExports(program, filename);
  const requires = new Set<string>();
  const topLevelRequires = new Set<string>();
  const diagnostics: string[] = [];
  let exportsObject = shape.exports.size > 0 || shape.stars.length > 0;
  program.traverse({
    ReferencedIdentifier(path) {
      if (
        (path.node.name === "module" || path.node.name === "exports") &&
        !path.scope.getBinding(path.node.name)
      )
        exportsObject = true;
    },

    CallExpression(path) {
      if (
        !path.get("callee").isIdentifier({ name: "require" }) ||
        path.scope.getBinding("require")
      )
        return;

      const source = getStaticCssEvalLiteralRequireImportPath(
        path.node,
        path.scope
      );

      if (source) {
        requires.add(source);

        let child: NodePath = path;
        const conditional = path.findParent((parent) => {
          const key = child.key;
          child = parent;

          return (
            parent.isFunction() ||
            ((parent.isIfStatement() || parent.isConditionalExpression()) &&
              key !== "test") ||
            (parent.isLogicalExpression() && key === "right") ||
            parent.isLoop() ||
            parent.isTryStatement() ||
            parent.isSwitchStatement()
          );
        });

        if (conditional)
          diagnostics.push(
            `Conditional or lazy require at line ${path.node.loc?.start.line ?? "unknown"}`
          );

        const statementParent = path.getStatementParent()?.parentPath;
        if (
          !conditional &&
          !path.findParent((parent) => parent.isClass()) &&
          (statementParent?.isProgram() ||
            (statementParent?.isExportNamedDeclaration() &&
              statementParent.parentPath.isProgram()))
        )
          topLevelRequires.add(source);
      } else
        diagnostics.push(
          `Dynamic require at line ${path.node.loc?.start.line ?? "unknown"}`
        );
    }
  });

  const stars = shape.stars.map((entry) => entry.source);
  const esmStars: string[] = [];
  const exportNames = new Set<string>();

  for (const statement of program.get("body")) {
    if (statement.isExportDefaultDeclaration()) exportNames.add("default");
    if (
      statement.isExportAllDeclaration() &&
      statement.node.exportKind !== "type"
    )
      esmStars.push(statement.node.source.value);
    if (
      !statement.isExportNamedDeclaration() ||
      statement.node.exportKind === "type"
    )
      continue;
    if (statement.node.declaration)
      for (const name of Object.keys(
        t.getOuterBindingIdentifiers(statement.node.declaration)
      ))
        exportNames.add(name);

    for (const specifier of statement.node.specifiers) {
      if (t.isExportSpecifier(specifier) && specifier.exportKind === "type")
        continue;

      exportNames.add(
        t.isIdentifier(specifier.exported)
          ? specifier.exported.name
          : specifier.exported.value
      );
    }
  }

  const reexports: CommonJsDescription["reexports"] = [];
  const localGetters: CommonJsDescription["localGetters"] = [];

  for (const [name, entry] of shape.exports) {
    if (entry.kind === "unsupported") {
      // Writes through the old exports alias do not change a replaced module.exports.
      if (
        /^(?:Object.defineProperty )?exports\..* after module.exports replacement$/.test(
          entry.cjsExportMutation ?? ""
        )
      ) {
        shape.exports.delete(name);
        continue;
      }

      diagnostics.push(
        `Unsupported CommonJS export ${String(name)}: ${entry.cjsExportMutation ?? entry.cjsHelperName ?? entry.unsupportedKind}`
      );
      continue;
    }

    if (entry.kind === "reexport" && name !== null) {
      reexports.push({
        name,
        source: entry.source,
        imported: entry.importedName
      });
    } else if (entry.kind === "expression") {
      const path = findNodePath(program, entry.expression);
      const reference = path && getModuleReference(path);
      const getter = path?.findParent((parent) => parent.isFunction());

      if (
        name !== null &&
        getter &&
        path?.isIdentifier() &&
        path.scope.getBinding(path.node.name)?.scope === program.scope
      )
        localGetters.push({ name, local: path.node.name });

      if (reference?.kind === "require" && !reference.unsafe) {
        if (name === null && reference.members.length === 0)
          stars.push(reference.source);
        else if (
          name !== null &&
          getter &&
          reference.members.length === 1 &&
          reference.members[0] !== null
        )
          reexports.push({
            name,
            source: reference.source,
            imported: reference.members[0]!
          });
      }
    }
  }

  return {
    commonjs: exportsObject || requires.size > 0 || diagnostics.length > 0,
    exportsObject,
    requires: [...requires],
    topLevelRequires: [...topLevelRequires],
    exports: [
      ...new Set([
        ...exportNames,
        ...[...shape.exports.keys()].filter(
          (name): name is string => name !== null && name !== "__esModule"
        )
      ])
    ],
    stars,
    esmStars,
    reexports,
    localGetters,
    diagnostics
  };
}

export interface CommonJsEsmOptions {
  description: CommonJsDescription;
  imports: Readonly<Record<string, { id: string; commonjs: boolean }>>;
  exportNames: readonly string[];
}

/** Vite's browser runtime needs ESM; extraction itself keeps the input format. */
export function commonJsToEsmPlugin(options: CommonJsEsmOptions): PluginObj {
  return {
    name: "mincho-commonjs-to-esm",
    visitor: {
      Program(program) {
        if (options.description.diagnostics.length)
          throw program.buildCodeFrameError(
            options.description.diagnostics.join("; ")
          );

        const imports: t.ImportDeclaration[] = [];
        const replacements = new Map<string, t.Expression>();

        for (const [source, resolved] of Object.entries(options.imports)) {
          const namespace = program.scope.generateUidIdentifier("cjsImport");
          imports.push(
            t.importDeclaration(
              [t.importNamespaceSpecifier(namespace)],
              t.stringLiteral(resolved.id)
            )
          );
          replacements.set(
            source,
            resolved.commonjs
              ? t.memberExpression(namespace, t.identifier("default"))
              : namespace
          );
        }

        const module = program.scope.generateUidIdentifier("cjsModule");
        const exports = program.scope.generateUidIdentifier("cjsExports");
        program.traverse({
          CallExpression(path) {
            const source = getStaticCssEvalLiteralRequireImportPath(
              path.node,
              path.scope
            );

            if (source && replacements.has(source))
              path.replaceWith(t.cloneNode(replacements.get(source)!));
          },

          ReferencedIdentifier(path) {
            if (path.scope.getBinding(path.node.name)) return;

            if (path.node.name === "module")
              path.replaceWith(t.cloneNode(module));
            else if (path.node.name === "exports")
              path.replaceWith(t.cloneNode(exports));
          },

          AssignmentExpression(path) {
            if (
              t.isIdentifier(path.node.left, { name: "exports" }) &&
              !path.scope.getBinding("exports")
            )
              path.node.left = t.cloneNode(exports);
          }
        });

        const body = program.node.body;

        if (options.description.exportsObject) {
          body.unshift(
            t.variableDeclaration("var", [
              t.variableDeclarator(
                module,
                t.objectExpression([
                  t.objectProperty(
                    t.identifier("exports"),
                    t.objectExpression([])
                  )
                ])
              ),
              t.variableDeclarator(
                exports,
                t.memberExpression(t.cloneNode(module), t.identifier("exports"))
              )
            ])
          );

          const value = program.scope.generateUidIdentifier("cjsValue");
          body.push(
            t.variableDeclaration("const", [
              t.variableDeclarator(
                value,
                t.memberExpression(t.cloneNode(module), t.identifier("exports"))
              )
            ])
          );
          body.push(t.exportDefaultDeclaration(t.cloneNode(value)));

          for (const name of options.exportNames) {
            if (name === "default" || name === "__esModule") continue;

            const reexport = options.description.reexports.find(
              (entry) => entry.name === name
            );

            const dependency = reexport && options.imports[reexport.source];
            const exported = t.isValidIdentifier(name)
              ? t.identifier(name)
              : t.stringLiteral(name);

            const getter = options.description.localGetters.find(
              (entry) => entry.name === name
            );

            if (getter) {
              body.push(
                t.exportNamedDeclaration(null, [
                  t.exportSpecifier(t.identifier(getter.local), exported)
                ])
              );
              continue;
            }

            if (
              reexport &&
              dependency &&
              t.isValidIdentifier(reexport.imported, false) &&
              (reexport.imported !== "default" || !dependency.commonjs)
            ) {
              body.push(
                t.exportNamedDeclaration(
                  null,
                  [
                    t.exportSpecifier(t.identifier(reexport.imported), exported)
                  ],
                  t.stringLiteral(dependency.id)
                )
              );
            } else {
              const local = program.scope.generateUidIdentifier(name);
              body.push(
                t.variableDeclaration("const", [
                  t.variableDeclarator(
                    local,
                    t.memberExpression(
                      t.cloneNode(value),
                      t.stringLiteral(name),
                      true
                    )
                  )
                ])
              );
              body.push(
                t.exportNamedDeclaration(null, [
                  t.exportSpecifier(local, exported)
                ])
              );
            }
          }
        }

        body.unshift(...imports);
        program.node.sourceType = "module";
        program.scope.crawl();
        program.stop();
      }
    }
  };
}

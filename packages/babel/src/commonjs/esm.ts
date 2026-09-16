import {
  parseSync,
  traverse,
  types as t,
  type NodePath,
  type PluginObj,
  type TransformOptions
} from "@babel/core";
import { getModuleReference, isWriteTarget } from "./bindings.js";
import { isSupportedImportInterop } from "./interop.js";
import { getBoundHelperFunctions } from "../staticCssEval/cjsHelperLookup.js";
import {
  collectEsbuildHelperOperations,
  collectEsbuildModuleReplacementOperations
} from "../staticCssEval/cjsEsbuildHelpers.js";
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
  filename: string,
  parserPlugins: NonNullable<TransformOptions["parserOpts"]>["plugins"] = []
): CommonJsDescription {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: {
      sourceType: "unambiguous",
      plugins: [
        ...parserPlugins,
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
    Identifier(path) {
      if (
        (path.isReferencedIdentifier() || isWriteTarget(path)) &&
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
          const listKey = child.listKey;
          child = parent;

          return (
            (parent.isFunction() && key !== "key") ||
            ((parent.isIfStatement() || parent.isConditionalExpression()) &&
              key !== "test") ||
            (parent.isLogicalExpression() && key === "right") ||
            (parent.isAssignmentPattern() && key === "right") ||
            (parent.isAssignmentExpression() &&
              ["||=", "&&=", "??="].includes(parent.node.operator) &&
              key === "right") ||
            (parent.isOptionalCallExpression() && listKey === "arguments") ||
            (parent.isOptionalMemberExpression() && key === "property") ||
            ((parent.isClassProperty() ||
              parent.isClassPrivateProperty() ||
              parent.isClassAccessorProperty()) &&
              !parent.node.static &&
              key === "value") ||
            parent.isLoop() ||
            parent.isTryStatement() ||
            parent.isSwitchStatement()
          );
        });

        if (conditional)
          diagnostics.push(
            `Conditional or lazy require at line ${path.node.loc?.start.line ?? "unknown"}`
          );
        else if (hasEarlierSideEffects(path))
          diagnostics.push(
            `Cannot move require at line ${path.node.loc?.start.line ?? "unknown"} before earlier side effects`
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

  if (exportsObject && exportNames.has("default"))
    diagnostics.push(
      "Unsupported mixed ESM default and CommonJS exports: both require the default export"
    );

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

function hasEarlierSideEffects(path: NodePath): boolean {
  let child = path;
  for (let parent = child.parentPath; parent; parent = child.parentPath) {
    if (child.listKey && typeof child.key === "number") {
      for (const previous of child.getAllPrevSiblings())
        if (!isHoistSafe(previous)) return true;
    }

    if (
      (parent.isCallExpression() || parent.isNewExpression()) &&
      child.listKey === "arguments"
    ) {
      if (!isHoistSafe(parent.get("callee") as NodePath)) return true;
    } else if (parent.isBinaryExpression() && child.key === "right") {
      if (!isHoistSafe(parent.get("left"))) return true;
    } else if (parent.isMemberExpression() && child.key === "property") {
      if (!isHoistSafe(parent.get("object"))) return true;
    } else if (
      parent.isObjectProperty() &&
      parent.node.computed &&
      child.key === "value"
    ) {
      if (!isHoistSafe(parent.get("key"))) return true;
    } else if (parent.isAssignmentExpression() && child.key === "right") {
      const left = parent.get("left");
      if (
        left.isMemberExpression() &&
        (!isHoistSafe(left.get("object")) ||
          (left.node.computed && !isHoistSafe(left.get("property"))))
      )
        return true;
    }
    child = parent;
  }
  return false;
}

function isHoistSafe(path: NodePath<t.Node | null | undefined>): boolean {
  if (path.isObjectMethod() || path.isClassMethod())
    return !path.node.computed || isHoistSafe(path.get("key") as NodePath);
  if (
    !path.node ||
    path.isFunction() ||
    path.isIdentifier() ||
    path.isThisExpression() ||
    path.isEmptyStatement() ||
    path.isImportDeclaration() ||
    path.isExportAllDeclaration()
  )
    return true;
  if (path.isVariableDeclaration())
    return path.get("declarations").every(isHoistSafe);
  if (path.isVariableDeclarator()) {
    if (!t.isIdentifier(path.node.id)) {
      // Static import-like property reads are part of the supported CJS surface.
      // Defaults, rest, computed keys and array iterators can execute extra work.
      const init = path.get("init");
      const reference = init.node && getModuleReference(init as NodePath);
      return (
        t.isObjectPattern(path.node.id) &&
        path.node.id.properties.every(
          (property) =>
            t.isObjectProperty(property) &&
            !property.computed &&
            t.isIdentifier(property.value)
        ) &&
        reference?.kind === "require" &&
        !reference.unsafe &&
        reference.members.length === 0
      );
    }
    return (
      getBoundHelperFunctions(path.node.id.name, path.scope).length > 0 ||
      isHoistSafe(path.get("init"))
    );
  }
  if (path.isExpressionStatement()) return isHoistSafe(path.get("expression"));
  if (path.isExportNamedDeclaration())
    return !path.node.declaration || isHoistSafe(path.get("declaration"));
  if (path.isExportDefaultDeclaration())
    return isHoistSafe(path.get("declaration"));
  if (path.isCallExpression()) {
    if (getStaticCssEvalLiteralRequireImportPath(path.node, path.scope))
      return true;
    if (isSupportedImportInterop(path))
      return path.get("arguments").every(isHoistSafe);
    if (isEsbuildExportSetup(path)) return true;
    const { callee, arguments: args } = path.node;
    return (
      t.isMemberExpression(callee, { computed: false }) &&
      t.isIdentifier(callee.object, { name: "Object" }) &&
      !path.scope.getBinding("Object") &&
      t.isIdentifier(callee.property, { name: "defineProperty" }) &&
      t.isIdentifier(args[0], { name: "exports" }) &&
      !path.scope.getBinding("exports") &&
      t.isStringLiteral(args[1], { value: "__esModule" }) &&
      args.length === 3 &&
      isHoistSafe(path.get("arguments.2"))
    );
  }
  if (path.isAssignmentExpression({ operator: "=" })) {
    if (isEsbuildExportSetup(path)) return true;
    const { left } = path.node;
    return (
      t.isMemberExpression(left, { computed: false }) &&
      t.isIdentifier(left.object, { name: "exports" }) &&
      !path.scope.getBinding("exports") &&
      isHoistSafe(path.get("right"))
    );
  }
  if (path.isMemberExpression()) {
    const reference = getModuleReference(path);
    if (
      reference?.kind === "require" &&
      !reference.unsafe &&
      reference.members.length === 1 &&
      reference.members[0] !== null
    )
      return true;
    const { object, property, computed } = path.node;
    // Compiler helpers read these intrinsic references before their requires.
    if (
      !computed &&
      t.isIdentifier(object, { name: "Object" }) &&
      !path.scope.getBinding("Object") &&
      t.isIdentifier(property) &&
      [
        "create",
        "defineProperty",
        "getPrototypeOf",
        "getOwnPropertyDescriptor",
        "getOwnPropertyNames",
        "prototype"
      ].includes(property.name)
    )
      return true;
    if (
      !computed &&
      t.isIdentifier(property, { name: "hasOwnProperty" }) &&
      t.isMemberExpression(object, { computed: false }) &&
      t.isIdentifier(object.object, { name: "Object" }) &&
      t.isIdentifier(object.property, { name: "prototype" }) &&
      !path.scope.getBinding("Object")
    )
      return true;
    return (
      !computed &&
      t.isIdentifier(object, { name: "module" }) &&
      !path.scope.getBinding("module") &&
      t.isIdentifier(property, { name: "exports" })
    );
  }
  return path.isPure();
}

function isEsbuildExportSetup(
  path: NodePath<t.CallExpression | t.AssignmentExpression>
): boolean {
  const statement = path.parentPath;
  if (!statement?.isExpressionStatement() || !statement.parentPath.isProgram())
    return false;
  const state = { file: "", exportsAliasSafe: true, moduleObjectLike: true };
  const operations =
    path.isCallExpression() && path.node.arguments.length === 2
      ? collectEsbuildHelperOperations({
          expression: path.node,
          state,
          statementPath: statement
        })
      : path.isAssignmentExpression({ operator: "=" }) &&
          t.isCallExpression(path.node.right) &&
          path.node.right.arguments.length === 1
        ? collectEsbuildModuleReplacementOperations({
            declaration: statement.node,
            expression: path.node,
            scope: path.scope,
            state
          })
        : null;
  return Boolean(
    operations?.length &&
    operations.every(
      (operation) =>
        operation.kind !== "set" || operation.entry.kind !== "unsupported"
    )
  );
}

function isModuleThis(path: NodePath<t.ThisExpression>): boolean {
  let child: NodePath = path;
  return !path.findParent((parent) => {
    const key = child.key;
    child = parent;
    return (
      (parent.isFunction() &&
        !parent.isArrowFunctionExpression() &&
        key !== "key") ||
      ((parent.isClassProperty() ||
        parent.isClassPrivateProperty() ||
        parent.isClassAccessorProperty()) &&
        key === "value") ||
      parent.isStaticBlock()
    );
  });
}

/** Vite's browser runtime needs ESM; extraction itself keeps the input format. */
export function commonJsToEsmPlugin(options: CommonJsEsmOptions): PluginObj {
  return {
    name: "mincho-commonjs-to-esm",
    visitor: {
      Program(program) {
        const hasEsmSyntax = program.node.body.some(
          (statement) =>
            t.isImportDeclaration(statement) || t.isExportDeclaration(statement)
        );

        if (options.description.diagnostics.length) {
          // ESM may rely on a runtime-provided require with its original timing.
          if (hasEsmSyntax && !options.description.exportsObject) return;

          throw program.buildCodeFrameError(
            options.description.diagnostics.join("; ")
          );
        }

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
        const thisValue = program.scope.generateUidIdentifier("cjsThis");
        let usesThis = false;
        const esmExportNames = new Set<string>();
        for (const statement of program.get("body")) {
          if (statement.isExportDefaultDeclaration())
            esmExportNames.add("default");
          if (!statement.isExportNamedDeclaration()) continue;
          if (statement.node.declaration)
            for (const name of Object.keys(
              t.getOuterBindingIdentifiers(statement.node.declaration)
            ))
              esmExportNames.add(name);
          for (const specifier of statement.node.specifiers)
            esmExportNames.add(
              t.isIdentifier(specifier.exported)
                ? specifier.exported.name
                : specifier.exported.value
            );
        }
        program.traverse({
          CallExpression(path) {
            const source = getStaticCssEvalLiteralRequireImportPath(
              path.node,
              path.scope
            );

            if (source && replacements.has(source))
              path.replaceWith(t.cloneNode(replacements.get(source)!));
          },

          Identifier(path) {
            if (!path.isReferencedIdentifier() && !isWriteTarget(path)) return;
            if (path.scope.getBinding(path.node.name)) return;

            if (path.node.name === "module")
              path.replaceWith(t.cloneNode(module));
            else if (path.node.name === "exports")
              path.replaceWith(t.cloneNode(exports));
          },

          ThisExpression(path) {
            if (
              !options.description.exportsObject ||
              hasEsmSyntax ||
              !isModuleThis(path)
            )
              return;
            usesThis = true;
            path.replaceWith(t.cloneNode(thisValue));
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
              ),
              ...(usesThis
                ? [
                    t.variableDeclarator(
                      t.cloneNode(thisValue),
                      t.cloneNode(exports)
                    )
                  ]
                : [])
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
            if (
              name === "default" ||
              name === "__esModule" ||
              esmExportNames.has(name)
            )
              continue;

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

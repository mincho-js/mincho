import { types as t, type BabelFile, type NodePath } from "@babel/core";
import { collectStaticCssEvalCjsExportMapOperations } from "../staticCssEval/cjsExports.js";
import type {
  ExportMapEntry,
  ExportGraphStarReexportEntry
} from "../staticCssEval/moduleCache.js";

/** Preserve the existing CommonJS collector's ordering and helper fingerprints. */
export function commonJsExports(
  program: NodePath<t.Program>,
  filename: string
) {
  const exports = new Map<string | null, ExportMapEntry>();
  const stars: ExportGraphStarReexportEntry[] = [];

  for (const operation of collectStaticCssEvalCjsExportMapOperations({
    programPath: program,
    file: filename
  })) {
    if (operation.kind === "clear-cjs-exports") {
      exports.clear();
      stars.length = 0;
    }

    if (operation.kind === "set")
      exports.set(operation.entry.exportName, operation.entry);
    if (operation.kind === "star-reexport") stars.push(operation.entry);
  }

  return { exports, stars };
}

export function findNodePath(
  program: NodePath<t.Program>,
  node: t.Node
): NodePath<t.Node> | null {
  let found: NodePath<t.Node> | null = null;
  program.traverse({
    enter(path) {
      if (path.node === node) {
        found = path;
        path.stop();
      }
    }
  });

  return found;
}

function isTypeReference(path: NodePath<t.Node>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;
  if (
    parent.isTSTypeReference() ||
    parent.isTSExpressionWithTypeArguments() ||
    parent.isTSTypeQuery()
  )
    return true;
  if (parent.isTSQualifiedName())
    return !parent
      .findParent((ancestor) => !ancestor.isTSQualifiedName())
      ?.isTSImportEqualsDeclaration();
  return (
    parent.isExportSpecifier() &&
    (parent.node.exportKind === "type" ||
      (parent.parentPath.isExportNamedDeclaration() &&
        parent.parentPath.node.exportKind === "type"))
  );
}

function jsxPragmaBindings(
  program: NodePath<t.Program>,
  file?: BabelFile
): Set<string> {
  const pragmas = {
    jsxPragma: "React.createElement",
    jsxPragmaFrag: "React.Fragment"
  };

  // Babel resolves preset options into the transform-typescript plugin.
  for (const plugin of file?.opts.plugins ?? []) {
    if (
      typeof plugin !== "object" ||
      plugin === null ||
      !("key" in plugin) ||
      plugin.key !== "transform-typescript" ||
      !("options" in plugin) ||
      typeof plugin.options !== "object" ||
      plugin.options === null
    )
      continue;

    if (
      "jsxPragma" in plugin.options &&
      typeof plugin.options.jsxPragma === "string"
    )
      pragmas.jsxPragma = plugin.options.jsxPragma;
    if (
      "jsxPragmaFrag" in plugin.options &&
      typeof plugin.options.jsxPragmaFrag === "string"
    )
      pragmas.jsxPragmaFrag = plugin.options.jsxPragmaFrag;
  }

  const comments =
    file?.ast.comments ??
    (t.isFile(program.parent) ? program.parent.comments : undefined);

  for (const comment of comments ?? []) {
    for (const match of comment.value.matchAll(/@jsx(Frag)?\s+(\S+)/g)) {
      pragmas[match[1] ? "jsxPragmaFrag" : "jsxPragma"] = match[2];
    }
  }

  return new Set(Object.values(pragmas).map((pragma) => pragma.split(".")[0]));
}

/** TypeScript's CommonJS surface is normalized before the TypeScript preset runs. */
export function normalizeTypeScriptCommonJs(
  program: NodePath<t.Program>,
  file?: BabelFile
): void {
  let changed = false;
  let hasJsx: boolean | undefined;
  let pragmaBindings: Set<string> | undefined;

  for (const statement of program.get("body")) {
    if (
      statement.isTSImportEqualsDeclaration() &&
      t.isTSExternalModuleReference(statement.node.moduleReference)
    ) {
      if (statement.node.importKind === "type") {
        statement.remove();
        changed = true;
        continue;
      }

      const { id, moduleReference, isExport } = statement.node;
      const binding = statement.scope.getBinding(id.name);

      if (!isExport && binding?.referencePaths.every(isTypeReference)) {
        pragmaBindings ??= jsxPragmaBindings(program, file);

        // Only a pragma binding can gain an implicit reference during JSX lowering.
        if (pragmaBindings.has(id.name) && hasJsx === undefined) {
          hasJsx = false;
          program.traverse({
            "JSXElement|JSXFragment"(path) {
              hasJsx = true;
              path.stop();
            }
          });
        }
        if (!pragmaBindings.has(id.name) || !hasJsx) {
          statement.remove();
          changed = true;
          continue;
        }
      }

      const declaration = t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(id),
          t.callExpression(t.identifier("require"), [
            t.cloneNode(moduleReference.expression)
          ])
        )
      ]);

      t.inherits(declaration, statement.node);
      statement.replaceWithMultiple([
        declaration,
        ...(isExport
          ? [
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(t.identifier("exports"), t.cloneNode(id)),
                  t.cloneNode(id)
                )
              )
            ]
          : [])
      ]);
      changed = true;
    } else if (statement.isTSExportAssignment()) {
      const declaration = t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(t.identifier("module"), t.identifier("exports")),
          statement.node.expression
        )
      );

      t.inherits(declaration, statement.node);
      statement.replaceWith(declaration);
      changed = true;
    }
  }

  if (changed) program.scope.crawl();
}

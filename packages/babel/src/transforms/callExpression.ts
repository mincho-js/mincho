import type { ProgramScope } from "@/types";
import {
  extractionAPIs,
  getNearestIdentifier,
  registerImportMethod
} from "@/utils";
import { NodePath, types as t } from "@babel/core";

/**
 * Transforms a call expression to import the CSS
 * @param path - The path to transform
 */
export function transformCallExpression(path: NodePath<t.CallExpression>) {
  const callee = path.get("callee");

  // Checks if the function call is from @mincho-js/css
  if (
    !extractionAPIs.some((api) =>
      callee.referencesImport("@mincho-js/css", api)
    )
  ) {
    return;
  }

  const programParent = path.scope.getProgramParent() as ProgramScope;

  // Checks for special comments that say "mincho-js-ignore"
  if (
    path.node.leadingComments?.some(
      (comment) => comment.value.trim() === "mincho-js-ignore"
    ) ||
    path.parent.leadingComments?.some(
      (comment) => comment.value.trim() === "mincho-js-ignore"
    )
  ) {
    // Even if ignored, still collect bindings
    const bindings = getBindings(path.get("callee"));
    for (const binding of bindings) {
      programParent.minchoData.nodes.push(findRootBinding(binding).node);
    }
    return;
  }

  // Creates unique identifier for the CSS
  const nearestIdentifier = getNearestIdentifier(path);
  const identifier = nearestIdentifier
    ? programParent.generateUidIdentifier(
        `$mincho$$${nearestIdentifier.node.name}`
      )
    : programParent.generateUidIdentifier("$mincho$$unknown");

  // Register the import using the CSS file path
  const importedIdentifier = registerImportMethod(
    path,
    identifier.name,
    programParent.minchoData.cssFile
  );

  const bindings = getBindings(path);
  for (const binding of bindings) {
    programParent.minchoData.nodes.push(findRootBinding(binding).node);
  }

  // Creates an export declaration for the CSS
  programParent.minchoData.nodes.push(
    t.exportNamedDeclaration(
      t.variableDeclaration("var", [
        t.variableDeclarator(identifier, path.node)
      ])
    )
  );

  // Creates an alias for the imported identifier
  // because other transforms use the imported ident as reference
  programParent.minchoData.nodes.push(
    t.variableDeclaration("var", [
      t.variableDeclarator(importedIdentifier, identifier)
    ])
  );
  path.replaceWith(importedIdentifier);
}

/**
 * Finds the root binding of a given path
 * @param path - The path to find the root binding of
 * @returns The root binding of the given path
 */
function findRootBinding(path: NodePath<t.Node>) {
  if (!("parent" in path) || path.parentPath?.isProgram()) {
    return path;
  }

  return path.parentPath as NodePath<t.Node>;
}

/**
 * Gets the bindings of a given path
 * @param path - The path to get the bindings of
 * @returns The bindings of the given path
 */
function getBindings(path: NodePath<t.Node>) {
  const programParent = path.scope.getProgramParent() as ProgramScope;
  const bindings: Array<NodePath<t.Node>> = [];

  const processedBindings = new Set<string>();

  path.traverse({
    Expression(expressionPath) {
      if (!expressionPath.isIdentifier()) {
        return;
      }

      const binding = path.scope.getBinding(expressionPath.node.name);

      if (
        !binding ||
        processedBindings.has(binding.identifier.name) ||
        programParent.minchoData.bindings.some(
          (b) => b.node === binding.path.node
        )
      ) {
        return;
      }

      processedBindings.add(binding.identifier.name);

      const rootBinding = findRootBinding(binding.path);

      // Prevents infinite loop in cases like having arguments in a function declaration
      // If the path being checked is the same as the latest path, then the bindings will be the same
      if (path.node === rootBinding.node) {
        bindings.push(binding.path);
        return;
      }

      const bindingOfBindings = getBindings(rootBinding);
      bindings.push(...bindingOfBindings, binding.path);
    }
  });

  programParent.minchoData.bindings.push(...bindings);

  return bindings;
}

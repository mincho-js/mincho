import { NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import { collectExtractionBindings } from "./extractionBindings.js";
import {
  extractionAPIs,
  getNearestIdentifier,
  registerImportMethod
} from "../utils.js";

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
    programParent.minchoData.nodes.push(
      ...collectExtractionBindings(path.get("callee"))
    );

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

  programParent.minchoData.nodes.push(...collectExtractionBindings(path));

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

import {
  completeExtractionPublication,
  requiresExtractionPublication,
  isIgnoredExtractionCall
} from "./extractionPublication.js";
import { NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import {
  collectExtractionBindings,
  recordExtractionInitializer
} from "./extractionBindings.js";
import { getNearestIdentifier, registerImportMethod } from "../utils.js";
import {
  isExtractionCall,
  isInsideExtractCallsImplementation
} from "../extractionCalls/index.js";

/**
 * Transforms a call expression to import the CSS
 * @param path - The path to transform
 */
export function transformCallExpression(path: NodePath<t.CallExpression>) {
  if (isInsideExtractCallsImplementation(path)) return;

  const callee = path.get("callee");

  const programParent = path.scope.getProgramParent() as ProgramScope;

  // Checks for special comments that say "mincho-js-ignore"
  const ignored = isIgnoredExtractionCall(path);

  const publicationRequired = requiresExtractionPublication(
    programParent,
    path.node
  );
  if (publicationRequired && ignored)
    throw path.buildCodeFrameError(
      "Cannot ignore a compiler-required output publication."
    );
  if (!isExtractionCall(callee, !ignored)) {
    // Compiler-selected complete owners and promised publications must not
    // silently fall back to a runtime invocation after their proof is lost.
    if (
      !ignored &&
      (publicationRequired ||
        path.node.extra?.minchoEvaluationOwner === "build")
    )
      throw path.buildCodeFrameError(
        `Cannot safely extract compiler-owned build-time call ${callee.toString()}: its invocation, dependencies, or evaluation order could not be proven. Simplify the authoring expression or move it to a supported CSS module.`
      );
    return;
  }

  if (ignored) {
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
  const alias = t.variableDeclaration("var", [
    t.variableDeclarator(importedIdentifier, identifier)
  ]);
  programParent.minchoData.nodes.push(alias);
  recordExtractionInitializer(path, alias);
  const publishedCall = path.node;
  path.replaceWith(importedIdentifier);
  completeExtractionPublication(programParent, publishedCall);
}

import { NodePath, types as t } from "@babel/core";
import hash from "@emotion/hash";
import type { ProgramScope } from "../types.js";
import type { PreparedExtractCalls } from "../extractionCalls/types.js";

/**
 * Process the program before Babel applies transformations
 * @param path - The program path to process
 */
export default function preprocess(
  path: NodePath<t.Node>,
  extractCalls?: PreparedExtractCalls
) {
  // Generate a hash from the content for the CSS file name
  const source = path.toString();
  const cssFileHash = hash(
    extractCalls?.fingerprint
      ? `${source}\0${extractCalls.fingerprint}`
      : source
  );

  // Create a clean CSS file path without any null bytes
  const cssFilePath = `extracted_${cssFileHash}.css.ts`;

  // Initialize the program scope with the CSS file path
  (path.scope as ProgramScope).minchoData = {
    imports: new Map(),
    effectImports: new Set(
      t.isProgram(path.node)
        ? path.node.body.flatMap((statement) =>
            t.isImportDeclaration(statement) &&
            statement.importKind !== "type" &&
            !statement.specifiers.length
              ? [statement.source.value]
              : []
          )
        : []
    ),
    cssFile: cssFilePath,
    nodes: [],
    bindings: [],
    ...(extractCalls ? { extractCalls } : {})
  };
}

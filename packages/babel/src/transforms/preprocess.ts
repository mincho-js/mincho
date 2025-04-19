import type { ProgramScope } from "@/types.js";
import { NodePath, types as t } from "@babel/core";
import hash from "@emotion/hash";

/**
 * Process the program before Babel applies transformations
 * @param path - The program path to process
 */
export default function preprocess(path: NodePath<t.Node>) {
  // Generate a hash from the content for the CSS file name
  const cssFileHash = hash(path.toString());

  // Create a clean CSS file path without any null bytes
  const cssFilePath = `extracted_${cssFileHash}.css.ts`;

  // Initialize the program scope with the CSS file path
  (path.scope as ProgramScope).minchoData = {
    imports: new Map(),
    cssFile: cssFilePath,
    nodes: [],
    bindings: []
  };
}

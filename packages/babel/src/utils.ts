import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { addNamed } from "@babel/helper-module-imports";
import type { ProgramScope } from "./types.js";

export function invariant(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(msg);
  }
}

export function registerImportMethod(
  path: NodePath<t.Node>,
  methodName: string,
  moduleName: string = "@mincho-js/css"
) {
  const imports =
    (path.scope.getProgramParent() as ProgramScope).minchoData.imports ||
    ((path.scope.getProgramParent() as ProgramScope).minchoData.imports =
      new Map());

  if (!imports.has(`${moduleName}:${methodName}`)) {
    const id = addNamed(path, methodName, moduleName);
    imports.set(`${moduleName}:${methodName}`, id);

    return id;
  } else {
    const id = imports.get(`${moduleName}:${methodName}`) as t.Identifier;

    return t.cloneNode(id);
  }
}

/**
 * Get the nearest identifier from the current path
 * @param path - The path to search for an identifier
 * @returns The nearest identifier or null if not found
 */
export function getNearestIdentifier(path: NodePath<t.Node>) {
  let currentPath: NodePath<t.Node> = path;

  while (currentPath.parentPath !== null) {
    // Check if current path is already an identifier
    if (currentPath.isIdentifier()) {
      return currentPath;
    }

    // Check for id property (typical for declarations)
    const id = currentPath.get("id");

    if (!Array.isArray(id)) {
      if (id.isIdentifier()) {
        return id;
      }

      if (id.isArrayPattern()) {
        for (const element of id.get("elements")) {
          if (element.isIdentifier()) {
            return element;
          }
        }
      }
    }

    // Check for key property (for object properties)
    const key = currentPath.get("key");
    if (!Array.isArray(key) && key.isIdentifier()) {
      return key;
    }

    currentPath = currentPath.parentPath;
  }

  return null;
}

const vanillaExtractAPIs = [
  "style",
  "styleVariants",
  "globalStyle",
  "createTheme",
  "createGlobalTheme",
  "createThemeContract",
  "createGlobalThemeContract",
  "createVar",
  "createGlobalVar",
  "fontFace",
  "globalFontFace",
  "keyframes",
  "globalKeyframes",
  "layer",
  "globalLayer",
  "createContainer",
  "createViewTransition",
  "generateIdentifier"
];

const sprinklesUtilityAPIs = ["createNormalizeValueFn", "createMapValueFn"];

// Match both the imported binding and its source. Runtime helpers such as
// assignInlineVars, composeStyles and calls to generated recipes stay in place.
export const extractionAPIs: Readonly<Record<string, readonly string[]>> = {
  "@mincho-js/css": [
    "mincho$",
    "css",
    "globalCss",
    "rules",
    ...vanillaExtractAPIs,
    // Preserve extraction of legacy Mincho re-exports.
    "assignVars",
    "fallbackVar",
    "recipe"
  ],
  "@mincho-js/css/compat": [...vanillaExtractAPIs, "recipe"],
  "@vanilla-extract/css": vanillaExtractAPIs,
  "@vanilla-extract/recipes": ["recipe"],
  "@vanilla-extract/sprinkles": [
    "defineProperties",
    "createSprinkles",
    ...sprinklesUtilityAPIs,
    "createAtomicStyles",
    "createAtomsFn"
  ],
  "@vanilla-extract/sprinkles/createUtils": sprinklesUtilityAPIs
};

export function isExtractionCall(callee: NodePath<t.Node>): boolean {
  return Object.entries(extractionAPIs).some(([source, apis]) =>
    apis.some((api) => callee.referencesImport(source, api))
  );
}

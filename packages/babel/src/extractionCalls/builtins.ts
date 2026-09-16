import type { NodePath, types as t } from "@babel/core";

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
export const builtInExtractionCalls: Readonly<
  Record<string, readonly string[]>
> = {
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

export function isBuiltInExtractionCall(callee: NodePath<t.Node>): boolean {
  return Object.entries(builtInExtractionCalls).some(([source, apis]) =>
    apis.some((api) => callee.referencesImport(source, api))
  );
}

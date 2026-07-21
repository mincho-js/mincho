import type { StaticCssEvalBabelScope } from "./cjsHelperLookup.js";
import { getBoundHelperFunctions } from "./cjsHelperLookup.js";
import { isTscCreateBindingFunction } from "./cjsCreateBindingFingerprint.js";
import { isTscExportStarFunction } from "./cjsExportStarFingerprint.js";

export function isSupportedTscCreateBindingHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundHelperFunctions(helperName, scope);

  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isTscCreateBindingFunction(helperFunction, scope)
    )
  );
}

export function isSupportedTscExportStarHelper(
  helperName: string,
  scope: StaticCssEvalBabelScope
): boolean {
  const helperFunctions = getBoundHelperFunctions(helperName, scope);

  return (
    helperFunctions.length > 0 &&
    helperFunctions.every((helperFunction) =>
      isTscExportStarFunction(helperFunction, scope)
    )
  );
}

import type { ProgramScope } from "../types.js";

export const cssAttributeName = "css";
export const classNameAttributeName = "className";
export const cssModuleName = "@mincho-js/css";

export const fragmentTargetErrorMessage =
  "Mincho JSX css prop does not support fragments because fragments cannot receive className";
export const namespacedTargetErrorMessage =
  "Mincho JSX css prop does not support namespaced JSX elements";
export const unsupportedTargetErrorMessage =
  "Mincho JSX css prop only supports JSX identifiers and member expressions";
export const keyRefSpreadErrorMessage =
  "Mincho JSX css prop does not support key/ref on spread elements in compile-away mode";
export const spreadAggregationContextErrorMessage =
  "Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode";
export const nestedAsyncGeneratorErrorMessage =
  "Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode";
export const cssExpressionValueErrorMessage =
  "Mincho JSX css prop requires an expression value";
export const cssValueErrorMessage =
  "Mincho JSX css prop expects a Mincho CSS object/expression";
export const unsupportedFunctionCssValueErrorMessage =
  "Mincho JSX css prop does not support function values in compile-away mode";
export const unsupportedDynamicCssRuleValueErrorMessage =
  "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode";
export const unsupportedArraySpreadCssValueErrorMessage =
  "Mincho JSX css prop array values do not support spread elements in compile-away mode";
export const duplicateCssErrorMessage =
  "Mincho JSX css prop must appear only once";
export const duplicateClassNameErrorMessage =
  "Mincho JSX css prop cannot merge duplicate className attributes";
export const classNameValueErrorMessage =
  "Mincho JSX css prop requires className to be a string literal or expression";
export const cssModuleHelperImportCleanupScopes = new WeakSet<ProgramScope>();

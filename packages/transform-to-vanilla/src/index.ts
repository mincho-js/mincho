export { transform } from "./transform.js";
export {
  collectStyleDeclarations,
  type CollectStyleDeclarationsOptions,
  type CollectedStyleDeclaration,
  type ConditionAliasMap,
  type ConditionAliasValue,
  type NormalizedCondition
} from "./transform-object/declaration-collection.js";
export {
  initTransformContext,
  type TransformContext
} from "./transform-object/index.js";
export { replaceVariantReference } from "./transform-object/variant-reference.js";
export type * from "./types/style-rule.js";
export type { NonNullableString } from "./types/string.js";
export type {
  NonNullableString as StrictNonNullableString,
  NonNullableNumber as StrictNonNullableNumber
} from "@mincho-js/csstype";

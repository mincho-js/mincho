import { types as t } from "@babel/core";

// JSX quotes preserve backslashes and fold line indentation. Once the value
// becomes a JavaScript expression, it needs fresh escaping instead of JSX raw.
export function createJsxAttributeString(
  value: t.StringLiteral
): t.StringLiteral {
  return t.stringLiteral(value.value.replace(/\n\s+/g, " "));
}

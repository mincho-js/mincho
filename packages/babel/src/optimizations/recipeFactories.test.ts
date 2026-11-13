import { parseSync, types as t } from "@babel/core";
import { describe, expect, it } from "vitest";
import { isClosedCompiledRecipeInvocationArguments } from "./recipeFactories.js";

function call(source: string): t.CallExpression {
  const node = parseSync(source, { configFile: false, babelrc: false })?.program
    .body[0];
  if (!t.isExpressionStatement(node) || !t.isCallExpression(node.expression))
    throw new Error("Expected call");
  return node.expression;
}

describe("compiled recipe invocation argument obligations", () => {
  it.each([
    "recipe()",
    "recipe(void 0)",
    "recipe(null)",
    "recipe({tone:'solid', size:2, active:true})",
    "recipe(['active', {tone:'solid'}])"
  ])("accepts closed primitive selections: %s", (source) => {
    expect(isClosedCompiledRecipeInvocationArguments(call(source))).toBe(true);
  });
  it.each([
    "recipe({tone})",
    "recipe({get tone(){return 'solid'}})",
    "recipe({tone:{toString(){return 'solid'}}})",
    "recipe({...options})",
    "recipe({tone:read()})",
    "recipe(...options)",
    "recipe({}, observe())",
    "recipe({[key]:'solid'})",
    "recipe({__proto__: {tone:'solid'}})"
  ])("retains unknown input effects: %s", (source) => {
    expect(isClosedCompiledRecipeInvocationArguments(call(source))).toBe(false);
  });
});

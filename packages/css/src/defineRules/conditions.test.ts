/// <reference types="node" />
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { normalizeDefineRulesConditionValue } from "./conditions.js";

describe("condition objects across compiler VM realms", () => {
  it("accepts plain and null-prototype records from another realm", () => {
    for (const expression of [
      '({selector:"&:hover"})',
      'Object.assign(Object.create(null), {selector:"&:hover"})'
    ]) {
      expect(
        normalizeDefineRulesConditionValue(runInNewContext(expression))
      ).toEqual({ selector: "&:hover" });
    }
  });

  it("rejects class instances and custom prototypes without invoking constructor getters", () => {
    for (const expression of [
      'new (class Condition {selector="&:hover"})()',
      'Object.create({selector:"&:hover"})',
      "Object.create(Object.assign(Object.create(null), {constructor:Object}))",
      'Object.create(Object.defineProperty(Object.create(null), "constructor", {get(){throw new Error("getter invoked")}}))'
    ]) {
      expect(() =>
        normalizeDefineRulesConditionValue(runInNewContext(expression))
      ).toThrow("Unsupported defineRules condition value");
    }
  });
});

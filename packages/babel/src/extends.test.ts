/// <reference types="node" />

import { transformSync } from "@babel/core";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { minchoBabelPlugin } from "./index.js";
import type { PluginOptions } from "./types.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore This test runs as ESM; ignore import.meta for CJS declaration emission.
const typescriptPreset = createRequire(import.meta.url).resolve(
  "@babel/preset-typescript"
);

function transform(source: string, optimize = false) {
  const options: PluginOptions = {
    result: ["", ""],
    optimize: { defineRulesCxConditions: optimize }
  };
  const output = transformSync(source, {
    filename: "extends.ts",
    plugins: [[minchoBabelPlugin(), options]],
    presets: [typescriptPreset]
  });
  return {
    code: output?.code ?? "",
    css: options.result[1],
    metadata: output?.metadata
  };
}

describe("extension calls", () => {
  it.each([
    [
      'const { rules } = require("@mincho-js/css");',
      'rules.extends(parent, { color: "blue" })'
    ],
    [
      'const mincho = require("@mincho-js/css");',
      'mincho.rules["extends"](parent, { color: "blue" })'
    ],
    [
      'import { rules } from "@mincho-js/css";',
      'rules.extends(parent, { color: "blue" })'
    ],
    [
      'import { rules as recipe } from "@mincho-js/css";',
      'recipe.extends(parent, { color: "blue" })'
    ],
    [
      'import * as mincho from "@mincho-js/css";',
      'mincho.rules.extends(parent, { color: "blue" })'
    ],
    [
      'import { rules } from "@mincho-js/css"; const custom = rules.with<{ color: string }>((style) => style);',
      'custom.extends(parent, { color: "blue" })'
    ],
    [
      'import { rules } from "@mincho-js/css"; const custom = rules.with((style) => style); const alias = custom;',
      'alias.extends(parent, { color: "blue" })'
    ]
  ])("extracts %s %s", (setup, call) => {
    const output = transform(
      `${setup}\nimport { parent } from "@test/parent";\nexport const child = ${call};`
    );
    expect(output.css.replace(/\s+/g, "")).toContain(call.replace(/\s+/g, ""));
    expect(output.css).toContain('from "@test/parent"');
    expect(output.code.replace(/\s+/g, "")).not.toContain(
      call.replace(/\s+/g, "")
    );
    expect(output.code).toContain("extracted_");
  });

  it("preserves parent-before-child authoring dependencies", () => {
    const output = transform(`
      import { rules } from "@mincho-js/css";
      const parent = rules({ color: "red" });
      export const child = rules.extends(parent, { color: "blue" });
    `);
    expect(output.css.indexOf('color: "red"')).toBeLessThan(
      output.css.indexOf('color: "blue"')
    );
    expect(output.code).not.toContain("rules.extends");
  });

  it("extracts typed parent creation before extending it through the same handle", () => {
    const output = transform(`
      import { rules } from "@mincho-js/css";
      const custom = rules.with<{ color: string }>((style) => style);
      export const parent = custom({ color: "red" });
      export const child = custom.extends(parent, { color: "blue" });
    `);
    expect(output.code).not.toContain("custom(");
    expect(output.code).not.toContain("custom.extends(");
    expect(output.css.indexOf('color: "red"')).toBeLessThan(
      output.css.indexOf('color: "blue"')
    );
  });

  it("leaves unrelated and shadowed extends methods alone", () => {
    const output = transform(`
      import { rules } from "@mincho-js/css";
      const unrelated = { extends(value) { return value; } };
      export const plain = unrelated.extends("value");
      export function shadowed(rules) { return rules.extends("value"); }
    `);
    expect(output.code).toContain('unrelated.extends("value")');
    expect(output.code).toContain('rules.extends("value")');
    expect(output.css).not.toContain("extends(");
  });
});

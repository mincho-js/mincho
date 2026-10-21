import { expect, it } from "vitest";
import type { InternalVanillaCssArtifact } from "@mincho-js/integration";
import { CssIrAggregation } from "./cssIrAggregation.js";

it("invalidates resource cycles after removal and reconnects re-added owners", () => {
  const data = (
    selector: string,
    vars: Record<string, string>
  ): InternalVanillaCssArtifact => ({
    origin: selector,
    fileScope: { filePath: selector, packageName: "test" },
    localClassNames: [selector],
    composedClassLists: [],
    usedCompositions: [],
    cssObjs: [{ type: "local", selector, rule: { vars } }]
  });

  const graph = new CssIrAggregation();
  const input = new Map([
    ["a", data("a", { "--a": "var(--b)" })],
    ["b", data("b", { "--b": "var(--c)" })],
    ["c", data("c", { "--c": "var(--a)" })],
    ["leaf", data("leaf", { "--leaf": "red" })]
  ]);

  const initial = graph.update(input);

  expect(initial).toEqual([["a", "b", "c"], ["leaf"]]);
  expect(graph.update(input)).toBe(initial);

  const b = input.get("b")!;
  input.delete("b");
  input.delete("c");

  expect(graph.update(input)).toEqual([["a"], ["leaf"]]);

  input.set("b", b);

  expect(graph.update(input)).toEqual([["a", "b"], ["leaf"]]);

  input.set("leaf", {
    ...input.get("leaf")!,
    provenance: {
      version: 1,
      publicReferences: [],
      generatedVariables: [],
      opaque: false,
      resources: {
        version: 2,
        recipes: [],
        themes: [],
        keyframes: [],
        publicKeyframes: [],
        recipeUses: [{ id: "leaf", used: ["a"] }]
      }
    }
  });

  expect(graph.update(input)).toEqual([["a", "b", "leaf"]]);

  graph.clear();

  expect(graph.update(new Map())).toEqual([]);
});

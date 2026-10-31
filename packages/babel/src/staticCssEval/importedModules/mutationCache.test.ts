import { describe, expect, it, vi } from "vitest";
import * as references from "./localReference.js";
import { ImportedStaticCssEvalResolver } from "./resolver.js";

function resolver(mutated: boolean) {
  const sources = {
    "/owner.tsx":
      'import { a } from "/a.ts"; import { b } from "/b.ts"; import "/mutator.ts";',
    "/a.ts": 'export const a = { color: "red" };',
    "/b.ts": 'export const b = { color: "blue" };',
    "/barrel.ts": 'export { a } from "/a.ts"; export { b } from "/b.ts";',
    "/mutator.ts":
      'import * as shared from "/barrel.ts";' +
      (mutated ? 'shared.a.color = "green";' : "void shared;")
  };
  return new ImportedStaticCssEvalResolver({
    modules: Object.entries(sources).map(([id, source]) => ({
      id,
      source
    })),
    importResolutions: []
  });
}

function resolveBoth(instance: ImportedStaticCssEvalResolver) {
  return ["a", "b"].map((bindingName) =>
    instance.resolve({
      importerId: "/owner.tsx",
      bindingName,
      memberPath: ["color"],
      expressionStart: 0,
      expressionEnd: 1
    })
  );
}

describe("imported mutation analysis reuse", () => {
  it.each([false, true])(
    "analyses a shared binding once across dependency sets (mutated: %s)",
    (mutated) => {
      const analysis = vi.spyOn(
        references,
        "hasImportedStaticCssBindingMutation"
      );
      try {
        const results = resolveBoth(resolver(mutated));
        expect(results).toMatchObject(
          mutated
            ? ["a", "b"].map(() => ({
                kind: "error",
                diagnostic: { reason: "mutated-binding" }
              }))
            : [
                { kind: "resolved", value: "red" },
                { kind: "resolved", value: "blue" }
              ]
        );
        expect(
          analysis.mock.calls.filter(
            ([record, name]) => record.id === "/mutator.ts" && name === "shared"
          )
        ).toHaveLength(1);
      } finally {
        analysis.mockRestore();
      }
    }
  );

  it("rechecks bindings when a new resolver receives changed source", () => {
    expect(resolveBoth(resolver(false)).map(({ kind }) => kind)).toEqual([
      "resolved",
      "resolved"
    ]);
    expect(resolveBoth(resolver(true)).map(({ kind }) => kind)).toEqual([
      "error",
      "error"
    ]);
  });
});

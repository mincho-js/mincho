import { describe, expect, it } from "vitest";
import { createDefineRulesCxRuntime } from "./createDefineRulesCxRuntime.js";

describe("defineRules cx runtime", () => {
  it("preserves prototype-inherited tokens as unknown", () => {
    const runtimeWithSegments = createDefineRulesCxRuntime({
      classWrites: [],
      segments: []
    });
    const runtimeWithoutSegments = createDefineRulesCxRuntime({
      classWrites: []
    });

    expect(runtimeWithSegments("toString toString")).toBe("toString toString");
    expect(runtimeWithoutSegments("__proto__ __proto__")).toBe(
      "__proto__ __proto__"
    );
  });

  it("preserves inherited marker payload write IDs as unknown", () => {
    const runtime = createDefineRulesCxRuntime({
      classWrites: [["owned", 1]],
      segments: [["marker", [1]]]
    });

    expect(runtime("marker inherited owned")).toBe("marker inherited owned");
  });

  it("resolves registered prototype-like class names", () => {
    const runtime = createDefineRulesCxRuntime({
      classWrites: [
        ["__proto__", 1],
        ["owned", 1]
      ]
    });

    expect(runtime("__proto__ owned")).toBe("owned");
  });

  it("restores markers after resolving duplicate writes", () => {
    const runtime = createDefineRulesCxRuntime({
      classWrites: [
        ["first", 1],
        ["last", 1],
        ["other", 2]
      ],
      segments: [["marker", [2, 1]]]
    });

    expect(runtime("marker other first last")).toBe("marker other last");
  });

  it("selects a canonical marker for equivalent write sequences", () => {
    const runtime = createDefineRulesCxRuntime({
      classWrites: [["owned", 1]],
      segments: [
        ["second", [1]],
        ["first", [1]]
      ]
    });

    expect(runtime("owned")).toBe("first owned");
  });
});

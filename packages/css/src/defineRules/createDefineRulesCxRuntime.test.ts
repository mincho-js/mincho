import { describe, expect, it } from "vitest";
import {
  createCompiledDefineRulesCxRuntime,
  createDefineRulesCxRuntime
} from "./createDefineRulesCxRuntime.js";

describe.each([
  ["direct", createDefineRulesCxRuntime],
  ["compiled", createCompiledDefineRulesCxRuntime]
] as const)(
  "%s defineRules cx runtime",
  (_name, createDefineRulesCxRuntime) => {
    it("preserves prototype-inherited tokens as unknown", () => {
      const runtimeWithSegments = createDefineRulesCxRuntime({
        classWrites: [],
        segments: []
      });

      const runtimeWithoutSegments = createDefineRulesCxRuntime({
        classWrites: []
      });

      expect(runtimeWithSegments("toString toString")).toBe(
        "toString toString"
      );
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

    it("preserves unknown token positions and duplicate classes on repeated calls", () => {
      const runtime = createDefineRulesCxRuntime({
        classWrites: [
          ["first", 1],
          ["last", 1],
          ["other", 2]
        ],
        segments: [["marker", [2, 1]]]
      });

      for (let iteration = 0; iteration < 2; iteration += 1) {
        expect(runtime("external marker other first last external")).toBe(
          "external other last external"
        );
        expect(runtime("marker other first external marker other last")).toBe(
          "external other last"
        );
        expect(runtime("marker other last")).toBe("marker other last");
        expect(runtime("marker first other")).toBe("marker first other");
        expect(runtime("marker other")).toBe("marker other");
        expect(runtime("marker")).toBe("marker");
      }
    });

    it("still evaluates clsx getters and with callbacks on cache hits", () => {
      const runtime = createDefineRulesCxRuntime({
        classWrites: [["owned", 1]]
      });

      let reads = 0;
      const value = {
        get owned() {
          reads += 1;

          return true;
        }
      };

      expect(runtime(value)).toBe("owned");
      expect(runtime(value)).toBe("owned");
      expect(reads).toBe(2);

      let calls = 0;
      const mapped = runtime.with((enabled: boolean) => {
        calls += 1;

        return { owned: enabled };
      });

      expect(mapped(true)).toBe("owned");
      expect(mapped(true)).toBe("owned");
      expect(calls).toBe(2);
    });

    it("handles empty, whitespace, large, and prototype-like cache keys", () => {
      const runtime = createDefineRulesCxRuntime({
        classWrites: [["owned", 1]]
      });

      expect(runtime("")).toBe("");
      expect(runtime(" \n\t ")).toBe("");
      expect(runtime("owned\towned\nowned")).toBe("owned");
      expect(runtime("__proto__ toString constructor")).toBe(
        "__proto__ toString constructor"
      );

      const external = "x".repeat(5000);

      expect(runtime(external, "owned owned")).toBe(`${external} owned`);
    });
  }
);

it("prepares compiled indexes only on first use", () => {
  let reads = 0;
  const runtime = createCompiledDefineRulesCxRuntime({
    get classWrites() {
      reads += 1;

      return [["owned", 1]] as const;
    }
  });

  expect(reads).toBe(0);
  expect(runtime("owned")).toBe("owned");
  expect(reads).toBe(1);
  expect(runtime("owned")).toBe("owned");
  expect(reads).toBe(1);
});

it("keeps direct factory index snapshots and mutable segment behavior", () => {
  const classWrites: [string, number][] = [
    ["first", 1],
    ["other", 2]
  ];

  const writes = [1];
  const runtime = createDefineRulesCxRuntime({
    classWrites,
    segments: [["marker", writes]]
  });

  classWrites.push(["last", 1]);

  expect(runtime("last first")).toBe("last first");
  expect(runtime("marker first")).toBe("marker first");

  writes[0] = 2;

  expect(runtime("marker other")).toBe("other");
});

it("matches direct merging across cache eviction and mixed marker payloads", () => {
  const artifact = {
    classWrites: [
      ["first", 1],
      ["last", 1],
      ["other", 2]
    ] as const,
    segments: [["marker", [2, 1]]] as const
  };

  const direct = createDefineRulesCxRuntime(artifact);
  const compiled = createCompiledDefineRulesCxRuntime(artifact);
  const tokens = [
    "",
    "marker",
    "first",
    "last",
    "other",
    "__proto__",
    "external"
  ];

  for (const first of tokens) {
    for (const second of tokens) {
      for (const third of tokens) {
        const input = `${first} ${second} ${third}`;

        expect(compiled(input)).toBe(direct(input));
      }
    }
  }

  for (let index = 0; index < 300; index += 1) {
    const input = `external-${index} marker other first last`;

    expect(compiled(input)).toBe(direct(input));
  }

  expect(compiled("marker other first last")).toBe(
    direct("marker other first last")
  );
});

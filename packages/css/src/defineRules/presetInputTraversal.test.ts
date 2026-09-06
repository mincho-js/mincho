import { describe, expect, it } from "vitest";
import { defineRules } from "./index.js";
import { createDefineRulesPresetArtifactV5 } from "./presetArtifact.js";
import {
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import type { DefineRulesPresetInput } from "./types.js";

function preset(name: string) {
  const node = createDefineRulesPresetNodeV5({
    origin: createPresetOriginId({
      packageName: `@test/${name}`,
      producerPath: "rules.css.ts",
      registrationIndex: 0
    }),
    parents: [],
    atoms: [
      {
        cacheKey: "color:red",
        className: name,
        property: "color",
        condition: {
          layer: null,
          supports: null,
          media: null,
          container: null,
          selector: "&"
        }
      }
    ]
  });

  return createDefineRulesPresetArtifactV5({
    rootNodeId: node.nodeId,
    nodes: [node]
  });
}

function consume(presets: DefineRulesPresetInput) {
  return defineRules({ properties: {}, presets });
}

function classes(value: string) {
  return value
    .split(/\s+/)
    .filter((token) => !token.startsWith("__mincho_seg_"))
    .join(" ");
}

describe("preset input array traversal", () => {
  it.each([5_000, 10_000])(
    "consumes %i nested arrays through defineRules",
    (depth) => {
      const parent = preset("deep");
      let input: DefineRulesPresetInput = parent;

      for (let index = 0; index < depth; index++) input = [input];

      const owner = consume(input);
      const snapshot = owner.preset;

      expect(snapshot.nodes).toHaveLength(2);
      expect(
        snapshot.nodes.find((node) => node.nodeId === snapshot.rootNodeId)
          ?.parents
      ).toEqual([parent.rootNodeId]);
    }
  );

  it("reports direct and indirect array cycles with the input path", () => {
    const direct: DefineRulesPresetInput[] = [];
    direct.push(direct);

    const indirect: DefineRulesPresetInput[] = [];
    indirect.push([preset("before"), indirect]);

    for (const [input, path] of [
      [direct, "presets[0]"],
      [indirect, "presets[0][1]"]
    ] as const) {
      expect(() => consume(input)).toThrow(
        new TypeError(
          `Invalid defineRules presets: array cycle detected at ${path}`
        )
      );
    }
  });

  it("preserves repeated arrays, sparse entries and first-visit parent precedence", () => {
    const b = preset("b_red");
    const c = preset("c_red");
    const repeated = [b];
    const input: DefineRulesPresetInput[] = [repeated, [c], repeated];
    input.length = 5;

    const owner = consume(input);
    const snapshot = owner.preset;

    expect(
      snapshot.nodes.find((node) => node.nodeId === snapshot.rootNodeId)
        ?.parents
    ).toEqual([b.rootNodeId, c.rootNodeId, b.rootNodeId]);
    expect(classes(owner.cx("b_red", "c_red"))).toBe("c_red");
    expect(classes(owner.cx("c_red", "b_red"))).toBe("b_red");
  });
});

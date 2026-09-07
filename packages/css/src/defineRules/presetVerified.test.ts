import { describe, expect, it, vi } from "vitest";
import { defineRules } from "./index.js";
import {
  createDefineRulesPresetArtifactV5,
  parseDefineRulesPresetArtifactV5
} from "./presetArtifact.js";
import {
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";

function artifact() {
  const node = createDefineRulesPresetNodeV5({
    origin: createPresetOriginId({
      packageName: "@test/verified",
      producerPath: "rules.css.ts",
      registrationIndex: 0
    }),
    parents: [],
    atoms: [
      {
        cacheKey: "color:red",
        className: "parent_red",
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

describe("verified preset reuse", () => {
  it("reuses only normalized outputs and preserves immutable ancestor nodes in snapshots", () => {
    const parent = artifact();

    expect(parseDefineRulesPresetArtifactV5(parent)).toBe(parent);

    const child = defineRules({ properties: {}, presets: parent });
    const inherited = child.preset.nodes.find(
      (node) => node.nodeId === parent.rootNodeId
    );

    expect(inherited).toBe(parent.nodes[0]);

    for (const value of [
      parent,
      parent.nodes,
      inherited,
      inherited?.parents,
      inherited?.atoms,
      inherited?.atoms[0],
      inherited?.atoms[0]?.condition
    ])
      expect(Object.isFrozen(value)).toBe(true);

    expect(child.cx("external", "parent_red")).toContain("external");
    expect(child.cx("parent_red")).toContain("parent_red");
  });

  it("does not trust caller objects after an earlier successful parse", () => {
    const input = JSON.parse(JSON.stringify(artifact()));
    const parsed = parseDefineRulesPresetArtifactV5(input);

    expect(parsed).not.toBe(input);

    input.nodes[0].atoms[0].className = "tampered";

    expect(parsed.nodes[0]?.atoms[0]?.className).toBe("parent_red");
    expect(() => parseDefineRulesPresetArtifactV5(input)).toThrow(
      "claimed node hashes"
    );
    expect(() => resolveDefineRulesPresetGraphV5([input])).toThrow(
      "claimed node hashes"
    );
  });

  it("does not infer trust from frozen objects or claimed IDs", () => {
    const original = artifact();
    const validCopy = Object.freeze({ ...original });

    expect(parseDefineRulesPresetArtifactV5(validCopy)).not.toBe(validCopy);

    const altered = Object.freeze({
      ...original,
      nodes: Object.freeze(
        original.nodes.map((node) =>
          Object.freeze({
            ...node,
            contentHash: "0".repeat(64) as typeof node.contentHash
          })
        )
      )
    });

    expect(() => parseDefineRulesPresetArtifactV5(altered)).toThrow(
      "claimed node hashes"
    );
    expect(() => resolveDefineRulesPresetGraphV5([altered])).toThrow(
      "claimed node hashes"
    );
  });

  it("validates immutable artifacts arriving from another module instance", async () => {
    const original = artifact();
    vi.resetModules();

    const other = await import("./presetArtifact.js");
    const parsed = other.parseDefineRulesPresetArtifactV5(original);

    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(other.parseDefineRulesPresetArtifactV5(parsed)).toBe(parsed);
  });
});

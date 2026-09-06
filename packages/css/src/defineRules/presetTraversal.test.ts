import { beforeAll, describe, expect, it } from "vitest";
import { defineRules } from "./index.js";
import { parseDefineRulesPresetArtifactV5 } from "./presetArtifact.js";
import {
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";
import type { DefineRulesPresetArtifactV5 } from "./types.js";

function createChain(size: number): DefineRulesPresetArtifactV5 {
  const nodes: DefineRulesPresetArtifactV5["nodes"][number][] = [];

  for (let index = 0; index < size; index++) {
    nodes.push(
      createDefineRulesPresetNodeV5({
        origin: createPresetOriginId({
          packageName: `@mincho-js/deep-${index}`,
          producerPath: "src/rules.css.ts",
          registrationIndex: 0
        }),
        parents: index === 0 ? [] : [nodes[index - 1].nodeId],
        atoms:
          index === 0 || index === size - 1
            ? [
                {
                  cacheKey: "color:red",
                  className: `deep_color_${index}`,
                  condition: {
                    layer: null,
                    supports: null,
                    media: null,
                    container: null,
                    selector: "&"
                  },
                  property: "color"
                }
              ]
            : []
      })
    );
  }

  return {
    schema: "mincho.defineRulesPreset",
    version: 5,
    rootNodeId: nodes[size - 1].nodeId,
    nodes
  };
}

describe.each([5_000, 10_000])("V5 preset chains with %i nodes", (size) => {
  let artifact: DefineRulesPresetArtifactV5;

  beforeAll(() => {
    artifact = createChain(size);
  });

  it("parses a deep imported artifact without exhausting the call stack", () => {
    const parsed = parseDefineRulesPresetArtifactV5(artifact);

    expect(parsed.rootNodeId).toBe(artifact.rootNodeId);
    expect(parsed.nodes).toHaveLength(size);
    expect(parsed.nodes[0]).toEqual(artifact.nodes[0]);
    expect(parsed.nodes[size - 1]).toEqual(artifact.nodes[size - 1]);
    expect(Object.isFrozen(parsed.nodes)).toBe(true);
  });

  it("merges ancestors before descendants and retains historical classes", () => {
    const graph = resolveDefineRulesPresetGraphV5([artifact]);
    const first = artifact.nodes[0].atoms[0];
    const last = artifact.nodes[size - 1].atoms[0];

    expect(graph.producerOrigins).toEqual(
      artifact.nodes.map((node) => node.origin)
    );
    expect(graph.styleOrigins).toHaveLength(size);
    expect(graph.atomById.get(first.atomId)).toEqual(last);
    expect([...graph.atomIdByClassName]).toEqual([
      [first.className, first.atomId],
      [last.className, last.atomId]
    ]);
  });

  it("consumes the deep artifact through public defineRules presets", () => {
    const owner = defineRules({ properties: {}, presets: [[artifact]] });
    const snapshot = owner.preset;
    const root = snapshot.nodes.find(
      (node) => node.nodeId === snapshot.rootNodeId
    );

    expect(snapshot.nodes).toHaveLength(size + 1);
    expect(root?.parents).toEqual([artifact.rootNodeId]);
    expect(new Set(snapshot.nodes.map((node) => node.nodeId)).size).toBe(
      size + 1
    );
  });

  it("diagnoses a cycle at the deepest ancestor before checking hashes", () => {
    const cyclic = {
      ...artifact,
      nodes: artifact.nodes.map((node, index) =>
        index === 0 ? { ...node, parents: [artifact.rootNodeId] } : node
      )
    };

    for (const run of [
      () => parseDefineRulesPresetArtifactV5(cyclic),
      () => resolveDefineRulesPresetGraphV5([cyclic])
    ]) {
      let error: unknown;

      try {
        run();
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("cycle detected");
      expect((error as Error).message).toContain(artifact.nodes[0].origin);
      expect((error as Error).message.match(/\.parents\[0\]/g)).toHaveLength(
        size
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";
import { createDefineRulesPresetArtifactV5 } from "./presetArtifact.js";
import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";

const condition = {
  layer: null,
  supports: null,
  media: null,
  container: null,
  selector: "&"
} as const;

function origin(name: string) {
  return createPresetOriginId({
    packageName: `@mincho-js/${name}`,
    producerPath: `src/${name}.css.ts`,
    registrationIndex: 0
  });
}

function atom(cacheKey: string, className: string, property = "color") {
  return createDefineRulesPresetAtomV5({
    cacheKey,
    className,
    condition,
    property
  });
}

function node(input: Parameters<typeof createDefineRulesPresetNodeV5>[0]) {
  return createDefineRulesPresetNodeV5(input);
}

function artifact(
  rootNodeId: ReturnType<typeof node>["nodeId"],
  nodes: readonly ReturnType<typeof node>[]
) {
  return createDefineRulesPresetArtifactV5({ rootNodeId, nodes });
}

describe("V5 preset graph", () => {
  it("applies a diamond root-first, selects the later root, and preserves every valid class", () => {
    const aAtom = atom("color:red", "a_color");
    const bAtom = atom("color:red", "b_color");
    const cAtom = atom("color:red", "c_color");
    const a = node({ origin: origin("a"), parents: [], atoms: [aAtom] });
    const b = node({
      origin: origin("b"),
      parents: [a.nodeId],
      atoms: [bAtom]
    });
    const c = node({
      origin: origin("c"),
      parents: [a.nodeId],
      atoms: [cAtom]
    });
    const bPreset = artifact(b.nodeId, [a, b]);
    const cPreset = artifact(c.nodeId, [a, c]);
    const snapshot = JSON.stringify([bPreset, cPreset]);

    const graph = resolveDefineRulesPresetGraphV5([bPreset, cPreset]);

    expect(graph.atomById.get(aAtom.atomId)).toEqual(cAtom);
    expect([...graph.atomIdByClassName]).toEqual([
      ["a_color", aAtom.atomId],
      ["b_color", bAtom.atomId],
      ["c_color", cAtom.atomId]
    ]);
    expect(graph.producerOrigins).toEqual([a.origin, b.origin, c.origin]);
    expect(graph.styleOrigins).toEqual([
      "@mincho-js/a",
      "@mincho-js/b",
      "@mincho-js/c"
    ]);
    expect(JSON.stringify([bPreset, cPreset])).toBe(snapshot);
    expect([
      ...resolveDefineRulesPresetGraphV5([bPreset, cPreset]).atomById
    ]).toEqual([...graph.atomById]);
  });

  it("selects B when roots are ordered C then B", () => {
    const aAtom = atom("color:red", "a_color");
    const bAtom = atom("color:red", "b_color");
    const cAtom = atom("color:red", "c_color");
    const a = node({ origin: origin("a"), parents: [], atoms: [aAtom] });
    const b = node({
      origin: origin("b"),
      parents: [a.nodeId],
      atoms: [bAtom]
    });
    const c = node({
      origin: origin("c"),
      parents: [a.nodeId],
      atoms: [cAtom]
    });

    const graph = resolveDefineRulesPresetGraphV5([
      artifact(c.nodeId, [a, c]),
      artifact(b.nodeId, [a, b])
    ]);

    expect(graph.atomById.get(aAtom.atomId)).toEqual(bAtom);
  });

  it("rejects cycles, dangling and malformed parents with traversal paths", () => {
    const rootAtom = atom("color:red", "root_color");
    const root = node({
      origin: origin("root"),
      parents: [],
      atoms: [rootAtom]
    });
    const preset = artifact(root.nodeId, [root]);
    const cycle = {
      ...preset,
      nodes: preset.nodes.map((record) => ({
        ...record,
        parents: [record.nodeId]
      }))
    };
    const missing = node({
      origin: origin("missing"),
      parents: [],
      atoms: []
    });
    const danglingRoot = node({
      origin: origin("dangling"),
      parents: [missing.nodeId],
      atoms: []
    });
    const danglingSource = artifact(danglingRoot.nodeId, [
      missing,
      danglingRoot
    ]);
    const dangling = {
      ...danglingSource,
      nodes: danglingSource.nodes.filter(
        (record) => record.nodeId !== missing.nodeId
      )
    };
    const malformed = {
      ...preset,
      nodes: preset.nodes.map((record) => ({ ...record }))
    };
    Reflect.set(malformed.nodes[0], "parents", "not-an-array");

    expect(() => resolveDefineRulesPresetGraphV5([cycle])).toThrow(
      `${root.origin}.parents[0]`
    );
    expect(() => resolveDefineRulesPresetGraphV5([dangling])).toThrow(
      `${danglingRoot.origin}.parents[0]`
    );
    expect(() => resolveDefineRulesPresetGraphV5([malformed])).toThrow(
      `${root.origin}.parents`
    );
  });

  it("rejects revisions, class conflicts, and claimed atom IDs", () => {
    const sameOrigin = origin("revision");
    const first = node({
      origin: sameOrigin,
      parents: [],
      atoms: [atom("color:red", "first_color")]
    });
    const second = node({
      origin: sameOrigin,
      parents: [],
      atoms: [atom("color:blue", "second_color")]
    });
    const classA = node({
      origin: origin("class-a"),
      parents: [],
      atoms: [atom("color:red", "shared_class")]
    });
    const classB = node({
      origin: origin("class-b"),
      parents: [],
      atoms: [atom("color:blue", "shared_class")]
    });
    const valid = artifact(first.nodeId, [first]);
    const otherAtom = atom("display:flex", "display_flex", "display");
    const invalidAtom = {
      ...valid,
      nodes: valid.nodes.map((record) => ({
        ...record,
        atoms: record.atoms.map((recordAtom) => ({
          ...recordAtom,
          atomId: otherAtom.atomId
        }))
      }))
    };

    expect(() =>
      resolveDefineRulesPresetGraphV5([
        artifact(first.nodeId, [first]),
        artifact(second.nodeId, [second])
      ])
    ).toThrow(sameOrigin);
    expect(() =>
      resolveDefineRulesPresetGraphV5([
        artifact(classA.nodeId, [classA]),
        artifact(classB.nodeId, [classB])
      ])
    ).toThrow("shared_class");
    expect(() => resolveDefineRulesPresetGraphV5([invalidAtom])).toThrow(
      `${first.origin}.atoms[0]`
    );
  });
});

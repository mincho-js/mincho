import { describe, expect, it } from "vitest";
import {
  createDefineRulesPresetArtifactV5,
  parseDefineRulesPresetArtifactV5
} from "./presetArtifact.js";
import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId,
  parsePresetOriginId
} from "./presetCanonical.js";
import { defineRules } from "./index.js";
import type {
  DefineRulesEmptyConditions,
  DefineRulesPresetArtifactV5,
  DefineRulesPresetInput
} from "./types.js";

const condition = {
  layer: null,
  supports: null,
  media: null,
  container: null,
  selector: "&"
} as const;
const origin = createPresetOriginId({
  packageName: "@scope/provider",
  producerPath: "src/styles.css.ts",
  registrationIndex: 0
});
const atom = createDefineRulesPresetAtomV5({
  cacheKey: "color:red",
  className: "provider_color_red",
  condition,
  property: "color"
});

describe("V5 preset artifact", () => {
  it("creates an immutable V5 snapshot with final canonical hashes", () => {
    const node = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const artifact = createDefineRulesPresetArtifactV5({
      rootNodeId: node.nodeId,
      nodes: [node]
    });
    const snapshot = createDefineRulesPresetArtifactV5(artifact);
    const parsedSnapshot = parseDefineRulesPresetArtifactV5(snapshot);

    expect(parsedSnapshot).toEqual(snapshot);
    for (const value of [
      snapshot,
      snapshot.nodes,
      snapshot.nodes[0],
      snapshot.nodes[0].atoms,
      snapshot.nodes[0].atoms[0],
      snapshot.nodes[0].atoms[0].condition,
      parsedSnapshot.nodes[0].parents
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(snapshot.nodes, 0, snapshot.nodes[0])).toBe(false);
    expect(Reflect.set(parsedSnapshot.nodes[0].parents, 0, node.nodeId)).toBe(
      false
    );
  });

  it("rejects V3, V4, maps, malformed references, and unsupported V5 shapes", () => {
    const node = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const valid = createDefineRulesPresetArtifactV5({
      rootNodeId: node.nodeId,
      nodes: [node]
    });
    const cyclic = {
      ...valid,
      nodes: valid.nodes.map((entry) => ({
        ...entry,
        parents: [entry.nodeId]
      }))
    };
    const custom = { ...valid };
    Object.setPrototypeOf(custom, { corrupt: true });
    const cases = [
      [
        {
          schema: "mincho.defineRulesPreset",
          version: 3,
          classNameByCache: {}
        },
        "Invalid defineRules preset at $.version: expected defineRules preset version 5"
      ],
      [
        {
          schema: "mincho.defineRulesPreset",
          version: 4,
          classNameByCache: {}
        },
        "Invalid defineRules preset at $.version: expected defineRules preset version 5"
      ],
      [
        { colorRed: "color_red" },
        "Invalid defineRules preset at $.schema: expected defineRules preset schema"
      ],
      [
        { ...valid, rootNodeId: "0".repeat(64) },
        "Invalid defineRules preset at $: Missing defineRules preset root node"
      ],
      [
        { ...valid, extra: true },
        "Invalid defineRules preset at $: contains unsupported fields"
      ],
      [
        { ...valid, nodes: Number.NaN },
        "Invalid defineRules preset at $.nodes: expected an array"
      ],
      [
        JSON.parse(JSON.stringify({ ...valid, ["__proto__"]: {} })),
        "Invalid defineRules preset at $: contains unsupported fields"
      ],
      [custom, "Invalid defineRules preset at $: expected a plain record"],
      [
        cyclic,
        `Invalid defineRules preset at ${origin}.parents[0] -> ${origin}: cycle detected`
      ]
    ];

    for (const [value, diagnostic] of cases) {
      expect(() => parseDefineRulesPresetArtifactV5(value)).toThrow(diagnostic);
    }
  });

  it("reports the V5 diagnostic for V4 artifacts with legacy fields", () => {
    expect(() =>
      parseDefineRulesPresetArtifactV5({
        schema: "mincho.defineRulesPreset",
        version: 4,
        classNameByCache: {}
      })
    ).toThrow(
      "Invalid defineRules preset at $.version: expected defineRules preset version 5"
    );
  });

  it("reports a missing version before exact-key validation", () => {
    const node = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const valid = createDefineRulesPresetArtifactV5({
      rootNodeId: node.nodeId,
      nodes: [node]
    });
    const { version: _, ...missingVersion } = valid;

    expect(() => parseDefineRulesPresetArtifactV5(missingVersion)).toThrow(
      "Invalid defineRules preset at $.version: expected defineRules preset version 5"
    );
  });

  it("reports malformed fields without a version diagnostic", () => {
    const node = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const valid = createDefineRulesPresetArtifactV5({
      rootNodeId: node.nodeId,
      nodes: [node]
    });
    const malformedContentHash = {
      ...valid,
      nodes: valid.nodes.map((entry) => ({
        ...entry,
        contentHash: "invalid"
      }))
    };
    const wrongVersion = { ...valid, version: 4 };

    expect(() =>
      parseDefineRulesPresetArtifactV5(malformedContentHash)
    ).toThrow(
      "Invalid defineRules preset at $.nodes[0].contentHash: expected a SHA-256 hash"
    );
    expect(() =>
      parseDefineRulesPresetArtifactV5(malformedContentHash)
    ).not.toThrow("expected defineRules preset version 5");
    expect(() => parseDefineRulesPresetArtifactV5(wrongVersion)).toThrow(
      "Invalid defineRules preset at $.version: expected defineRules preset version 5"
    );
  });

  it("rejects malformed imported artifacts through public nested presets", () => {
    const node = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const valid = createDefineRulesPresetArtifactV5({
      rootNodeId: node.nodeId,
      nodes: [node]
    });
    const artifactWithUnsupportedField = {
      ...valid,
      unsupportedArtifactField: true
    };
    const nodeWithUnsupportedField = {
      ...valid,
      nodes: valid.nodes.map((node) => ({
        ...node,
        unsupportedNodeField: true
      }))
    };
    const atomWithUnsupportedField = {
      ...valid,
      nodes: valid.nodes.map((node) => ({
        ...node,
        atoms: node.atoms.map((atom) => ({
          ...atom,
          unsupportedAtomField: true
        }))
      }))
    };
    const atomWithCssPayload = {
      ...valid,
      nodes: valid.nodes.map((node) => ({
        ...node,
        atoms: node.atoms.map((atom) => ({
          ...atom,
          css: { color: "red" }
        }))
      }))
    };
    const artifactWithSymbol = { ...valid, [Symbol("preset")]: true };
    const artifactWithAccessor = Object.defineProperty({ ...valid }, "nodes", {
      enumerable: true,
      get() {
        return valid.nodes;
      }
    });
    const invalidPresets: readonly DefineRulesPresetArtifactV5[] = [
      artifactWithUnsupportedField,
      nodeWithUnsupportedField,
      atomWithUnsupportedField,
      atomWithCssPayload,
      artifactWithSymbol,
      artifactWithAccessor
    ];

    for (const preset of invalidPresets) {
      const nestedPresets: DefineRulesPresetInput = [valid, [preset]];

      expect(() =>
        defineRules<
          { readonly color: true },
          Record<never, never>,
          DefineRulesEmptyConditions
        >({
          presets: nestedPresets,
          properties: { color: true }
        })
      ).toThrow(/Invalid defineRules preset/);
    }
  });

  it("round-trips created origins and rejects ambiguous components", () => {
    const originInputs = [
      {
        packageName: "@scope/provider",
        producerPath: "src/styles.css.ts",
        registrationIndex: 0
      },
      {
        packageName: "package-name_1.2",
        producerPath: "src:generated/styles.css.ts",
        registrationIndex: 17
      }
    ];

    for (const input of originInputs) {
      const created = createPresetOriginId(input);
      expect(parsePresetOriginId(created)).toBe(created);
    }
    for (const input of [
      {
        packageName: "package\\name",
        producerPath: "src/styles.css.ts",
        registrationIndex: 0
      },
      {
        packageName: "package#name",
        producerPath: "src/styles.css.ts",
        registrationIndex: 0
      },
      {
        packageName: "package",
        producerPath: "src/styles#hash.css.ts",
        registrationIndex: 0
      }
    ])
      expect(() => createPresetOriginId(input)).toThrow(
        "Invalid defineRules preset origin"
      );
    for (const originId of [
      "package\\name:src/styles.css.ts#defineRules:0",
      "package#name:src/styles.css.ts#defineRules:0",
      "package:src/styles#hash.css.ts#defineRules:0"
    ])
      expect(() => parsePresetOriginId(originId)).toThrow(
        "Invalid defineRules preset origin"
      );
  });
});

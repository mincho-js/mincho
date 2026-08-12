import { describe, expect, it } from "vitest";
import {
  canonicalizePresetValue,
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId,
  hashPresetCanonical
} from "./presetCanonical.js";

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

describe("V5 preset canonicalization", () => {
  it("hashes canonical objects independently of key insertion order", () => {
    expect(hashPresetCanonical("abc")).toBe(
      "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25"
    );
    expect(
      hashPresetCanonical({ cacheKey: "a", condition, property: "color" })
    ).toBe(
      hashPresetCanonical({ property: "color", condition, cacheKey: "a" })
    );
    for (const value of [
      { constructor: "unsafe" },
      Number.NaN,
      Object.create({ value: true })
    ])
      expect(() => canonicalizePresetValue(value)).toThrow();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizePresetValue(cyclic)).toThrow();
  });

  it("keeps ordered parents and atoms in V5 content hashes", () => {
    const secondAtom = createDefineRulesPresetAtomV5({
      cacheKey: "background:red",
      className: "provider_background_red",
      condition,
      property: "backgroundColor"
    });
    const firstParent = createDefineRulesPresetNodeV5({
      origin,
      parents: [],
      atoms: [atom]
    });
    const secondParent = createDefineRulesPresetNodeV5({
      origin: createPresetOriginId({
        packageName: "@scope/provider",
        producerPath: "src/other.css.ts",
        registrationIndex: 0
      }),
      parents: [],
      atoms: [secondAtom]
    });
    const childOrigin = createPresetOriginId({
      packageName: "@scope/consumer",
      producerPath: "src/styles.css.ts",
      registrationIndex: 0
    });
    const leftToRight = createDefineRulesPresetNodeV5({
      origin: childOrigin,
      parents: [firstParent.nodeId, secondParent.nodeId],
      atoms: [atom, secondAtom]
    });
    const rightToLeft = createDefineRulesPresetNodeV5({
      origin: childOrigin,
      parents: [secondParent.nodeId, firstParent.nodeId],
      atoms: [secondAtom, atom]
    });
    const renamedAtom = createDefineRulesPresetAtomV5({
      ...atom,
      className: "consumer_color_red"
    });
    const parentSnapshot = JSON.stringify(firstParent);
    createDefineRulesPresetNodeV5({
      origin: childOrigin,
      parents: [firstParent.nodeId],
      atoms: [renamedAtom]
    });

    expect(leftToRight.contentHash).not.toBe(rightToLeft.contentHash);
    expect(atom.atomId).toBe(renamedAtom.atomId);
    expect(JSON.stringify(firstParent)).toBe(parentSnapshot);
    expect(
      createDefineRulesPresetNodeV5({
        origin,
        parents: [],
        atoms: [renamedAtom]
      }).contentHash
    ).not.toBe(firstParent.contentHash);
  });
});

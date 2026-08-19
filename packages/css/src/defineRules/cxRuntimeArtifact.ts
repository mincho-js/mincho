import { resolveDefineRulesPresetGraphV5 } from "./presetGraph.js";
import { createDefineRulesPresetArtifactV5 } from "./presetArtifact.js";
import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import type { CompiledSegment } from "./metadata.js";
import type {
  DefineRulesPresetArtifactV5,
  DefineRulesPresetAtomV5
} from "./types.js";

export type DefineRulesCxRuntimeArtifact = {
  readonly classWrites: Record<string, number>;
  readonly segments?: Record<string, readonly number[]>;
};

export function createDefineRulesCxRuntimeArtifact(
  preset: DefineRulesPresetArtifactV5,
  segmentsByMarker: ReadonlyMap<string, CompiledSegment>
): DefineRulesCxRuntimeArtifact {
  const graph = resolveDefineRulesPresetGraphV5([preset]);
  const classWrites: Record<string, number> = Object.create(null);
  const writeIdByKey = new Map<string, number>();

  for (const atom of graph.atomById.values()) {
    const key = atomWriteKey(atom);

    if (!writeIdByKey.has(key)) {
      writeIdByKey.set(key, writeIdByKey.size);
    }
  }

  for (const [className, atomId] of graph.atomIdByClassName) {
    const atom = graph.atomById.get(atomId);

    if (atom === undefined) {
      throw new TypeError(`Missing defineRules atom for ${className}`);
    }

    const key = atomWriteKey(atom);
    const writeId = writeIdByKey.get(key);

    if (writeId === undefined) {
      throw new TypeError(`Missing defineRules write ID for ${className}`);
    }

    classWrites[className] = writeId;
  }

  const segments: Record<string, readonly number[]> = Object.create(null);

  for (const [marker, segment] of segmentsByMarker) {
    const writes: number[] = [];

    for (const entry of segment.entries) {
      if (entry.kind !== "known") {
        throw new TypeError(`Invalid defineRules segment marker ${marker}`);
      }

      const writeId = classWrites[entry.className];

      if (writeId === undefined) {
        throw new TypeError(
          `Unknown defineRules segment class ${entry.className}`
        );
      }

      writes.push(writeId);
    }

    const existing = segments[marker];

    if (existing !== undefined && !sameWrites(existing, writes)) {
      throw new Error(`Mincho segment marker collision for ${marker}`);
    }

    segments[marker] = writes;
  }

  return Object.keys(segments).length === 0
    ? { classWrites }
    : { classWrites, segments };
}

function atomWriteKey(atom: DefineRulesPresetAtomV5): string {
  return JSON.stringify([
    atom.condition.layer,
    atom.condition.supports,
    atom.condition.media,
    atom.condition.container,
    atom.condition.selector,
    atom.property
  ]);
}

function sameWrites(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((writeId, index) => writeId === right[index])
  );
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  describe("defineRules cx runtime artifact", () => {
    it("assigns global writes in parent-first DFS order", () => {
      const baseCondition = {
        layer: null,
        supports: null,
        media: null,
        container: null,
        selector: "&"
      } as const;
      const mobileCondition = {
        ...baseCondition,
        media: "screen and (min-width: 768px)"
      } as const;
      const parentAtom = createDefineRulesPresetAtomV5({
        cacheKey: "color:red",
        className: "parent_color",
        condition: baseCondition,
        property: "color"
      });
      const childAtom = createDefineRulesPresetAtomV5({
        cacheKey: "color:blue",
        className: "child_color",
        condition: mobileCondition,
        property: "color"
      });
      const parent = createDefineRulesPresetNodeV5({
        origin: createPresetOriginId({
          packageName: "@scope/parent",
          producerPath: "src/styles.css.ts",
          registrationIndex: 0
        }),
        parents: [],
        atoms: [parentAtom]
      });
      const child = createDefineRulesPresetNodeV5({
        origin: createPresetOriginId({
          packageName: "@scope/child",
          producerPath: "src/styles.css.ts",
          registrationIndex: 0
        }),
        parents: [parent.nodeId],
        atoms: [childAtom]
      });
      const preset = createDefineRulesPresetArtifactV5({
        rootNodeId: child.nodeId,
        nodes: [parent, child]
      });
      const segments = new Map([
        [
          "__mincho_seg_test",
          {
            entries: [
              {
                kind: "known" as const,
                className: "parent_color",
                writeKeyId: 0
              },
              {
                kind: "known" as const,
                className: "child_color",
                writeKeyId: 0
              }
            ],
            hasKnownAtomicClass: true
          }
        ]
      ]);

      const artifact = createDefineRulesCxRuntimeArtifact(preset, segments);

      expect(artifact).toEqual({
        classWrites: { parent_color: 0, child_color: 1 },
        segments: { __mincho_seg_test: [0, 1] }
      });
      expect(createDefineRulesCxRuntimeArtifact(preset, segments)).toEqual(
        artifact
      );
    });

    it("handles prototype-like class and marker names", () => {
      const condition = {
        layer: null,
        supports: null,
        media: null,
        container: null,
        selector: "&"
      } as const;
      const colorAtom = createDefineRulesPresetAtomV5({
        cacheKey: "color:red",
        className: "color",
        condition,
        property: "color"
      });
      const backgroundAtom = createDefineRulesPresetAtomV5({
        cacheKey: "background-color:blue",
        className: "background",
        condition,
        property: "background-color"
      });
      const node = createDefineRulesPresetNodeV5({
        origin: createPresetOriginId({
          packageName: "@scope/prototype-like-names",
          producerPath: "src/styles.css.ts",
          registrationIndex: 0
        }),
        parents: [],
        atoms: [colorAtom, backgroundAtom]
      });
      const artifactPreset = createDefineRulesPresetArtifactV5({
        rootNodeId: node.nodeId,
        nodes: [node]
      });
      const prototypeLikeNames = [
        "constructor",
        "toString",
        "valueOf",
        "__proto__"
      ] as const;

      for (const className of prototypeLikeNames) {
        const segments = new Map([
          [
            "__mincho_seg_invalid",
            {
              entries: [
                {
                  kind: "known" as const,
                  className,
                  writeKeyId: 0
                }
              ],
              hasKnownAtomicClass: true
            }
          ]
        ]);

        expect(() =>
          createDefineRulesCxRuntimeArtifact(artifactPreset, segments)
        ).toThrow(`Unknown defineRules segment class ${className}`);
      }

      const segments = new Map<string, CompiledSegment>(
        prototypeLikeNames.map((marker) => [
          marker,
          {
            entries: [
              {
                kind: "known" as const,
                className: "color",
                writeKeyId: 0
              },
              {
                kind: "known" as const,
                className: "background",
                writeKeyId: 1
              }
            ],
            hasKnownAtomicClass: true
          }
        ])
      );
      const artifact = createDefineRulesCxRuntimeArtifact(
        artifactPreset,
        segments
      );

      if (artifact.segments === undefined) {
        throw new Error("Expected defineRules segment writes");
      }

      const artifactSegments = artifact.segments;

      expect(artifact.classWrites).toEqual({ color: 0, background: 1 });
      expect(Object.getPrototypeOf(artifact.classWrites)).toBeNull();
      expect(Object.getPrototypeOf(artifactSegments)).toBeNull();

      for (const marker of prototypeLikeNames) {
        expect(
          Object.prototype.hasOwnProperty.call(artifactSegments, marker)
        ).toBe(true);
        expect(artifactSegments[marker]).toEqual([0, 1]);
      }
    });
  });
}

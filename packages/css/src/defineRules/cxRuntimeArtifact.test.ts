import { describe, expect, it } from "vitest";
import { createDefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";
import { createDefineRulesPresetArtifactV5 } from "./presetArtifact.js";
import {
  createDefineRulesPresetAtomV5,
  createDefineRulesPresetNodeV5,
  createPresetOriginId
} from "./presetCanonical.js";
import type { CompiledSegment } from "./metadata.js";

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
      className: "__proto__",
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
    const segment = {
      entries: [
        {
          kind: "known" as const,
          className: "__proto__",
          writeKeyId: 0
        },
        {
          kind: "known" as const,
          className: "child_color",
          writeKeyId: 0
        }
      ],
      hasKnownAtomicClass: true
    };
    const segments = new Map([["__mincho_seg_test", segment]]);

    const artifact = createDefineRulesCxRuntimeArtifact(preset, segments);

    expect(artifact.classWrites).toEqual([
      ["__proto__", 0],
      ["child_color", 1]
    ]);
    expect(artifact.segments).toEqual([["__mincho_seg_test", [0, 1]]]);
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
    const preset = createDefineRulesPresetArtifactV5({
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
      const segments = new Map<string, CompiledSegment>([
        [
          "__mincho_seg_invalid",
          {
            entries: [
              {
                kind: "known",
                className,
                writeKeyId: 0
              }
            ],
            hasKnownAtomicClass: true
          }
        ]
      ]);

      expect(() =>
        createDefineRulesCxRuntimeArtifact(preset, segments)
      ).toThrow(`Unknown defineRules segment class ${className}`);
    }

    const segments = new Map<string, CompiledSegment>(
      prototypeLikeNames.map((marker) => [
        marker,
        {
          entries: [
            {
              kind: "known",
              className: "color",
              writeKeyId: 0
            },
            {
              kind: "known",
              className: "background",
              writeKeyId: 1
            }
          ],
          hasKnownAtomicClass: true
        }
      ])
    );
    const artifact = createDefineRulesCxRuntimeArtifact(preset, segments);

    expect(artifact.classWrites).toEqual([
      ["color", 0],
      ["background", 1]
    ]);
    expect(artifact.segments).toEqual(
      prototypeLikeNames.map((marker) => [marker, [0, 1]])
    );
  });
});

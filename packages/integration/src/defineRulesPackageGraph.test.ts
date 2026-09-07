import { createHash } from "node:crypto";
import { parseDefineRulesPresetArtifactV5 } from "@mincho-js/css/defineRules/registry";
import { describe, expect, it } from "vitest";
import {
  collectDefineRulesPackageGraph,
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs
} from "./defineRulesPackageGraph.js";

type DefineRulesPresetArtifactV5 = ReturnType<
  typeof parseDefineRulesPresetArtifactV5
>;

type Node = DefineRulesPresetArtifactV5["nodes"][number];

function createArtifact(
  definitions: readonly { packageName: string; parents?: readonly number[] }[],
  label = "fixture"
): DefineRulesPresetArtifactV5 {
  const nodes: Node[] = [];

  for (const [index, definition] of definitions.entries()) {
    const origin = `${definition.packageName}:src/${label}-${index}.css.ts#defineRules:0`;
    const parents = (definition.parents ?? []).map(
      (parent) => nodes[parent].nodeId
    );

    const contentHash = createHash("sha256")
      .update(JSON.stringify({ atoms: [], parents }))
      .digest("hex");

    const nodeId = createHash("sha256")
      .update(JSON.stringify({ contentHash, origin }))
      .digest("hex");

    nodes.push({
      origin: origin as Node["origin"],
      parents,
      atoms: [],
      contentHash: contentHash as Node["contentHash"],
      nodeId: nodeId as Node["nodeId"]
    });
  }

  return parseDefineRulesPresetArtifactV5({
    schema: "mincho.defineRulesPreset",
    version: 5,
    rootNodeId: nodes[nodes.length - 1].nodeId,
    nodes
  });
}

describe("defineRules package CSS dependency graph", () => {
  it("defends against an accidental unvalidated node cycle at the public collector boundary", () => {
    const artifact = createArtifact([
      { packageName: "app" },
      { packageName: "app", parents: [0] }
    ]);

    const invalid = {
      ...artifact,
      nodes: artifact.nodes.map((node, index) =>
        index === 0 ? { ...node, parents: [artifact.rootNodeId] } : node
      )
    };

    expect(() => collectDefineRulesPackageGraph([invalid])).toThrow(
      new TypeError(
        `defineRules preset node cycle: ${artifact.nodes[0].origin} -> ${artifact.nodes[1].origin}`
      )
    );
  });

  it("preserves scoped package names and diagnoses origins without a separator", () => {
    const artifact = createArtifact([{ packageName: "@scope/package" }]);

    expect(
      getDefineRulesPackageStyleSpecifiers(
        collectDefineRulesPackageGraph([artifact]),
        {
          excludePackages: []
        }
      )
    ).toEqual(["@scope/package/style.css"]);

    const invalid = {
      ...artifact,
      nodes: [
        { ...artifact.nodes[0], origin: "missing-separator" as Node["origin"] }
      ]
    };

    expect(() => collectDefineRulesPackageGraph([invalid])).toThrow(
      "defineRules preset origin is missing a package separator: missing-separator"
    );
  });

  it("orders the artifact union instead of concatenating individually ordered lists", () => {
    const first = createArtifact(
      [{ packageName: "@theme/b" }, { packageName: "app", parents: [0] }],
      "first"
    );

    const second = createArtifact(
      [
        { packageName: "@theme/a" },
        { packageName: "@theme/b", parents: [0] },
        { packageName: "app", parents: [1] }
      ],
      "second"
    );

    const graph = collectDefineRulesPackageGraph([first, second], {
      owner: "src/styles.css.ts"
    });

    expect(graph.packages).toEqual([
      { packageName: "@theme/b", firstSeen: 0 },
      { packageName: "app", firstSeen: 1 },
      { packageName: "@theme/a", firstSeen: 2 }
    ]);
    expect(getDefineRulesPackageStyleSpecifiers(graph)).toEqual([
      "@theme/a/style.css",
      "@theme/b/style.css"
    ]);
    expect(
      graph.dependencies.find((edge) => edge.dependency === "@theme/a")
        ?.witnesses
    ).toEqual([
      {
        parentOrigin: second.nodes[0].origin,
        childOrigin: second.nodes[1].origin,
        parentNodeId: second.nodes[0].nodeId,
        childNodeId: second.nodes[1].nodeId,
        owner: "src/styles.css.ts"
      }
    ]);
  });

  it("retains parent-first encounter order while contracting same-package edges", () => {
    const artifact = createArtifact([
      { packageName: "base" },
      { packageName: "left", parents: [0] },
      { packageName: "left", parents: [1] },
      { packageName: "right", parents: [0] },
      { packageName: "app", parents: [2, 3, 2] }
    ]);

    const graph = collectDefineRulesPackageGraph([artifact, artifact]);

    expect(getDefineRulesPackageStyleSpecifiers(graph)).toEqual([
      "base/style.css",
      "left/style.css",
      "right/style.css"
    ]);
    expect(graph.dependencies).toHaveLength(4);
    expect(
      graph.dependencies.every((edge) => edge.dependency !== edge.dependent)
    ).toBe(true);
    expect(
      graph.dependencies.find((edge) => edge.dependency === "left")?.witnesses
    ).toHaveLength(1);
    expect(Object.isFrozen(graph)).toBe(true);
  });

  it("merges module graphs with stable ranks and retains their diagnostic witnesses", () => {
    const artifact = createArtifact([
      { packageName: "base" },
      { packageName: "app", parents: [0] }
    ]);

    const first = collectDefineRulesPackageGraph([artifact], {
      owner: "first.css.ts"
    });

    const second = collectDefineRulesPackageGraph([artifact], {
      owner: "second.css.ts"
    });

    const graph = mergeDefineRulesPackageGraphs([first, second, first]);

    expect(graph.packages).toEqual(first.packages);
    expect(graph.localPackages).toEqual(["app"]);
    expect(graph.dependencies).toHaveLength(1);
    expect(
      graph.dependencies[0].witnesses.map((witness) => witness.owner)
    ).toEqual(["first.css.ts", "second.css.ts"]);
    expect(
      getDefineRulesPackageStyleSpecifiers(graph, { excludePackages: [] })
    ).toEqual(["base/style.css", "app/style.css"]);
  });

  it("checks package cycles introduced only by merging separate artifact graphs", () => {
    const first = createArtifact(
      [
        { packageName: "a" },
        { packageName: "b", parents: [0] },
        { packageName: "app", parents: [1] }
      ],
      "first"
    );

    const second = createArtifact(
      [
        { packageName: "b" },
        { packageName: "a", parents: [0] },
        { packageName: "app", parents: [1] }
      ],
      "second"
    );

    const firstGraph = collectDefineRulesPackageGraph([first], {
      owner: "one.css.ts"
    });

    const secondGraph = collectDefineRulesPackageGraph([second], {
      owner: "two.css.ts"
    });

    expect(() =>
      getDefineRulesPackageStyleSpecifiers(firstGraph)
    ).not.toThrow();
    expect(() =>
      getDefineRulesPackageStyleSpecifiers(secondGraph)
    ).not.toThrow();

    const graph = mergeDefineRulesPackageGraphs([firstGraph, secondGraph]);

    expect(() => getDefineRulesPackageStyleSpecifiers(graph)).toThrow(
      "defineRules automatic CSS package dependency cycle: a -> b -> a"
    );
    expect(() => getDefineRulesPackageStyleSpecifiers(graph)).toThrow(
      "owner: two.css.ts"
    );
    expect(() => getDefineRulesPackageStyleSpecifiers(graph)).toThrow(
      first.nodes[0].origin
    );
  });

  it("includes the local root package in cycle checks without rejecting the valid node artifact", () => {
    const artifact = createArtifact([
      { packageName: "app" },
      { packageName: "external", parents: [0] },
      { packageName: "app", parents: [1] }
    ]);

    expect(() => parseDefineRulesPresetArtifactV5(artifact)).not.toThrow();

    const graph = collectDefineRulesPackageGraph([artifact]);

    expect(graph.localPackages).toEqual(["app"]);
    expect(() => getDefineRulesPackageStyleSpecifiers(graph)).toThrow(
      "app -> external -> app"
    );
  });

  it("ignores valid nodes outside the root ancestry", () => {
    const artifact = createArtifact([
      { packageName: "unused" },
      { packageName: "base" },
      { packageName: "app", parents: [1] }
    ]);

    expect(
      getDefineRulesPackageStyleSpecifiers(
        collectDefineRulesPackageGraph([artifact])
      )
    ).toEqual(["base/style.css"]);
  });

  it("handles deep graphs without recursive traversal or unstable ordering", () => {
    const count = 5_000;
    const artifact = createArtifact(
      Array.from({ length: count }, (_, index) => ({
        packageName: index === count - 1 ? "app" : `p-${index}`,
        parents: index === 0 ? [] : [index - 1]
      }))
    );

    const styles = getDefineRulesPackageStyleSpecifiers(
      collectDefineRulesPackageGraph([artifact])
    );

    expect(styles).toHaveLength(count - 1);
    expect(styles[0]).toBe("p-0/style.css");
    expect(styles[styles.length - 1]).toBe(`p-${count - 2}/style.css`);
  });
});

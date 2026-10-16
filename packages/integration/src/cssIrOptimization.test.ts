import { describe, expect, it } from "vitest";
import { optimizeVanillaCssArtifacts } from "./cssIrOptimization.js";
import {
  annotateVanillaCssArtifacts,
  generateVanillaCss,
  hashVanillaCssArtifact,
  type VanillaCssArtifact
} from "./vanillaCssIr.js";

const options = { mergeRules: true, compactThemes: true, pruneGenerated: true };

function artifact(
  cssObjs: VanillaCssArtifact["cssObjs"],
  names = ["a", "b", "c"]
): VanillaCssArtifact {
  return {
    origin: "/src/component.css.ts",
    fileScope: { filePath: "src/component.css.ts", packageName: "test" },
    cssObjs,
    localClassNames: names,
    composedClassLists: [],
    usedCompositions: []
  };
}

const local = (
  selector: string,
  rule: Extract<
    VanillaCssArtifact["cssObjs"][number],
    { type: "local" }
  >["rule"]
) => ({ type: "local" as const, selector, rule });

const optimize = (
  data: VanillaCssArtifact,
  settings = options,
  external = false
) => optimizeVanillaCssArtifacts(new Map([["id", data]]), settings, external);

describe("name-preserving CSS IR optimization", () => {
  it("keeps non-finite custom property tokens distinct in merging and artifact identity", () => {
    const first = artifact([
      local("a", { vars: { "--public": NaN } } as never)
    ]);

    const second = artifact([
      local("a", { vars: { "--public": Infinity } } as never)
    ]);

    expect(hashVanillaCssArtifact(first)).not.toBe(
      hashVanillaCssArtifact(second)
    );

    const data = artifact([
      local("a", { vars: { "--public": NaN } } as never),
      local("b", { vars: { "--public": Infinity } } as never)
    ]);

    expect(optimize(data).diagnostics.mergedRules).toBe(0);
    expect(generateVanillaCss(optimize(data).artifacts.get("id")!)).toBe(
      generateVanillaCss(data)
    );

    const keys = [
      undefined,
      null,
      NaN,
      Infinity,
      -Infinity,
      -0,
      0,
      "\0nNaN",
      "\0u"
    ].map((value) =>
      hashVanillaCssArtifact(
        artifact([local("a", { vars: { "--public": value } } as never)])
      )
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("merges adjacent equal declarations while retaining both public class names", () => {
    const data = artifact([
      local("a", { color: "red" }),
      local("b", { color: "red" })
    ]);

    const original = structuredClone(data);
    const result = optimize(data);
    const css = generateVanillaCss(result.artifacts.get("id")!);

    expect(css).toContain(".a, .b");
    expect(css.match(/color: red/g)).toHaveLength(1);
    expect(result.diagnostics.mergedRules).toBe(1);
    expect(data).toEqual(original);
    expect(result.artifacts.get("id")!.localClassNames).toEqual(
      data.localClassNames
    );
  });

  it("does not cross global, condition, fallback order, or file boundaries", () => {
    const data = artifact([
      local("a", { color: "red" }),
      { type: "global", selector: "[data-active]", rule: { color: "blue" } },
      local("b", { color: "red" }),
      local("a", {
        color: "red",
        "@media": { "(width > 1px)": { color: "green" } }
      }),
      local("b", {
        color: "red",
        "@media": { "(width > 1px)": { color: "green" } }
      }),
      local("a", { display: ["block", "flex"] }),
      local("b", { display: ["flex", "block"] })
    ]);

    expect(optimize(data).diagnostics.mergedRules).toBe(0);

    const left = artifact([local("a", { color: "red" })]);
    const right = artifact([local("b", { color: "red" })]);
    const result = optimizeVanillaCssArtifacts(
      new Map([
        ["a", left],
        ["b", right]
      ]),
      options
    );

    expect(result.diagnostics.mergedRules).toBe(0);
  });

  it("compacts only identical adjacent themes and supports independent opt-outs", () => {
    const data = artifact([
      local("a", { vars: { "--public": "red" } }),
      local("b", { vars: { "--public": "red" } }),
      local("c", { vars: { "--public": "blue" } })
    ]);

    expect(optimize(data).diagnostics.mergedRules).toBe(1);
    expect(
      optimize(data, { ...options, compactThemes: false }).diagnostics
        .mergedRules
    ).toBe(0);
    expect(
      optimize(data, { ...options, mergeRules: false }).diagnostics.mergedRules
    ).toBe(1);
  });

  it("keeps keyframes immutable across preview and multiple serializations", () => {
    const data = artifact([
      {
        type: "keyframes",
        name: "fade",
        rule: { from: { opacity: 0 }, to: { opacity: 1 } }
      },
      local("a", { animation: "fade 1s" })
    ]);

    const original = structuredClone(data);
    const first = generateVanillaCss(data);

    expect(generateVanillaCss(data)).toBe(first);
    expect(data).toEqual(original);
  });
});

describe("closed generated resource graph", () => {
  it("retains layer establishment and keyframe contents when their last declaration is a private var", () => {
    const data = artifact([
      local("a", { "@layer": { tokens: { vars: { "--layer": "red" } } } }),
      {
        type: "keyframes",
        name: "fade",
        rule: {
          from: { vars: { "--keyframe": "red" } },
          to: { vars: { "--keyframe": "blue" } }
        }
      }
    ]);

    annotateVanillaCssArtifacts([data], [], ["--layer", "--keyframe"]);

    expect(optimize(data).diagnostics.removedVariables).toBe(0);
    expect(generateVanillaCss(optimize(data).artifacts.get("id")!)).toBe(
      generateVanillaCss(data)
    );
  });

  it("treats transition/animation effects as an opaque resource-use boundary", () => {
    const data = artifact([
      local("a", { vars: { "--private": "red" }, transition: "all 1s" })
    ]);

    annotateVanillaCssArtifacts([data], [], ["--private"]);

    expect(optimize(data).diagnostics.removedVariables).toBe(0);
  });

  const property = (name: string, inherits = false) => ({
    type: "property" as const,
    name,
    rule: {
      syntax: "*",
      inherits: inherits ? ("true" as const) : ("false" as const)
    }
  });

  it("removes only captured private dead resources and follows aliases across owners", () => {
    const provider = artifact([
      property("--dead"),
      property("--live"),
      property("--author"),
      local("a", {
        vars: { "--dead": "red", "--live": "blue", "--alias": "var(--live)" }
      })
    ]);

    const consumer = artifact([local("b", { color: "var(--alias)" })]);
    annotateVanillaCssArtifacts(
      [provider, consumer],
      ['export const className = "a b";'],
      ["--dead", "--live", "--alias"]
    );

    const result = optimizeVanillaCssArtifacts(
      new Map([
        ["a", provider],
        ["b", consumer]
      ]),
      options
    );

    const output = generateVanillaCss(result.artifacts.get("a")!);

    expect(output).not.toContain("--dead");
    expect(output).toContain("--live");
    expect(output).toContain("--alias");
    expect(output).toContain("--author");
    expect(result.diagnostics.removedVariables).toBe(1);
    expect(generateVanillaCss(provider)).toContain("--dead");
  });

  it("retains exported, inheriting, and author-referenced generated variables", () => {
    const data = artifact([
      property("--public"),
      property("--inherited", true),
      property("--dependency"),
      local("a", {
        vars: {
          "--public": "red",
          "--dependency": "blue",
          "--external": "var(--dependency)"
        }
      })
    ]);

    annotateVanillaCssArtifacts(
      [data],
      ['export const token = "var(--public)";'],
      ["--public", "--inherited", "--dependency"]
    );

    expect(optimize(data).diagnostics.removedVariables).toBe(0);
  });

  it("handles unused cycles and preserves explicit pruning opt-outs", () => {
    const data = artifact([
      local("a", { vars: { "--x": "var(--y)", "--y": "var(--x)" } })
    ]);

    annotateVanillaCssArtifacts([data], [], ["--x", "--y"]);

    expect(optimize(data).artifacts.get("id")!.cssObjs).toEqual([]);
    expect(
      optimize(data, { ...options, pruneGenerated: false }).artifacts.get("id")!
        .cssObjs
    ).toEqual(data.cssObjs);
  });

  it("falls back for missing provenance, escaped exports/references, or external CSS", () => {
    const data = artifact([property("--x")]);

    expect(optimize(data).diagnostics.removedVariables).toBe(0);

    annotateVanillaCssArtifacts(
      [data],
      [String.raw`export const token = "var(\u002d-x)";`],
      ["--x"]
    );

    expect(optimize(data).diagnostics.removedVariables).toBe(0);

    annotateVanillaCssArtifacts([data], [], ["--x"]);

    expect(optimize(data, options, true).diagnostics.removedVariables).toBe(0);

    data.cssObjs.push(local("a", { color: String.raw`var(--\78)` }));

    // IR arrays are immutable after capture; represent the new revision.
    data.cssObjs = [...data.cssObjs];

    expect(optimize(data).diagnostics.removedVariables).toBe(0);
  });

  it("recomputes liveness when an owner is removed", () => {
    const provider = artifact([property("--private")]);
    const consumer = artifact([local("b", { color: "var(--private)" })]);
    annotateVanillaCssArtifacts([provider, consumer], [], ["--private"]);

    expect(
      optimizeVanillaCssArtifacts(
        new Map([
          ["a", provider],
          ["b", consumer]
        ]),
        options
      ).diagnostics.removedVariables
    ).toBe(0);
    expect(optimize(provider).diagnostics.removedVariables).toBe(1);
  });
});

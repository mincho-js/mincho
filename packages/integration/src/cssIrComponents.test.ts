import { describe, expect, it } from "vitest";
import { optimizeVanillaCssArtifacts } from "./cssIrOptimization.js";
import {
  annotateVanillaCssArtifacts,
  generateVanillaCss,
  hashVanillaCssArtifact,
  type VanillaCssArtifact
} from "./vanillaCssIr.js";
import { isInternableThemeLiteral } from "./cssIrThemeValues.js";
import { prunePrivateCssResources } from "./cssIrResources.js";

const settings = {
  mergeRules: false,
  compactThemes: false,
  pruneGenerated: false
};

type Root = VanillaCssArtifact["cssObjs"][number];

const local = (selector: string, rule: unknown): Root =>
  ({ type: "local", selector, rule }) as Root;

const frame = (
  name: string,
  rule: unknown = { from: { opacity: 0 }, to: { opacity: 1 } }
): Root => ({ type: "keyframes", name, rule }) as Root;

function artifact(roots: Root[]): VanillaCssArtifact {
  const data: VanillaCssArtifact = {
    origin: "/a.css.ts",
    fileScope: { filePath: "a.css.ts", packageName: "test" },
    cssObjs: roots,
    localClassNames: [
      "a",
      "b",
      "base",
      "small",
      "large",
      "compound",
      "foreign"
    ],
    composedClassLists: [],
    usedCompositions: []
  };

  annotateVanillaCssArtifacts([data], [], [], {
    version: 2,
    keyframes: ["live", "dead", "cycle"],
    recipes: [],
    themes: ["a", "b"]
  });

  return data;
}

function optimize(
  data: VanillaCssArtifact,
  options: Partial<Parameters<typeof optimizeVanillaCssArtifacts>[1]> = {},
  external = false
) {
  const result = optimizeVanillaCssArtifacts(
    new Map([["a", data]]),
    { ...settings, ...options },
    external
  );

  const output = result.artifacts.get("a")!;

  return { ...result, output, css: generateVanillaCss(output) };
}

describe("component-system CSS IR", () => {
  it("reuses candidate-free IR without changing variable-liveness semantics", () => {
    const data = artifact([
      local("a", { vars: { "--unused": "red" }, color: "black" })
    ]);

    data.provenance!.resources!.keyframes = [];

    const input = new Map([["a", data]]);
    const options = { pruneRecipes: true, pruneKeyframes: true };
    const result = prunePrivateCssResources(input, options, false);

    expect(result.artifacts).toBe(input);
    expect(result.diagnostics.resourceBailout).toBe("no-candidates");
    expect(optimize(data, { pruneGenerated: true, ...options }).css).toBe(
      optimize(data, { pruneGenerated: true }).css
    );
  });

  it("leaves defaults and explicit false flags byte-equivalent", () => {
    const data = artifact([
      local("a", { "@media": { print: { color: "red" } } }),
      local("b", { "@media": { print: { color: "red" } } }),
      frame("dead")
    ]);

    expect(optimize(data).css).toBe(generateVanillaCss(data));
    expect(
      optimize(data, {
        mergeConditionalRules: false,
        pruneRecipes: false,
        pruneKeyframes: false,
        internThemeValues: false
      }).css
    ).toBe(generateVanillaCss(data));
  });

  it("merges adjacent identical ordered media/supports paths without changing class names", () => {
    const rule = {
      "@media": {
        print: {
          "@supports": {
            "(display: grid)": { display: ["block", "grid"], color: "red" }
          }
        }
      }
    };

    const data = artifact([local("a", rule), local("b", rule)]);
    const before = structuredClone(data);
    const result = optimize(data, { mergeConditionalRules: true });

    expect(result.diagnostics.mergedRules).toBe(1);
    expect(result.css).toContain(".a, .b");
    expect(result.css.match(/color: red/g)).toHaveLength(1);
    expect(result.output.localClassNames).toEqual(data.localClassNames);
    expect(data).toEqual(before);
  });

  it.each([
    [
      local("a", { "@layer": { lib: { color: "red" } } }),
      local("b", { "@layer": { lib: { color: "red" } } })
    ],
    [
      local("a", { "@media": { print: { color: "red" } } }),
      local("b", { "@media": { screen: { color: "red" } } })
    ],
    [
      local("a", { "@media": { print: { display: ["block", "flex"] } } }),
      local("b", { "@media": { print: { display: ["flex", "block"] } } })
    ],
    [
      local("a:hover", { "@media": { print: { color: "red" } } }),
      local("b:hover", { "@media": { print: { color: "red" } } })
    ],
    [
      local("a", {
        "@media": {
          print: { "@supports": { "(display: grid)": { color: "red" } } }
        }
      }),
      local("b", {
        "@supports": {
          "(display: grid)": { "@media": { print: { color: "red" } } }
        }
      })
    ]
  ])(
    "keeps layer, condition, fallback, complex selector and wrapper order barriers",
    (...roots) => {
      const data = artifact(roots);

      expect(optimize(data, { mergeConditionalRules: true }).css).toBe(
        generateVanillaCss(data)
      );
    }
  );

  it("interns long literals locally, preserving independent public declarations and identical-theme compaction", () => {
    const value =
      "linear-gradient(90deg, rgb(1, 20, 30) 0%, rgba(100, 200, 220, 0.75) 55%, rgb(240, 245, 250) 100%)";

    const vars = { "--one": value, "--two": value, "--three": value };
    const data = artifact([local("a", { vars }), local("b", { vars })]);
    const result = optimize(data, {
      internThemeValues: true,
      compactThemes: true
    });

    expect(result.diagnostics.themeValues.applied).toBe(2);
    expect(result.diagnostics.mergedRules).toBe(1);
    expect(result.css).toMatch(/--one: var\(--mi-/);
    expect(result.css).toMatch(/--two: var\(--mi-/);
    expect(result.css).not.toContain("var(--one)");
    expect(Buffer.byteLength(result.css)).toBeLessThan(
      Buffer.byteLength(optimize(data, { compactThemes: true }).css)
    );
    expect(generateVanillaCss(data)).not.toContain("--mi-");
  });

  it("does not intern arbitrary blocks, registered properties, short values, escapes or context-dependent functions", () => {
    const value =
      "linear-gradient(90deg, red, green, blue, yellow, orange, purple, violet, indigo, cyan, magenta)";

    const data = artifact([
      local("foreign", { vars: { "--a": value, "--b": value } }),
      local("a", {
        vars: {
          "--one": value,
          "--two": value,
          "--red": "red",
          "--red2": "red"
        }
      }),
      {
        type: "property",
        name: "--one",
        rule: { syntax: "*", inherits: "false" }
      } as Root
    ]);

    expect(
      optimize(data, { internThemeValues: true }).diagnostics.themeValues
        .applied
    ).toBe(0);

    for (const literal of [
      "var(--a)",
      "env(foo)",
      "attr(data-x)",
      "url(a.png)",
      "revert-layer",
      "inherit",
      "rgb(1,2,3",
      "\\72 ed",
      "calc(2 * 3)",
      "foo(100px)"
    ])
      expect(isInternableThemeLiteral(literal)).toBe(false);

    expect(optimize(data, { internThemeValues: true }, true).css).toBe(
      generateVanillaCss(data)
    );
  });

  it("skips existing private-name collisions and escaped CSS namespaces", () => {
    const value =
      "linear-gradient(90deg, red, green, blue, yellow, orange, purple, violet, indigo, cyan, magenta)";

    const data = artifact([
      local("a", { vars: { "--one": value, "--two": value, "--three": value } })
    ]);

    const name = /--mi-[\da-f]+/.exec(
      optimize(data, { internThemeValues: true }).css
    )![0];

    const collision = artifact([
      ...data.cssObjs,
      local("foreign", { vars: { [name]: "red" } })
    ]);

    expect(
      optimize(collision, { internThemeValues: true }).diagnostics.themeValues
        .applied
    ).toBe(0);

    const escaped = artifact([
      ...data.cssObjs,
      local("foreign", { vars: { "--mi-\\61": "red" } })
    ]);

    expect(
      optimize(escaped, { internThemeValues: true }).diagnostics.themeValues
        .reason
    ).toBe("escaped-css");
  });

  it("prunes only actual private recipe classes, pinning compositions and CSS selector references", () => {
    const data = artifact([
      local("base", { color: "black" }),
      local("small", { fontSize: 12 }),
      local("large", { fontSize: 90 }),
      local("compound", { color: "orange" }),
      local("foreign", { color: "blue" })
    ]);

    const resources = data.provenance!.resources!;
    resources.recipes = [
      {
        id: "base foreign",
        classes: ["base", "small", "large", "compound"],
        references: ["base", "small", "large", "compound", "foreign"]
      }
    ];
    resources.recipeUses = [
      { id: "base foreign", used: ["base", "small", "foreign"] }
    ];

    const result = optimize(data, { pruneRecipes: true });

    expect(result.diagnostics.resources?.removedRecipeRules).toBe(2);
    expect(result.css).toContain(".foreign");
    expect(result.css).not.toContain(".large");

    data.cssObjs.push({
      type: "global",
      selector: ".large:hover",
      rule: { color: "red" }
    } as Root);
    data.composedClassLists.push({ identifier: "keep", classList: "compound" });

    expect(
      optimize(data, { pruneRecipes: true }).diagnostics.resources
        ?.removedRecipeRules
    ).toBe(0);

    resources.recipeUses = [{ id: "base foreign", used: null }];

    expect(optimize(data, { pruneRecipes: true }).css).toBe(
      generateVanillaCss(data)
    );
  });

  it("removes recipes before calculating keyframe reach, keeping global and public animations", () => {
    const data = artifact([
      local("small", { animation: "live 1s ease-in infinite" }),
      local("large", { animationName: "dead" }),
      frame("live"),
      frame("dead"),
      frame("global")
    ]);

    data.provenance!.resources!.recipes = [
      {
        id: "base",
        classes: ["small", "large"],
        references: ["small", "large"]
      }
    ];
    data.provenance!.resources!.recipeUses = [{ id: "base", used: ["small"] }];

    const result = optimize(data, { pruneRecipes: true, pruneKeyframes: true });

    expect(result.diagnostics.resources?.removedRecipeRules).toBe(1);
    expect(result.diagnostics.resources?.removedKeyframes).toBe(1);
    expect(result.css).toContain("@keyframes live");
    expect(result.css).toContain("@keyframes global");
    expect(result.css).not.toContain("@keyframes dead");

    data.provenance!.resources!.publicKeyframes = ["dead"];

    expect(
      optimize(data, { pruneRecipes: true, pruneKeyframes: true }).css
    ).toContain("@keyframes dead");
  });

  it.each([
    "animation-name",
    "WebkitAnimationName",
    "-webkit-animation-name",
    "MozAnimationName"
  ])("retains live keyframes referenced through %s", (property) => {
    const data = artifact([
      local("a", { [property]: "live" }),
      frame("live"),
      frame("dead")
    ]);

    const result = optimize(data, { pruneKeyframes: true });

    expect(result.css).toContain("@keyframes live");
    expect(result.css).not.toContain("@keyframes dead");
  });

  it("distinguishes complete public names from a generated keyframe prefix", () => {
    const data = artifact([frame("live"), frame("liveSuffix"), frame("dead")]);
    annotateVanillaCssArtifacts(
      [data],
      ['export const selected="liveSuffix"'],
      [],
      {
        version: 2,
        keyframes: ["live", "liveSuffix", "dead"],
        recipes: [],
        themes: []
      }
    );

    const result = optimize(data, { pruneKeyframes: true });

    expect(result.css).toContain("@keyframes liveSuffix");
    expect(result.css).not.toContain("@keyframes live {");
    expect(result.css).not.toContain("@keyframes dead");
  });

  it("preserves resources when serialized public names contain CSS escapes", () => {
    const data = artifact([frame("live"), frame("dead")]);
    annotateVanillaCssArtifacts(
      [data],
      [String.raw`export const name="\\6c ive"`],
      [],
      {
        version: 2,
        keyframes: ["live", "dead"],
        recipes: [],
        themes: []
      }
    );

    expect(optimize(data, { pruneKeyframes: true }).css).toContain(
      "@keyframes live"
    );
  });

  it.each([
    String.raw`export const name="\\6c ive"`,
    String.raw`export const message="first\nsecond"`,
    String.raw`export const message="\"quoted\""`
  ])("keeps variable pruning independent of resource escapes: %s", (source) => {
    const data = artifact([
      local("a", { vars: { "--unused": "red" }, color: "black" }),
      frame("live"),
      frame("dead")
    ]);

    annotateVanillaCssArtifacts([data], [source], ["--unused"], {
      version: 2,
      keyframes: ["live", "dead"],
      recipes: [],
      themes: []
    });

    const result = optimize(data, {
      pruneGenerated: true,
      pruneKeyframes: true,
      pruneRecipes: true
    });

    expect(data.provenance!.opaque).toBe(false);
    expect(data.provenance!.resources).toBeUndefined();
    expect(result.diagnostics.removedVariables).toBe(1);
    expect(result.css).not.toContain("--unused");
    expect(result.css).toContain("@keyframes live");
    expect(result.css).toContain("@keyframes dead");
  });

  it.each([
    String.raw`export const token="var(\u002d-unused)"`,
    String.raw`export const token="var(\x2d-unused)"`
  ])(
    "keeps Unicode and hex exports opaque to variable pruning: %s",
    (source) => {
      const data = artifact([
        local("a", { vars: { "--unused": "red" }, color: "black" })
      ]);

      annotateVanillaCssArtifacts([data], [source], ["--unused"], {
        version: 2,
        keyframes: [],
        recipes: [],
        themes: []
      });

      expect(data.provenance!.opaque).toBe(true);
      expect(data.provenance!.resources?.version).toBe(2);
      expect(optimize(data, { pruneGenerated: true }).css).toContain(
        "--unused"
      );
    }
  );

  it("marks animation/variable cycles and multiple possible definitions without refcount leaks", () => {
    const data = artifact([
      local("a", {
        vars: {
          "--first": "var(--second)",
          "--second": "live",
          "--unused": "cycle"
        },
        animationName: "var(--first)"
      }),
      frame("live", { from: { animationName: "cycle" } }),
      frame("cycle", { from: { animationName: "live" } }),
      frame("dead")
    ]);

    data.provenance!.generatedVariables = ["--first", "--second", "--unused"];

    const result = optimize(data, { pruneKeyframes: true });

    expect(result.diagnostics.resources?.removedKeyframes).toBe(1);
    expect(result.css).toContain("@keyframes cycle");
  });

  it.each([
    ["vars", true],
    ["vars", false],
    ["property", true],
    ["property", false]
  ] as const)(
    "retains runtime-selectable keyframes across %s definitions (export first: %s)",
    (definition, exportFirst) => {
      const exported = artifact([local("b", { color: "blue" })]);
      exported.provenance!.publicReferences = ["--name"];
      exported.provenance!.resources!.keyframes = [];

      const provider = artifact([
        local("a", {
          ...(definition === "vars" ? { vars: { "--name": "live" } } : {}),
          animationName: "var(--name)"
        }),
        ...(definition === "property"
          ? [
              {
                type: "property",
                name: "--name",
                rule: { syntax: "*", inherits: "false", initialValue: "live" }
              } as Root
            ]
          : []),
        frame("live"),
        frame("dead")
      ]);
      provider.provenance!.generatedVariables = ["--name"];

      const entries: [string, VanillaCssArtifact][] = [
        ["exported", exported],
        ["provider", provider]
      ];
      const input = new Map(exportFirst ? entries : entries.reverse());
      const options = { ...settings, pruneKeyframes: true };
      const result = optimizeVanillaCssArtifacts(input, options);
      const css = generateVanillaCss(result.artifacts.get("provider")!);

      expect(result.diagnostics.resources?.resourceBailout).toBe(
        "opaque-animation-value"
      );
      expect(result.diagnostics.resources?.removedKeyframes).toBe(0);
      expect(css).toContain("@keyframes live");
      expect(css).toContain("@keyframes dead");

      exported.provenance!.publicReferences = [];

      const privateResult = optimizeVanillaCssArtifacts(input, options);

      expect(privateResult.diagnostics.resources?.removedKeyframes).toBe(1);
    }
  );

  it("keeps foreign keyframes even when they collide with a captured local animation name", () => {
    const data = artifact([
      frame("dead"),
      frame("dead", { from: { opacity: 0.75 } })
    ]);

    data.provenance!.resources!.foreignKeyframes = ["dead"];

    expect(
      optimize(data, { pruneKeyframes: true }).css.match(/@keyframes dead/g)
    ).toHaveLength(2);
  });

  it("retains a private recipe's class reused by a public recipe without a composition registration", () => {
    const data = artifact([
      local("small", { color: "red" }),
      local("large", { color: "blue" }),
      local("foreign", { padding: 2 })
    ]);

    data.provenance!.resources!.recipes = [
      {
        id: "base",
        classes: ["small", "large"],
        references: ["small", "large"]
      },
      { id: "foreign", classes: ["foreign"], references: ["foreign", "large"] }
    ];
    data.provenance!.resources!.recipeUses = [
      { id: "base", used: ["small"] },
      { id: "foreign", used: null }
    ];

    expect(optimize(data, { pruneRecipes: true }).css).toContain(".large");
  });

  it("pins a candidate class also targeted by an unowned root in another artifact", () => {
    const owned = artifact([local("large", { color: "blue" })]);
    owned.provenance!.resources!.recipes = [
      { id: "base", classes: ["large"], references: ["large"] }
    ];
    owned.provenance!.resources!.recipeUses = [{ id: "base", used: [] }];

    const unowned = artifact([local("large", { background: "yellow" })]);
    const result = optimizeVanillaCssArtifacts(
      new Map([
        ["owned", owned],
        ["unowned", unowned]
      ]),
      { ...settings, pruneRecipes: true }
    );

    expect(result.diagnostics.resources?.removedRecipeRules).toBe(0);
  });

  it("prunes unused variables after closing animation reach, retaining transition event registrations", () => {
    const data = artifact([
      local("a", {
        vars: { "--unused": "red", "--name": "live" },
        animationName: "var(--name)"
      }),
      frame("live"),
      frame("dead")
    ]);

    data.provenance!.generatedVariables = ["--unused", "--name"];

    const result = optimize(data, {
      pruneKeyframes: true,
      pruneGenerated: true
    });

    expect(result.css).not.toContain("--unused");
    expect(result.css).toContain("--name");

    const transitions = artifact([
      local("a", { vars: { "--unused": "red" }, transition: "all 1s" }),
      frame("dead")
    ]);

    transitions.provenance!.generatedVariables = ["--unused"];

    expect(
      optimize(transitions, { pruneKeyframes: true, pruneGenerated: true }).css
    ).toContain("--unused");
  });

  it.each([
    "var(--external)",
    "live 1s, var(--unknown) 2s",
    "\\64 ead",
    "inherit",
    "scroll(foo)"
  ])("retains frames for opaque animation value %s", (animation) => {
    const data = artifact([local("a", { animation }), frame("dead")]);

    expect(
      optimize(data, { pruneKeyframes: true }).diagnostics.resources
        ?.removedKeyframes
    ).toBe(0);
  });

  it("bails out on missing/version-mismatched metadata and keeps proof independent of CSS identity", () => {
    const data = artifact([frame("dead")]);
    const hash = hashVanillaCssArtifact(data);
    data.provenance!.resources!.recipeUses = [{ id: "test", used: [] }];

    expect(hashVanillaCssArtifact(data)).toBe(hash);

    data.provenance!.resources = undefined;

    expect(optimize(data, { pruneKeyframes: true }).css).toBe(
      generateVanillaCss(data)
    );
  });
});

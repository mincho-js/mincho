import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { babelTransform } from "./testUtils/plugin.js";
import type { ExtractCalls } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const base = join(process.cwd(), ".cache", "extract-calls");
  mkdirSync(base, { recursive: true });

  const root = mkdtempSync(join(base, "case-"));
  roots.push(root);

  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }

  return {
    root,

    transform(file: string, extractCalls: ExtractCalls) {
      return babelTransform(
        readFileSync(join(root, file), "utf8"),
        { extractCalls },
        { filename: join(root, file), root }
      );
    }
  };
}

describe("extractCalls configuration", () => {
  it.each([
    ['import { defineStyle } from "custom-styles";', "defineStyle"],
    ['import { defineStyle as make } from "custom-styles";', "make"],
    ['import make from "custom-styles";', "make"],
    ['import * as custom from "custom-styles";', "custom.defineStyle"],
    ['import * as custom from "custom-styles";', 'custom["defineStyle"]']
  ])("extracts registered imports: %s", (declaration, callee) => {
    const { code, result } = babelTransform(
      `${declaration} export const value = ${callee}({ color: "red" });`,
      {
        extractCalls: { "custom-styles": ["defineStyle", "default"] }
      }
    );

    expect(code).not.toContain(`${callee}(`);
    expect(code).toContain(result[0]);
    expect(result[1]).toContain(`${callee}(`);
  });

  it("preserves built-ins, ignores unrelated sources and does not leak configuration", () => {
    const source = `
      import { style } from "@vanilla-extract/css";
      import { defineStyle } from "custom-styles";
      import { defineStyle as unrelated } from "another-package";
      export const native = style({ color: "red" });
      export const custom = defineStyle({ color: "blue" });
      export const other = unrelated({});
      export const shadowed = (defineStyle) => defineStyle({});
    `;

    const configured = babelTransform(source, {
      extractCalls: { "custom-styles": ["defineStyle"] }
    });

    expect(configured.result[1]).toContain("style({");
    expect(configured.result[1]).toContain("defineStyle({");
    expect(configured.code).toContain("unrelated({})");
    expect(configured.code).toContain("defineStyle => defineStyle({})");
    expect(babelTransform(source).result[1]).not.toContain("defineStyle({");
  });

  it("normalizes registration order and preserves existing sidecar names without additions", () => {
    const source =
      'import { style } from "@vanilla-extract/css"; export const x = style({});';

    const baseline = babelTransform(source);

    expect(babelTransform(source, { extractCalls: {} }).result).toEqual(
      baseline.result
    );
    expect(
      babelTransform(source, {
        extractCalls: { "@vanilla-extract/css": ["style"] }
      }).result
    ).toEqual(baseline.result);

    const config = Object.freeze({
      b: Object.freeze(["z", "a", "z"]),
      a: Object.freeze(["x"])
    });

    const first = babelTransform(source, { extractCalls: config });

    expect(first.result).toEqual(
      babelTransform(source, { extractCalls: { a: ["x"], b: ["a", "z"] } })
        .result
    );
    expect(first.result[0]).not.toBe(baseline.result[0]);
  });

  it("accepts source names that also exist on Object.prototype", () => {
    const transformed = babelTransform(
      'import { make } from "constructor"; export const value = make({});',
      {
        extractCalls: { constructor: ["make"] }
      }
    );

    expect(transformed.result[1]).toContain("make({})");
  });

  it.each([
    null,
    [],
    { source: "style" },
    { source: [""] },
    { source: ["*"] },
    { "": ["style"] }
  ])("reports invalid configuration: %j", (extractCalls) => {
    expect(() =>
      babelTransform("", {
        extractCalls: extractCalls as unknown as ExtractCalls
      })
    ).toThrow(/extractCalls/);
  });

  it("keeps ignored registered calls at their original location", () => {
    const { code, result } = babelTransform(
      `
      import { defineStyle } from "custom-styles";
      export const ignored = /* mincho-js-ignore */ defineStyle({ color: "red" });
      /* mincho-js-ignore */ defineStyle({ color: "blue" });
    `,
      { extractCalls: { "custom-styles": ["defineStyle"] } }
    );

    expect(code).toContain("defineStyle({");
    expect(result[1]).not.toContain("defineStyle({");
  });

  it("does not trust registered calls as read-only during CSS prop evaluation", () => {
    expect(() =>
      babelTransform(
        `
      import { defineStyle } from "custom-styles";
      const rule = { color: "red" };
      defineStyle(rule);
      export const App = () => <div css={rule} />;
    `,
        { jsxCssProp: true, extractCalls: { "custom-styles": ["defineStyle"] } }
      )
    ).toThrow();
  });
});

describe("local extractCalls implementations", () => {
  const extractCalls = { "./src/factory.ts": ["defineStyle", "default"] };

  it("protects a factory before its caller is transformed and resolves imports by file identity", () => {
    const project = fixture({
      "src/factory.ts": `
        import { style } from "@vanilla-extract/css";
        export function defineStyle(rule) { return style(rule); }
        export default (rule) => style(rule);
        export const standalone = style({ color: "pink" });
      `,
      "src/nested/app.ts": `import make, { defineStyle as create } from "../factory.js"; export const red = create({ color: "red" }); export const blue = make({ color: "blue" });`,
      "src/other.ts": `import { style } from "@vanilla-extract/css"; export function defineStyle() { return style({ color: "green" }); }`
    });

    const factory = project.transform("src/factory.ts", extractCalls);

    expect(factory.code).toContain("style(rule)");
    expect(factory.result[1]).toContain('color: "pink"');
    expect(factory.result[1]).not.toContain("style(rule)");

    const caller = project.transform("src/nested/app.ts", extractCalls);

    expect(caller.code).not.toContain("create({");
    expect(caller.result[1]).toContain("create({");
    expect(caller.result[1]).toContain("make({");
    expect(project.transform("src/other.ts", extractCalls).code).not.toContain(
      "style({"
    );
  });

  it("protects closures, callbacks and imported helpers through re-exports", () => {
    const project = fixture({
      "src/factory.ts":
        'export { make as defineStyle } from "./impl"; export { default } from "./impl";',
      "src/impl.ts": `
        import * as helpers from "./helper";
        const make = (rule) => helpers.wrap(rule);
        export { make };
        export default make;
      `,
      "src/helper.ts": `
        import { style, styleVariants } from "@vanilla-extract/css";
        const local = (rule) => style(rule);
        export function wrap(rule) { return local(rule); }
        export function unrelated() { return style({ color: "green" }); }
      `,
      "src/app.ts":
        'import { defineStyle } from "./factory"; export const value = defineStyle({ color: "red" });'
    });

    const helper = project.transform("src/helper.ts", extractCalls);

    expect(helper.code).toContain("style(rule)");
    expect(helper.result[1]).toContain('color: "green"');
    expect(helper.result[1]).not.toContain("style(rule)");
    expect(project.transform("src/app.ts", extractCalls).result[1]).toContain(
      "defineStyle({"
    );
  });

  it("refreshes protection after a re-export changes without retaining old bindings", () => {
    const project = fixture({
      "barrel.ts": 'export { make } from "./first";',
      "first.ts":
        'import { style } from "@vanilla-extract/css"; export const make = () => style({ color: "red" });',
      "second.ts":
        'import { style } from "@vanilla-extract/css"; export const make = () => style({ color: "blue" });'
    });

    const config = { "./barrel.ts": ["make"] };

    expect(project.transform("first.ts", config).result[1]).toBe("");

    writeFileSync(
      join(project.root, "barrel.ts"),
      'export { make } from "./second";'
    );

    expect(project.transform("first.ts", config).result[1]).toContain(
      "style({"
    );
    expect(project.transform("second.ts", config).result[1]).toBe("");
  });

  it("generates the same sidecar filename in different project checkout directories", () => {
    const files = {
      "factory.ts": 'export const make = () => "class";',
      "app.ts": 'import { make } from "./factory"; export const value = make();'
    };

    const first = fixture(files);
    const second = fixture(files);
    const config = { "./factory.ts": ["make"] };

    expect(first.transform("app.ts", config).result).toEqual(
      second.transform("app.ts", config).result
    );
  });

  it("generates the same sidecar filename through symlinked checkout roots", () => {
    const files = {
      "factory.ts": 'export const make = () => "class";',
      "app.ts": 'import { make } from "./factory"; export const value = make();'
    };
    const first = fixture(files);
    const second = fixture(files);
    const links = fixture({});
    const config = { "./factory.ts": ["make"] };
    const baseline = first.transform("app.ts", config).result;

    for (const [name, project] of [
      ["first", first],
      ["second", second]
    ] as const) {
      const root = join(links.root, name);
      symlinkSync(project.root, root, "junction");

      expect(
        babelTransform(
          files["app.ts"],
          { extractCalls: config },
          {
            filename: join(root, "app.ts"),
            root
          }
        ).result
      ).toEqual(baseline);
    }
  });

  it.each(["css", "styles"])(
    "resolves dotted .%s factory and helper imports",
    (extension) => {
      const project = fixture({
        [`factory.${extension}.ts`]: `
        import { style } from "@vanilla-extract/css";
        import { color } from "./tokens.${extension}";
        export const make = (rule) => style({ color, ...rule });
      `,
        [`tokens.${extension}.ts`]: 'export const color = "red";',
        "app.ts": `import { make } from "./factory.${extension}"; export const value = make({});`
      });
      const config = { [`./factory.${extension}.ts`]: ["make"] };

      expect(project.transform("app.ts", config).result[1]).toContain(
        "make({})"
      );
      expect(
        project.transform(`factory.${extension}.ts`, config).result[1]
      ).toBe("");
    }
  );

  it.each([
    ["export function make(rule) { return style(rule); }", "make"],
    ["export const make = (rule) => style(rule);", "make"],
    ["export default function make(rule) { return style(rule); }", "default"],
    ["const make = (rule) => style(rule); export default make;", "default"],
    [
      "const original = (rule) => style(rule); const make = original; export { make as registered };",
      "registered"
    ]
  ])(
    "extracts owner-local calls to registered bindings: %s",
    (declaration, name) => {
      const project = fixture({
        "factory.ts": `
        import { style } from "@vanilla-extract/css";
        ${declaration}
        export const primary = make({ color: "red" });
        export const shadowed = (make) => make({ color: "blue" });
        export const ignored = /* mincho-js-ignore */ make({ color: "pink" });
      `
      });
      const transformed = project.transform("factory.ts", {
        "./factory.ts": [name]
      });

      expect(transformed.result[1]).toContain('color: "red"');
      expect(transformed.result[1]).toContain("style(rule)");
      expect(transformed.result[1]).not.toContain('color: "blue"');
      expect(transformed.result[1]).not.toContain('color: "pink"');
      expect(transformed.code).not.toContain('color: "red"');
      expect(transformed.code).toContain("style(rule)");
      expect(transformed.code).toContain('color: "blue"');
      expect(transformed.code).toContain('color: "pink"');
    }
  );

  it("extracts owner bindings reached through registered re-exports without extracting helpers", () => {
    const project = fixture({
      "barrel.ts": 'export { make as registered } from "./factory";',
      "factory.ts": `
        import { style } from "@vanilla-extract/css";
        const helper = (rule) => style(rule);
        export const make = (rule) => helper(rule);
        export const primary = make({ color: "red" });
        export const unrelated = helper({ color: "blue" });
      `
    });
    const transformed = project.transform("factory.ts", {
      "./barrel.ts": ["registered"]
    });

    expect(transformed.result[1]).toContain('color: "red"');
    expect(transformed.result[1]).toContain("helper(rule)");
    expect(transformed.result[1]).not.toContain('color: "blue"');
    expect(transformed.code).not.toContain('color: "red"');
    expect(transformed.code).toContain('color: "blue"');
  });

  it("extracts calls to an imported owner binding exported under a registered name", () => {
    const project = fixture({
      "factory.ts": `
        import { make } from "./impl";
        export { make as registered };
        export const primary = make({ color: "red" });
      `,
      "impl.ts":
        'import { style } from "@vanilla-extract/css"; export const make = (rule) => style(rule);'
    });
    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["registered"]
    });

    expect(transformed.result[1]).toContain('color: "red"');
    expect(transformed.code).not.toContain('color: "red"');
  });

  it("resolves unambiguous star exports and diagnoses unresolved implementations", () => {
    const project = fixture({
      "barrel.ts": 'export * from "./impl";',
      "impl.ts":
        'import { style } from "@vanilla-extract/css"; export const make = (rule) => style(rule); export const invalid = 42;',
      "app.ts":
        'import { make } from "./barrel"; export const value = make({});'
    });

    expect(
      project.transform("app.ts", { "./barrel.ts": ["make"] }).result[1]
    ).toContain("make({})");
    expect(() =>
      project.transform("app.ts", { "./barrel.ts": ["invalid"] })
    ).toThrow(/extractCalls.*invalid.*implementation/);
    expect(() =>
      project.transform("app.ts", { "./missing.ts": ["make"] })
    ).toThrow(/extractCalls.*missing.ts/);
  });

  it("honors ignore comments at a local call site and inside its implementation", () => {
    const project = fixture({
      "factory.ts":
        'import { style } from "@vanilla-extract/css"; export const make = (rule) => /* mincho-js-ignore */ style(rule);',
      "app.ts":
        'import { make } from "./factory"; export const ignored = /* mincho-js-ignore */ make({ color: "red" });'
    });

    const config = { "./factory.ts": ["make"] };

    expect(project.transform("factory.ts", config).code).toContain(
      "/* mincho-js-ignore */style(rule)"
    );

    const caller = project.transform("app.ts", config);

    expect(caller.code).toContain("make({");
    expect(caller.result[1]).not.toContain("make({");
  });

  it("protects only reachable callbacks and object methods in the same module", () => {
    const project = fixture({
      "factory.ts": `
        import { style, styleVariants } from "@vanilla-extract/css";
        const methods = { make(rule) { return style(rule); }, other() { return style({ color: "pink" }); } };
        const callback = (rule) => style(rule);
        export const variants = (rules) => styleVariants(rules, callback);
        export const make = (rule) => methods.make(rule);
        export const unrelated = () => style({ color: "green" });
      `
    });

    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["make", "variants"]
    });

    expect(transformed.code.match(/style\(rule\)/g)).toHaveLength(2);
    expect(transformed.code).toContain("styleVariants(rules, callback)");
    expect(transformed.result[1]).toContain('color: "green"');
    expect(transformed.result[1]).toContain('color: "pink"');
    expect(transformed.result[1]).not.toContain("style(rule)");
  });

  it("does not load type-only imports while protecting a TypeScript factory", () => {
    const project = fixture({
      "factory.ts": `
        import { style } from "@vanilla-extract/css";
        import type * as Types from "./types";
        import type { Extra } from "./extra";
        export const make = (rule: Types.Rule & Extra) => style(rule);
      `
    });

    const result = project.transform("factory.ts", {
      "./factory.ts": ["make"]
    });

    expect(result.code).toContain("style(rule)");
    expect(result.result[1]).toBe("");
  });

  it("terminates cyclic re-exports and reports ambiguous exports", () => {
    const project = fixture({
      "barrel.ts": 'export * from "./cycle"; export * from "./first";',
      "cycle.ts": 'export * from "./barrel";',
      "first.ts": 'export const make = () => "first";',
      "second.ts": 'export const make = () => "second";',
      "app.ts": 'import { make } from "./barrel"; export const value = make();'
    });

    const config = { "./barrel.ts": ["make"] };

    expect(project.transform("app.ts", config).result[1]).toContain("make()");

    writeFileSync(
      join(project.root, "barrel.ts"),
      'export * from "./first"; export * from "./second";'
    );

    expect(() => project.transform("app.ts", config)).toThrow(
      /Ambiguous export make/
    );
  });
});

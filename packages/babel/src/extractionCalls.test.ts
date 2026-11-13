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
import { transformSync } from "@babel/core";
import { transformSync as transformModule } from "esbuild";
import { analyzeExtractCalls } from "./extractionCalls/analysis.js";
import { minchoBabelPlugin } from "./index.js";
import { styledComponentPlugin } from "./styled.js";
import { babelTransform } from "./testUtils/plugin.js";
import type { ExtractCalls, PluginOptions } from "./types.js";

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

function executeModule(source: string, modules: Record<string, unknown>) {
  const { code } = transformModule(source, { format: "cjs" });
  const module = { exports: {} as Record<string, unknown> };

  new Function("require", "exports", "module", code)(
    (specifier: string) => {
      if (!(specifier in modules))
        throw new Error(`Unexpected module: ${specifier}`);

      return modules[specifier];
    },
    module.exports,
    module
  );

  return module.exports;
}

describe("extractCalls configuration", () => {
  it.each([
    ["import", "././factory.ts", "binding"],
    ["import", "./alias.ts", "binding"],
    ["require", "././factory.ts", "binding"],
    ["import", "././factory.ts", "direct-require"],
    ["import", "./alias.ts", "direct-require"],
    ["require", "././factory.ts", "import-binding"]
  ] as const)(
    "checks canonical module mutation for %s via %s (%s)",
    (kind, alias, mutationKind) => {
      const selected =
        kind === "import"
          ? 'import { system } from "./factory.ts";'
          : 'const { system } = require("./factory.ts");';
      const mutation =
        mutationKind === "direct-require"
          ? `require("${alias}").system.css = () => "blue";`
          : mutationKind === "import-binding" || kind === "import"
            ? `import { system as changed } from "${alias}"; changed.css = () => "blue";`
            : `const { system: changed } = require("${alias}"); changed.css = () => "blue";`;
      const source = `${selected} ${mutation} export const cls = system.css();`;
      const project = fixture({
        "entry.ts": source,
        "factory.ts": 'export const system = { css: () => "red" };'
      });
      if (alias === "./alias.ts")
        symlinkSync(
          join(project.root, "factory.ts"),
          join(project.root, "alias.ts")
        );

      const module = { system: { css: () => "red" } };
      expect(
        executeModule(source, { "./factory.ts": module, [alias]: module }).cls
      ).toBe("blue");

      const transform = () =>
        project.transform("entry.ts", { "./factory.ts": ["system.css"] });
      if (kind === "require") {
        expect(transform).toThrow(/Cannot safely extract/);
      } else {
        const result = transform();
        expect(result.code).toContain("system.css()");
        expect(result.result[1]).not.toContain("system.css()");
        expect(
          executeModule(result.code, {
            "./factory.ts": module,
            [alias]: module
          }).cls
        ).toBe("blue");
      }
    }
  );

  it.each(["read-only-alias", "different-module"])(
    "preserves canonical module %s controls",
    (control) => {
      const alias =
        control === "read-only-alias" ? "././factory.ts" : "./other.ts";
      const access =
        control === "read-only-alias"
          ? "const label = changed.color;"
          : 'changed.css = () => "blue";';
      const project = fixture({
        "entry.ts": `import { system } from "./factory.ts";
          import { system as changed } from "${alias}";
          ${access}
          export const cls = system.css();`,
        "factory.ts":
          'export const system = { color: "red", css: () => "red" };',
        "other.ts":
          'export const system = { color: "other", css: () => "other" };'
      });
      const result = project.transform("entry.ts", {
        "./factory.ts": ["system.css"]
      });

      expect(result.result[1]).toContain("system.css()");
      expect(result.code).not.toContain("system.css()");
    }
  );

  it.each(["import", "require"] as const)(
    "keeps canonical module identity specific to %s resolution",
    (kind) => {
      const source =
        kind === "import"
          ? `import { system } from "./factory.ts";
            import * as inspected from "test-preset";
            require("test-preset").system.css = () => "blue";
            const label = inspected.system.color;
            export const cls = system.css();`
          : `const { system } = require("./factory.ts");
            const inspected = require("test-preset");
            import { system as changed } from "test-preset";
            changed.css = () => "blue";
            const label = inspected.system.color;
            export const cls = system.css();`;
      const project = fixture({
        "entry.ts": source,
        "factory.ts":
          'export const system = { color: "red", css: () => "red" };',
        "other.ts":
          'export const system = { color: "other", css: () => "other" };'
      });
      const extractCalls = { "./factory.ts": ["system.css"] };
      const analysis = analyzeExtractCalls({
        extractCalls,
        root: project.root,
        filename: join(project.root, "entry.ts"),
        source
      });
      let step = analysis.next();

      while (!step.done) {
        const request = step.value;
        if (request.kind === "load") {
          step = analysis.next(readFileSync(request.id, "utf8"));
        } else if (request.kind === "resolve") {
          const file =
            request.source === "test-preset"
              ? request.mode === kind
                ? "factory.ts"
                : "other.ts"
              : request.source;
          step = analysis.next(join(project.root, file));
        } else {
          throw new Error(`Unexpected analysis request: ${request.kind}`);
        }
      }

      const result = babelTransform(source, {
        extractCalls,
        preparedExtractCalls: step.value
      } as Omit<PluginOptions, "result">);
      expect(result.result[1]).toContain("system.css()");
      expect(result.code).not.toContain("system.css()");
    }
  );

  it.each([
    ["same module", "factory.ts", false],
    ["different module", "other.ts", true],
    ["unknown module", null, true]
  ] as const)(
    "checks canonical module aliases for package registration: %s",
    (_label, aliasTarget, extracted) => {
      const source = `import { system } from "test-preset";
        import { system as changed } from "alias-preset";
        changed.css = () => "blue";
        export const cls = system.css();`;
      const project = fixture({
        "entry.ts": source,
        "factory.ts": 'export const system = { css: () => "red" };',
        "other.ts": 'export const system = { css: () => "other" };'
      });
      const extractCalls = { "test-preset": ["system.css"] };
      const prepare = (aliasFile: string | null, input = source) => {
        const analysis = analyzeExtractCalls({
          extractCalls,
          root: project.root,
          filename: join(project.root, "entry.ts"),
          source: input
        });
        let step = analysis.next();

        while (!step.done) {
          const request = step.value;
          if (request.kind !== "resolve")
            throw new Error(`Unexpected analysis request: ${request.kind}`);

          const file =
            request.source === "test-preset" ? "factory.ts" : aliasFile;
          step = analysis.next(file ? join(project.root, file) : null);
        }

        return step.value;
      };
      const result = babelTransform(source, {
        extractCalls,
        preparedExtractCalls: prepare(aliasTarget)
      } as Omit<PluginOptions, "result">);
      expect(result.result[1].includes("system.css()")).toBe(extracted);
      expect(result.code.includes("system.css()")).toBe(!extracted);

      if (aliasTarget === "factory.ts") {
        const readOnly = source.replace(
          'changed.css = () => "blue";',
          "changed.css;"
        );
        const sidecar = (aliasFile: string) =>
          babelTransform(readOnly, {
            extractCalls,
            preparedExtractCalls: prepare(aliasFile, readOnly)
          } as Omit<PluginOptions, "result">).result[0];

        expect(sidecar("factory.ts")).not.toBe(sidecar("other.ts"));
      }
    }
  );

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

  it.each([
    {
      label: "registered imports",
      source:
        'import { css } from "test-preset"; export const value = css({ padding: 12 });',
      options: { extractCalls: { "test-preset": ["css"] } }
    },
    {
      label: "configured JSX css",
      source: "export const Component = () => <div css={{ padding: 12 }} />;",
      options: { jsxCssProp: { importSource: "test-preset" } }
    }
  ])(
    "isolates sidecar owner fingerprints for $label",
    ({ source, options }) => {
      const files = { "first.tsx": source, "second.tsx": source };
      const original = fixture(files);
      const relocated = fixture(files);
      const transform = (root: string, file: string) =>
        babelTransform(source, options, { root, filename: join(root, file) })
          .result;

      const first = transform(original.root, "first.tsx");
      const second = transform(original.root, "second.tsx");

      expect(first[0]).not.toBe(second[0]);
      expect(transform(original.root, "first.tsx")).toEqual(first);
      expect(transform(original.root, "second.tsx")).toEqual(second);
      expect(transform(relocated.root, "first.tsx")).toEqual(first);
      expect(transform(relocated.root, "second.tsx")).toEqual(second);
    }
  );

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

  it.each([
    [
      "ignored statement with a named import",
      'import { system } from "test-preset";',
      "system",
      "/* mincho-js-ignore */ system.configure();",
      true,
      false
    ],
    [
      "ignored call with a namespace import",
      'import * as preset from "test-preset";',
      "preset.system",
      "const configured = /* mincho-js-ignore */ preset.system.configure();",
      true,
      false
    ],
    [
      "registered calls without ignore",
      'import { system } from "test-preset";',
      "system",
      "system.configure();",
      true,
      true
    ],
    [
      "an unregistered configuration call",
      'import * as preset from "test-preset";',
      "preset.system",
      "preset.system.configure();",
      false,
      false
    ]
  ] as const)(
    "preserves namespace changes before CSS generation: %s",
    (_, declaration, callee, configure, registered, extracted) => {
      const source = `${declaration}
        ${configure}
        export const cls = ${callee}.css();`;
      const { code, result } = babelTransform(source, {
        extractCalls: {
          "test-preset": registered
            ? ["system.configure", "system.css"]
            : ["system.css"]
        }
      });
      const createPreset = (events: string[]) => ({
        system: {
          color: "red",
          configure() {
            this.color = "blue";
            events.push(`configure:${this.color}`);
          },
          css() {
            events.push(`css:${this.color}`);
            return `color-${this.color}`;
          }
        }
      });
      const originalEvents: string[] = [];
      const original = executeModule(source, {
        "test-preset": createPreset(originalEvents)
      });
      const buildEvents: string[] = [];
      const sidecar = executeModule(result[1], {
        "test-preset": createPreset(buildEvents)
      });
      const runtimeEvents: string[] = [];
      const runtime = executeModule(code, {
        "test-preset": createPreset(runtimeEvents),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe("color-blue");
      expect(runtime.cls).toBe(original.cls);
      expect(originalEvents).toEqual(["configure:blue", "css:blue"]);
      expect(buildEvents).toEqual(extracted ? originalEvents : []);
      expect(runtimeEvents).toEqual(extracted ? [] : originalEvents);
    }
  );

  it.each([
    "/* mincho-js-ignore */ system.configure();",
    "const configured = /* mincho-js-ignore */ system.configure();"
  ])("diagnoses namespace changes from ignored CommonJS calls: %s", (usage) => {
    expect(() =>
      babelTransform(
        `const { system } = require("test-preset");
        ${usage}
        export const cls = system.css();`,
        { extractCalls: { "test-preset": ["system.configure", "system.css"] } }
      )
    ).toThrow(/Cannot safely extract.*[Ee]scaped CommonJS namespace system/);
  });

  it.each([
    ['require("test-preset").system.css = replacement;', "before"],
    ['require("test-preset").system.css = replacement;', "after"],
    ['require("test-preset").system.color = "blue";', "before"],
    ['delete require("test-preset").system.css;', "before"],
    ['configure(require("test-preset").system);', "before"],
    [
      'function update() { configure(require("test-preset").system); } update();',
      "after"
    ]
  ])(
    "rejects a direct require owner mutation or escape: %s %s",
    (usage, order) => {
      const call = "export const cls = system.css();";
      const source = `const { system } = require("test-preset");
      const replacement = () => "replaced";
      function configure(value) { value.color = "blue"; }
      ${order === "before" ? `${usage}\n${call}` : `${call}\n${usage}`}`;

      expect(() =>
        babelTransform(source, {
          extractCalls: { "test-preset": ["system.css"] }
        })
      ).toThrow(
        /Cannot safely extract.*(?:[Mm]utated|[Ee]scaped) CommonJS namespace/
      );
    }
  );

  it.each([
    [
      "bound require mutation",
      "import",
      'const changed = require("test-preset"); changed.system.color = "blue";'
    ],
    [
      "direct require mutation",
      "import",
      'require("test-preset").system.color = "blue";'
    ],
    [
      "require escape",
      "import",
      'const changed = require("test-preset"); configure(changed.system);'
    ],
    [
      "named import mutation",
      "require",
      'import { system as changed } from "test-preset"; changed.color = "blue";'
    ],
    [
      "namespace import mutation",
      "require",
      'import * as changed from "test-preset"; changed.system.color = "blue";'
    ],
    [
      "import escape",
      "require",
      'import { system as changed } from "test-preset"; configure(changed);'
    ]
  ])("keeps mixed module access unsafe for %s", (_name, kind, mutation) => {
    const owner =
      kind === "import"
        ? 'import { system } from "test-preset";'
        : 'const { system } = require("test-preset");';
    const source = `${owner}
      function configure(value) { value.color = "blue"; }
      ${mutation}
      export const cls = system.css();`;
    const transform = () =>
      babelTransform(source, {
        extractCalls: { "test-preset": ["system.css"] }
      });

    if (kind === "require") {
      expect(transform).toThrow(
        /Cannot safely extract.*(?:[Mm]utated|[Ee]scaped) CommonJS namespace/
      );
    } else {
      const { code, result } = transform();
      expect(code).toContain("system.css()");
      expect(result[1]).not.toContain("system.css()");
      const system = {
        color: "red",
        css() {
          return `color-${this.color}`;
        }
      };
      expect(executeModule(code, { "test-preset": { system } })).toEqual({
        cls: "color-blue"
      });
    }
  });

  it.each(["import", "require"])(
    "allows mixed module access to an unrelated owner for a %s consumer",
    (kind) => {
      const owner =
        kind === "import"
          ? 'import { system } from "test-preset";'
          : 'const { system } = require("test-preset");';
      const mutation =
        kind === "import"
          ? 'const changed = require("test-preset"); changed.dark.color = "blue";'
          : 'import { dark as changed } from "test-preset"; changed.color = "blue";';
      const { code, result } = babelTransform(
        `${owner}
        ${mutation}
        export const cls = system.css();`,
        {
          extractCalls: { "test-preset": ["system.css"] }
        }
      );
      expect(result[1]).toContain("system.css()");
      expect(code).not.toContain("system.css()");
    }
  );

  it.each([
    ["import", "namespace.system.color = 'blue';"],
    ["require", "namespace.system.color = 'blue';"],
    ["import", "change(namespace.system);"],
    ["require", "change(namespace.system);"]
  ])(
    "keeps shared re-exports unsafe across separate %s entries: %s",
    (kind, mutation) => {
      const owner =
        kind === "import"
          ? 'import { system } from "test-preset"; const namespace = require("test-preset");'
          : 'import * as namespace from "test-preset"; const { system } = require("test-preset");';
      const source = `${owner}
        function change(value) { value.color = 'blue'; }
        ${mutation}
        export const cls = system.css();`;
      const sharedSource =
        'exports.system = { color: "red", css() { return `color-${this.color}`; } };';
      const importSource = 'export { system } from "./shared.cjs";';
      const requireSource = 'module.exports = require("./shared.cjs");';
      const project = fixture({
        "entry.ts": source,
        "shared.cjs": sharedSource,
        "import.js": importSource,
        "require.cjs": requireSource
      });
      const shared = executeModule(sharedSource, {});
      const imported = executeModule(importSource, { "./shared.cjs": shared });
      const required = executeModule(requireSource, { "./shared.cjs": shared });
      expect(imported.system).toBe(required.system);
      expect(executeModule(source, { "test-preset": imported }).cls).toBe(
        "color-blue"
      );

      const extractCalls = { "test-preset": ["system.css"] };
      const analysis = analyzeExtractCalls({
        extractCalls,
        root: project.root,
        filename: join(project.root, "entry.ts"),
        source
      });
      let step = analysis.next();
      while (!step.done) {
        const request = step.value;
        if (request.kind === "load") {
          step = analysis.next(readFileSync(request.id, "utf8"));
        } else if (request.kind === "resolve") {
          expect(request.source).toBe("test-preset");
          step = analysis.next(
            join(
              project.root,
              request.mode === "require" ? "require.cjs" : "import.js"
            )
          );
        } else {
          throw new Error(`Unexpected analysis request: ${request.kind}`);
        }
      }

      const preparedExtractCalls = step.value;
      const options: Omit<PluginOptions, "result"> = {
        extractCalls,
        preparedExtractCalls
      };
      const transform = () => babelTransform(source, options);
      if (kind === "require") {
        expect(transform).toThrow(/Cannot safely extract/);
      } else {
        const result = transform();
        expect(result.code).toContain("system.css()");
        expect(result.result[1]).not.toContain("system.css()");
        expect(
          executeModule(result.code, { "test-preset": imported }).cls
        ).toBe("color-blue");
      }
    }
  );

  it.each(["import", "require"])(
    "checks mixed %s mutations conservatively even for independent entries",
    (kind) => {
      const owner =
        kind === "import"
          ? 'import { system } from "test-preset";'
          : 'const { system } = require("test-preset");';
      const mutation =
        kind === "import"
          ? 'require("test-preset").system.color = "blue";'
          : 'import { system as changed } from "test-preset"; changed.color = "blue";';
      const source = `${owner} ${mutation} export const cls = system.css();`;
      const importSource =
        'export const system = { color: "red", css() { return `color-${this.color}`; } };';
      const requireSource =
        'exports.system = { color: "red", css() { return `color-${this.color}`; } };';
      const project = fixture({
        "entry.ts": source,
        "import.js": importSource,
        "require.cjs": requireSource
      });
      const imported = executeModule(importSource, {});
      const required = executeModule(requireSource, {});
      expect(imported.system).not.toBe(required.system);

      const extractCalls = { "test-preset": ["system.css"] };
      const prepare = (source: string) => {
        const analysis = analyzeExtractCalls({
          extractCalls,
          root: project.root,
          filename: join(project.root, "entry.ts"),
          source
        });
        let step = analysis.next();

        while (!step.done) {
          const request = step.value;
          if (request.kind === "load") {
            step = analysis.next(readFileSync(request.id, "utf8"));
          } else if (request.kind === "resolve") {
            expect(request.source).toBe("test-preset");
            step = analysis.next(
              join(
                project.root,
                request.mode === "require" ? "require.cjs" : "import.js"
              )
            );
          } else {
            throw new Error(`Unexpected analysis request: ${request.kind}`);
          }
        }

        return step.value;
      };
      // Different entry files alone cannot prove that their exports are distinct.
      const options: Omit<PluginOptions, "result"> = {
        extractCalls,
        preparedExtractCalls: prepare(source)
      };
      const transform = () => babelTransform(source, options);
      if (kind === "require") {
        expect(transform).toThrow(
          /Cannot safely extract.*[Mm]utated CommonJS namespace/
        );
      } else {
        const result = transform();
        expect(result.code).toContain("system.css()");
        expect(result.result[1]).not.toContain("system.css()");
      }

      const readOnly = source.replace(
        mutation,
        kind === "import"
          ? 'const label = require("test-preset").system.color;'
          : 'import { system as inspected } from "test-preset"; const label = inspected.color;'
      );
      const readOnlyOptions: Omit<PluginOptions, "result"> = {
        extractCalls,
        preparedExtractCalls: prepare(readOnly)
      };
      const result = babelTransform(readOnly, readOnlyOptions);
      expect(result.result[1]).toContain("system.css()");
      expect(result.code).not.toContain("system.css()");
    }
  );

  it("checks direct require calls without any namespace declaration", () => {
    expect(() =>
      babelTransform(
        `require("test-preset").system.color = "blue";
         export const cls = require("test-preset").system.css();`,
        { extractCalls: { "test-preset": ["system.css"] } }
      )
    ).toThrow(/Cannot safely extract.*[Mm]utated CommonJS namespace/);
  });

  it.each([
    'require("test-preset").dark.color = "blue"; configure(require("test-preset").dark);',
    'require("other-preset").system.color = "blue"; configure(require("other-preset").system);',
    'function update(require) { require("test-preset").system.color = "blue"; }',
    'require("test-preset");'
  ])(
    "preserves direct require reads unrelated to the extracted owner: %s",
    (usage) => {
      const source = `const { system } = require("test-preset");
      function configure(value) { value.color = "blue"; }
      ${usage}
      export const cls = system.css();`;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["system.css"] }
      });
      const createPreset = () => ({
        system: {
          color: "red",
          css() {
            return `color-${this.color}`;
          }
        },
        dark: { color: "black" }
      });
      const original = executeModule(source, {
        "test-preset": createPreset(),
        "other-preset": createPreset()
      });
      const sidecar = executeModule(result[1], {
        "test-preset": createPreset()
      });
      const runtime = executeModule(code, {
        "test-preset": createPreset(),
        "other-preset": createPreset(),
        [result[0]]: sidecar
      });

      expect(result[1]).toContain("system.css()");
      expect(code).not.toContain("system.css()");
      expect(runtime.cls).toBe(original.cls);
      expect(runtime.cls).toBe("color-red");
    }
  );

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

  it.each([false, true])(
    "preserves argument mutations by a registered call with runtime replacement=%s",
    (replaced) => {
      const source = `
      import { tools, system } from "test-preset";
      ${replaced ? 'tools.configure = (value) => { value.color = "blue"; };' : ""}
      tools.configure(system);
      export const cls = system.css();
    `;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-preset": ["tools.configure", "system.css"] }
      });
      const createPreset = () => ({
        tools: {
          configure: (value: { color: string }) => {
            value.color = "blue";
          }
        },
        system: {
          color: "red",
          css() {
            return `color-${this.color}`;
          }
        }
      });
      const original = executeModule(source, { "test-preset": createPreset() });
      const sidecar = executeModule(result[1], {
        "test-preset": createPreset()
      });
      const runtime = executeModule(code, {
        "test-preset": createPreset(),
        [result[0]]: sidecar
      });

      expect(original.cls).toBe("color-blue");
      expect(runtime.cls).toBe(original.cls);
      expect(code.includes("system.css()")).toBe(replaced);
      expect(result[1].includes("system.css()")).toBe(!replaced);
    }
  );
});

describe("local extractCalls implementations", () => {
  it.each([
    [
      "css(rule) { return this.helper(rule); }",
      "helper(rule) { return this.finish(rule); }, finish(rule) { return style(rule); }"
    ],
    [
      "css: function(rule) { return (() => this.helper(rule))(); }",
      "helper(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return this.helpers.paint(rule); }",
      "helpers: { paint(rule) { return style(rule); } }"
    ],
    [
      "css(rule) { return (this as typeof system).helper(rule); }",
      "helper(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return (<typeof system>this).helper(rule); }",
      "helper(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return this!.helper(rule); }",
      "helper(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return (this satisfies typeof system).helper(rule); }",
      "helper(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return ((this as typeof system).helpers as typeof system.helpers).paint(rule); }",
      "helpers: { paint(rule) { return style(rule); } }"
    ],
    [
      "css(rule) { return system.helper(rule); }",
      "helper(rule) { return this.finish(rule); }, finish(rule) { return style(rule); }"
    ],
    [
      "css(rule) { return this.helper(rule); }",
      "helper(rule) { return rule.recurse ? this.css({ ...rule, recurse: false }) : style(rule); }"
    ]
  ])(
    "protects statically reachable receiver helpers: %s",
    (method, helpers) => {
      const project = fixture({
        "factory.ts": `import { style } from "@vanilla-extract/css";
        export const system = {
          ${helpers},
          ${method},
          unrelated() { return style({ color: "green" }); }
        };`
      });
      const transformed = project.transform("factory.ts", {
        "./factory.ts": ["system.css"]
      });

      expect(transformed.code).toContain("style(rule)");
      expect(transformed.result[1]).toContain('color: "green"');
      expect(transformed.result[1]).not.toContain("style(rule)");

      const style = (rule: { color: string }) => rule.color;
      const imports = { "@vanilla-extract/css": { style } };
      const extracted = executeModule(transformed.result[1], imports);
      const output = executeModule(transformed.code, {
        ...imports,
        [transformed.result[0]]: extracted
      }) as {
        system: { css(rule: { color: string; recurse?: boolean }): string };
      };

      expect(output.system.css({ color: "red", recurse: true })).toBe("red");
    }
  );

  it("protects a shared method against each registered receiver", () => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const shared = function(rule) { return this.helper(rule); };
        export const system = {
          helper(rule) { return style(rule); },
          css: shared
        };
        export const alternate = {
          helper(rule) { return style({ ...rule, color: "blue" }); },
          css: shared
        };`
    });
    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["system.css", "alternate.css"]
    });
    const output = executeModule(transformed.code, {
      "@vanilla-extract/css": { style: (rule: { color: string }) => rule.color }
    }) as {
      system: { css(rule: { color: string }): string };
      alternate: { css(rule: { color: string }): string };
    };

    expect(output.system.css({ color: "red" })).toBe("red");
    expect(output.alternate.css({ color: "red" })).toBe("blue");
    expect(transformed.result[1]).not.toContain("style(");
  });

  it.each([
    "system.helper = replacement;",
    "const alias = system; alias.helper = replacement;",
    "let alias = {}; alias = system; alias.helper = replacement;",
    "let alias = {}; alias = system; const copy = alias; copy.helper = replacement;",
    "let alias = system; alias = {}; alias.helper = replacement;",
    "const { nested } = system; nested.helper = replacement;",
    "const { current: alias } = { current: system }; alias.helper = replacement;",
    "const { chosen: alias = system } = {}; alias.helper = replacement;",
    "let alias; ({ current: alias } = { current: system }); alias.helper = replacement;",
    "delete system.helper;"
  ])("rejects a receiver changed after its declaration: %s", (mutation) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const replacement = rule => style(rule);
        export const system = {
          helper(rule) { return style(rule); },
          nested: {},
          css(rule) { return this.helper(rule); }
        };
        ${mutation}`
    });

    expect(() =>
      project.transform("factory.ts", { "./factory.ts": ["system.css"] })
    ).toThrow("Cannot use mutated extractCalls receiver");
  });

  it.each([
    "Object.assign(system, { helper: replacement });",
    "Reflect.set(system, 'helper', replacement);",
    "replace(system);",
    "const alias = system; replace(alias);",
    "let alias = {}; alias = system; replace(alias);"
  ])("rejects an escaped receiver: %s", (escape) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const replacement = rule => style(rule);
        function replace(owner) { owner.helper = replacement; }
        export const system = {
          helper(rule) { return style(rule); },
          css(rule) { return this.helper(rule); }
        };
        ${escape}`
    });

    expect(() =>
      project.transform("factory.ts", { "./factory.ts": ["system.css"] })
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it("does not confuse writes to a separate object with the receiver", () => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const other = { helper: null };
        other.helper = () => 'other';
        export const system = {
          helper(rule) { return style(rule); },
          css(rule) { return this.helper(rule); }
        };`
    });
    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["system.css"]
    });

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(");
  });

  it("keeps copied receiver values and unrelated object arguments usable", () => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const identity = value => value;
        export const system = {
          themeClass: 'theme',
          helper(rule) { return style(rule); },
          css(rule) { return this.helper(rule); }
        };
        const label = system.themeClass;
        export const copied = identity(label);
        export const direct = identity(system.themeClass);
        export const unrelated = identity({ color: 'blue' });`
    });
    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["system.css"]
    });

    expect(transformed.code).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain("style(");
  });

  it.each([
    "const { themeClass: label } = system;",
    "const { themeClass } = system; const label = themeClass;",
    "const { tokens: { themeClass: label } } = system;",
    "const alias = system; const { themeClass: label } = alias;",
    "const { themeClass: label = 'fallback' } = system;",
    "const { chosen: label = 'theme' } = {};",
    "const { chosen: label = system } = { chosen: 'theme' };",
    "const { tokens: { themeClass: label = system } } = { tokens: { themeClass: 'theme' } };",
    "const { tokens: { themeClass: label } = { themeClass: 'theme' } } = {};",
    "const { themeClass: label } = system.tokens;",
    "const [label] = ['theme'];",
    "let label; ({ themeClass: label } = system);",
    "let label; ({ chosen: label = system } = { chosen: 'theme' });"
  ])("keeps a selected destructured receiver value: %s", (selection) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const identity = value => value;
        export const system = {
          themeClass: 'theme',
          tokens: { themeClass: 'theme' },
          css(rule) { return style(rule); }
        };
        ${selection}
        export const copied = identity(label);`
    });
    const transformed = project.transform("factory.ts", {
      "./factory.ts": ["system.css"]
    });
    const output = executeModule(transformed.code, {
      "@vanilla-extract/css": { style: (rule: { color: string }) => rule.color }
    }) as { copied: string; system: { css(rule: { color: string }): string } };

    expect(output.copied).toBe("theme");
    expect(output.system.css({ color: "red" })).toBe("red");
    expect(transformed.result[1]).not.toContain("style(");
  });

  it.each([
    "const { current: alias } = { current: system };",
    "const holder = { current: system }; const { current: alias } = holder;",
    "const holder = { nested: { current: system } }; const { nested: { current: alias } } = holder;",
    "let { themeClass: alias } = system; alias = system;",
    "let first; let second; first = second; second = first; first = system; const { current: alias } = { current: first };",
    "const { chosen: alias = system } = {};",
    "const { nested: { chosen: alias } = { chosen: system } } = {};",
    "const holder = { nested: { current: system } }; const { current: alias } = holder.nested;",
    "const [alias] = [system];",
    "let alias; ({ current: alias } = { current: system });",
    "let alias; ({ chosen: alias = system } = {});"
  ])("rejects an escaped destructured receiver object: %s", (selection) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const identity = value => value;
        export const system = {
          themeClass: 'theme',
          css(rule) { return style(rule); }
        };
        ${selection}
        identity(alias);`
    });

    expect(() =>
      project.transform("factory.ts", { "./factory.ts": ["system.css"] })
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it.each([
    "const { css, ...alias } = system;",
    "const key = 'themeClass'; const { [key]: alias } = system;",
    "const { computed: alias } = system;"
  ])("keeps uncertain receiver selections conservative: %s", (selection) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const identity = value => value;
        export const system = {
          themeClass: 'theme',
          get computed() { return 'theme'; },
          css(rule) { return style(rule); }
        };
        ${selection}
        identity(alias);`
    });

    expect(() =>
      project.transform("factory.ts", { "./factory.ts": ["system.css"] })
    ).toThrow("Cannot use escaped extractCalls receiver");
  });

  it.each([
    "this.helper",
    "(this as typeof system).helper",
    "(this.helper as typeof replacement)",
    "(this.helper satisfies typeof replacement)"
  ])("rejects replacement of a receiver helper: %s", (target) => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const replacement = rule => style(rule);
        export const system = {
          helper(rule) { return style(rule); },
          css(rule) { ${target} = replacement; return this.helper(rule); }
        };`
    });

    expect(() =>
      project.transform("factory.ts", { "./factory.ts": ["system.css"] })
    ).toThrow("Cannot use mutated extractCalls receiver");
  });

  it.each([
    "helperName: 'helper', css(rule) { return this[this.helperName](rule); }",
    "get helper() { return function(rule) { return style(rule); }; }, css(rule) { return this.helper(rule); }"
  ])(
    "rejects a receiver helper that cannot be resolved statically: %s",
    (members) => {
      const project = fixture({
        "factory.ts": `import { style } from "@vanilla-extract/css";
        export const system = { ${members} };`
      });

      expect(() =>
        project.transform("factory.ts", { "./factory.ts": ["system.css"] })
      ).toThrow("Cannot identify extractCalls receiver member");
    }
  );

  const extractCalls = { "./src/factory.ts": ["defineStyle", "default"] };

  it("parses a registered TypeScript dependency without its TSX owner's JSX plugin", () => {
    const project = fixture({
      "factory.ts": `export const make = (rule) => <const>{ color: "red", ...rule };`,
      "app.tsx":
        'import { make } from "./factory"; export const cls = make({ padding: 4 }); export const view = <div />;'
    });
    const { code, result } = project.transform("app.tsx", {
      "./factory.ts": ["make"]
    });

    expect(result[1]).toContain("make({");
    expect(code).not.toContain("make({");
    expect(code).toContain("<div />");
  });

  it.each([false, true])(
    "resolves local nested registrations through an object export with reexport=%s",
    (reexport) => {
      const project = fixture({
        "factory.ts": `import { style } from "@vanilla-extract/css";
        const definition = { css(rule) { return style(rule); } };
        export { definition as system };
        export const standalone = style({ color: "pink" });`,
        "barrel.ts": 'export { system } from "./factory";',
        "app.ts": `import { system } from "./${reexport ? "barrel" : "factory"}";
        export const cls = system.css({ color: "red" });`
      });
      const config = {
        [reexport ? "./barrel.ts" : "./factory.ts"]: ["system.css"]
      };
      const caller = project.transform("app.ts", config);
      const factory = project.transform("factory.ts", config);

      expect(caller.result[1]).toContain('color: "red"');
      expect(caller.code).not.toContain('color: "red"');
      expect(factory.code).toContain("style(rule)");
      expect(factory.result[1]).not.toContain("style(rule)");
      expect(factory.result[1]).toContain('color: "pink"');
    }
  );

  it("preserves literal dotted export names in local registrations", () => {
    const project = fixture({
      "factory.ts": `import { style } from "@vanilla-extract/css";
        const make = (rule) => style(rule);
        export { make as "system.css" };`,
      "app.ts":
        'import { "system.css" as make } from "./factory"; export const cls = make({ color: "red" });'
    });
    const { code, result } = project.transform("app.ts", {
      "./factory.ts": ["system.css"]
    });

    expect(result[1]).toContain('color: "red"');
    expect(code).not.toContain('color: "red"');
  });

  it.each([false, true])(
    "protects both literal dotted exports and member implementations with receiver helper=%s",
    (helper) => {
      const project = fixture({
        "factory.ts": `import { style } from "@vanilla-extract/css";
          const literal = rule => style(rule);
          export { literal as "system.css" };
          export const system = {
            ${helper ? "helper(rule) { return style(rule); }," : ""}
            css(rule) { return ${helper ? "this.helper(rule)" : "style(rule)"}; }
          };`,
        "app.ts": `import { "system.css" as make, system } from "./factory";
          export const literal = make({ color: "red" });
          export const member = system.css({ color: "blue" });`
      });
      const config = { "./factory.ts": ["system.css"] };
      const factory = project.transform("factory.ts", config);

      expect(factory.result[1]).toBe("");

      const calls: string[] = [];
      const definitions = executeModule(factory.code, {
        "@vanilla-extract/css": {
          style(rule: { color: string }) {
            calls.push(rule.color);
            return `class-${rule.color}`;
          }
        }
      });
      const caller = project.transform("app.ts", config);
      const classes = executeModule(caller.result[1], {
        "./factory": definitions
      });

      expect(Object.values(classes)).toEqual(["class-red", "class-blue"]);
      expect(calls).toEqual(["red", "blue"]);
      expect(caller.code).not.toContain("make({");
      expect(caller.code).not.toContain("system.css({");
    }
  );

  it("extracts a TypeScript dependency from a Flow owner", () => {
    const source = `import { make } from "./factory.ts";
      type Props = {| padding: number |};
      export const value = make({ padding: 4 });`;
    const project = fixture({
      "factory.ts": "export const make = rule => <const>{ ...rule };",
      "app.jsx": source
    });
    const options: PluginOptions = {
      result: ["", ""],
      extractCalls: { "./factory.ts": ["make"] },
      optimize: { pureFunctions: false }
    };
    const transformed = transformSync(source, {
      filename: join(project.root, "app.jsx"),
      root: project.root,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["flow", "jsx"] },
      plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]]
    });

    expect(transformed?.code).not.toContain("make({");
    expect(options.result[1]).toContain("padding: 4");
  });

  it("resolves deeper CommonJS object registrations through local aliases", () => {
    const project = fixture({
      "factory.cjs": `const { style } = require("@vanilla-extract/css");
        const make = (rule) => style(rule);
        const methods = { css: make };
        exports.system = { styles: methods };`,
      "app.ts":
        'const { system } = require("./factory.cjs"); export const cls = system.styles.css({ color: "red" });'
    });
    const config = { "./factory.cjs": ["system.styles.css"] };
    const caller = project.transform("app.ts", config);
    const factory = project.transform("factory.cjs", config);

    expect(caller.result[1]).toContain('color: "red"');
    expect(caller.code).not.toContain('color: "red"');
    expect(factory.code).toContain("style(rule)");
    expect(factory.result[1]).not.toContain("style(rule)");
  });

  it.each([
    "export const system = { ...dynamic, css: (rule) => rule };",
    "export const system = { [method]: (rule) => rule };",
    "export const system = { get css() { return (rule) => rule; } };"
  ])("rejects unproven local object implementations: %s", (factory) => {
    const project = fixture({
      "factory.ts": factory,
      "app.ts":
        'import { system } from "./factory"; export const cls = system.css({});'
    });

    expect(() =>
      project.transform("app.ts", { "./factory.ts": ["system.css"] })
    ).toThrow(/Cannot statically identify a function implementation/);
  });

  it("forwards configured parser plugins to registered dependencies", () => {
    const source =
      'import { make } from "./factory.ts"; export const value = make({ color: "red" });';
    const project = fixture({
      "factory.ts": `
        export @sealed class Factory {}
        export const make = (rule) => rule;
      `,
      "app.ts": source
    });
    const options: PluginOptions = {
      result: ["", ""],
      extractCalls: { "./factory.ts": ["make"] },
      optimize: { pureFunctions: false }
    };
    const transformed = transformSync(source, {
      filename: join(project.root, "app.ts"),
      root: project.root,
      babelrc: false,
      configFile: false,
      parserOpts: {
        plugins: [["decorators", { decoratorsBeforeExport: false }]]
      },
      plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]]
    });

    expect(transformed?.code).not.toContain("make({");
    expect(options.result[1]).toContain("make({");
    expect(options.result[1]).toContain('color: "red"');
  });

  it("leaves dynamic inline members of external CommonJS factories alone", () => {
    const project = fixture({
      "factory.cjs":
        'exports.make = (rule) => require("external-styles")[rule.kind](rule);',
      "app.ts":
        'import { make } from "./factory.cjs"; export const value = make({ color: "red" });'
    });
    const config = { "./factory.cjs": ["make"] };

    expect(project.transform("app.ts", config).result[1]).toContain("make({");
    expect(project.transform("factory.cjs", config).code).toContain(
      'require("external-styles")[rule.kind](rule)'
    );
  });

  it("still rejects dynamic inline members of local CommonJS factories", () => {
    const project = fixture({
      "factory.cjs":
        'exports.make = (rule) => require("./helpers.cjs")[rule.kind](rule);',
      "helpers.cjs": 'exports.make = (rule) => "class";',
      "app.ts":
        'import { make } from "./factory.cjs"; export const value = make({});'
    });

    expect(() =>
      project.transform("app.ts", { "./factory.cjs": ["make"] })
    ).toThrow(/Dynamic CommonJS member/);
  });

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

import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { babelTransform } from "./testUtils/plugin.js";
import { transformWithEsbuild } from "vite";
import { transformSync as transformModule } from "esbuild";
import { transformSync } from "@babel/core";
import { minchoBabelPlugin } from "./index.js";
import { styledComponentPlugin } from "./styled.js";
import { typescriptPresetPath } from "./testUtils/babel.js";
import { inspectCommonJs } from "./commonjs/esm.js";
import {
  getExtractionModuleReference,
  hasLocalValueMutation,
  type ModuleReference
} from "./commonjs/bindings.js";
import { parseModuleProgram } from "./moduleGraph.js";
import type { ProgramScope } from "./types.js";
import type { PreparedExtractCalls } from "./extractionCalls/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function transform(source: string, extractCalls?: Record<string, string[]>) {
  return babelTransform(
    source,
    { extractCalls },
    { filename: "test.cjs", sourceType: "unambiguous" }
  );
}

function fixture(
  files: Record<string, string>,
  registrations: Record<string, string[]> = { "./factory.cjs": ["make"] }
) {
  mkdirSync(".cache", { recursive: true });

  const root = mkdtempSync(join(process.cwd(), ".cache", "cjs-"));
  roots.push(root);

  for (const [name, source] of Object.entries(files))
    writeFileSync(join(root, name), source);

  return (file: string) =>
    babelTransform(
      readFileSync(join(root, file), "utf8"),
      { extractCalls: registrations },
      { filename: join(root, file), root, sourceType: "unambiguous" }
    );
}

function executeFixture(files: Record<string, string>, entry = "entry.ts") {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const load = (name: string): Record<string, unknown> => {
    const id = name.replace(/^\.\//, "");
    const previous = cache.get(id);
    if (previous) return previous.exports;
    if (!(id in files)) throw new Error(`Unexpected module ${id}`);
    const module = { exports: {} as Record<string, unknown> };
    cache.set(id, module);
    const { code } = transformModule(files[id], { format: "cjs" });
    new Function("require", "exports", "module", code)(
      load,
      module.exports,
      module
    );
    return module.exports;
  };
  return load(entry);
}

describe("CommonJS extraction", () => {
  it.each([false, true])(
    "shares extracted values between registered calls and CommonJS exports, forwarding=%s",
    (forwarding) => {
      const source = `const {makeStyle, makeRecipe} = require('./custom.cjs');
      const className = makeStyle('red');
      const button = makeRecipe(className);
      exports.className = className;
      exports.button = button;`;
      const implementation = `exports.makeStyle = value => value;
      function makeRecipe(value) { return value + '-button'; }
      exports.makeRecipe = makeRecipe;
      exports.local = makeRecipe('local');`;
      const custom = forwarding
        ? `const implementation = require('./implementation.cjs');
        Object.defineProperty(exports, 'makeStyle', {
          enumerable: true, get: function () { return implementation.makeStyle; }
        });
        Object.defineProperty(exports, 'makeRecipe', {
          enumerable: true, get: function () { return implementation.makeRecipe; }
        });`
        : implementation;
      const files = {
        "entry.ts": source,
        "custom.cjs": custom,
        "implementation.cjs": implementation
      };
      const { code, result } = fixture(files, {
        "./custom.cjs": ["makeStyle", "makeRecipe"]
      })("entry.ts");
      const original = executeFixture(files);
      const compiled = executeFixture({
        ...files,
        "entry.ts": code,
        [result[0]]: result[1]
      });

      expect(compiled).toEqual(original);
      expect(compiled.button).toBe("red-button");
      expect(result[1]).toContain("makeRecipe(className)");
      expect(result[1]).not.toContain(result[0]);
    }
  );

  it("rejects an unproved spread of a registered method receiver", () => {
    const source = `const { system } = require('custom');
      const copy = { ...system };
      exports.color = system.css();`;
    const custom = `let color = 'red'; exports.system = {
      css() { return color; },
      get trigger() { color = 'blue'; return true; }
    };`;
    expect(executeFixture({ "entry.ts": source, custom }).color).toBe("blue");
    // A method identity does not certify every property copied by the spread.
    expect(() => transform(source, { custom: ["system.css"] })).toThrow(
      /Cannot safely extract/
    );
  });

  it("preserves getter reads owned by successive extracted calls", () => {
    const source = `const { first, second } = require('custom');
      exports.color = first();
      exports.reads = second();`;
    const custom = `let color = 'red'; const reads = [];
      Object.defineProperty(exports, 'first', {
        get() { reads.push('first'); return () => color; }
      });
      Object.defineProperty(exports, 'second', {
        get() { reads.push('second'); color = 'blue'; return () => reads.join(','); }
      });`;
    const { code, result } = transform(source, { custom: ["first", "second"] });
    const original = executeFixture({ "entry.ts": source, custom });
    const compiled = executeFixture({
      "entry.ts": code,
      custom,
      [result[0]]: result[1]
    });

    expect(original).toEqual({ color: "blue", reads: "first,second" });
    expect(compiled).toEqual(original);
  });

  it.each([
    "",
    "/* mincho-js-ignore */ second();",
    "if (flag) second();",
    "let value = 'red'; value = 'blue'; second(value);",
    "if (flag) { var value = 'blue'; } second(value);",
    "second(); exports.later = () => second();",
    "exports.second = second;",
    "const alias = second; alias();"
  ])("rejects unowned sibling getter reads: %s", (usage) => {
    expect(() =>
      transform(
        `const { first, second } = require('custom');
      exports.color = first(); ${usage}`,
        { custom: ["first", "second"] }
      )
    ).toThrow(/Cannot safely extract/);
  });

  it.each([
    "void typeof system.trigger;",
    "void !system.trigger;",
    "if (system.trigger) {}",
    "system.trigger && 0;",
    "const observed = system.trigger;"
  ])(
    "preserves consumer getter reads beside an extracted method: %s",
    (read) => {
      const files = {
        custom: `let color = 'red';
        exports.system = {
          css() { return color; },
          get trigger() { color = 'blue'; return 1; }
        };`,
        "entry.ts": `const { system } = require('custom');
        ${read}
        exports.color = system.css();`
      };
      expect(executeFixture(files)).toEqual({ color: "blue" });
      expect(() =>
        transform(files["entry.ts"], { custom: ["system.css"] })
      ).toThrow(/Cannot safely extract/);
    }
  );

  it.each(["<system.trigger />", "<div className={system.trigger} />"])(
    "rejects unowned JSX getter reads: %s",
    (jsx) => {
      expect(() =>
        babelTransform(
          `const { system } = require('custom');
         const view = ${jsx};
         exports.color = system.css();`,
          { extractCalls: { custom: ["system.css"] } }
        )
      ).toThrow(/Cannot safely extract/);
    }
  );

  it.each([
    `Object.defineProperty(exports, 'api', {set(value) {value.css = () => 'blue'}});`,
    `const exports = {set api(value) {value.css = () => 'blue'}};`,
    `opaque(exports);`,
    `exports = opaque();`
  ])("keeps observable CommonJS publications unsafe: %s", (setup) => {
    expect(() =>
      transform(
        `const {system} = require('custom');
        ${setup}
        exports.api = system;
        exports.color = system.css();`,
        { custom: ["system.css"] }
      )
    ).toThrow(/Cannot safely extract/);
  });

  describe("immutable namespace certificates", () => {
    type Metadata = NonNullable<PreparedExtractCalls["exportOrigins"]>[string];
    const metadata = (ownDataPaths: readonly string[]): Metadata => ({
      exports: { '["box"]': "independent", '["other"]': "other" },
      unknownExports: ['["box","alias"]', '["other","alias"]'],
      ownDataPaths,
      esModule: false
    });
    const prepare = (source: string, wrapper: Metadata) => {
      const program = parseModuleProgram(
        "/project/proof.cjs",
        `const { system } = require('factory'); ${source} system.css();`
      );
      const scope = program.scope as ProgramScope;
      scope.minchoData = {
        imports: new Map(),
        bindings: [],
        nodes: [],
        cssFile: "",
        extractCalls: {
          imports: {},
          localBindings: [],
          fingerprint: "",
          protectedFunctions: [],
          dependencies: [],
          resolvedSources: {
            import: {},
            require: { factory: "/factory", wrapper: "/wrapper" }
          },
          exportOrigins: {
            "/factory": {
              exports: { '["system"]': "receiver" },
              esModule: false
            },
            "/wrapper": wrapper
          }
        }
      };
      const inspect = () => {
        let reference: ModuleReference | null | undefined;
        program.traverse({
          CallExpression(call) {
            const callee = call.get("callee");
            if (callee.matchesPattern("system.css"))
              reference = getExtractionModuleReference(callee, (value) =>
                value.matchesPattern("system.css")
              );
          }
        });
        expect(reference?.source).toBe("factory");
        return reference?.unsafe;
      };
      return { scope, inspect };
    };

    it("reuses immutable facts without carrying them across metadata or transform replacement", () => {
      let materializations = 0;
      const known: Metadata = {
        ...metadata(['["box","alias"]']),
        get closedDataPaths() {
          materializations++;
          return [];
        }
      };
      const { scope, inspect } = prepare(
        "const { box } = require('wrapper'); void typeof box.alias;",
        known
      );
      expect(inspect()).toBeUndefined();
      expect(inspect()).toBeUndefined();
      expect(materializations).toBe(1);

      const initial = scope.minchoData.extractCalls!;
      scope.minchoData.extractCalls = {
        ...initial,
        exportOrigins: { ...initial.exportOrigins, "/wrapper": metadata([]) }
      };
      expect(inspect()).toMatch(/Escaped/);
      scope.minchoData = { ...scope.minchoData, extractCalls: initial };
      expect(inspect()).toBeUndefined();
      expect(materializations).toBe(2);
    });

    it("keeps different member projections separate", () => {
      const { inspect } = prepare(
        `const { box, other } = require('wrapper');
         void typeof box.alias; void typeof other.alias;`,
        metadata(['["box","alias"]'])
      );
      // Only box.alias is an own data slot. Reusing its projection for other
      // would incorrectly hide an accessor-capable read.
      expect(inspect()).toMatch(/Escaped/);
    });

    it("keeps raw and synthetic-default representations separate", () => {
      const { inspect } = prepare(
        `function _interopRequireDefault(obj) {
          return obj && obj.__esModule ? obj : { default: obj };
        }
        const raw = require('wrapper');
        const wrapped = _interopRequireDefault(require('wrapper'));
        void typeof raw.box.alias;
        void typeof wrapped.default.box.alias;`,
        metadata(['["box"]', '["box","alias"]'])
      );
      expect(inspect()).toBeUndefined();
      expect(inspect()).toBeUndefined();
    });
  });

  it.each([
    "export const classes = { primary: themeClass };",
    "export const View = () => <Box className={themeClass} />;",
    "export const getMode = (key) => modeClasses[key];",
    'export const classes = "panel " + themeClass;'
  ])(
    "extracts flat named factories alongside unrelated export values: %s",
    (usage) => {
      const run = fixture(
        {
          "factory.ts": `
          export const css = rule => rule;
          export const themeClass = "theme";
          export const modeClasses = { dark: "dark-theme" };
        `,
          "entry.tsx": `
          import { css, themeClass, modeClasses } from './factory';
          ${usage}
          export const cls = css({ color: "red" });
        `
        },
        { "./factory.ts": ["css"] }
      );

      const result = run("entry.tsx");
      expect(result.result[1]).toContain('color: "red"');
      expect(result.code).not.toContain('color: "red"');
      expect(result.code).toContain(usage.split(" = ")[0]);
    }
  );

  it.each([
    "changed.settings.color = 'blue';",
    "consume(changed);",
    "namespace.css = replacement;",
    "consume(namespace);"
  ])(
    "keeps flat factory endpoint aliases and namespaces guarded: %s",
    (usage) => {
      const run = fixture(
        {
          "factory.ts": "export const css = rule => rule;",
          "entry.ts": `
          import { css, css as changed } from './factory';
          import * as namespace from './factory';
          ${usage}
          export const cls = css({ color: "red" });
        `
        },
        { "./factory.ts": ["css"] }
      );

      const result = run("entry.ts");
      expect(result.result[1]).toBe("");
      expect(result.code).toContain('color: "red"');
    }
  );

  it.each(["system", "renamed"])(
    "rejects shared receivers mutated through their original module behind %s barrels",
    (exportName) => {
      const run = fixture(
        {
          "factory.ts": "export const system = { css(rule) { return rule; } };",
          "barrel.ts": `export { system as ${exportName} } from './factory';`,
          "entry.ts": `
            import { ${exportName} as factory } from './barrel';
            import { system as changed } from './factory';
            changed.css = rule => ({ ...rule, color: 'blue' });
            export const cls = factory.css({ color: 'red' });
          `
        },
        { "./barrel.ts": [`${exportName}.css`] }
      );

      const result = run("entry.ts");
      expect(result.result[1]).toBe("");
      expect(result.code).toContain("factory.css({");
    }
  );

  it("allows independent receiver objects with matching member names", () => {
    const run = fixture(
      {
        "factory.ts": "export const system = { css(rule) { return rule; } };",
        "other.ts": "export const system = { css(rule) { return rule; } };",
        "entry.ts": `
          import { system } from './factory';
          import { system as changed } from './other';
          changed.css = rule => ({ ...rule, color: 'blue' });
          export const cls = system.css({ color: 'red' });
        `
      },
      { "./factory.ts": ["system.css"] }
    );

    expect(run("entry.ts").result[1]).toContain("color: 'red'");
  });

  it.each(["binding", "direct"])(
    "protects CommonJS interop synthetic default against raw %s mutation",
    (access) => {
      const run = fixture(
        {
          "entry.cjs": `
            function _interopRequireDefault(obj) {
              return obj && obj.__esModule ? obj : { default: obj };
            }
            const wrapped = _interopRequireDefault(require('factory-package'));
            const raw = require('factory-package');
            ${access === "binding" ? "raw" : "require('factory-package')"}.system.color = 'blue';
            exports.cls = wrapped.default.system.css({ color: 'red' });
          `
        },
        { "factory-package": ["default.system.css"] }
      );

      expect(() => run("entry.cjs")).toThrow(/[Mm]utated|[Ee]scaped/);
    }
  );

  it("allows unmutated CommonJS interop synthetic default", () => {
    const result = transform(
      `
        function _interopRequireDefault(obj) {
          return obj && obj.__esModule ? obj : { default: obj };
        }
        const wrapped = _interopRequireDefault(require('factory-package'));
        exports.cls = wrapped.default.system.css({ color: 'red' });
      `,
      { "factory-package": ["default.system.css"] }
    );

    expect(result.result[1]).toContain("color: 'red'");
  });

  describe("uncertain receiver origins through CommonJS interop", () => {
    const interop = `function _interopRequireDefault(obj) {
      return obj && obj.__esModule ? obj : { default: obj };
    }`;

    function inspectReference(
      source: string,
      {
        esModule = false,
        origins = {},
        unknownMembers = ["nested", "alias"],
        ownDataPaths = []
      }: {
        esModule?: boolean;
        origins?: Record<string, string>;
        unknownMembers?: string[];
        ownDataPaths?: string[];
      } = {}
    ) {
      let reference: ModuleReference | null | undefined;
      const program = parseModuleProgram("/project/reference.cjs", source);
      (program.scope as ProgramScope).minchoData = {
        imports: new Map(),
        bindings: [],
        nodes: [],
        cssFile: "",
        extractCalls: {
          imports: {},
          localBindings: [],
          fingerprint: "",
          protectedFunctions: [],
          dependencies: [],
          resolvedSources: {
            import: {},
            require: { factory: "/factory", wrapper: "/wrapper" }
          },
          exportOrigins: {
            "/factory": {
              exports: {
                '["system"]': "receiver",
                '["system","css"]': "method"
              },
              ownDataPaths: ['["system","css"]'],
              esModule: false
            },
            "/wrapper": {
              exports: origins,
              unknownExports: [JSON.stringify(unknownMembers)],
              ownDataPaths,
              esModule
            }
          }
        }
      };
      program.traverse({
        CallExpression(call) {
          const callee = call.get("callee");
          if (callee.matchesPattern("system.css"))
            reference = getExtractionModuleReference(callee, (value) =>
              value.matchesPattern("system.css")
            );
        }
      });
      expect(reference?.source).toBe("factory");
      return reference;
    }

    it.each([
      ["bound raw require", "const changed = require('wrapper');", "changed"],
      ["direct raw require", "", "require('wrapper')"],
      [
        "bound synthetic default",
        "const changed = _interopRequireDefault(require('wrapper')).default;",
        "changed"
      ],
      [
        "direct synthetic default",
        "",
        "_interopRequireDefault(require('wrapper')).default"
      ]
    ])("guards unknown metadata through %s", (_name, setup, receiver) => {
      const reference = inspectReference(`
        ${interop}
        const { system } = require('factory');
        ${setup}
        ${receiver}.nested.alias.css = () => 'blue';
        system.css();
      `);
      expect(reference?.unsafe).toMatch(/[Mm]utated|[Ee]scaped/);
    });

    it("keeps a real ESM default separate from an unknown named export", () => {
      const reference = inspectReference(
        `${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default;
        changed.nested.alias.css = () => 'blue';
        system.css();`,
        { esModule: true }
      );
      expect(reference?.unsafe).toBeUndefined();
    });

    it("guards a forced Node default even for an ESM-marked module", async () => {
      const { code } = await transformWithEsbuild(
        `import changed from 'wrapper';
        const { system } = require('factory');
        changed.nested.alias.css = () => 'blue';
        system.css();`,
        "entry.mts",
        { format: "cjs" }
      );
      expect(inspectReference(code, { esModule: true })?.unsafe).toMatch(
        /[Mm]utated|[Ee]scaped/
      );
    });

    it("allows readonly own-data access through an uncertain synthetic default", () => {
      const reference = inspectReference(
        `
        ${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default;
        void typeof changed.nested.alias;
        system.css();
      `,
        {
          origins: { '["nested"]': "independent" },
          ownDataPaths: ['["nested","alias"]']
        }
      );
      expect(reference?.unsafe).toBeUndefined();
    });

    it.each(
      [
        "require('wrapper')",
        "_interopRequireDefault(require('wrapper')).default"
      ].flatMap((namespace) =>
        [
          ["own data slot", "changed.alias = {};", false],
          ["nested mutation", "changed.alias.css = () => 'blue';", true],
          ["opaque escape", "consume(changed);", true]
        ].map(([name, action, unsafe]) => [namespace, name, action, unsafe])
      )
    )(
      "preserves independent container identity through %s: %s",
      (namespace, _name, action, unsafe) => {
        const reference = inspectReference(
          `${interop}
          const { system } = require('factory');
          const changed = ${namespace}.nested;
          ${action}
          system.css();`,
          {
            origins: { '["nested"]': "independent" },
            ownDataPaths: ['["nested","alias"]']
          }
        );
        expect(Boolean(reference?.unsafe)).toBe(unsafe);
      }
    );

    it("does not treat a known shared receiver as an independent container", () => {
      const reference = inspectReference(
        `${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default.nested;
        changed.mode = 'blue';
        system.css();`,
        {
          origins: { '["nested"]': "receiver" },
          unknownMembers: ["nested"]
        }
      );
      expect(reference?.unsafe).toMatch(/[Mm]utated|[Ee]scaped/);
    });

    it.each([
      ["replace copied slot", "changed.css = () => 'blue';", false],
      ["mutate shared function", "changed.css.mode = 'blue';", true],
      ["escape shared function", "consume(changed.css);", true]
    ])("tracks a copied function endpoint: %s", (_name, action, unsafe) => {
      const reference = inspectReference(
        `${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default.nested;
        ${action}
        system.css();`,
        {
          origins: {
            '["nested"]': "independent",
            '["nested","css"]': "method"
          },
          unknownMembers: ["nested", "css"],
          ownDataPaths: ['["nested","css"]']
        }
      );
      expect(Boolean(reference?.unsafe)).toBe(unsafe);
    });

    it.each(["binding", "direct"])(
      "preserves runtime styles after an uncertain %s default alias mutates",
      (access) => {
        const files: Record<string, string> = {
          "factory.ts": "export const system = { css: () => 'red' };",
          "wrapper.cjs": `const { system } = require('./factory.ts');
            exports.nested = { alias: true ? system : {} };`,
          "entry.ts": `${interop}
            import { system } from './factory.ts';
            const changed = _interopRequireDefault(require('./wrapper.cjs')).default;
            ${access === "binding" ? "changed" : "_interopRequireDefault(require('./wrapper.cjs')).default"}.nested.alias.css = () => 'blue';
            export const color = system.css();`
        };
        const run = fixture(files, { "./factory.ts": ["system.css"] });
        const { code, result } = run("entry.ts");
        const original = executeFixture(files);
        const compiled = executeFixture({
          ...files,
          "entry.ts": code,
          [result[0]]: result[1]
        });
        expect(original.color).toBe("blue");
        expect(compiled.color).toBe(original.color);
        expect(result[1]).toBe("");
      }
    );

    it.each([
      ["setter assignment", "changed.mode = 'blue';"],
      ["getter read", "void typeof changed.mode;"]
    ])(
      "does not infer an inert %s from allocation identity",
      (_name, action) => {
        const reference = inspectReference(
          `${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default.nested;
        ${action}
        system.css();`,
          {
            origins: { '["nested"]': "independent" },
            unknownMembers: ["nested"]
          }
        );
        expect(reference?.unsafe).toMatch(/[Mm]utated|[Ee]scaped/);
      }
    );

    it.each([
      [
        "setter",
        "set mode(value) { system.mode = value; }",
        "other.mode = 'blue';"
      ],
      [
        "getter",
        "get mode() { system.mode = 'blue'; return 0; }",
        "void typeof other.mode;"
      ]
    ])(
      "preserves runtime changes caused by an independent object's %s",
      (_name, descriptor, action) => {
        const files = {
          "factory.ts":
            "export const system = { mode: 'red', css() { return this.mode; } };",
          "wrapper.ts": `import { system } from './factory.ts'; export const other = { ${descriptor} };`,
          "entry.ts": `import { system } from './factory.ts';
          import { other } from './wrapper.ts';
          ${action}
          export const color = system.css();`
        };
        const { code, result } = fixture(files, {
          "./factory.ts": ["system.css"]
        })("entry.ts");
        expect(executeFixture(files).color).toBe("blue");
        expect(
          executeFixture({ ...files, "entry.ts": code, [result[0]]: result[1] })
            .color
        ).toBe("blue");
        expect(result[1]).toBe("");
      }
    );

    it.each(["delete changed.css;", "changed.css++;", "changed.css += other;"])(
      "does not reuse own-data certificates for descriptor-changing or coercing writes: %s",
      (action) => {
        const reference = inspectReference(
          `${interop}
        const { system } = require('factory');
        const changed = _interopRequireDefault(require('wrapper')).default.nested;
        ${action}
        system.css();`,
          {
            origins: {
              '["nested"]': "independent",
              '["nested","css"]': "method"
            },
            unknownMembers: ["nested", "css"],
            ownDataPaths: ['["nested","css"]']
          }
        );
        expect(reference?.unsafe).toMatch(/[Mm]utated|[Ee]scaped/);
      }
    );
  });

  it.each([
    ["parent slot replacement", "box.owner = {};", true],
    ["known own-data read", "void typeof box.owner;", false],
    ["unproven property read", "void typeof box.owner.current;", true],
    ["nested write", "box.owner.css = () => 'blue';", true],
    [
      "aliased nested write",
      "const alias = box.owner; alias.css = () => 'blue';",
      true
    ],
    ["tagged template escape", "tag`${box.owner}`;", true],
    ["JSX prop escape", "<Component value={box.owner} />;", true],
    ["JSX className escape", "<div className={box.owner} />;", true],
    ["export binding publication", "export { box };", false]
  ] as const)(
    "shares conservative local shape tracking for %s",
    (_name, action, mutated) => {
      const program = parseModuleProgram(
        "/project/value.tsx",
        `const box = { owner: {} }; ${action}`
      );
      expect(
        hasLocalValueMutation(
          program.scope.getBinding("box")!,
          new Set(['["owner"]'])
        )
      ).toBe(mutated);
    }
  );

  it.each([false, true])(
    "keeps an exported allocation's actual mutations separate from publication: %s",
    (mutated) => {
      const program = parseModuleProgram(
        "/project/value.ts",
        `export const box = { owner: {} };
        ${mutated ? "box.owner.css = () => 'blue';" : ""}`
      );
      expect(
        hasLocalValueMutation(
          program.scope.getBinding("box")!,
          new Set(['["owner"]'])
        )
      ).toBe(mutated);
    }
  );

  it.each(["named", "namespace", "escape"])(
    "protects original registered receivers through %s barrel aliases",
    (use) => {
      const run = fixture(
        {
          "factory.ts": "export const system = { css(rule) { return rule; } };",
          "barrel.ts": "export { system as renamed } from './factory';",
          "entry.ts": `
            import { system } from './factory';
            ${use === "namespace" ? "import * as barrel from './barrel';" : "import { renamed } from './barrel';"}
            ${use === "escape" ? "mutate(renamed);" : `${use === "namespace" ? "barrel.renamed" : "renamed"}.css = rule => rule;`}
            export const cls = system.css({ color: 'red' });
          `
        },
        { "./factory.ts": ["system.css"] }
      );

      const result = run("entry.ts");
      expect(result.result[1]).toBe("");
      expect(result.code).toContain("system.css({");
    }
  );

  describe.each(["esm", "commonjs"])(
    "local receiver copies in %s",
    (format) => {
      const cases = [
        [
          "replace an own property",
          "const copy = { ...system }; copy.css = () => {};",
          false
        ],
        [
          "delete an own property",
          "const copy = { ...system }; delete copy.css;",
          true
        ],
        ["reassign the copy", "let copy = { ...system }; copy = {};", false],
        [
          "replace an alias property",
          "const copy = { ...system }; const alias = copy; alias.settings = {};",
          false
        ],
        [
          "replace a repeated copy property",
          "const copy = { ...system }; const other = { ...copy }; other.settings = {};",
          false
        ],
        [
          "replace a container property",
          "const box = { system }; box.system = {};",
          false
        ],
        [
          "replace a nested copy property",
          "const box = { copy: { ...system } }; box.copy.settings = {};",
          false
        ],
        [
          "replace a destructured copy property",
          "const box = { copy: { ...system } }; const { copy } = box; copy.settings = {};",
          false
        ],
        [
          "replace an array-wrapped copy property",
          "const box = [{ ...system }]; box[0].settings = {};",
          false
        ],
        [
          "mutate a shared property",
          "const copy = { ...system }; copy.settings.color = 'blue';",
          true
        ],
        [
          "mutate a shared destructured property",
          "const copy = { ...system }; const { settings } = copy; settings.color = 'blue';",
          true
        ],
        [
          "mutate a shared alias property",
          "const copy = { ...system }; const alias = copy; alias.settings.color = 'blue';",
          true
        ],
        [
          "mutate a repeated copy property",
          "const copy = { ...system }; const other = { ...copy }; other.settings.color = 'blue';",
          true
        ],
        [
          "mutate an array-wrapped shared value",
          "const box = [{ ...system }]; box[0].settings.color = 'blue';",
          true
        ],
        [
          "escape a copy with shared values",
          "const copy = { ...system }; consume(copy);",
          true
        ],
        [
          "mutate the retained receiver",
          "const box = { system }; box.system.css = () => {};",
          true
        ],
        [
          "mutate a receiver after a copied sibling",
          "const box = { copy: { ...system }, original: system }; box.original.css = () => {};",
          true
        ],
        [
          "mutate a receiver before a copied sibling",
          "const box = { original: system, copy: { ...system } }; box.original.css = () => {};",
          true
        ]
      ] as const;

      it.each(cases)("%s", (_name, usage, guarded) => {
        const commonjs = format === "commonjs";
        const factory = commonjs ? "factory.cjs" : "factory.ts";
        const entry = commonjs ? "entry.cjs" : "entry.ts";
        const run = fixture(
          {
            [factory]: `${commonjs ? "exports.system =" : "export const system ="} {
            settings: { color: 'red' }, css(rule) { return rule; }
          };`,
            [entry]: `
            ${commonjs ? `const { system } = require('./${factory}');` : `import { system } from './${factory}';`}
            ${usage}
            ${commonjs ? "exports.cls =" : "export const cls ="} system.css({ color: 'red' });
          `
          },
          { [`./${factory}`]: ["system.css"] }
        );

        if (guarded && commonjs) {
          expect(() => run(entry)).toThrow(/[Mm]utated|[Ee]scaped/);
          return;
        }

        const result = run(entry);

        if (guarded) {
          expect(result.result[1]).toBe("");
          expect(result.code).toContain("system.css({");
        } else {
          expect(result.result[1]).toContain("color: 'red'");
        }
      });
    }
  );

  it("allows a copied receiver object exported from another module", () => {
    const run = fixture(
      {
        "factory.ts": "export const system = { css(rule) { return rule; } };",
        "barrel.ts": `
          import { system } from './factory';
          export const copy = { ...system };
        `,
        "entry.ts": `
          import { system } from './factory';
          import { copy } from './barrel';
          copy.css = rule => ({ ...rule, color: 'blue' });
          export const cls = system.css({ color: 'red' });
        `
      },
      { "./factory.ts": ["system.css"] }
    );

    expect(run("entry.ts").result[1]).toContain("color: 'red'");
  });

  it.each(["esm", "ignored CommonJS"])(
    "preserves runtime output for descriptor-changing copies in %s",
    (format) => {
      const commonjs = format !== "esm";
      const entry = commonjs ? "entry.cjs" : "entry.ts";
      const files = {
        "factory.ts": "export const system = { css: () => 'red' };",
        [entry]: `${commonjs ? "const { system } = require('./factory.ts');" : "import { system } from './factory.ts';"}
          const copy = { ...system };
          delete copy.css;
          ${commonjs ? "exports.color =" : "export const color ="}
          ${commonjs ? "/* mincho-js-ignore */" : ""} system.css();`
      };
      const { code, result } = fixture(files, {
        "./factory.ts": ["system.css"]
      })(entry);
      expect(result[1]).toBe("");
      expect(executeFixture(files, entry).color).toBe("red");
      expect(executeFixture({ ...files, [entry]: code }, entry).color).toBe(
        "red"
      );
    }
  );

  it("preserves a real CommonJS default separate from its named receiver", () => {
    const run = fixture(
      {
        "factory.cjs": `
          exports.__esModule = true;
          exports.default = { system: { css(rule) { return rule; } } };
          exports.system = { color: 'red' };
        `,
        "entry.cjs": `
          function _interopRequireDefault(obj) {
            return obj && obj.__esModule ? obj : { default: obj };
          }
          const wrapped = _interopRequireDefault(require('./factory.cjs'));
          const raw = require('./factory.cjs');
          raw.system.color = 'blue';
          exports.cls = wrapped.default.system.css({ color: 'red' });
        `
      },
      { "./factory.cjs": ["default.system.css"] }
    );

    expect(run("entry.cjs").result[1]).toContain("color: 'red'");
  });

  it("preserves a real ESM default through CommonJS interop", () => {
    const run = fixture(
      {
        "factory.ts": `
          export default { system: { css(rule) { return rule; } } };
          export const system = { color: 'red' };
        `,
        "entry.cjs": `
          function _interopRequireDefault(obj) {
            return obj && obj.__esModule ? obj : { default: obj };
          }
          const wrapped = _interopRequireDefault(require('./factory.ts'));
          const raw = require('./factory.ts');
          raw.system.color = 'blue';
          exports.cls = wrapped.default.system.css({ color: 'red' });
        `
      },
      { "./factory.ts": ["default.system.css"] }
    );

    expect(run("entry.cjs").result[1]).toContain("color: 'red'");
  });

  it("does not validate unrelated imported syntax for receiver identities", () => {
    const run = fixture(
      {
        "factory.ts": "export const system = { css(rule) { return rule; } };",
        "component.ts": "@decorator export class Component {}",
        "entry.ts": `
          import { system } from './factory';
          import { Component } from './component';
          export const cls = system.css({ color: 'red' });
          export { Component };
        `
      },
      { "./factory.ts": ["system.css"] }
    );

    expect(run("entry.ts").result[1]).toContain("color: 'red'");
  });

  it.each(["Component.mode = 'blue';", "consume(Component);"])(
    "keeps re-exported unknown values guarded when eagerly used: %s",
    (action) => {
      const run = fixture(
        {
          "factory.ts": "export const system = { css(rule) { return rule; } };",
          "component.ts": "@decorator export class Component {}",
          "entry.ts": `import { system } from './factory';
            import { Component } from './component';
            export { Component };
            ${action}
            export const cls = system.css({ color: 'red' });`
        },
        { "./factory.ts": ["system.css"] }
      );
      expect(run("entry.ts").result[1]).toBe("");
    }
  );

  it.each([false, true])(
    "tracks nested receiver exports without merging a copied object=%s",
    (copied) => {
      const run = fixture(
        {
          "factory.ts": `
            export const system = { nested: { css(rule) { return rule; } } };
            export const nested = ${copied ? "{ ...system.nested }" : "system.nested"};
          `,
          "barrel.ts": "export { nested as renamed } from './factory';",
          "entry.ts": `
            import { system } from './factory';
            import { renamed } from './barrel';
            renamed.css = rule => ({ ...rule, color: 'blue' });
            export const cls = system.nested.css({ color: 'red' });
          `
        },
        { "./factory.ts": ["system.nested.css"] }
      );

      const result = run("entry.ts");
      if (copied) expect(result.result[1]).toContain("color: 'red'");
      else {
        expect(result.result[1]).toBe("");
        expect(result.code).toContain("system.nested.css({");
      }
    }
  );

  it.each(["node:fs", "external-build-helper"])(
    "protects factories that pass an external namespace to a helper: %s",
    (source) => {
      const transform = fixture({
        "factory.cjs": `
          const lib = require(${JSON.stringify(source)});
          const { style } = require("@vanilla-extract/css");
          exports.make = (rule) => { console.log(lib); return style(rule); };
        `
      });
      const result = transform("factory.cjs");

      expect(result.code).toContain("style(rule)");
      expect(result.result[1]).toBe("");
    }
  );

  it("still rejects an escaped local namespace in a protected factory", () => {
    const transform = fixture({
      "factory.cjs": `
        const lib = require("./helper.cjs");
        const { style } = require("@vanilla-extract/css");
        exports.make = (rule) => { console.log(lib); return style(rule); };
      `,
      "helper.cjs": "exports.value = 42;"
    });

    expect(() => transform("factory.cjs")).toThrow(
      /Escaped CommonJS namespace lib/
    );
  });

  it.each([
    ['const { style } = require("@vanilla-extract/css");', "style"],
    ['var ve = require("@vanilla-extract/css");', "ve.style"],
    ['let ve = require("@vanilla-extract/css");', "(0, ve.style)"],
    ['const { style: make } = require("@vanilla-extract/css");', "make"],
    [
      'const ve = require("@vanilla-extract/css"); const other = ve; const make = other.style;',
      "make"
    ],
    ["", 'require("@vanilla-extract/css")["style"]']
  ])("extracts %s %s", (declaration, call) => {
    const result = transform(
      `${declaration} exports.cls = ${call}({color: "red"});`
    );

    expect(result.result[1]).toContain('color: "red"');
    expect(result.code).not.toContain('color: "red"');
    expect(result.code).toContain('require("extracted_');
    expect(result.code).not.toContain("import ");
  });

  it.each(["make", "make.default"])("registers default: %s", (call) => {
    const result = transform(
      `const make = require("custom"); exports.cls = ${call}({ color: "blue" });`,
      { custom: ["default"] }
    );

    expect(result.result[1]).toContain('color: "blue"');
  });

  it.each([
    'const [make] = require("custom");',
    'const [, make] = require("custom");',
    'const [...make] = require("custom");',
    'const [{ make }] = require("custom");',
    'const namespace = require("custom"); const [make] = namespace;'
  ])("does not extract iterator elements as module exports: %s", (source) => {
    const result = transform(`${source} make({ color: "red" });`, {
      custom: ["default"]
    });

    expect(result.result[1]).toBe("");
    expect(result.code).toMatch(/make\(\{\s*color: "red"\s*\}\)/);
  });

  it("does not confuse shadowed require or unrelated exports with style APIs", () => {
    const result = transform(
      'function local(require) { return require("@vanilla-extract/css").style({}); } const { assignVars } = require("@vanilla-extract/css"); exports.value = assignVars({}, {});'
    );

    expect(result.result[1]).toBe("");
  });

  it.each([
    'let style = require("@vanilla-extract/css").style; style = other; style({});',
    'const ve = require("@vanilla-extract/css"); ve.style = other; ve.style({});',
    'const ve = require("@vanilla-extract/css"); const alias = ve; alias.style = other; ve.style({});',
    'const ve = require("@vanilla-extract/css"); leak(ve); ve.style({});',
    'const ve = require("@vanilla-extract/css"); ve[key]({});'
  ])("rejects ambiguous target calls: %s", (source) => {
    expect(() => transform(source)).toThrow(/Cannot safely extract/);
  });

  it("honors ignore before reporting an unsafe call", () => {
    const result = transform(
      'let style = require("@vanilla-extract/css").style; style = other; /* mincho-js-ignore */ style({});'
    );

    expect(result.result[1]).toBe("");
    expect(result.code).toContain("style({})");
  });

  it.each([
    "exports.make = make;",
    "module.exports = { make };",
    'Object.defineProperty(exports, "make", { enumerable: true, get: function () { return make; } });'
  ])("protects local implementation: %s", (declaration) => {
    const run = fixture({
      "factory.cjs": `const { helper } = require("./helper.cjs"); const make = rule => helper(rule); ${declaration}`,
      "helper.cjs":
        'const { style } = require("@vanilla-extract/css"); exports.helper = rule => style(rule); exports.unrelated = style({color:"blue"});',
      "entry.cjs":
        'const {make} = require("./factory.cjs"); exports.cls = make({color:"red"});'
    });

    expect(run("entry.cjs").result[1]).toContain('color: "red"');

    const helper = run("helper.cjs");

    expect(helper.code).toContain("style(rule)");
    expect(helper.result[1]).not.toContain("style(rule)");
    expect(helper.result[1]).toContain('color: "blue"');
  });

  it("follows module.exports forwarding", () => {
    const run = fixture({
      "factory.cjs": 'module.exports = require("./impl.cjs");',
      "impl.cjs":
        'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);',
      "entry.cjs":
        'const {make} = require("./factory.cjs"); exports.cls = make({color:"red"});'
    });

    expect(run("entry.cjs").result[1]).toContain('color: "red"');
    expect(run("impl.cjs").result[1]).toBe("");
  });

  it("protects a directly exported function registered as default", () => {
    const run = fixture(
      {
        "factory.cjs":
          'const {style} = require("@vanilla-extract/css"); module.exports = rule => style(rule);',
        "entry.cjs":
          'const make = require("./factory.cjs"); exports.cls = make({color:"red"});'
      },
      { "./factory.cjs": ["default"] }
    );

    expect(run("entry.cjs").result[1]).toContain('color: "red"');
    expect(run("factory.cjs").result[1]).toBe("");
  });

  it.each([
    "type Value = T;",
    "type Value = T.Member;",
    "type Value = typeof T;",
    "export type { T };",
    "export type { T as Value };",
    ""
  ])("removes type-only import-equals dependencies: %s", (usage) => {
    const result = babelTransform(
      `import T = require("missing-types"); ${usage} exports.answer = 42;`,
      {},
      { filename: "test.cts", sourceType: "unambiguous" }
    );

    expect(result.code).not.toContain("missing-types");
    expect(result.code).toContain("exports.answer = 42");
  });

  it.each([
    'export import T = require("runtime-module");',
    'import T = require("runtime-module"); exports.value = T as unknown;',
    'import T = require("runtime-module"); exports.value = T satisfies unknown;',
    'import T = require("runtime-module"); import Value = T.Member; exports.value = Value;'
  ])("preserves runtime import-equals dependencies: %s", (source) => {
    const result = babelTransform(
      source,
      {},
      {
        filename: "test.cts",
        sourceType: "unambiguous"
      }
    );

    expect(result.code).toContain('require("runtime-module")');
  });

  it.each([
    ["", "React", "<div />"],
    ["", "React", "<></>"],
    ["/** @jsx h */", "h", "<div />"],
    ["/** @jsx UI.createElement */", "UI", "<div />"],
    ["/** @jsxFrag Fragment */", "Fragment", "<></>"]
  ])("preserves the active JSX pragma binding: %s %s", (comment, name, jsx) => {
    const source = `${comment} import ${name} = require("classic-jsx"); export const view = ${jsx};`;
    const result = babelTransform(
      source,
      {},
      { filename: "test.tsx", sourceType: "unambiguous" }
    );

    expect(result.code).toContain('require("classic-jsx")');
    expect(inspectCommonJs(source, "test.tsx").requires).toEqual([
      "classic-jsx"
    ]);
  });

  it.each(["<div />", "<></>"])(
    "removes unrelated type-only imports alongside JSX: %s",
    (jsx) => {
      const result = babelTransform(
        `import T = require("missing-types"); type Value = T.Member; export const view = ${jsx};`
      );

      expect(result.code).not.toContain("missing-types");
      expect(result.code).toContain("export const view");
    }
  );

  it("uses custom JSX pragmas instead of retaining the default binding", () => {
    const result = babelTransform(`
      /** @jsx h */
      /** @jsxFrag Fragment */
      import React = require("missing-types");
      import h = require("jsx-factory");
      import Fragment = require("jsx-fragment");
      type Value = React.Member;
      export const view = <><div /></>;
    `);

    expect(result.code).not.toContain("missing-types");
    expect(result.code).toContain('require("jsx-factory")');
    expect(result.code).toContain('require("jsx-fragment")');
  });

  it.each([
    ["jsxPragma", "h", "<div />"],
    ["jsxPragmaFrag", "Fragment", "<></>"]
  ])("preserves the TypeScript preset's configured %s", (option, name, jsx) => {
    for (const plugin of [minchoBabelPlugin, styledComponentPlugin]) {
      const result = transformSync(
        `import ${name} = require("classic-jsx"); export const view = ${jsx};`,
        {
          filename: "test.tsx",
          configFile: false,
          babelrc: false,
          presets: [[typescriptPresetPath, { [option]: name }]],
          plugins: [plugin()]
        }
      );

      expect(result?.code).toContain('require("classic-jsx")');
    }
  });

  it("normalizes TypeScript CommonJS declarations", () => {
    const result = babelTransform(
      'import ve = require("@vanilla-extract/css"); const cls: string = ve.style({color:"red"}); export = cls;',
      {},
      { filename: "test.cts", sourceType: "unambiguous" }
    );

    expect(result.result[1]).toContain('color: "red"');
    expect(result.code).toContain("module.exports = cls");
  });
});

describe("CommonJS require evaluation", () => {
  it.each([
    'const value = require("dep") || fallback;',
    'const value = require("dep") && fallback;',
    'const value = require("dep") ?? fallback;',
    'const value = require("dep") ? a : b;',
    'if (require("dep")) run();',
    'if (check(require("dep")) || fallback) run();',
    'target[require("dep")] ||= fallback;',
    'require("dep")?.();'
  ])("recognizes an unconditional condition: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.topLevelRequires).toEqual(["dep"]);
    expect(description.diagnostics).toEqual([]);
  });

  it.each([
    'const value = enabled && require("dep");',
    'const value = enabled || require("dep");',
    'const value = enabled ?? require("dep");',
    'const value = enabled ? require("dep") : fallback;',
    'const value = enabled ? fallback : require("dep");',
    'if (enabled) require("dep");',
    'if (enabled) {} else require("dep");',
    'const value = enabled && (require("dep") || fallback);',
    'if (enabled) { if (require("dep")) run(); }',
    'function load() { return require("dep") || fallback; }',
    'class A { field = require("dep"); }',
    'class A { #field = require("dep"); }',
    'value ||= require("dep");',
    'value &&= require("dep");',
    'value ??= require("dep");',
    'fn?.(require("dep"));',
    'fn?.method(require("dep"));',
    'fn?.(wrap(require("dep")));',
    'while (require("dep")) run();',
    'try { require("dep"); } catch {}',
    'switch (value) { case 1: require("dep"); }'
  ])("keeps a conditional or deferred load in place: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.topLevelRequires).toEqual([]);
    expect(description.diagnostics).toHaveLength(1);
    expect(description.diagnostics[0]).toMatch(/Conditional or lazy require/);
  });

  it.each([
    'class A { [require("dep")] = 1; }',
    'class A { static field = require("dep"); }',
    'class A { static #field = require("dep"); }'
  ])("preserves eager class evaluation: %s", (source) => {
    const description = inspectCommonJs(source, "conditions.cjs");

    expect(description.requires).toEqual(["dep"]);
    expect(description.diagnostics).toEqual([]);
  });
});

it("protects both the module value and its distinct default property", () => {
  const run = fixture(
    {
      "factory.cjs":
        'const {style} = require("@vanilla-extract/css"); const raw = rule => style(rule); module.exports = raw; module.exports.default = rule => style({...rule, color:"blue"});',
      "entry.cjs":
        'const make = require("./factory.cjs"); exports.a = make({color:"red"}); exports.b = make.default({color:"green"});'
    },
    { "./factory.cjs": ["default"] }
  );

  expect(run("factory.cjs").result[1]).toBe("");
  expect(run("entry.cjs").result[1]).toContain('color: "green"');
});

it("supports a Babel default interop wrapper and rejects a forged helper", () => {
  const source =
    'function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; } var make = _interopRequireDefault(require("custom")); exports.cls = (0, make.default)({color:"red"});';

  expect(transform(source, { custom: ["default"] }).result[1]).toContain(
    'color: "red"'
  );
  expect(() =>
    transform(
      source.replace(
        "return obj && obj.__esModule ? obj : { default: obj };",
        "return other(obj);"
      ),
      { custom: ["default"] }
    )
  ).toThrow(/Unsupported CommonJS interop helper/);
});

it("supports CommonJS styled and dynamic JSX css variables", () => {
  const styled = transform(
    'const {styled} = require("@mincho-js/react"); exports.Button = styled.button({color:"red"});'
  );

  expect(styled.result[1]).toContain('color: "red"');
  expect(styled.code).toContain("$$styled");

  const jsx = babelTransform(
    "exports.View = ({color}) => <div css={{color}} />;",
    { jsxCssProp: true },
    { filename: "view.tsx", sourceType: "unambiguous" }
  );

  expect(jsx.result[1]).toContain("createVar");
  expect(jsx.code).not.toContain(" css=");
});

it("protects factory implementations across actual esbuild re-exports", async () => {
  const compile = async (source: string) =>
    (
      await transformWithEsbuild(source, "input.ts", {
        loader: "ts",
        format: "cjs"
      })
    ).code;

  const run = fixture({
    "factory.cjs": await compile('export { make } from "./impl.cjs";'),
    "impl.cjs": await compile(
      'import { style } from "@vanilla-extract/css"; export const make = rule => style(rule);'
    ),
    "entry.cjs": await compile(
      'import { make } from "./factory.cjs"; export const cls = make({color:"red"});'
    )
  });

  expect(run("entry.cjs").result[1]).toContain('color: "red"');
  expect(run("impl.cjs").result[1]).toBe("");
});

it("reports captured runtime parameters before generating invalid sidecars", () => {
  expect(() =>
    transform(
      'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);'
    )
  ).toThrow(/captures runtime binding rule/);
});

it("follows verified TypeScript export-star helpers", () => {
  const helpers = `      var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() { return m[k]; } };
        }
        Object.defineProperty(o, k2, desc);
      }) : (function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      }));
      var __exportStar = (this && this.__exportStar) || function(m, exports) {
        for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
      };
`;

  const run = fixture({
    "factory.cjs": helpers + '__exportStar(require("./impl.cjs"), exports);',
    "impl.cjs":
      'const {style} = require("@vanilla-extract/css"); exports.make = rule => style(rule);',
    "entry.cjs":
      'const factory = require("./factory.cjs"); exports.cls = factory.make({color:"red"});'
  });

  expect(run("entry.cjs").result[1]).toContain('color: "red"');
  expect(run("impl.cjs").result[1]).toBe("");
});

it.each([
  "[ve.style] = [replacement];",
  "({ style: ve.style } = { style: replacement });",
  "for (ve.style of [replacement]) {}",
  "for (ve.style in { replacement: true }) {}"
])(
  "rejects namespace mutation through assignment targets: %s",
  (assignment) => {
    expect(() =>
      babelTransform(`
    const ve = require("@vanilla-extract/css");
    const replacement = () => "runtime";
    ${assignment}
    exports.value = ve.style({ color: "red" });
  `)
    ).toThrow(/Mutated CommonJS namespace/);
  }
);

it.each([
  "forged || function (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "async function (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "function* (obj) { return obj && obj.__esModule ? obj : { default: obj }; }",
  "async obj => obj && obj.__esModule ? obj : { default: obj }"
])("rejects a non-canonical interop helper: %s", (helper) => {
  expect(() =>
    babelTransform(
      `
    const forged = obj => ({ default: () => "runtime" });
    const helper = ${helper};
    const make = helper(require("custom-style"));
    exports.value = make.default({ color: "red" });
  `,
      { extractCalls: { "custom-style": ["default"] } }
    )
  ).toThrow(/Unsupported CommonJS interop helper/);
});

it("recognizes the TypeScript default interop fallback", () => {
  const result = babelTransform(
    `
    var __importDefault = (this && this.__importDefault) || function (obj) {
      return obj && obj.__esModule ? obj : { default: obj };
    };
    const make = __importDefault(require("custom-style"));
    exports.value = make.default({ color: "red" });
  `,
    { extractCalls: { "custom-style": ["default"] } }
  );
  expect(result.result[1]).toContain('color: "red"');
});

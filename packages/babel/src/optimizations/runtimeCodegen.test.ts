import {
  template,
  transformFromAstSync,
  transformSync,
  type NodePath,
  types as t
} from "@babel/core";
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { optimizeRuntimeCodegen } from "./runtimeCodegen.js";
import { pruneRecipeMetadata } from "./recipeMetadata.js";
import { babelTransform } from "../testUtils/plugin.js";
import { analyzeRuntimeExpressions } from "./runtimeExpressions.js";
import { vx } from "@mincho-js/transform-runtime";
import { minchoBabelPlugin } from "../index.js";

function optimize(code: string) {
  return transformSync(code, {
    configFile: false,
    babelrc: false,
    sourceType: "unambiguous",
    plugins: [
      () => ({
        visitor: {
          Program(path: NodePath<t.Program>) {
            optimizeRuntimeCodegen(path);
            pruneRecipeMetadata(path);
          }
        }
      })
    ]
  })!.code!;
}

function analyze(source: string, modules: Record<string, string> = {}) {
  const flow = analyzeRuntimeExpressions({
    filename: "/app.tsx",
    source,
    runtimeCodegen: true,
    styledComponents: true
  });

  let step = flow.next();

  while (!step.done) {
    const request = step.value;
    step = flow.next(
      request.kind === "load"
        ? (modules[request.id] ?? null)
        : request.kind === "resolve" && modules[request.source]
          ? request.source
          : null
    );
  }

  return step.value;
}

describe("runtime code generation", () => {
  it.each([
    ["@mincho-js/css", "css"],
    ["@vanilla-extract/css", "style"]
  ])(
    "removes extracted CommonJS authoring bindings from %s",
    (source, name) => {
      const { code, result } = babelTransform(`
      const { ${name}: makeStyle } = require(${JSON.stringify(source)});
      exports.className = makeStyle({ color: "tomato" });
    `);

      expect(result[1]).toContain(source);
      expect(code).not.toContain(source);
      expect(code).not.toContain("makeStyle");
    }
  );

  it.each([
    'const api = require("@vanilla-extract/css"); exports.className = api.style({ color: "tomato" });',
    'const makeStyle = require("@vanilla-extract/css").style; exports.className = makeStyle({ color: "tomato" });',
    'const api = require("@vanilla-extract/css"); const alias = api; const makeStyle = alias.style; exports.className = makeStyle({ color: "tomato" });',
    'const api = require("@vanilla-extract/css"), alias = api; const { style: makeStyle } = alias; exports.className = makeStyle({ color: "tomato" });'
  ])(
    "removes extracted CommonJS namespace and member bindings: %s",
    (source) => {
      const { code, result } = babelTransform(source);

      expect(result[1]).toContain("@vanilla-extract/css");
      expect(code).not.toContain("@vanilla-extract/css");
    }
  );

  it.each([
    'const api = require("@mincho-js/css"); const style = api.css({ color: "tomato" }); exports.render = () => api.cx(style);',
    'const api = require("@mincho-js/css"); exports.style = api.css({ color: "tomato" }); observe(); require("@mincho-js/css");'
  ])(
    "retains live CommonJS namespaces and their explicit effects: %s",
    (source) => {
      const { code } = babelTransform(source);

      expect(code).toContain('const api = require("@mincho-js/css")');
      if (source.includes("observe()"))
        expect(code.indexOf('require("@mincho-js/css")')).toBeLessThan(
          code.indexOf("observe()")
        );
      else expect(code).toContain("api.cx(style)");
    }
  );

  it("keeps CommonJS runtime imports and explicit effects when pruning authoring bindings", () => {
    const { code } = babelTransform(`
      require("@mincho-js/css");
      const { css, cx } = require("@mincho-js/css");
      const style = css({ color: "tomato" });
      exports.render = () => cx(style);
    `);

    expect(code).toContain('require("@mincho-js/css");');
    expect(code).toMatch(/\{\s*cx\s*\}\s*=\s*require/);
    expect(code).toContain("cx(style)");
    expect(code).not.toMatch(/\{\s*css\b/);
  });

  it.each([
    ["named", 'export { cx } from "@mincho-js/css";', true],
    ["star", 'export * from "@mincho-js/css";', true],
    [
      "native package alias re-export",
      'export { cx } from "#css-alias";',
      true
    ],
    [
      "Babel pre-authored CSS import and native alias",
      'export { cx } from "#css-alias";',
      true,
      true
    ],
    [
      "native package alias import",
      'import { cx } from "#css-alias"; export { cx };',
      true
    ],
    [
      "later value import",
      'import { cx } from "@mincho-js/css"; export { cx };',
      true
    ],
    [
      "type only",
      'export type { CSSProperties } from "@mincho-js/css";',
      false
    ],
    [
      "deferred dynamic import",
      'export const load = () => import("@mincho-js/css");',
      true
    ],
    [
      "deferred dynamic import with a closed string expression",
      'export const load = () => import("@mincho-js/" + "css");',
      true
    ],
    [
      "deferred dynamic import with an immutable closed string",
      'const request = "@mincho-js/" + "css"; export const load = () => import(request);',
      true
    ],
    [
      "deferred dynamic import with a later immutable module string",
      'export const load = () => import(request); const request = "@mincho-js/css";',
      true
    ],
    [
      "deferred request preserves the authored early-read TDZ",
      `export const load = () => import(request);
        try { await load(); throw new Error("expected request TDZ"); }
        catch (error) { if (!(error instanceof ReferenceError)) throw error; }
        const request = "@mincho-js/css";`,
      true
    ],
    [
      "dead deferred dynamic import with a closed string expression",
      'export const load = () => false && import("@mincho-js/" + "css");',
      false
    ],
    [
      "different closed string request",
      'export const load = () => import("./" + "observe.mjs");',
      false
    ],
    [
      "dynamic import with unescaped constant empty attributes",
      'const options = {with:{}}; export const load = () => import("@mincho-js/css", options);',
      true
    ],
    [
      "dynamic import with a separately referenced options object",
      'const options = {with:{}}; options.with = {}; export const load = () => import("@mincho-js/css", options);',
      false
    ],
    [
      "dynamic import with empty options",
      'export const load = () => import("@mincho-js/css", {});',
      true
    ],
    [
      "dynamic import with empty attributes",
      'export const load = () => import("@mincho-js/css", { with: {} });',
      true
    ],
    [
      "dynamic import with undefined attributes",
      'export const load = () => import("@mincho-js/css", { with: void 0 });',
      true
    ],
    [
      "dynamic import with shadowed undefined attributes",
      'export const load = (undefined) => import("@mincho-js/css", { with: undefined });',
      false
    ],
    [
      "dynamic import with effect-free nonzero void options",
      'export const load = () => import("@mincho-js/css", void 1);',
      true
    ],
    [
      "dynamic import with void zero options",
      'export const load = () => import("@mincho-js/css", void 0);',
      true
    ],
    [
      "dynamic import with unbound undefined options",
      'export const load = () => import("@mincho-js/css", undefined);',
      true
    ],
    [
      "dynamic import with shadowed undefined options",
      'export const load = (undefined) => import("@mincho-js/css", undefined);',
      false
    ],
    [
      "dead dynamic import",
      'export const load = () => false && import("@mincho-js/css");',
      false
    ],
    [
      "different dynamic import",
      'export const load = () => import("./observe.mjs");',
      false
    ],
    ["standalone observer after CSS (unknown runtime graph)", "", true],
    [
      "transitive namespace re-export with omitted runtimeCodegen",
      'export * as runtime from "./barrel.mjs";',
      true,
      undefined,
      true
    ],
    [
      "no following request with omitted runtimeCodegen",
      "",
      false,
      undefined,
      true
    ],
    ["no following authored runtime request", "", false]
  ] as const)(
    "preserves ESM initialization with a %s request remaining",
    async (
      _label,
      later,
      hasRuntimeRequest,
      preAddsImport?: true,
      omitRuntimeCodegen?: true
    ) => {
      const observe = 'import { observed } from "./observe.mjs";';
      const input = `${hasRuntimeRequest ? "" : observe}
        ${preAddsImport ? "" : 'import { css } from "@mincho-js/css";'}
        ${hasRuntimeRequest ? observe : ""}
        export const className = css({ color: "red" });
        export { observed }; ${later}`;
      const { code, result } = preAddsImport
        ? (() => {
            const options = {
              result: ["", ""] as [string, string],
              optimize: { runtimeCodegen: false, pureFunctions: false }
            };
            const transformed = transformSync(input, {
              filename: "test.mjs",
              configFile: false,
              babelrc: false,
              plugins: [
                {
                  pre(file) {
                    file.path.unshiftContainer(
                      "body",
                      template.statement.ast(
                        'import { css } from "@mincho-js/css";'
                      )
                    );
                    file.path.scope.crawl();
                  }
                },
                [minchoBabelPlugin(), options]
              ]
            });
            return { code: transformed!.code!, result: options.result };
          })()
        : babelTransform(input, {
            optimize: omitRuntimeCodegen
              ? { pureFunctions: false }
              : { runtimeCodegen: false }
          });
      const root = await mkdtemp(join(tmpdir(), "mincho-esm-init-"));
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"@mincho-js/css","type":"module","exports":"./css.mjs","imports":{"#css-alias":"./css.mjs"}}'
        );
        await writeFile(
          join(root, "css.mjs"),
          'globalThis.trace.push("css-package"); export const css = () => "red-class"; export const cx = () => "";'
        );
        await writeFile(
          join(root, "observe.mjs"),
          'export const observed = globalThis.trace.includes("css-package"); globalThis.trace.push("observe");'
        );
        await writeFile(
          join(root, "barrel.mjs"),
          'import "@mincho-js/css"; export const hasRuntime = true;'
        );
        const imported = code.match(
          /import\s*\{\s*([\w$]+)\s+as\s+[\w$]+\s*\}\s*from/
        );
        expect(imported, code).toBeTruthy();
        await writeFile(
          join(root, "sidecar.mjs"),
          `export const ${imported![1]} = "red-class";`
        );
        await writeFile(
          join(root, "entry.mjs"),
          code.replace(result[0], "./sidecar.mjs")
        );
        const run = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'globalThis.trace = []; const {observed, className} = await import("./entry.mjs"); console.log(JSON.stringify({trace: globalThis.trace, observed, className}));'
          ],
          {
            cwd: root,
            env: { ...process.env, NODE_OPTIONS: "" },
            encoding: "utf8"
          }
        );
        expect(run.status, run.stderr).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({
          trace: hasRuntimeRequest ? ["css-package", "observe"] : ["observe"],
          observed: hasRuntimeRequest,
          className: "red-class"
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["not called", true, false, false],
    ["returns normally", true, true, false],
    ["throws at the authored call", true, true, true],
    ["dead request", false, true, false],
    ["with value not called", true, false, false, true],
    ["with value returns normally", true, true, false, true],
    ["with value throws at the authored call", true, true, true, true],
    ["with value dead request", false, true, false, true]
  ] as const)(
    "preserves eager module order with effectful void options: %s",
    async (_label, live, invoke, throws, nested?: true) => {
      const { code, result } = babelTransform(
        `
        import { css } from "@mincho-js/css";
        export const className = css({ color: "red" });
        globalThis.trace.push("observe");
        function observeOptions() {
          globalThis.trace.push("options");
          ${throws ? 'throw new Error("ordinary options failure");' : "return 7;"}
        }
        export const load = () => ${live ? "" : "false && "}
          import("@mincho-js/css", ${nested ? "{ with: void observeOptions() }" : "void observeOptions()"});
      `,
        { optimize: { runtimeCodegen: false } }
      );
      const root = await mkdtemp(join(tmpdir(), "mincho-esm-init-"));
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"@mincho-js/css","type":"module","exports":"./css.mjs"}'
        );
        await writeFile(
          join(root, "css.mjs"),
          'globalThis.trace.push("css-package"); export const css = () => "red-class";'
        );
        const output = code.match(
          /import\s*\{\s*([\w$]+)\s+as\s+[\w$]+\s*\}\s*from/
        );
        expect(output, code).toBeTruthy();
        await writeFile(
          join(root, "sidecar.mjs"),
          `export const ${output![1]} = "red-class";`
        );
        await writeFile(
          join(root, "entry.mjs"),
          code.replace(result[0], "./sidecar.mjs")
        );
        const run = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          globalThis.trace = [];
          const app = await import("./entry.mjs");
          const initial = [...globalThis.trace];
          let error;
          if (${invoke}) {
            try { await app.load(); } catch (caught) { error = caught.message; }
          }
          console.log(JSON.stringify({ className: app.className, initial, error, trace: globalThis.trace }));
        `
          ],
          {
            cwd: root,
            env: { ...process.env, NODE_OPTIONS: "" },
            encoding: "utf8"
          }
        );
        expect(run.status, run.stderr).toBe(0);
        const initial = live ? ["css-package", "observe"] : ["observe"];
        expect(JSON.parse(run.stdout)).toEqual({
          className: "red-class",
          initial,
          ...(throws ? { error: "ordinary options failure" } : {}),
          trace: invoke && live ? [...initial, "options"] : initial
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [
      "split",
      'const { css } = require("@mincho-js/css"); const unrelated = require("@vanilla-extract/css"); const size = 4;'
    ],
    [
      "compound",
      'const { css } = require("@mincho-js/css"), unrelated = require("@vanilla-extract/css"), size = 4;'
    ]
  ])(
    "preserves unrelated CommonJS initialization in a %s declaration",
    (_name, declarations) => {
      const { code, result } = babelTransform(
        `
      observe("before");
      ${declarations}
      observe("after");
      exports.first = css({ padding: size, color: "red" });
      exports.second = css({ padding: size, color: "blue" });
    `,
        {},
        { sourceType: "script" }
      );
      expect(result[1]).toContain('require("@mincho-js/css")');
      expect(result[1]).not.toContain("@vanilla-extract/css");
      expect(result[1].match(/const size = 4;/g)).toHaveLength(1);
      const sidecar = Object.fromEntries(
        [...result[1].matchAll(/export var (\S+) = css/g)].map(([_, name]) => [
          name,
          name
        ])
      );
      expect(Object.keys(sidecar)).toHaveLength(2);
      const trace: string[] = [];
      const runtime = {};
      new Function("require", "exports", "observe", code)(
        (id: string) => {
          if (id === result[0]) return sidecar;
          trace.push(id);
          return {};
        },
        runtime,
        (event: string) => void trace.push(event)
      );
      // A later authored runtime dependency may load the original CSS module.
      // Keep the original request (not the unrelated sibling in the sidecar).
      expect(trace).toEqual([
        "before",
        "@mincho-js/css",
        "@vanilla-extract/css",
        "after"
      ]);
      expect(runtime).toEqual({
        first: expect.any(String),
        second: expect.any(String)
      });
    }
  );

  it.each([
    [
      "split",
      'const { css } = require("@mincho-js/css"); const rule = { color: shade };'
    ],
    [
      "compound",
      'const { css } = require("@mincho-js/css"), rule = { color: shade };'
    ]
  ])(
    "executes a late-selected %s declarator after all transitive dependencies",
    (_name, declaration) => {
      const { result } = babelTransform(`
      const base = "red";
      const shade = base;
      ${declaration}
      export const first = css({ color: "blue" });
      export const second = css(rule);
    `);
      const colors: string[] = [];
      // Exports do not participate in the sidecar's initialization order.
      new Function("require", result[1].replaceAll("export var ", "var "))(
        (id: string) => {
          expect(id).toBe("@mincho-js/css");
          return {
            css: (style: { color: string }) => colors.push(style.color)
          };
        }
      );
      expect(colors).toEqual(["blue", "red"]);
    }
  );

  it.each([
    ["blue", 'changed = (palette.color = "blue"),'],
    ["red", ""]
  ])("reads %s from the exact owned compound initializer", (color, write) => {
    const { code, result } = babelTransform(
      `const palette = { color: "red" },
        ${write}
        unused = observe(),
        { css } = require("@mincho-js/css");
        exports.result = css({ color: palette.color });`,
      {},
      { sourceType: "script" }
    );
    const events: string[] = [];
    const sidecarExports: Record<string, string> = {};
    new Function(
      "require",
      "out",
      result[1].replace(/export var ([$\w]+) = /g, "var $1 = out.$1 = ")
    )((name: string) => {
      expect(name).toBe("@mincho-js/css");
      events.push("require");
      return {
        css(value: { color: string }) {
          events.push(value.color);
          return value.color;
        }
      };
    }, sidecarExports);
    expect(events).toEqual(["require", color]);
    expect(result[1]).not.toContain("observe()");
    const runtime: { result?: string } = {};
    new Function("require", "exports", "observe", code)(
      (name: string) => {
        expect(name).toBe(result[0]);
        return sidecarExports;
      },
      runtime,
      () => events.push("runtime only")
    );
    expect(runtime.result).toBe(color);
    expect(events).toEqual(["require", color, "runtime only"]);
  });

  it("does not change rest exclusions or unused imports without extraction ownership", () => {
    const { code } = babelTransform(`
      const { css, ...runtime } = require("@mincho-js/css");
      const { css: untouched } = require("@mincho-js/css");
      exports.style = css({ color: "tomato" });
      exports.runtime = runtime;
    `);

    expect(code).toContain("...runtime");
    expect(code).toMatch(/\{\s*css,/);
    expect(code).toContain("css: untouched");
  });

  it("preserves the first CommonJS initialization when a later require requests effects", () => {
    const { code } = babelTransform(`
      const { css } = require("@mincho-js/css");
      exports.style = css({ color: "tomato" });
      observe();
      require("@mincho-js/css");
    `);

    expect(code.indexOf('require("@mincho-js/css")')).toBeLessThan(
      code.indexOf("observe()")
    );
    expect(code).not.toMatch(/\{\s*css\s*\}/);
  });

  it.each([
    'const { css } = require("@mincho-js/css");',
    'const api = require("@mincho-js/css"); const alias = api; const css = alias.css;',
    'const css = require("@mincho-js/css").css;',
    'const api = require("@mincho-js/css"), alias = api; const { css } = alias;'
  ])(
    "preserves initial require before a later live import: %s",
    (initialization) => {
      const { code, result } = babelTransform(
        `
      ${initialization}
      exports.style = css({ color: "tomato" });
      observe();
      const { cx } = require("@mincho-js/css");
      exports.cx = cx;
    `,
        {},
        { sourceType: "script" }
      );
      const events: string[] = [];
      let initialized = false;
      new Function("require", "exports", "observe", code)(
        (source: string) => {
          if (source === result[0]) return { _v0: "compiled" };
          if (source !== "@mincho-js/css") throw new Error(source);
          if (!initialized) events.push("initialize");
          initialized = true;
          return { cx: () => "runtime" };
        },
        {},
        () => events.push("observe")
      );

      expect(events).toEqual(["initialize", "observe"]);
      expect(code).not.toContain("alias");
    }
  );

  it.each([
    [false, "split"],
    [true, "split"],
    [false, "compound"],
    [true, "compound"],
    [false, "observer first, opaque export"],
    [true, "observer first, opaque export"],
    [false, "observer first, known boolean export"],
    [true, "observer first, known boolean export"]
  ] as const)(
    "keeps authored runtime initialization for codegen=%s (%s)",
    async (runtimeCodegen, shape) => {
      const loader = 'css = require("@mincho-js/css").css';
      const observer = 'observed = require("./observe.cjs")';
      const observerFirst = shape.startsWith("observer first");
      const scalarObserved = shape.endsWith("known boolean export");
      const original = `${
        shape === "compound"
          ? `const ${loader}, ${observer};`
          : observerFirst
            ? `const ${observer}; const ${loader};`
            : `const ${loader}; const ${observer};`
      }
      exports.className = css({ color: "red" }); exports.observed = ${scalarObserved ? "!!observed" : "observed"};`;
      const { code, result } = babelTransform(
        original,
        { optimize: { runtimeCodegen } },
        { sourceType: "script" }
      );
      const root = await mkdtemp(join(tmpdir(), "mincho-cjs-init-"));
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"@mincho-js/css","type":"commonjs","exports":"./css.cjs"}'
        );
        await writeFile(
          join(root, "css.cjs"),
          'globalThis.trace.push("css-package"); exports.css = () => "red-class";'
        );
        await writeFile(
          join(root, "observe.cjs"),
          `globalThis.trace.push("observe"); ${observerFirst ? "" : 'require("@mincho-js/css");'} module.exports = globalThis.trace[0] === "css-package";`
        );
        const names = [
          ...result[1].matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)
        ].map((match) => match[1]);
        expect(names).not.toHaveLength(0);
        await writeFile(
          join(root, "sidecar.cjs"),
          names.map((name) => `exports.${name} = "red-class";`).join("\n")
        );
        await writeFile(
          join(root, "entry.cjs"),
          code.replace(result[0], "./sidecar.cjs")
        );
        const run = spawnSync(
          process.execPath,
          [
            "-e",
            'globalThis.trace = []; const app = require("./entry.cjs"); console.log(JSON.stringify({ trace: globalThis.trace, ...app }));'
          ],
          {
            cwd: root,
            env: { ...process.env, NODE_OPTIONS: "" },
            encoding: "utf8"
          }
        );
        expect(run.status, run.stderr).toBe(0);
        if (observerFirst && !scalarObserved) {
          // The compiler has no child export shape here. Native initializes the
          // package after loading this child; preserve the original slot even
          // when this particular fixture's actual export turns out to be data.
          await writeFile(join(root, "native.cjs"), original);
          const native = spawnSync(
            process.execPath,
            [
              "-e",
              'globalThis.trace = []; const app = require("./native.cjs"); console.log(JSON.stringify({ trace: globalThis.trace, ...app }));'
            ],
            {
              cwd: root,
              env: { ...process.env, NODE_OPTIONS: "" },
              encoding: "utf8"
            }
          );
          expect(native.status, native.stderr).toBe(0);
          expect(JSON.parse(run.stdout)).toEqual(JSON.parse(native.stdout));
        }
        expect(JSON.parse(run.stdout)).toEqual({
          trace: observerFirst
            ? scalarObserved
              ? ["observe"]
              : ["observe", "css-package"]
            : ["css-package", "observe"],
          observed: !observerFirst,
          className: "red-class"
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [
      "constant",
      'const request="@vanilla-extract/css"; export const load=()=>import(request);',
      true
    ],
    ["literal", 'export const load=()=>import("@vanilla-extract/css");', true],
    ["no demand", "", false]
  ] as const)(
    "preserves early ESM initialization for a %s dynamic request",
    async (_name, demand, retains) => {
      const source = `import {style} from "@vanilla-extract/css";
        export const cls=style({color:"red"}); globalThis.trace.push("app"); ${demand}`;
      const { code, result } = babelTransform(source, {
        optimize: { runtimeCodegen: false, pureFunctions: false }
      });
      const root = await mkdtemp(
        join(tmpdir(), "mincho-constant-dynamic-init-")
      );
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"@vanilla-extract/css","type":"module","exports":"./css.mjs"}'
        );
        await writeFile(
          join(root, "css.mjs"),
          'globalThis.trace.push("css-package"); export const style=rule=>"class-"+rule.color; export const marker="css";'
        );
        const exports = [
          ...result[1].matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)
        ];
        expect(exports).not.toHaveLength(0);
        await writeFile(
          join(root, "sidecar.mjs"),
          exports
            .map((item) => `export const ${item[1]}="class-red";`)
            .join("\n")
        );
        await writeFile(
          join(root, "app.mjs"),
          code.replace(result[0], "./sidecar.mjs")
        );
        await writeFile(join(root, "native.mjs"), source);
        const run = (entry: string) => {
          const output = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `globalThis.trace=[]; const app=await import("./${entry}"); const before=trace.slice();
              const marker=(await app.load?.())?.marker;
              console.log(JSON.stringify({before,after:trace,marker,cls:app.cls}));`
            ],
            {
              cwd: root,
              encoding: "utf8",
              env: { ...process.env, NODE_OPTIONS: "" }
            }
          );
          expect(output.status, output.stderr).toBe(0);
          return JSON.parse(output.stdout);
        };
        if (retains) {
          expect(run("app.mjs")).toEqual(run("native.mjs"));
          expect(run("app.mjs")).toEqual({
            before: ["css-package", "app"],
            after: ["css-package", "app"],
            marker: "css",
            cls: "class-red"
          });
        } else {
          expect(run("app.mjs")).toEqual({
            before: ["app"],
            after: ["app"],
            cls: "class-red"
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "later",
    "earlier",
    "exported",
    "getter read",
    "setter write",
    "package call",
    "constructor",
    "never"
  ] as const)(
    "distinguishes child loading from the time of its actual consumption: %s",
    async (invocation) => {
      const load =
        invocation === "package call"
          ? 'const { observe } = require("observer-package");'
          : invocation === "constructor"
            ? 'const { Observer } = require("./observe.cjs");'
            : 'const observe = require("./observe.cjs");';
      const author = 'const { css } = require("@mincho-js/css");';
      const use = "exports.observed = observe();";
      const source = [
        load,
        invocation === "earlier" ? use : "",
        author,
        'exports.className = css({ color: "red" });',
        invocation === "later" || invocation === "package call" ? use : "",
        invocation === "constructor"
          ? "exports.observed = new Observer().ready;"
          : "",
        invocation === "exported" ? "exports.load = observe;" : "",
        invocation === "getter read"
          ? "exports.observed = !!observe.ready;"
          : "",
        invocation === "setter write"
          ? "observe.ready = true; exports.observed = globalThis.setterObserved;"
          : ""
      ].join("\n");
      const { code, result } = babelTransform(
        source,
        { optimize: { runtimeCodegen: false } },
        { sourceType: "script" }
      );
      expect(result[1]).toContain("red");
      expect(code.includes('require("@mincho-js/css")')).toBe(
        invocation === "later" ||
          invocation === "exported" ||
          invocation === "getter read" ||
          invocation === "setter write" ||
          invocation === "package call" ||
          invocation === "constructor"
      );
      const root = await mkdtemp(join(tmpdir(), "mincho-called-child-init-"));
      try {
        await writeFile(
          join(root, "package.json"),
          '{"name":"@mincho-js/css","type":"commonjs","exports":"./css.cjs"}'
        );
        await writeFile(
          join(root, "css.cjs"),
          'globalThis.trace.push("css-package"); exports.css=()=>"red-class";'
        );
        await writeFile(
          join(root, "observe.cjs"),
          invocation === "getter read"
            ? 'globalThis.trace.push("loaded-child"); module.exports={get ready(){const initialized=globalThis.trace.includes("css-package");globalThis.trace.push("getter");require("@mincho-js/css");return initialized;}};'
            : invocation === "setter write"
              ? 'globalThis.trace.push("loaded-child"); module.exports={set ready(value){globalThis.setterObserved=globalThis.trace.includes("css-package")&&value;globalThis.trace.push("setter");require("@mincho-js/css");}};'
              : invocation === "constructor"
                ? 'globalThis.trace.push("loaded-child"); exports.Observer=class { constructor(){ this.ready=globalThis.trace.includes("css-package"); globalThis.trace.push("construct"); require("@mincho-js/css"); } };'
                : 'globalThis.trace.push("loaded-child"); module.exports=()=>{const ready=globalThis.trace.includes("css-package"); globalThis.trace.push("call-child"); require("@mincho-js/css"); return ready;};'
        );
        const packagePath = join(root, "fixtures", "observer-package");
        if (invocation === "package call") {
          await mkdir(packagePath, { recursive: true });
          await writeFile(
            join(packagePath, "package.json"),
            '{"name":"observer-package","main":"index.cjs"}'
          );
          await writeFile(
            join(packagePath, "index.cjs"),
            'exports.observe=require("../../observe.cjs");'
          );
        }
        const names = [
          ...result[1].matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)
        ].map((match) => match[1]);
        expect(names).not.toHaveLength(0);
        await writeFile(
          join(root, "sidecar.cjs"),
          names.map((name) => `exports.${name}="red-class";`).join("\n")
        );
        await writeFile(
          join(root, "entry.cjs"),
          code.replace(result[0], "./sidecar.cjs")
        );
        await writeFile(join(root, "native.cjs"), source);
        const run = (file: string) => {
          const result = spawnSync(
            process.execPath,
            [
              "-e",
              `globalThis.trace=[]; const app=require("./${file}"); if (app.load) app.observed=app.load(); console.log(JSON.stringify({trace:globalThis.trace,...app}));`
            ],
            {
              cwd: root,
              env: {
                ...process.env,
                NODE_OPTIONS: "",
                NODE_PATH: join(root, "fixtures")
              },
              encoding: "utf8"
            }
          );
          expect(result.status, result.stderr).toBe(0);
          return JSON.parse(result.stdout);
        };
        if (invocation === "never") {
          expect(run("entry.cjs")).toEqual({
            trace: ["loaded-child"],
            className: "red-class"
          });
        } else {
          const compiled = run("entry.cjs");
          expect(compiled).toEqual(run("native.cjs"));
          if (
            invocation === "getter read" ||
            invocation === "setter write" ||
            invocation === "package call" ||
            invocation === "constructor"
          )
            expect(compiled).toEqual({
              trace: [
                "loaded-child",
                "css-package",
                invocation === "getter read"
                  ? "getter"
                  : invocation === "setter write"
                    ? "setter"
                    : invocation === "package call"
                      ? "call-child"
                      : "construct"
              ],
              observed: true,
              className: "red-class"
            });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("retains actual require initialization without dead namespace aliases", () => {
    const { code } = babelTransform(`
      const api = require("@mincho-js/css");
      const alias = api;
      const { css } = alias;
      exports.style = css({ color: "tomato" });
      observe();
      require("@mincho-js/css");
    `);

    expect(code.indexOf('require("@mincho-js/css")')).toBeLessThan(
      code.indexOf("observe()")
    );
    expect(code).toContain('const api = require("@mincho-js/css")');
    expect(code).not.toContain("alias");
    expect(code).not.toMatch(/\{\s*css\s*\}/);
  });

  it.each([
    'const load = require; observe(); const { cx } = load("@mincho-js/css"); exports.cx = cx;',
    "observe(); const { cx } = require(packageName); exports.cx = cx;"
  ])(
    "preserves initialization with an opaque runtime loader: %s",
    (runtime) => {
      const { code, result } = babelTransform(
        `const api = require("@mincho-js/css");
       const alias = api;
       const css = alias.css;
       exports.style = css({ color: "tomato" });
       ${runtime}`,
        {},
        { sourceType: "script" }
      );
      const events: string[] = [];
      let initialized = false;
      new Function("require", "exports", "observe", "packageName", code)(
        (source: string) => {
          if (source === result[0]) return { _v0: "compiled" };
          if (source !== "@mincho-js/css") throw new Error(source);
          if (!initialized) events.push("initialize");
          initialized = true;
          return { cx: () => "runtime" };
        },
        {},
        () => events.push("observe"),
        "@mincho-js/css"
      );

      expect(events).toEqual(["initialize", "observe"]);
      expect(code).not.toContain("alias");
    }
  );

  it.each([
    'const load = require; return load("@mincho-js/css");',
    "return require(packageName);"
  ])(
    "ignores shadowed runtime loaders when pruning authoring imports: %s",
    (runtime) => {
      const { code } = babelTransform(`
      const api = require("@mincho-js/css");
      const alias = api;
      const css = alias.css;
      exports.style = css({ color: "tomato" });
      exports.load = function (require, packageName) { ${runtime} };
    `);

      expect(code).not.toContain('const api = require("@mincho-js/css")');
      expect(code).not.toContain("alias");
      expect(code).toContain(
        runtime.includes("const load")
          ? "const load = require"
          : "return require(packageName)"
      );
    }
  );

  it.each([
    'const { style: makeStyle } = api; exports.className = makeStyle({ color: "tomato" });',
    'exports.className = api.style({ color: "tomato" });'
  ])("prunes authoring bindings after namespace lowering: %s", (use) => {
    const { code, result } = babelTransform(
      'import * as api from "@vanilla-extract/css";' + use
    );

    expect(result[1]).toContain("@vanilla-extract/css");
    expect(code).not.toContain("@vanilla-extract/css");
    expect(code).not.toContain("makeStyle");
  });

  it("prunes only unobservable literal extension metadata and preserves exported recipes", () => {
    const factory =
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";';
    const recipe =
      'make({defaultClassName:"parent child",variantClassNames:{},defaultVariants:{},compoundVariants:[],classNameReferences:{base:"child",variants:{}},extension:{version:1,stylePackages:["@test/parent"]}}, {})';

    const local = optimize(`${factory} const r = ${recipe}; r();`);
    expect(local).toContain("createCompiledClassRuntimeFn");
    expect(local).not.toContain("stylePackages");
    expect(local).not.toContain("classNameReferences");

    const exported = optimize(`${factory} export const r = ${recipe};`);
    expect(exported).toContain("stylePackages");
    expect(exported).toContain("classNameReferences");

    const selector = optimize(
      `${factory} const r = ${recipe}; console.log(r.classNames.base);`
    );
    expect(selector).toContain("classNameReferences");
    expect(selector).not.toContain("stylePackages");

    const effects = optimize(
      `${factory} const r = ${recipe.replace('extension:{version:1,stylePackages:["@test/parent"]}', "extension:observe()")}; r();`
    );
    expect(effects).toContain("observe()");
  });

  it.each(["Compact", "Packed", "PackedCompact"])(
    "recognizes %s factories when folding literal recipe calls",
    (stem) => {
      const config = {
        defaultClassName: "base",
        variantClassNames: {},
        defaultVariants: {},
        compoundVariants: []
      };
      const packed = [
        1,
        [
          "defaultClassName",
          "base",
          "variantClassNames",
          "defaultVariants",
          "compoundVariants"
        ],
        [
          "o",
          [
            [0, ["s", 1]],
            [2, ["o", []]],
            [3, ["o", []]],
            [4, ["a", []]]
          ]
        ]
      ];
      const payload = stem.startsWith("Packed") ? packed : config;
      for (const full of [false, true]) {
        const result = analyze(
          `import {create${stem}${full ? "" : "Class"}RuntimeFn as make} from '@mincho-js/css/rules/create${stem}RuntimeFn';const r=make(${JSON.stringify(payload)}${full ? ",{}" : ""});globalThis.result=r();`
        );
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]!.config).toEqual(config);
        expect(result.calls[0]!.compiled).toBe(true);
      }
    }
  );

  it("imports generated class merging from the pure runtime and removes orphan css imports", () => {
    const result = babelTransform(
      'export function App(flag) {return <div className="base" css={flag ? "active" : "inactive"}/>;}',
      { jsxCssProp: true }
    );

    expect(result.code).toContain('from "@mincho-js/css/classname"');
    expect(result.code).not.toContain('from "@mincho-js/css"');

    const branch = babelTransform(
      'export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(branch.code).not.toContain('from "@mincho-js/css"');
    expect(branch.result[1]).toContain("@mincho-js/css");
  });

  it("retains authored module effects while removing generated helpers", () => {
    const { code } = babelTransform(
      'import "@mincho-js/css"; export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(code).toContain('import "@mincho-js/css"');
  });

  it.each([false, true])(
    "does not turn an empty type-only import into effects with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `import type {} from "@mincho-js/css"; ${authoredEffect ? 'import "@mincho-js/css";' : ""} export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}`,
        { jsxCssProp: true }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code.includes('import "@mincho-js/css"')).toBe(authoredEffect);
    }
  );

  it.each([false, true])(
    "removes generated CommonJS helpers with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `${authoredEffect ? 'require("@mincho-js/css");' : ""}
         exports.App = function App(flag) {
           return <div css={{color: flag ? "red" : "blue"}}/>;
         };`,
        { jsxCssProp: true },
        { filename: "view.tsx", sourceType: "unambiguous" }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code).not.toMatch(/import\s/);
      expect(code).not.toMatch(/require\("@mincho-js\/css"\)\.css/);
      expect(code.includes('require("@mincho-js/css")')).toBe(authoredEffect);
    }
  );

  it("removes extracted authoring imports while preserving runtime references and explicit effects", () => {
    // No TypeScript preset: unused import elision must not hide this regression.
    const extract = (source: string) => {
      const options = { result: ["", ""], optimize: { runtimeCodegen: true } };
      const result = transformSync(source, {
        configFile: false,
        babelrc: false,
        plugins: [[minchoBabelPlugin, options]]
      })!;

      return { code: result.code!, result: options.result };
    };

    const source =
      'import {rules, cx} from "@mincho-js/css"; const recipe = rules({props:["width"]}); export function map(input) {return recipe.props(input);} export const cls = cx(input);';

    const result = extract(source);

    expect(result.code).not.toMatch(/import\s*\{[^}]*\brules\b/);
    expect(result.code).toContain('import { cx } from "@mincho-js/css"');
    expect(result.result[1]).toContain("rules({");
    expect(extract('import "@mincho-js/css";' + source).code).toContain(
      'import "@mincho-js/css"'
    );
    expect(extract(source + "export {rules};").code).toMatch(
      /import\s*\{[^}]*\brules\b/
    );
    expect(extract(source + 'eval("rules");').code).toMatch(
      /import\s*\{[^}]*\brules\b/
    );
    expect(
      extract('import {rules} from "@mincho-js/css"; export const value=1;')
        .code
    ).toContain("rules");
  });

  it("folds literal class runs without crossing dynamic evaluations or deduplicating", () => {
    const code = optimize(
      'import {cx} from "@mincho-js/css/classname"; export const value=cx("a", [false, ["b", "a"]], next(), "", "c");'
    );

    expect(code).toContain('cx("a b a", next(), "c")');
    expect(
      optimize(
        'import {cx} from "@mincho-js/css/classname"; const a=cx("a "," b",0);'
      )
    ).toContain('"a   b"');
    expect(
      optimize(
        'import {cx} from "@mincho-js/css/classname"; const a=cx({a:true});'
      )
    ).toContain("cx({");
    expect(optimize('function f(cx) {return cx("a","b");}')).toContain(
      'cx("a", "b")'
    );
  });

  it("specializes vx with syntax proofs and keeps unknown values guarded", () => {
    const code = optimize(
      'import {vx} from "@mincho-js/transform-runtime"; const a=vx(+size); const b=vx(+size,"px"); const c=vx(void touch()); const d=vx(value);'
    );

    expect(code).toContain("a = +size");
    expect(code).toContain("`${+size}px`");
    expect(code).toContain('void touch(), "var(--c-, )"');
    expect(code).toContain("d = vx(value)");
  });

  it.each(["`", "${literal}", "\\", "\r", "\r\n", "x\\`${literal}\r\n"])(
    "preserves vx suffix bytes: %j",
    (suffix) => {
      const input = template.program.ast`
        import {vx} from "@mincho-js/transform-runtime";
        function result(size) { return vx(+size, ${t.stringLiteral(suffix)}); }
      `;
      const code = optimize(
        transformFromAstSync(input, undefined, {
          configFile: false,
          babelrc: false
        })!.code!
      );

      expect(code).not.toContain("return vx(");

      const result = new Function(
        "size",
        code.replace(/^import[^;]+;/, "") + "\nreturn result(size);"
      );

      expect(result(12)).toBe(vx(12, suffix));
    }
  );

  it.each([
    'eval("r.props({ width: 1 })");',
    'function inspect(eval) { return eval("r.props({ width: 1 })"); }',
    'with (scope) { inspect("r.props"); }'
  ])(
    "preserves metadata and helper calls under dynamic lexical access: %s",
    (use) => {
      const code = optimize(`
      const {createCompiledRuntimeFn: make} = require("@mincho-js/css/rules/createRuntimeFn");
      let cx = require("@mincho-js/css/classname").cx;
      const r = make({ defaultClassName: "base" }, { width: "--width" });
      ${use}
      const result = cx("a", "b");
    `);

      expect(code).toContain('cx("a", "b")');
      expect(code).toContain("--width");
      expect(code).not.toContain("props: false");
    }
  );

  it("retains runtime calls when a local or imported module permits direct eval", () => {
    const factory =
      'const {createCompiledRuntimeFn: make} = require("@mincho-js/css/rules/createRuntimeFn"); const r = make({ defaultClassName: "base", variantClassNames: {}, defaultVariants: {}, compoundVariants: [] }, { width: "--width" });';

    const local = analyze(
      `${factory} const cls = r(); const style = r.props({width: 1});`
    );

    expect(local.calls).toHaveLength(1);
    expect(local.expressions).toHaveLength(1);

    const owner = analyze(
      `${factory} function inspect(eval) { eval("r.props = custom"); } const cls = r(); const style = r.props({width: 1});`
    );

    expect(owner.calls).toHaveLength(0);
    expect(owner.expressions).toHaveLength(0);

    const safeImport = analyze(
      'import {r} from "/bridge.js"; export const cls = r();',
      {
        "/bridge.js":
          'const {r} = require("/extracted_rules.css.ts"); exports.r = r;',
        "/extracted_rules.css.ts": `${factory} exports.r = r;`
      }
    );

    expect(safeImport.calls).toHaveLength(1);

    const imported = analyze(
      'import {r} from "/bridge.js"; export const cls = r();',
      {
        "/bridge.js":
          'const {r} = require("/extracted_rules.css.ts"); function inspect(eval) { return eval("r"); } exports.r = r;',
        "/extracted_rules.css.ts": `${factory} exports.r = r;`
      }
    );

    expect(imported.dependencies).toContain("/bridge.js");
    expect(imported.calls).toHaveLength(0);
    expect(imported.finiteCalls).toHaveLength(0);
  });

  it("removes only redundant copies of fresh data objects", () => {
    const code = optimize(
      "const a={...(test ? {x:read()} : {})}; const b={...input}; const c={...{get x(){return read()}}}; const d={...{__proto__:proto}};"
    );

    expect(code).toMatch(/a = test \?/);
    expect(code).toContain("...input");
    expect(code).toContain("get x()");
    expect(code).toMatch(/\.\.\.\{\s*__proto__/);
  });

  it("prunes unobserved compiled metadata only in closed local use graphs", () => {
    const factory =
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";';

    const code = optimize(
      factory +
        'const r=make({defaultClassName:"base"},{width:"--width"}); function render(value){return r(value)}'
    );

    expect(code).not.toContain("--width");
    expect(code).toContain("createCompiledClassRuntimeFn");
    expect(code).toContain("variants: false");
    expect(code).toContain("classNames: false");

    for (const use of [
      "export {r};",
      "escape(r);",
      "r.props = other;",
      "r[name];"
    ]) {
      const open = optimize(
        factory + 'const r=make({}, {width:"--width"});' + use
      );

      expect(open).not.toContain("props: false");
      expect(open).toContain("--width");
    }
  });

  it("retains constructor metadata assignments around observable prototype writes", () => {
    const factory =
      'import {createCompiledRuntimeFn as make} from "@mincho-js/css/rules/createRuntimeFn";';

    const recipe =
      'const r=make({defaultClassName:"base"},{width:"--width"}); r();';

    for (const mutation of [
      'Object.defineProperty(Function.prototype, "props", {set(value) { observe(value); }});',
      'Object.defineProperty(Object.prototype, "variants", {set(value) { observe(value); }});',
      "Function.prototype.classNames = replacement;",
      "const inherited = globalThis.Function.prototype; installSetter(inherited);",
      'Function.prototype.__defineSetter__("props", observe);'
    ]) {
      const code = optimize(factory + mutation + recipe);

      expect(code).toContain("--width");
      expect(code).not.toContain("props: false");
      expect(code).not.toContain("variants: false");
      expect(code).not.toContain("classNames: false");
    }

    const readOnly = optimize(
      factory + 'Object.prototype.hasOwnProperty.call(input, "id");' + recipe
    );

    expect(readOnly).toContain("createCompiledClassRuntimeFn");
  });

  it("registers private self-consumed vars only for supported intrinsic elements", () => {
    const transform = (tag: string, style: string) =>
      babelTransform(`function App(size) {return <${tag} css={${style}}/>;}`, {
        jsxCssProp: true,
        experimental: { nonInheritingCssVars: true }
      });

    expect(transform("div", "{width: +size}").result[1]).toContain(
      "inherits: false"
    );
    expect(
      transform("div", '{"@media": {"(min-width: 1px)": {width: +size}}}')
        .result[1]
    ).toContain("inherits: false");

    for (const tag of ["Component", "custom-element"])
      expect(transform(tag, "{width: +size}").result[1]).not.toContain(
        "inherits: false"
      );

    expect(
      transform("div", '{selectors: {"& > span": {width: +size}}}').result[1]
    ).not.toContain("inherits: false");
  });
});

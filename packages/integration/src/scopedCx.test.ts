import { describe, expect, it, vi } from "vitest";
import { createCompiledDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
import { RuntimeOptimizations } from "./runtimeOptimizations.js";
import { CompilationCache } from "./compilationCache.js";
import type { StaticCssEvalSourceProvider } from "./babel.js";

const artifact = {
  classWrites: [
    ["red", 0],
    ["blue", 0],
    ["flex", 1]
  ] as [string, number][],
  segments: [["__mincho_seg_both", [0, 1]]] as [string, number[]][]
};

const make = (
  name = "createCompiledDefineRulesCxRuntime",
  arg = JSON.stringify(artifact)
) =>
  `import {${name} as factory} from "@mincho-js/css/defineRules/createDefineRulesCxRuntime"; export var cx = factory(${arg}); export var red = "red";`;

const optimize = {
  staticScopedCx: true,
  staticRecipes: false,
  styledComponents: false,
  runtimeCodegen: false
};

const sourceProvider = (source = make()): StaticCssEvalSourceProvider => ({
  resolve: (_owner, id) => ({ id }),

  load: (id) => (id === "/extracted_rules.css.ts" ? { source } : null)
});

async function transform(code: string, source = make(), enabled = true) {
  return new RuntimeOptimizations().transform(
    {
      filename: "/app.tsx",
      source: code,
      babel: { optimize: { ...optimize, staticScopedCx: enabled } }
    },
    { code, result: ["", ""] },
    sourceProvider(source)
  );
}

describe("static scoped cx", () => {
  it.each(["const", "var"])(
    "preserves a caught call before %s initialization",
    async (kind) => {
      const code = `import {createCompiledDefineRulesCxRuntime as factory} from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
let result;
try { result = cx("red", "blue"); } catch { result = "fallback"; }
${kind} cx = factory(${JSON.stringify(artifact)});`;

      for (const enabled of [false, true]) {
        const output = await transform(code, make(), enabled);
        const execute = new Function(
          "factory",
          output.code.replace(/import[^;]+;|export\s*\{\s*\};?/g, "") +
            "\nreturn result;"
        );

        expect(execute(createCompiledDefineRulesCxRuntime)).toBe("fallback");
      }
    }
  );

  it("bakes table initializers with exact marker and unknown-class output, retaining CSS", async () => {
    const code =
      'import {cx, red} from "/extracted_rules.css.ts"; const table = [cx(red, "flex"), cx(red, "blue", "external")]; export const cls = flag => table[!!flag << 0];';

    const runtime = createCompiledDefineRulesCxRuntime(artifact);
    const output = await transform(code);

    expect(output.code).toContain(JSON.stringify(runtime("red", "flex")));
    expect(output.code).toContain(
      JSON.stringify(runtime("red", "blue", "external"))
    );
    expect(output.code).not.toContain("cx(");
    expect(output.code).toContain('import "/extracted_rules.css.ts"');
    expect(output.code).toContain("!!flag << 0");
    expect((await transform(code, make(), false)).code).toBe(code);
  });

  it("removes an unused private literal factory and leaves exported factories", async () => {
    const source =
      make().replace("export var cx", "const cx") +
      ' export const result = cx("red", "blue");';

    const result = await transform(source);

    expect(result.code).not.toContain("createCompiledDefineRulesCxRuntime");
    expect(result.code).not.toContain("factory(");
    expect(
      (await transform(make() + ' export const result = cx("red");')).code
    ).toContain("factory(");
  });

  it("reads immutable class operands through Vite's virtual sidecar wrapper", async () => {
    const code =
      'import {cx, red} from "/extracted_rules.css.ts"; export const cls = cx(red, "blue");';

    const output = await new RuntimeOptimizations().transform(
      { filename: "/app.tsx", source: code, babel: { optimize } },
      { code, result: ["", ""] },
      {
        resolve: (_owner, id) => ({
          id:
            id === "/extracted_rules.css.ts"
              ? "\0mincho-extracted-css:/extracted_rules.css.ts.js"
              : id
        }),

        load: (id) =>
          id.startsWith("\0mincho-extracted-css:") ? { source: make() } : null
      }
    );

    expect(output.code).not.toContain("cx(");
    expect(output.code).toContain(
      JSON.stringify(
        createCompiledDefineRulesCxRuntime(artifact)("red", "blue")
      )
    );
    expect(output.code).toContain('import "/extracted_rules.css.ts"');
  });

  it.each([
    "cx(input)",
    "cx({get red(){ return sideEffect(); }})",
    "cx(...values)",
    'cx((sideEffect(), "red"))'
  ])("keeps unknown operands: %s", async (call) => {
    const code = `import {cx} from "/extracted_rules.css.ts"; export const cls = input => ${call};`;

    expect((await transform(code)).code).toBe(code);
  });

  it("rejects public factories, mutable artifact aliases and malformed artifacts", async () => {
    const code =
      'import {cx} from "/extracted_rules.css.ts"; export const cls = cx("red");';

    for (const source of [
      make("createDefineRulesCxRuntime"),
      make(undefined, "shared") + `const shared = ${JSON.stringify(artifact)};`,
      make(undefined, '{classWrites:[["red", "0"]]}')
    ])
      expect((await transform(code, source)).code).toBe(code);
  });

  it("preserves CommonJS effects and literal array/object clsx semantics", async () => {
    const code =
      'const {cx} = require("/extracted_rules.css.ts"); exports.cls = cx(["red", false, null, {flex:true}], "blue");';

    const output = await transform(code);

    expect(output.code).not.toContain("cx([");
    expect(output.code).toContain('require("/extracted_rules.css.ts")');
    expect(output.code).toContain(
      JSON.stringify(
        createCompiledDefineRulesCxRuntime(artifact)(
          ["red", false, null, { flex: true }],
          "blue"
        )
      )
    );
  });

  it("enforces the module payload budget without changing remaining calls", async () => {
    const code =
      'import {cx} from "/extracted_rules.css.ts";' +
      Array.from(
        { length: 260 },
        (_, i) => `export const cls${i} = cx("red");`
      ).join("\n");

    const output = await transform(code);

    expect(output.code.match(/cx\("red"\)/g)?.length).toBe(4);

    const oversized =
      'import {cx} from "/extracted_rules.css.ts"; export const cls = cx(' +
      JSON.stringify("x".repeat(4097)) +
      ");";

    expect((await transform(oversized)).code).toBe(oversized);
  });

  it("replays sidecar loading on a cache hit and observes changed artifact writes", async () => {
    const code =
      'import {cx} from "/extracted_rules.css.ts"; export const cls = cx("red", "blue");';

    const provider = sourceProvider();
    const load = vi.spyOn(provider, "load");
    const cache = new CompilationCache();
    const runtime = new RuntimeOptimizations();
    const options = {
      filename: "/app.tsx",
      source: code,
      babel: { optimize, compilationCache: cache }
    };

    const run = () =>
      runtime.transform(options, { code, result: ["", ""] }, provider);

    const first = await run();
    const calls = load.mock.calls.length;

    expect((await run()).code).toBe(first.code);
    expect(load.mock.calls.length).toBeGreaterThan(calls);

    load.mockImplementation(() => ({
      source: make().replace('["blue",0]', '["blue",2]')
    }));

    expect((await run()).code).not.toBe(first.code);
  });
});

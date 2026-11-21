import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { parseSync } from "@babel/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { processVanillaFile } from "@vanilla-extract/integration";
import {
  beginCompilerClassCost,
  endCompilerClassCost
} from "@mincho-js/css/defineRules/registry";
import { CompilationExecution } from "./compilationExecution.js";
import { CompilationCache } from "./compilationCache.js";
import { processDefineRulesPresetRegistryFile } from "./defineRulesPreset.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { compile } from "./compile.js";
import { proveReusableEvaluation } from "./evaluationProof.js";
import {
  processVanillaWithExecution,
  replayVanillaEvaluation,
  type SerializedVanillaEvaluation
} from "./vanillaEvaluation.js";
import {
  issueCssScopeRuntimeOrigins,
  validateCssScopeRuntimeOrigins,
  CSS_SCOPE_RUNTIME_PREFIX
} from "./fileScopeRuntime.js";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";

const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
});

const filePath = join(process.cwd(), "src/__fixtures__/vm-proof.css.ts");

async function compiled(contents: string) {
  return compile({
    filePath,
    originalPath: filePath,
    contents,
    resolverCache: new Map()
  });
}

async function compiledSizeAwareClasses() {
  return compiled(`
        import { defineRules } from '@mincho-js/css';
        import { compilePrivateDefineRulesClass as compileClass } from '@mincho-js/css/defineRules/registry';
        const rules = defineRules({ properties: { color: true, display: true } });
        const strategy = { version: 1, source: ${JSON.stringify(filePath)}, globalAtomicClasses: true, compileClass: false };
        compileClass(rules.css, { color: 'red' }, strategy);
        compileClass(rules.css, { display: 'flex' }, strategy);
        export const className = compileClass(rules.css, { color: 'red', display: 'flex' }, {
          ...strategy, compileClass: true, sizeAware: true, metric: 'raw'
        });
      `);
}

describe("compatible vanilla-extract evaluation", () => {
  it.each([
    ["direct", false],
    ["fresh", false],
    ["auto", false],
    ["fresh", true],
    ["auto", true]
  ] as const)(
    "measures class strategies once with %s evaluation and artifacts=%s",
    async (evaluation, artifacts) => {
      const { source, cssScopeOrigins } = await compiledSizeAwareClasses();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const evaluate = () =>
        processVanillaWithExecution({
          source,
          filePath,
          serializeVirtualCssPath: () => "",
          ...(evaluation === "direct" ? {} : { cssScopeOrigins }),
          ...(artifacts ? { serializeCssArtifact: () => "" } : {})
        });
      let result: string;

      if (evaluation === "direct") {
        result = await diagnostics.run(filePath, "test", evaluate);
      } else {
        const execution = new CompilationExecution({ workers: 0, evaluation });
        executions.push(execution);
        result = await diagnostics.run(filePath, "test", () =>
          execution.run(evaluate)
        );
      }

      expect(result).toContain("__mincho_seg_");
      const decisions = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .filter((event) => event.phase === "bundle-size-class-strategy");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.detail).toMatchObject({
        applied: true,
        metric: "raw"
      });
    }
  );

  it.each([false, true])(
    "restores outer class costs while CSS serialization is pending, rejects=%s",
    async (reject) => {
      const { source } = await compiledSizeAwareClasses();
      const outerCost = vi.fn(() => [1000, 0]);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      beginCompilerClassCost(outerCost);

      try {
        const evaluated = processVanillaWithExecution({
          source,
          filePath,
          serializeVirtualCssPath: async () => {
            await pending;
            if (reject) throw new Error("CSS serialization failed");
            return "";
          }
        });
        const result = evaluated.then(
          (value) => value,
          (error: Error) => error
        );

        try {
          expect(outerCost).not.toHaveBeenCalled();
          await processVanillaFile({
            source,
            filePath,
            serializeVirtualCssPath: () => ""
          });
          expect(outerCost).toHaveBeenCalledTimes(1);
        } finally {
          release();
          await result;
        }

        if (reject)
          expect(await result).toEqual(new Error("CSS serialization failed"));
        else expect(await result).toContain("__mincho_seg_");

        await processVanillaFile({
          source,
          filePath,
          serializeVirtualCssPath: () => ""
        });
        expect(outerCost).toHaveBeenCalledTimes(2);
      } finally {
        endCompilerClassCost();
      }
    }
  );

  it.each(["auto", "fresh"] as const)(
    "defers CSS with %s evaluation, preserving compositions and ordered rules",
    async (evaluation) => {
      const { source, cssScopeOrigins } = await compiled(`
      import {style, globalStyle, keyframes, layer} from '@vanilla-extract/css';
      const base = style({color:'red'});
      export const composed = style([base]);
      export const unused = style([base]);
      const animation = keyframes({from:{opacity:0},to:{opacity:1}});
      export const box = style({animationName:animation, selectors:{[composed + ' &']:{color:'blue'}}, '@media':{'(min-width: 20px)':{padding:2}}});
      globalStyle('body', {margin:0});
      export const styles = layer('styles');
    `);

      const css: string[] = [];
      const expected = await processVanillaFile({
        source,
        filePath,

        serializeVirtualCssPath: ({ source }) => {
          css.push(source);

          return 'import "marker";';
        }
      });

      const execution = new CompilationExecution({ workers: 0, evaluation });
      executions.push(execution);

      const artifacts: VanillaCssArtifact[] = [];
      const actual = await execution.run(() =>
        processVanillaWithExecution({
          source,
          filePath,

          serializeVirtualCssPath: () => {
            throw new Error("CSS serialized during evaluation");
          },

          cssScopeOrigins,
          serializeCssArtifact: (artifact) => {
            artifacts.push(artifact);

            return 'import "marker";';
          }
        })
      );

      expect(actual).toBe(expected);

      const snapshot = structuredClone(artifacts);

      expect(artifacts.map(generateVanillaCss)).toEqual(css);
      expect(artifacts.map(generateVanillaCss)).toEqual(css);
      expect(artifacts).toEqual(snapshot);
    }
  );

  it.each<"auto" | "fresh" | undefined>([undefined, "auto", "fresh"])(
    "preserves CSS and exports with evaluation %s",
    async (evaluation) => {
      const { source, cssScopeOrigins } = await compiled(
        'import { style, createVar } from "@vanilla-extract/css"; export const color = createVar(); export const box = style({color: "red"});'
      );

      expect(
        proveReusableEvaluation(source, undefined, {
          cssScopeOrigins
        })
      ).toBeDefined();

      const runtime = new CompilationExecution({
        workers: 0,
        evaluation
      });

      executions.push(runtime);

      const diagnostics = new CompilationDiagnostics({ console: true });

      const evaluate = (pooled: boolean) => {
        const css: string[] = [];
        const options = {
          source,
          filePath,
          cssScopeOrigins,
          serializeVirtualCssPath: ({ source }: { source: string }) => {
            css.push(source);

            return "";
          }
        };

        return (
          pooled
            ? diagnostics.run(filePath, "test", () =>
                runtime.run(() => processVanillaWithExecution(options))
              )
            : processVanillaFile(options)
        ).then((source) => ({ source, css }));
      };

      const expected = await evaluate(false);

      expect(await evaluate(true)).toEqual(expected);
      expect(await evaluate(true)).toEqual(expected);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events);

      expect(events.some((event) => event.phase === "vm-context-reuse")).toBe(
        false
      );
      expect(
        events.filter((event) => event.phase === "vm-context-new")
      ).toHaveLength(evaluation === "fresh" ? 0 : 2);
      expect(events.some((event) => event.phase === "vm-script-hit")).toBe(
        evaluation !== "fresh"
      );
    }
  );

  it("uses fresh contexts by default for programs with unproved effects", async () => {
    const runtime = new CompilationExecution({ evaluation: "auto" });
    executions.push(runtime);

    const { source, cssScopeOrigins } = await compiled(`
      import { style } from "@vanilla-extract/css";
      globalThis.__minchoReuseProbe = (globalThis.__minchoReuseProbe ?? 0) + 1;
      export const box = style({ zIndex: globalThis.__minchoReuseProbe });
    `);

    expect(
      proveReusableEvaluation(source, undefined, { cssScopeOrigins })
    ).toBeUndefined();

    const options = {
      source,
      filePath,
      cssScopeOrigins
    };
    const expected = await processVanillaFile(options);
    const diagnostics = new CompilationDiagnostics({ console: true });

    for (let iteration = 0; iteration < 2; iteration++)
      expect(
        await diagnostics.run(filePath, "test", () =>
          runtime.run(() => processVanillaWithExecution(options))
        )
      ).toBe(expected);

    const events = diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "vm-context-bypass")
    ).toHaveLength(2);
    expect(events.some((event) => event.phase === "vm-context-reuse")).toBe(
      false
    );
  });

  it.each([
    "globalThis.leak = 1;",
    "Object.prototype.leak = 1;",
    "setTimeout(() => {}, 0);",
    "Promise.resolve().then(() => {});",
    "const x = {get value() { return 1; }};",
    'const x = require("unverified-package");',
    "var Object = {};",
    'var scope = require("@vanilla-extract/css/fileScope"); scope.setFileScope("leaked.css.ts");',
    'var scope = require("@vanilla-extract/css/fileScope"); scope.endFileScope();',
    "const x = {__proto__: {value: 1}};"
  ])("rejects unknown effects before executing: %s", (source) => {
    expect(proveReusableEvaluation(source)).toBeUndefined();
  });

  it("does not trust forged compiler helper names", async () => {
    const { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );
    expect(
      proveReusableEvaluation(source, undefined, { cssScopeOrigins })
    ).toBeDefined();
    for (const changed of [
      source.replace("Object.defineProperty", "Object.freeze"),
      source + "\nvar Object = {};"
    ]) {
      expect(changed).not.toBe(source);
      expect(
        proveReusableEvaluation(changed, undefined, {
          cssScopeOrigins: issueCssScopeRuntimeOrigins(changed, cssScopeOrigins)
        })
      ).toBeUndefined();
    }
  });

  it("restores fileScope, adapter and NODE_ENV after a stylesheet throws", async () => {
    const runtime = new CompilationExecution({
      workers: 0,
      evaluation: "auto"
    });

    executions.push(runtime);

    const { source, cssScopeOrigins } = await compiled(
      'import { style } from "@vanilla-extract/css"; export const box = style({selectors:{"body": {color: "red"}}});'
    );

    expect(
      proveReusableEvaluation(source, undefined, {
        cssScopeOrigins
      })
    ).toBeDefined();

    const before = process.env.NODE_ENV;

    await expect(
      runtime.run(() =>
        processVanillaWithExecution({
          source,
          filePath,
          cssScopeOrigins
        })
      )
    ).rejects.toThrow();
    expect(process.env.NODE_ENV).toBe(before);

    const { source: valid, cssScopeOrigins: validOrigins } = await compiled(
      'import { style } from "@vanilla-extract/css"; export const box = style({color: "blue"});'
    );

    expect(
      await runtime.run(() =>
        processVanillaWithExecution({
          source: valid,
          filePath,
          cssScopeOrigins: validOrigins
        })
      )
    ).toBe(await processVanillaFile({ source: valid, filePath }));
  });

  it("starts a new realm after a registered consumer throws", async () => {
    const runtime = new CompilationExecution({
      workers: 0,
      evaluation: "auto"
    });

    executions.push(runtime);

    const { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );

    const options = {
      source,
      filePath,
      cssScopeOrigins
    };
    const diagnostics = new CompilationDiagnostics({ console: true });

    await expect(
      diagnostics.run(filePath, "test", () =>
        runtime.run(() =>
          processVanillaWithExecution(options, () => {
            throw new Error("artifact rejected");
          })
        )
      )
    ).rejects.toThrow("artifact rejected");
    expect(
      await diagnostics.run(filePath, "test", () =>
        runtime.run(() => processVanillaWithExecution(options))
      )
    ).toBe(await processVanillaFile(options));
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .filter((event) => event.phase === "vm-context-new")
    ).toHaveLength(2);
  });

  it("cleans up each evaluation pool when an execution is repeatedly reopened", async () => {
    const runtime = new CompilationExecution({
      workers: 0,
      evaluation: "auto"
    });

    executions.push(runtime);

    const { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );

    const diagnostics = new CompilationDiagnostics({ console: true });

    for (let iteration = 0; iteration < 3; iteration++) {
      runtime.begin();
      await diagnostics.run(filePath, "test", () =>
        runtime.run(() =>
          processVanillaWithExecution({
            source,
            filePath,
            cssScopeOrigins
          })
        )
      );
      await runtime.close();
    }

    const events = diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "vm-context-new")
    ).toHaveLength(3);
    expect(events.some((event) => event.phase === "vm-context-reuse")).toBe(
      false
    );
  });
});

describe("compiler-issued runtime file-scope provenance", () => {
  const factoryName = "__mincho_css_scope_factory_test";
  const id = `${CSS_SCOPE_RUNTIME_PREFIX}producer`;
  const makeSource = (body = "") => `
    const scope=${factoryName}(${JSON.stringify(id)});
    const css=require('@vanilla-extract/css');
    if(typeof arguments!=='undefined') throw new Error('unexpected script arguments');
    if(Object.getOwnPropertyNames(globalThis).some(name=>name===${JSON.stringify(factoryName)}||name==='__mincho_internal_css_scope_bridge__')) throw new Error('capability leaked globally');
    scope.setFileScope('logical.css.ts','published');
    exports.className=css.style({color:'red'});
    scope.endFileScope();
    ${body}
  `;
  const metadata = (source: string, origin = "/physical/producer.js") =>
    issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: {
          filePath: "unrelated-registration-hint",
          packageName: "published"
        },
        origin,
        runtime: { id, sourceHash: "", factoryName }
      }
    ]);
  it("records actual dynamic scopes, not the registration hint, without exposing factory arguments", async () => {
    const source = makeSource();
    const artifacts: VanillaCssArtifact[] = [];
    await processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: metadata(source),
      serializeCssArtifact(artifact) {
        artifacts.push(artifact);
        return "";
      }
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      origin: "/physical/producer.js",
      fileScope: { filePath: "logical.css.ts", packageName: "published" }
    });
  });
  it.each(["clone", "source", "origin", "unknown-id"])(
    "rejects forged or stale runtime provenance: %s",
    async (mode) => {
      const original = makeSource();
      let source = original;
      let origins = metadata(source);
      if (mode === "clone") origins = structuredClone(origins);
      if (mode === "source") source += ";";
      if (mode === "origin")
        origins = [{ ...origins[0]!, origin: "/forged.js" }];
      if (mode === "unknown-id") {
        source = original.replace(
          JSON.stringify(id),
          JSON.stringify(id + "-other")
        );
        origins = metadata(source);
      }
      const serializeCssArtifact = vi.fn(() => "");
      await expect(
        processVanillaWithExecution({
          source,
          filePath,
          cssScopeOrigins: origins,
          serializeCssArtifact
        })
      ).rejects.toThrow(/CSS scope runtime/);
      expect(serializeCssArtifact).not.toHaveBeenCalled();
    }
  );
  it("validates source and registration key before replaying runtime artifacts", async () => {
    const source = makeSource();
    const origins = metadata(source);
    let captured: SerializedVanillaEvaluation | undefined;
    await processVanillaWithExecution(
      {
        source,
        filePath,
        cssScopeOrigins: origins,
        serializeCssArtifact: () => ""
      },
      (x) => x,
      {
        beforeSerialize() {},
        complete(value) {
          captured = value;
        }
      }
    );
    const serializeCssArtifact = vi.fn(() => "");
    await replayVanillaEvaluation(
      { source, filePath, cssScopeOrigins: origins, serializeCssArtifact },
      captured!
    );
    expect(serializeCssArtifact).toHaveBeenCalledTimes(1);
    await expect(
      replayVanillaEvaluation(
        {
          source,
          filePath,
          cssScopeOrigins: metadata(source, "/other.js"),
          serializeCssArtifact
        },
        captured!
      )
    ).rejects.toThrow("Stale CSS scope runtime receipt");
    const forged = structuredClone(captured!);
    forged.artifacts![0]!.origin = "/forged.js";
    await expect(
      replayVanillaEvaluation(
        { source, filePath, cssScopeOrigins: origins, serializeCssArtifact },
        forged
      )
    ).rejects.toThrow("Mismatched cached CSS artifact origin");
    const validRuntime = captured!.cssScopeRuntime!;
    const invalidReceipt = {
      ...captured!,
      cssScopeRuntime: {
        ...validRuntime,
        receipts: validRuntime.receipts.map((receipt, index) =>
          index === 0 ? { ...receipt, id: "missing-producer" } : receipt
        )
      }
    };
    await expect(
      replayVanillaEvaluation(
        { source, filePath, cssScopeOrigins: origins, serializeCssArtifact },
        invalidReceipt
      )
    ).rejects.toThrow("Invalid CSS scope runtime receipt");
    expect(serializeCssArtifact).toHaveBeenCalledTimes(1);
  });
  it("does not publish or retain receipts from an aborted evaluation", async () => {
    const source = makeSource("throw new Error('abort runtime');");
    const serializeCssArtifact = vi.fn(() => "");
    const complete = vi.fn();
    await expect(
      processVanillaWithExecution(
        {
          source,
          filePath,
          cssScopeOrigins: metadata(source),
          serializeCssArtifact
        },
        (x) => x,
        { beforeSerialize() {}, complete }
      )
    ).rejects.toThrow("abort runtime");
    expect(complete).not.toHaveBeenCalled();
    expect(serializeCssArtifact).not.toHaveBeenCalled();
    const clean = makeSource();
    await processVanillaWithExecution({
      source: clean,
      filePath,
      cssScopeOrigins: metadata(clean),
      serializeCssArtifact
    });
    expect(serializeCssArtifact).toHaveBeenCalledTimes(1);
  });
});

it("retains the producing facade's origin when another producer forwards it", async () => {
  const factoryName = "__mincho_css_scope_factory_forwarded";
  const a = CSS_SCOPE_RUNTIME_PREFIX + "a",
    b = CSS_SCOPE_RUNTIME_PREFIX + "b";
  const source = `const left=${factoryName}(${JSON.stringify(a)});const right=${factoryName}(${JSON.stringify(b)});const css=require('@vanilla-extract/css');function forward(api){api.setFileScope('forwarded','pkg');exports.name=css.style({color:'blue'});api.endFileScope();}forward(left);`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(
    source,
    [a, b].map((id, index) => ({
      fileScope: { filePath: "hint" + index },
      origin: "/producer" + index + ".js",
      runtime: { id, sourceHash: "", factoryName }
    }))
  );
  const artifacts: VanillaCssArtifact[] = [];
  await processVanillaWithExecution({
    source,
    filePath,
    cssScopeOrigins,
    staticStyles: true,
    serializeCssArtifact(a) {
      artifacts.push(a);
      return "";
    }
  });
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]!.origin).toBe("/producer0.js");
});
it("rejects ambiguous actual scope tuples from distinct producers before publishing", async () => {
  const factoryName = "__mincho_css_scope_factory_ambiguous";
  const ids = [CSS_SCOPE_RUNTIME_PREFIX + "a", CSS_SCOPE_RUNTIME_PREFIX + "b"];
  const source = `const css=require('@vanilla-extract/css');${ids.map((id, index) => `{const api=${factoryName}(${JSON.stringify(id)});api.setFileScope('same','pkg');exports.n${index}=css.style({color:'blue'});api.endFileScope();}`).join("")}`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(
    source,
    ids.map((id, index) => ({
      fileScope: { filePath: "hint" + index },
      origin: "/producer" + index + ".js",
      runtime: { id, sourceHash: "", factoryName }
    }))
  );
  const publish = vi.fn(() => "");
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins,
      serializeCssArtifact: publish
    })
  ).rejects.toThrow("Ambiguous CSS file scope");
  expect(publish).not.toHaveBeenCalled();
});

it.each([
  "scope.setFileScope=()=>{};",
  "delete scope.setFileScope;",
  "Object.defineProperty(scope,'setFileScope',{value:()=>{}});",
  "Object.setPrototypeOf(scope,{});"
])(
  "rejects runtime namespace mutation even in sloppy code: %s",
  async (mutation) => {
    const factoryName = "__mincho_css_scope_factory_readonly",
      id = CSS_SCOPE_RUNTIME_PREFIX + "readonly";
    const source = `const scope=${factoryName}(${JSON.stringify(id)});${mutation}`;
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: "/readonly.js",
        runtime: { id, factoryName, sourceHash: "" }
      }
    ]);
    await expect(
      processVanillaWithExecution({
        source,
        filePath,
        cssScopeOrigins,
        serializeCssArtifact: () => ""
      })
    ).rejects.toThrow("Cannot mutate compiler CSS scope runtime facade");
  }
);
it("requires generated-acquisition runtime metadata for artifacts, but preserves text fallback", async () => {
  const name = "__mincho_css_scope_factory_missing",
    id = CSS_SCOPE_RUNTIME_PREFIX + "missing";
  const source = `const original=require('@vanilla-extract/css/fileScope');const scope=typeof ${name}==='function'?${name}(${JSON.stringify(id)}):original;scope.setFileScope('legacy','pkg');exports.name=require('@vanilla-extract/css').style({color:'red'});scope.endFileScope();`;
  const origins = [
    {
      fileScope: { filePath: "legacy", packageName: "pkg" },
      origin: "/legacy.js"
    }
  ];
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: origins,
      serializeCssArtifact: () => ""
    })
  ).rejects.toThrow("Missing CSS scope provenance");
  const serializeVirtualCssPath = vi.fn(
    (_value: { source: string; origin?: string }) => ""
  );
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      serializeVirtualCssPath
    })
  ).resolves.toContain("name");
  expect(serializeVirtualCssPath).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ source: expect.stringContaining("red") })
  );
  expect(serializeVirtualCssPath.mock.calls[0]![0].origin).toBeUndefined();
});
it.each([
  "// __mincho_css_scope_factory_not_a_call",
  'const text="__mincho_css_scope_factory_not_a_call";',
  'function __mincho_css_scope_factory_local(id){return id}; __mincho_css_scope_factory_local("ordinary");'
])(
  "does not mistake legacy comments, strings or bound names for generated acquisitions: %s",
  async (preamble) => {
    const source = `${preamble}\nconst scope=require('@vanilla-extract/css/fileScope');scope.setFileScope('legacy','pkg');exports.name=require('@vanilla-extract/css').style({color:'red'});scope.endFileScope();`;
    await expect(
      processVanillaWithExecution({
        source,
        filePath,
        cssScopeOrigins: [
          {
            fileScope: { filePath: "legacy", packageName: "pkg" },
            origin: "/legacy.js"
          }
        ],
        serializeCssArtifact: () => ""
      })
    ).resolves.toContain("name");
  }
);

it.each([
  ["missing package name", "{filePath:'optional.css.ts'}", true],
  [
    "accessor package name",
    "{filePath:'optional.css.ts',get packageName(){throw new Error('must not read')}}",
    false
  ]
])("handles an unattributed scope with %s", async (_name, scope, valid) => {
  const factoryName = "__mincho_css_scope_factory_optional_scope";
  const id = CSS_SCOPE_RUNTIME_PREFIX + "optional-scope";
  const source = `const scope=${factoryName}(${JSON.stringify(id)});scope.setFileScope('attested','pkg');scope.endFileScope();
    require('@vanilla-extract/css/adapter').appendCss({type:'global',selector:'body',rule:{color:'red'}},${scope});
    exports.name='optional-scope';`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "hint" },
      origin: filePath,
      runtime: { id, factoryName, sourceHash: "" }
    }
  ]);
  const serializeVirtualCssPath = vi.fn(
    (_value: { source: string; origin?: string }) => ""
  );
  const text = processVanillaWithExecution({
    source,
    filePath,
    cssScopeOrigins,
    serializeVirtualCssPath
  });
  if (valid) {
    await expect(text).resolves.toContain("optional-scope");
    expect(serializeVirtualCssPath).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        fileScope: { filePath: "optional.css.ts" },
        source: expect.stringContaining("red")
      })
    );
    expect(serializeVirtualCssPath.mock.calls[0]![0].origin).toBeUndefined();
  } else {
    await expect(text).rejects.toThrow("invalid runtime scope instance fields");
    expect(serializeVirtualCssPath).not.toHaveBeenCalled();
  }
  const serializeCssArtifact = vi.fn(() => "");
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins,
      serializeCssArtifact
    })
  ).rejects.toThrow(
    valid
      ? "unattributed runtime scope instance"
      : "invalid runtime scope instance fields"
  );
  expect(serializeCssArtifact).not.toHaveBeenCalled();
});

it("does not let an unattributed same-tuple scope instance reuse an earlier receipt", async () => {
  const factoryName = "__mincho_css_scope_factory_epoch",
    id = CSS_SCOPE_RUNTIME_PREFIX + "epoch";
  const source = `const trusted=${factoryName}(${JSON.stringify(id)});trusted.setFileScope('same','pkg');trusted.endFileScope();const dynamicName='@vanilla-extract/css/'+'fileScope';const raw=require(dynamicName);raw.setFileScope('same','pkg');exports.name=require('@vanilla-extract/css').style({color:'red'});raw.endFileScope();`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "same", packageName: "pkg" },
      origin: "/producer.js",
      runtime: { id, sourceHash: "", factoryName }
    }
  ]);
  const serializeCssArtifact = vi.fn(() => "");
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins,
      serializeCssArtifact
    })
  ).rejects.toThrow("unattributed runtime scope instance");
  expect(serializeCssArtifact).not.toHaveBeenCalled();
  const css: Array<{ origin?: string }> = [];
  await processVanillaWithExecution({
    source,
    filePath,
    cssScopeOrigins,
    serializeVirtualCssPath(value) {
      css.push(value);
      return "";
    }
  });
  expect(css).toHaveLength(1);
  expect(css[0]!.origin).toBeUndefined();
});

it("does not certify a stale raw scope after the official set protocol is replaced", async () => {
  const factoryName = "__mincho_css_scope_factory_protocol",
    id = CSS_SCOPE_RUNTIME_PREFIX + "protocol";
  const source = `const facade=${factoryName}(${JSON.stringify(id)});const raw=require('node:module').createRequire(${JSON.stringify(filePath)})('@vanilla-extract/css/fileScope');const original=raw.setFileScope;raw.setFileScope('same','pkg');try{raw.setFileScope=()=>{};facade.setFileScope('same','pkg');exports.name=require('@vanilla-extract/css').style({color:'red'});}finally{raw.setFileScope=original;if(raw.hasFileScope())raw.endFileScope();}`;
  const origins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "same", packageName: "pkg" },
      origin: "/forged-owner.js",
      runtime: { id, sourceHash: "", factoryName }
    }
  ]);
  const publish = vi.fn(() => "");
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: origins,
      serializeCssArtifact: publish
    })
  ).rejects.toThrow(/protocol|scope instance/);
  expect(publish).not.toHaveBeenCalled();
});

it("snapshots runtime entries once before validating and storing origin authority", () => {
  const source = "";
  const original = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "hint" },
      origin: "/real.js",
      runtime: {
        id: CSS_SCOPE_RUNTIME_PREFIX + "snapshot",
        sourceHash: "",
        factoryName: "__mincho_css_scope_factory_snapshot"
      }
    }
  ])[0]!;
  let runtimeReads = 0,
    originReads = 0;
  const accessor = {
    fileScope: original.fileScope,
    get runtime() {
      runtimeReads++;
      return original.runtime;
    },
    get origin() {
      return ++originReads === 1 ? "/real.js" : "/evil.js";
    }
  };
  const registration = validateCssScopeRuntimeOrigins(source, [accessor])!;
  expect(registration.origins.get(original.runtime!.id)).toBe("/real.js");
  expect(runtimeReads).toBe(1);
  expect(originReads).toBe(1);
});

it.each([
  "current.filePath='other';",
  "Object.defineProperty(current,'filePath',{get(){return 'same'}});",
  "delete current.packageName;"
])(
  "rejects changed own scope tuple fields before attributing CSS: %s",
  async (mutation) => {
    const factoryName = "__mincho_css_scope_factory_tuple",
      id = CSS_SCOPE_RUNTIME_PREFIX + "tuple";
    const source = `const api=${factoryName}(${JSON.stringify(id)});api.setFileScope('other','pkg');api.endFileScope();api.setFileScope('same','pkg');const current=api.getFileScope();${mutation}exports.name=require('@vanilla-extract/css').style({color:'red'});api.endFileScope();`;
    const origins = issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: "/producer.js",
        runtime: { id, sourceHash: "", factoryName }
      }
    ]);
    const publish = vi.fn(() => "");
    await expect(
      processVanillaWithExecution({
        source,
        filePath,
        cssScopeOrigins: origins,
        serializeCssArtifact: publish
      })
    ).rejects.toThrow(/scope instance/);
    expect(publish).not.toHaveBeenCalled();
  }
);

it("cleans raw protocol scopes on abort before the next evaluation", async () => {
  const factoryName = "__mincho_css_scope_factory_cleanup",
    id = CSS_SCOPE_RUNTIME_PREFIX + "cleanup";
  const source = `${factoryName}(${JSON.stringify(id)});require('node:module').createRequire(${JSON.stringify(filePath)})('@vanilla-extract/css/fileScope').setFileScope('leaked','bad');throw new Error('raw-abort');`;
  const metadata = (source: string) =>
    issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: "/clean.js",
        runtime: { id, sourceHash: "", factoryName }
      }
    ]);
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: metadata(source),
      serializeCssArtifact: () => ""
    })
  ).rejects.toThrow("raw-abort");
  const actualScope = await import("@vanilla-extract/css/fileScope");
  expect(actualScope.hasFileScope()).toBe(false);
  const clean = `const api=${factoryName}(${JSON.stringify(id)});api.setFileScope('clean','pkg');exports.count=api.getAndIncrementRefCounter();exports.name=require('@vanilla-extract/css').style({color:'red'});api.endFileScope();`;
  const artifacts: VanillaCssArtifact[] = [];
  const result = await processVanillaWithExecution({
    source: clean,
    filePath,
    cssScopeOrigins: metadata(clean),
    serializeCssArtifact(a) {
      artifacts.push(a);
      return "";
    }
  });
  expect(result).toContain("count = 0");
  expect(artifacts[0]).toMatchObject({
    origin: "/clean.js",
    fileScope: { filePath: "clean", packageName: "pkg" }
  });
  expect(actualScope.hasFileScope()).toBe(false);
});

it.each(["same", "src/theme$$$dark.css.ts"])(
  "retains emitting provenance despite an empty same-tuple producer: %s",
  async (scopePath) => {
    const factoryName = "__mincho_css_scope_factory_bucket";
    const ids = [
      CSS_SCOPE_RUNTIME_PREFIX + "bucket-a",
      CSS_SCOPE_RUNTIME_PREFIX + "bucket-b"
    ];
    const source = `const css=require('@vanilla-extract/css');${ids.map((id, index) => `{const api=${factoryName}(${JSON.stringify(id)});api.setFileScope(${JSON.stringify(scopePath)},'pkg');${index === 0 ? "exports.name=css.style({color:'blue'});" : ""}api.endFileScope();}`).join("")}`;
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(
      source,
      ids.map((id, index) => ({
        fileScope: { filePath: "hint" + index },
        origin: "/bucket" + index + ".js",
        runtime: { id, sourceHash: "", factoryName }
      }))
    );
    const publish = vi.fn((_artifact: VanillaCssArtifact) => "");
    let captured: SerializedVanillaEvaluation | undefined;
    await processVanillaWithExecution(
      { source, filePath, cssScopeOrigins, serializeCssArtifact: publish },
      (x) => x,
      {
        beforeSerialize() {},
        complete(value) {
          captured = value;
        }
      }
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toMatchObject({
      origin: "/bucket0.js",
      fileScope: { filePath: scopePath, packageName: "pkg" }
    });
    publish.mockClear();
    await replayVanillaEvaluation(
      { source, filePath, cssScopeOrigins, serializeCssArtifact: publish },
      captured!
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(captured!.cssScopeRuntime!.receipts).toHaveLength(1);
    const forged = structuredClone(captured!);
    forged.artifacts![0]!.origin = "/bucket1.js";
    await expect(
      replayVanillaEvaluation(
        { source, filePath, cssScopeOrigins, serializeCssArtifact: publish },
        forged
      )
    ).rejects.toThrow("Mismatched cached CSS artifact origin");
    expect(publish).toHaveBeenCalledTimes(1);
  }
);

it("uses the exact static program origin in native CSS-text fallback", async () => {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...original,
      readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
        const value = original.readFileSync(...args);
        if (
          typeof value !== "string" ||
          !String(args[0]).includes("vanilla-extract-integration") ||
          !String(args[0]).endsWith("package.json")
        )
          return value;
        return JSON.stringify({
          ...JSON.parse(value),
          version: "0.0.0-unvalidated"
        });
      }
    };
  });
  try {
    const freshCompiler = await import("./compile.js");
    const freshEvaluator = await import("./vanillaEvaluation.js");
    const { readStaticStyleProgram } = await import("./staticStyles.js");
    const compiled = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      contents: `import {style} from '@vanilla-extract/css';
        export const box=style({backgroundImage:'url("./logo.svg")'});`,
      resolverCache: new Map(),
      staticStyles: true
    });
    const program = readStaticStyleProgram(compiled.source);
    expect(program).toBeDefined();
    expect(compiled.cssScopeOrigins).toEqual([
      { fileScope: program!.scope, origin: filePath }
    ]);
    const native = vi.fn((_value: { source: string; origin?: string }) => "");
    const options = {
      ...compiled,
      filePath,
      staticStyles: true,
      serializeVirtualCssPath: native
    };
    await freshEvaluator.processVanillaWithExecution(options);
    expect(native).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        fileScope: program!.scope,
        origin: filePath,
        source: expect.stringContaining("./logo.svg")
      })
    );
    native.mockClear();
    await freshEvaluator.processVanillaWithExecution({
      ...options,
      cssScopeOrigins: []
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0].origin).toBeUndefined();

    native.mockClear();
    await freshEvaluator.processVanillaWithExecution({
      ...options,
      source: compiled.source + "\n// additional source text"
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0].origin).toBeUndefined();

    native.mockClear();
    await expect(
      freshEvaluator.processVanillaWithExecution({
        ...options,
        cssScopeOrigins: [
          ...compiled.cssScopeOrigins,
          { fileScope: program!.scope, origin: filePath + ".another" }
        ]
      })
    ).rejects.toThrow("Ambiguous CSS file scope");
    expect(native).not.toHaveBeenCalled();

    await expect(
      freshEvaluator.processVanillaWithExecution({
        ...options,
        serializeCssArtifact: () => ""
      })
    ).rejects.toThrow("requires the validated @vanilla-extract/integration");
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

it.each([
  "read-only",
  "replace module",
  "single getter",
  "adapter-sensitive getter"
] as const)(
  "serializes ordinary CommonJS exports (%s) without a write-back",
  async (mode) => {
    const defaultIdent =
      process.env.NODE_ENV === "production" ? "short" : "debug";
    const identOption = defaultIdent === "debug" ? "short" : "debug";
    const compiledInput = await compiled(`
      require('@vanilla-extract/css').globalStyle('.ordinary-exports',{color:'red'});
      ${
        mode === "read-only"
          ? "Object.defineProperty(module,'exports',{value:{label:'ordinary'},writable:false});"
          : mode === "replace module"
            ? "Object.freeze(module); module={exports:{label:'ordinary'}};"
            : mode === "adapter-sensitive getter"
              ? "let reads=0; Object.defineProperty(module,'exports',{get(){if(++reads>1)throw new Error('exports read twice');return {label:require('@vanilla-extract/css/adapter').getIdentOption()};}});"
              : "let reads=0; Object.defineProperty(module,'exports',{get(){if(++reads>1)throw new Error('exports read twice');return {label:'ordinary'};}});"
      }
    `);
    const input = { ...compiledInput, filePath, identOption } as const;
    const upstreamCss: string[] = [];
    const registeredCss: string[] = [];
    const upstream = await processVanillaFile({
      ...input,
      serializeVirtualCssPath(value) {
        upstreamCss.push(value.source);
        return "";
      }
    });
    const registered = await processVanillaWithExecution({
      ...input,
      serializeVirtualCssPath(value) {
        registeredCss.push(value.source);
        return "";
      }
    });
    expect(upstreamCss).toHaveLength(1);
    expect(upstreamCss[0]).toContain("red");
    expect(registeredCss).toEqual(upstreamCss);
    expect(registered).toBe(upstream);
    const expectedLabel =
      mode === "adapter-sensitive getter" ? defaultIdent : "ordinary";
    expect(registered).toMatch(
      new RegExp(`export var label = ['"]${expectedLabel}['"]`)
    );
  }
);

it("preserves repeated public fileScope acquisitions in registered CSS-text evaluation", async () => {
  const compiledInput = await compiled(`
    const specifier = ['@vanilla-extract/css','fileScope'].join('/');
    const first = require(specifier);
    const second = require(specifier);
    const color = new Map([[first,'green']]).get(second) ?? 'red';
    require('@vanilla-extract/css').globalStyle('.scope-identity',{color});
    module.exports.color = color;
  `);
  expect(
    validateCssScopeRuntimeOrigins(
      compiledInput.source,
      compiledInput.cssScopeOrigins
    )
  ).toBeDefined();

  const input = {
    ...compiledInput,
    filePath,
    serializeVirtualCssPath: ({ source }: { source: string }) =>
      JSON.stringify(source)
  };
  const upstream = await processVanillaFile(input);
  expect(upstream).toContain("color: green");
  expect(await processVanillaWithExecution(input)).toBe(upstream);
});

it("isolates public fileScope facade state between registered evaluations", async () => {
  const compiledInput = await compiled(`
    const specifier = ['@vanilla-extract/css','fileScope'].join('/');
    const scope = require(specifier);
    const seen = Object.hasOwn(scope, 'minchoExampleLabel') ? 'retained' : 'fresh';
    scope.minchoExampleLabel = 'custom';
    module.exports.seen = seen;
  `);
  expect(
    validateCssScopeRuntimeOrigins(
      compiledInput.source,
      compiledInput.cssScopeOrigins
    )
  ).toBeDefined();
  const input = { ...compiledInput, filePath };
  for (let run = 0; run < 2; run++)
    expect(await processVanillaWithExecution(input)).toContain(
      "export var seen = 'fresh';"
    );
});

it("keeps upstream CSS-text fallback for unsupported adapter versions without granting artifact authority", async () => {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const original = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...original,
      readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
        const value = original.readFileSync(...args);
        const name = String(args[0]);
        if (name.includes("vanilla-extract") && name.endsWith("package.json")) {
          const changed = JSON.stringify({
            ...JSON.parse(String(value)),
            version: "0.0.0-unvalidated"
          });
          return typeof value === "string" ? changed : Buffer.from(changed);
        }
        return value;
      }
    };
  });
  try {
    const freshCompiler = await import("./compile.js");
    const freshEvaluator = await import("./vanillaEvaluation.js");
    const compiled = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      contents:
        "import {style} from '@vanilla-extract/css';export const box=style({color:'red'});",
      resolverCache: new Map()
    });
    const input = { ...compiled, filePath };
    const expected = await processVanillaFile(input);
    expect(await freshEvaluator.processVanillaWithExecution(input)).toBe(
      expected
    );
    const native = vi.fn((_args: { origin?: string; source: string }) => "");
    await freshEvaluator.processVanillaWithExecution({
      ...input,
      serializeVirtualCssPath: native
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0]).toMatchObject({
      origin: filePath,
      source: expect.stringContaining("red")
    });
    const unclosed = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `const moduleName='@vanilla-extract/css/fileScope';const scope=require(moduleName);scope.setFileScope('manual.css.ts','manual');exports.name=require('@vanilla-extract/css').style({color:'blue'});scope.endFileScope();`
    });
    native.mockClear();
    await freshEvaluator.processVanillaWithExecution({
      ...unclosed,
      filePath,
      serializeVirtualCssPath: native
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0].origin).toBeUndefined();
    expect(native.mock.calls[0]![0].source).toContain("blue");
    const delimited = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `const scope=require('@vanilla-extract/css/fileScope');scope.setFileScope('theme$$$dark.css.ts','manual');exports.name=require('@vanilla-extract/css').style({color:'green'});scope.endFileScope();`
    });
    native.mockClear();
    await freshEvaluator.processVanillaWithExecution({
      ...delimited,
      filePath,
      serializeVirtualCssPath: native
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0].origin).toBeUndefined();
    expect(native.mock.calls[0]![0].source).toContain("green");
    const resource = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `import {style} from '@vanilla-extract/css';export const image=style({backgroundImage:'url("./asset.svg")'});`
    });
    const generated =
      'setFileScope("src/__fixtures__/vm-proof.css.ts", "@mincho-js/integration")';
    expect(resource.source).toContain(generated);
    const freshScopes = await import("./fileScopeRuntime.js");
    for (const suffix of [',""', ""]) {
      const source = resource.source.replace(
        generated,
        `setFileScope("second.css.ts"${suffix})`
      );
      const cssScopeOrigins = freshScopes.issueCssScopeRuntimeOrigins(
        source,
        resource.cssScopeOrigins
      );
      native.mockClear();
      await freshEvaluator.processVanillaWithExecution({
        source,
        cssScopeOrigins,
        filePath,
        serializeVirtualCssPath: native
      });
      expect(native).toHaveBeenCalledTimes(1);
      expect(native.mock.calls[0]![0]).toMatchObject({
        origin: filePath,
        fileScope: { filePath: "second.css.ts" },
        source: expect.stringContaining("./asset.svg")
      });
    }
    const dynamicResource = await freshCompiler.compile({
      filePath,
      originalPath: filePath,
      resolverCache: new Map(),
      contents: `import {style} from '@vanilla-extract/css';export const image=style({backgroundImage:process.platform==='win32'?'url("./win.svg")':'url("./other.svg")'});`
    });
    native.mockClear();
    await freshEvaluator.processVanillaWithExecution({
      ...dynamicResource,
      filePath,
      serializeVirtualCssPath: native
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]![0].origin).toBeUndefined();
    expect(native.mock.calls[0]![0].source).toContain(
      process.platform === "win32" ? "./win.svg" : "./other.svg"
    );

    const cacheDir = join(process.cwd(), ".cache");
    await mkdir(cacheDir, { recursive: true });
    const producerDir = await realpath(
      await mkdtemp(join(cacheDir, "native-serializers-"))
    );
    try {
      const producer = join(producerDir, "producer.css.ts");
      const base = await freshCompiler.compile({
        filePath: producer,
        originalPath: producer,
        resolverCache: new Map(),
        contents:
          "import {style} from '@vanilla-extract/css';export const box=style({color:'red'});"
      });
      // Add another ordinary scope to the same verified producer, retaining the
      // compiler's generated fileScope acquisition and public style import.
      const source = base.source.replace(
        "endFileScope();\n// Annotate",
        'endFileScope();\nsetFileScope("second.css.ts", "pkg");\nvar second = (0, import_css.style)({color:"blue"});\nendFileScope();\n// Annotate'
      );
      expect(source).not.toBe(base.source);
      const cssScopeOrigins = freshScopes.issueCssScopeRuntimeOrigins(
        source,
        base.cssScopeOrigins
      );
      const serializer = vi.fn(
        async (args: { origin?: string; source: string }) => {
          expect(args.origin).toBe(producer);
          const color = args.source.includes("red") ? "red" : "blue";
          await writeFile(
            join(producerDir, `output-${color}.css`),
            args.source
          );
          return "";
        }
      );
      await freshEvaluator.processVanillaWithExecution({
        source,
        cssScopeOrigins,
        filePath: producer,
        serializeVirtualCssPath: serializer
      });
      expect(serializer).toHaveBeenCalledTimes(2);
      expect(
        serializer.mock.calls.map(([args]) => args.source).join("\n")
      ).toMatch(/red[\s\S]*blue/);
    } finally {
      await rm(producerDir, { recursive: true, force: true });
    }

    const snapshots = await import("./compilationInputs.js");
    const unchanged = vi
      .spyOn(snapshots, "unchangedFiles")
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    native.mockClear();
    try {
      await expect(
        freshEvaluator.processVanillaWithExecution({
          ...input,
          serializeVirtualCssPath: native
        })
      ).rejects.toThrow("ownership inputs changed");
      expect(native).not.toHaveBeenCalled();
    } finally {
      unchanged.mockRestore();
    }
    const serializer = vi.fn((_artifact: VanillaCssArtifact) => "");
    await expect(
      freshEvaluator.processVanillaWithExecution({
        ...input,
        serializeCssArtifact: serializer
      })
    ).rejects.toThrow("validated");
    expect(serializer).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

it.each([true, false])(
  "revokes queued scope pushes before yielding (producer facade: %s)",
  async (registered) => {
    const factoryName = "__mincho_css_scope_factory_late";
    const id = CSS_SCOPE_RUNTIME_PREFIX + "late";
    const key = "MINCHO_TEST_LATE_SCOPE_RESULT";
    const previous = process.env[key];
    const source = `const owned=${factoryName}(${JSON.stringify(id)});const api=${registered ? "owned" : "require('@vanilla-extract/css/fileScope')"};owned.setFileScope('initial','pkg');exports.name=require('@vanilla-extract/css').style({color:'blue'});owned.endFileScope();Promise.resolve().then(()=>{try{api.setFileScope('late','pkg');process.env.${key}='unexpected push';}catch(error){process.env.${key}=error.message;}});`;
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: "/late.js",
        runtime: { id, factoryName, sourceHash: "" }
      }
    ]);
    const actualScope = await import("@vanilla-extract/css/fileScope");
    const baseline = actualScope.hasFileScope()
      ? actualScope.getFileScope()
      : undefined;
    try {
      await processVanillaWithExecution({
        source,
        filePath,
        cssScopeOrigins,
        serializeCssArtifact: () => ""
      });
      expect(process.env[key]).toBe("Closed CSS scope runtime evaluation");
      expect(
        actualScope.hasFileScope() ? actualScope.getFileScope() : undefined
      ).toBe(baseline);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      while (
        actualScope.hasFileScope() &&
        actualScope.getFileScope() !== baseline
      )
        actualScope.endFileScope();
    }
  }
);

it.each(["", '"use strict";'])(
  "keeps strict and sloppy script scope: %s",
  async (directive) => {
    const factoryName = "__mincho_css_scope_factory_semantics";
    const id = CSS_SCOPE_RUNTIME_PREFIX + "semantics";
    const source = `${directive}\nconst scope=${factoryName}(${JSON.stringify(id)});scope.setFileScope('semantics','pkg');scope.endFileScope();exports.before='discarded';module={exports:{arity:typeof arguments,realmReceiver:this===globalThis,strictReceiver:(function(){return this===undefined})(),nodeGlobals:typeof process.cwd==='function'&&typeof Buffer.from==='function',capabilityGlobal:Object.prototype.hasOwnProperty.call(globalThis,${JSON.stringify(factoryName)}) || Object.prototype.hasOwnProperty.call(globalThis,'__mincho_internal_css_scope_bridge__')}};`;
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: "/semantics.js",
        runtime: { id, factoryName, sourceHash: "" }
      }
    ]);
    const actual = await processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins
    });
    expect(actual).toMatch(/export var arity = ['"]undefined['"];/);
    expect(actual).toContain("export var realmReceiver = true;");
    expect(actual).toContain(
      `export var strictReceiver = ${Boolean(directive)};`
    );
    expect(actual).toContain("export var nodeGlobals = true;");
    expect(actual).toContain("export var capabilityGlobal = false;");
    expect(actual).not.toContain("discarded");
  }
);

it("retains authored line coordinates and cleans scope state after a compiled-script throw", async () => {
  const factoryName = "__mincho_css_scope_factory_trace";
  const id = CSS_SCOPE_RUNTIME_PREFIX + "trace";
  const source = `const scope=${factoryName}(${JSON.stringify(id)});\nscope.setFileScope('trace','pkg');\nthrow new Error('trace-boundary');`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "hint" },
      origin: "/trace.js",
      runtime: { id, factoryName, sourceHash: "" }
    }
  ]);
  let failure: Error | undefined;
  try {
    await processVanillaWithExecution({ source, filePath, cssScopeOrigins });
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.stack).toContain(`${filePath}:3:`);
  const scope = await import("@vanilla-extract/css/fileScope");
  expect(scope.hasFileScope()).toBe(false);
});

it("preserves cascade order across attributed and unattributed emissions of one scope", async () => {
  const factoryName = "__mincho_css_scope_factory_cascade",
    id = CSS_SCOPE_RUNTIME_PREFIX + "cascade";
  const source = `const trusted=${factoryName}(${JSON.stringify(id)});const raw=require('@vanilla-extract/css/fileScope');const css=require('@vanilla-extract/css');
    trusted.setFileScope('same','pkg');css.globalStyle('.same',{color:'red'});trusted.endFileScope();
    raw.setFileScope('same','pkg');css.globalStyle('.same',{color:'blue'});raw.endFileScope();
    trusted.setFileScope('same','pkg');css.globalStyle('.same',{color:'green'});trusted.endFileScope();`;
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "same", packageName: "pkg" },
      origin: "/producer.js",
      runtime: { id, sourceHash: "", factoryName }
    }
  ]);
  const values: Array<{ source: string; origin?: string }> = [];
  await processVanillaWithExecution({
    source,
    filePath,
    cssScopeOrigins,
    serializeVirtualCssPath(value) {
      values.push(value);
      return "";
    }
  });
  expect(values).toHaveLength(1);
  expect(values[0]!.origin).toBeUndefined();
  expect(values[0]!.source.match(/color: (red|blue|green)/g)).toEqual([
    "color: red",
    "color: blue",
    "color: green"
  ]);
});

it("snapshots all static origin tuples before invoking serializers", async () => {
  const source = `const scope=require('@vanilla-extract/css/fileScope'),css=require('@vanilla-extract/css');
    scope.setFileScope('first','pkg');css.globalStyle('.first',{color:'red'});scope.endFileScope();
    scope.setFileScope('second','pkg');css.globalStyle('.second',{color:'blue'});scope.endFileScope();`;
  const origins = [
    {
      fileScope: { filePath: "first", packageName: "pkg" },
      origin: "/first.js"
    },
    {
      fileScope: { filePath: "second", packageName: "pkg" },
      origin: "/second.js"
    }
  ];
  const seen: string[] = [];
  const execution = new CompilationExecution({
    workers: 0,
    evaluation: "auto"
  });
  executions.push(execution);
  await execution.run(() =>
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: origins,
      serializeVirtualCssPath(value) {
        seen.push(value.origin!);
        origins[1]!.origin = "/tampered.js";
        origins[1]!.fileScope.filePath = "changed";
        return "";
      }
    })
  );
  expect(seen).toEqual(["/first.js", "/second.js"]);
});

it("rejects missing runtime registration after native syntax minification", async () => {
  const factoryName = "__mincho_css_scope_factory_minified",
    id = CSS_SCOPE_RUNTIME_PREFIX + "minified";
  const original = `const scope=typeof ${factoryName}==="function"?${factoryName}(${JSON.stringify(id)}):require('@vanilla-extract/css/fileScope');scope.setFileScope('same','pkg');require('@vanilla-extract/css').globalStyle('.same',{color:'red'});scope.endFileScope();`;
  const source = (
    await (await import("esbuild")).transform(original, { minifySyntax: true })
  ).code;
  expect(source).toMatch(/(?<![=!])==(?!=)\s*"function"/);
  const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
    {
      fileScope: { filePath: "same", packageName: "pkg" },
      origin: "/producer.js",
      runtime: { id, sourceHash: "", factoryName }
    }
  ]);
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins,
      serializeCssArtifact: () => ""
    })
  ).resolves.toBeTypeOf("string");
  await expect(
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins: [
        {
          fileScope: { filePath: "same", packageName: "pkg" },
          origin: "/producer.js"
        }
      ],
      serializeCssArtifact: () => ""
    })
  ).rejects.toThrow("compiler runtime registration is required");
});

it("quotes actual default CSS import specifiers in fresh and replay output", async () => {
  const scope = "theme$$$brand's.css.ts";
  const result = await compiled(`
    import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope';
    import {globalStyle} from '@vanilla-extract/css';
    setFileScope('empty.css.ts','pkg');endFileScope();
    setFileScope(${JSON.stringify(scope)},'pkg');globalStyle('.scope',{color:'red'});endFileScope();
    export const name = "quotes";
  `);
  const options = { ...result, filePath };
  let captured: SerializedVanillaEvaluation | undefined;
  const fresh = await processVanillaWithExecution(options, (source) => source, {
    beforeSerialize() {},
    complete(value) {
      captured = value;
    }
  });
  expect(captured!.css).toHaveLength(1);
  expect(captured!.css[0]).toMatchObject({
    fileName: scope + ".vanilla.css",
    source: expect.stringContaining("red")
  });
  const replay = await replayVanillaEvaluation(options, captured!);
  expect(replay).toBe(fresh);
  const first = parseSync(fresh, {
    configFile: false,
    babelrc: false,
    sourceType: "module"
  })!.program.body[0];
  expect(first).toMatchObject({
    type: "ImportDeclaration",
    source: { value: expect.stringContaining(scope + ".vanilla.css?source=") }
  });
});

it("matches upstream CSS text when Node starts without NODE_ENV", async () => {
  const result = await compiled(`
    import {globalStyle} from '@vanilla-extract/css';
    globalStyle('.env-probe', {color: process.env.NODE_ENV === 'undefined' ? 'red' : 'blue'});
    export const name = "env-probe";
  `);
  const { NODE_ENV: _nodeEnv, ...env } = process.env;
  const childSource = `
    import assert from 'node:assert/strict';
    import {processVanillaFile} from '@vanilla-extract/integration';
    import {processVanillaWithExecution} from './vanillaEvaluation.ts';
    import {issueCssScopeRuntimeOrigins} from './fileScopeRuntime.ts';
    assert.equal(process.env.NODE_ENV, undefined);
    const options = ${JSON.stringify({ source: result.source, filePath })};
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(options.source, ${JSON.stringify(result.cssScopeOrigins)});
    const capture = (target) => (value) => { target.push(value.source); return ''; };
    const upstream = [];
    await processVanillaFile({...options,serializeVirtualCssPath:capture(upstream)});
    assert.equal(upstream.length, 1);
    assert.match(upstream[0], /red/);
    delete process.env.NODE_ENV;
    const registered = [];
    await processVanillaWithExecution({...options,cssScopeOrigins,serializeVirtualCssPath:capture(registered)});
    assert.equal(process.env.NODE_ENV, undefined);
    assert.deepEqual(registered,upstream);
    process.stdout.write('CSS text matched');
  `;
  const build = await esbuild.build({
    stdin: { contents: childSource, resolveDir: join(process.cwd(), "src") },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false
  });
  const run = promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-"],
    {
      cwd: join(process.cwd(), "src"),
      env,
      timeout: 10_000
    }
  );
  run.child.stdin!.end(build.outputFiles[0]!.text);
  expect((await run).stdout).toBe("CSS text matched");
}, 15_000);

it("matches upstream's CommonJS parent in registered fresh evaluation", async () => {
  const result = await compiled(
    `import { globalStyle } from "@vanilla-extract/css";
    const sameAuthorApi = require("@vanilla-extract/css").globalStyle === globalStyle;
    globalStyle('.parent-probe', { color: globalThis.module.parent && sameAuthorApi ? 'red' : 'blue' });
    export const parentFilename = globalThis.module.parent?.filename;
    export const parentHasRequire = typeof globalThis.module.parent?.require === 'function';`
  );
  const colors = [[], []] as string[][];
  const upstream = await processVanillaFile({
    source: result.source,
    filePath,
    serializeVirtualCssPath(value) {
      colors[0]!.push(value.source);
      return "";
    }
  });
  const registered = await processVanillaWithExecution({
    source: result.source,
    filePath,
    cssScopeOrigins: result.cssScopeOrigins,
    serializeVirtualCssPath(value) {
      colors[1]!.push(value.source);
      return "";
    }
  });
  expect(colors[0]).toHaveLength(1);
  expect(colors[0]![0]).toContain("red");
  expect(colors[1]).toEqual(colors[0]);
  expect(upstream).toContain("parentHasRequire = true");
  expect(registered).toContain("parentHasRequire = false");
  expect(
    registered.replace("parentHasRequire = false", "parentHasRequire = true")
  ).toBe(upstream);
});

it("keeps independent adapter CSS text while refusing owned artifacts and replay", async () => {
  const result = await compiled(
    'import { style } from "@vanilla-extract/css"; export const box=style({color:"red"});'
  );
  let captured: SerializedVanillaEvaluation | undefined;
  await processVanillaWithExecution(
    { ...result, filePath, serializeCssArtifact: () => "" },
    (value) => value,
    {
      beforeSerialize() {},
      complete(value) {
        captured = value;
      }
    }
  );
  const root = await mkdtemp(join(tmpdir(), "mincho-foreign-evaluation-"));
  try {
    const foreign = join(root, "node_modules/@vanilla-extract/css");
    await mkdir(foreign, { recursive: true });
    // Use a separate evaluation of the installed package, not a fabricated
    // adapter or forwarding aliases to the host's module instance.
    const bundled = await esbuild.build({
      stdin: {
        contents: `module.exports={
          css:require('@vanilla-extract/css'),
          adapter:require('@vanilla-extract/css/adapter'),
          fileScope:require('@vanilla-extract/css/fileScope')
        };`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: "node",
      write: false
    });
    await writeFile(
      join(foreign, "runtime.cjs"),
      bundled.outputFiles[0]!.contents
    );
    for (const [filename, key] of [
      ["index.js", "css"],
      ["adapter.js", "adapter"],
      ["fileScope.js", "fileScope"]
    ])
      await writeFile(
        join(foreign, filename!),
        `module.exports=require('./runtime.cjs').${key};`
      );
    const issuer = join(root, "entry.css.ts");
    const request = { ...result, filePath: issuer };
    expect(createRequire(issuer)("@vanilla-extract/css/adapter")).not.toBe(
      createRequire(filePath)("@vanilla-extract/css/adapter")
    );
    const text = vi.fn(
      (_css: { source: string; origin?: string }) => 'import "independent.css";'
    );
    const upstream = await processVanillaFile({
      ...request,
      serializeVirtualCssPath: text
    });
    expect(text).toHaveBeenCalledTimes(1);
    expect(text.mock.calls[0]![0].source).toContain("red");
    text.mockClear();
    const capture = { beforeSerialize: vi.fn(), complete: vi.fn() };
    expect(
      await processVanillaWithExecution(
        { ...request, serializeVirtualCssPath: text },
        (value) => value,
        capture
      )
    ).toBe(upstream);
    expect(text).toHaveBeenCalledTimes(1);
    expect(text.mock.calls[0]![0].origin).toBeUndefined();
    expect(capture.complete).not.toHaveBeenCalled();

    const execution = new CompilationExecution({ workers: 0 });
    execution.compilationCache = new CompilationCache();
    executions.push(execution);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    for (let pass = 0; pass < 2; pass++) {
      text.mockClear();
      await diagnostics.run(issuer, "test", () =>
        execution.run(() =>
          processDefineRulesPresetRegistryFile({
            ...request,
            serializeVirtualCssPath: text
          })
        )
      );
      expect(text).toHaveBeenCalledTimes(1);
      expect(text.mock.calls[0]![0].origin).toBeUndefined();
    }
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some(
          (event) =>
            event.phase === "evaluation-result-hit" ||
            event.phase === "vm-evaluate"
        )
    ).toBe(false);
    const publish = vi.fn(() => "");
    const options = {
      ...result,
      filePath: join(root, "entry.css.ts"),
      serializeCssArtifact: publish
    };
    const diagnostic =
      "Registered CSS evaluation requires the compiler's vanilla-extract adapter and fileScope instance";
    await expect(processVanillaWithExecution(options)).rejects.toThrow(
      diagnostic
    );
    await expect(replayVanillaEvaluation(options, captured!)).rejects.toThrow(
      diagnostic
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  [
    "unbound arguments",
    'export const box=style({color:typeof arguments==="undefined"?"red":"blue"});',
    "color: red",
    false
  ],
  [
    "fixed script global",
    "var NaN=4;export const box=style({zIndex:NaN});",
    "z-index: NaN",
    true
  ]
])(
  "matches upstream script CSS with %s in both fresh and automatic modes",
  async (_, program, declaration, reusable) => {
    const result = await compiled(
      `import {style} from '@vanilla-extract/css';${program}`
    );
    const context = { cssScopeOrigins: result.cssScopeOrigins };
    expect(
      !!proveReusableEvaluation(result.source, undefined, context),
      "actual compiler proof"
    ).toBe(reusable);
    const css: string[] = [];
    const options = {
      ...result,
      filePath,
      serializeVirtualCssPath(value: { source: string }) {
        css.push(value.source);
        return 'import "script.css";';
      }
    };
    const upstream = await processVanillaFile(options);
    const expected = css.splice(0);
    expect(expected).toHaveLength(1);
    expect(expected[0]).toContain(declaration);
    for (const evaluation of ["fresh", "auto"] as const) {
      const runtime = new CompilationExecution({ workers: 0, evaluation });
      executions.push(runtime);
      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      for (let pass = 0; pass < 2; pass++) {
        const output = await diagnostics.run(filePath, "test", () =>
          runtime.run(() => processVanillaWithExecution(options))
        );
        expect(output).toBe(upstream);
        expect(css.splice(0)).toEqual(expected);
      }
      const events = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events);
      const prepared = reusable && evaluation === "auto";
      expect(
        events.filter((event) => event.phase === "vm-compile")
      ).toHaveLength(prepared ? 1 : 0);
      expect(
        events.filter((event) => event.phase === "vm-context-new")
      ).toHaveLength(prepared ? 2 : 0);
      if (prepared)
        expect(events.some((event) => event.phase === "vm-script-hit")).toBe(
          true
        );
      expect(
        events.some(
          (event) =>
            event.phase === "vm-cached-data-rejected" ||
            event.phase === "vm-context-reuse"
        )
      ).toBe(false);
    }
  }
);

it.each(["\n", "\r", "\u2028"])(
  "rejects a non-identifier factory suffix %j before issuing a registration",
  (suffix) => {
    expect(() =>
      issueCssScopeRuntimeOrigins("", [
        {
          fileScope: { filePath: "logical" },
          origin: filePath,
          runtime: {
            id: CSS_SCOPE_RUNTIME_PREFIX + "invalid",
            sourceHash: "",
            factoryName: "__mincho_css_scope_factory_name" + suffix
          }
        }
      ])
    ).toThrow("Invalid compiler CSS scope runtime registration");
  }
);

it.each(["artifact", "text"] as const)(
  "replays a private %s snapshot across serializer awaits",
  async (kind) => {
    const factoryName = "__mincho_css_scope_factory_snapshot_replay";
    const id = CSS_SCOPE_RUNTIME_PREFIX + "snapshot-replay";
    const source = `const scope=${factoryName}(${JSON.stringify(id)});const css=require('@vanilla-extract/css');
    scope.setFileScope('first','pkg');css.globalStyle('.first',{color:'red'});scope.endFileScope();
    scope.setFileScope('second','pkg');css.globalStyle('.second',{color:'blue'});scope.endFileScope();`;
    const cssScopeOrigins = issueCssScopeRuntimeOrigins(source, [
      {
        fileScope: { filePath: "hint" },
        origin: filePath,
        runtime: { id, sourceHash: "", factoryName }
      }
    ]);
    const options = { source, filePath, cssScopeOrigins };
    let captured: SerializedVanillaEvaluation | undefined;
    await processVanillaWithExecution(
      {
        ...options,
        ...(kind === "artifact"
          ? { serializeCssArtifact: () => "" }
          : { serializeVirtualCssPath: () => "" })
      },
      (value) => value,
      {
        beforeSerialize() {},
        complete(value) {
          captured = value;
        }
      }
    );
    const records = kind === "artifact" ? captured!.artifacts! : captured!.css;
    expect(records).toHaveLength(2);
    const origins: Array<string | undefined> = [];
    const serializer = async (value: {
      origin?: string;
      fileScope: { filePath: string };
    }) => {
      await Promise.resolve();
      origins.push(value.origin);
      if (value.fileScope.filePath === "first") {
        Object.assign(value, { origin: "/not-shared/current.ts" });
        Object.assign(records[1]!, { origin: "/not-validated/later.ts" });
      }
      return "";
    };
    await replayVanillaEvaluation(
      {
        ...options,
        ...(kind === "artifact"
          ? { serializeCssArtifact: serializer }
          : { serializeVirtualCssPath: serializer })
      },
      captured!
    );
    expect(origins).toEqual([filePath, filePath]);
  }
);

it("allows partial legacy CSS text origins without weakening artifact or ambiguity errors", async () => {
  const source = `const scope=require('@vanilla-extract/css/fileScope');const css=require('@vanilla-extract/css');
    scope.setFileScope('first','pkg');css.globalStyle('.first',{color:'red'});scope.endFileScope();
    scope.setFileScope('second','pkg');css.globalStyle('.second',{color:'blue'});scope.endFileScope();`;
  const cssScopeOrigins = [
    {
      fileScope: { filePath: "first", packageName: "pkg" },
      origin: "/first.ts"
    }
  ];
  const runtime = new CompilationExecution({ workers: 0, evaluation: "auto" });
  executions.push(runtime);
  const text = vi.fn(
    (_value: {
      fileScope: { filePath: string };
      origin?: string;
      source: string;
    }) => ""
  );
  await runtime.run(() =>
    processVanillaWithExecution({
      source,
      filePath,
      cssScopeOrigins,
      serializeVirtualCssPath: text
    })
  );
  expect(
    text.mock.calls.map(([value]) => [value.fileScope.filePath, value.origin])
  ).toEqual([
    ["first", "/first.ts"],
    ["second", undefined]
  ]);
  expect(text.mock.calls[1]![0].source).toContain("blue");
  const artifact = vi.fn(() => "");
  await expect(
    runtime.run(() =>
      processVanillaWithExecution({
        source,
        filePath,
        cssScopeOrigins,
        serializeCssArtifact: artifact
      })
    )
  ).rejects.toThrow('Missing CSS scope provenance for "second"');
  expect(artifact).not.toHaveBeenCalled();
  text.mockClear();
  await expect(
    runtime.run(() =>
      processVanillaWithExecution({
        source,
        filePath,
        serializeVirtualCssPath: text,
        cssScopeOrigins: [
          ...cssScopeOrigins,
          ...["/one.ts", "/two.ts"].map((origin) => ({
            fileScope: { filePath: "second", packageName: "pkg" },
            origin
          }))
        ]
      })
    )
  ).rejects.toThrow('Ambiguous CSS file scope "second"');
  expect(text).not.toHaveBeenCalled();
});

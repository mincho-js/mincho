import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import esbuild, { type PluginBuild } from "esbuild";
import { compile, type CompileOptions } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import { babelTransformSource } from "./babel.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { CompilationExecution } from "./compilationExecution.js";
import { processVanillaWithExecution } from "./vanillaEvaluation.js";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";
import { readStaticStyleProgram } from "./staticStyles.js";
import { prepareEvaluationDependencyGraph } from "./evaluationDependencyGraph.js";
import {
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "./defineRulesPreset.js";

const roots: string[] = [];
const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(
  contents: string,
  dependencies: Record<string, string> = {}
) {
  // Parallel cache tests observe the workspace directory for config changes.
  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  const root = await mkdtemp(
    join(process.cwd(), ".cache", "evaluation-optimization-")
  );
  roots.push(root);
  await Promise.all(
    Object.entries({
      "package.json": '{"name":"mincho-evaluation-fixture","sideEffects":true}',
      "entry.css.ts": contents,
      ...dependencies
    }).map(([file, source]) => writeFile(join(root, file), source))
  );

  return {
    root,
    options: {
      filePath: join(root, "entry.css.ts"),
      originalPath: join(root, "entry.css.ts"),
      cwd: process.cwd(),
      contents,
      resolverCache: new Map<string, string>()
    } satisfies CompileOptions
  };
}

async function evaluate(
  source: string,
  filePath: string,
  staticStyles = false,
  raw = false
) {
  const css: string[] = [];
  const artifacts: VanillaCssArtifact[] = [];
  const exports = await processVanillaWithExecution({
    source,
    filePath,
    staticStyles,

    serializeVirtualCssPath: ({ source }) => {
      css.push(source);

      return 'import "css";';
    },

    ...(raw
      ? {
          serializeCssArtifact: (artifact: VanillaCssArtifact) => {
            artifacts.push(artifact);

            return 'import "css";';
          }
        }
      : {})
  });

  return { exports, css: raw ? artifacts.map(generateVanillaCss) : css };
}

function diagnosticEvents(diagnostics: CompilationDiagnostics) {
  return diagnostics.snapshot().builds.flatMap((build) => build.events);
}

describe("closed ESM evaluation demand", () => {
  it("skips AST parsing and resolution when imports are known external intrinsics only", async () => {
    const cache = new CompilationCache();
    const parse = vi.spyOn(cache.parser, "parse");
    const resolve = vi.fn();
    const readFile = vi.fn();
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const result = await diagnostics.run("entry.css.ts", "test", () =>
      prepareEvaluationDependencyGraph({
        source: `import {rules as makeRules} from '@mincho-js/css'; import {setFileScope,endFileScope} from '@vanilla-extract/css/fileScope'; export const box=makeRules({base:{color:'red'}});`,
        filePath: join(process.cwd(), "entry.css.ts"),
        cwd: process.cwd(),
        build: { resolve } as unknown as PluginBuild,
        readFile,
        parser: cache.parser
      })
    );

    expect(result).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(diagnosticEvents(diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "dependency-graph-bypass",
          detail: { reason: "external-intrinsic-imports-only" }
        })
      ])
    );
  });

  it.each([
    ["@tokens", "import"],
    ["#tokens", "import"],
    ["@tokens", "re-export"],
    ["./to\\u006bens", "import"]
  ])("retains graph candidates for %s %s", async (specifier, kind) => {
    const { options } = await fixture(
      kind === "re-export"
        ? `export {red} from '${specifier}';`
        : `import {style} from '@vanilla-extract/css'; import {palette} from '${specifier}'; export const box=style({color:palette.red});`,
      {
        "package.json": JSON.stringify({
          name: "mincho-evaluation-fixture",
          sideEffects: true,
          imports: { "#tokens": "./tokens.ts" }
        }),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@tokens": ["./tokens.ts"] }
          }
        }),
        "tokens.ts": `export const palette={red:'red',unused:'UNUSED_ALIAS_MEMBER'}; export const red='red'; export const other='UNUSED_ALIAS_EXPORT';`
      }
    );

    const baseline = await compile(options);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const optimized = await diagnostics.run(options.filePath, "test", () =>
      compile({ ...options, dependencyGraph: true })
    );

    if (kind === "import")
      expect(baseline.source).toContain("UNUSED_ALIAS_MEMBER");

    expect(optimized.source).not.toContain("UNUSED_ALIAS_MEMBER");
    expect(optimized.source).not.toContain("UNUSED_ALIAS_EXPORT");
    expect(
      diagnosticEvents(diagnostics).some(
        (event) => event.phase === "dependency-graph-scope-skip"
      )
    ).toBe(true);
    expect(await evaluate(optimized.source, options.filePath)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
  });

  it("slices actual named export and nested member preparation through a pure barrel", async () => {
    const { options, root } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {palette} from './barrel'; export const box=style({color:palette.brand.main});`,
      {
        "barrel.ts": `export {palette} from './tokens'; export {unused} from './unused';`,
        "tokens.ts": `export const palette={brand:{main:'red',unused:'UNUSED_MEMBER'},other:'UNUSED_PROPERTY'} as const; export const unusedExport='UNUSED_EXPORT';`,
        "unused.ts": `export const unused={huge:'UNUSED_MODULE'};`
      }
    );

    const baseline = await compile(options);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const optimized = await diagnostics.run(options.filePath, "test", () =>
      compile({ ...options, dependencyGraph: true })
    );

    expect(optimized.source).not.toContain("UNUSED_MEMBER");
    expect(optimized.source).not.toContain("UNUSED_PROPERTY");
    expect(optimized.source).not.toContain("UNUSED_MODULE");
    expect(baseline.source).toContain("UNUSED_MEMBER");
    expect(optimized.watchFiles).toContain(join(root, "unused.ts"));
    expect(await evaluate(optimized.source, options.filePath)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
    expect(
      diagnosticEvents(diagnostics).some(
        (event) => event.phase === "dependency-graph-scope-skip"
      )
    ).toBe(true);
  });

  it("unions demands across aliases, namespace imports and multiple importers", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {red} from './one'; import {blue} from './two'; export const box=style({color:red,background:blue});`,
      {
        "tokens.ts": `const colors={red:'red',blue:'blue',unused:'REMOVE_ME'}; export {colors as palette};`,
        "one.ts": `import {palette as colors} from './tokens'; export const red=colors.red;`,
        "two.ts": `import * as tokens from './tokens'; export const blue=tokens.palette.blue;`
      }
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    expect(optimized.source).not.toContain("REMOVE_ME");
    expect(await evaluate(optimized.source, options.filePath)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
  });

  it.each([
    [
      `import './effect'; export const palette={red:'red',unused:'KEEP_ME'};`,
      `import {globalStyle} from '@vanilla-extract/css'; globalStyle('body',{margin:0});`
    ],
    [`export const palette={get red(){return 'red'},unused:'KEEP_ME'};`, ``],
    [
      `export const palette={red:process.env.MINCHO_GRAPH_TEST_COLOR || 'red',unused:'KEEP_ME'};`,
      ``
    ]
  ])(
    "preserves effects, getters, CJS and unknown expression graphs",
    async (tokens, effect) => {
      const { options } = await fixture(
        `import {style} from '@vanilla-extract/css'; import {palette} from './tokens'; export const box=style({color:palette.red});`,
        { "tokens.ts": tokens, "effect.ts": effect }
      );

      const baseline = await compile(options);
      const optimized = await compile({ ...options, dependencyGraph: true });

      expect(optimized.source).toContain("KEEP_ME");
      expect(await evaluate(optimized.source, options.filePath)).toEqual(
        await evaluate(baseline.source, options.filePath)
      );
    }
  );

  it("preserves CommonJS preparation and execution", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; const {palette}=require('./tokens.cjs'); export const box=style({color:palette.red});`,
      {
        "tokens.cjs": `module.exports={palette:{red:'red',unused:'CJS_MEMBER'}};`
      }
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    expect(optimized.source).toBe(baseline.source);
    expect(await evaluate(optimized.source, options.filePath)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
  });

  it("does not suppress getter effects or throws after a sibling mutates shared data", async () => {
    const { options } = await fixture(
      `import './mutate'; import {style} from '@vanilla-extract/css'; import {kept} from './projection'; export const box=style({color:kept});`,
      {
        "tokens.ts": `export const palette={red:'red',unused:'KEEP_AFTER_ESCAPE'};`,
        "barrel.ts": `export {palette} from './tokens';`,
        "mutate.ts": `import {palette} from './barrel'; Object.defineProperty(palette,'red',{get(){throw new Error('mutated getter')}});`,
        "projection.ts": `import {palette} from './tokens'; export const kept='red'; export const otherwiseUnused=palette.red;`
      }
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    expect(optimized.source).toContain("KEEP_AFTER_ESCAPE");
    await expect(evaluate(baseline.source, options.filePath)).rejects.toThrow(
      "mutated getter"
    );
    await expect(evaluate(optimized.source, options.filePath)).rejects.toThrow(
      "mutated getter"
    );
  });

  it("preserves external Babel dependency transforms", async () => {
    const { root, options } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {palette} from './tokens'; export const box=style({color:palette.red});`,
      {
        "tokens.ts": `export const palette={red:'red',unused:'EXTERNAL_PLUGIN'};`,
        ".babelrc.json": JSON.stringify({ plugins: ["./replace.cjs"] }),
        "replace.cjs": `module.exports=()=>({visitor:{StringLiteral(path){if(path.node.value==='red')path.node.value='blue'}}});`
      }
    );

    await rm(join(root, "package.json"));

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    expect(optimized.source).toContain("EXTERNAL_PLUGIN");

    const result = await evaluate(optimized.source, options.filePath);

    expect(result).toEqual(await evaluate(baseline.source, options.filePath));
    expect(result.css.join("\n")).toContain("blue");
  });

  it("preserves a throwing default export before a later declaration", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {palette} from './tokens'; export const box=style({color:palette.red});`,
      {
        "tokens.ts": `export default later.key; export const palette={red:'red',unused:'PRESERVE_TDZ'}; const later={key:'x'};`
      }
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    expect(optimized.source).toContain("PRESERVE_TDZ");
    await expect(evaluate(baseline.source, options.filePath)).rejects.toThrow();
    await expect(
      evaluate(optimized.source, options.filePath)
    ).rejects.toThrow();
  });

  it("invalidates proofs when a sibling invokes an inherited mutator", async () => {
    const { options } = await fixture(
      `import './mutate'; import {style} from '@vanilla-extract/css'; import {kept} from './projection'; export const box=style({color:kept});`,
      {
        "tokens.ts": `export const palette=[{red:'red'}];`,
        "mutate.ts": `import {palette} from './tokens'; palette.shift();`,
        "projection.ts": `import {palette} from './tokens'; export const kept='red'; export const otherwiseUnused=palette[0].red;`
      }
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, dependencyGraph: true });

    await expect(evaluate(baseline.source, options.filePath)).rejects.toThrow();
    await expect(
      evaluate(optimized.source, options.filePath)
    ).rejects.toThrow();
  });

  it("keeps every member when data escapes or is reflected", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {palette} from './tokens'; export const escaped=palette; export const box=style({color:palette.red});`,
      {
        "tokens.ts": `export const palette={red:'red',unused:'PUBLIC_MEMBER'};`
      }
    );

    const baseline = await compile(options);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const optimized = await diagnostics.run(options.filePath, "test", () =>
      compile({ ...options, dependencyGraph: true })
    );

    expect(optimized.source).toContain("PUBLIC_MEMBER");
    expect(optimized.watchFiles).not.toContain(
      join(options.cwd, ".babelrc.json")
    );
    expect(
      diagnosticEvents(diagnostics).some(
        (event) =>
          event.phase === "dependency-graph-bypass" &&
          (event.detail as { reason?: string })?.reason ===
            "no-closed-data-after-escape"
      )
    ).toBe(true);
    expect(await evaluate(optimized.source, options.filePath)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
  });

  it("keeps full data through cycles and observes removed graph dependencies for cache invalidation", async () => {
    const { root, options } = await fixture(
      `import {style} from '@vanilla-extract/css'; import {palette} from './tokens'; export const box=style({color:palette.red});`,
      {
        "tokens.ts": `import {other} from './cycle'; export const palette={red:'red',unused:'CYCLE_MEMBER'};`,
        "cycle.ts": `import {palette} from './tokens'; export const other=1;`
      }
    );

    const cache = new CompilationCache();
    const optimized = await compile({
      ...options,
      cache,
      dependencyGraph: true
    });

    expect(optimized.source).toContain("CYCLE_MEMBER");

    await writeFile(
      join(root, "tokens.ts"),
      `export const palette={red:'blue',unused:'NOW_REMOVABLE'};`
    );

    const changed = await compile({ ...options, cache, dependencyGraph: true });

    expect(changed.source).not.toContain("NOW_REMOVABLE");
    expect(
      (await evaluate(changed.source, options.filePath)).css.join("\n")
    ).toContain("blue");
  });
});

describe("intrinsic literal static styles", () => {
  it("bypasses intrinsic proof for rules-only sources and preserves ordinary output", async () => {
    const { options } = await fixture(
      `import {rules as makeRules} from '@mincho-js/css'; export const box=makeRules({base:{color:'red'}});`
    );

    const baseline = await compile(options);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const optimized = await diagnostics.run(options.filePath, "test", () =>
      compile({ ...options, staticStyles: true, dependencyGraph: true })
    );

    expect(optimized.source).toBe(baseline.source);
    expect(await evaluate(optimized.source, options.filePath, true)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );
    expect(diagnosticEvents(diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "static-styles-preflight-skip",
          detail: { reason: "no-intrinsic-import" }
        }),
        expect.objectContaining({
          phase: "dependency-graph-bypass",
          detail: { reason: "external-intrinsic-imports-only" }
        })
      ])
    );
  });

  it.each([
    `import {style as paint} from '@vanilla-extract/css';`,
    `import {st\\u0079le as paint} from '@vanilla-extract/css';`,
    `import {style as paint} from '@vanilla-extract/c\\u0073s';`,
    `import /* comment with } */ {style as paint} from '@vanilla-extract/css';`,
    `import // comment\n {style as paint} from '@vanilla-extract/css';`
  ])(
    "keeps supported aliased, escaped and commented imports eligible: %s",
    async (statement) => {
      const { options } = await fixture(
        `${statement} export const box=paint({color:'red'});`
      );

      const baseline = await compile(options);
      const build = vi.fn(esbuild.build);
      const optimized = await compile({
        ...options,
        esbuild: { ...esbuild, build },
        staticStyles: true
      });

      expect(readStaticStyleProgram(optimized.source)).toBeDefined();
      expect(build).not.toHaveBeenCalled();
      expect(await evaluate(optimized.source, options.filePath, true)).toEqual(
        await evaluate(baseline.source, options.filePath)
      );
    }
  );

  it.each([
    ["@vanilla-extract/css", "style", false],
    ["@vanilla-extract/css", "style", true],
    ["@mincho-js/css", "css", false],
    ["@mincho-js/css", "css", true]
  ] as const)(
    "proves actual Babel sidecars for %s/%s with cache %s",
    async (module, intrinsic, cacheEnabled) => {
      const { options } = await fixture(
        `import {${intrinsic}} from '${module}'; export const className=${intrinsic}({color:'red',padding:4});`
      );

      const transformed = await babelTransformSource({
        filename: options.originalPath,
        source: options.contents,
        root: options.cwd,
        babel: { cwd: options.cwd }
      });

      const contents = transformed.result[1]!;

      expect(contents).toContain("export var _$mincho$$className");
      expect(contents).toContain("= _$mincho$$className;");

      const baseline = await compile({ ...options, contents });
      const build = vi.fn(esbuild.build);
      const execution = new CompilationExecution({ workers: 0 }, cacheEnabled);
      executions.push(execution);

      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      const cache = cacheEnabled ? new CompilationCache() : undefined;

      for (let pass = 0; pass < 2; pass++) {
        const actual = await diagnostics.run(options.filePath, "test", () =>
          execution.run(async () => {
            const optimized = await compile({
              ...options,
              contents,
              esbuild: { ...esbuild, build },
              staticStyles: true,
              cache
            });

            const proof = readStaticStyleProgram(optimized.source);

            expect(
              proof?.operations.some((operation) => operation.reference)
            ).toBe(true);

            return evaluate(
              optimized.source,
              options.filePath,
              true,
              cacheEnabled
            );
          })
        );

        expect(actual).toEqual(
          await evaluate(baseline.source, options.filePath)
        );
      }

      expect(build).not.toHaveBeenCalled();
      expect(
        diagnosticEvents(diagnostics).some(
          (event) => event.phase === "vm-evaluate"
        )
      ).toBe(false);
      expect(
        diagnosticEvents(diagnostics).some(
          (event) => event.phase === "static-styles-evaluate"
        )
      ).toBe(true);
    }
  );

  it.each([false, true])(
    "skips esbuild and VM with identical CSS/exports and cache %s",
    async (cacheEnabled) => {
      const { options } = await fixture(
        `import {style as s,globalStyle,keyframes} from '@vanilla-extract/css'; export const z=s({color:'red','@media':{'(min-width: 10px)':{padding:2}}},'box'); globalStyle('body',{margin:0}); export const a=keyframes({from:{opacity:0},to:{opacity:1}},'fade'); export const data={answer:42};`
      );

      const baseline = await compile(options);
      const build = vi.fn(esbuild.build);
      const execution = new CompilationExecution({ workers: 0 }, cacheEnabled);
      executions.push(execution);

      const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
      const cache = cacheEnabled ? new CompilationCache() : undefined;

      for (let iteration = 0; iteration < 2; iteration++) {
        const actual = await diagnostics.run(options.filePath, "test", () =>
          execution.run(async () => {
            const optimized = await compile({
              ...options,
              esbuild: { ...esbuild, build },
              staticStyles: true,
              cache
            });

            expect(readStaticStyleProgram(optimized.source)).toBeDefined();

            return evaluate(optimized.source, options.filePath, true, true);
          })
        );

        expect(actual).toEqual(
          await evaluate(baseline.source, options.filePath)
        );
      }

      expect(build).not.toHaveBeenCalled();
      expect(
        diagnosticEvents(diagnostics).some(
          (event) => event.phase === "static-styles-evaluate"
        )
      ).toBe(true);
      expect(
        diagnosticEvents(diagnostics).some(
          (event) => event.phase === "vm-evaluate"
        )
      ).toBe(false);
    }
  );

  it("replays static results and raw provenance into a new registry session", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; export const box=style({color:'red'});`
    );

    const source = (await compile({ ...options, staticStyles: true })).source;
    const execution = new CompilationExecution({ workers: 0 });
    execution.compilationCache = new CompilationCache();
    execution.compilationCache.configure(
      { type: "memory", evaluationResults: true },
      process.cwd(),
      "test"
    );
    executions.push(execution);

    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    const artifacts: VanillaCssArtifact[] = [];

    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(options.filePath, "test", () =>
          execution.run(() =>
            processDefineRulesPresetRegistryFile({
              source,
              filePath: options.filePath,
              staticStyles: true,

              serializeCssArtifact: (artifact) => {
                artifacts.push(artifact);

                return 'import "css";';
              }
            })
          )
        )
      );

    const first = await run();
    const second = await run();

    expect(first.source).toBe(second.source);
    expect(first.registrySession.instances).toEqual(
      second.registrySession.instances
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts[1]).toEqual(artifacts[0]);
    expect(artifacts[0]!.provenance?.version).toBe(1);
    expect(
      diagnosticEvents(diagnostics).filter(
        (event) => event.phase === "static-styles-evaluate"
      )
    ).toHaveLength(1);
    expect(
      diagnosticEvents(diagnostics).filter(
        (event) => event.phase === "evaluation-result-hit"
      )
    ).toHaveLength(1);
  });

  it("preserves Mincho classes and empty defineRules registry sessions", async () => {
    const { options } = await fixture(
      `import {css,globalCss} from '@mincho-js/css'; export const box=css({color:'red',padding:2}); globalCss('body',{margin:0});`
    );

    const baseline = await compile(options);
    const optimized = await compile({ ...options, staticStyles: true });

    expect(readStaticStyleProgram(optimized.source)).toBeDefined();
    expect(await evaluate(optimized.source, options.filePath, true)).toEqual(
      await evaluate(baseline.source, options.filePath)
    );

    const session = await runDefineRulesPresetRegistryStep(() =>
      processDefineRulesPresetRegistryFile({
        source: optimized.source,
        filePath: options.filePath,
        staticStyles: true,

        serializeVirtualCssPath: () => 'import "css";'
      })
    );

    expect(session.registrySession.instances).toHaveLength(0);
  });

  it.each([
    ["1e999", "export"],
    ["+1e999", "export"],
    ["-1e999", "export"],
    ["1e999", "style"],
    ["+1e999", "style"],
    ["-1e999", "style"]
  ])(
    "preserves nonfinite %s in %s through the normal compiler",
    async (value, target) => {
      const { options } = await fixture(
        target === "export"
          ? `import {style} from '@vanilla-extract/css'; export const value={nested:[${value}]}; export const box=style({color:'red'});`
          : `import {style} from '@vanilla-extract/css'; export const box=style({opacity:${value}});`
      );

      const baseline = await compile(options);
      const build = vi.fn(esbuild.build);
      const optimized = await compile({
        ...options,
        staticStyles: true,
        esbuild: { ...esbuild, build }
      });

      expect(readStaticStyleProgram(optimized.source)).toBeUndefined();
      expect(build).toHaveBeenCalledTimes(1);
      expect(optimized.source).toBe(baseline.source);
      expect(await evaluate(optimized.source, options.filePath, true)).toEqual(
        await evaluate(baseline.source, options.filePath)
      );
    }
  );

  it.each([
    `import {style} from '@vanilla-extract/css'; const value='red'; export const box=style({color:value});`,
    `import {style} from '@vanilla-extract/css'; export const box=style({get color(){return 'red'}});`,
    `const style=(rule)=>'custom'; export const box=style({color:'red'});`,
    `import {style} from '@vanilla-extract/css'; export const box=style({...{color:'red'}});`,
    `import {style} from '@vanilla-extract/css'; export const negativeZero=-0; export const box=style({color:'red'});`,
    `import {style} from '@vanilla-extract/css'; export var box=style({color:'red'}); box='changed';`,
    `import {style} from '@vanilla-extract/css'; export var box=style({color:'red'}); var box=style({color:'blue'});`,
    `import {style} from '@vanilla-extract/css'; export var forward=box; var box=style({color:'red'});`,
    `import {style} from '@vanilla-extract/css'; export var box=style({color:'red'}); var alias=box; alias++;`
  ])(
    "falls back before execution for nonliteral or unproved bindings",
    async (contents) => {
      const { options } = await fixture(contents);
      const build = vi.fn(esbuild.build);
      const optimized = await compile({
        ...options,
        staticStyles: true,
        esbuild: { ...esbuild, build }
      });

      expect(readStaticStyleProgram(optimized.source)).toBeUndefined();
      expect(build).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps the generated source executable when the direct evaluator is disabled", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; export const box=style({color:'red'});`
    );

    const source = (await compile({ ...options, staticStyles: true })).source;

    expect(await evaluate(source, options.filePath, false)).toEqual(
      await evaluate(source, options.filePath, true)
    );
    expect(
      readStaticStyleProgram(source + "\nthrow new Error('extra');")
    ).toBeUndefined();
  });

  it("bypasses the direct compiler and evaluator for evaluation:fresh", async () => {
    const { options } = await fixture(
      `import {style} from '@vanilla-extract/css'; export const box=style({color:'red'});`
    );

    const execution = new CompilationExecution({
      workers: 0,
      evaluation: "fresh"
    });

    executions.push(execution);

    const build = vi.fn(esbuild.build);
    const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
    await diagnostics.run(options.filePath, "test", () =>
      execution.run(async () => {
        const source = (
          await compile({
            ...options,
            staticStyles: true,
            esbuild: { ...esbuild, build }
          })
        ).source;

        expect(readStaticStyleProgram(source)).toBeUndefined();

        await evaluate(source, options.filePath, true);
      })
    );

    expect(build).toHaveBeenCalledTimes(1);
    expect(
      diagnosticEvents(diagnostics).some(
        (event) => event.phase === "static-styles-evaluate"
      )
    ).toBe(false);
  });
});

describe("evaluation compiler resource provenance", () => {
  it("records Mincho private/theme variables and protects exported references without claiming foreign/global variables", async () => {
    const { options } = await fixture(`
      import {createVar,css,theme} from '@mincho-js/css';
      import {createVar as foreignVar,createGlobalVar} from '@vanilla-extract/css';
      export const publicVar=createVar();
      const privateVar=createVar();
      export const foreign=foreignVar();
      export const global=createGlobalVar('explicit-global');
      export const [themeClass,themeVars]=theme({brand:'red'});
      export const box=css({color:publicVar,vars:{[privateVar]:'blue',[foreign]:'green',[global]:'black'}});
    `);

    const source = (await compile(options)).source;
    const artifacts: VanillaCssArtifact[] = [];
    const output = await processVanillaWithExecution({
      source,
      filePath: options.filePath,

      serializeCssArtifact: (artifact) => {
        artifacts.push(artifact);

        return 'import "css";';
      }
    });

    const variable = (name: string) =>
      output.match(new RegExp(name + `\\s*=\\s*["']var\\((--[^)]+)\\)`))![1]!;

    const generated = new Set(
      artifacts.flatMap(
        (artifact) => artifact.provenance?.generatedVariables ?? []
      )
    );

    const publicReferences = new Set(
      artifacts.flatMap(
        (artifact) => artifact.provenance?.publicReferences ?? []
      )
    );

    expect(generated.has(variable("publicVar"))).toBe(true);
    expect(generated.has(variable("foreign"))).toBe(false);
    expect(generated.has(variable("global"))).toBe(false);
    expect(generated.size).toBe(3);
    expect(publicReferences.has(variable("publicVar"))).toBe(true);
    expect(publicReferences.has(variable("foreign"))).toBe(true);
    expect(
      [...generated].filter((name) => publicReferences.has(name))
    ).toHaveLength(2);
  });

  it("unwinds compiler resource capture after a throw before the next file scope", async () => {
    const bad = await fixture(
      `import {createVar,css} from '@mincho-js/css'; const bad=createVar(); css({color:bad}); throw new Error('resource failure');`
    );

    await expect(
      evaluate(
        (await compile(bad.options)).source,
        bad.options.filePath,
        false,
        true
      )
    ).rejects.toThrow("resource failure");

    const captureKey = Symbol.for("@mincho-js/compiler-resources/v1");

    expect(
      (globalThis as unknown as Record<symbol, unknown>)[captureKey]
    ).toBeUndefined();

    const good = await fixture(
      `import {createVar,css} from '@mincho-js/css'; export const good=createVar(); export const box=css({color:good});`
    );

    const artifacts: VanillaCssArtifact[] = [];
    await processVanillaWithExecution({
      source: (await compile(good.options)).source,
      filePath: good.options.filePath,

      serializeCssArtifact: (artifact) => {
        artifacts.push(artifact);

        return 'import "css";';
      }
    });

    expect(artifacts[0]!.provenance?.generatedVariables).toHaveLength(1);
    expect(
      (globalThis as unknown as Record<symbol, unknown>)[captureKey]
    ).toBeUndefined();
  });
});

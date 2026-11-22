import { processVanillaFile } from "@vanilla-extract/integration";
import { issueCssScopeRuntimeOrigins } from "./fileScopeRuntime.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationExecution } from "./compilationExecution.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import * as diskCache from "./diskCache.js";
import * as evaluationProof from "./evaluationProof.js";
import { getActiveDefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";
import {
  processDefineRulesPresetRegistryFile,
  processManagedRegistryFile,
  runDefineRulesPresetRegistryStep
} from "./defineRulesPreset.js";

const executions: CompilationExecution[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(executions.splice(0).map((execution) => execution.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const filePath = join(
  process.cwd(),
  "src/__fixtures__/evaluation-cache.css.ts"
);

function compiled(contents: string) {
  return compile({
    filePath,
    originalPath: filePath,
    contents,
    resolverCache: new Map()
  });
}

function runtime(evaluation: "auto" | "fresh" = "auto", enabled = true) {
  const execution = new CompilationExecution({ workers: 0, evaluation });
  execution.compilationCache = new CompilationCache();
  execution.compilationCache.configure(
    { type: "memory", evaluationResults: enabled },
    process.cwd(),
    "test"
  );
  executions.push(execution);

  return execution;
}

it.each(["default", "callback"] as const)(
  "preserves public CommonJS fileScope identity with %s CSS serialization",
  async (serializer) => {
    const result = await compiled(`
      const first = require("@vanilla-extract/css/fileScope");
      const second = require(["@vanilla-extract/css", "fileScope"].join("/"));
      const color = new Map([[first, "green"]]).get(second) ?? "red";
      first.setFileScope("colors.css.ts", "colors");
      try {
        require("@vanilla-extract/css").globalStyle(".scope-identity", {color});
        module.exports.color = color;
      } finally { first.endFileScope(); }
    `);
    const serialize = vi.fn(({ source }: { source: string }) =>
      JSON.stringify(source)
    );
    const options = {
      ...result,
      filePath,
      ...(serializer === "callback"
        ? { serializeVirtualCssPath: serialize }
        : {})
    };
    const original = await processVanillaFile(options);
    serialize.mockClear();
    const output = await processDefineRulesPresetRegistryFile(options);
    expect(output.source).toBe(original);
    expect(output.source).toContain("export var color = 'green';");
    if (serializer === "callback") {
      expect(serialize).toHaveBeenCalledTimes(1);
      const [css] = serialize.mock.calls[0]!;
      expect(css.source).toContain("color: green");
      expect(css).not.toHaveProperty("origin");
    }
  }
);

it.each([
  [false, true],
  [true, true],
  [true, false]
] as const)(
  "isolates public text from managed evaluation reuse (serializer: %s, result cache: %s)",
  async (callback, resultCache) => {
    const result = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box=style({color:"red"});'
    );
    const execution = runtime("auto", resultCache);
    const run = async (evaluate: typeof processManagedRegistryFile) => {
      const diagnostics = new CompilationDiagnostics({ console: true });
      const serialize = vi.fn(
        ({ source }: { source: string; origin?: string }) => {
          getActiveDefineRulesRegistrySession()!.nextRegistrationIndex +=
            evaluate === processManagedRegistryFile ? 1 : 2;
          return JSON.stringify(source);
        }
      );
      const output = await diagnostics.run(filePath, "evaluation", () =>
        execution.run(() =>
          runDefineRulesPresetRegistryStep(() =>
            evaluate({
              ...result,
              filePath,
              ...(callback ? { serializeVirtualCssPath: serialize } : {})
            })
          )
        )
      );
      const phases = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events.map((event) => event.phase));
      return { output, phases, css: serialize.mock.calls[0]?.[0] };
    };
    const publicCold = await run(processDefineRulesPresetRegistryFile);
    const managedCold = await run(processManagedRegistryFile);
    const publicWarm = await run(processDefineRulesPresetRegistryFile);
    const managedWarm = await run(processManagedRegistryFile);
    expect(managedCold.phases).toContain("vm-evaluate");
    expect(managedCold.phases).not.toContain("evaluation-result-hit");
    expect(managedWarm.phases).toContain(
      resultCache ? "evaluation-result-hit" : "vm-script-hit"
    );
    for (const current of [publicCold, publicWarm]) {
      expect(
        current.phases.filter(
          (phase) =>
            phase.startsWith("vm-") || phase.startsWith("evaluation-result-")
        )
      ).toEqual([]);
      expect(current.output.source).toBe(managedCold.output.source);
    }
    expect(publicCold.output.registrySession).not.toBe(
      publicWarm.output.registrySession
    );
    expect(managedCold.output.source).toBe(managedWarm.output.source);
    if (callback) {
      expect(
        [publicCold, managedCold, publicWarm, managedWarm].map(
          (run) => run.output.registrySession.nextRegistrationIndex
        )
      ).toEqual([2, 1, 2, 1]);
      expect(publicCold.css).not.toHaveProperty("origin");
      expect(publicWarm.css).not.toHaveProperty("origin");
      expect(managedCold.css).toMatchObject({ origin: filePath });
      expect(managedWarm.css).toEqual(managedCold.css);
    }
  }
);

describe("serialized evaluation results", () => {
  it("replays inherited recipe CSS dependencies and their package ordering", async () => {
    // Exercise snapshot replay independently of the intentionally conservative
    // language proof, which currently falls back for imported recipe factories.
    vi.spyOn(evaluationProof, "proveReusableEvaluation").mockReturnValue({
      modules: ["@mincho-js/css", "@mincho-js/css/rules/createRuntimeFn"]
    });

    const { source, cssScopeOrigins } = await compiled(`
      import { rules } from "@mincho-js/css";
      import { createCompiledRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
      const parent = createCompiledRuntimeFn({
        defaultClassName: "parent", variantClassNames: {}, defaultVariants: {}, compoundVariants: [],
        extension: { version: 1, stylePackages: ["@test/ancestor", "@test/parent"] }
      }, {});
      export const child = rules.extends(parent, { color: "blue" });
    `);
    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });
    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processManagedRegistryFile({
              source,
              filePath,
              cssScopeOrigins,
              serializeVirtualCssPath: () => ""
            })
          )
        )
      );
    const first = await run();
    const second = await run();

    expect(first.ancestorStyleSpecifiers).toEqual([
      "@test/ancestor/style.css",
      "@test/parent/style.css"
    ]);
    expect(second.ancestorStyleSpecifiers).toEqual(
      first.ancestorStyleSpecifiers
    );
    expect(second.packageGraph).toEqual(first.packageGraph);
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .filter((event) => event.phase === "evaluation-result-hit")
    ).toHaveLength(1);
  });

  it("replays raw CSS artifacts and separates IR from CSS-text cache entries", async () => {
    const { source, cssScopeOrigins } = await compile({
      filePath,
      originalPath: filePath,
      contents:
        'import {style} from "@vanilla-extract/css"; export const box=style({color:"red"});',
      resolverCache: new Map()
    });

    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });
    const artifacts: VanillaCssArtifact[] = [];

    const run = (deferred: boolean, origins = cssScopeOrigins) =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processManagedRegistryFile({
              source,
              filePath,
              cssScopeOrigins: origins,
              ...(deferred
                ? {
                    serializeCssArtifact: (artifact: VanillaCssArtifact) => {
                      artifacts.push(artifact);

                      return 'import "marker";';
                    }
                  }
                : {}),

              serializeVirtualCssPath: ({ source }) =>
                `import ${JSON.stringify(source)};`
            })
          )
        )
      );

    const text = await run(false);
    const first = await run(true);

    expect((await run(true)).source).toBe(first.source);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[1]).toEqual(artifacts[0]);
    expect(text.source).toContain(
      JSON.stringify(generateVanillaCss(artifacts[0]!))
    );
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((b) => b.events)
        .filter((e) => e.phase === "evaluation-result-hit")
    ).toHaveLength(1);
    const relocated = cssScopeOrigins.map((entry) => ({
      ...entry,
      origin: entry.origin + ".virtual"
    }));
    await expect(run(true, relocated)).rejects.toThrow(
      "Untrusted or stale compiler CSS scope runtime registration"
    );
    // Simulate a newly verified compiler registration for a relocated producer,
    // rather than granting authority by mutating a previously issued receipt.
    await run(true, issueCssScopeRuntimeOrigins(source, relocated));
    expect(artifacts.at(-1)?.origin).toBe(relocated[0]!.origin);
    await run(true);
    expect(artifacts.at(-1)?.origin).toBe(cssScopeOrigins[0]!.origin);
  });

  it.each([
    'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});',
    'import {rules} from "@mincho-js/css"; export const box = rules({color:"red"});'
  ])(
    "replays CSS into the current serializer without executing the module again: %s",
    async (contents) => {
      const { source, cssScopeOrigins } = await compiled(contents);
      const execution = runtime();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const css: string[] = [];
      let callbacks = 0;

      const run = () =>
        runDefineRulesPresetRegistryStep(() =>
          diagnostics.run(filePath, "test", () =>
            execution.run(() =>
              processManagedRegistryFile({
                source,
                filePath,
                cssScopeOrigins,

                serializeVirtualCssPath: ({ source }) => {
                  getActiveDefineRulesRegistrySession()!
                    .nextRegistrationIndex++;
                  css.push(source);

                  return `import "css-${++callbacks}";`;
                }
              })
            )
          )
        );

      const first = await run();
      const second = await run();

      expect(callbacks).toBe(2);
      expect(css[1]).toBe(css[0]);
      expect(second.source.replace("css-2", "css-1")).toBe(first.source);
      expect(second.registrySession).not.toBe(first.registrySession);
      expect(second.registrySession.nextRegistrationIndex).toBe(
        first.registrySession.nextRegistrationIndex
      );
      expect(second.packageGraph).toEqual(first.packageGraph);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events);

      expect(
        events.filter((event) => event.phase === "vm-evaluate")
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.phase === "evaluation-result-hit")
      ).toHaveLength(1);
    }
  );

  it.each(["cold", "warm"] as const)(
    "bypasses a %s result cache when compiler identity is unavailable",
    async (state) => {
      const { source, cssScopeOrigins } = await compiled(
        'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
      );

      const execution = runtime();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const css: string[] = [];
      const run = (owner = execution) =>
        runDefineRulesPresetRegistryStep(() =>
          diagnostics.run(filePath, "test", () =>
            owner.run(() =>
              processManagedRegistryFile({
                source,
                filePath,
                cssScopeOrigins,

                serializeVirtualCssPath: ({ source }) => {
                  css.push(source);

                  return 'import "current.css";';
                }
              })
            )
          )
        );

      const expected = await run(runtime("fresh"));
      // The trusted-capability fresh path now reports VM work too. Count only
      // the requests under test, not this independent reference evaluation.
      const referenceEvents = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events).length;
      if (state === "warm") await run();

      const identity = vi
        .spyOn(diskCache, "getCompilerIdentity")
        .mockRejectedValue(new Error("Compiler identity read failed"));

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run();

        expect(result.source).toBe(expected.source);
        expect(result.packageGraph).toEqual(expected.packageGraph);
        expect(result.registrySession).not.toBe(expected.registrySession);
        expect(getActiveDefineRulesRegistrySession()).toBeUndefined();
      }

      expect(identity).toHaveBeenCalledTimes(2);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .slice(referenceEvents);

      expect(
        events.filter((event) => event.phase === "evaluation-result-bypass")
      ).toEqual([
        expect.objectContaining({
          detail: { reason: "compiler-identity-unavailable" }
        }),
        expect.objectContaining({
          detail: { reason: "compiler-identity-unavailable" }
        })
      ]);
      expect(
        events.filter((event) => event.phase === "vm-evaluate")
      ).toHaveLength(state === "warm" ? 3 : 2);
      expect(
        events.some((event) => event.phase === "evaluation-result-hit")
      ).toBe(false);

      identity.mockRestore();

      expect((await run()).source).toBe(expected.source);
      expect((await run()).source).toBe(expected.source);
      expect(css.every((value) => value === css[0])).toBe(true);
      expect(
        diagnostics
          .snapshot()
          .builds.flatMap((build) => build.events)
          .filter((event) => event.phase === "evaluation-result-hit")
      ).toHaveLength(state === "warm" ? 2 : 1);
    }
  );

  it.each(["disabled", "fresh"] as const)(
    "honors %s without changing output",
    async (mode) => {
      const { source, cssScopeOrigins } = await compiled(
        'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
      );

      const execution = runtime(
        mode === "fresh" ? "fresh" : "auto",
        mode !== "disabled"
      );

      const diagnostics = new CompilationDiagnostics({ console: true });

      const run = () =>
        runDefineRulesPresetRegistryStep(() =>
          diagnostics.run(filePath, "test", () =>
            execution.run(() =>
              processManagedRegistryFile({
                source,
                filePath,
                cssScopeOrigins
              })
            )
          )
        );

      const first = await run();

      expect((await run()).source).toBe(first.source);
      expect(
        diagnostics
          .snapshot()
          .builds.flatMap((build) => build.events)
          .some((event) => event.phase === "evaluation-result-hit")
      ).toBe(false);
    }
  );

  it("restores a persistent result in another execution and rejects changed source", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "mincho-evaluation-results-")
    );

    directories.push(directory);

    let { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
    );

    const diagnostics = new CompilationDiagnostics({ console: true });

    const run = async () => {
      const execution = runtime();
      execution.compilationCache!.configure(
        { type: "filesystem", directory },
        directory,
        "test"
      );

      const result = await runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processManagedRegistryFile({
              source,
              filePath,
              cssScopeOrigins
            })
          )
        )
      );

      await execution.close();

      return result;
    };

    const first = await run();

    expect((await run()).source).toBe(first.source);

    let events = diagnostics.snapshot().builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "evaluation-result-hit")
    ).toHaveLength(1);

    ({ source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color:"blue"});'
    ));

    expect((await run()).source).not.toBe(first.source);

    events = diagnostics.snapshot().builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "vm-evaluate")
    ).toHaveLength(2);
  });

  it("does not publish failed serialization", async () => {
    const { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
    );

    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });
    let fail = true;

    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processManagedRegistryFile({
              source,
              filePath,
              cssScopeOrigins,

              serializeVirtualCssPath() {
                if (fail) throw new Error("serializer failed");

                return "";
              }
            })
          )
        )
      );

    await expect(run()).rejects.toThrow("serializer failed");

    fail = false;

    const first = await run();

    expect((await run()).source).toBe(first.source);

    const events = diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "vm-evaluate")
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.phase === "evaluation-result-hit")
    ).toHaveLength(1);
  });

  it("evaluates programs with untracked inputs on every request", async () => {
    const { source, cssScopeOrigins } = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({padding: Date.now() % 7});'
    );

    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });

    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processManagedRegistryFile({
              source,
              filePath,
              cssScopeOrigins
            })
          )
        )
      );

    await run();
    await run();

    const events = diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "evaluation-result-bypass")
    ).toHaveLength(2);
    expect(
      events.some((event) => event.phase === "evaluation-result-hit")
    ).toBe(false);
  });
});

it("keys, evaluates and replays one immutable origin snapshot despite serializer mutation", async () => {
  const options = { filePath };
  const source = `var scope=require('@vanilla-extract/css/fileScope');var css=require('@vanilla-extract/css');scope.setFileScope('first','pkg');css.globalStyle('.first',{color:'red'});scope.endFileScope();scope.setFileScope('second','pkg');css.globalStyle('.second',{color:'blue'});scope.endFileScope();`;
  const execution = new CompilationExecution({ workers: 0 });
  execution.compilationCache = new CompilationCache();
  execution.compilationCache.configure(
    { type: "memory", evaluationResults: true },
    process.cwd(),
    "snapshot"
  );
  executions.push(execution);
  const diagnostics = new CompilationDiagnostics({ json: "unused.json" });
  const seen: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
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
    const values: string[] = [];
    seen.push(values);
    await runDefineRulesPresetRegistryStep(() =>
      diagnostics.run(options.filePath, "snapshot", () =>
        execution.run(() =>
          processManagedRegistryFile({
            source,
            filePath: options.filePath,
            cssScopeOrigins: origins,
            serializeVirtualCssPath(artifact) {
              values.push(artifact.origin!);
              origins[1]!.origin = "/changed.js";
              return "";
            }
          })
        )
      )
    );
  }
  expect(seen).toEqual([
    ["/first.js", "/second.js"],
    ["/first.js", "/second.js"]
  ]);
  expect(
    diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events)
      .filter((event) => event.phase === "evaluation-result-hit")
  ).toHaveLength(1);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "./compile.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationExecution } from "./compilationExecution.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import * as diskCache from "./diskCache.js";
import { getActiveDefineRulesRegistrySession } from "@mincho-js/css/defineRules/registry";
import {
  processDefineRulesPresetRegistryFile,
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

async function compiled(contents: string) {
  return (
    await compile({
      filePath,
      originalPath: filePath,
      contents,
      resolverCache: new Map()
    })
  ).source;
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

describe("serialized evaluation results", () => {
  it.each([
    'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});',
    'import {rules} from "@mincho-js/css"; export const box = rules({color:"red"});'
  ])(
    "replays CSS into the current serializer without executing the module again: %s",
    async (contents) => {
      const source = await compiled(contents);
      const execution = runtime();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const css: string[] = [];
      let callbacks = 0;

      const run = () =>
        runDefineRulesPresetRegistryStep(() =>
          diagnostics.run(filePath, "test", () =>
            execution.run(() =>
              processDefineRulesPresetRegistryFile({
                source,
                filePath,

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
      const source = await compiled(
        'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
      );

      const execution = runtime();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const css: string[] = [];
      const run = (owner = execution) =>
        runDefineRulesPresetRegistryStep(() =>
          diagnostics.run(filePath, "test", () =>
            owner.run(() =>
              processDefineRulesPresetRegistryFile({
                source,
                filePath,

                serializeVirtualCssPath: ({ source }) => {
                  css.push(source);

                  return 'import "current.css";';
                }
              })
            )
          )
        );

      const expected = await run(runtime("fresh"));
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
        .builds.flatMap((build) => build.events);

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
      const source = await compiled(
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
              processDefineRulesPresetRegistryFile({ source, filePath })
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

    let source = await compiled(
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
            processDefineRulesPresetRegistryFile({ source, filePath })
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

    source = source.replace('"red"', '"blue"');

    expect((await run()).source).not.toBe(first.source);

    events = diagnostics.snapshot().builds.flatMap((build) => build.events);

    expect(
      events.filter((event) => event.phase === "vm-evaluate")
    ).toHaveLength(2);
  });

  it("does not publish failed serialization", async () => {
    const source = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color:"red"});'
    );

    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });
    let fail = true;

    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processDefineRulesPresetRegistryFile({
              source,
              filePath,

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
    const source = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({padding: Date.now() % 7});'
    );

    const execution = runtime();
    const diagnostics = new CompilationDiagnostics({ console: true });

    const run = () =>
      runDefineRulesPresetRegistryStep(() =>
        diagnostics.run(filePath, "test", () =>
          execution.run(() =>
            processDefineRulesPresetRegistryFile({ source, filePath })
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

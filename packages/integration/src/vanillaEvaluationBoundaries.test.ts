import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import * as fileScope from "@vanilla-extract/css/fileScope";
import { processVanillaFile } from "@vanilla-extract/integration";
import { compile } from "./compile.js";
import { CompilationExecution } from "./compilationExecution.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { proveReusableEvaluation } from "./evaluationProof.js";
import { processVanillaWithExecution } from "./vanillaEvaluation.js";

const filePath = join(process.cwd(), "src/__fixtures__/vm-boundaries.css.ts");
const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
});

function execution(cache = true) {
  const value = new CompilationExecution(
    { workers: 0, evaluation: "auto" },
    cache
  );
  executions.push(value);

  return value;
}

async function options() {
  const { source } = await compile({
    filePath,
    originalPath: filePath,
    contents:
      'import { style } from "@vanilla-extract/css"; export const box = style({color: "blue"});',
    resolverCache: new Map()
  });

  return { source, filePath };
}

describe("guarded evaluation boundaries", () => {
  it("supports explicit fresh evaluation", async () => {
    const runtime = new CompilationExecution({ evaluation: "fresh" });
    executions.push(runtime);
    const input = await options();
    const diagnostics = new CompilationDiagnostics({ console: true });

    expect(runtime.evaluation).toBe("fresh");
    for (let index = 0; index < 2; index++)
      await diagnostics.run(filePath, "test", () =>
        runtime.run(() => processVanillaWithExecution(input))
      );

    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some((event) => event.phase.startsWith("vm-"))
    ).toBe(false);
  });

  it.each(["invalid", 1, false, {}])(
    "rejects invalid evaluation mode %j",
    (mode) => {
      expect(
        () => new CompilationExecution({ evaluation: mode as never })
      ).toThrow("execution.evaluation must be auto or fresh");
    }
  );

  it("accepts renamed bindings only for the exact compiler wrapper", async () => {
    const input = await options();
    const source = input.source
      .replace(
        "{ setFileScope, endFileScope }",
        "{ setFileScope: openScope, endFileScope: closeScope }"
      )
      .replace("\nsetFileScope(", "\nopenScope(")
      .replace("\nendFileScope();", "\ncloseScope();");

    expect(source).toContain("\nopenScope(");
    expect(proveReusableEvaluation(source)).toBeDefined();
    expect(
      await execution().run(() =>
        processVanillaWithExecution({ ...input, source })
      )
    ).toBe(await processVanillaFile(input));
  });

  it.each([
    ["let parentCounter = 0", "let parentCounter = 1"],
    ["fileScope.hasFileScope()", "fileScope.endFileScope()"],
    [
      "{ setFileScope, endFileScope }",
      "{ setFileScope: Object, endFileScope }"
    ],
    [
      "{ setFileScope, endFileScope }",
      "{ setFileScope: endFileScope, endFileScope }"
    ]
  ])("rejects a forged wrapper or binding: %s", async (from, to) => {
    const input = await options();
    expect(input.source).toContain(from);
    expect(
      proveReusableEvaluation(input.source.replace(from, to))
    ).toBeUndefined();
  });

  it("rejects nested scopes before reuse", () => {
    expect(
      proveReusableEvaluation(`
      var scope = require("@vanilla-extract/css/fileScope");
      scope.setFileScope("outer.css.ts");
      scope.setFileScope("inner.css.ts");
      scope.endFileScope();
      scope.endFileScope();
    `)
    ).toBeUndefined();
  });

  it("preserves fresh errors outside the consumer module graph", async () => {
    const input = {
      source: "module.exports = { value: 42 };",
      filePath: "/__mincho_unowned_project__/value.css.ts"
    };

    const failure = await processVanillaFile(input).then(
      () => {
        throw new Error("Expected an unavailable consumer protocol");
      },
      (error: Error) => error
    );
    const diagnostics = new CompilationDiagnostics({ console: true });
    await expect(
      diagnostics.run(input.filePath, "test", () =>
        execution().run(() => processVanillaWithExecution(input))
      )
    ).rejects.toMatchObject({ name: failure.name, message: failure.message });
    expect(
      diagnostics.snapshot().builds.flatMap((build) => build.events)
    ).toContainEqual(
      expect.objectContaining({
        phase: "vm-context-bypass",
        detail: { reason: "protocol-unavailable" }
      })
    );
  });

  it("uses fresh evaluation while a consumer holds the shared context", async () => {
    const runtime = execution();
    const input = await options();
    const diagnostics = new CompilationDiagnostics({ console: true });
    let signal!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = diagnostics.run(filePath, "first", () =>
      runtime.run(() =>
        processVanillaWithExecution(input, async (source) => {
          signal();
          await held;

          return source;
        })
      )
    );

    try {
      await Promise.race([
        entered,
        first.then(() => {
          throw new Error("The first consumer did not hold its lease");
        })
      ]);
      const second = await diagnostics.run(filePath, "second", () =>
        runtime.run(() => processVanillaWithExecution(input))
      );
      release();
      expect(await first).toBe(second);
      expect(
        await diagnostics.run(filePath, "third", () =>
          runtime.run(() => processVanillaWithExecution(input))
        )
      ).toBe(second);

      const events = diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events);
      expect(events).toContainEqual(
        expect.objectContaining({
          phase: "vm-context-bypass",
          detail: { reason: "concurrent-evaluation" }
        })
      );
      expect(events.some((event) => event.phase === "vm-context-reuse")).toBe(
        true
      );
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });

  it("preserves an existing file scope and its identifier counter", async () => {
    const input = await options();
    const runtime = execution();
    const diagnostics = new CompilationDiagnostics({ console: true });
    const expected = await processVanillaFile(input);
    fileScope.setFileScope("parent.css.ts", "parent");

    try {
      for (let index = 0; index < 5; index++)
        fileScope.getAndIncrementRefCounter();
      expect(
        await diagnostics.run(filePath, "test", () =>
          runtime.run(() => processVanillaWithExecution(input))
        )
      ).toBe(expected);
      expect(fileScope.getFileScope().filePath).toBe("parent.css.ts");
      expect(fileScope.getAndIncrementRefCounter()).toBe(5);
      expect(
        diagnostics.snapshot().builds.flatMap((build) => build.events)
      ).toContainEqual(
        expect.objectContaining({
          phase: "vm-context-bypass",
          detail: { reason: "active-file-scope" }
        })
      );
    } finally {
      while (fileScope.hasFileScope()) fileScope.endFileScope();
    }
  });

  it("does not retain contexts when compilation caching is disabled", async () => {
    const input = await options();
    const runtime = execution(false);
    const diagnostics = new CompilationDiagnostics({ console: true });

    for (let index = 0; index < 2; index++)
      await diagnostics.run(filePath, "test", () =>
        runtime.run(() => processVanillaWithExecution(input))
      );

    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some((event) => event.phase.startsWith("vm-"))
    ).toBe(false);
  });

  it("keeps separately owned contexts independent when an owner closes", async () => {
    const input = await options();
    const first = execution();
    const second = execution();
    const diagnostics = new CompilationDiagnostics({ console: true });
    const evaluate = (runtime: CompilationExecution) =>
      diagnostics.run(filePath, "test", () =>
        runtime.run(() => processVanillaWithExecution(input))
      );

    const expected = await evaluate(first);
    expect(await evaluate(second)).toBe(expected);
    await first.close();
    expect(await evaluate(second)).toBe(expected);

    const events = diagnostics
      .snapshot()
      .builds.flatMap((build) => build.events);
    expect(
      events.filter((event) => event.phase === "vm-context-new")
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.phase === "vm-context-reuse")
    ).toHaveLength(1);
  });
});

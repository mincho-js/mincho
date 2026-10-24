import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { processVanillaFile } from "@vanilla-extract/integration";
import {
  beginCompilerClassCost,
  endCompilerClassCost
} from "@mincho-js/css/defineRules/registry";
import { CompilationExecution } from "./compilationExecution.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { compile } from "./compile.js";
import { proveReusableEvaluation } from "./evaluationProof.js";
import { processVanillaWithExecution } from "./vanillaEvaluation.js";
import { generateVanillaCss, type VanillaCssArtifact } from "./vanillaCssIr.js";

const executions: CompilationExecution[] = [];

afterEach(async () => {
  await Promise.all(executions.splice(0).map((execution) => execution.close()));
});

const filePath = join(process.cwd(), "src/__fixtures__/vm-proof.css.ts");

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
      const source = await compiledSizeAwareClasses();
      const diagnostics = new CompilationDiagnostics({ console: true });
      const evaluate = () =>
        processVanillaWithExecution({
          source,
          filePath,
          serializeVirtualCssPath: () => "",
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
      const source = await compiledSizeAwareClasses();
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
      const source = await compiled(`
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
      const source = await compiled(
        'import { style, createVar } from "@vanilla-extract/css"; export const color = createVar(); export const box = style({color: "red"});'
      );

      expect(proveReusableEvaluation(source)).toBeDefined();

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
        evaluation !== "fresh"
      );
      expect(events.some((event) => event.phase === "vm-script-hit")).toBe(
        evaluation !== "fresh"
      );
    }
  );

  it("uses fresh contexts by default for programs with unproved effects", async () => {
    const runtime = new CompilationExecution({ evaluation: "auto" });
    executions.push(runtime);

    const source = await compiled(`
      import { style } from "@vanilla-extract/css";
      globalThis.__minchoReuseProbe = (globalThis.__minchoReuseProbe ?? 0) + 1;
      export const box = style({ zIndex: globalThis.__minchoReuseProbe });
    `);

    expect(proveReusableEvaluation(source)).toBeUndefined();

    const options = { source, filePath };
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
    const source = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );

    expect(
      proveReusableEvaluation(
        source.replace("Object.defineProperty", "Object.freeze")
      )
    ).toBeUndefined();
    expect(
      proveReusableEvaluation(source + "\nvar Object = {};")
    ).toBeUndefined();
  });

  it("restores fileScope, adapter and NODE_ENV after a stylesheet throws", async () => {
    const runtime = new CompilationExecution({
      workers: 0,
      evaluation: "auto"
    });

    executions.push(runtime);

    const source = await compiled(
      'import { style } from "@vanilla-extract/css"; export const box = style({selectors:{"body": {color: "red"}}});'
    );

    expect(proveReusableEvaluation(source)).toBeDefined();

    const before = process.env.NODE_ENV;

    await expect(
      runtime.run(() => processVanillaWithExecution({ source, filePath }))
    ).rejects.toThrow();
    expect(process.env.NODE_ENV).toBe(before);

    const valid = await compiled(
      'import { style } from "@vanilla-extract/css"; export const box = style({color: "blue"});'
    );

    expect(
      await runtime.run(() =>
        processVanillaWithExecution({ source: valid, filePath })
      )
    ).toBe(await processVanillaFile({ source: valid, filePath }));
  });

  it("discards the context when artifact validation fails inside its lease", async () => {
    const runtime = new CompilationExecution({
      workers: 0,
      evaluation: "auto"
    });

    executions.push(runtime);

    const source = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );

    const options = { source, filePath };
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

    const source = await compiled(
      'import {style} from "@vanilla-extract/css"; export const box = style({color: "red"});'
    );

    const diagnostics = new CompilationDiagnostics({ console: true });

    for (let iteration = 0; iteration < 3; iteration++) {
      runtime.begin();
      await diagnostics.run(filePath, "test", () =>
        runtime.run(() => processVanillaWithExecution({ source, filePath }))
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

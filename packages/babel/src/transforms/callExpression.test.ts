import { transformSync as compileModule } from "esbuild";
import { runInNewContext } from "node:vm";
import { transformSync, type PluginObj, types as t } from "@babel/core";
import { describe, expect, it } from "vitest";
import { minchoBabelPlugin } from "../index.js";
import {
  markBuildEvaluation,
  retainRuntimeInvocation
} from "../extractionCalls/index.js";
import type { PluginOptions } from "../types.js";

function transform(
  source: string,
  owner?: "build" | "runtime",
  ownerName = "css"
) {
  const options: PluginOptions = {
    result: ["", ""],
    extractCalls: { "test-preset": ["css", "configure", "cx"] },
    optimize: { pureFunctions: false }
  };
  const markOwner = (): PluginObj => ({
    visitor: {
      Program(path) {
        path.traverse({
          CallExpression(call) {
            if (!t.isIdentifier(call.node.callee, { name: ownerName })) return;
            if (owner === "build") markBuildEvaluation(call.node);
            if (owner === "runtime") retainRuntimeInvocation(call.node);
          }
        });
      }
    }
  });
  const result = transformSync(source, {
    filename: "owner.ts",
    configFile: false,
    babelrc: false,
    plugins: [markOwner, [minchoBabelPlugin(), options]]
  });
  return {
    code: result!.code!,
    sidecar: options.result[1],
    sidecarId: options.result[0]
  };
}

const unproven = `import { configure, css } from "test-preset";
import { enabled } from "flags";
if (enabled) configure();
export const cls = css({ color: "red" });`;

describe("compiler-owned build invocation boundary", () => {
  it("reports an unproven compiler-owned invocation instead of emitting runtime authoring", () => {
    expect(() => transform(unproven, "build")).toThrow(
      /Cannot safely extract compiler-owned build-time call/
    );
  });
  it("extracts a proven compiler-owned invocation", () => {
    const result = transform(
      'import { css } from "test-preset"; export const cls = css({ color: "red" });',
      "build"
    );
    expect(result.code).not.toContain("css({");
    expect(result.sidecar).toContain("css({");
  });
  it.each([undefined, "runtime"] as const)(
    "preserves unmarked or runtime-owned calls: %s",
    (owner) => {
      expect(transform(unproven, owner).code).toContain("css({");
    }
  );
  it("respects explicit ignore on a compiler-owned invocation", () => {
    expect(
      transform(
        unproven.replace("css({", "/* mincho-js-ignore */ css({"),
        "build"
      ).code
    ).toContain("css({");
  });
  it("allows unmarked leaves to move with their complete build owner", () => {
    const result = transform(
      'import { mincho$ } from "@mincho-js/css"; import { ordinary } from "runtime"; export const cls = mincho$(() => ordinary("value"));',
      "build",
      "mincho$"
    );
    expect(result.code).not.toContain("ordinary(");
    expect(result.sidecar).toContain('ordinary("value")');
  });
  it("does not classify ordinary values or runtime helpers as build-only", () => {
    const result = transform(
      'import { cx } from "test-preset"; export function render(value) { return ordinary(cx(value)); }'
    );
    expect(result.code).toContain("ordinary(cx(value))");
  });
});

describe("activated deferred class field ownership", () => {
  it.each(["field = ordinary()", "#field = ordinary()"])(
    "keeps instance initialization deferred after whole-callback extraction: %s",
    (field) => {
      const source = `import {mincho$} from '@mincho-js/css'; import {ordinary} from 'runtime'; const C=mincho$(()=>class {${field}}); export const read=()=>new C();`;
      const output = transform(source, "build", "mincho$");
      const events: string[] = [];
      const modules: Record<string, unknown> = {
        "@mincho-js/css": { mincho$: (callback: () => unknown) => callback() },
        runtime: {
          ordinary: () => {
            events.push("field");
            return "blue";
          }
        }
      };
      const execute = (code: string) => {
        const module = { exports: {} };
        runInNewContext(
          compileModule(code, { format: "cjs", target: "esnext" }).code,
          {
            module,
            exports: module.exports,
            require: (name: string) => modules[name]
          }
        );
        return module.exports as { read: () => unknown };
      };
      const original = execute(source);
      expect(events).toEqual([]);
      original.read();
      expect(events).toEqual(["field"]);
      events.length = 0;
      modules[output.sidecarId] = execute(output.sidecar);
      const runtime = execute(output.code);
      expect(events).toEqual([]);
      runtime.read();
      expect(events).toEqual(["field"]);
      // Babel moves the class intact. This is not a claim that a raw class
      // can cross the downstream serializer's artifact boundary.
    }
  );
  it("retains the directly executed callback leaf as a normal build-owned contrast", () => {
    const result = transform(
      "import {mincho$} from '@mincho-js/css'; import {ordinary} from 'runtime'; export const cls=mincho$(()=>ordinary('red'));",
      "build",
      "mincho$"
    );
    expect(result.sidecar).toContain("ordinary('red')");
    expect(result.code).not.toContain("ordinary('red')");
  });
});

import { resolve, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as commonJs from "./commonjs/modules.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow
} from "./moduleGraph.js";

function fixture(files: Record<string, string>) {
  const graph = createModuleGraph();
  const requests: Array<{ source: string; mode: string }> = [];

  function run<T>(flow: ModuleGraphFlow<T>): T {
    let step = flow.next();

    while (!step.done) {
      const request = step.value;
      let value: string | null;

      if (request.kind === "load") value = files[request.id] ?? null;
      else {
        requests.push({
          source: request.source,
          mode: request.mode ?? "import"
        });

        const id =
          request.source === "package"
            ? `/project/${request.mode}.ts`
            : resolve(dirname(request.importer), request.source);

        value = Object.hasOwn(files, id) ? id : null;
      }

      step = flow.next(value);
    }

    return step.value;
  }

  return { graph, run, requests };
}

describe("shared module graph", () => {
  it("resolves namespace calls through reexports and keeps loading modes separate", () => {
    const { graph, run, requests } = fixture({
      "/project/import.ts": 'export { gap } from "./helper.ts";',
      "/project/helper.ts": "export const gap = n => n * 4;",
      "/project/require.ts": "exports.gap = n => n * 8;"
    });

    const program = parseModuleProgram(
      "/project/App.tsx",
      'import * as helpers from "package"; const cjs = require("package"); helpers.gap(2); cjs.gap(2);'
    );

    const owner = { id: "/project/App.tsx", program };
    const targets: string[] = [];
    program.traverse({
      CallExpression(path) {
        if (!path.get("callee").isMemberExpression()) return;

        const target = run(
          graph.valueTarget(owner, path.get("callee"), new Set())
        );

        if (target && !("external" in target)) targets.push(target.module.id);
      }
    });

    expect(targets).toEqual(["/project/helper.ts", "/project/require.ts"]);
    expect(
      requests
        .filter((request) => request.source === "package")
        .map((request) => request.mode)
    ).toEqual(["import", "require"]);
  });

  it("does not resolve cycles or ambiguous star exports to arbitrary definitions", () => {
    const { graph, run } = fixture({
      "/project/cycle.ts": 'export { gap } from "./cycle.ts";',
      "/project/barrel.ts": 'export * from "./a.ts"; export * from "./b.ts";',
      "/project/a.ts": "export const gap = n => n;",
      "/project/b.ts": "export const gap = n => n * 2;"
    });

    const cycle = run(graph.load("/project/cycle.ts"));

    expect(run(graph.resolveExport(cycle, "gap", new Set()))).toBeNull();

    const barrel = run(graph.load("/project/barrel.ts"));

    expect(() => run(graph.resolveExport(barrel, "gap", new Set()))).toThrow(
      "Ambiguous export"
    );
  });

  it("caches CommonJS export shapes within each graph, including default lookups", () => {
    const shape = vi.spyOn(commonJs, "commonJsExports");
    try {
      const files = {
        "/project/helper.cjs":
          "function make() {} module.exports = make; module.exports.named = make;"
      };
      const { graph, run } = fixture(files);
      const helper = run(graph.load("/project/helper.cjs"));

      for (const name of ["named", "default", "named", "default"]) {
        const target = run(
          graph.importTarget(helper, "./helper.cjs", name, new Set())
        );
        expect(
          target &&
            !("external" in target) &&
            target.path.isFunctionDeclaration()
        ).toBe(true);
      }
      expect(shape).toHaveBeenCalledTimes(1);

      const other = fixture(files);
      expect(
        other.run(other.graph.resolveExport(helper, "named", new Set()))
      ).not.toBeNull();
      expect(shape).toHaveBeenCalledTimes(2);
    } finally {
      shape.mockRestore();
    }
  });

  it("rejects reassigned exported helpers", () => {
    const { graph, run } = fixture({
      "/project/helper.ts": "export let gap = n => n; gap = other;"
    });

    const module = run(graph.load("/project/helper.ts"));

    expect(() => run(graph.resolveExport(module, "gap", new Set()))).toThrow(
      "Mutable binding"
    );
  });
});

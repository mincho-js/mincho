import { resolve, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { transformWithEsbuild } from "vite";
import type { TransformOptions } from "@babel/core";
import * as commonJs from "./commonjs/modules.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow
} from "./moduleGraph.js";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";

function fixture(files: Record<string, string>) {
  const graph = createModuleGraph();
  const requests: Array<{ source: string; mode: string }> = [];

  function run<T>(flow: ModuleGraphFlow<T>): T {
    let step = flow.next();

    while (!step.done) {
      const request = step.value;
      let value: string | null;

      if (request.kind === "load") value = files[request.id] ?? null;
      else if (request.kind === "token-reference") value = null;
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
  it.each([false, true])(
    "parses TypeScript dependencies despite forwarded Flow plugins with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const plugins = [
        "jsx",
        ["flow", { all: true }],
        "flowComments",
        ["decorators", { decoratorsBeforeExport: false }]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >;

      for (const extension of ["ts", "tsx", "mts", "cts"]) {
        const source = `export @sealed class Factory {}
          export const rule = ${extension === "tsx" ? '{ color: "red" } as const' : '<const>{ color: "red" }'};
          ${extension === "tsx" ? "export const view = <div />;" : ""}`;
        const program = parseModuleProgram(
          `/project/factory.${extension}`,
          source,
          undefined,
          cache,
          plugins
        );

        expect(program.scope.hasBinding("rule")).toBe(true);
        expect(program.node.body[0]).toMatchObject({
          type: "ExportNamedDeclaration",
          declaration: { type: "ClassDeclaration", decorators: [{}] }
        });
        if (extension === "tsx")
          expect(program.scope.hasBinding("view")).toBe(true);
      }

      expect(
        plugins.map((entry) => (typeof entry === "string" ? entry : entry[0]))
      ).toContain("flow");
    }
  );

  it.each([false, true])(
    "preserves Flow syntax instead of appending TypeScript with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const configurations = [
        ["flow"],
        [["flow", { all: true }]]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >[];

      for (const plugins of configurations) {
        const program = parseModuleProgram(
          "/project/view.jsx",
          `type Props = {| color: string |};
           export const View = (props: Props) => <div>{props.color}</div>;`,
          true,
          cache,
          plugins
        );

        expect(program.node.body[0]).toMatchObject({
          type: "TypeAlias",
          right: { type: "ObjectTypeAnnotation", exact: true }
        });
        expect(program.scope.hasBinding("View")).toBe(true);
      }
    }
  );

  it.each([false, true])(
    "preserves configured decorator syntax with cached parsing=%s",
    (cached) => {
      const program = parseModuleProgram(
        "/project/view.tsx",
        "export @sealed class View { render(): unknown { return <div />; } }",
        true,
        cached ? new SourceAstCache() : undefined,
        [["decorators", { decoratorsBeforeExport: false }]]
      );

      expect(program.node.body[0]).toMatchObject({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "ClassDeclaration",
          decorators: [{ expression: { name: "sealed" } }]
        }
      });
    }
  );

  it.each([false, true])(
    "keeps user TypeScript plugin options over defaults with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const parse = (disallowAmbiguousJSXLike: boolean) =>
        parseModuleProgram(
          "/project/generic.ts",
          "export const identity = <T>(value: T) => value;",
          false,
          cache,
          [["typescript", { disallowAmbiguousJSXLike }]]
        );

      expect(parse(false).scope.hasBinding("identity")).toBe(true);
      expect(() => parse(true)).toThrow("reserved in files with the .mts");
    }
  );

  it.each([false, true])(
    "keeps TS assertions and TSX syntax filename-specific with cached parsing=%s",
    (cached) => {
      const cache = cached ? new SourceAstCache() : undefined;
      const plugins = [
        "jsx",
        ["decorators", { decoratorsBeforeExport: false }]
      ] satisfies NonNullable<
        NonNullable<TransformOptions["parserOpts"]>["plugins"]
      >;
      const program = parseModuleProgram(
        "/project/factory.ts",
        'export @sealed class Factory {} export const rule = <const>{ color: "red" };',
        undefined,
        cache,
        plugins
      );
      const view = parseModuleProgram(
        "/project/view.tsx",
        "export const view = <div />;",
        undefined,
        cache,
        plugins
      );
      const javascript = parseModuleProgram(
        "/project/view.js",
        "export const view = <div />;",
        undefined,
        cache,
        plugins
      );

      expect(program.scope.hasBinding("rule")).toBe(true);
      expect(view.scope.hasBinding("view")).toBe(true);
      expect(javascript.scope.hasBinding("view")).toBe(true);
    }
  );

  it.each([
    ["entry.ts", true, "other"],
    ["entry.mts", true, "raw"],
    ["entry.ts", false, "raw"],
    ["entry.mts", false, "raw"]
  ] as const)(
    "resolves esbuild default interop for %s with __esModule=%s",
    async (filename, marker, expected) => {
      const { code } = await transformWithEsbuild(
        'import make from "./factory.cjs"; export const value = make();',
        filename,
        { format: "cjs" }
      );
      const { graph, run } = fixture({
        "/project/factory.cjs": `function raw() {} function other() {} module.exports = raw; module.exports.__esModule = ${marker}; module.exports.default = other;`
      });
      const program = parseModuleProgram("/project/entry.cjs", code);
      const owner = { id: "/project/entry.cjs", program };
      const targets: string[] = [];

      program.traverse({
        CallExpression(path) {
          if (!path.get("callee").isSequenceExpression()) return;

          const target = run(
            graph.valueTarget(owner, path.get("callee"), new Set())
          );
          if (
            target &&
            !("external" in target) &&
            target.path.isFunctionDeclaration()
          )
            targets.push(target.path.node.id!.name);
        }
      });

      expect(targets).toEqual([expected]);
    }
  );

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

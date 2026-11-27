import { parseModuleProgram } from "../moduleGraph.js";
import { describe, expect, it } from "vitest";
import {
  parseSync,
  transformFromAstSync,
  transformSync,
  types as t,
  type NodePath,
  type PluginObj
} from "@babel/core";
import { minchoBabelPlugin } from "../index.js";
import type { PluginOptions, ProgramScope } from "../types.js";
import {
  assertExtractionPublications,
  requireCapturedPatternOwner,
  finishCapturedAuthoringOwners,
  completeExtractionPublication,
  requireExtractionPublication,
  requiresExtractionPublication
} from "./extractionPublication.js";

const source =
  'import {css} from "test-preset"; export const cls=css({color:"red"});';
function options(): PluginOptions {
  return {
    result: ["", ""],
    extractCalls: { "test-preset": ["css"] },
    optimize: { pureFunctions: false }
  };
}
function inject(
  action: (
    call: NodePath<t.CallExpression>,
    program: NodePath<t.Program>
  ) => void
): PluginObj {
  return {
    visitor: {
      Program: {
        enter(program) {
          let selected: NodePath<t.CallExpression> | undefined;
          program.traverse({
            CallExpression(call) {
              if (call.get("callee").isIdentifier({ name: "css" }))
                selected = call;
            }
          });
          if (!selected) throw new Error("missing fixture call");
          action(selected, program);
        }
      }
    }
  };
}
function run(
  input: string,
  action: (
    call: NodePath<t.CallExpression>,
    program: NodePath<t.Program>
  ) => void
) {
  const config = options();
  const output = transformSync(input, {
    filename: "publication.ts",
    configFile: false,
    babelrc: false,
    plugins: [[minchoBabelPlugin(), config], () => inject(action)]
  });
  return { code: output?.code, sidecar: config.result[1] };
}
describe("state-scoped output publication obligations", () => {
  it("completes only after the lowerer exports and replaces the call", () => {
    const result = run(source, (call, program) => {
      requireExtractionPublication(call);
      expect(
        requiresExtractionPublication(program.scope as ProgramScope, call.node)
      ).toBe(true);
      expect(call.node.extra?.minchoEvaluationOwner).toBeUndefined();
    });
    expect(result.sidecar).toContain("css({");
    expect(result.code).not.toContain("css({");
  });
  it.each([
    'import {css} from "test-preset"; export const cls=/* mincho-js-ignore */ css({color:"red"});',
    'import {css} from "test-preset"; /* mincho-js-ignore */ const cls=css({color:"red"}); export {cls};'
  ])("does not silently drop an ignored required publication: %s", (input) => {
    expect(() =>
      run(input, (call) => requireExtractionPublication(call))
    ).toThrow(/Cannot (?:ignore|complete).*publication/);
  });
  it("does not fall back to runtime when the required call cannot be extracted", () => {
    expect(() =>
      run('const css=runtime; export const cls=css({color:"red"});', (call) =>
        requireExtractionPublication(call)
      )
    ).toThrow(/Cannot safely extract compiler-owned build-time call/);
  });
  it("does not discharge an exact-node obligation with a clone", () => {
    expect(() =>
      run(source, (call, program) => {
        requireExtractionPublication(call);
        const scope = program.scope as ProgramScope;
        const clone = t.cloneNode(call.node, true);
        expect(requiresExtractionPublication(scope, clone)).toBe(false);
        completeExtractionPublication(scope, clone);
        assertExtractionPublications(program);
      })
    ).toThrow(/Cannot complete compiler-owned output publication/);
  });
  it.each(["clone", "replacement"])(
    "rejects an unfinished original node after %s",
    (kind) => {
      expect(() =>
        run(source, (call) => {
          requireExtractionPublication(call);
          call.replaceWith(
            kind === "clone"
              ? t.cloneNode(call.node, true)
              : t.stringLiteral("replacement")
          );
        })
      ).toThrow(/Cannot complete compiler-owned output publication/);
    }
  );
  it("does not leak a pending obligation into a new transform of the same AST", () => {
    const ast = parseSync(source, { sourceType: "module" });
    if (!ast) throw new Error("missing fixture AST");
    let original: t.CallExpression | undefined;
    const transform = (first: boolean) =>
      transformFromAstSync(ast, source, {
        filename: "publication.ts",
        cloneInputAst: false,
        configFile: false,
        babelrc: false,
        plugins: [
          [minchoBabelPlugin(), options()],
          () =>
            inject((call, program) => {
              if (first) {
                original = call.node;
                requireExtractionPublication(call);
                throw new Error("stop first transform");
              }
              expect(call.node).toBe(original);
              expect(call.node.extra?.minchoEvaluationOwner).toBeUndefined();
              expect(
                requiresExtractionPublication(
                  program.scope as ProgramScope,
                  call.node
                )
              ).toBe(false);
              expect(() => assertExtractionPublications(program)).not.toThrow();
            })
        ]
      });
    expect(() => transform(true)).toThrow("stop first transform");
    expect(() => transform(false)).not.toThrow();
  });
});

describe("exact destructuring publication removal", () => {
  function fixture() {
    const program = parseModuleProgram(
      "/pattern.ts",
      `function Box(){const {first,second}=getStyles();return null}`
    );
    const state = {
      imports: new Map(),
      bindings: [],
      nodes: [] as t.Node[],
      cssFile: "pattern.css.js"
    };
    Object.assign(program.scope, { minchoData: state });
    let owner!: NodePath<t.VariableDeclarator>;
    program.traverse({
      VariableDeclarator(path) {
        if (path.get("id").isObjectPattern()) owner = path;
      }
    });
    return { program, owner, state };
  }
  it.each(["clone-init", "replace-init", "clone-id", "missing-sidecar"])(
    "rejects %s instead of deleting changed runtime code",
    (kind) => {
      const { program, owner, state } = fixture();
      requireCapturedPatternOwner(owner);
      state.nodes.push(owner.parent);
      if (kind === "clone-init")
        owner.node.init = t.cloneNode(owner.node.init!);
      if (kind === "replace-init")
        owner.node.init = t.callExpression(t.identifier("other"), []);
      if (kind === "clone-id") owner.node.id = t.cloneNode(owner.node.id);
      if (kind === "missing-sidecar") state.nodes = [];
      expect(() => finishCapturedAuthoringOwners(program)).toThrow(
        /changed before publication/
      );
      expect(owner.removed).toBeFalsy();
    }
  );
  it("does not carry removal authority into a new state for the same AST", () => {
    const { program, owner, state } = fixture();
    requireCapturedPatternOwner(owner);
    state.nodes.push(owner.parent);
    Object.assign(program.scope, { minchoData: { ...state, nodes: [] } });
    expect(() => finishCapturedAuthoringOwners(program)).not.toThrow();
    expect(owner.removed).toBeFalsy();
  });
});

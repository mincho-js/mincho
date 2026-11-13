import {
  transformSync as transformBabel,
  parseSync,
  transformFromAstSync,
  types as t,
  type NodePath
} from "@babel/core";
import { minchoBabelPlugin } from "../index.js";
import type { ProgramScope } from "../types.js";
import {
  requireCapturedAuthoringOwner,
  finishCapturedAuthoringOwners,
  isCommittedCapturedAuthoringOwner
} from "../transforms/extractionPublication.js";
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import { babelTransform } from "../testUtils/plugin.js";

const prefix = `import {defineRules} from '@mincho-js/css';
import {staticValue} from 'test-build';
const owner=defineRules({properties:{color:true}});`;
const uses = `const red=staticValue(()=>owner.css({color:'red'}));
const blue=staticValue(()=>owner.css({color:'blue'}));
const cx=staticValue(()=>owner.cx);
export const result=cx(red,blue);`;
function execute(source: string, modules: Record<string, unknown>) {
  const module = { exports: {} };
  const code = transformSync(source, { format: "cjs", target: "esnext" }).code;
  new Function("require", "module", "exports", code)(
    (name: string) => modules[name],
    module,
    module.exports
  );
  return module.exports;
}
describe("captured compiler authoring owner", () => {
  it.each([0, 1, 2])(
    "moves one owner instance with %s callback evaluations",
    (count) => {
      const source = prefix + uses;
      const events: string[] = [];
      let owners = 0;
      const modules = {
        "@mincho-js/css": {
          defineRules: () => {
            const id = ++owners;
            events.push(`owner:${id}`);
            return {
              css: (style: { color: string }) => {
                events.push(`${id}:${style.color}`);
                return style.color;
              },
              cx: (...classes: string[]) => classes.join(" ")
            };
          }
        },
        "test-build": {
          staticValue: (callback: () => unknown) => {
            events.push("wrapper");
            let result: unknown = () => "skipped";
            for (let i = 0; i < count; i++) result = callback();
            return result;
          }
        }
      };
      const original = execute(source, modules);
      const expected = [...events];
      events.length = 0;
      owners = 0;
      const { code, result } = babelTransform(source, {
        extractCalls: { "test-build": ["staticValue"] }
      });
      expect(result[1]).toContain("defineRules(");
      expect(code).not.toContain("defineRules(");
      const sidecar = execute(result[1], modules);
      expect(execute(code, { ...modules, [result[0]]: sidecar })).toEqual(
        original
      );
      expect(events).toEqual(expected);
      expect(owners).toBe(1);
    }
  );
  it.each([
    [
      "effectful config capture",
      prefix
        .replace("const owner=", "const config=makeConfig(); const owner=")
        .replace("{properties:{color:true}}", "{read:()=>config}") + uses
    ],
    [
      "effectful callback capture",
      prefix +
        "const extra=effect();" +
        uses.replace("{color:'red'}", "{color:extra}")
    ],
    [
      "multi declaration effects",
      prefix.replace("const owner=", "const extra=effect(),owner=") + uses
    ],
    ["runtime owner escape", prefix + uses + "export {owner};"],
    [
      "runtime callback escape",
      prefix + "export const callback=()=>owner.cx;" + uses
    ],
    [
      "deferred nested callback",
      prefix + "const later=staticValue(()=>()=>owner.cx); export {later};"
    ],
    [
      "ordinary factory",
      prefix.replace(
        "defineRules({properties:{color:true}})",
        "ordinaryFactory()"
      ) + uses
    ],
    ["intervening observation", prefix + "observe();" + uses],
    [
      "unknown owner argument effects",
      prefix.replace("{properties:{color:true}}", "readConfig()") + uses
    ]
  ])("does not own %s", (_name, source) => {
    const { code, result } = babelTransform(source, {
      extractCalls: { "test-build": ["staticValue"] }
    });
    expect(result[1]).not.toContain("defineRules(");
    expect(code).toContain("staticValue(");
  });
});

describe("captured owner removal obligations", () => {
  function inject(
    action: (
      owner: NodePath<t.VariableDeclarator>,
      program: NodePath<t.Program>
    ) => void
  ) {
    return {
      visitor: {
        Program: {
          enter(program: NodePath<t.Program>) {
            const statement = program.get("body")[0];
            if (!statement?.isVariableDeclaration())
              throw new Error("missing declaration");
            action(statement.get("declarations")[0]!, program);
          }
        }
      }
    };
  }
  it.each([
    "initializer",
    "identifier",
    "declaration",
    "block move",
    "statement move"
  ])("rejects changed exact %s before removal", (kind) => {
    expect(() =>
      transformBabel("const owner=make(); observe();", {
        filename: "owner.ts",
        configFile: false,
        babelrc: false,
        plugins: [
          [minchoBabelPlugin(), { result: ["", ""] }],
          () =>
            inject((owner, program) => {
              (program.scope as ProgramScope).minchoData.nodes.push(
                owner.parent as t.Statement
              );
              requireCapturedAuthoringOwner(owner);
              if (kind === "initializer")
                owner
                  .get("init")
                  .replaceWith(
                    t.callExpression(t.identifier("otherEffect"), [])
                  );
              if (kind === "identifier")
                owner.get("id").replaceWith(t.identifier("other"));
              if (kind === "declaration")
                owner.replaceWith(t.cloneNode(owner.node, true));
              if (kind === "statement move") program.node.body.reverse();
              if (kind === "block move") {
                const statement = owner.parentPath;
                statement.replaceWith(
                  t.blockStatement([statement.node as t.Statement])
                );
              }
              finishCapturedAuthoringOwners(program);
            })
        ]
      })
    ).toThrow(/initializer changed/);
  });
  it("does not reuse the same AST's receipt in another transform generation", () => {
    const ast = parseSync("const owner=make();");
    if (!ast) throw new Error("missing AST");
    const run = (first: boolean) =>
      transformFromAstSync(ast, "", {
        filename: "owner.ts",
        cloneInputAst: false,
        configFile: false,
        babelrc: false,
        plugins: [
          [minchoBabelPlugin(), { result: ["", ""] }],
          () =>
            inject((owner, program) => {
              const init = owner.get("init");
              if (!init.isCallExpression()) throw new Error("missing call");
              if (first) {
                requireCapturedAuthoringOwner(owner);
                throw new Error("stop generation");
              }
              expect(isCommittedCapturedAuthoringOwner(init)).toBe(false);
              finishCapturedAuthoringOwners(program);
              expect(owner.node.init).toBe(init.node);
            })
        ]
      });
    expect(() => run(true)).toThrow("stop generation");
    expect(() => run(false)).not.toThrow();
  });
});

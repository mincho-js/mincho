import {
  parseSync,
  transformSync,
  traverse,
  type NodePath,
  types as t
} from "@babel/core";
import { expect, it } from "vitest";
import { scopedFileScopeRuntime } from "./fileScopeRuntime.js";
import { getVerifiedFileScopeRequire } from "./fileScopeNamespace.js";

function verified(source: string) {
  let result: NodePath<t.CallExpression> | undefined;
  traverse(parseSync(source, { configFile: false, babelrc: false })!, {
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id, { name: "namespace" }))
        result = getVerifiedFileScopeRequire(
          path.get("init") as NodePath<t.Node>
        );
    }
  });
  return result;
}
it.each(['require("@vanilla-extract/css/fileScope")', scopedFileScopeRuntime])(
  "recognizes exact file scope forwarding: %s",
  (expression) => {
    expect(
      verified(`const namespace=${expression}`)?.node.arguments
    ).toMatchObject([
      { type: "StringLiteral", value: "@vanilla-extract/css/fileScope" }
    ]);
  }
);
it.each([
  scopedFileScopeRuntime.replace(
    "fileScope.setFileScope(...args)",
    'fileScope.setFileScope("forged", "pkg")'
  ),
  scopedFileScopeRuntime.replace(
    "fileScope.endFileScope();",
    "opaque();fileScope.endFileScope();"
  ),
  '(mod=>({setFileScope(){}}))(require("@vanilla-extract/css/fileScope"))',
  '__importStar(require("@vanilla-extract/css/fileScope"))'
])(
  "does not trust arbitrary or modified namespace wrappers: %s",
  (expression) => {
    expect(verified(`const namespace=${expression}`)).toBeUndefined();
  }
);
it("rejects a shadowed loader inside the exact wrapper", () => {
  expect(
    verified(`function use(require){const namespace=${scopedFileScopeRuntime}}`)
  ).toBeUndefined();
});

it.each([false, true])(
  "recognizes only unchanged wrappers after TypeScript erasure: changed=%s",
  (changed) => {
    const expression = changed
      ? scopedFileScopeRuntime.replace(
          "fileScope.setFileScope(...args)",
          'fileScope.setFileScope("forged", "pkg")'
        )
      : scopedFileScopeRuntime;
    const ast = transformSync(`const namespace=${expression};`, {
      filename: "fixture.ts",
      configFile: false,
      babelrc: false,
      presets: [["@babel/preset-typescript", { allExtensions: true }]],
      ast: true
    })!.ast!;
    let result: NodePath<t.CallExpression> | undefined;
    let original: t.Node | undefined;
    let snapshot: t.Node | undefined;
    traverse(ast, {
      VariableDeclarator(path) {
        if (t.isIdentifier(path.node.id, { name: "namespace" })) {
          original = path.node.init!;
          snapshot = structuredClone(original);
          result = getVerifiedFileScopeRequire(
            path.get("init") as NodePath<t.Node>
          );
        }
      }
    });
    expect(!!result).toBe(!changed);
    // Comparison must not mutate the host-owned transformed AST.
    expect(Object.hasOwn(original!, "typeParameters")).toBe(true);
    expect(original).toEqual(snapshot);
  }
);

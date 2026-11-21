import { transformSync as emitTypeScript } from "esbuild";
import { runInNewContext } from "node:vm";
import { parseSync, traverse, type NodePath, types as t } from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import {
  hasPrimitiveInvocationResult,
  describeArgumentPrimitiveInvocation
} from "./primitiveInvocation.js";
function proves(source: string) {
  const binding = parseModuleProgram(
    "/fixture/provider.ts",
    source
  ).scope.getBinding("factory");
  if (!binding) throw new Error("missing factory");
  return hasPrimitiveInvocationResult(
    binding.path.isVariableDeclarator()
      ? binding.path.get("init")
      : binding.path
  );
}
describe("normal-call primitive result contract", () => {
  it.each([
    "function factory(x) { x.effect(); return `value-${x}`; }",
    "function factory(x) { if (x) return 1; }",
    "function factory(x) { return +x; }",
    "function factory(x) { return x.value++; }",
    "function factory(x) { return x + 1; }",
    'function factory(x) { return (x.effect(), "done"); }',
    "function factory(x) { const result = `${x}`; return result; }",
    'function factory(x) { return x ? "a" : 1; }',
    "function factory() { throw {}; }",
    "function factory() { function nested() { return {}; } return true; }",
    "const factory = x => `${x}`;"
  ])("certifies result, not invocation effects: %s", (source) =>
    expect(proves(source)).toBe(true)
  );
  it.each([
    "function factory() { const {constructor} = 1; return constructor; }",
    "function factory() { const {toString} = 'x'; return toString; }",
    "function factory() { const {constructor: selected} = 1; return selected; }",
    "async function factory() { return 1; }",
    "function* factory() { return 1; }",
    "function factory(x) { return x; }",
    'function factory(state, color="blue") { state.color=color; return state.color; }',
    "function factory(x) { return x ? {} : 1; }",
    "function factory(x) { return x && 1; }",
    "function factory() { return new Number(1); }",
    "function factory() { return /x/; }",
    "function factory() { return unknown(); }",
    "function factory() { try { return 1; } finally { return {}; } }",
    "function factory() { try { return 1; } finally { effect(); } }",
    "function factory() { let x=1; x={}; return x; }",
    'function factory() { eval("effect()"); return 1; }',
    "class factory { constructor() { return {}; } }"
  ])("retains unsupported result boundaries: %s", (source) =>
    expect(proves(source)).toBe(false)
  );
  it("does not authorize construction of an otherwise primitive-returning function", () => {
    expect(proves("function factory() { return 1; }")).toBe(true);
    expect(
      typeof new (
        function () {
          return 1;
        } as unknown as new () => object
      )()
    ).toBe("object");
  });
});

function argumentContract(source: string) {
  const binding = parseModuleProgram(
    "/fixture/provider.ts",
    source
  ).scope.getBinding("factory");
  if (!binding) throw new Error("missing factory");
  return describeArgumentPrimitiveInvocation(
    binding.path.isVariableDeclarator()
      ? binding.path.get("init")
      : binding.path
  );
}
describe("conditional argument primitive result", () => {
  it.each([
    ["const factory = value => value", 0],
    ["function factory(first, second) { return second; }", 1],
    ["const factory = function(value) { return value; }", 0]
  ])("describes only the formal slot: %s", (source, index) => {
    expect(argumentContract(source as string)).toEqual({
      kind: "argument-primitive",
      index
    });
  });
  it.each([
    "async function factory(value) { return value; }",
    "function* factory(value) { return value; }",
    "function factory(value = {}) { return value; }",
    "function factory(...value) { return value; }",
    "function factory({value}) { return value; }",
    "function factory(value) { value = {}; return value; }",
    "function factory(value) { effect(); return value; }",
    "function factory(value) { return arguments[0]; }",
    "function factory(value) { return value.field; }",
    "function factory(value) { return () => value; }",
    "function factory(value) { return (effect(), value); }",
    "const other = {}; function factory(value) { return other; }"
  ])("does not infer broader input flow: %s", (source) => {
    expect(argumentContract(source)).toBeUndefined();
  });
});

it.each([
  'let mode = "a"; eval("mode = {}"); function factory() { return mode; }',
  '"use strict"; let mode = "a"; eval("mode = {}"); function factory() { return mode; }',
  'let mode = "a"; function rewrite() { eval("mode = {}"); } rewrite(); function factory() { return mode; }'
])("withholds primitive results after enclosing direct eval: %s", (source) => {
  expect(proves(source)).toBe(false);
});

it("withholds a sloppy-script function whose outer lookup is intercepted by with", () => {
  let factory!: NodePath<t.FunctionExpression>;
  const ast = parseSync(
    'let mode = "a"; with ({mode: {}}) { const factory = function() { return mode; }; }',
    {
      sourceType: "script",
      configFile: false,
      babelrc: false
    }
  )!;
  traverse(ast, {
    FunctionExpression(path) {
      factory = path;
    }
  });
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});

it("does not assume that a shadowed eval cannot contain intrinsic eval", () => {
  let factory!: NodePath<t.FunctionDeclaration>;
  const ast = parseSync(
    'function outer(eval) { let mode = "a"; eval("mode = {}"); function factory() { return mode; } return factory(); }',
    {
      sourceType: "script",
      configFile: false,
      babelrc: false
    }
  )!;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});

it.each([
  "function eval() {}",
  "const eval = function() {};",
  "const eval = () => {};"
])("preserves an exact non-intrinsic shadowed eval: %s", (declaration) => {
  let factory!: NodePath<t.FunctionDeclaration>;
  const ast = parseSync(
    `${declaration} const mode = "a"; eval("mode = {}"); function factory() { return mode; }`,
    {
      sourceType: "script",
      configFile: false,
      babelrc: false
    }
  )!;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
});

it.each([
  'const evaluator = eval; evaluator("mode = {}")',
  'eval?.("mode = {}")',
  '(0, eval)("mode = {}")',
  'Function("mode = {}")()',
  '(function() {}).constructor("mode = {}")()'
])(
  "withholds a script global binding changed by indirect eval: %s",
  (invocation) => {
    const source = `let mode = 1; ${invocation}; function factory() { return mode; } factory()`;
    let factory!: NodePath<t.FunctionDeclaration>;
    traverse(
      parseSync(source, {
        sourceType: "script",
        configFile: false,
        babelrc: false
      })!,
      {
        FunctionDeclaration(path) {
          if (path.node.id?.name === "factory") factory = path;
        }
      }
    );
    expect(typeof runInNewContext(source)).toBe("object");
    expect(hasPrimitiveInvocationResult(factory)).toBe(false);
  }
);

it.each([
  'const evaluator = eval; evaluator("globalThis.mode = {}")',
  'eval?.("globalThis.mode = {}")',
  '(0, eval)("globalThis.mode = {}")'
])(
  "does not confuse indirect global eval with a module lexical binding: %s",
  (invocation) => {
    expect(
      proves(
        `let mode = 1; ${invocation}; export function factory() { return mode; }`
      )
    ).toBe(true);
  }
);

it("keeps script function-local mutable bindings separate from globals", () => {
  const ast = parseSync(
    'function outer() { let mode = 1; const evaluator = eval; evaluator("globalThis.mode = {}"); function factory() { return mode; } return factory; }',
    { sourceType: "script", configFile: false, babelrc: false }
  )!;
  let factory!: NodePath<t.FunctionDeclaration>;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
});

it.each(["let", "var"])(
  "does not use a mutable script-global %s initializer as result proof",
  (kind) => {
    const ast = parseSync(
      `${kind} mode = 1; function factory() { return mode; }`,
      { sourceType: "script", configFile: false, babelrc: false }
    )!;
    let factory!: NodePath<t.FunctionDeclaration>;
    traverse(ast, {
      FunctionDeclaration(path) {
        if (path.node.id?.name === "factory") factory = path;
      }
    });
    expect(hasPrimitiveInvocationResult(factory)).toBe(false);
  }
);

it("preserves primitive literals without relying on ambient lexical bindings", () => {
  expect(
    proves('eval("globalThis.mode = {}"); function factory() { return 1; }')
  ).toBe(true);
});

it("rejects unsupported parameter origins without a whole-program lexical scan", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "export const factory = rule => rule;"
  );
  const binding = program.scope.getBinding("factory")!;
  if (!binding.path.isVariableDeclarator()) throw new Error("missing fixture");
  const scan = vi.spyOn(program, "traverse").mockImplementation(() => {
    throw new Error("unsupported origin must not scan the program");
  });
  try {
    expect(hasPrimitiveInvocationResult(binding.path.get("init"))).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
});

it.each([
  ["function factory(){var mode=1;{function mode(){}}return mode;}", false],
  ["function factory(){var mode=1;return mode;}", true],
  [
    "function factory(){'use strict';var mode=1;{function mode(){}}return mode;}",
    true
  ],
  [
    "function factory(){let mode=1; (eval as typeof eval)('mode={}');return mode;}",
    false
  ],
  [
    "let mode=1;(eval as typeof eval)('mode={}');function factory(){return mode;}",
    false
  ],
  ["function factory(){let mode=1;(eval!)('mode={}');return mode;}", false],
  ["function factory(){let mode=1;eval?.('mode={}');return mode;}", true],
  ["function factory(){let mode=1;(0,eval)('mode={}');return mode;}", true]
] as const)("respects lexical mutation semantics: %s", (source, expected) => {
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript"] }
  })!;
  let result: boolean | undefined;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory")
        result = hasPrimitiveInvocationResult(path);
    }
  });
  expect(result).toBe(expected);
});

it("does not confuse a block function's own strict body with its sloppy Annex B declaration", () => {
  const source =
    "function factory(){var mode=1;{function mode(){'use strict';}}return mode;}";
  expect(typeof runInNewContext(`${source};factory()`)).toBe("function");
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory")
        expect(hasPrimitiveInvocationResult(path)).toBe(false);
    }
  });
});

it("withdraws primitive result after a raw AST write without scope recrawl", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "function factory(){let x=0;return x;}"
  );
  const factory = program.scope.getBinding("factory")!.path;
  if (!factory.isFunctionDeclaration()) throw new Error("Expected factory");
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
  factory.node.body.body.splice(
    1,
    0,
    t.expressionStatement(
      t.assignmentExpression("=", t.identifier("x"), t.objectExpression([]))
    )
  );
  expect(factory.scope.getBinding("x")!.constant).toBe(true);
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});

it("reads constant authority after a newly inserted loop refreshes scope metadata", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "function factory(){let x=0;return x;}"
  );
  const factory = program.scope.getBinding("factory")!.path;
  if (!factory.isFunctionDeclaration()) throw new Error("Expected factory");
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
  factory.node.body.body.splice(
    1,
    0,
    t.forOfStatement(
      t.identifier("x"),
      t.arrayExpression([t.objectExpression([])]),
      t.blockStatement([])
    )
  );
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});
it("does not keep an unbound primitive proof after inserting a local shadow", () => {
  const program = parseModuleProgram(
    "/fixture/provider.ts",
    "function factory(){return undefined;}"
  );
  const factory = program.scope.getBinding("factory")!.path;
  if (!factory.isFunctionDeclaration()) throw new Error("Expected factory");
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
  factory.node.body.body.unshift(
    t.variableDeclaration("const", [
      t.variableDeclarator(t.identifier("undefined"), t.objectExpression([]))
    ])
  );
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});
it.each([
  ["function factory(this:void,value:any){return value}", 0],
  ["function factory(this:void,first:any,second:any){return second}", 1],
  ["function factory(first:any,second:any){return second}", 1]
] as const)(
  "describes runtime slots after erased TypeScript parameters: %s",
  (source, index) => {
    expect(argumentContract(source)).toEqual({
      kind: "argument-primitive",
      index
    });
  }
);
it("does not treat externally replaceable script eval as a local shadow", () => {
  const source = `var saved=globalThis.eval;var eval=()=>{};globalThis.eval=saved;function outer(){let mode=1;eval('mode={}');function factory(){return mode}return factory()}outer()`;
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  let factory!: NodePath<t.FunctionDeclaration>;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(typeof runInNewContext(source)).toBe("object");
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});
it("retains a genuinely function-local unchanged eval shadow", () => {
  const source = `function outer(){const eval=()=>{};let mode=1;eval('mode={}');function factory(){return mode}return factory()}outer()`;
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  let factory!: NodePath<t.FunctionDeclaration>;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(runInNewContext(source)).toBe(1);
  expect(hasPrimitiveInvocationResult(factory)).toBe(true);
});
it("does not let immutable aliases hide a mutable origin changed by restored eval", () => {
  const source = `var saved=globalThis.eval;var eval=()=>{};globalThis.eval=saved;function outer(){let mode=1;eval('mode={}');const alias=mode;function factory(){return alias}return factory()}outer()`;
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  let factory!: NodePath<t.FunctionDeclaration>;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(typeof runInNewContext(source)).toBe("object");
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});
it("does not ignore a direct eval var which shadows an outer const", () => {
  const source = `const mode='a';function outer(){eval('var mode={}');function factory(){return mode}return factory()}outer()`;
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  let factory!: NodePath<t.FunctionDeclaration>;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === "factory") factory = path;
    }
  });
  expect(typeof runInNewContext(source)).toBe("object");
  expect(hasPrimitiveInvocationResult(factory)).toBe(false);
});

it("matches TypeScript-emitted runtime argument zero for erased this", () => {
  const source = "function factory(this:void,value:any){return value}";
  const contract = argumentContract(source)!;
  const actual = [{}, 1];
  const returned = runInNewContext(
    emitTypeScript(`${source};factory({},1)`, { loader: "ts" }).code
  );
  expect(typeof returned).toBe("object");
  expect(contract.index).toBe(0);
  expect(typeof actual[contract.index]).toBe("object");
});

it("uses current runtime parameters rather than approving a duplicate from stale bindings", () => {
  const ast = parseSync("function factory(first,second){return first}", {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  traverse(ast, {
    FunctionDeclaration(fn) {
      const binding = fn.scope.getBinding("first");
      expect(describeArgumentPrimitiveInvocation(fn)).toEqual({
        kind: "argument-primitive",
        index: 0
      });
      fn.node.params[1] = t.identifier("first");
      expect(fn.scope.getBinding("first")).toBe(binding);
      expect(describeArgumentPrimitiveInvocation(fn)).toBeUndefined();
    }
  });
});

it.each([false, true])(
  "requires an emitted primitive initializer: ambient=%s",
  (ambient) => {
    expect(
      proves(
        `${ambient ? "declare " : ""}const mode=1;function factory(){return mode}`
      )
    ).toBe(!ambient);
  }
);

it.each([
  ["function factory(){return NaN}", true],
  ["function factory(){enum NaN { Red } return NaN}", false],
  [
    "function factory(){namespace Infinity { export const Red=0 } return Infinity}",
    false
  ],
  ["function factory(){type NaN=number;return NaN}", true],
  ["function factory(){ { function undefined(){} } return undefined }", false],
  [
    "function factory(){ 'use strict'; { function undefined(){} } return undefined }",
    true
  ],
  [
    "function factory(){ function other(){ { function undefined(){} } } return undefined }",
    true
  ],
  ["function factory(){ { function label(){} } return undefined }", true]
] as const)(
  "checks unmodeled emitted shadows before using default globals: %s",
  (source, expected) => {
    const ast = parseSync(source, {
      configFile: false,
      babelrc: false,
      sourceType: source.includes("namespace ") ? "module" : "script",
      parserOpts: { plugins: ["typescript"] }
    })!;
    traverse(ast, {
      FunctionDeclaration(path) {
        if (path.node.id?.name === "factory")
          expect(hasPrimitiveInvocationResult(path)).toBe(expected);
      }
    });
  }
);

it("does not use a conditional var initializer for the implicit arguments value", () => {
  const source =
    "function factory(early){if(early)return arguments;var arguments=1;return arguments}factory(true)";
  const ast = parseSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false
  })!;
  traverse(ast, {
    FunctionDeclaration(path) {
      expect(hasPrimitiveInvocationResult(path)).toBe(false);
    }
  });
  expect(typeof runInNewContext(source)).toBe("object");
});

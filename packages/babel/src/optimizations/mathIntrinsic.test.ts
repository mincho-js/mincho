import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import { createMathIntrinsicEnvironment } from "./mathIntrinsic.js";

function source(
  text: string,
  sourceType: "script" | "module" = "script",
  receiver = "Math"
) {
  let program!: NodePath<t.Program>;
  let call!: NodePath<t.CallExpression>;
  traverse(
    parseSync(text, {
      configFile: false,
      babelrc: false,
      sourceType,
      parserOpts: { plugins: ["typescript"] }
    })!,
    {
      Program(path) {
        program = path;
      },
      CallExpression(path) {
        if (
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object, { name: receiver })
        )
          call = path;
      }
    }
  );
  return { program, call };
}

describe("Math primitive result environment", () => {
  it.each([
    ["sloppy alias shadow", "", "Alias", "Alias", ".max", false],
    ["strict alias shadow", '"use strict";', "Alias", "Alias", ".max", true],
    ["sloppy key shadow", "", "key", "Math", "[key]", false],
    ["strict key shadow", '"use strict";', "key", "Math", "[key]", true],
    ["unrelated shadow", "", "unrelated", "Alias", "[key]", true]
  ] as const)(
    "requires lexical authority for native method identity: %s",
    (_case, directive, declaration, receiver, member, proven) => {
      const { program, call } = source(
        `const Alias = Math; const key = "max";
         function sample() {
           ${directive}
           { function ${declaration}() {} }
           return ${receiver}${member}(1, 2);
         }`,
        "script",
        receiver
      );
      const environment = createMathIntrinsicEnvironment();
      environment.observe(program);
      expect(environment.referenceIdentity(call.get("callee"))?.kind).toBe(
        proven ? "method" : undefined
      );
      expect(environment.provesPrimitiveResult(call)).toBe(proven);
    }
  );

  it.each([
    ["__proto__", false],
    ["toString", true]
  ] as const)(
    "separates legacy descriptor acquisition from direct Math authority: %s",
    (key, bindIntact) => {
      const { program, call } = source(
        `Object.getOwnPropertyDescriptor(Object.prototype, "${key}"); Math.max(1,2);`
      );
      const environment = createMathIntrinsicEnvironment();
      environment.observe(program);
      expect(environment.snapshot().bindIntact).toBe(bindIntact);
      expect(environment.provesPrimitiveResult(call)).toBe(true);
    }
  );

  it.each([
    "Math.max(1, 2)",
    "Math.random()",
    "Math.max(read())",
    "Math.max({valueOf(){observe(); return 1}})",
    "Math.max(...values)",
    "typeof window; typeof Math; void globalThis; Math.max(1,2)"
  ])(
    "proves only a normal-return primitive, preserving effects: %s",
    (text) => {
      const { program, call } = source(text);
      const environment = createMathIntrinsicEnvironment();
      environment.observe(program);
      expect(environment.provesPrimitiveResult(call)).toBe(true);
    }
  );
  it.each([
    "Math.max = replacement",
    "Math[key] = replacement",
    "delete Math.max",
    "Math = replacement",
    "globalThis.Math = replacement",
    "globalThis['Math'].max = replacement",
    "globalThis[key] = replacement",
    "const alias = Math; alias.max = replacement",
    "Object.defineProperty(Math, 'max', descriptor)",
    "Object.assign(Math, values)",
    "Reflect.set(Math, 'max', replacement)",
    "expose(Math)",
    "const root=globalThis; root.Math=replacement",
    "eval(code)",
    "const Math={max(){return {}}}",
    "({Math} = replacement)",
    "[Math] = values",
    "Math.max ||= replacement",
    "Object.defineProperty(globalThis, 'Math', descriptor)"
  ])("withdraws on shadow, mutation or escape: %s", (setup) => {
    const { program, call } = source(`${setup}; Math.max(1,2)`);
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(false);
  });
  it.each([
    "global",
    "window",
    "self",
    "globalThis.window",
    "window.globalThis",
    "globalThis.self",
    "globalThis.window.self"
  ])("withdraws on standard realm alias writes: %s", (alias) => {
    const { program, call } = source(
      `${alias}.Math.max = () => ({color:'blue'}); Math.max()`
    );
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(false);
  });
  it.each(["global", "window", "self"])(
    "keeps a lexically shadowed host alias separate: %s",
    (alias) => {
      const { program, call } = source(
        `const ${alias}={Math:{}}; ${alias}.Math.max=replacement; Math.max()`
      );
      const environment = createMathIntrinsicEnvironment();
      environment.observe(program);
      expect(environment.provesPrimitiveResult(call)).toBe(true);
    }
  );
  it.each([
    "const realm=globalThis.window; realm.Math.max=replacement",
    "opaque(window)",
    "Object.assign(globalThis.self, {Math: replacement})"
  ])("withdraws on host alias escapes: %s", (setup) => {
    const { program, call } = source(`${setup};Math.max()`);
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(false);
  });
  it.each([
    '(0,eval)("Math.max=()=>({})")',
    'const e=eval; e("Math.max=()=>({})")',
    'Function("Math.max=()=>({})")()',
    'new Function("Math.max=()=>({})")()',
    'const C=Function; C("Math.max=()=>({})")()',
    'globalThis.eval("Math.max=()=>({})")',
    'window.Function("Math.max=()=>({})")()',
    '(()=>{}).constructor("Math.max=()=>({})")()',
    '(()=>{})?.constructor("Math.max=()=>({})")()',
    'const C=[].filter["constructor"]; C("Math.max=()=>({})")()'
  ])("withdraws on observable dynamic code capability: %s", (setup) => {
    const { program, call } = source(`${setup};Math.max()`);
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(false);
  });
  it("does not confuse a shadowed Function with a dynamic-code intrinsic", () => {
    const { program, call } = source(
      "const Function=()=>{}; Function(); Math.max()"
    );
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(true);
  });
  it("does not mistake an unrelated max property for Math", () => {
    const { program, call } = source(
      "const object={};object.max=replacement; Math.max(1,2)"
    );
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.provesPrimitiveResult(call)).toBe(true);
  });
  it("revokes prior positive queries after a later graph load", () => {
    const first = source("Math.max(1,2)");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(first.program);
    expect(environment.provesPrimitiveResult(first.call)).toBe(true);
    const before = environment.snapshot();
    environment.observe(source("globalThis.Math.max=replacement").program);
    expect(environment.provesPrimitiveResult(first.call)).toBe(false);
    expect(environment.snapshot().intact).toBe(false);
    expect(environment.revision).toBeGreaterThan(before.revision);
  });
  it("rescans an observed AST after transformation", () => {
    const first = source("Math.max(1,2)");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(first.program);
    expect(environment.provesPrimitiveResult(first.call)).toBe(true);
    first.program.pushContainer(
      "body",
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(t.identifier("Math"), t.identifier("max")),
          t.identifier("replacement")
        )
      )
    );
    expect(environment.provesPrimitiveResult(first.call)).toBe(false);
  });
});

describe("constant Math method aliases", () => {
  function aliasCall(setup: string, callText: string) {
    const { program } = source(`${setup}; ${callText};`);
    const statement = program.get("body").at(-1)!;
    if (!statement.isExpressionStatement())
      throw new Error("Expected expression");
    const call = statement.get("expression");
    if (!call.isCallExpression()) throw new Error("Expected call");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    return environment.provesPrimitiveResult(call);
  }
  it.each([
    ["const M=Math", "M.max(1,2)"],
    ["const M=Math;const N=M", "N.max(read())"],
    ["const {max}=Math", "max(1,2)"],
    ["const {max: highest}=Math", "highest({valueOf(){observe();return 1}})"],
    ["const highest=Math.max", "highest(1,2)"],
    ["const highest=Math.max.bind(Math)", "highest(1,2)"],
    [
      "const M=Math; const {max}=M;const highest=max.bind(M,read())",
      "highest(1,2)"
    ],
    ["", "Math.max.bind(Math)(1,2)"]
  ])("preserves a constant alias result contract: %s; %s", (setup, call) => {
    expect(aliasCall(setup, call)).toBe(true);
  });
  it("keeps direct Math valid when only bind authority is lost", () => {
    expect(
      aliasCall(
        "const object={};Object.assign(object,{max:replacement})",
        "Math.max(1,2)"
      )
    ).toBe(true);
    expect(
      aliasCall(
        "const object={};Object.assign(object,{max:replacement});const highest=Math.max.bind(Math)",
        "highest(1,2)"
      )
    ).toBe(false);
  });
  it("carries revoked bind authority into a later consumer environment", () => {
    const environment = createMathIntrinsicEnvironment();
    environment.observe(
      source("Object.defineProperty(target,'bind',descriptor)").program
    );
    const snapshot = environment.snapshot();
    expect(snapshot.intact).toBe(true);
    expect(snapshot.bindIntact).toBe(false);
    const { program } = source(
      "const highest=Math.max.bind(Math);highest(1,2)"
    );
    const statement = program.get("body").at(-1)!;
    if (!statement.isExpressionStatement())
      throw new Error("Expected expression");
    const call = statement.get("expression");
    if (!call.isCallExpression()) throw new Error("Expected call");
    const consumer = createMathIntrinsicEnvironment({
      bindIntact: snapshot.bindIntact
    });
    consumer.observe(program);
    expect(consumer.provesPrimitiveResult(call)).toBe(false);
  });
  it.each([
    "const M=Math;M.max=replacement;const highest=M.max",
    "const M=Math;expose(M);const highest=M.max",
    "const {max}=Math;expose(max);const highest=max",
    "let highest=Math.max;highest=replacement",
    "const Math={max(){return {}}};const highest=Math.max",
    "Function.prototype.bind=replacement;const highest=Math.max.bind(Math)",
    "const prototype=Object.getPrototypeOf(()=>{});prototype.bind=replacement;const highest=Math.max.bind(Math)",
    "const O=Object;O.defineProperty((()=>{}).__proto__,'bind',{value:replacement});const highest=Math.max.bind(Math)",
    "const define=Object.defineProperty;define(target,'bind',{value:replacement});const highest=Math.max.bind(Math)",
    "globalThis.window.Object.defineProperty(target,'bind',descriptor);const highest=Math.max.bind(Math)",
    "const highest=Math.max.bind(other)"
  ])("withdraws on alias escape/write or lost bind authority: %s", (setup) => {
    expect(aliasCall(setup, "highest(1,2)")).toBe(false);
  });
});

describe("Math reference identity versus evaluation", () => {
  it("retains bound input evaluation dependencies instead of skipping its initializer", () => {
    const { program } = source(
      "const M=Math;const max=M.max.bind(M,read(),{valueOf(){observe();return 1}});max(0)"
    );
    const statement = program.get("body").at(-1)!;
    if (!statement.isExpressionStatement())
      throw new Error("Expected expression");
    const call = statement.get("expression");
    if (!call.isCallExpression()) throw new Error("Expected call");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    const identity = environment.referenceIdentity(call.get("callee"));
    expect(identity?.kind).toBe("method");
    expect(identity?.dependencies.map((path) => path.toString())).toEqual([
      "read()",
      "{\n  valueOf() {\n    observe();\n    return 1;\n  }\n}"
    ]);
    expect(environment.provesPrimitiveResult(call)).toBe(true);
  });
  it("identifies exact namespace and bind member reads without calling them primitive results", () => {
    const { program } = source("const M=Math; const max=M.max.bind(M);max(0)");
    const declaration = program.get("body")[1];
    if (!declaration.isVariableDeclaration())
      throw new Error("Expected declaration");
    const init = declaration.get("declarations")[0].get("init");
    if (!init.isCallExpression()) throw new Error("Expected bind call");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    expect(environment.referenceIdentity(init.get("callee"))?.kind).toBe(
      "bind"
    );
    expect(environment.referenceIdentity(init.get("arguments")[0])?.kind).toBe(
      "namespace"
    );
    expect(environment.provesPrimitiveResult(init)).toBe(false);
  });
});

describe("optional and closed-computed Math calls", () => {
  function prove(text: string) {
    let program!: NodePath<t.Program>;
    let call!: NodePath<t.CallExpression | t.OptionalCallExpression>;
    traverse(parseSync(text, { configFile: false, babelrc: false })!, {
      Program(path) {
        program = path;
      },
      "CallExpression|OptionalCallExpression"(path) {
        call = path as NodePath<t.CallExpression | t.OptionalCallExpression>;
      }
    });
    const environment = createMathIntrinsicEnvironment();
    environment.observe(program);
    return environment.provesPrimitiveResult(call);
  }
  it.each([
    "Math?.max(0,1)",
    "Math.max?.(0,1)",
    "Math?.max?.(0,1)",
    "const M=Math;M?.max(0,1)",
    "const {max}=Math;max?.(0,1)",
    "Math['max'](0,1)",
    "const key='max';Math[key](0,1)",
    "const first='max';const key=first;Math?.[key]?.(0,1)"
  ])("proves a non-null intrinsic with closed selection: %s", (text) => {
    expect(prove(text)).toBe(true);
  });
  it.each([
    "const Math={max(){return {}}};Math?.max(0,1)",
    "Math.max=replacement;Math?.max(0,1)",
    "const key=read();Math[key](0,1)",
    "const key={toString(){return 'max'}};Math[key](0,1)",
    "const key=source.name;Math[key](0,1)",
    "let key='max';Math[key](0,1)",
    "Math[key](0,1);const key='max'",
    "const key='max';Math[key]=replacement;Math?.[key](0,1)"
  ])("does not execute or infer unknown computed selection: %s", (text) => {
    expect(prove(text)).toBe(false);
  });
});

describe("global this intrinsic observations", () => {
  it.each([
    "this.Math.max = other",
    "(()=>{this.Math.max = other})()",
    "function replace(){this.Math.max = other} replace()",
    "const realm=this; realm.Math.max=other",
    "class C { [this.Math.max=other]() {} }"
  ])("withdraws for a possible global receiver: %s", (setup) => {
    const { program, call } = source(setup + "; Math.max(1,2)");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  });
});

it.each([
  '"use strict"; this.Math.max=other',
  "function f(){(()=>{this.Math.max=other})()} f()",
  "class C { [(()=>{this.Math.max=other})()](){} }",
  "this[key]=other"
])("withdraws lexical global this authority: %s", (setup) => {
  const { program, call } = source(setup + "; Math.max(1,2)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});
it.each([
  '{const f=function(){"use strict";this.Math.max=other}}',
  '"use strict"; {const f=function(){this.Math.max=other}}',
  '{const f=function(){"use strict";(()=>{this.Math.max=other})()}}',
  "class C { method(){this.Math.max=other} }",
  "class C { field=()=>{this.Math.max=other} }",
  "class C { static {this.Math.max=other} }",
  "class C { static field=()=>{this.Math.max=other} }",
  "this.unrelated"
])("preserves distinct or strict this receivers: %s", (setup) => {
  const { program, call } = source(setup + "; Math.max(1,2)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each([
  "this.Object.defineProperty(target,'bind',descriptor)",
  "this.Reflect.set(target,'bind',replacement)",
  "function f(){this.Object.assign(target,patch)} f()"
])("withdraws bind separately through global this: %s", (setup) => {
  const { program, call } = source(setup + "; Math.max(1,2)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
  expect(env.snapshot().bindIntact).toBe(false);
});

it.each([
  "globalThis.valueOf().Math.max=()=>({});Math.max()",
  '(()=>{})["con"+"structor"]("Math.max=()=>({})")();Math.max()',
  '(function(){})[key]("Math.max=()=>({})")();Math.max()'
])(
  "withdraws Math result authority for observed realm recovery: %s",
  (text) => {
    const { program, call } = source(text);
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it.each([
  'Reflect.get(()=>{},"__proto__")',
  '(()=>{const get=Reflect.get;return get(()=>{},"__proto__")})()',
  '(()=>{const {get}=Reflect;return get(()=>{},"__proto__")})()'
])(
  "withdraws only bind authority for reflected callable acquisition: %s",
  (acquire) => {
    const { program, call } = source(
      `const p=${acquire};p["bi"+"nd"]=()=>()=>({});const highest=Math.max.bind(Math);highest();Math.max(1,2)`
    );
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.snapshot().bindIntact).toBe(false);
    expect(env.provesPrimitiveResult(call)).toBe(false);
    const direct = source(
      `const p=${acquire};p["bi"+"nd"]=()=>()=>({});Math.max(1,2)`
    );
    const directEnv = createMathIntrinsicEnvironment();
    directEnv.observe(direct.program);
    expect(directEnv.provesPrimitiveResult(direct.call)).toBe(true);
    program.traverse({
      CallExpression(path) {
        if (t.isIdentifier(path.node.callee, { name: "highest" }))
          expect(env.provesPrimitiveResult(path)).toBe(false);
      }
    });
  }
);

it.each([
  "const f=()=>{};",
  "const f=class{};",
  "function f(){};",
  "class f{};",
  "const original=()=>{};const f=original;"
])(
  "withdraws unresolved constructor acquisition from constant callable aliases: %s",
  (declaration) => {
    const { program, call } = source(
      `${declaration}f["con"+"structor"]("Math.max=()=>({})")();Math.max()`
    );
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it("preserves unrelated computed data reads and closed Math selections", () => {
  const { program, call } = source(
    'const f={label:1};const value=f[key];Math["max"](1,2)'
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each(["__defineGetter__", "__defineSetter__"])(
  "withdraws Math authority for inherited global receiver mutation: %s",
  (method) => {
    const operation =
      method === "__defineGetter__"
        ? `globalThis.__defineGetter__('Math',()=>({max:()=>({})}));`
        : `globalThis.__defineSetter__('trip',()=>{Math.max=()=>({})});globalThis.trip=1;`;
    const { program, call } = source(`${operation}Math.max()`);
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it.each(["Object.keys", "[].filter", "parseInt", "opaque", "(()=>()=>{})()"])(
  "withdraws unresolved constructor access on a possible callable: %s",
  (receiver) => {
    const { program, call } = source(
      `const c=read();${receiver}[c]('Math.max=()=>({})')();Math.max()`
    );
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);

it("preserves a fresh own non-callable member while retaining unknown alias vetoes", () => {
  const { program, call } = source(
    "const data=({nested:{label:1}}).nested[key];Math.max(1,2)"
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});
it.each([
  'function f(value){value[key]("Math.max=()=>({})")()}',
  'let value=()=>{};value=read();value[key]("Math.max=()=>({})")()',
  'const data={nested:{}};data.nested=read();data.nested[key]("Math.max=()=>({})")()'
])(
  "does not mistake unknown mutable or parameter values for non-callables: %s",
  (text) => {
    const { program, call } = source(text + ";Math.max()");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);

it("validates once per result query and rechecks the next query", () => {
  const { program, call } = source("Math.max(1,2)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  const scan = vi.spyOn(program, "traverse");
  try {
    env.snapshot();
    const perPass = scan.mock.calls.length;
    expect(perPass).toBeGreaterThan(0);
    scan.mockClear();
    expect(env.provesPrimitiveResult(call)).toBe(true);
    expect(scan.mock.calls.length).toBe(perPass);
    program.node.body.push(...source("Math.max=opaque;").program.node.body);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  } finally {
    scan.mockRestore();
  }
});
it.each([
  "const {constructor:C}=()=>{};",
  "let C;({constructor:C}=()=>{});",
  "const {nested:{constructor:C}}={nested:()=>{}};",
  'const { ["con"+"structor"]:C}=()=>{};',
  'const key="constructor";const {[key]:C}=()=>{};',
  "const {constructor:C,...rest}=()=>{};"
])("observes destructured callable constructor capture: %s", (declaration) => {
  const { program, call } = source(
    declaration + 'C("Math.max=()=>({})")();Math.max()'
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});
it("keeps ordinary data destructuring and rest independent of Math authority", () => {
  const { program, call } = source(
    "const {label,...rest}={label:1,other:2};const {[key]:value}={label:1};Math.max(1,2)"
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each([
  'function use({constructor:C}){C("Math.max=()=>({})")()}use(()=>{});',
  'try{throw ()=>{}}catch({constructor:C}){C("Math.max=()=>({})")()}',
  'for(const {constructor:C} of [()=>{}]){C("Math.max=()=>({})")()}',
  "for(const {constructor:C} in object){capture(C)}",
  "function use({nested:{[key]:C}}){capture(C)}"
])(
  "observes protected pattern reads at parameters, catch and loop targets: %s",
  (text) => {
    const { program, call } = source(text + ";Math.max()");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it("preserves unrelated parameter and loop data selections", () => {
  const { program, call } = source(
    "function use({label}){return label}for(const {label} of data){use({label})};Math.max(1,2)"
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each([
  ["function use({[spacing * 2]:value}){};Math.max(1,2)", true],
  [
    "function use({[(Math.max=opaque, spacing)*2]:value}){};Math.max(1,2)",
    false
  ]
])(
  "separates numeric pattern key identity from operand effects: %s",
  (text, expected) => {
    const { program, call } = source(text);
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(expected);
  }
);

it("resolves an exact string-literal concatenation pattern key", () => {
  const { program, call } = source(
    "const {['val'+'ue']:size}={value:4};Math.max(1,2)"
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each([
  "declare const globalThis:any;globalThis.Math.max=()=>({});",
  'const data={__proto__:()=>{}};let key="constructor";const C=data[key];C("Math.max=()=>({})")();',
  'const data={__proto__:()=>{}};let key="constructor";const {[key]:C}=data;C("Math.max=()=>({})")();',
  'Object.defineProperty(Object.getPrototypeOf(()=>{}),"bind",{value(receiver){receiver.max=()=>({});return ()=>0}});const highest=Math.max.bind(Math);'
])("withdraws for observed constructor or native bind escapes: %s", (text) => {
  const { program, call } = source(text + "Math.max()");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});
it("revalidates Math alias references after raw AST insertion", () => {
  const { program, call } = source("const M=Math;Math.max()");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
  program.node.body.splice(
    1,
    0,
    parseSync("M.max=()=>({})", { configFile: false, babelrc: false })!.program
      .body[0]!
  );
  expect(env.provesPrimitiveResult(call)).toBe(false);
});

it.each([
  "const data={constructor:Function};",
  "const data={constructor:()=>Function};",
  "const data={other:Function};",
  "const data=[Function];",
  "const data={get constructor(){return Function}};",
  "const data={...opaque};"
])(
  "does not infer unknown property selection from receiver noncallability: %s",
  (text) => {
    const { program, call } = source(
      text + 'const C=data[key];C("Math.max=()=>({})")();Math.max()'
    );
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it.each(["const Math={max:()=>({})};", "const M={max:()=>({})};"])(
  "rejects newly inserted shadow declarations without mutating Binding identity: %s",
  (text) => {
    const { program, call } = source("Math.max()");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(true);
    program.node.body.unshift(
      parseSync(text, { configFile: false, babelrc: false })!.program.body[0]!
    );
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it("preserves existing Binding objects while collecting edited references", () => {
  const { program, call } = source("const M=Math;Math.max()");
  const binding = program.scope.getBinding("M");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  program.node.body.splice(
    1,
    0,
    parseSync("M.max=()=>({})", { configFile: false, babelrc: false })!.program
      .body[0]!
  );
  expect(env.provesPrimitiveResult(call)).toBe(false);
  expect(program.scope.getBinding("M")).toBe(binding);
});
it("does not retain a removed ambient shadow", () => {
  const { program, call } = source("const globalThis={};Math.max()");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  program.node.body.shift();
  program.node.body.unshift(
    parseSync("globalThis.Math.max=()=>({})", {
      configFile: false,
      babelrc: false
    })!.program.body[0]!
  );
  expect(env.provesPrimitiveResult(call)).toBe(false);
});

it.each(["M=other", "({value:M}=other)", "for(M of other){}"])(
  "sees write-only alias targets inserted after observation: %s",
  (edit) => {
    const { program, call } = source("const M=Math;Math.max()");
    const binding = program.scope.getBinding("M");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(true);
    program.node.body.splice(
      1,
      0,
      parseSync(edit, { configFile: false, babelrc: false })!.program.body[0]!
    );
    expect(env.provesPrimitiveResult(call)).toBe(false);
    expect(program.scope.getBinding("M")).toBe(binding);
  }
);
it("does not trust a replaced alias declaration", () => {
  const { program } = source("const M=Math;M.max()");
  let call!: NodePath<t.CallExpression>;
  program.traverse({
    CallExpression(path) {
      call = path;
    }
  });
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
  program.node.body[0] = parseSync("const M={max:()=>({})}", {
    configFile: false,
    babelrc: false
  })!.program.body[0]!;
  expect(env.provesPrimitiveResult(call)).toBe(false);
});
it.each([
  "function fn(value){const local=1;return value+local}",
  "try{throw 1}catch(error){const local=error;void local}",
  "{const local=1;void local}",
  "const fn=(value=1)=>value"
])(
  "does not mistake current lexical bindings for stale declarations: %s",
  (text) => {
    const { program, call } = source(text + ";Math.max(1,2)");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(true);
  }
);

it.each([
  ["export const M=Math;", false],
  ["const M=Math;", true]
] as const)("distinguishes published Math aliases: %s", (code, expected) => {
  let program!: NodePath<t.Program>;
  let call!: NodePath<t.CallExpression>;
  traverse(
    parseSync(code + "M.max(1);Math.max(1)", {
      configFile: false,
      babelrc: false,
      sourceType: "module"
    })!,
    {
      Program(p) {
        program = p;
      },
      CallExpression(p) {
        call = p;
      }
    }
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(expected);
});

it.each([
  'Reflect.get(()=>{},"constructor");',
  'const get=Reflect.get;get(()=>{},"constructor");',
  'const {get}=Reflect;get(()=>{},"constructor");',
  'const R=Reflect;R.get(()=>{},"constructor");',
  "Reflect.get(()=>{},unknown);",
  'window.setTimeout(function(){"use strict";this.Math.max=other},0);',
  'const f=function(){"use strict";this.Math.max=other};f.call(window);'
])(
  "withdraws unknown reflected callable or supplied realm receiver: %s",
  (code) => {
    const { program, call } = source(code + "Math.max(1)");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(false);
  }
);
it.each([
  'Reflect.get({value:1},"value");',
  'const get=Reflect.get;get({value:1},"value");',
  '(()=>{"use strict";})() ;'
])("preserves unrelated reflection and closed calls: %s", (code) => {
  const { program, call } = source(code + "Math.max(1)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(true);
});

it.each([
  "const C=((()=>{}).constructor ??= other);opaque(C);",
  "const C=((()=>{}).constructor ||= other);opaque(C);",
  'function f(){"use strict";this.Math.max=other}opaque(f);',
  'const f=function(){"use strict";this.Math.max=other};f.apply(window,[]);'
])("keeps adjacent receiver/acquisition paths conservative: %s", (code) => {
  const { program, call } = source(code + ";Math.max(1)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});
it.each([
  '(function(){"use strict";this.Math.max=other})();',
  '{const f=function(){"use strict";this.Math.max=other};f();}',
  "globalThis.unrelated;",
  'const Reflect={get(){return 1}};Reflect.get(null,"constructor");'
])(
  "preserves known plain-call or unrelated receiver operations: %s",
  (code) => {
    const { program, call } = source(code + ";Math.max(1)");
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(true);
  }
);

it.each([
  'function f(){"use strict";this.Math.max=other}window.f();',
  'var f=function(){"use strict";this.Math.max=other};globalThis.f();',
  'function f(){"use strict";this.Math.max=other}this.f();'
])("does not hide observed script-global receivers: %s", (code) => {
  const { program, call } = source(code + ";Math.max(1)");
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});

it("does not infer a reflected key position through spread arguments", () => {
  const { program, call } = source(
    'Reflect.get(...argumentsList,"value");Math.max(1)'
  );
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesPrimitiveResult(call)).toBe(false);
});

it.each([
  ["var Math = replacement", "script", false],
  ["var Math;", "script", true],
  ["var Math; Math.max = replacement", "script", false],
  ["function shadow(){var Math = local}", "script", true],
  ["var Math = local", "module", true]
] as const)(
  "distinguishes possible script-global initialization from local shadows: %s",
  (setup, sourceType, expected) => {
    const env = createMathIntrinsicEnvironment();
    const probe = source("Math.max(1,2)");
    env.observe(probe.program);
    expect(env.provesPrimitiveResult(probe.call)).toBe(true);
    env.observe(source(setup, sourceType).program);
    expect(env.provesPrimitiveResult(probe.call)).toBe(expected);
  }
);

it.each([
  ["globalThis.document.defaultView;", false],
  ["document.querySelector('x');", true]
] as const)(
  "keeps DOM acquisition distinct from a realm exposure: %s",
  (setup, expected) => {
    const { program, call } = source(`${setup} Math.max(1,2)`);
    const env = createMathIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesPrimitiveResult(call)).toBe(expected);
  }
);

it.each(["script", "module", "wrapped"] as const)(
  "keeps classic window bindings visible only in possible global scripts: %s",
  (sourceType) => {
    const target = source("Math.max(1,2)");
    const env = createMathIntrinsicEnvironment();
    env.observe(target.program);
    const code = "var window; window.Math.max = local";
    env.observe(
      source(
        sourceType === "wrapped"
          ? `(function(exports,require,module){${code}})()`
          : code,
        sourceType === "module" ? "module" : "script"
      ).program
    );
    expect(env.provesPrimitiveResult(target.call)).toBe(
      sourceType !== "script"
    );
  }
);

it.each([
  [`const {__proto__: parent}=()=>{};`, false],
  [`const {['__'+'proto__']: parent}=()=>{};`, false],
  [`const {name}=()=>{};`, true]
] as const)(
  "observes implicit prototype acquisition without disabling direct Math: %s",
  (code, expected) => {
    const target = source(`${code} Math.max(1,2)`);
    const env = createMathIntrinsicEnvironment();
    env.observe(target.program);
    expect(env.snapshot().bindIntact).toBe(expected);
    expect(env.provesPrimitiveResult(target.call)).toBe(true);
  }
);

it.each([
  ["const Math=local;", "script", false],
  ["let Math=local;", "script", false],
  ["class Math {}", "script", false],
  ["const Math=local;", "module", true],
  ["function scope(){const Math=local;}", "script", true],
  ["{const Math=local;}", "script", true]
] as const)(
  "observes only classic global lexical shadows across programs: %s",
  (code, sourceType, expected) => {
    const target = source("Math.max(1,2)");
    const declaration = source(code, sourceType);
    for (const order of [
      [target.program, declaration.program],
      [declaration.program, target.program]
    ]) {
      const env = createMathIntrinsicEnvironment();
      order.forEach((program) => env.observe(program));
      expect(env.provesPrimitiveResult(target.call)).toBe(expected);
    }
  }
);

it.each([
  ['({ "1": {}, 1: () => {} })["1"][key];', false],
  ['({ 1: () => {}, "1": {} })["1"][key];', true]
] as const)(
  "uses last-write-wins for equivalent literal property keys: %s",
  (code, expected) => {
    const target = source(code + "Math.max(1,2)");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(target.program);
    expect(environment.provesPrimitiveResult(target.call)).toBe(expected);
  }
);

it.each([
  [
    'const proto=Object.getPrototypeOf(()=>0); Object.getOwnPropertyDescriptor(proto,"constructor");',
    false
  ],
  [
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>0),"name");',
    true
  ],
  ['Object.getOwnPropertyDescriptor({constructor:0},"constructor");', true]
] as const)(
  "keeps prototype reflection separate from ordinary descriptors: %s",
  (code, expected) => {
    const target = source(code + "Math.max(1,2)");
    const environment = createMathIntrinsicEnvironment();
    environment.observe(target.program);
    expect(environment.provesPrimitiveResult(target.call)).toBe(expected);
  }
);

it.each([
  [3, true],
  [27, false]
] as const)(
  "bounds repeated visits to shared origins at depth %s",
  (depth, expected) => {
    let code = "const layer0={};";
    for (let level = 1; level <= depth; level++)
      code += `const layer${level}={left:layer${level - 1},right:layer${level - 1}};`;
    const target = source(code + `layer${depth}[key]; Math.max(1,2)`);
    const environment = createMathIntrinsicEnvironment();
    environment.observe(target.program);
    expect(environment.provesPrimitiveResult(target.call)).toBe(expected);
  }
);

it.each([
  ["observe(globalThis.valueOf());", false],
  ["observe(document.defaultView);", false],
  ["observe(globalThis.document.defaultView);", false],
  ["observe(document.body.nodeName);", true],
  ["observe(globalThis.document.body.nodeName);", true],
  ["function read(document){observe(document.defaultView)}", true],
  ["observe(globalThis.innerWidth);", true]
] as const)(
  "tracks realm-returning uses separately from ordinary slots: %s",
  (code, expected) => {
    const target = source(code);
    const environment = createMathIntrinsicEnvironment();
    environment.observe(target.program);
    expect(environment.snapshot().bindIntact).toBe(expected);
  }
);

it.each([
  ["{ function Math() {} }", "script", false],
  ['"use strict"; { function Math() {} }', "script", true],
  ["{ function Math() {} }", "module", true],
  ["function nested() { {function Math() {}} }", "script", true]
] as const)(
  "observes only possible classic realm Math declarations: %s (%s)",
  (code, kind, intact) => {
    const env = createMathIntrinsicEnvironment();
    const target = source("Math.max(1, 2);");
    env.observe(target.program);
    expect(env.provesPrimitiveResult(target.call)).toBe(true);
    env.observe(source(code, kind).program);
    expect(env.provesPrimitiveResult(target.call)).toBe(intact);
  }
);

it.each(["script", "module"] as const)(
  "checks sibling lexical references to prior aliases only for %s",
  (kind) => {
    const alias = source("const M=Math;", kind);
    const sibling = source("const input=M;Math.max(1,2);");
    for (const programs of [
      [alias.program, sibling.program],
      [sibling.program, alias.program]
    ]) {
      const env = createMathIntrinsicEnvironment();
      programs.forEach((program) => env.observe(program));
      expect(env.provesPrimitiveResult(sibling.call)).toBe(kind === "module");
    }
  }
);

it.each([
  ["Math.max(?)", false],
  ["Math.max.bind(Math, ?)(1)", false],
  ["Math.max(...values)", true],
  ["Math.max.bind(Math, 2)(1)", true]
] as const)(
  "requires completed invocation syntax for numeric result proof: %s",
  (code, expected) => {
    let invocation!: NodePath<t.CallExpression>;
    traverse(
      parseSync(code, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["partialApplication"] }
      })!,
      {
        CallExpression(path) {
          if (path.parentPath.isExpressionStatement()) invocation = path;
        }
      }
    );
    const environment = createMathIntrinsicEnvironment();
    expect(environment.provesPrimitiveResult(invocation)).toBe(expected);
  }
);

it.each([
  ["const alias = eval; void alias;", false],
  ["const eval=()=>1; const alias=eval; void alias;", true]
] as const)(
  "uses current ambient callable evidence for bind authority: %s",
  (code, expected) => {
    const environment = createMathIntrinsicEnvironment();
    environment.observe(source(code).program);
    expect(environment.snapshot().bindIntact).toBe(expected);
  }
);

it("observes a sibling lexical alias read through an erased declaration", () => {
  const first = source("const Shared=Math;");
  const second = source(
    "declare const Shared: object; const sample=Shared; Math.max(1,2);"
  );
  const environment = createMathIntrinsicEnvironment();
  environment.observe(first.program);
  environment.observe(second.program);
  expect(environment.provesPrimitiveResult(second.call)).toBe(false);
});

import { runInNewContext } from "node:vm";
import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import {
  createArrayMapIntrinsicEnvironment,
  observePatternRealm
} from "./arrayMapIntrinsic.js";

function source(text: string, sourceType: "script" | "module" = "script") {
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
          t.isIdentifier(path.node.callee.property) &&
          ["map", "includes"].includes(path.node.callee.property.name)
        )
          call = path;
      }
    }
  );
  return { program, call };
}
describe("native identity array map contract", () => {
  it.each([
    "[1,2].map(x=>x)",
    "[,1,,].map(x=>x)",
    "[value].map(function(x){return x})",
    "Array.isArray(value); [1].map(x=>x)",
    "typeof window; [1].map(x=>x)"
  ])("accepts a closed identity map: %s", (text) => {
    const { program, call } = source(text);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(true);
  });
  it.each([
    "Array.prototype.map=other",
    "Array.prototype.constructor=other",
    "Object.defineProperty(Array,Symbol.species,{value:other})",
    "const A=Array; mutate(A)",
    "const p=Array.prototype; mutate(p)",
    "const root=globalThis; mutate(root)",
    "globalThis.Array=other",
    "window[key]=other",
    "globalThis?.Array",
    "eval(code)",
    "Function(code)()",
    "const C=(()=>{}).constructor; C(code)()",
    "Object.prototype[0]=other",
    "Reflect.set(Array.prototype,'map',other)",
    "Object.setPrototypeOf([],other)"
  ])("withdraws native authority on observation: %s", (setup) => {
    const { program, call } = source(setup + "; [1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(false);
  });
  it.each([
    "[1].map(x=>{observe();return x})",
    "[1].map(x=>{throw x})",
    "[1].map(x=>({value:x}))",
    "[1].map(async x=>x)",
    "[...items].map(x=>x)",
    "const arr=[1]; arr.map(x=>x)",
    "Object.assign([1],{map:other}).map(x=>x)"
  ])("does not infer callback or receiver semantics by name: %s", (text) => {
    const { program, call } = source(text);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(false);
  });

  it.each(["[value].includes(4)", "[4].includes(value)"])(
    "proves dense includes without element coercion: %s",
    (text) => {
      const { program, call } = source(text);
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(program);
      expect(env.provesNativeIncludes(call)).toBe(true);
    }
  );
  it.each([
    "[,].includes(value)",
    "[...values].includes(value)",
    "[4].includes(value, fromIndex)",
    "[4].includes(...values)",
    "Array.prototype.includes=other; [4].includes(value)"
  ])("does not infer includes receiver or coercion safety: %s", (text) => {
    const { program, call } = source(text);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeIncludes(call)).toBe(false);
  });
  it("withdraws after a later source and after an AST transform", () => {
    const first = source("[1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(first.program);
    expect(env.provesNativeMap(first.call)).toBe(true);
    const before = env.snapshot().revision;
    env.observe(source("Array.prototype.map=other").program);
    expect(env.provesNativeMap(first.call)).toBe(false);
    expect(env.snapshot().revision).toBeGreaterThan(before);
    const next = createArrayMapIntrinsicEnvironment();
    next.observe(first.program);
    first.program.pushContainer(
      "body",
      t.expressionStatement(
        t.assignmentExpression(
          "=",
          t.memberExpression(t.identifier("Array"), t.identifier("prototype")),
          t.identifier("other")
        )
      )
    );
    expect(next.provesNativeMap(first.call)).toBe(false);
  });
});

describe("global this intrinsic observations", () => {
  it.each([
    "this.Array.prototype.map = other",
    "this.Object.prototype[0] = other",
    "(()=>{this.Array.prototype.map = other})()",
    "function replace(){this.Array.prototype.map = other} replace()",
    "const realm=this; realm.Array.prototype.map=other",
    "class C { [this.Array.prototype.map=other]() {} }"
  ])("withdraws for a possible global receiver: %s", (setup) => {
    const { program, call } = source(setup + "; [1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(false);
  });
});

it.each([
  '"use strict"; this.Array.prototype.map=other',
  "function f(){(()=>{this.Array.prototype.map=other})()} f()",
  "class C { [(()=>{this.Array.prototype.map=other})()](){} }",
  "this[key]=other"
])("withdraws lexical global this authority: %s", (setup) => {
  const { program, call } = source(setup + "; [1].map(x=>x)");
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(false);
});
it.each([
  '{const f=function(){"use strict";this.Array.prototype.map=other}}',
  '"use strict"; {const f=function(){this.Array.prototype.map=other}}',
  '{const f=function(){"use strict";(()=>{this.Array.prototype.map=other})()}}',
  "class C { method(){this.Array.prototype.map=other} }",
  "class C { field=()=>{this.Array.prototype.map=other} }",
  "class C { static {this.Array.prototype.map=other} }",
  "class C { static field=()=>{this.Array.prototype.map=other} }",
  "this.unrelated"
])("preserves distinct or strict this receivers: %s", (setup) => {
  const { program, call } = source(setup + "; [1].map(x=>x)");
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
});

describe("standard pattern realm observations (not call purity)", () => {
  it.each([
    "const assign=Object.assign; assign({}, input)",
    "function install(target){Object.defineProperty(target,key,{value:1})};install(unknown)",
    "function C(){effect()};Object.assign(new C(),{x:1})",
    "function C(){};function install(){opaque(C);Object.defineProperty(C.prototype,'x',{value:1})};install()",
    "function display(x){x=((x=x.constructor)&&(x.displayName||x.name))||'C';return x}",
    "Array(4); new Array(4)",
    "function display(x){return '' + x.constructor.name}",
    "function C(){}; Object.defineProperty(C.prototype,'x',{value:1})",
    "const has=Object.prototype.hasOwnProperty; function owns(value,key){return has.call(value,key)}",
    "const isArray=Array.isArray; isArray(value)",
    "function kind(x){return x.constructor===Symbol}",
    "const unused=async function(){}.constructor",
    "globalThis.__viteFoo=other",
    "const {customElements}=globalThis"
  ])(
    "does not mistake ordinary reflection for observed intrinsic mutation: %s",
    (setup) => {
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(source(setup).program);
      expect(env.snapshot().prototypeAbsenceIntact).toBe(true);
    }
  );
  it.each([
    "const assign=Object.assign; opaque(assign)",
    "function display(x){const expose=()=>x;x=((x=x.constructor)&&(x.displayName||x.name))||'C';return expose()}",
    "function display(x){return x.constructor.name()}",
    "function display(x){return x.constructor('return Array')()}",
    "function display(x){return x.constructor.name = other}",
    "const assign=Object.assign; assign(Array.prototype,{x:1})",
    "const has=Object.prototype.hasOwnProperty; opaque(has)",
    "const has=Object.prototype.hasOwnProperty; has.constructor('return Array')()",
    "Object.assign(Object.getPrototypeOf([]),{[Symbol.iterator]:other})",
    "function f(x){x.constructor.prototype[Symbol.iterator]=other};f([])",
    "const C=[].constructor;opaque(C)",
    "Reflect.defineProperty(Array.prototype,Symbol.iterator,{value:other})",
    "delete Array.prototype[0]",
    "Array.prototype.push(9)",
    "const p=Object.prototype.valueOf();p[0]=9",
    "const root=globalThis;root.Array.prototype[Symbol.iterator]=other"
  ])(
    "withdraws observed protected acquisition, mutation or escape: %s",
    (setup) => {
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(source(setup).program);
      expect(env.snapshot().prototypeAbsenceIntact).toBe(false);
    }
  );
  it.each([
    "const p=Reflect.get([], '__proto__');p[Symbol.iterator]=other",
    "const get=Reflect.get;const p=get([], '__proto__');p[Symbol.iterator]=other",
    "const c='constructor',p='prototype';const target=[][c][p];target[Symbol.iterator]=other",
    "const c=unknown;const target=[][c];opaque(target)"
  ])("does not lose computed/reflected capability recovery: %s", (setup) => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(source(setup).program);
    expect(env.snapshot()).toMatchObject({
      intact: false,
      iterationIntact: false,
      prototypeAbsenceIntact: false
    });
  });
});

describe("pattern operation footprints", () => {
  it("separates observed prototype display-property writes from iteration, without granting map authority", () => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(
      source("Object.defineProperty(Object.prototype,'name',{value:label})")
        .program
    );
    expect(env.snapshot()).toMatchObject({
      intact: false,
      iterationIntact: true,
      prototypeAbsenceIntact: false
    });
  });
  it.each([
    "Object.defineProperty(Object.prototype,'0',{value:other})",
    "Object.defineProperty(Object.prototype,key,{value:other})",
    "Object.defineProperty(Object.prototype,'next',{value:other})",
    "Object.defineProperty(Object.prototype,'name',{get value(){Array.prototype[Symbol.iterator]=other;return 1}})",
    "const define=Object.defineProperty; opaque(define)"
  ])("revokes protected or unobserved effects: %s", (text) => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(source(text).program);
    expect(env.snapshot().iterationIntact).toBe(false);
  });
  it("withdraws operation flags after later source and in-place AST changes", () => {
    const env = createArrayMapIntrinsicEnvironment();
    const clean = source("const value=1").program;
    env.observe(clean);
    expect(env.snapshot().iterationIntact).toBe(true);
    env.observe(
      source("Object.defineProperty(Object.prototype,'name',{value:1})").program
    );
    expect(env.snapshot()).toMatchObject({
      iterationIntact: true,
      prototypeAbsenceIntact: false
    });
    clean.node.body.push(
      ...source("Array.prototype[Symbol.iterator]=other").program.node.body
    );
    expect(env.snapshot().iterationIntact).toBe(false);
  });
});

it("keeps sorted precise prototype keys without allowing unknown namespace effects", () => {
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(
    source(
      "Object.defineProperty(Object.prototype,'name',{value:1});Object.defineProperty(Object.prototype,'displayName',{value:2})"
    ).program
  );
  expect(env.snapshot().prototypeMutationKeys).toEqual(["displayName", "name"]);
  env.observe(
    source("Object.defineProperty(Object.prototype,'color',{value:3})").program
  );
  expect(env.snapshot().prototypeMutationKeys).toEqual([
    "color",
    "displayName",
    "name"
  ]);
  env.observe(
    source("Object.defineProperty(Object.prototype,key,{value:4})").program
  );
  expect(env.snapshot().prototypeMutationKeys).toBeNull();
});

describe("unexecuted empty-own-key observations", () => {
  const context = `const context=(()=>{if(typeof globalThis !== 'undefined') return globalThis; else return Function('return this')()})();`;
  const callback = `key=>{context[key]=defines[key]}`;
  it.each([
    `const defines={};Object.keys(defines).forEach(${callback})`,
    `Object.keys({}).forEach(key=>{context[key]=unknown})`,
    `const defines={};Object.keys(defines).forEach(key=>{defines[key]=1;context[key]=1})`
  ])("ignores only proven zero-invocation callback bodies: %s", (code) => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(source(context + code).program);
    expect(env.snapshot()).toMatchObject({
      intact: false,
      iterationIntact: true,
      prototypeAbsenceIntact: true
    });
  });
  it.each([
    `const defines={Array:other};Object.keys(defines).forEach(${callback})`,
    `const defines={};defines.Array=other;Object.keys(defines).forEach(${callback})`,
    `const defines={};opaque(defines);Object.keys(defines).forEach(${callback})`,
    `const defines={};const alias=defines;Object.keys(defines).forEach(${callback})`,
    `Object.keys(defines).forEach(${callback});const defines={}`,
    `let defines={};Object.keys(defines).forEach(${callback})`,
    `const defines={};const Object=other;Object.keys(defines).forEach(${callback})`,
    `const defines={};Object.keys=other;Object.keys(defines).forEach(${callback})`,
    `const defines={};Array.prototype.forEach=other;Object.keys(defines).forEach(${callback})`,
    `const defines={};Object.keys(defines).forEach(${callback},opaque(context))`,
    `const defines={};Object.keys(defines).forEach(${callback});opaque(context)`,
    `const defines={};delete globalThis.globalThis;Object.keys(defines).forEach(${callback})`,
    `const defines={};globalThis=other;Object.keys(defines).forEach(${callback})`,
    `const defines={};eval(code);Object.keys(defines).forEach(${callback})`
  ])(
    "does not assume native empty iteration or confined namespace uses: %s",
    (code) => {
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(source(context + code).program);
      expect(env.snapshot().iterationIntact).toBe(false);
    }
  );
  it.each([
    ['const Object={keys(){return ["entry"]}}', "script", false],
    ['const Object={keys(){return ["entry"]}}', "module", true],
    ['{ const Object={keys(){return ["entry"]}} }', "script", true]
  ] as const)(
    "accounts for shared classic lexical scope: %s (%s)",
    (declaration, mode, intact) => {
      const side = source(declaration, mode);
      const target = source(
        context + "Object.keys({}).forEach(key=>{context[key]=1})"
      );
      for (const order of [
        [side.program, target.program],
        [target.program, side.program]
      ]) {
        const env = createArrayMapIntrinsicEnvironment();
        for (const program of order) env.observe(program);
        expect(env.snapshot().iterationIntact).toBe(intact);
      }
    }
  );
  it.each([
    ["sloppy Annex B shadow", "", "Object", 1],
    ["strict block-local shadow", '"use strict";', "Object", 0],
    ["unrelated Annex B shadow", "", "Other", 0],
    ["native empty keys", "", undefined, 0]
  ] as const)(
    "tracks callback reachability with %s",
    (_case, directive, binding, visits) => {
      const local = binding
        ? `{ function ${binding}() {} ${binding}.keys = () => ["entry"]; }`
        : "";
      const text = `(function() {
        ${directive}
        ${local}
        Object.keys({}).forEach(() => observe(globalThis));
      })();`;
      // The callback only calls a no-op observer. No intrinsics are modified.
      const observe = vi.fn();
      runInNewContext(text, { observe });
      expect(observe).toHaveBeenCalledTimes(visits);
      expect(observePatternRealm(source(text).program).iteration).toBe(
        visits === 0
      );
    }
  );
  it("withdraws all skipped-body effect assumptions after a later native-method overwrite", () => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(
      source(
        context + `const defines={};Object.keys(defines).forEach(${callback})`
      ).program
    );
    expect(env.snapshot().iterationIntact).toBe(true);
    env.observe(source("Array.prototype.forEach=other").program);
    expect(env.snapshot()).toMatchObject({
      iterationIntact: false,
      prototypeMutationKeys: null
    });
  });
  it.each([`const globalThis=other;`, `const alias=globalThis;opaque(alias);`])(
    "does not turn shadowed or escaped globalThis into a branch receipt: %s",
    (prefix) => {
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(
        source(
          prefix +
            context +
            `const defines={};Object.keys(defines).forEach(${callback})`
        ).program
      );
      expect(env.snapshot().iterationIntact).toBe(false);
    }
  );
});

it("withdraws both array contracts for an inherited namespace-returning call", () => {
  const { program, call } = source(
    "Object.valueOf().prototype[0]=9;[,].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(false);
  expect(env.snapshot().iterationIntact).toBe(false);
  expect(env.snapshot().prototypeAbsenceIntact).toBe(false);
});

it("shares the pattern observation within validation and rescans after AST changes", () => {
  const { program } = source("[1].map(x=>x)");
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  const scan = vi.spyOn(program, "traverse");
  const count = () =>
    scan.mock.calls.filter(
      ([visitor]) => !!visitor.enter && !!visitor.ThisExpression
    ).length;
  try {
    expect(env.snapshot().iterationIntact).toBe(true);
    expect(count()).toBe(1);
    program.node.body.push(
      ...source("Array.prototype[Symbol.iterator]=opaque;").program.node.body
    );
    expect(env.snapshot().iterationIntact).toBe(false);
    expect(count()).toBe(2);
  } finally {
    scan.mockRestore();
  }
});

it("stops scanning later programs once all pattern authority is irreversibly revoked", () => {
  const first = source("Array.prototype[Symbol.iterator]=opaque;"),
    later = source("[1].map(x=>x)");
  const single = createArrayMapIntrinsicEnvironment();
  single.observe(first.program);
  const expected = single.snapshot();
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(first.program);
  env.observe(later.program);
  const scan = vi.spyOn(later.program, "traverse");
  try {
    const snapshot = env.snapshot();
    expect(snapshot).toEqual({ ...expected, revision: expected.revision + 1 });
    expect(scan).not.toHaveBeenCalled();
    expect(env.snapshot()).toEqual(snapshot);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
});

it.each([
  "const {constructor:A}=[];",
  "let A;({constructor:A}=[]);",
  "const {nested:{constructor:A}}={nested:[]};",
  'const {["con"+"structor"]:A}=[];',
  'const key="constructor";const {[key]:A}=[];',
  "const {constructor:A,...rest}=[];"
])("observes destructured protected constructor capture: %s", (declaration) => {
  const { program, call } = source(
    declaration +
      "A.prototype.map=opaque;A.prototype[Symbol.iterator]=opaque;[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(false);
  expect(env.snapshot().iterationIntact).toBe(false);
});
it.each([
  "const {[Symbol.iterator]:iterate}=[];",
  "let iterate;({[Symbol.iterator]:iterate}=[]);"
])("observes destructured iterator acquisition: %s", (text) => {
  const { program } = source(text);
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().iterationIntact).toBe(false);
});
it("preserves unrelated own data destructuring and empty rest", () => {
  const { program, call } = source(
    "const {label,...rest}={label:1,other:2};const {...copy}=[];[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
  expect(env.snapshot().iterationIntact).toBe(true);
});

it.each([
  "function use({constructor:A}){A.prototype.map=opaque}use([]);",
  "try{throw []}catch({constructor:A}){A.prototype[Symbol.iterator]=opaque}",
  "for(const {constructor:A} of [[]]){A.prototype.map=opaque}",
  "for(const {constructor:A} in object){capture(A)}",
  "function use({nested:{[key]:A}}){capture(A)}"
])(
  "observes protected patterns at parameters, catch and loop targets: %s",
  (text) => {
    const { program, call } = source(text + ";[1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(false);
    expect(env.snapshot().iterationIntact).toBe(false);
  }
);
it("preserves unrelated parameter and loop data reads", () => {
  const { program, call } = source(
    "function use({label}){return label}for(const {label} of data){use({label})};[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
});

it("does not confuse numeric computed keys with protected acquisition", () => {
  const { program, call } = source(
    "const {[spacing * 2]:size}={8:8};[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
  expect(env.snapshot().iterationIntact).toBe(true);
  expect(env.snapshot().prototypeAbsenceIntact).toBe(true);
});
it("still observes effects inside numeric computed keys", () => {
  const { program } = source(
    "const {[(Array.prototype[Symbol.iterator]=opaque, spacing)*2]:size}={8:8};"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().iterationIntact).toBe(false);
});

it("resolves an exact string-literal concatenation pattern key", () => {
  const { program, call } = source(
    "const {['val'+'ue']:size}={value:4};[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
});

it("does not resolve a key before its initializer executes", () => {
  const { program } = source('[1][key](x=>x);var key="map"');
  let call!: NodePath<t.CallExpression>;
  program.traverse({
    CallExpression(path) {
      call = path;
    }
  });
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(false);
});
it.each([
  'const a=[];let key="constructor";const A=a[key];A.prototype.map=opaque;',
  'const a=[];let key="constructor";const A=a[key];A.prototype[Symbol.iterator]=opaque;',
  "declare const globalThis:any;globalThis.Array.prototype[Symbol.iterator]=opaque;"
])("observes protected acquisition and ambient runtime writes: %s", (text) => {
  const { program } = source(text);
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().iterationIntact).toBe(false);
});
it("revalidates empty callbacks after raw AST insertion", () => {
  const { program } = source(
    "const record={};Object.keys(record).forEach(()=>{Array.prototype[Symbol.iterator]=other})"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().iterationIntact).toBe(true);
  program.node.body.splice(
    1,
    0,
    parseSync("record.x=1", { configFile: false, babelrc: false })!.program
      .body[0]!
  );
  expect(env.snapshot().iterationIntact).toBe(false);
});

it("keeps initialized same-scope keys and unrelated literal aliases supported", () => {
  const { program, call } = source(
    'const key="map";const a=[];a.label;[1][key](x=>x)'
  );
  let computedCall = call;
  program.traverse({
    CallExpression(path) {
      if (t.isMemberExpression(path.node.callee) && path.node.callee.computed)
        computedCall = path;
    }
  });
  expect(computedCall.node.callee).toMatchObject({
    computed: true,
    property: { name: "key" }
  });
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(computedCall)).toBe(true);
});
it("does not report a future initializer as a precise prototype mutation key", () => {
  const { program } = source('Object.prototype[key]=9;var key="label"');
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().prototypeMutationKeys).toBe(null);
});
it("honors emitted local realm shadows", () => {
  const { program, call } = source(
    "const globalThis={Array:{prototype:{}}};globalThis.Array.prototype.map=opaque;[1].map(x=>x)"
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(true);
});

it("reports newly inserted global eval from current AST without rebuilding scopes", () => {
  const { program } = source("const record={};");
  const binding = program.scope.getBinding("record");
  expect(observePatternRealm(program).hasGlobalEval).toBe(false);
  program.node.body.push(
    parseSync('(0,eval)("opaque()")', { configFile: false, babelrc: false })!
      .program.body[0]!
  );
  expect(observePatternRealm(program).hasGlobalEval).toBe(true);
  expect(program.scope.getBinding("record")).toBe(binding);
});

it("follows literal aliases when reassignment makes the selection key unresolved", () => {
  const { program } = source(
    'const a=[];let key;key="constructor";const A=a[key];A.prototype[Symbol.iterator]=opaque'
  );
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().iterationIntact).toBe(false);
});

it.each([
  "const p=[].__lookupGetter__('__proto__').call([]); p.map=()=>[];",
  "const p=[].__lookupGetter__('__proto__').call([]); p[Symbol.iterator]=function*(){yield 9};",
  "const {__lookupGetter__:lookup}=[]; const p=lookup.call([], '__proto__').call([]); p.map=()=>[];"
])("withdraws protected legacy getter acquisition: %s", (code) => {
  const { program, call } = source(code + "[1].map(x=>x)");
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(program);
  expect(env.provesNativeMap(call)).toBe(false);
  expect(env.snapshot().iterationIntact).toBe(false);
});

it.each([
  "export const record={};",
  "const record={};export {record};",
  "const record={};export default record;"
])(
  "does not treat exported records as closed empty records: %s",
  (declaration) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(
        `${declaration}patch();Object.keys(record).forEach(()=>{Array.prototype[Symbol.iterator]=other});`,
        { configFile: false, babelrc: false, sourceType: "module" }
      )!,
      {
        Program(path) {
          program = path;
        }
      }
    );
    expect(observePatternRealm(program).iteration).toBe(false);
  }
);
it.each([
  "export const A=[].constructor;",
  "const A=[].constructor;export {A};",
  "const A=[].constructor;export default A;"
])(
  "does not treat exported constructor captures as unused: %s",
  (declaration) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(declaration, {
        configFile: false,
        babelrc: false,
        sourceType: "module"
      })!,
      {
        Program(path) {
          program = path;
        }
      }
    );
    expect(observePatternRealm(program).iteration).toBe(false);
  }
);

it.each([
  "const record={};Object.keys(record).forEach(()=>{Array.prototype[Symbol.iterator]=other});",
  "const unused=[].constructor;"
])("preserves confined local observation exemptions: %s", (code) => {
  expect(observePatternRealm(source(code).program).iteration).toBe(true);
});

it.each([
  "globalThis.valueOf().Array.prototype[Symbol.iterator]=other;",
  "const root=globalThis.valueOf();root.Array.prototype.map=other;",
  "const A=([].constructor ??= fallback);A.prototype[Symbol.iterator]=other;",
  "const A=([].constructor ||= fallback);A.prototype[Symbol.iterator]=other;",
  "Iterator.prototype.return=other;",
  "const I=Iterator;I.prototype.return=other;",
  'window.setTimeout(function(){"use strict";this.Array.prototype[Symbol.iterator]=other},0);'
])(
  "withdraws protected realm acquisition/iterator-close authority: %s",
  (code) => {
    const { program, call } = source(code + "[1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.snapshot().iterationIntact).toBe(false);
    expect(env.provesNativeMap(call)).toBe(false);
  }
);

it.each([
  "globalThis.unrelated;",
  "const Iterator={prototype:{}};Iterator.prototype.return=other;",
  "const object={};object.constructor=other;"
])("preserves unrelated pattern realm operations: %s", (code) => {
  expect(observePatternRealm(source(code).program).iteration).toBe(true);
});

describe("exact host pattern observation boundary", () => {
  it("does not confer native map authority or erase other modules", () => {
    const host = source("consume(globalThis); [1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment({
      validatesPatternIntrinsicEffects: (program) => program === host.program
    });
    env.observe(host.program);
    expect(env.snapshot()).toMatchObject({
      intact: false,
      iterationIntact: true,
      prototypeAbsenceIntact: true
    });
    expect(env.provesNativeMap(host.call)).toBe(false);
    env.observe(source("Array.prototype[Symbol.iterator]=other").program);
    expect(env.snapshot().iterationIntact).toBe(false);
  });
  it("revalidates source and generation without restoring a withdrawn observation", () => {
    const host = source("consume(globalThis)");
    const original = JSON.stringify(host.program.node);
    let current = true;
    const env = createArrayMapIntrinsicEnvironment({
      validatesPatternIntrinsicEffects: (program) =>
        current &&
        program === host.program &&
        JSON.stringify(program.node) === original
    });
    env.observe(host.program);
    expect(env.snapshot().iterationIntact).toBe(true);
    current = false;
    expect(env.snapshot().iterationIntact).toBe(false);
    current = true;
    expect(env.snapshot().iterationIntact).toBe(false);
    const edited = createArrayMapIntrinsicEnvironment({
      validatesPatternIntrinsicEffects: (program) =>
        JSON.stringify(program.node) === original
    });
    edited.observe(host.program);
    expect(edited.snapshot().iterationIntact).toBe(true);
    host.program.node.body.push(
      t.expressionStatement(
        t.callExpression(t.identifier("opaque"), [t.identifier("globalThis")])
      )
    );
    expect(edited.snapshot().iterationIntact).toBe(false);
  });
});

describe("native prototype dispatch prerequisites", () => {
  it.each([
    "hasOwnProperty",
    "propertyIsEnumerable",
    "isPrototypeOf",
    "toString",
    "toLocaleString"
  ])("retains native %s calls but withdraws on observed replacement", (key) => {
    const clean = createArrayMapIntrinsicEnvironment();
    clean.observe(source(`Object.prototype.${key}();`).program);
    expect(clean.snapshot().prototypeAbsenceIntact).toBe(true);
    const changed = createArrayMapIntrinsicEnvironment();
    changed.observe(source(`Object.prototype.${key}=function(){};`).program);
    expect(changed.snapshot()).toMatchObject({
      iterationIntact: false,
      prototypeMutationKeys: null
    });
  });
  it("preserves unrelated precise keys and propagates late dispatch revocation between modules", () => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(
      source(
        "Object.prototype.displayName='display';Object.prototype.toLocaleString();"
      ).program
    );
    expect(env.snapshot()).toMatchObject({
      iterationIntact: true,
      prototypeMutationKeys: ["displayName"]
    });
    env.observe(
      source(
        "Object.defineProperty(Object.prototype,'toString',{value:function(){}});"
      ).program
    );
    expect(env.snapshot()).toMatchObject({
      iterationIntact: false,
      prototypeMutationKeys: null
    });
    env.observe(source("const unrelated=1").program);
    expect(env.snapshot()).toMatchObject({
      iterationIntact: false,
      prototypeMutationKeys: null
    });
  });
});

it.each([
  ["var Captured=[].constructor; globalThis.Captured;", false],
  ["const Captured=[].constructor;", true],
  ["globalThis.document.defaultView;", false],
  ["const doc=document; doc['default'+'View'];", false],
  ["const {defaultView}=document;", false],
  ["document[unknown];", false],
  ["document.querySelector('x');", true],
  ["function shadow(document){return document.defaultView}", true],
  ["function f(eval){(eval<string>)('1')}", false],
  ["function f(eval){eval('1')}", false],
  ["function f(other){(other<string>)('1')}", true]
] as const)(
  "withdraws pattern evidence only on possible emitted acquisition or execution: %s",
  (setup, expected) => {
    const env = createArrayMapIntrinsicEnvironment();
    const target = source(`${setup}; [1].map(x=>x)`);
    env.observe(target.program);
    expect(env.snapshot().iterationIntact).toBe(expected);
    if (setup.startsWith("globalThis.document"))
      expect(env.provesNativeMap(target.call)).toBe(false);
  }
);

it.each(["script", "module", "wrapped"] as const)(
  "separates Array declarations from true local shadows in %s",
  (sourceType) => {
    const target = source("[1].map(x=>x)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(target.program);
    const code = "var Array; Array.prototype[Symbol.iterator]=local";
    env.observe(
      source(
        sourceType === "wrapped"
          ? `(function(exports,require,module){${code}})()`
          : code,
        sourceType === "module" ? "module" : "script"
      ).program
    );
    expect(env.snapshot().iterationIntact).toBe(sourceType !== "script");
    expect(env.provesNativeMap(target.call)).toBe(sourceType !== "script");
  }
);

it.each([
  ["function observe(a,k){const entry=a[k]; entry.prototype;}", false],
  ["function observe(a,k){const entry=a[k]; entry.label;}", true],
  ["function observe(a,k){a[k];}", true],
  ["document.documentElement.ownerDocument.defaultView;", false],
  [
    "const node=document.documentElement; const doc=node.ownerDocument; doc.defaultView;",
    false
  ],
  ["document.querySelector('x');", true],
  ["document.querySelector('x')?.nonce;", true]
] as const)(
  "limits chained observation to protected slot demand: %s",
  (setup, expected) => {
    const target = source(`${setup} [1].map(x=>x)`);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(target.program);
    expect(env.snapshot().iterationIntact).toBe(expected);
    expect(env.provesNativeMap(target.call)).toBe(expected);
  }
);

it.each([
  ["{value:label,enumerable:false}", true],
  ["{get(){return label}}", false],
  ["{set(value){observe(value)}}", false],
  ["{get value(){return label}}", false],
  ["{...descriptor}", false],
  ["descriptor", false]
] as const)(
  "requires own data descriptor evidence: %s",
  (descriptor, expected) => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(
      source(
        `Object.defineProperty(Object.prototype,'displayName',${descriptor});`
      ).program
    );
    expect(env.snapshot()).toMatchObject({
      iterationIntact: expected,
      prototypeMutationKeys: expected ? ["displayName"] : null
    });
  }
);
it("withdraws descriptor precision when inherited descriptor slot reads can change", () => {
  const env = createArrayMapIntrinsicEnvironment();
  env.observe(
    source(`Object.defineProperty(Object.prototype,'name',{value:label});`)
      .program
  );
  expect(env.snapshot().prototypeMutationKeys).toEqual(["name"]);
  env.observe(source(`Object.prototype.enumerable=true;`).program);
  expect(env.snapshot().prototypeMutationKeys).toBeNull();
});
it.each([
  [
    `const {ownerDocument: doc}=document.documentElement; doc.defaultView;`,
    false
  ],
  [
    `const {['owner'+'Document']: doc}=document.documentElement; doc.defaultView;`,
    false
  ],
  [`const {ownerDocument: doc}=document.documentElement;`, true],
  [`const {ownerDocument: doc}=document.documentElement; doc.title;`, true],
  [`const {ownerDocument: doc}=document.documentElement; observe(doc);`, false],
  [`const {nodeName}=document.documentElement; observe(nodeName);`, true]
] as const)(
  "follows observable DOM pattern capabilities: %s",
  (code, expected) => {
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(source(code).program);
    expect(env.snapshot().iterationIntact).toBe(expected);
  }
);

it("does not use old locations to certify a moved computed method call", () => {
  const { program, call } = source('const map="map"; [1][map](x=>x);');
  const environment = createArrayMapIntrinsicEnvironment();
  expect(environment.provesNativeMap(call)).toBe(true);
  const [declaration, use] = program.node.body;
  program.node.body.splice(0, 2, use, declaration);
  expect(environment.provesNativeMap(call)).toBe(false);
});

describe("classic shared pattern realm observations", () => {
  it.each([
    [
      "const record={}; fill(); Object.keys(record).forEach(key=>{globalThis[key]=key});",
      "script",
      false
    ],
    [
      "function isolated(){const record={}; fill(); Object.keys(record).forEach(key=>{globalThis[key]=key});}",
      "script",
      true
    ],
    [
      "const record={}; fill(); Object.keys(record).forEach(key=>{globalThis[key]=key});",
      "module",
      true
    ]
  ] as const)(
    "uses the exact shared extent of an empty record: %s (%s)",
    (code, type, intact) => {
      const side = source("function fill(){record.count=1}");
      const target = source(code, type);
      for (const order of [
        [side.program, target.program],
        [target.program, side.program]
      ]) {
        const env = createArrayMapIntrinsicEnvironment();
        order.forEach((program) => env.observe(program));
        expect(env.snapshot().iterationIntact).toBe(intact);
      }
    }
  );

  it.each([
    ["Object", "script", null],
    ["Reflect", "script", null],
    ["Object", "module", ["label"]],
    ["Reflect", "module", ["label"]]
  ] as const)(
    "tracks only native descriptor dispatch for %s (%s)",
    (api, type, expected) => {
      const target = source(
        api + '.defineProperty(Array.prototype,"label",{value:1});'
      );
      const side = source("const " + api + "={defineProperty(){}}", type);
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(target.program);
      expect(env.snapshot().prototypeMutationKeys).toEqual(["label"]);
      env.observe(side.program);
      expect(env.snapshot().prototypeMutationKeys).toEqual(expected);
    }
  );

  it.each([
    "globalThis",
    "(() => { if (typeof globalThis !== 'undefined') return globalThis; })()"
  ])("checks shared use only after recognizing a realm capture: %s", (init) => {
    const target = source("const context=" + init + ";");
    const unrelated = source("function local(context){consume(context)}");
    const side = source("consume(context)");
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(target.program);
    env.observe(unrelated.program);
    expect(env.snapshot().iterationIntact).toBe(true);
    env.observe(side.program);
    expect(env.snapshot().iterationIntact).toBe(false);
  });

  it.each([
    ["script", false],
    ["module", true]
  ] as const)(
    "checks cross-program references to a %s capture",
    (type, intact) => {
      const target = source("const captured=[].constructor;", type);
      const unrelated = source("observe(other)");
      const side = source("observe(captured)");
      const env = createArrayMapIntrinsicEnvironment();
      env.observe(target.program);
      env.observe(unrelated.program);
      expect(env.snapshot().iterationIntact).toBe(true);
      env.observe(side.program);
      expect(env.snapshot().iterationIntact).toBe(intact);
    }
  );
});

it.each([
  ["declare const", false],
  ["const", true]
] as const)(
  "requires an emitted computed-method key: %s",
  (declaration, expected) => {
    const { program } = source(
      `${declaration} key="map";[1][key](value=>value)`
    );
    let call!: NodePath<t.CallExpression>;
    program.traverse({
      CallExpression(path) {
        call = path;
      }
    });
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(expected);
  }
);

it.each([
  ["let value; ({Array:value}=data);", true],
  ["({value:Array}=data);", false],
  ["({Array}=data);", false],
  ["let value; ({[Array]:value}=data);", false]
] as const)(
  "distinguishes destructuring labels, writes and evaluated keys: %s",
  (code, expected) => {
    const { program, call } = source(`${code}[1].map(value=>value)`);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.provesNativeMap(call)).toBe(expected);
    expect(env.snapshot().iterationIntact).toBe(expected);
  }
);

it.each([
  ["[1].includes(?)", false],
  ["[1].includes(1)", true]
] as const)(
  "distinguishes partial application from evaluation: %s",
  (code, expected) => {
    let call!: NodePath<t.CallExpression>;
    traverse(
      parseSync(code, {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["partialApplication"] }
      })!,
      {
        CallExpression(path) {
          call = path;
        }
      }
    );
    const environment = createArrayMapIntrinsicEnvironment();
    expect(environment.provesNativeIncludes(call)).toBe(expected);
  }
);

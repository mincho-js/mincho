import {
  isPossibleGlobalThis,
  collectRuntimeSourceEvidence,
  hasRuntimeBinding,
  isRuntimeSourceReference
} from "./runtimeSourceReference.js";
import { parseSync, traverse, type NodePath, types as t } from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import { createMathIntrinsicEnvironment } from "./mathIntrinsic.js";
import { createArrayMapIntrinsicEnvironment } from "./arrayMapIntrinsic.js";

function environments(source: string) {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync(source, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript"] }
    })!,
    {
      Program(path) {
        program = path;
        path.stop();
      }
    }
  );
  const math = createMathIntrinsicEnvironment();
  const array = createArrayMapIntrinsicEnvironment();
  math.observe(program);
  array.observe(program);
  return { math: math.snapshot(), array: array.snapshot() };
}

it.each([
  [
    "a classic top-level block",
    "{ function fixtureHelper() {} }",
    "script",
    true
  ],
  [
    "a classic switch",
    "switch (1) { case 1: function fixtureHelper() {} }",
    "script",
    true
  ],
  [
    "a strict script",
    '"use strict"; { function fixtureHelper() {} }',
    "script",
    false
  ],
  ["a module", "{ function fixtureHelper() {} }", "module", false],
  [
    "a function-owned block",
    "function wrap() { { function fixtureHelper() {} } }",
    "script",
    false
  ],
  [
    "an intervening lexical declaration",
    "{ let fixtureHelper; { function fixtureHelper() {} } }",
    "script",
    false
  ],
  [
    "an existing program lexical declaration",
    "let fixtureHelper; { function fixtureHelper() {} }",
    "script",
    false
  ]
] as const)(
  "reports a possible shared script global write for %s",
  (_case, source, sourceType, writesProgram) => {
    const ast = parseSync(source, {
      configFile: false,
      babelrc: false,
      sourceType
    })!;
    traverse(ast, {
      Program(path) {
        const evidence = collectRuntimeSourceEvidence(path);
        expect(evidence.writesScriptGlobal("fixtureHelper")).toBe(
          writesProgram
        );
        expect(evidence.writesScriptGlobal("unrelated")).toBe(false);
      }
    });
  }
);

describe("runtime intrinsic references exclude erased TypeScript", () => {
  it.each([
    "const fn: Function = () => 1;",
    "const values: Array<number> = [];",
    "type F = typeof globalThis.Function;",
    "interface Methods extends Function { value: Array<number> }",
    "class Box implements Array<number> {}",
    "declare const fn: typeof globalThis.Function;",
    "declare namespace Globals { const factory: typeof Function; }",
    "const fn = (()=>1) as Function;",
    "const fn = (()=>1) satisfies Function;",
    "const x = identity<Function>;",
    'import type {Function} from "types";'
  ])("preserves native authority for erased references: %s", (source) => {
    const result = environments(source + "Math.max(1,2);[1].map(x=>x);");
    expect(result.math.intact).toBe(true);
    expect(result.math.bindIntact).toBe(true);
    expect(result.array.intact).toBe(true);
  });
  it.each([
    "const value = (Function('return 1') as Function);",
    "const value = Function('return 1') satisfies Function;",
    "const value = Function<string>('return 1');",
    "namespace Globals { const fn=Function('return 1'); }",
    "enum Value { Dynamic=Function('return 1')() }",
    "class Box extends Function {}"
  ])("still observes executable expressions next to types: %s", (source) => {
    const result = environments(source);
    expect(result.math.intact).toBe(false);
    expect(result.array.intact).toBe(false);
  });
});

it.each([
  ["module", "this.Math", false],
  ["module", "(()=>this.Math)()", false],
  ["module", "function f(){return this.Math}", false],
  ["script", '"use strict"; this.Math', true],
  ["script", '{const f=function(){"use strict"; return ()=>this.Math}}', false],
  ["script", "class C { field=this.Math }", false],
  ["script", "class C { static field=this.Math }", false],
  ["script", "class C { [this.Math](){} }", true],
  ["script", "class C { [this.Math]=1 }", true]
] as const)(
  "classifies %s lexical receiver in %s",
  (sourceType, code, expected) => {
    const ast = parseSync(code, {
      configFile: false,
      babelrc: false,
      sourceType
    })!;
    let actual: boolean | undefined;
    traverse(ast, {
      ThisExpression(path) {
        actual = isPossibleGlobalThis(path);
      }
    });
    expect(actual).toBe(expected);
  }
);
it.each([
  ["class C{@dec(this.Math) m(){}}", true],
  ["class C{m(@dec(this.Math) p){}}", true],
  ["@dec(this.Math) class C{}", true],
  ["function outer(){class C{@dec(this.Math) m(){}}}", true],
  [
    '{const outer=function(){"use strict";class C{@dec(this.Math) m(){}}}}',
    false
  ],
  ["class C{@dec((()=>this.Math)()) m(){}}", true],
  ["class C{@dec((function(){return this.Math})()) m(){}}", true]
] as const)("uses enclosing receiver for decorators: %s", (code, expected) => {
  const ast = parseSync(code, {
    configFile: false,
    babelrc: false,
    sourceType: "script",
    parserOpts: { plugins: ["typescript", "decorators-legacy"] }
  })!;
  let actual: boolean | undefined;
  traverse(ast, {
    ThisExpression(path) {
      actual = isPossibleGlobalThis(path);
    }
  });
  expect(actual).toBe(expected);
});

it.each([
  "@dec(this.Math.max=other) m(){}",
  "m(@dec(this.Math.max=other) p){}"
])("observes Math writes in decorator definition contexts: %s", (member) => {
  const ast = parseSync(`class C{${member}};Math.max()`, {
    configFile: false,
    babelrc: false,
    sourceType: "script",
    parserOpts: { plugins: ["typescript", "decorators-legacy"] }
  })!;
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
    }
  });
  const env = createMathIntrinsicEnvironment();
  env.observe(program);
  expect(env.snapshot().intact).toBe(false);
});

describe("current writes versus cached constant binding authority", () => {
  const programOf = (text: string) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(text, {
        configFile: false,
        babelrc: false,
        sourceType: "module",
        parserOpts: {
          plugins: ["typescript"],
          createParenthesizedExpressions: true
        }
      })!,
      {
        Program(path) {
          program = path;
        }
      }
    );
    return program;
  };
  it.each([
    "key=other",
    "({value:key}=other)",
    "[key]=other",
    "[(key)]=other",
    "({value:(key as any)}=other)",
    "[{value:(key satisfies number)}]=other",
    "[...(key as any)]=other",
    "key++",
    "for(key of other){}",
    "for(key in other){}",
    "(key as any)=other",
    "(key)=other",
    "(key satisfies number)=other",
    "(()=>{key=other})()"
  ])("withdraws on a newly inserted binding write: %s", (text) => {
    const program = programOf("let key=0;key;");
    const binding = program.scope.getBinding("key");
    expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
    program.node.body.splice(1, 0, programOf(text).node.body[0]!);
    expect(binding!.constant).toBe(true);
    const current = collectRuntimeSourceEvidence(program);
    // Babel may refresh the existing constant flag while creating a new loop scope.
    expect(current.bindingsCurrent && binding!.constant).toBe(false);
    expect(program.scope.getBinding("key")).toBe(binding);
  });
  it.each([
    "key;",
    "void key;",
    "object[key];",
    "object.key=1",
    "[(object.key as any)]=other",
    "({value:(object.key)}=other)",
    "for(const local of other){void local}"
  ])(
    "does not confuse reads/member writes/new separately crawled declarations with binding writes: %s",
    (text) => {
      const program = programOf("let key=0;const object={};" + text);
      expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
    }
  );
  it("keeps known nonconstant bindings current", () => {
    const program = programOf("let key=0;key=1;key;");
    expect(program.scope.getBinding("key")!.constant).toBe(false);
    expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
  });

  it.each(["var count; var count;", "var count = 1, count = 2;"])(
    "keeps a redeclaration known to Babel current: %s",
    (source) => {
      const program = programOf(source);
      const binding = program.scope.getBinding("count");
      expect(binding?.kind).toBe("var");
      expect(binding?.constant).toBe(false);
      expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
      const statement = programOf("var count = 3;").node.body[0]!;
      program.node.body.push(statement);
      expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(false);
      expect(program.scope.getBinding("count")).toBe(binding);
    }
  );
});

it("withdraws cached declaration kind after an in-place const to let edit", () => {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync("const key=0;key", { configFile: false, babelrc: false })!,
    {
      Program(path) {
        program = path;
      }
    }
  );
  const binding = program.scope.getBinding("key");
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
  (program.node.body[0] as t.VariableDeclaration).kind = "let";
  expect(binding!.kind).toBe("const");
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(false);
  expect(program.scope.getBinding("key")).toBe(binding);
});

it.each([
  "export function getStyles(size){return {padding:size}}",
  "export default function getStyles(size){return {padding:size}}",
  "export default function(size){return {padding:size}}",
  "export const getStyles=(size)=>({padding:size})",
  "export const size=4;"
])(
  "checks exported function bindings in their declaration scope: %s",
  (source) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(source, {
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
    expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
    expect(
      createArrayMapIntrinsicEnvironment().snapshot().iterationIntact
    ).toBe(true);
    const env = createArrayMapIntrinsicEnvironment();
    env.observe(program);
    expect(env.snapshot().iterationIntact).toBe(true);
  }
);

it("still rejects a raw replaced exported declaration", () => {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync("export function getStyles(size){return size}", {
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
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
  const replacement = parseSync("function getStyles(other){return other}", {
    configFile: false,
    babelrc: false
  })!.program.body[0] as t.FunctionDeclaration;
  (program.node.body[0] as t.ExportNamedDeclaration).declaration = replacement;
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(false);
});

it.each([
  ['import typeof { Math } from "types";', false],
  ['import { typeof Math } from "types";', false],
  ['import { Math } from "values";', true]
] as const)("classifies Flow import emission: %s", (code, expected) => {
  let actual: boolean | undefined;
  traverse(
    parseSync(code, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["flow"] }
    })!,
    {
      ImportSpecifier(path) {
        actual = isRuntimeSourceReference(path);
      }
    }
  );
  expect(actual).toBe(expected);
});

it.each([
  ["declare var count: number;", "DeclareVariable", false],
  ["declare function read(): string;", "DeclareFunction", false],
  ["type Name = string;", "TypeAlias", false],
  ["enum Count { One, Two }", "EnumDeclaration", true],
  ["(value: number);", "TypeCastExpression", true]
] as const)(
  "classifies the Flow declaration or expression itself: %s",
  (text, kind, runtime) => {
    const ast = parseSync(text, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["flow"] }
    })!;
    let actual: boolean | undefined;
    traverse(ast, {
      enter(path) {
        if (path.node.type === kind) actual = isRuntimeSourceReference(path);
      }
    });
    expect(actual).toBe(runtime);
  }
);

it("validates an exact path slot before reading all sibling identities", () => {
  const code = "const Math = local;" + " Math.max(1);".repeat(128);
  const ast = parseSync(code, { configFile: false, babelrc: false })!;
  const uses: NodePath<t.Identifier>[] = [];
  traverse(ast, {
    ReferencedIdentifier(path) {
      if (path.isIdentifier({ name: "Math" })) uses.push(path);
    }
  });
  expect(uses).toHaveLength(128);
  const body = ast.program.body;
  const iterate = vi.fn(() => body[Symbol.iterator]());
  ast.program.body = new Proxy(body, {
    get(target, key, receiver) {
      return key === Symbol.iterator
        ? iterate
        : Reflect.get(target, key, receiver);
    }
  });
  expect(uses.every((path) => hasRuntimeBinding(path, "Math"))).toBe(true);
  expect(iterate).not.toHaveBeenCalled();
  const declaration = body.shift()!;
  body.push(declaration); // The stale path slot needs the full identity fallback.
  expect(hasRuntimeBinding(uses[0], "Math")).toBe(true);
  expect(iterate).toHaveBeenCalledOnce();
  body.pop();
  expect(hasRuntimeBinding(uses[0], "Math")).toBe(false);
});

it.each([
  ["", true],
  ['"use strict";', false]
] as const)(
  "keeps computed-key strictness in its enclosing context: %s",
  (prefix, expected) => {
    const ast = parseSync(
      `${prefix}({[(function(){return this.Math})()](){"use strict";}})`,
      { configFile: false, babelrc: false, sourceType: "script" }
    )!;
    traverse(ast, {
      ThisExpression(path) {
        expect(isPossibleGlobalThis(path)).toBe(expected);
      }
    });
  }
);
it("withdraws cached references to a detached inner declaration", () => {
  const ast = parseSync("const key={};function f(){const key=1;return key}", {
    configFile: false,
    babelrc: false
  })!;
  let program!: NodePath<t.Program>;
  traverse(ast, {
    Program(path) {
      program = path;
    }
  });
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
  const fn = program.node.body[1] as t.FunctionDeclaration;
  const declaration = fn.body.body.shift()!;
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(false);
  fn.body.body.unshift(declaration);
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
});

it.each([
  ["script", "const eval=()=>{};", false],
  ["script", "let eval=()=>{};", true],
  ["script", "function eval(){}", true],
  ["script", 'function outer(){function eval(){};eval("x")} ', false]
] as const)(
  "uses current eval binding authority in %s: %s",
  (sourceType, declaration, expected) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(
        declaration + (declaration.includes("outer") ? "" : 'eval("x");'),
        { configFile: false, babelrc: false, sourceType }
      )!,
      {
        Program(path) {
          program = path;
        }
      }
    );
    expect(collectRuntimeSourceEvidence(program).hasGlobalEval).toBe(expected);
  }
);
it("preserves runtime export evidence without treating erased exports as escapes", () => {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync(
      "const local={};const erased={};export type {erased};export {local as visible}",
      {
        configFile: false,
        babelrc: false,
        sourceType: "module",
        parserOpts: { plugins: ["typescript"] }
      }
    )!,
    {
      Program(path) {
        program = path;
      }
    }
  );
  const evidence = collectRuntimeSourceEvidence(program);
  expect(evidence.isExported(program.scope.getBinding("local")!)).toBe(true);
  expect(evidence.isExported(program.scope.getBinding("erased")!)).toBe(false);
});

it("does not export outer bindings named like exported function parameters", () => {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync("const record={};export function fn(record){return record}", {
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
  const evidence = collectRuntimeSourceEvidence(program);
  expect(evidence.isExported(program.scope.getBinding("record")!)).toBe(false);
  expect(evidence.isExported(program.scope.getBinding("fn")!)).toBe(true);
});

it("indexes wide parent child identities only within one evidence query", () => {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync(
      Array.from({ length: 64 }, (_, i) => `const x${i}=${i};void x${i};`).join(
        ""
      ),
      { configFile: false, babelrc: false }
    )!,
    {
      Program(path) {
        program = path;
      }
    }
  );
  const scans = vi.spyOn(program.node.body, "includes");
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(true);
  expect(scans.mock.calls.length).toBeLessThan(10);
  program.node.body.shift();
  expect(collectRuntimeSourceEvidence(program).bindingsCurrent).toBe(false);
  scans.mockRestore();
});

it.each([
  ["class C { constructor(){opaque(this)} } new C();", false],
  ["const C=class { constructor(){(()=>opaque(this))()} };new C();", false],
  [
    "class C extends Parent { constructor(){super();opaque(this)} }new C();",
    true
  ],
  [
    "class Parent {constructor(){return globalThis}} class C extends Parent {constructor(){super();opaque(this)}} new C();",
    true
  ],
  ["class C {method(){opaque(this)}} opaque(C.prototype.method);", true],
  [
    'function callback(){"use strict";opaque(this)} window.setTimeout(callback);',
    true
  ]
] as const)(
  "distinguishes constructed receivers from supplied receivers: %s",
  (code, expected) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(code, {
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
    const evidence = collectRuntimeSourceEvidence(program);
    program.traverse({
      ThisExpression(path) {
        expect(isPossibleGlobalThis(path, evidence)).toBe(expected);
      }
    });
  }
);
it("keeps native iteration for base constructor field initialization helpers", () => {
  const result = environments(
    'const C=class {constructor(){defineProperty(this,"field",0)}};new C();'
  );
  expect(result.array.iterationIntact).toBe(true);
});

it.each([
  ["class C {field=opaque(this)}new C();", false],
  ["class C extends Parent {field=opaque(this)}new C();", true],
  ["class C extends Parent {static field=opaque(this)}", false],
  ["class C extends Parent {field=()=>opaque(this)}new C();", true]
] as const)(
  "uses construction receiver semantics for field initializers: %s",
  (code, expected) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(code, {
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
    const evidence = collectRuntimeSourceEvidence(program);
    program.traverse({
      ThisExpression(path) {
        expect(isPossibleGlobalThis(path, evidence)).toBe(expected);
      }
    });
  }
);

it.each([
  ["class C { m(){observe(this)} }", false],
  ["class C { static label='plain'; m(){observe(this)} }", false],
  ["class C { static unused(){return this} m(){observe(this)} }", false],
  [
    "class C { static value=function(){return this}; m(){observe(this)} }",
    false
  ],
  [
    "class C { static value=class {static value=this}; m(){observe(this)} }",
    false
  ],
  ["class C { static {register(this.prototype.m)} m(){observe(this)} }", true],
  ["class C { static value=register(this); m(){observe(this)} }", true],
  ["class C { static {register(()=>this)} m(){observe(this)} }", true],
  [
    "class C extends Base { static {super.register()} m(){observe(this)} }",
    true
  ],
  [
    "class C { static value=class extends register(this){}; m(){observe(this)} }",
    true
  ],
  ["@register class C { m(){observe(this)} }", true],
  ["class C { @register m(){observe(this)} }", true]
] as const)(
  "counts implicit class capabilities, not only identifier reads: %s",
  (code, expected) => {
    let program!: NodePath<t.Program>;
    traverse(
      parseSync(code, {
        configFile: false,
        babelrc: false,
        sourceType: "module",
        parserOpts: { plugins: ["decorators-legacy"] }
      })!,
      {
        Program(path) {
          program = path;
        }
      }
    );
    const evidence = collectRuntimeSourceEvidence(program);
    let checked = 0;
    program.traverse({
      ThisExpression(path) {
        const method = path.findParent((parent) => parent.isClassMethod());
        if (
          method?.isClassMethod() &&
          t.isIdentifier(method.node.key, { name: "m" })
        ) {
          expect(isPossibleGlobalThis(path, evidence)).toBe(expected);
          checked++;
        }
      }
    });
    expect(checked).toBe(1);
  }
);

it.each([
  [`globalThis[''+'callback']()`, true],
  [`globalThis[unknown]()`, true],
  [`globalThis['unrelated']()`, false]
] as const)(
  "tracks computed property uses of script-global bindings: %s",
  (access, expected) => {
    traverse(
      parseSync(`function callback(){}; ${access}`, {
        configFile: false,
        babelrc: false,
        sourceType: "script"
      })!,
      {
        Program(path) {
          const binding = path.scope.getBinding("callback")!;
          expect(
            collectRuntimeSourceEvidence(path).hasGlobalPropertyUse(binding)
          ).toBe(expected);
        }
      }
    );
  }
);

it.each([
  ["script", true],
  ["module", false],
  ["wrapped", false]
] as const)(
  "a callable outside the observed Program can receive a classic realm: %s",
  (sourceType, expected) => {
    const body =
      'function callback(){"use strict"; observe(this)}; callback();';
    traverse(
      parseSync(
        sourceType === "wrapped"
          ? `(function(exports,require,module){${body}})()`
          : body,
        {
          configFile: false,
          babelrc: false,
          sourceType: sourceType === "module" ? "module" : "script"
        }
      )!,
      {
        Program(program) {
          const evidence = collectRuntimeSourceEvidence(program);
          program.traverse({
            ThisExpression(path) {
              expect(isPossibleGlobalThis(path, evidence)).toBe(expected);
            }
          });
        }
      }
    );
  }
);

it.each([
  [
    `(function retry(){"use strict"; observe(this); if(false)retry();})();`,
    false
  ],
  [
    `(function retry(){"use strict"; observe(this); register(retry);})();`,
    true
  ],
  [
    `const launch=function retry(){"use strict"; observe(this); register(retry);};launch();`,
    true
  ],
  [
    `const launch=function retry(){"use strict"; observe(this); if(false)retry();};launch();`,
    false
  ]
] as const)(
  "requires private-name calls to preserve the receiver contract: %s",
  (code, expected) => {
    traverse(parseSync(code, { configFile: false, babelrc: false })!, {
      ThisExpression(path) {
        expect(isPossibleGlobalThis(path)).toBe(expected);
      }
    });
  }
);
it.each([
  ["enum mode { Blue }", false],
  ["namespace mode { export const Blue=1 }", false],
  ["enum other { Blue }", true],
  ["namespace other { export const Blue=1 }", true],
  ["type mode = number", true]
] as const)(
  "checks emitted TS declaration identity against outer initializers: %s",
  (declaration, expected) => {
    const ast = parseSync(
      `const mode=1;function factory(){${declaration};return mode}`,
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] }
      }
    )!;
    traverse(ast, {
      Program(path) {
        expect(collectRuntimeSourceEvidence(path).bindingsCurrent).toBe(
          expected
        );
      }
    });
  }
);

it.each([
  ["observe(document.documentElement);", false],
  ["observe(document.body);", false],
  ["const {body}=document; observe(body);", false],
  ["observe(document.head);", false],
  ["observe(document.body.nodeName);", true],
  ["const element=document.documentElement; observe(element);", false],
  ["observe(document.querySelector('p'));", false],
  ["observe(document.getElementById('p'));", false],
  ["const node=document.getElementById('p'); observe(node);", false],
  ["document.getElementById('p');", true],
  ["observe(document.getElementById('p')?.nodeName);", true],
  ["document.querySelector('p');", true],
  ["observe(document.querySelector('p')?.nonce);", true],
  ["observe(document.documentElement.nodeName);", true]
] as const)(
  "distinguishes document-related node escape from scalar observation: %s",
  (code, expected) => {
    const result = environments(code);
    expect(result.math.intact).toBe(expected);
    expect(result.array.iterationIntact).toBe(expected);
  }
);

function classicRealmProgram(
  code: string,
  sourceType: "script" | "module" = "script"
): NodePath<t.Program> {
  let program!: NodePath<t.Program>;
  traverse(
    parseSync(code, { configFile: false, babelrc: false, sourceType })!,
    {
      Program(path) {
        program = path;
      }
    }
  );
  return program;
}

it.each([
  ["class Tool { show(){ consume(this) } }", "Tool"],
  ["const page = document;", "page"],
  ["const {document: page} = globalThis;", "page"],
  ["const {body: page} = document;", "page"]
] as const)(
  "observes a shared classic capability without mistaking local names: %s",
  (code, name) => {
    const local = classicRealmProgram(
      `function isolated(${name}) { consume(${name}) }`
    );
    const direct = classicRealmProgram("consume(" + name + ");");
    for (const type of ["script", "module"] as const) {
      const origin = classicRealmProgram(code, type);
      const math = createMathIntrinsicEnvironment();
      const array = createArrayMapIntrinsicEnvironment();
      math.observe(origin);
      array.observe(origin);
      math.observe(local);
      array.observe(local);
      const benignMath = code.includes(" = globalThis") ? false : true;
      expect(math.snapshot().intact).toBe(benignMath);
      expect(array.snapshot().iterationIntact).toBe(true);
      math.observe(direct);
      array.observe(direct);
      expect(math.snapshot().intact).toBe(type === "module" && benignMath);
      expect(array.snapshot().iterationIntact).toBe(type === "module");
    }
  }
);

it("rechecks an already observed sibling source after an in-place edit", () => {
  const origin = classicRealmProgram("const page = document;");
  const updated = classicRealmProgram("consume(label);");
  const math = createMathIntrinsicEnvironment();
  const array = createArrayMapIntrinsicEnvironment();
  math.observe(origin);
  math.observe(updated);
  array.observe(origin);
  array.observe(updated);
  expect(math.snapshot().intact).toBe(true);
  expect(array.snapshot().iterationIntact).toBe(true);
  (updated.node.body[0] as t.ExpressionStatement).expression = t.callExpression(
    t.identifier("consume"),
    [t.identifier("page")]
  );
  expect(math.snapshot().intact).toBe(false);
  expect(array.snapshot().iterationIntact).toBe(false);
});

it("indexes only lexical opening JSX tags and opening member roots", () => {
  const ast = parseSync(
    `
    class Tool { method(){ return this; } }
    const ns = {}; const local = 1; const thing = 2; const Member = 3;
    const child = <Tool local={1}><thing/><ns.Member /></Tool>;
  `,
    {
      configFile: false,
      babelrc: false,
      sourceType: "module",
      parserOpts: { plugins: ["jsx"] }
    }
  )!;
  traverse(ast, {
    Program(program) {
      const evidence = collectRuntimeSourceEvidence(program);
      for (const name of ["Tool", "ns", "local", "thing", "Member"]) {
        const binding = program.scope.getBinding(name)!;
        expect(
          evidence.references(binding).map((path) => path.node.type)
        ).toEqual(["Tool", "ns"].includes(name) ? ["JSXIdentifier"] : []);
      }
      program.traverse({
        ThisExpression(path) {
          expect(isPossibleGlobalThis(path, evidence)).toBe(true);
        }
      });
      program.stop();
    }
  });
});

it("keeps object pattern label names out of lexical reference discovery", () => {
  const ast = parseSync(
    `let label,value;({label:value}=data);({[label]:value}=data);`,
    { configFile: false, babelrc: false }
  )!;
  traverse(ast, {
    Program(program) {
      const evidence = collectRuntimeSourceEvidence(program);
      expect(
        evidence.references(program.scope.getBinding("label")!)
      ).toHaveLength(1);
      expect(
        evidence.references(program.scope.getBinding("value")!)
      ).toHaveLength(2);
    }
  });
});

it("indexes emitted reads as unbound through a type-only declaration", () => {
  traverse(
    parseSync("declare const Shared: object; observe(Shared);", {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript"] }
    })!,
    {
      Program(program) {
        const evidence = collectRuntimeSourceEvidence(program);
        expect(evidence.bindingsCurrent).toBe(true);
        expect(evidence.usesUnboundName("Shared")).toBe(true);
        expect(
          evidence.references(program.scope.getBinding("Shared")!)
        ).toHaveLength(0);
      }
    }
  );
});

it("chooses the nearest emitted outer binding rather than an erased local", () => {
  traverse(
    parseSync(
      "const Shared=1; function read(){declare const Shared: object; observe(Shared);}",
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] }
      }
    )!,
    {
      Program(program) {
        const evidence = collectRuntimeSourceEvidence(program);
        const binding = program.scope.getBinding("Shared")!;
        expect(evidence.bindingsCurrent).toBe(true);
        expect(evidence.usesUnboundName("Shared")).toBe(false);
        const [reference] = evidence.references(binding);
        expect(reference?.node.name).toBe("Shared");
        expect(reference && hasRuntimeBinding(reference, "Shared")).toBe(true);
      }
    }
  );
});

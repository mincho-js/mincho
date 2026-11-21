import { runInNewContext } from "node:vm";
import {
  parseSync,
  transformSync,
  types as t,
  type PluginObj
} from "@babel/core";
import { describe, expect, it, vi } from "vitest";
import {
  collectSkippedPatternDefaults,
  patternSelectionEnvironment,
  everyPatternNodeExpression,
  everyPatternExpression,
  type PatternSelectionEnvironment
} from "./patternExpressions.js";

function skippedDefaults(
  source: string,
  environment?: PatternSelectionEnvironment
): string[] {
  const defaults: string[] = [];
  transformSync(source, {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          Program(program) {
            const skipped = collectSkippedPatternDefaults(program, environment);
            program.traverse({
              AssignmentPattern(pattern) {
                if (skipped.has(pattern.node))
                  defaults.push(pattern.get("right").toString());
              }
            });
            program.stop();
          }
        }
      })
    ]
  });
  return defaults;
}

describe("fresh literal default receipts", () => {
  it.each(["4", "0", "false", "null", "{}", "[]"])(
    "records only a definitely skipped default for %s",
    (value) => {
      expect(
        skippedDefaults(`const { value = fallback() } = { value: ${value} };`)
      ).toEqual(["fallback()"]);
    }
  );

  it("does not assume an inherited property is absent when selecting a nested default", () => {
    // Object.prototype.values could supply [undefined], executing fallback().
    // The syntax remains valid; without realm evidence it supplies no receipt.
    expect(
      skippedDefaults("const { values: [value = fallback()] = [4] } = {};", {
        nativeArrayIteration: true,
        standardPrototypeAbsence: false
      })
    ).toEqual([]);
  });

  it.each(["{values:undefined}", "{__proto__:null}"])(
    "shares a proven nested default without suppressing the executed outer default: %s",
    (value) => {
      expect(
        skippedDefaults(
          `const { values: [value = fallback()] = [4] } = ${value};`
        )
      ).toEqual(["fallback()"]);
    }
  );

  it.each([
    "const { value = fallback() } = source;",
    "const { value = fallback() } = {};",
    "const { value = fallback() } = { value: undefined };",
    "const { value = fallback() } = { get value() { return 4; } };",
    "const { value = fallback() } = { ...source };",
    "const [value = fallback()] = [...source];",
    "const [, value = fallback()] = [...[], 4];",
    'const {"01": value = fallback()} = [0, 4];',
    "const {__proto__: value = fallback()} = {__proto__: null};",
    "const {a, b = (a.x = undefined), a: {x = fallback()}} = {a: {x: 4}};",
    "const {a, [(a.x = undefined, 'b')]: b, a: {x = fallback()}} = {a: {x: 4}};"
  ])("does not certify an executed or unknown default: %s", (source) => {
    expect(skippedDefaults(source)).toEqual([]);
  });
});

it.each([
  'const {"1": value = fallback()} = [0,4];',
  'const {__proto__: value = fallback()} = {["__proto__"]: null};',
  "const [value = fallback()] = [4,...source];",
  "const {a, b=0, a:{x=fallback()}} = {a:{x:4}, b:undefined};"
])("preserves stable literal selection: %s", (source) =>
  expect(skippedDefaults(source)).toEqual(["fallback()"])
);

it.each([
  "const [, value = fallback()] = [...[], 4];",
  'const {"01": value = fallback()} = [0, 4];',
  "const {__proto__: value = fallback()} = {__proto__: null};",
  "const {a, b = (a.x = undefined), a: {x = fallback()}} = {a: {x: 4}};",
  "const {a, [(a.x = undefined, 'b')]: b, a: {x = fallback()}} = {a: {x: 4}};"
])("does not certify a default that JavaScript executes: %s", (source) => {
  expect(
    new Function(
      `let calls=0; const fallback=()=>++calls; ${source} return calls;`
    )()
  ).toBe(1);
  expect(skippedDefaults(source)).not.toContain("fallback()");
});
it("does not invalidate later selections for a skipped effectful default", () => {
  expect(
    skippedDefaults(
      "const {a, b=(a.x=undefined), a:{x=fallback()}} = {a:{x:4}, b:0};"
    )
  ).toEqual(["a.x = undefined", "fallback()"]);
});

it.each([
  "Array.prototype[0]={x:undefined}; const [{x=fallback()}={x:4}]=[,];",
  "Object.prototype.foo={x:undefined}; const {foo:{x=fallback()}={x:4}}={};"
])(
  "does not confuse missing own properties with missing inherited values: %s",
  (source) => {
    expect(skippedDefaults(source)).not.toContain("fallback()");
  }
);
it.each([
  "const {foo:{x=fallback()}={x:4}}={__proto__:null};",
  "const {foo:{x=fallback()}={x:4}}={foo:undefined};",
  "const [{x=fallback()}={x:4}]=[undefined];"
])(
  "keeps explicit undefined and null-prototype absence proofs: %s",
  (source) => {
    expect(skippedDefaults(source)).toEqual(["fallback()"]);
  }
);

it("withdraws array iteration selection after an observed iterator replacement", () => {
  expect(
    skippedDefaults(
      "Array.prototype[Symbol.iterator]=function*(){yield undefined}; const [value=fallback()]=[4];"
    )
  ).toEqual([]);
});
it("retains own indexed object reads despite an iterator replacement", () => {
  expect(
    skippedDefaults(
      'Array.prototype[Symbol.iterator]=function*(){yield undefined}; const {"0":value=fallback()}=[4];'
    )
  ).toEqual(["fallback()"]);
});
it.each([false, true])(
  "node-only callers explicitly supply array iteration authority: %s",
  (nativeArrayIteration) => {
    const ast = parseSync("const [value=fallback()]=[4];");
    const statement = ast?.program.body[0];
    if (!t.isVariableDeclaration(statement)) throw new Error("missing fixture");
    const declaration = statement.declarations[0]!;
    const skipped: t.AssignmentPattern[] = [];
    everyPatternNodeExpression(
      declaration.id,
      () => true,
      declaration.init,
      true,
      "",
      (pattern) => skipped.push(pattern),
      { nativeArrayIteration }
    );
    expect(skipped).toHaveLength(nativeArrayIteration ? 1 : 0);
  }
);

it.each([undefined, true, false])(
  "intersects external iteration authority %s with fresh local observations",
  (external) => {
    for (const localMutation of [false, true]) {
      transformSync(
        `${localMutation ? "Array.prototype[Symbol.iterator]=function*(){yield undefined};" : ""} const [value=fallback()]=[4]; const {0: own=ownFallback()}=[4];`,
        {
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              visitor: {
                Program(program) {
                  const environment =
                    external === undefined
                      ? undefined
                      : { nativeArrayIteration: external };
                  const collection = collectSkippedPatternDefaults(
                    program,
                    environment
                  );
                  const wrapper: t.AssignmentPattern[] = [];
                  program.traverse({
                    VariableDeclarator(declaration) {
                      everyPatternExpression(
                        declaration.get("id"),
                        () => true,
                        declaration.node.init,
                        (pattern) => wrapper.push(pattern),
                        environment
                      );
                    }
                  });
                  // The object pattern selects its own data slot, not Array iteration.
                  const expected =
                    1 + Number(external !== false && !localMutation);
                  expect(collection.size).toBe(expected);
                  expect(wrapper).toHaveLength(expected);
                  expect(
                    wrapper.every((pattern) => collection.has(pattern))
                  ).toBe(true);
                  program.stop();
                }
              }
            })
          ]
        }
      );
    }
  }
);

it("recollects exact-node receipts after external authority is revoked", () => {
  transformSync("const [value=fallback()]=[4];", {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          Program(program) {
            const environment = { nativeArrayIteration: true };
            expect(
              collectSkippedPatternDefaults(program, environment).size
            ).toBe(1);
            environment.nativeArrayIteration = false;
            expect(
              collectSkippedPatternDefaults(program, environment).size
            ).toBe(0);
            program.stop();
          }
        }
      })
    ]
  });
});

it.each([
  "const {values: [value=fallback()]=[4]}={};",
  "const [{value=fallback()}={value:4}]=[];",
  "const [{value=fallback()}={value:4}]=[,];"
])("uses an explicit standard-prototype absence operation for %s", (source) => {
  expect(
    skippedDefaults(source, {
      nativeArrayIteration: true,
      standardPrototypeAbsence: true
    })
  ).toEqual(["fallback()"]);
  expect(
    skippedDefaults(source, {
      nativeArrayIteration: true,
      standardPrototypeAbsence: false
    })
  ).toEqual(source.endsWith("=[];") ? ["fallback()"] : []);
  expect(skippedDefaults(source)).toEqual(["fallback()"]);
});

it.each([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__"
])("never treats standard inherited Object member %s as absent", (name) => {
  expect(
    skippedDefaults(`const {${name}: {value=fallback()}={value:4}}={};`, {
      nativeArrayIteration: true,
      standardPrototypeAbsence: true
    })
  ).toEqual([]);
});

it.each([
  "Object.prototype.values=[undefined]; const {values:[value=fallback()]=[4]}={};",
  "Array.prototype[0]={value:undefined}; const [{value=fallback()}={value:4}]=[];"
])(
  "local prototype mutation overrides external absence authority: %s",
  (source) => {
    expect(
      skippedDefaults(source, {
        nativeArrayIteration: true,
        standardPrototypeAbsence: true
      })
    ).toEqual([]);
  }
);

it("does not inspect the whole realm for a bare binding with no pattern expressions", () => {
  transformSync("const value = 4;", {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          VariableDeclarator(declaration) {
            const program = declaration.scope.getProgramParent().path;
            const scan = vi
              .spyOn(program, "traverse")
              .mockImplementation(() => {
                throw new Error("bare binding must not scan realm");
              });
            const predicate = vi.fn(() => true);
            try {
              expect(
                everyPatternExpression(
                  declaration.get("id"),
                  predicate,
                  declaration.node.init
                )
              ).toBe(true);
              expect(predicate).not.toHaveBeenCalled();
              expect(scan).not.toHaveBeenCalled();
            } finally {
              scan.mockRestore();
            }
          }
        }
      })
    ]
  });
});

it("requires operation equivalence for replay even when all defaults are pure", () => {
  const pure = () => true;
  const array = t.arrayPattern([
    t.assignmentPattern(t.identifier("value"), t.numericLiteral(9))
  ]);
  const input = t.arrayExpression([t.numericLiteral(4)]);
  expect(
    everyPatternNodeExpression(array, pure, input, true, "", undefined, {
      nativeArrayIteration: false
    })
  ).toBe(true);
  expect(
    everyPatternNodeExpression(array, pure, input, true, "", undefined, {
      nativeArrayIteration: false,
      requireReplaySafety: true
    })
  ).toBe(false);
  expect(
    everyPatternNodeExpression(
      t.arrayPattern([t.identifier("value")]),
      pure,
      input,
      true,
      "",
      undefined,
      { nativeArrayIteration: false, requireReplaySafety: true }
    )
  ).toBe(false);
  expect(
    everyPatternNodeExpression(array, pure, input, true, "", undefined, {
      nativeArrayIteration: true,
      requireReplaySafety: true
    })
  ).toBe(true);
  const object = t.objectPattern([
    t.objectProperty(
      t.identifier("slot"),
      t.assignmentPattern(t.identifier("value"), t.numericLiteral(9))
    )
  ]);
  const environment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: false,
    requireReplaySafety: true
  };
  expect(
    everyPatternNodeExpression(
      object,
      pure,
      t.objectExpression([]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  for (const value of [
    t.numericLiteral(4),
    t.unaryExpression("void", t.numericLiteral(0))
  ])
    expect(
      everyPatternNodeExpression(
        object,
        pure,
        t.objectExpression([t.objectProperty(t.identifier("slot"), value)]),
        true,
        "",
        undefined,
        environment
      )
    ).toBe(true);
  expect(
    everyPatternNodeExpression(
      object,
      pure,
      t.objectExpression([
        t.objectProperty(t.identifier("__proto__"), t.nullLiteral())
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
});

it("limits precise absence revocation to the selected key without trusting computed keys", () => {
  const environment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: false,
    prototypeMutationKeys: ["name"],
    requireReplaySafety: true
  };
  const pattern = (key: string) =>
    t.objectPattern([
      t.objectProperty(
        t.identifier(key),
        t.assignmentPattern(t.identifier("value"), t.numericLiteral(4))
      )
    ]);
  expect(
    everyPatternNodeExpression(
      pattern("size"),
      () => true,
      t.objectExpression([]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
  expect(
    everyPatternNodeExpression(
      pattern("name"),
      () => true,
      t.objectExpression([]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  expect(
    everyPatternNodeExpression(
      pattern("name"),
      () => true,
      t.objectExpression([
        t.objectProperty(
          t.identifier("name"),
          t.unaryExpression("void", t.numericLiteral(0))
        )
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
  expect(
    everyPatternNodeExpression(
      pattern("name"),
      () => true,
      t.objectExpression([
        t.objectProperty(t.identifier("__proto__"), t.nullLiteral())
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
  const computed = t.objectPattern([
    t.objectProperty(
      t.identifier("key"),
      t.assignmentPattern(t.identifier("value"), t.numericLiteral(4)),
      true
    )
  ]);
  expect(
    everyPatternNodeExpression(
      computed,
      () => true,
      t.objectExpression([]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
});

it("merges external precise keys before certifying aggregate prototype absence", () => {
  const source = "const {values:[value=fallback()]=[4]}={};";
  expect(
    skippedDefaults(source, {
      nativeArrayIteration: true,
      prototypeMutationKeys: ["values"]
    })
  ).not.toContain("fallback()");
  expect(
    skippedDefaults(source, {
      nativeArrayIteration: true,
      prototypeMutationKeys: null
    })
  ).not.toContain("fallback()");
  expect(
    skippedDefaults(source, {
      nativeArrayIteration: true,
      prototypeMutationKeys: ["other"]
    })
  ).toContain("fallback()");
});
it.each([
  t.identifier("source"),
  t.objectExpression([
    t.objectMethod("get", t.identifier("slot"), [], t.blockStatement([]))
  ])
])(
  "does not certify an unresolved own Get from prototype absence",
  (source) => {
    const pattern = t.objectPattern([
      t.objectProperty(t.identifier("slot"), t.identifier("value"))
    ]);
    expect(
      everyPatternNodeExpression(
        pattern,
        () => true,
        source,
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          standardPrototypeAbsence: true,
          requireReplaySafety: true
        }
      )
    ).toBe(false);
  }
);
it("does not select a stale spread slot after an earlier getter changes it", () => {
  const source = "const {b=fallback()}={...{get a(){this.b=undefined},b:1}};";
  expect(
    new Function(
      `let calls=0;function fallback(){calls++;return 9};${source};return calls`
    )()
  ).toBe(1);
  expect(skippedDefaults(source)).not.toContain("fallback()");
  expect(skippedDefaults("const {b=fallback()}={...{a:0,b:1}};")).toContain(
    "fallback()"
  );
});
it.each([
  "const {b:{x=fallback()}}={...{b:{x:1},get a(){this.b.x=undefined}}};",
  "const {b=fallback()}={...{b:1,get 0(){this.b=undefined}}};",
  "const {b=fallback()}={...{...{get a(){this.b=undefined},b:1}}};"
])(
  "does not ignore spread getter ordering or retained nested aliases: %s",
  (source) => {
    expect(
      new Function(
        `let calls=0;function fallback(){calls++;return 9};${source};return calls`
      )()
    ).toBe(1);
    expect(skippedDefaults(source)).not.toContain("fallback()");
  }
);
it("keeps exact own-read authority separate from values and nested reads", () => {
  const source = t.identifier("source");
  const pattern = t.objectPattern([
    t.objectProperty(
      t.identifier("slot"),
      t.assignmentPattern(
        t.identifier("value"),
        t.callExpression(t.identifier("fallback"), [])
      )
    )
  ]);
  const skipped: t.AssignmentPattern[] = [];
  const environment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: true,
    requireReplaySafety: true,
    canReplayOwnRead: (value: t.Expression) => value === source
  };
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      source,
      true,
      "",
      (node) => skipped.push(node),
      environment
    )
  ).toBe(true);
  expect(skipped).toEqual([]);
  const nested = t.objectPattern([
    t.objectProperty(
      t.identifier("slot"),
      t.objectPattern([
        t.objectProperty(t.identifier("value"), t.identifier("value"))
      ])
    )
  ]);
  expect(
    everyPatternNodeExpression(
      nested,
      () => true,
      source,
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
});
it("requires own-read evidence for rest but retains plain data-only rest", () => {
  const pattern = t.objectPattern([t.restElement(t.identifier("rest"))]);
  const environment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: true,
    requireReplaySafety: true
  };
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.identifier("source"),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.objectExpression([
        t.objectMethod("get", t.identifier("slot"), [], t.blockStatement([]))
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.objectExpression([
        t.objectProperty(t.identifier("slot"), t.numericLiteral(4))
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
});
it("allows a fresh root data Get but not an alias or custom prototype", () => {
  const pattern = t.objectPattern([
    t.objectProperty(t.identifier("key"), t.identifier("value"), true)
  ]);
  const data = t.objectExpression([
    t.objectProperty(t.numericLiteral(8), t.numericLiteral(4))
  ]);
  const environment = {
    nativeArrayIteration: true,
    standardPrototypeAbsence: true,
    requireReplaySafety: true
  };
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      data,
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  // An unknown operand needs its own coercion proof, even on fresh own data.
  pattern.properties[0] = t.objectProperty(
    t.binaryExpression("*", t.identifier("spacing"), t.numericLiteral(2)),
    t.identifier("value"),
    true
  );
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      data,
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  pattern.properties[0] = t.objectProperty(
    t.binaryExpression("*", t.numericLiteral(4), t.numericLiteral(2)),
    t.identifier("value"),
    true
  );
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      data,
      true,
      "",
      undefined,
      environment
    )
  ).toBe(true);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.assignmentExpression("=", t.identifier("alias"), data),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.objectExpression([
        t.objectProperty(t.identifier("__proto__"), t.identifier("prototype"))
      ]),
      true,
      "",
      undefined,
      environment
    )
  ).toBe(false);
});
it("does not let a node-only aggregate flag override explicit mutation keys", () => {
  const pattern = t.objectPattern([
    t.objectProperty(t.identifier("slot"), t.identifier("value"))
  ]);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      t.objectExpression([]),
      true,
      "",
      undefined,
      {
        nativeArrayIteration: true,
        standardPrototypeAbsence: true,
        prototypeMutationKeys: ["slot"],
        requireReplaySafety: true
      }
    )
  ).toBe(false);
});

describe("array receiver versus iterator realm", () => {
  const custom = "{0:4,*[Symbol.iterator](){yield undefined}}";
  it("does not select a custom iterator's numeric own property", () => {
    expect(skippedDefaults(`const [value=fallback()]=${custom}`)).toEqual([]);
  });
  it.each([custom, "source", "[4]"])(
    "keeps node and path replay evidence separate for %s",
    (source) => {
      const ast = parseSync(`const [value=fallback()]=${source}`, {
        configFile: false,
        babelrc: false
      })!;
      const declaration = (ast.program.body[0] as t.VariableDeclaration)
        .declarations[0];
      const environment: PatternSelectionEnvironment = {
        nativeArrayIteration: true,
        requireReplaySafety: true
      };
      const skipped: t.AssignmentPattern[] = [];
      expect(
        everyPatternNodeExpression(
          declaration.id,
          () => true,
          declaration.init,
          true,
          "",
          (p) => skipped.push(p),
          environment
        )
      ).toBe(source === "[4]");
      expect(skipped.length).toBe(source === "[4]" ? 1 : 0);
      transformSync(`const [value=fallback()]=${source}`, {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              VariableDeclarator(path) {
                expect(
                  everyPatternExpression(
                    path.get("id"),
                    () => true,
                    path.node.init,
                    undefined,
                    environment
                  )
                ).toBe(source === "[4]");
              }
            }
          })
        ]
      });
    }
  );
  it("allows exact group iteration effects without inventing indexed values", () => {
    const pattern = t.arrayPattern([
      t.assignmentPattern(
        t.identifier("value"),
        t.callExpression(t.identifier("fallback"), [])
      )
    ]);
    const source = t.callExpression(t.identifier("factory"), []);
    const skipped = vi.fn();
    const predicate = vi.fn(() => true);
    expect(
      everyPatternNodeExpression(
        pattern,
        predicate,
        source,
        true,
        "",
        skipped,
        {
          nativeArrayIteration: true,
          requireReplaySafety: true,
          canReplayIteration: (value) => value === source
        }
      )
    ).toBe(true);
    expect(skipped).not.toHaveBeenCalled();
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(
      everyPatternNodeExpression(
        pattern,
        () => true,
        t.identifier("other"),
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          requireReplaySafety: true,
          canReplayIteration: (value) => value === source
        }
      )
    ).toBe(false);
  });
});

it("does not inherit exact iteration authority into nested unknown receivers", () => {
  const source = t.callExpression(t.identifier("factory"), []);
  const pattern = t.arrayPattern([t.arrayPattern([t.identifier("value")])]);
  expect(
    everyPatternNodeExpression(
      pattern,
      () => true,
      source,
      true,
      "",
      undefined,
      {
        nativeArrayIteration: true,
        requireReplaySafety: true,
        canReplayIteration: (value) => value === source
      }
    )
  ).toBe(false);
});

describe("closed local native array receiver aliases", () => {
  it.each([
    ["const array=[4];const[value=fallback()]=array", true],
    ["const array=[4];const alias=array;const[value=fallback()]=alias", true],
    ["const array=[4];var alias=array;const[value]=array", false],
    [
      "function local(){const array=[4];var alias=array;const[value]=array}",
      true
    ],
    ["const array=[4];let alias=array;const[value]=array", true],
    ["const array=[4];array[0]=9;const[value]=array", false],
    ["const array=[4];array[Symbol.iterator]=custom;const[value]=array", false],
    ["const array=[4];opaque(array);const[value]=array", false],
    ["const[value]=array;const array=[4]", false],
    ["const array=[4];function f(){const[value]=array}", false],
    ["const array={0:4,[Symbol.iterator]:custom};const[value]=array", false],
    [
      "const array=[4];const alias=array;opaque(alias);const[value]=array",
      false
    ]
  ] as const)(
    "checks identity without selecting values: %s",
    (source, expected) => {
      let result: boolean | undefined;
      const skipped = vi.fn();
      transformSync(source, {
        sourceType: "script",
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              ArrayPattern(path) {
                result = everyPatternExpression(
                  path,
                  () => true,
                  (path.parentPath.node as t.VariableDeclarator).init,
                  skipped,
                  { nativeArrayIteration: true, requireReplaySafety: true }
                );
              }
            }
          })
        ]
      });
      expect(result).toBe(expected);
      expect(skipped).not.toHaveBeenCalled();
    }
  );
});

describe("identifier default read effects", () => {
  const pattern = "const {a,b=trigger,a:{x=fallback()}}={a:{x:4},b:undefined}";
  it("does not skip after a global accessor default", () => {
    expect(
      skippedDefaults(
        `Object.defineProperty(globalThis,'trigger',{get(){a.x=undefined;return 0}});${pattern}`
      )
    ).toEqual([]);
  });
  it("keeps unproven node-only reads effectful", () => {
    const declaration = (
      parseSync(pattern)!.program.body[0] as t.VariableDeclaration
    ).declarations[0];
    const skipped = vi.fn();
    everyPatternNodeExpression(
      declaration.id,
      () => true,
      declaration.init,
      true,
      "",
      skipped
    );
    expect(skipped).not.toHaveBeenCalled();
  });
  it("retains proven lexical and literal defaults", () => {
    expect(skippedDefaults(`const trigger=0;${pattern}`)).toEqual([
      "fallback()"
    ]);
    expect(skippedDefaults(pattern.replace("b=trigger", "b=0"))).toEqual([
      "fallback()"
    ]);
  });
  it("does not suppress an accessor read inside with", () => {
    const skipped: string[] = [];
    transformSync(`const trigger=0;with(source){${pattern}}`, {
      sourceType: "script",
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            Program(path) {
              const set = collectSkippedPatternDefaults(path);
              path.traverse({
                AssignmentPattern(p) {
                  if (set.has(p.node)) skipped.push(p.get("right").toString());
                }
              });
              path.stop();
            }
          }
        })
      ]
    });
    expect(skipped).toEqual([]);
  });
});
it.each(["trigger", "[trigger]", "{v:trigger}"])(
  "invalidates later defaults for global reads inside %s",
  (value) => {
    expect(
      skippedDefaults(
        `const {a,b=${value},a:{x=fallback()}}={a:{x:4},b:undefined}`
      )
    ).toEqual([]);
  }
);
it.each(["()=>trigger", "function(){return trigger}"])(
  "does not execute the body of a created default %s",
  (value) => {
    expect(
      skippedDefaults(
        `const {a,b=${value},a:{x=fallback()}}={a:{x:4},b:undefined}`
      )
    ).toEqual(["fallback()"]);
  }
);
it("does not grant lexical read evidence before initialization", () => {
  expect(
    skippedDefaults(
      "const {a,b=trigger,a:{x=fallback()}}={a:{x:4},b:undefined};const trigger=0"
    )
  ).toEqual([]);
});
it("passes lexical read evidence through the path API only", () => {
  const skipped: string[] = [];
  transformSync(
    "const trigger=0;const {a,b=trigger,a:{x=fallback()}}={a:{x:4},b:undefined}",
    {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              if (!path.get("id").isObjectPattern()) return;
              everyPatternExpression(
                path.get("id"),
                () => true,
                path.node.init,
                (p) => skipped.push((p.right as t.CallExpression).callee.type)
              );
            }
          }
        })
      ]
    }
  );
  expect(skipped).toEqual(["Identifier"]);
});

describe("review5 pattern operation boundaries", () => {
  it.each(["undefined", "void 0"])(
    "distinguishes dynamic undefined from %s",
    (source) => {
      const found: string[] = [];
      transformSync(
        `with({undefined:{x:void 0}}){const {slot:{x=fallback()}={x:4}}={slot:${source}}}`,
        {
          sourceType: "script",
          configFile: false,
          babelrc: false,
          plugins: [
            (): PluginObj => ({
              visitor: {
                Program(p) {
                  const skipped = collectSkippedPatternDefaults(p);
                  p.traverse({
                    AssignmentPattern(q) {
                      if (skipped.has(q.node))
                        found.push(q.get("right").toString());
                    }
                  });
                  p.stop();
                }
              }
            })
          ]
        }
      );
      expect(found).toEqual(source === "void 0" ? ["fallback()"] : []);
    }
  );
  it.each(["{}", "{...rest}"])(
    "requires object coercibility for %s",
    (pattern) => {
      for (const source of ["null", "void 0", "undefined", "{}"]) {
        const d = (
          parseSync(`const ${pattern}=${source}`)!.program
            .body[0] as t.VariableDeclaration
        ).declarations[0];
        expect(
          everyPatternNodeExpression(
            d.id,
            () => true,
            d.init,
            true,
            "",
            undefined,
            { nativeArrayIteration: true, requireReplaySafety: true }
          )
        ).toBe(source === "{}");
      }
    }
  );
  it("does not reuse own Get authority for an object's key coercion", () => {
    const p = t.objectPattern([
      t.objectProperty(t.identifier("key"), t.identifier("value"), true)
    ]);
    expect(
      everyPatternNodeExpression(
        p,
        () => true,
        t.identifier("source"),
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          requireReplaySafety: true,
          canReplayOwnRead: () => true
        }
      )
    ).toBe(false);
  });
  it("scans a literal's spread boundary once per walk", () => {
    const elements = Array.from({ length: 100 }, (_, i) => t.numericLiteral(i));
    const source = t.arrayExpression(elements);
    const pattern = t.arrayPattern(
      elements.map((_, i) => t.identifier(`v${i}`))
    );
    const slice = vi.spyOn(elements, "slice");
    const findIndex = vi.spyOn(elements, "findIndex");
    everyPatternNodeExpression(pattern, () => true, source);
    expect(slice).not.toHaveBeenCalled();
    expect(findIndex).toHaveBeenCalledTimes(1);
  });
});

it("does not infer global undefined through the path API in with", () => {
  const skipped = vi.fn();
  transformSync(
    "with(source){const {slot:{x=fallback()}={x:4}}={slot:undefined}}",
    {
      sourceType: "script",
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              everyPatternExpression(
                path.get("id"),
                () => true,
                path.node.init,
                skipped
              );
            }
          }
        })
      ]
    }
  );
  expect(skipped).not.toHaveBeenCalled();
});
it.each(["'slot'", "{toString(){observe();return 'slot'}}"])(
  "checks lexical key coercion separately: %s",
  (init) => {
    let safe: boolean | undefined;
    transformSync(`const key=${init};const {[key]:value}={slot:4}`, {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              if (path.get("id").isObjectPattern())
                safe = everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  { nativeArrayIteration: true, requireReplaySafety: true }
                );
            }
          }
        })
      ]
    });
    expect(safe).toBe(init === "'slot'");
  }
);
it("does not classify pipeline results as primitive computed keys", () => {
  const ast = parseSync("const {[0 |> makeKey]:value}={slot:4}", {
    parserOpts: { plugins: [["pipelineOperator", { proposal: "minimal" }]] }
  })!;
  const d = (ast.program.body[0] as t.VariableDeclaration).declarations[0];
  expect(
    everyPatternNodeExpression(d.id, () => true, d.init, true, "", undefined, {
      nativeArrayIteration: true,
      requireReplaySafety: true,
      canReplayOwnRead: () => true
    })
  ).toBe(false);
});
it.each(["const {constructor:key}=1;", "const key=4*2;"])(
  "does not confuse initializer and selected binding for %s",
  (declaration) => {
    let safe: boolean | undefined;
    transformSync(`${declaration}const {[key]:value}={8:4}`, {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              if (
                path.get("id").isObjectPattern() &&
                path.node.init?.type === "ObjectExpression"
              )
                safe = everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  {
                    nativeArrayIteration: true,
                    requireReplaySafety: true,
                    canReplayOwnRead: () => true
                  }
                );
            }
          }
        })
      ]
    });
    expect(safe).toBe(declaration === "const key=4*2;");
  }
);
it.each([false, true])(
  "does not trust a let initializer after dynamic writes: %s",
  (dynamic) => {
    let safe: boolean | undefined;
    transformSync(
      `let key=0;${dynamic ? `eval("key={toString(){probe();return 'x'}}");` : ""}const {[key]:value}=source`,
      {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              VariableDeclarator(path) {
                if (path.get("id").isObjectPattern())
                  safe = everyPatternExpression(
                    path.get("id"),
                    () => true,
                    path.node.init,
                    undefined,
                    {
                      nativeArrayIteration: true,
                      requireReplaySafety: true,
                      canReplayOwnRead: () => true
                    }
                  );
              }
            }
          })
        ]
      }
    );
    expect(safe).toBe(!dynamic);
  }
);
it("observes inserted eval before inferring global undefined without a scope crawl", () => {
  const skipped = vi.fn();
  transformSync("const {slot:{x=fallback()}={x:4}}={slot:undefined}", {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          Program(program) {
            program.node.body.unshift(
              t.expressionStatement(
                t.callExpression(t.identifier("eval"), [
                  t.stringLiteral("opaque()")
                ])
              )
            );
            program.traverse({
              VariableDeclarator(path) {
                everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  skipped
                );
              }
            });
            expect(collectSkippedPatternDefaults(program).size).toBe(0);
            program.stop();
          }
        }
      })
    ]
  });
  expect(skipped).not.toHaveBeenCalled();
});
it.each([
  ["const eval=globalThis.eval;", "eval", false],
  ["const eval=globalThis.eval;", "(eval as any)", false],
  ["const eval=()=>{};", "eval", true]
] as const)(
  "distinguishes direct eval identity: %s %s",
  (declaration, callee, expected) => {
    let safe: boolean | undefined;
    transformSync(
      `function f(){${declaration}let key=0;${callee}("key={toString(){probe();return 'x'}}");const {[key]:value}=source}`,
      {
        sourceType: "script",
        parserOpts: { plugins: ["typescript"] },
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              VariableDeclarator(path) {
                if (path.get("id").isObjectPattern())
                  safe = everyPatternExpression(
                    path.get("id"),
                    () => true,
                    path.node.init,
                    undefined,
                    {
                      nativeArrayIteration: true,
                      requireReplaySafety: true,
                      canReplayOwnRead: () => true
                    }
                  );
              }
            }
          })
        ]
      }
    );
    expect(safe).toBe(expected);
  }
);

it("does not infer script-global mutable key types across indirect eval", () => {
  let safe: boolean | undefined;
  transformSync(
    `let key=0;globalThis.eval("key={toString(){probe();return 'x'}}");const {[key]:value}=source`,
    {
      sourceType: "script",
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              if (path.get("id").isObjectPattern())
                safe = everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  {
                    nativeArrayIteration: true,
                    requireReplaySafety: true,
                    canReplayOwnRead: () => true
                  }
                );
            }
          }
        })
      ]
    }
  );
  expect(safe).toBe(false);
});
it.each(["module-let", "function-let", "const"] as const)(
  "invalidates stale primitive key authority after an unregistered write: %s",
  (kind) => {
    const source =
      kind === "function-let"
        ? "function f(){let key=0;const {[key]:value}=source}"
        : `${kind === "const" ? "const" : "let"} key=0;const {[key]:value}=source`;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            Program(program) {
              program.traverse({
                VariableDeclarator(declaration) {
                  if (!declaration.get("id").isObjectPattern()) return;
                  const query = () =>
                    everyPatternExpression(
                      declaration.get("id"),
                      () => true,
                      declaration.node.init,
                      undefined,
                      {
                        nativeArrayIteration: true,
                        requireReplaySafety: true,
                        canReplayOwnRead: () => true
                      }
                    );
                  expect(query()).toBe(true);
                  const binding = declaration.scope.getBinding("key")!;
                  const body =
                    kind === "function-let"
                      ? (program.node.body[0] as t.FunctionDeclaration).body!
                          .body
                      : program.node.body;
                  body.splice(
                    1,
                    0,
                    parseSync("key={toString(){probe();return 'x'}}")!.program
                      .body[0]
                  );
                  expect(binding.constant).toBe(true); // Deliberately do not refresh Babel's cached binding.
                  expect(query()).toBe(false);
                  declaration.stop();
                }
              });
              program.stop();
            }
          }
        })
      ]
    });
  }
);
describe("pattern operations without bound names", () => {
  it("requires coercibility even for an empty object pattern", () => {
    for (const source of [t.identifier("source"), t.objectExpression([])]) {
      expect(
        everyPatternNodeExpression(
          t.objectPattern([]),
          () => true,
          source,
          true,
          "",
          undefined,
          { nativeArrayIteration: true, requireReplaySafety: true }
        )
      ).toBe(t.isObjectExpression(source));
    }
  });
  it.each(["[value]", "[,]", "[first,...rest]"])(
    "checks every inherited iterator read for %s",
    (pattern) => {
      const d = (
        parseSync(`const ${pattern}=[,,]`)!.program
          .body[0] as t.VariableDeclaration
      ).declarations[0];
      expect(
        everyPatternNodeExpression(
          d.id,
          () => true,
          d.init,
          true,
          "",
          undefined,
          {
            nativeArrayIteration: true,
            prototypeMutationKeys: ["0", "1"],
            requireReplaySafety: true
          }
        )
      ).toBe(false);
    }
  );
  it("does not skip later defaults after an elided inherited Get", () => {
    expect(
      skippedDefaults(
        "const {a,slots:[,],a:{x=fallback()}}={a:{x:4},slots:[,]}",
        { nativeArrayIteration: true, prototypeMutationKeys: ["0"] }
      )
    ).toEqual([]);
  });
  it("checks holes later than the first rest index", () => {
    const d = (
      parseSync("const [first,...rest]=[1,2,,]")!.program
        .body[0] as t.VariableDeclaration
    ).declarations[0];
    expect(
      everyPatternNodeExpression(
        d.id,
        () => true,
        d.init,
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          prototypeMutationKeys: ["2"],
          requireReplaySafety: true
        }
      )
    ).toBe(false);
  });
});
it.each(["[a,...rest]", "[,]", "[a,b=4]"])(
  "keeps dense or completed native iteration eligible: %s",
  (pattern) => {
    const d = (
      parseSync(`const ${pattern}=[1,2]`)!.program
        .body[0] as t.VariableDeclaration
    ).declarations[0];
    expect(
      everyPatternNodeExpression(
        d.id,
        () => true,
        d.init,
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          prototypeMutationKeys: null,
          requireReplaySafety: true
        }
      )
    ).toBe(true);
  }
);
it("does not use alias receiver identity to authorize an inherited Get", () => {
  let safe: boolean | undefined;
  transformSync("const array=[,];const[value]=array", {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          VariableDeclarator(path) {
            if (path.get("id").isArrayPattern())
              safe = everyPatternExpression(
                path.get("id"),
                () => true,
                path.node.init,
                undefined,
                {
                  nativeArrayIteration: true,
                  prototypeMutationKeys: ["0"],
                  requireReplaySafety: true
                }
              );
          }
        }
      })
    ]
  });
  expect(safe).toBe(false);
});
it("keeps exact iterator replay authority separate from default value receipts", () => {
  const d = (
    parseSync("const {slots:[,],a:{x=fallback()}}={slots:[,],a:{x:4}}")!.program
      .body[0] as t.VariableDeclaration
  ).declarations[0];
  const skipped = vi.fn();
  everyPatternNodeExpression(d.id, () => true, d.init, true, "", skipped, {
    nativeArrayIteration: true,
    prototypeMutationKeys: ["0"],
    canReplayIteration: () => true
  });
  expect(skipped).not.toHaveBeenCalled();
});

it("keeps completed iteration independent of inherited numeric properties", () => {
  expect(
    skippedDefaults("const [,{x=fallback()}={x:4}]=[1]", {
      nativeArrayIteration: true,
      prototypeMutationKeys: ["1"]
    })
  ).toEqual(["fallback()"]);
});
it("withdraws old iterator length after an unknown elided getter", () => {
  const d = (
    parseSync("const [,{x=fallback()}={x:4}]=[,]")!.program
      .body[0] as t.VariableDeclaration
  ).declarations[0];
  const skipped = vi.fn();
  everyPatternNodeExpression(d.id, () => true, d.init, true, "", skipped, {
    nativeArrayIteration: true,
    prototypeMutationKeys: ["0"],
    canReplayIteration: (source) => source === d.init
  });
  expect(skipped).not.toHaveBeenCalled();
});

it("matches native completion and length-changing getter counts", () => {
  const completed = runInNewContext(`(() => {
    let gets=0, fallbacks=0;
    Object.defineProperty(Array.prototype, '0', {configurable:true,get(){gets++;return {x:undefined}}});
    const [{x=(()=>{fallbacks++;return 9})()}={x:4}]=[];
    return {gets,fallbacks,x};
  })()`);
  expect(completed).toEqual({ gets: 0, fallbacks: 0, x: 4 });
  const extended = runInNewContext(`(() => {
    let gets=0, fallbacks=0;
    Object.defineProperty(Array.prototype, '0', {configurable:true,get(){gets++;Object.defineProperty(this,'1',{value:{x:undefined},configurable:true,writable:true});return undefined}});
    const [,{x=(()=>{fallbacks++;return 9})()}={x:4}]=[,];
    return {gets,fallbacks,x};
  })()`);
  expect(extended).toEqual({ gets: 1, fallbacks: 1, x: 9 });
});
it.each(["[value=fallback()]", "[,value=fallback()]", "[...rest]"])(
  "separates dense spread result reads from selected values: %s",
  (pattern) => {
    const d = (
      parseSync(`const ${pattern}=[...values]`)!.program
        .body[0] as t.VariableDeclaration
    ).declarations[0];
    const skipped = vi.fn();
    expect(
      everyPatternNodeExpression(d.id, () => true, d.init, true, "", skipped, {
        nativeArrayIteration: true,
        prototypeMutationKeys: null,
        requireReplaySafety: true
      })
    ).toBe(true);
    expect(skipped).not.toHaveBeenCalled();
  }
);
it("does not let spread density authorize holes or survive a default effect", () => {
  for (const source of [
    "const [...rest]=[...values,,]",
    "const [a=effect(),b]=[...values]"
  ]) {
    const d = (parseSync(source)!.program.body[0] as t.VariableDeclaration)
      .declarations[0];
    expect(
      everyPatternNodeExpression(
        d.id,
        () => true,
        d.init,
        true,
        "",
        undefined,
        {
          nativeArrayIteration: true,
          prototypeMutationKeys: null,
          requireReplaySafety: true
        }
      )
    ).toBe(false);
  }
});
it.each([
  "const [value]=[...(function*(){Array.prototype[Symbol.iterator]=custom;yield 4})()]",
  "function change(){Array.prototype[Symbol.iterator]=custom;return 4}const [value]=[change()]"
])(
  "does not approve result iteration when construction changes the native iterator: %s",
  (source) => {
    let safe: boolean | undefined;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              if (path.get("id").isArrayPattern())
                safe = everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  { nativeArrayIteration: true, requireReplaySafety: true }
                );
            }
          }
        })
      ]
    });
    expect(safe).toBe(false);
  }
);
it.each([false, true])(
  "observes newly inserted array escapes without rebuilding bindings: alias=%s",
  (alias) => {
    transformSync(
      `function replace(value){value[Symbol.iterator]=function*(){yield 9}}const array=[4];${alias ? "const alias=array;" : ""}const [value]=${alias ? "alias" : "array"};`,
      {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                program.traverse({
                  VariableDeclarator(path) {
                    if (!path.get("id").isArrayPattern()) return;
                    const query = () =>
                      everyPatternExpression(
                        path.get("id"),
                        () => true,
                        path.node.init,
                        undefined,
                        {
                          nativeArrayIteration: true,
                          requireReplaySafety: true
                        }
                      );
                    expect(query()).toBe(true);
                    const name = alias ? "alias" : "array";
                    const binding = path.scope.getBinding(name)!;
                    const refs = binding.referencePaths.length;
                    program.node.body.splice(
                      program.node.body.length - 1,
                      0,
                      t.expressionStatement(
                        t.callExpression(t.identifier("replace"), [
                          t.identifier(name)
                        ])
                      )
                    );
                    expect(binding.referencePaths.length).toBe(refs);
                    expect(query()).toBe(false);
                    path.stop();
                  }
                });
                program.stop();
              }
            }
          })
        ]
      }
    );
  }
);

it.each(
  ["eval", "(eval)", "((eval))", "(eval as any)"].flatMap((callee) =>
    (["local array", "literal array"] as const).map(
      (receiver) => [callee, receiver] as const
    )
  )
)(
  "withdraws array receipts for direct eval callee %s and %s",
  (callee, receiver) => {
    const local = receiver === "local array";
    const decisions: boolean[] = [];
    let skipped = 0;
    transformSync(
      `${local ? "const array=[4];" : ""}${callee}('${local ? "array" : "Array.prototype"}[Symbol.iterator]=function*(){yield undefined}');const [value=9]=${local ? "array" : "[7]"}`,
      {
        configFile: false,
        babelrc: false,
        parserOpts: {
          plugins: ["typescript"],
          createParenthesizedExpressions: true
        },
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                program.traverse({
                  VariableDeclarator(path) {
                    if (!path.get("id").isArrayPattern()) return;
                    decisions.push(
                      everyPatternExpression(
                        path.get("id"),
                        () => true,
                        path.node.init,
                        () => skipped++,
                        {
                          nativeArrayIteration: true,
                          requireReplaySafety: true
                        }
                      )
                    );
                  }
                });
                program.stop();
              }
            }
          })
        ]
      }
    );
    expect(decisions).toEqual([false]);
    expect(skipped).toBe(0);
  }
);
it.each([false, true])(
  "does not skip siblings across inherited IteratorClose effects: changed=%s",
  (changed) => {
    const source = `${changed ? "Object.prototype.return=function(){a.x=undefined;return {done:true}};" : ""}let calls=0;const {a,slots:[head],a:{x=fallback()}}={a:{x:4},slots:[1,2]};function fallback(){calls++;return 9}({calls,x})`;
    expect(skippedDefaults(source)).toEqual(changed ? [] : ["fallback()"]);
    const actual = runInNewContext(source);
    expect(actual.calls).toBe(changed ? 1 : 0);
    expect(actual.x).toBe(changed ? 9 : 4);
  }
);
it("retains a default receipt after exhausted native iteration without close", () => {
  expect(
    skippedDefaults(
      "const {slots:[head,tail,done],a:{x=fallback()}}={slots:[1,2],a:{x:4}}"
    )
  ).toEqual(["fallback()"]);
});

it("observes the named Iterator prototype without requiring it in the host", () => {
  expect(
    skippedDefaults(
      "Iterator.prototype.return=close; const {slots:[head],a:{x=fallback()}}={slots:[1,2],a:{x:4}}"
    )
  ).toEqual([]);
});

it.each([false, true])(
  "requires an emitted initializer to classify a lexical pattern key: ambient=%s",
  (ambient) => {
    let safe: boolean | undefined;
    transformSync(
      `${ambient ? "declare " : ""}const key='slot';const {[key]:value}={slot:4}`,
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
        plugins: [
          (): PluginObj => ({
            visitor: {
              VariableDeclarator(path) {
                if (!path.get("id").isObjectPattern()) return;
                safe = everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  {
                    nativeArrayIteration: true,
                    requireReplaySafety: true,
                    canReplayOwnRead: () => true
                  }
                );
              }
            }
          })
        ]
      }
    );
    expect(safe).toBe(!ambient);
  }
);

it.each([
  ["[[value]=make()]", "[source]", false],
  ["[{value}=make()]", "[source]", false],
  ["[[value]=make()]", "[[4]]", true],
  ["[[value]=[9]]", "[void 0]", true],
  ["[{value}={value:9}]", "[void 0]", true]
] as const)(
  "checks nested pattern operations only on a proven selected receiver: %s = %s",
  (pattern, initializer, expected) => {
    const d = (
      parseSync(`const ${pattern}=${initializer}`)!.program
        .body[0] as t.VariableDeclaration
    ).declarations[0];
    const isSource = (source: t.Expression) =>
      t.isIdentifier(source, { name: "source" });
    const check = vi.fn(() => true);
    expect(
      everyPatternNodeExpression(d.id, check, d.init, false, "", undefined, {
        nativeArrayIteration: true,
        requireReplaySafety: true,
        standardPrototypeAbsence: true,
        canReplayIteration: isSource,
        canReplayOwnRead: isSource
      })
    ).toBe(expected);
    if (initializer === "[[4]]") expect(check).not.toHaveBeenCalled();
  }
);

it.each([
  ["{[typeof inspect()]:value}", "{}", false, false],
  ["{[typeof inspect()]:value}", "source", true, false],
  ["{[1+2]:value}", "{3:4}", false, true],
  ["{[`slot${1}`]:value}", "{slot1:4}", false, true],
  ["{first=inspect(),[1+2]:value}", "{first:void 0,3:4}", false, false],
  ["{[1+2]:first,[3+4]:second}", "{3:4,7:8}", false, true],
  ["{[1+2]:value}", "source", true, true]
] as const)(
  "keeps computed Get receipts separate from key effects: %s = %s",
  (pattern, initializer, external, expected) => {
    const d = (
      parseSync(`const ${pattern}=${initializer}`)!.program
        .body[0] as t.VariableDeclaration
    ).declarations[0];
    const read = vi.fn(() => external);
    const evaluate = vi.fn(() => true);
    expect(
      everyPatternNodeExpression(d.id, evaluate, d.init, false, "", undefined, {
        nativeArrayIteration: true,
        standardPrototypeAbsence: true,
        requireReplaySafety: true,
        canReplayOwnRead: read
      })
    ).toBe(expected);
    if (external && !expected) expect(read).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalled();
  }
);

it.each([false, true])(
  "shares known import-key facts across direct, combined, and collection walks: %s",
  (sourceBacked) => {
    transformSync(
      'import {key} from "./tokens";const {a,[key * 2]:ignored,a:{x=fallback()}}={a:{x:4}}',
      {
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                const authority = {
                  nativeArrayIteration: true,
                  ...(sourceBacked
                    ? {
                        canReadPrimitiveImport: (
                          binding: import("@babel/traverse").Binding
                        ) => binding === program.scope.getBinding("key")
                      }
                    : {})
                };
                const merged = patternSelectionEnvironment(program, authority);
                const receiptSets = [authority, merged].map((environment) => {
                  const skipped = new Set<t.AssignmentPattern>();
                  program.traverse({
                    VariableDeclarator(path) {
                      everyPatternExpression(
                        path.get("id"),
                        () => true,
                        path.node.init,
                        (pattern) => skipped.add(pattern),
                        environment
                      );
                    }
                  });
                  return skipped;
                });
                const collected = collectSkippedPatternDefaults(
                  program,
                  merged
                );
                for (const skipped of [...receiptSets, collected])
                  expect(skipped.size).toBe(sourceBacked ? 1 : 0);
                expect([...receiptSets[0]]).toEqual([...receiptSets[1]]);
                expect([...receiptSets[0]]).toEqual([...collected]);
              }
            }
          })
        ]
      }
    );
  }
);

it.each([
  ["with (owner) { var {a, a:{x=fallback()}}={a:{x:4}}; }", false],
  ["with (owner) { const {a, a:{x=fallback()}}={a:{x:4}}; }", true],
  [
    "with (owner) { function local(){var {a,a:{x=fallback()}}={a:{x:4}};} }",
    true
  ],
  ["var {a, a:{x=fallback()}}={a:{x:4}};", false],
  ["let {a, a:{x=fallback()}}={a:{x:4}};", true],
  ["const {a, a:{x=fallback()}}={a:{x:4}};", true],
  ["function local(){var {a,a:{x=fallback()}}={a:{x:4}};}", true],
  ["export {}; var {a,a:{x=fallback()}}={a:{x:4}};", true]
] as const)(
  "separates dynamic binding writes from lexical ones: %s",
  (source, expected) => {
    transformSync(source, {
      sourceType: source.startsWith("export") ? "module" : "script",
      configFile: false,
      babelrc: false,
      plugins: [
        (): PluginObj => ({
          visitor: {
            Program(program) {
              const collected = collectSkippedPatternDefaults(program);
              expect(collected.size).toBe(expected ? 1 : 0);
              program.traverse({
                VariableDeclarator(path) {
                  expect(
                    everyPatternExpression(
                      path.get("id"),
                      () => true,
                      path.node.init,
                      undefined,
                      {
                        nativeArrayIteration: true,
                        requireReplaySafety: true
                      }
                    )
                  ).toBe(expected);
                }
              });
            }
          }
        })
      ]
    });
  }
);

it.each([
  ["", "undefined", 1],
  ["{ function undefined(){} }", "undefined", 0],
  ["{ function undefined(){} }", "void 0", 1],
  ['"use strict"; { function undefined(){} }', "undefined", 1]
] as const)(
  "infers undefined only if it lacks a runtime shadow: %s, %s",
  (prefix, input, count) => {
    transformSync(
      `function sample(){${prefix} const {slot:{x=fallback()}={x:4}}={slot:${input}};}`,
      {
        sourceType: "script",
        configFile: false,
        babelrc: false,
        plugins: [
          (): PluginObj => ({
            visitor: {
              Program(program) {
                expect(collectSkippedPatternDefaults(program).size).toBe(count);
                const skipped = vi.fn();
                program.traverse({
                  VariableDeclarator(path) {
                    everyPatternExpression(
                      path.get("id"),
                      () => true,
                      path.node.init,
                      skipped
                    );
                  }
                });
                expect(skipped).toHaveBeenCalledTimes(count);
              }
            }
          })
        ]
      }
    );
  }
);

it.each([
  ["var value;", true],
  ["var value=4;", false],
  ["for(var value of items) {}", false]
] as const)(
  "observes only actual var writes under with: %s",
  (body, expected) => {
    transformSync(`with(owner){${body}}`, {
      configFile: false,
      babelrc: false,
      sourceType: "script",
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              expect(
                everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  {
                    nativeArrayIteration: true,
                    requireReplaySafety: true
                  }
                )
              ).toBe(expected);
            }
          }
        })
      ]
    });
  }
);

it.each([
  ["var value;", "script", true],
  ["var value=4;", "script", false],
  ["for(var value of items) {}", "script", false],
  ["var value=4;", "module", true]
] as const)(
  "distinguishes realm-property writes from confined bindings: %s (%s)",
  (source, sourceType, expected) => {
    transformSync(source, {
      configFile: false,
      babelrc: false,
      sourceType,
      plugins: [
        (): PluginObj => ({
          visitor: {
            VariableDeclarator(path) {
              expect(
                everyPatternExpression(
                  path.get("id"),
                  () => true,
                  path.node.init,
                  undefined,
                  {
                    nativeArrayIteration: true,
                    requireReplaySafety: true
                  }
                )
              ).toBe(expected);
            }
          }
        })
      ]
    });
  }
);

import { hasPrimitiveInvocationResult } from "./primitiveInvocation.js";
import {
  transformSync,
  type NodePath,
  type TransformOptions,
  types as t
} from "@babel/core";
import { describe, expect, it } from "vitest";
import {
  planEvaluation,
  buildEvaluationOwner,
  markBuildEvaluation,
  isProvablyUnexecuted,
  proveEvaluationOrder,
  proveInitializedBindingValue,
  proveEvaluationSteps,
  proveStableEvaluationValue
} from "./evaluation.js";

function expression<T>(
  source: string,
  inspect: (path: NodePath<t.Expression>) => T,
  parserOpts?: TransformOptions["parserOpts"]
): T {
  let result: T | undefined;
  transformSync(`const value = ${source};`, {
    configFile: false,
    babelrc: false,
    parserOpts,
    plugins: [
      () => ({
        visitor: {
          VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
            if (!t.isIdentifier(path.node.id, { name: "value" })) return;
            const initializer = path.get("init");
            if (initializer.isExpression()) result = inspect(initializer);
          }
        }
      })
    ]
  });
  return result!;
}

describe("extraction evaluation contracts", () => {
  it.each(["&&", "||", "??"])(
    "bounds repeated proofs of deeply nested closed %s conditions",
    (operator) => {
      expression(
        `${Array.from({ length: 48 }, () => "true").join(` ${operator} `)} ? "selected" : "excluded"`,
        (path) => {
          expect(
            proveStableEvaluationValue(path, {
              replay: () => "unknown",
              binding: () => "unknown"
            })
          ).toBe("proven");
          expect(
            planEvaluation(path)
              .selectedBranches?.at(-1)
              ?.isStringLiteral({ value: "selected" })
          ).toBe(true);
        }
      );
    }
  );

  it("does not reuse condition proofs after an AST change", () => {
    expression('true ? "selected" : "excluded"', (path) => {
      if (!path.isConditionalExpression())
        throw new Error("Expected condition");
      expect(
        planEvaluation(path)
          .selectedBranches?.at(-1)
          ?.isStringLiteral({ value: "selected" })
      ).toBe(true);
      path.get("test").replaceWith(t.booleanLiteral(false));
      expect(
        planEvaluation(path)
          .selectedBranches?.at(-1)
          ?.isStringLiteral({ value: "excluded" })
      ).toBe(true);
    });
  });

  it.each(["=", "+=", "||="])(
    "separates reference formation from GetValue and writes for %s",
    (operator) => {
      expression(`owner.slot ${operator} call()`, (path) => {
        const plan = planEvaluation(path);
        const callIndex = plan.steps.findIndex(
          (step) =>
            step.kind === "evaluate" && step.operand.path.isCallExpression()
        );
        expect(callIndex).toBeGreaterThan(0);
        const prefix = plan.steps.slice(0, callIndex);
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(proveEvaluationSteps(prefix, requirements)).toBe("unknown");
        for (const reference of ["pending", "proven"] as const) {
          const withReference = { ...requirements, reference: () => reference };
          expect(proveEvaluationSteps(prefix, withReference)).toBe(
            operator === "=" ? reference : "unknown"
          );
          expect(proveEvaluationOrder(path, withReference)).toBe("unknown");
        }
      });
    }
  );

  it.each([
    ["if (false) probe();", true],
    ["if (true) {} else probe();", true],
    ["false && probe();", true],
    ["true || probe();", true],
    ["0 ?? probe();", true],
    ["true ? 0 : probe();", true],
    ["false ? probe() : 0;", true],
    ["if (1 === 2) probe();", true],
    ["if (true) probe();", false],
    ["const enabled = false; if (enabled) probe();", false],
    [
      'let enabled = false; eval("enabled = true"); if (enabled) probe();',
      false
    ],
    ['import { enabled } from "outside"; if (enabled) probe();', false],
    ["if (undefined) probe();", false],
    ["if (NaN) probe();", false],
    ["if (Infinity) {} else probe();", false],
    ["function later() { if (false) probe(); }", true],
    ["class Later { value = false && probe(); }", true],
    ["function outer() { function inner() { if (false) probe(); } }", true],
    ["function outer() { function inner() { if (true) probe(); } }", false],
    ["if (false) { function later() { probe(); } }", false],
    ["if ((sideEffect(), false)) probe();", false]
  ] as const)(
    "certifies only closed literal branch exclusion: %s",
    (source, expected) => {
      let actual: boolean | undefined;
      transformSync(source, {
        configFile: false,
        babelrc: false,
        plugins: [
          () => ({
            visitor: {
              CallExpression(path: NodePath<t.CallExpression>) {
                if (path.get("callee").isIdentifier({ name: "probe" }))
                  actual = isProvablyUnexecuted(path);
              }
            }
          })
        ]
      });
      expect(actual).toBe(expected);
    }
  );

  it.each([
    ['"red"', "proven"],
    ["1 + 2", "proven"],
    ["(replay(), 'red')", "proven"],
    ["false ? {} : 'red'", "proven"],
    ["{}", "unknown"],
    ["[]", "unknown"],
    ["() => 1", "unknown"],
    ["/red/", "unknown"],
    ["replay()", "unknown"],
    ["replay() === replay()", "unknown"],
    ["replay() ? 'red' : 'blue'", "unknown"]
  ] as const)(
    "distinguishes inert evaluation from stable value evidence: %s",
    (source, expected) => {
      expression(source, (path) => {
        const requirements = {
          replay: () => "proven" as const,
          binding: () => "unknown" as const
        };
        expect(proveEvaluationOrder(path, requirements)).toBe("proven");
        expect(proveStableEvaluationValue(path, requirements)).toBe(expected);
      });
    }
  );

  it("accepts a shared value only with evidence for that exact generated binding", () => {
    expression("shared", (path) => {
      const requirements = {
        replay: () => "proven" as const,
        binding: () => "unknown" as const
      };
      expect(proveStableEvaluationValue(path, requirements)).toBe("unknown");
      expect(
        proveStableEvaluationValue(path, {
          ...requirements,
          binding: (value) => (value === path ? "proven" : "unknown"),
          sharedValue: (value) => (value === path ? "proven" : "unknown")
        })
      ).toBe("proven");
    });
  });

  it.each([
    ["owner.field", "observe"],
    ["`${owner}`", "coerce"]
  ] as const)(
    "accepts only supplied %s evidence and retains pending obligations",
    (source, operation) => {
      expression(source, (path) => {
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(proveEvaluationOrder(path, requirements)).toBe("unknown");
        const step = planEvaluation(path).steps.find(
          (step) => step.kind === operation
        )!;
        if (step.kind === "evaluate") throw new Error("Missing evidence step");
        for (const proof of ["pending", "proven"] as const) {
          expect(
            proveEvaluationOrder(path, {
              ...requirements,
              [operation]: (value: NodePath<t.Node>) =>
                value === step.path ? proof : "unknown"
            })
          ).toBe(proof);
        }
      });
    }
  );

  it.each([
    ["left + call()", "proven"],
    ["`${left}${call()}`", "unknown"]
  ] as const)(
    "places coercion at its actual evaluation point: %s",
    (source, expected) => {
      expression(source, (path) => {
        const plan = planEvaluation(path);
        const callIndex = plan.steps.findIndex(
          (step) =>
            step.kind === "evaluate" && step.operand.path.isCallExpression()
        );
        expect(callIndex).toBeGreaterThan(0);
        const requirements = {
          replay: () => "unknown" as const,
          binding: () => "proven" as const
        };
        expect(
          proveEvaluationSteps(plan.steps.slice(0, callIndex), requirements)
        ).toBe(expected);
        expect(proveEvaluationOrder(path, requirements)).toBe("unknown");
      });
    }
  );

  it("retains dependencies below unknown operations without proving them safe", () => {
    expression("class { static color = system.color; }", (path) => {
      const references: string[] = [];
      const visit = (value: NodePath<t.Node>) => {
        if (value.isReferencedIdentifier()) references.push(value.node.name);
        for (const operand of planEvaluation(value).operands)
          visit(operand.path);
      };
      visit(path);
      expect(references).toContain("system");
      expect(planEvaluation(path).kind).toBe("unknown");
      expect(
        proveEvaluationOrder(path, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
  });

  it("separates computed method keys from deferred body captures", () => {
    expression("{ [key()]() { return body.color; } }", (path) => {
      const method = planEvaluation(path).operands[0]!.path;
      const plan = planEvaluation(method);
      expect(plan.operands.map(({ path }) => path.toString())).toEqual([
        "key()"
      ]);
      expect(plan.captures.map((path) => path.toString())).toEqual(["body"]);
      expect(
        proveEvaluationOrder(method, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
    expression("() => effect(owner)", (path) => {
      const plan = planEvaluation(path);
      expect(plan.operands).toEqual([]);
      expect(plan.captures.map((path) => path.toString())).toEqual([
        "effect",
        "owner"
      ]);
      expect(
        proveEvaluationOrder(path, {
          replay: () => "unknown",
          binding: () => "unknown"
        })
      ).toBe("proven");
    });
  });

  it.each([
    "`${replay()}`",
    "{ [replay()]: 1 }",
    "[...replay()]",
    "{ ...replay() }",
    "+replay()"
  ])(
    "does not turn replayed result hooks into inert evaluation: %s",
    (source) => {
      expression(source, (path) => {
        expect(
          proveEvaluationOrder(path, {
            replay: () => "proven",
            binding: () => "proven"
          })
        ).toBe("unknown");
      });
    }
  );

  it("retains pending replay obligations and does not execute an unselected branch", () => {
    expression("{ nested: [replay()] }", (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay: () => "pending",
          binding: () => "unknown"
        })
      ).toBe("pending");
    });
    expression('false ? replay() : "safe"', (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay() {
            throw new Error("Unselected replay must not be requested");
          },
          binding: () => "unknown"
        })
      ).toBe("proven");
    });
    expression('flag ? replay() : "safe"', (path) => {
      expect(
        proveEvaluationOrder(path, {
          replay: () => "proven",
          binding: () => "proven"
        })
      ).toBe("unknown");
    });
  });
});

describe("class evaluation ownership", () => {
  it.each([
    ["field = probe()", false],
    ["#field = probe()", false],
    ["static field = probe()", true],
    ["static { probe(); }", true],
    ["[probe()] = 0", true],
    ["method() { probe(); }", false]
  ])("class member %s is eager: %s", (member, expected) => {
    let owned: boolean | undefined;
    transformSync(`build(() => { class C { ${member} } return C; });`, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            CallExpression(path: NodePath<t.CallExpression>) {
              if (path.get("callee").isIdentifier({ name: "build" }))
                markBuildEvaluation(path.node);
              if (path.get("callee").isIdentifier({ name: "probe" }))
                owned = buildEvaluationOwner(path) !== undefined;
            }
          }
        })
      ]
    });
    expect(owned).toBe(expected);
  });
});

it.each([
  ["class C extends probe() {}", true],
  ["class C { field = class { static x = probe() }; }", false],
  ["class C { static field = class { static x = probe() }; }", true]
])("preserves class evaluation phase: %s", (body, expected) => {
  let owned: boolean | undefined;
  transformSync(`build(() => { ${body} });`, {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          CallExpression(path: NodePath<t.CallExpression>) {
            if (path.get("callee").isIdentifier({ name: "build" }))
              markBuildEvaluation(path.node);
            if (path.get("callee").isIdentifier({ name: "probe" }))
              owned = buildEvaluationOwner(path) !== undefined;
          }
        }
      })
    ]
  });
  expect(owned).toBe(expected);
});

it.each([
  ["({ [probe()]() {} })", true],
  ["({ get [probe()]() { return 1; } })", true],
  ["class C { [probe()]() {} }", true],
  ["class C { static [probe()]() {} }", true],
  ["({ method() { probe(); } })", false],
  ["class C { [0]() { probe(); } }", false]
])("computed method keys retain eager ownership: %s", (body, expected) => {
  let owned: boolean | undefined;
  transformSync(`build(() => { ${body}; });`, {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          CallExpression(path: NodePath<t.CallExpression>) {
            if (path.get("callee").isIdentifier({ name: "build" }))
              markBuildEvaluation(path.node);
            if (path.get("callee").isIdentifier({ name: "probe" }))
              owned = buildEvaluationOwner(path) !== undefined;
          }
        }
      })
    ]
  });
  expect(owned).toBe(expected);
});
it.each([
  ['read(); const token="ready"; function read(){return token}', "unknown"],
  [
    'switch(1){case 0: const token="ready"; break; case 1: use(token)}',
    "unknown"
  ],
  ['switch(0){case 0: const token="ready"; use(token); break}', "proven"],
  ['const token="ready"; use(token)', "proven"],
  ['const token="ready"; if (flag) use(token)', "proven"],
  ['const token="ready"; class C { field=token }', "unknown"],
  ['const token="ready"; class C { static field=token }', "proven"]
])(
  "requires initialization in the same execution frame: %s",
  (source, expected) => {
    let result: string | undefined;
    transformSync(source, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            ReferencedIdentifier(path: NodePath<t.Identifier>) {
              if (path.node.name === "token")
                result = proveInitializedBindingValue(
                  path,
                  {
                    replay: () => "unknown",
                    binding: () => "unknown"
                  },
                  new Set()
                );
            }
          }
        })
      ]
    });
    expect(result).toBe(expected);
  }
);

it.each([
  ["with(proxy){slot=probe()}", "unknown"],
  ["let slot; with(proxy){slot=probe()}", "unknown"],
  ["with(proxy){let slot;slot=probe()}", "proven"],
  ["let slot;slot=probe();with(proxy){}", "proven"]
])("bounds with reference formation: %s", (source, expected) => {
  let proof: string | undefined;
  transformSync(source, {
    sourceType: "script",
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
            const step = planEvaluation(path).steps[0];
            proof = proveEvaluationSteps([step], {
              binding: () => "unknown",
              replay: () => "unknown"
            });
          }
        }
      })
    ]
  });
  expect(proof).toBe(expected);
});
it.each([
  ['const token="ready";with({token:{}}){use(token)}', "unknown"],
  ['with(proxy){const token="ready";use(token)}', "proven"],
  ['const token="ready";use(token);with(proxy){}', "proven"]
])(
  "bounds with interception of initialized bindings: %s",
  (source, expected) => {
    let proof: string | undefined;
    transformSync(source, {
      sourceType: "script",
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            ReferencedIdentifier(path: NodePath<t.Identifier>) {
              if (path.node.name === "token")
                proof = proveInitializedBindingValue(
                  path,
                  { binding: () => "unknown", replay: () => "unknown" },
                  new Set()
                );
            }
          }
        })
      ]
    });
    expect(proof).toBe(expected);
  }
);

it.each([
  ["0 |> (() => ({}))", false],
  ["0 |> (() => 4)", false],
  ["1 + 2", true],
  ["1 === 2", true]
] as const)("preserves the result contract for %s", (source, primitive) => {
  let inspected = false;
  transformSync(`function factory() { return ${source}; }`, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: [["pipelineOperator", { proposal: "minimal" }]] },
    plugins: [
      () => ({
        visitor: {
          FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
            if (path.node.id?.name !== "factory") return;
            inspected = true;
            const statement = path.get("body.body")[0];
            if (!statement.isReturnStatement())
              throw new Error("Expected return");
            const value = statement.get("argument");
            if (!value.isExpression()) throw new Error("Expected expression");
            expect(planEvaluation(value).result.kind === "primitive").toBe(
              primitive
            );
            expect(hasPrimitiveInvocationResult(path)).toBe(primitive);
          }
        }
      })
    ]
  });
  expect(inspected).toBe(true);
});

it.each([
  "external = 1",
  "external++",
  "[external] = [1]",
  "({x: external} = {x: 1})",
  "for (external of [1]) {}"
])("records deferred write capture: %s", (body) => {
  expression(`() => { ${body}; }`, (path) => {
    const plan = planEvaluation(path);
    expect(
      plan.captures.some((value) => value.isIdentifier({ name: "external" }))
    ).toBe(true);
    expect(plan.steps).toEqual([]);
  });
});
it.each(["({[key()]: slot} = rhs())", "([slot] = rhs())"])(
  "evaluates destructuring RHS before pattern: %s",
  (source) => {
    expression(source, (path) => {
      const plan = planEvaluation(path);
      expect(plan.steps[0].kind).toBe("evaluate");
      const first = plan.steps[0];
      expect(
        first.kind === "evaluate" && first.operand.path.isCallExpression()
      ).toBe(true);
    });
  }
);
it("does not schedule replay for possible identifier operands", () => {
  expression("flag ? generated : 0", (path) => {
    const replayed: string[] = [];
    const result = proveEvaluationOrder(path, {
      replay: (value) => {
        replayed.push(value.toString());
        return "pending";
      },
      binding: () => "proven"
    });
    expect(result).toBe("pending"); // The eager flag can still require replay.
    expect(replayed).toEqual(["flag"]);
  });
});
it.each([
  ["false && decodeURIComponent('%')", 0],
  ["(false && decodeURIComponent('%')) === true", 0],
  ["true || decodeURIComponent('%')", 1],
  ["!(true || decodeURIComponent('%'))", 0]
] as const)(
  "never evaluates excluded code while selecting %s",
  (source, expected) => {
    expression(`${source} ? 1 : 0`, (path) => {
      expect(() => planEvaluation(path)).not.toThrow();
      expect(
        planEvaluation(path)
          .selectedBranches?.at(-1)
          ?.isNumericLiteral({ value: expected })
      ).toBe(true);
      expect(planEvaluation(path).unexecutedBranches).toHaveLength(1);
    });
  }
);

it("requires binding evidence rather than pending replay in a possible arm", () => {
  expression("flag ? generated : 0", (path) => {
    expect(
      proveEvaluationOrder(path, {
        replay: (value) =>
          value.isIdentifier({ name: "flag" }) ? "proven" : "pending",
        binding: () => "unknown"
      })
    ).toBe("unknown");
  });
});

it("withdraws an initialized binding proof after a raw AST write", () => {
  transformSync("const value=0; consume(value);", {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          Program(program: NodePath<t.Program>) {
            const binding = program.scope.getBinding("value")!;
            const reference = binding.referencePaths[0];
            if (!reference.isIdentifier())
              throw new Error("Expected reference");
            const requirements = {
              replay: () => "unknown" as const,
              binding: () => "unknown" as const
            };
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("proven");
            program.node.body.splice(
              1,
              0,
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.identifier("value"),
                  t.objectExpression([])
                )
              )
            );
            expect(binding.constant).toBe(true);
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("unknown");
            program.stop();
          }
        }
      })
    ]
  });
});

it("refreshes statement order before proving an initialized binding", () => {
  transformSync("const value=0; consume(value);", {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          Program(program: NodePath<t.Program>) {
            const reference =
              program.scope.getBinding("value")!.referencePaths[0];
            if (!reference.isIdentifier())
              throw new Error("Expected reference");
            const requirements = {
              replay: () => "unknown" as const,
              binding: () => "unknown" as const
            };
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("proven");
            program.node.body.reverse();
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("unknown");
            program.stop();
          }
        }
      })
    ]
  });
});

it.each([
  ["External.View", ["External"]],
  ["External", ["External"]],
  ["div", []],
  ["this", ["this"]],
  ["external.View", ["external"]]
] as const)("captures only JSX runtime tag roots: %s", (tag, expected) => {
  transformSync(`const fn=()=> <${tag}/>;`, {
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["jsx"] },
    plugins: [
      () => ({
        visitor: {
          ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
            const plan = planEvaluation(path);
            expect(
              plan.captures
                .filter((p) => p.isJSXIdentifier())
                .map((p) => p.node.name)
            ).toEqual(expected);
            expect(plan.steps).toEqual([]);
          }
        }
      })
    ]
  });
});
it.each([
  ["flag", false],
  ["true", true]
] as const)(
  "stable value replay preserves arm execution mode: %s",
  (condition, eager) => {
    expression(`${condition} ? (produce(), "red") : "blue"`, (path) => {
      const requested: string[] = [];
      proveStableEvaluationValue(path, {
        replay: (p) => {
          requested.push(p.toString());
          return "proven";
        },
        binding: () => "proven",
        sharedValue: () => "proven"
      });
      expect(requested.includes("produce()")).toBe(eager);
    });
  }
);
it("uses current declarator order after an in-place reorder", () => {
  transformSync('const token="red", used=consume(token);', {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          Program(program: NodePath<t.Program>) {
            const reference =
              program.scope.getBinding("token")!.referencePaths[0];
            if (!reference.isIdentifier())
              throw new Error("Expected reference");
            const requirements = {
              replay: () => "unknown" as const,
              binding: () => "unknown" as const
            };
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("proven");
            const declaration = program.node.body[0];
            if (!t.isVariableDeclaration(declaration))
              throw new Error("Expected declaration");
            declaration.declarations.reverse();
            expect(
              proveInitializedBindingValue(reference, requirements, new Set())
            ).toBe("unknown");
            program.stop();
          }
        }
      })
    ]
  });
});
it.each([
  ["@probe() method() {}", true],
  ["@probe() #method() {}", true],
  ["@decorator method() { probe(); }", false],
  ["@decorate(()=>probe()) method() {}", false]
] as const)(
  "keeps decorator definition expressions distinct from deferred bodies: %s",
  (member, expected) => {
    let owned: boolean | undefined;
    transformSync(`build(()=>{class C {${member}}})`, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["decorators"] },
      plugins: [
        () => ({
          visitor: {
            CallExpression(path: NodePath<t.CallExpression>) {
              if (path.get("callee").isIdentifier({ name: "build" }))
                markBuildEvaluation(path.node);
              if (path.get("callee").isIdentifier({ name: "probe" }))
                owned = buildEvaluationOwner(path) !== undefined;
            }
          }
        })
      ]
    });
    expect(owned).toBe(expected);
  }
);

it.each([false, true])(
  "requires a runtime-emitted initializer: ambient=%s",
  (ambient) => {
    transformSync(
      `${ambient ? "declare " : ""}const value=0; consume(value);`,
      {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["typescript"] },
        plugins: [
          () => ({
            visitor: {
              Program(program: NodePath<t.Program>) {
                const reference =
                  program.scope.getBinding("value")!.referencePaths[0];
                if (!reference.isIdentifier())
                  throw Error("Expected reference");
                expect(
                  proveInitializedBindingValue(
                    reference,
                    { replay: () => "unknown", binding: () => "unknown" },
                    new Set()
                  )
                ).toBe(ambient ? "unknown" : "proven");
                program.stop();
              }
            }
          })
        ]
      }
    );
  }
);
it("distinguishes tagged template-site identity from ordinary template strings", () => {
  const tagged = expression("tag`red`", (path) => {
    if (!path.isTaggedTemplateExpression())
      throw Error("Expected tagged template");
    return planEvaluation(path.get("quasi")).result.kind;
  });
  const plain = expression("`red`", (path) => planEvaluation(path).result.kind);
  expect(tagged).toBe("identity");
  expect(plain).toBe("primitive");
});

it.each([
  ["method(@probe() value:string){}", true],
  ["method(@probe() value:string='ok'){}", true],
  ["constructor(@probe() public value:string){}", true],
  ["method(@decorate value:string=probe()){}", false],
  ["method(value=class {@probe() inner(){}}){}", false],
  ["method(@decorate(()=>probe()) value:string){}", false]
] as const)(
  "assigns legacy parameter decorator ownership only during definition: %s",
  (member, expected) => {
    let owned: boolean | undefined;
    transformSync(`build(()=>{class C {${member}}})`, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "decorators-legacy"] },
      plugins: [
        () => ({
          visitor: {
            CallExpression(path: NodePath<t.CallExpression>) {
              if (path.get("callee").isIdentifier({ name: "build" }))
                markBuildEvaluation(path.node);
              if (path.get("callee").isIdentifier({ name: "probe" }))
                owned = buildEvaluationOwner(path) !== undefined;
            }
          }
        })
      ]
    });
    expect(owned).toBe(expected);
  }
);

it.each([
  "method(@probe() value:string=deferred()){ body(); }",
  "constructor(@probe() public value:string=deferred()){ body(); }"
])(
  "includes legacy decorator expressions, not parameter defaults or bodies: %s",
  (member) => {
    transformSync(`class C {${member}}`, {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript", "decorators-legacy"] },
      plugins: [
        () => ({
          visitor: {
            ClassMethod(path: NodePath<t.ClassMethod>) {
              const plan = planEvaluation(path);
              expect(
                plan.operands.map((operand) => operand.path.toString())
              ).toEqual(["probe()"]);
              expect(
                plan.captures.map((capture) => capture.toString())
              ).not.toContain("probe");
              expect(
                plan.captures.map((capture) => capture.toString())
              ).toEqual(expect.arrayContaining(["deferred", "body"]));
              const replayed: string[] = [];
              const order = (allow: boolean) =>
                proveEvaluationOrder(path, {
                  replay(effect) {
                    replayed.push(effect.toString());
                    return allow ? "proven" : "unknown";
                  },
                  binding: () => "unknown",
                  observe: () => "proven"
                });
              expect(order(false)).toBe("unknown");
              expect(order(true)).toBe("unknown");
              expect(plan.steps.at(-1)?.kind).toBe("apply-decorator");
              expect(replayed).toEqual(["probe()", "probe()"]);
            }
          }
        })
      ]
    });
  }
);

it("keeps only emitted dependencies in function captures", () => {
  transformSync(
    "const factory=()=>{ type T=typeof erased; target = runtime as T; }",
    {
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript"] },
      plugins: [
        () => ({
          visitor: {
            ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
              expect(
                planEvaluation(path).captures.map((capture) =>
                  capture.toString()
                )
              ).toEqual(["target", "runtime"]);
            }
          }
        })
      ]
    }
  );
});

it("only evaluates statements up to and including an unconditional return", () => {
  transformSync("function factory(){return first();return later();}", {
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
            const body = path.get("body");
            const requested: string[] = [];
            expect(
              planEvaluation(body).operands.map(({ execution }) => execution)
            ).toEqual(["eager", "possible"]);
            expect(
              proveEvaluationOrder(body, {
                replay(value) {
                  requested.push(value.toString());
                  return "proven";
                },
                binding: () => "unknown"
              })
            ).toBe("proven");
            expect(requested).toEqual(["first()"]);
          }
        }
      })
    ]
  });
});

it.each(['"key" in shared', "shared instanceof Constructor"])(
  "does not infer a stable state observation from shared identity: %s",
  (source) => {
    expression(source, (path) => {
      const requirements = {
        replay: () => "unknown" as const,
        binding: () => "proven" as const,
        sharedValue: () => "proven" as const,
        observe: () => "proven" as const
      };
      expect(proveEvaluationOrder(path, requirements)).toBe("proven");
      expect(proveStableEvaluationValue(path, requirements)).toBe("unknown");
    });
  }
);

it.each([false, true])(
  "only requests eligible nested replays in source order: first admitted=%s",
  (admitted) => {
    expression('(first(), (second(), "red"))', (path) => {
      const requested: string[] = [];
      const result = proveStableEvaluationValue(path, {
        replay(value) {
          requested.push(value.toString());
          return admitted || value.toString() !== "first()"
            ? "proven"
            : "unknown";
        },
        binding: () => "unknown"
      });
      expect(result).toBe(admitted ? "proven" : "unknown");
      expect(requested).toEqual(
        admitted ? ["first()", "second()"] : ["first()"]
      );
    });
  }
);

it.each([
  ["if(true) return 0;", "proven", []],
  ["if(false) return 0;", "pending", ["later()"]],
  ["if(flag) return 0;", "unknown", []],
  ["if(flag) {return 0;} else {return 1;}", "proven", []],
  ["{if(true) {return 0;}}", "proven", []],
  ["if(flag) {consume();}", "unknown", []]
] as const)(
  "does not schedule continuation replay after a possible return: %s",
  (prefix, expected, calls) => {
    transformSync(`function factory(flag){${prefix}return later();}`, {
      configFile: false,
      babelrc: false,
      plugins: [
        () => ({
          visitor: {
            FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
              const requested: string[] = [];
              expect(
                proveEvaluationOrder(path.get("body"), {
                  replay(value) {
                    if (!value.isCallExpression()) return "unknown";
                    requested.push(value.toString());
                    return "pending";
                  },
                  binding: () => "proven"
                })
              ).toBe(expected);
              expect(requested).toEqual(calls);
            }
          }
        })
      ]
    });
  }
);
it.each([
  ["+shared", false],
  ["shared * 2", false],
  ["`count ${shared}`", false],
  ['+(true ? shared : "2")', false],
  ['+"2"', true],
  ["shared === shared", true]
] as const)(
  "separates coercion-result stability from inert evaluation: %s",
  (source, expected) => {
    expression(source, (path) => {
      const requirements = {
        replay: () => "unknown" as const,
        binding: () => "proven" as const,
        sharedValue: () => "proven" as const,
        coerce: () => "proven" as const
      };
      expect(proveEvaluationOrder(path, requirements)).toBe("proven");
      expect(proveStableEvaluationValue(path, requirements)).toBe(
        expected ? "proven" : "unknown"
      );
      expect(
        proveStableEvaluationValue(path, {
          ...requirements,
          primitiveBinding: () => "proven"
        })
      ).toBe("proven");
    });
  }
);

it.each(["token", "(0, token)", "(true && (0, token))"])(
  "requires a position-safe read for a stable result: %s",
  (source) => {
    expression(source, (path) => {
      for (const read of ["unknown", "pending", "proven"] as const) {
        expect(
          proveStableEvaluationValue(path, {
            replay: () => "proven",
            sharedValue: () => "proven",
            binding: () => read
          })
        ).toBe(read);
      }
    });
  }
);

it("does not promote an inert binding read into a stable comparison value", () => {
  expression("mode === 0", (path) => {
    const orderOnly = {
      replay: () => "unknown" as const,
      binding: () => "proven" as const
    };
    expect(proveEvaluationOrder(path, orderOnly)).toBe("proven");
    expect(proveStableEvaluationValue(path, orderOnly)).toBe("unknown");

    for (const receipt of ["sharedValue", "primitiveBinding"] as const) {
      expect(
        proveStableEvaluationValue(path, {
          ...orderOnly,
          [receipt]: () => "proven" as const
        })
      ).toBe("proven");
    }
  });
});

it.each([
  ["owner.slot = produce()", "eager"],
  ["owner?.slot = produce()", "possible"],
  ["owner?.slot.deep = produce()", "possible"],
  ["owner?.slot! = produce()", "possible"],
  ["owner?.slot += produce()", "possible"],
  ["(owner?.slot).deep = produce()", "eager"]
] as const)(
  "only requests RHS replay for an unconditional assignment: %s",
  (source, execution) => {
    transformSync(`const result=${source};`, {
      configFile: false,
      babelrc: false,
      parserOpts: {
        plugins: [
          "typescript",
          ["optionalChainingAssign", { version: "2023-07" }]
        ]
      },
      plugins: [
        () => ({
          visitor: {
            AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
              expect(planEvaluation(path).operands[1]?.execution).toBe(
                execution
              );
              const requested: string[] = [];
              expect(
                proveEvaluationOrder(path, {
                  replay(value) {
                    requested.push(value.toString());
                    return "proven";
                  },
                  binding: () => "proven",
                  reference: () => "proven",
                  observe: () => "proven"
                })
              ).toBe(execution === "eager" ? "proven" : "unknown");
              expect(requested).toEqual(
                execution === "eager" ? ["produce()"] : []
              );
            }
          }
        })
      ]
    });
  }
);

it("keeps the entire test on the execution path when only its normal result is known", () => {
  expression("(record(), false) ? unused() : kept()", (path) => {
    expect(
      planEvaluation(path).selectedBranches?.map((branch) => branch.toString())
    ).toEqual(["record(), false", "kept()"]);
    const calls: string[] = [];
    proveEvaluationOrder(path, {
      binding: () => "proven",
      replay: (value) => {
        if (value.isCallExpression()) calls.push(value.toString());
        return value.isCallExpression() ? "proven" : "unknown";
      }
    });
    expect(calls).toEqual(["record()", "kept()"]);
  });
});

it.each([
  ["+1n", false],
  ["-1n", true, false],
  ["~1n", true, false],
  ["1n / 0n", false],
  ["1n % 0x0n", false],
  ["1 / 2", true],
  ["1 / 0", true],
  ['"rule-" + 2', true]
] as const)(
  "requires completion after operand coercion before later replay: %s",
  (first, completes, withoutReceipt?: boolean) => {
    const completesWithoutReceipt = withoutReceipt ?? completes;
    expression(`(${first}, later())`, (path) => {
      const requested: string[] = [];
      const requirements = {
        replay(value: NodePath<t.Node>) {
          requested.push(value.toString());
          return "proven" as const;
        },
        binding: () => "unknown" as const
      };
      expect(proveEvaluationOrder(path, requirements)).toBe(
        completesWithoutReceipt ? "proven" : "unknown"
      );
      expect(requested).toEqual(completesWithoutReceipt ? ["later()"] : []);
      requested.length = 0;

      // Even an explicit operand coercion receipt cannot prove the operator.
      expect(
        proveEvaluationOrder(path, {
          ...requirements,
          coerce: () => "proven"
        })
      ).toBe(completes ? "proven" : "unknown");
      expect(requested).toEqual(completes ? ["later()"] : []);
    });
  }
);

it("keeps throw-expression operand evaluation but withholds later replay", () => {
  expression(
    "(throw first(), later())",
    (path) => {
      const requested: string[] = [];
      expect(
        proveEvaluationOrder(path, {
          replay(value) {
            requested.push(value.toString());
            return "proven";
          },
          binding: () => "unknown"
        })
      ).toBe("unknown");
      expect(requested).toEqual(["first()"]);
    },
    { plugins: ["throwExpressions"] }
  );
});

it.each([
  ["unknown", "proven", "unknown"],
  ["proven", "unknown", "unknown"],
  ["pending", "proven", "pending"],
  ["proven", "pending", "pending"],
  ["proven", "proven", "proven"]
] as const)(
  "requires identifier read safety (%s) and stable value evidence (%s)",
  (read, result, expected) => {
    expression("token", (path) => {
      for (const valueFact of ["primitiveBinding", "sharedValue"] as const) {
        expect(
          proveStableEvaluationValue(path, {
            // Owning replay is not proof that the identifier can be read.
            replay: () => "proven",
            binding: () => read,
            [valueFact]: () => result
          })
        ).toBe(expected);
      }
    });
  }
);

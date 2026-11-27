import type { ClosedOwnAllocationShape } from "../../extractionCalls/closedAllocation.js";
import {
  createArrayMapIntrinsicEnvironment,
  isIdentityArrayMapCall,
  isDenseArrayIncludesCall
} from "../../optimizations/arrayMapIntrinsic.js";
import {
  sourceDeliveryStep,
  type EvaluationStep,
  branchEvaluationFacts,
  crossesWithEnvironment,
  isProvablyUnexecuted,
  logicalAssignmentOperator,
  objectSpreadStep,
  patternObservesDelivery,
  bindingPatternReadsSource,
  orderedValueConversionSteps,
  propertyKeyStep,
  planEvaluation
} from "../../extractionCalls/evaluation.js";
import {
  isWriteTarget,
  referencesModuleExports
} from "../../commonjs/bindings.js";
import { hasDynamicScope } from "../../optimizations/dynamicScope.js";
import {
  collectRuntimeSourceEvidence,
  type RuntimeSourceEvidence
} from "../../optimizations/runtimeSourceReference.js";
import { types as t } from "@babel/core";
import {
  isTransparentCssRuleWrapperExpression,
  unwrapTransparentCssRuleExpression
} from "../candidates.js";
import { isSupportedStaticCssPrimitiveLiteral } from "./primitives.js";
import type { NodePath } from "@babel/core";
import type { Binding, Visitor } from "@babel/traverse";
import { isBuiltInExtractionCall } from "../../extractionCalls/builtins.js";
import { STATIC_CSS_EVAL_LIMITS } from "../types.js";
import type { ProgramScope } from "../../types.js";
import { isStaticCssEvalLiteralRequireCallExpression } from "../cjsBindings.js";
import { getCjsAssignmentTarget } from "../cjsExportTargets.js";
import {
  isObjectPrototypeSetter,
  selectObjectLiteralMember,
  staticObjectMemberName as propertyName,
  staticPropertyName
} from "../propertySelection.js";

type ObjectPath = NodePath<t.Node>;

type OriginUncertainty = {
  reason:
    | "unsupported-origin"
    | "recursive-origin"
    | "getter-receiver"
    | "analysis-limit";
  path: NodePath<t.Node>;
};

export type StaticCssMutationProof =
  | { kind: "proved-unmodified" }
  | { kind: "may-mutate" }
  | ({ kind: "unknown" } & OriginUncertainty);

/** Caller receipts, not guesses from a callee name or read-only invocation.
 * build-owned requires validated ownership/replay; identity is shared by all
 * calls that can return the same result. A call node alone is not that proof.
 */
export type CallResultProof =
  | { kind: "primitive"; readOnlyInvocation?: "array-includes" }
  | { kind: "identity-array-map" }
  | {
      kind: "closed-own-allocation";
      identity: object;
      shape: ClosedOwnAllocationShape;
    }
  | { kind: "build-owned"; identity: object }
  /** Scoped, enforced publication boundary, not a source result, physical
   * allocation, primitive, or readonly fact. Runtime artifacts may share state. */
  | { kind: "materialized-artifact"; identity: object }
  /** Validated module provenance only, not immutability or effect-freedom. */
  | {
      kind: "module-origin";
      identity: object;
      primitivePaths?: readonly (readonly string[])[];
    };

export interface MutationOriginOptions {
  /** Conservative shared identity for import bindings and validated loaders. */
  moduleOriginIdentity?: object;
  /** Exact defaults excluded by the caller's existing pattern-selection proof. */
  skippedPatternDefaults?: Pick<ReadonlySet<t.AssignmentPattern>, "has">;
  branchResult?: (path: NodePath<t.Node>) => NodePath<t.Expression> | undefined;
  callResultProof?: (
    path: NodePath<t.CallExpression | t.OptionalCallExpression>
  ) => CallResultProof | undefined;
  callResultProofs?: ReadonlyMap<
    t.CallExpression | t.OptionalCallExpression,
    CallResultProof
  >;
}

export type ImportedOriginProof =
  | { kind: "imported" }
  | { kind: "local" }
  | ({ kind: "unknown" } & OriginUncertainty);

function combineImportedOrigins(
  proofs: ImportedOriginProof[]
): ImportedOriginProof {
  return (
    proofs.find((proof) => proof.kind === "imported") ??
    proofs.find((proof) => proof.kind === "unknown") ?? { kind: "local" }
  );
}

type LiteralScalar = string | number | boolean | null | undefined;
type ScalarProof = { value: LiteralScalar };

interface ObjectReference {
  ownShape?: ClosedOwnAllocationShape;
  modulePrimitivePaths?: readonly (readonly string[])[];
  arrayElements?: (ObjectReference[] | undefined)[];
  parameterFrame?: ReadonlyMap<Binding, ObjectReference[]>;
  provedIdentity?: object;
  provedModuleOrigin?: boolean;
  path: ObjectPath;
  call?: t.Node;
  owner?: NodePath<t.Function>;
  /** The function whose body is currently executing, not the factory owner. */
  activation?: NodePath<t.Function>;
  uncertainty?: OriginUncertainty;
  rest?: {
    sources: ObjectReference[];
    excluded: Set<string>;
    offset?: number;
  };
}

type InvocationArgument = {
  origins: ObjectReference[];
  definitelyDefined: boolean;
  definitelyUndefined?: boolean;
  source?: NodePath<t.Node>;
};
type InvocationArguments = readonly InvocationArgument[];
type ReturnedEffectInspector = (
  fn: NodePath<t.Function>,
  origin: ObjectReference,
  skippedDefaults?: ReadonlySet<t.Node>,
  argumentsInCaller?: InvocationArguments
) => void;
type UnresolvedEffect = (values: ObjectReference[]) => void;

function child(path: NodePath<t.Node>, key: string): NodePath<t.Node> {
  return path.get(key) as NodePath<t.Node>;
}

function isTransparentOriginWrapper(
  path: NodePath<t.Node | null | undefined>
): path is NodePath<t.Expression> {
  return (
    path.isExpression() &&
    !path.isTypeCastExpression() &&
    isTransparentCssRuleWrapperExpression(path.node)
  );
}

export class StaticCssMutationAnalysisLimit extends Error {}

/** Tracks allocation identity without executing initializers, getters or calls. */
class ObjectReferences {
  private allocations = new WeakMap<t.Node, WeakMap<t.Node, object>>();
  private visits = 0;
  private parameterOrigins = new Map<Binding, ObjectReference[]>();
  private parameterScalars = new Map<Binding, ScalarProof>();
  private activeScalarCalls = new Map<t.Function, Set<string>>();
  private returnedEffectReceivers = new Map<t.Function, ObjectReference>();
  private activeReturnedEffects = new Map<object, Set<t.Function>>();
  private functionNodes = new WeakMap<t.Function, Set<t.Node>>();
  private deletedProperties = new Map<object, Set<string | null>>();
  private possibleDeletedNames?: Set<string | null>;
  private primitiveHookEvidence?: RuntimeSourceEvidence;
  private hasOpenPrimitiveHookScope?: boolean;
  private assignmentIterationIsIntact?: boolean;

  constructor(
    private opaqueCalls: ReadonlySet<t.CallExpression>,
    private selectedBranches?: ReadonlyMap<t.Node, NodePath<t.Expression>>,
    program?: NodePath,
    private originOptions: MutationOriginOptions = {}
  ) {
    if (!program) return;

    const deletions: NodePath<
      t.MemberExpression | t.OptionalMemberExpression
    >[] = [];
    program.traverse({
      UnaryExpression(path) {
        const argument = path.get("argument");
        if (
          path.node.operator === "delete" &&
          (argument.isMemberExpression() ||
            argument.isOptionalMemberExpression())
        )
          deletions.push(argument);
      }
    });
    // Resolve deletion receivers with every possibly deleted slot open first.
    // Narrowing to allocation identities afterwards preserves unrelated shadows.
    this.possibleDeletedNames = new Set(
      deletions.map((path) => memberName(path.node))
    );
    for (const deletion of deletions) {
      const name = memberName(deletion.node);
      for (const reference of this.resolve(deletion.get("object"))) {
        const identity = this.identity(reference);
        const names = this.deletedProperties.get(identity) ?? new Set();
        names.add(name);
        this.deletedProperties.set(identity, names);
      }
    }
    this.possibleDeletedNames = undefined;
  }

  private mayDelete(reference: ObjectReference, name: string): boolean {
    const names =
      this.possibleDeletedNames ??
      this.deletedProperties.get(this.identity(reference));
    return names?.has(null) === true || names?.has(name) === true;
  }

  // Count repeated work too: acyclic helper graphs can expand exponentially.
  private visit(work = 1): void {
    const limit = STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount;
    this.visits += work;
    if (this.visits > limit) {
      throw new StaticCssMutationAnalysisLimit(
        `Cannot statically evaluate css prop value: mutation analysis node visit limit exceeded (${this.visits} visits > ${limit} visits)`
      );
    }
  }

  identity(reference: ObjectReference): object {
    if (reference.provedIdentity) return reference.provedIdentity;
    if (!reference.call) return reference.path.node;

    let calls = this.allocations.get(reference.path.node);

    if (!calls) {
      calls = new WeakMap();
      this.allocations.set(reference.path.node, calls);
    }

    let identity = calls.get(reference.call);

    if (!identity) {
      identity = {};
      calls.set(reference.call, identity);
    }

    return identity;
  }

  private atCall(
    reference: ObjectReference,
    call: t.Node,
    owner: NodePath<t.Function>
  ): ObjectReference {
    return reference.path.findParent((parent) => parent === owner)
      ? {
          ...reference,
          call,
          owner,
          parameterFrame: new Map(this.parameterOrigins)
        }
      : reference;
  }

  private inReferenceFrame<T>(reference: ObjectReference, run: () => T): T {
    const previous = this.parameterOrigins;
    if (reference.parameterFrame)
      this.parameterOrigins = new Map(reference.parameterFrame);
    try {
      return run();
    } finally {
      this.parameterOrigins = previous;
    }
  }

  resolve(
    path: NodePath<t.Node | null | undefined>,
    seen = new Set<t.Node>()
  ): ObjectReference[] {
    if (!path.node) return [];

    this.visit();

    if (seen.has(path.node))
      return [
        {
          path: path as NodePath<t.Node>,
          uncertainty: {
            reason: "recursive-origin",
            path: path as NodePath<t.Node>
          }
        }
      ];

    const next = new Set(seen).add(path.node);
    const selected =
      this.selectedBranches?.get(path.node) ??
      (path.isConditionalExpression() || path.isLogicalExpression()
        ? this.originOptions.branchResult?.(path)
        : undefined);

    if (selected) return this.resolve(selected, next);
    if (
      path.isObjectExpression() ||
      path.isArrayExpression() ||
      path.isFunction() ||
      path.isClass()
    )
      return [{ path }];

    if (path.isThisExpression()) {
      const receiver = this.returnedReceiver(path);
      if (receiver) return [receiver];
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);

      if (binding) return this.binding(binding, next, path);
      if (["undefined", "NaN", "Infinity"].includes(path.node.name)) return [];
      return [{ path, uncertainty: { reason: "unsupported-origin", path } }];
    }

    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      return this.select(
        this.resolve(child(path, "object"), next),
        memberName(path.node),
        next
      );
    }
    if (path.isConditionalExpression()) {
      const condition = this.literalScalar(path.get("test"));
      if (condition)
        return this.resolve(
          condition.value ? path.get("consequent") : path.get("alternate"),
          next
        );
      return [
        ...this.resolve(path.get("consequent"), next),
        ...this.resolve(path.get("alternate"), next)
      ];
    }
    if (path.isLogicalExpression()) {
      return [
        ...this.resolve(path.get("left"), next),
        ...this.resolve(path.get("right"), next)
      ];
    }
    if (path.isAssignmentExpression())
      return this.resolve(path.get("right"), next);

    if (path.isSequenceExpression()) {
      const expressions = path.get("expressions");

      return this.resolve(expressions[expressions.length - 1], next);
    }

    if (isTransparentOriginWrapper(path))
      return this.resolve(child(path, "expression"), next);

    if (path.isCallExpression() || path.isOptionalCallExpression()) {
      const proof =
        this.originOptions.callResultProofs?.get(path.node) ??
        this.originOptions.callResultProof?.(path);
      if (proof?.kind === "primitive") return [];
      if (proof?.kind === "closed-own-allocation")
        return proof.shape.kind === "primitive"
          ? []
          : [
              {
                path,
                provedIdentity: proof.identity,
                ownShape: proof.shape
              }
            ];
      if (
        proof?.kind === "identity-array-map" &&
        isIdentityArrayMapCall(path)
      ) {
        const callee = path.get("callee");
        if (callee.isMemberExpression()) {
          const receiver = callee.get("object");
          if (receiver.isArrayExpression())
            return [
              {
                path,
                arrayElements: receiver
                  .get("elements")
                  .map((element) =>
                    element.node ? this.resolve(element, next) : undefined
                  )
              }
            ];
        }
      }
      if (
        proof?.kind === "build-owned" ||
        proof?.kind === "module-origin" ||
        proof?.kind === "materialized-artifact"
      )
        return [
          {
            path,
            provedIdentity: proof.identity,
            provedModuleOrigin: proof.kind === "module-origin",
            modulePrimitivePaths:
              proof.kind === "module-origin" ? proof.primitivePaths : undefined
          }
        ];
      if (path.isCallExpression() && this.opaqueCalls.has(path.node))
        return [{ path }];
      const callee = child(path, "callee");
      const nestedMemberCall = this.returnedReceiverMethod(callee);
      const fn = nestedMemberCall?.method ?? this.localCallable(callee, next);
      const call: NodePath<t.CallExpression | t.OptionalCallExpression> = path;
      const args = call.get("arguments");
      const scalarFrame = fn ? this.scalarCallFrame(fn, args) : undefined;
      const scalarKey =
        scalarFrame &&
        JSON.stringify(
          [...scalarFrame.values()].map(({ value }) => [typeof value, value])
        );
      const repeatedState =
        !!fn &&
        scalarKey !== undefined &&
        this.activeScalarCalls.get(fn.node)?.has(scalarKey);
      // Only compiler-authorized opaque calls above have independent identities.
      // An uninspected factory may return shared state, including on repeated calls.
      if (
        !fn ||
        (next.has(fn.node) && !scalarFrame) ||
        repeatedState ||
        args.some((argument) => argument.isSpreadElement()) ||
        fn.node.async ||
        fn.node.generator ||
        fn
          .get("params")
          .some(
            (parameter) =>
              parameter.isRestElement() ||
              Object.keys(t.getBindingIdentifiers(parameter.node)).some(
                (name) => !!fn.scope.getBinding(name)?.constantViolations.length
              )
          )
      ) {
        const uncertainty: OriginUncertainty = {
          reason:
            fn?.node && next.has(fn.node)
              ? "recursive-origin"
              : "unsupported-origin",
          path
        };
        const plan = planEvaluation(path);
        return [
          { path, uncertainty },
          ...[...(nestedMemberCall?.receiver.parameterFrame?.values() ?? [])]
            .flat()
            .map((reference) => ({
              ...reference,
              uncertainty: reference.uncertainty ?? uncertainty
            })),
          ...[...plan.operands.map((operand) => operand.path), ...plan.captures]
            .flatMap((input) => this.resolve(input, next))
            .map((reference) => ({
              ...reference,
              uncertainty: reference.uncertainty ?? uncertainty
            }))
        ];
      }

      // Return origins and call effects are separate proofs. Substitution
      // preserves actual argument/captured identities; it does not make a
      // source-visible call read-only or authorize moving its execution.
      const previous = this.parameterOrigins;
      const argumentsInCaller = this.observeArguments(args, next);
      this.bindInvocationParameters(fn, argumentsInCaller, next);
      const previousScalars = this.parameterScalars;
      if (scalarFrame)
        this.parameterScalars = new Map([...previousScalars, ...scalarFrame]);
      const active = this.activeScalarCalls.get(fn.node) ?? new Set<string>();
      if (scalarKey !== undefined) {
        if (active.size >= 32)
          throw new StaticCssMutationAnalysisLimit(
            "local literal call state limit exceeded"
          );
        active.add(scalarKey);
        this.activeScalarCalls.set(fn.node, active);
      }
      const previousReceiver = this.returnedEffectReceivers.get(fn.node);
      if (nestedMemberCall)
        this.returnedEffectReceivers.set(fn.node, nestedMemberCall.receiver);
      try {
        // Revisit the same body only under a distinct, fully-known scalar state.
        // Ordinary alias cycles retain their original seen-node guard.
        const nodes = scalarFrame ? this.localFunctionNodes(fn) : undefined;
        const nested = new Set(
          [...next].filter((node) => !nodes?.has(node))
        ).add(fn.node);
        return this.returnedValues(fn, nested).map((reference) =>
          this.atCall(reference, path.node, fn)
        );
      } finally {
        this.parameterOrigins = previous;
        this.parameterScalars = previousScalars;
        if (nestedMemberCall) {
          if (previousReceiver)
            this.returnedEffectReceivers.set(fn.node, previousReceiver);
          else this.returnedEffectReceivers.delete(fn.node);
        }
        if (scalarKey !== undefined) active.delete(scalarKey);
      }
    }

    // Empty is reserved for a known non-reference value. Unsupported value
    // producers retain their inputs/captures as uncertain, rather than proving
    // that no alias exists merely because this analysis cannot interpret them.
    const plan = planEvaluation(path as NodePath<t.Node>);
    if (plan.result.kind === "primitive") return [];
    if (path.isExpression() || path.isSuper()) {
      const uncertainty: OriginUncertainty = {
        reason: "unsupported-origin",
        path
      };
      // A tag receives interpolation values, not a coerced template string.
      const inputs = path.isTaggedTemplateExpression()
        ? [
            path.get("tag"),
            ...planEvaluation(path.get("quasi")).operands.map(
              (operand) => operand.path
            )
          ]
        : [...plan.operands.map((operand) => operand.path), ...plan.captures];
      return [
        { path, uncertainty },
        ...inputs
          .flatMap((input) => this.resolve(input, next))
          .map((reference) => ({
            ...reference,
            uncertainty: reference.uncertainty ?? uncertainty
          }))
      ];
    }
    return [];
  }

  private returnedValues(
    fn: NodePath<t.Function>,
    seen: Set<t.Node>
  ): ObjectReference[] {
    const body = fn.get("body");
    if (!body.isBlockStatement()) return this.resolve(body, seen);
    const returned: ObjectReference[] = [];
    body.traverse({
      enter: () => this.visit(),
      Function(inner) {
        inner.skip();
      },
      ReturnStatement: (statement) => {
        returned.push(...this.resolve(statement.get("argument"), seen));
      }
    });
    return returned;
  }

  private observeArguments(
    args: readonly NodePath<t.Node>[],
    seen = new Set<t.Node>()
  ): InvocationArguments {
    return args.map((argument) => {
      const scalar = this.literalScalar(argument);
      return {
        origins: this.resolve(argument, seen),
        source: argument,
        definitelyUndefined: scalar !== undefined && scalar.value === undefined,
        definitelyDefined: scalar
          ? scalar.value !== undefined
          : argument.isObjectExpression() ||
            argument.isArrayExpression() ||
            argument.isFunction() ||
            argument.isClassExpression()
      };
    });
  }

  private bindInvocationParameters(
    fn: NodePath<t.Function>,
    argumentsInCaller: InvocationArguments,
    seen = new Set<t.Node>()
  ): ReadonlySet<t.Node> {
    // The arguments belong to the caller, but defaults run in the captured
    // callee's frame and can refer to earlier parameters.
    const parameters = new Map(this.parameterOrigins);
    this.parameterOrigins = parameters;
    const skippedDefaults = new Set<t.Node>();
    for (const [index, parameter] of fn.get("params").entries()) {
      const argument = argumentsInCaller[index];
      let pattern: NodePath<t.Node> = parameter;
      if (argument?.definitelyDefined && parameter.isAssignmentPattern()) {
        skippedDefaults.add(parameter.node.right);
        pattern = parameter.get("left");
      }
      for (const name of Object.keys(t.getBindingIdentifiers(parameter.node))) {
        const binding = fn.scope.getBinding(name);
        if (!binding) continue;
        parameters.set(
          binding,
          this.pattern(
            pattern,
            name,
            argument?.origins ?? [],
            seen,
            undefined,
            {
              source: argument?.source
            }
          )
        );
      }
    }
    return skippedDefaults;
  }

  selectedParameterDelivery(
    parameter: NodePath<t.Node>,
    incoming: InvocationArgument | undefined
  ): { pattern: NodePath<t.Node>; origins: ObjectReference[] } {
    if (!parameter.isAssignmentPattern())
      return { pattern: parameter, origins: incoming?.origins ?? [] };
    return {
      pattern: parameter.get("left"),
      // The caller's argument has already been evaluated. An omitted or
      // proved undefined value selects the default in the active callee frame.
      origins:
        !incoming || incoming.definitelyUndefined
          ? this.resolve(parameter.get("right"))
          : incoming.origins
    };
  }

  private observedInvocation(
    call: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >
  ): InvocationArguments | null {
    const args = call.get("arguments");
    return args.some((argument) => argument.isSpreadElement())
      ? null
      : this.observeArguments(args);
  }

  private literalScalar(
    path: NodePath<t.Node | null | undefined>
  ): ScalarProof | undefined {
    this.visit();
    if (!path.node) return { value: undefined };
    if (
      path.isStringLiteral() ||
      path.isNumericLiteral() ||
      path.isBooleanLiteral()
    )
      return { value: path.node.value };
    if (path.isNullLiteral()) return { value: null };
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      return binding
        ? this.parameterScalars.get(binding)
        : path.node.name === "undefined"
          ? { value: undefined }
          : undefined;
    }
    return undefined;
  }

  private scalarCallFrame(
    fn: NodePath<t.Function>,
    args: NodePath<t.Node>[]
  ): Map<Binding, ScalarProof> | undefined {
    const frame = new Map<Binding, ScalarProof>();
    for (const [index, parameter] of fn.get("params").entries()) {
      const id = parameter.isAssignmentPattern()
        ? parameter.get("left")
        : parameter;
      if (!id.isIdentifier()) return;
      const binding = fn.scope.getBinding(id.node.name);
      if (!binding || binding.constantViolations.length) return;
      const argument = args[index];
      let scalar = argument
        ? this.literalScalar(argument)
        : { value: undefined };
      if (!scalar) return;
      if (scalar.value === undefined && parameter.isAssignmentPattern())
        scalar = this.literalScalar(parameter.get("right"));
      if (!scalar) return;
      frame.set(binding, scalar);
    }
    return frame;
  }

  private localFunctionNodes(fn: NodePath<t.Function>): Set<t.Node> {
    let nodes = this.functionNodes.get(fn.node);
    if (!nodes) {
      nodes = new Set([fn.node]);
      fn.traverse({
        enter: (path) => {
          this.visit();
          nodes!.add(path.node);
        }
      });
      this.functionNodes.set(fn.node, nodes);
    }
    return nodes;
  }

  private localCallable(
    callee: NodePath<t.Node>,
    seen: Set<t.Node>
  ): NodePath<t.Function> | undefined {
    if (callee.isFunction()) return callee;
    if (callee.isIdentifier()) {
      const binding = callee.scope.getBinding(callee.node.name);
      if (!binding || binding.constantViolations.length) return;
      const declaration = binding.path;
      const fn = declaration.isVariableDeclarator()
        ? declaration.get("init")
        : declaration;
      return fn.isFunction() ? fn : undefined;
    }
    if (!callee.isMemberExpression() && !callee.isOptionalMemberExpression())
      return;
    const name = memberName(callee.node);
    if (name === null) return;
    const receiver = child(callee, "object");
    if (receiver.isIdentifier()) {
      const binding = receiver.scope.getBinding(receiver.node.name);
      if (!binding || binding.constantViolations.length) return;
      // A local method table may be read by these direct calls only. Aliases,
      // stores, writes, unknown property reads and escapes need a separate proof.
      if (
        binding.referencePaths.some((reference) => {
          const member = reference.parentPath;
          return (
            !member ||
            (!member.isMemberExpression() &&
              !member.isOptionalMemberExpression()) ||
            member.node.object !== reference.node ||
            memberName(member.node) !== name ||
            (!member.parentPath?.isCallExpression() &&
              !member.parentPath?.isOptionalCallExpression()) ||
            member.parentPath.node.callee !== member.node
          );
        })
      )
        return;
    } else if (!receiver.isObjectExpression()) return;
    const objects = this.resolve(receiver, seen);
    if (
      objects.length !== 1 ||
      objects[0].uncertainty ||
      objects[0].parameterFrame
    )
      return;
    const object = objects[0].path;
    if (!object.isObjectExpression()) return;
    const selected = selectObjectLiteralMember(object.node, name);
    if (selected.kind !== "property") return;
    const property = child(object, selected.path);
    const fn = property.isObjectProperty()
      ? property.get("value")
      : property.isObjectMethod({ kind: "method" })
        ? property
        : undefined;
    if (!fn?.isFunction()) return;
    let receiverDependent = false;
    fn.traverse({
      enter: () => this.visit(),
      "ThisExpression|Super"() {
        receiverDependent = true;
      }
    });
    return receiverDependent ? undefined : fn;
  }

  inspectReturnedCallable(
    value: NodePath<t.Node>,
    inspect: ReturnedEffectInspector,
    call: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >,
    unresolved: UnresolvedEffect,
    evaluation: ReturnType<typeof branchEvaluationFacts>
  ): boolean {
    // Most calls are direct declarations, imports or methods. Resolve
    // returned values at their invocation, including conditional selection.
    let source = value;
    let writtenOrigins: ObjectReference[] | undefined;
    let projectedBinding = false;
    const seen = new Set<t.Node>();
    for (;;) {
      while (isTransparentOriginWrapper(source)) {
        this.visit();
        source = child(source, "expression");
      }
      if (!source.isIdentifier()) break;
      this.visit();
      if (seen.has(source.node)) return false;
      seen.add(source.node);
      const binding = source.scope.getBinding(source.node.name);
      if (!binding?.path.isVariableDeclarator()) return false;
      if (!binding.constant) {
        // The reference's execution position selects the lexical store, just
        // as a member invocation selects the write to the actual receiver.
        writtenOrigins = this.binding(binding, seen, source, true);
        break;
      }
      // The initializer describes the container, not necessarily the
      // value invoked. Binding resolution projects the selected slot below.
      if (!binding.path.get("id").isIdentifier()) {
        projectedBinding = true;
        break;
      }
      source = binding.path.get("init") as NodePath<t.Node>;
    }
    // Inspect the yielded/possible callable, not the prefix or an excluded
    // branch. Their evaluation remains at the authored expression.
    const projected =
      source.isLogicalExpression() ||
      source.isConditionalExpression() ||
      source.isSequenceExpression()
        ? evaluation.plan(source).result
        : undefined;
    if (
      !writtenOrigins &&
      !projectedBinding &&
      projected?.kind !== "operand" &&
      !source.isCallExpression() &&
      !source.isOptionalCallExpression()
    )
      return false;
    if (isProvablyUnexecuted(call)) return true;

    let inspected = false;
    let args: InvocationArguments | null | undefined;
    const consumed =
      writtenOrigins ??
      (projected?.kind === "operand" && source.isLogicalExpression()
        ? projected.paths.flatMap((operand) => this.resolve(operand))
        : this.resolve(value));
    for (const origin of consumed) {
      if (
        (projected?.kind === "operand" || writtenOrigins || projectedBinding) &&
        origin.uncertainty
      ) {
        // An unknown arm can only veto an invocation when its captured origin
        // is relevant to the rule; known arms retain their own caller frames.
        unresolved([origin]);
      } else if (
        origin.path.isFunction() &&
        origin.parameterFrame &&
        !origin.uncertainty
      ) {
        if (args === undefined) args = this.observedInvocation(call);
        this.inspectReturnedEffect(
          origin,
          origin.path,
          inspect,
          false,
          args,
          unresolved
        );
        inspected = true;
      }
    }
    return inspected;
  }

  observeDirectParameterDelivery(
    callee: NodePath<t.Node>,
    call: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >,
    inspect: (fn: NodePath<t.Function>, args: InvocationArguments) => void
  ) {
    if (!callee.isIdentifier() || crossesWithEnvironment(callee)) return;
    const fn = this.localCallable(callee, new Set());
    // An ordinary named declaration has a stable, initialized function
    // value here. Other direct callees use their existing origin proof.
    if (
      !fn?.isFunctionDeclaration() ||
      fn.node.async ||
      fn.node.generator ||
      !fn
        .get("params")
        .some((parameter) => bindingPatternReadsSource(parameter.node))
    )
      return;
    const args = this.observedInvocation(call);
    if (!args) return;
    const evaluatesDefault = fn.get("params").some((parameter, index) => {
      const incoming = args[index];
      return (
        parameter.isAssignmentPattern() &&
        bindingPatternReadsSource(parameter.node) &&
        (!incoming || incoming.definitelyUndefined)
      );
    });
    if (!evaluatesDefault) {
      inspect(fn, args);
      return;
    }
    const previous = this.parameterOrigins;
    try {
      this.bindInvocationParameters(fn, args);
      inspect(fn, args);
    } finally {
      this.parameterOrigins = previous;
    }
  }

  inspectCapturedCall(
    origin: ObjectReference,
    path: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >,
    inspect: ReturnedEffectInspector,
    unresolved: (values: ObjectReference[]) => void
  ): void {
    const callee = child(path, "callee");
    if (isProvablyUnexecuted(path)) return;
    const fn = callee.isIdentifier()
      ? this.localCallable(callee, new Set())
      : path.isCallExpression() &&
          (callee.isArrowFunctionExpression() || callee.isFunctionExpression())
        ? callee
        : undefined;
    if (
      fn?.findParent((parent) => parent.node === origin.owner?.node) &&
      (!path.isNewExpression() ||
        (callee.isIdentifier() &&
          fn.isFunctionDeclaration() &&
          callee.scope.getBinding(callee.node.name)?.path === fn)) &&
      !fn.node.async &&
      !fn.node.generator &&
      fn.node.params.every((parameter) => !t.isRestElement(parameter))
    ) {
      // Inspect a closed local call for writes to its lexical captures. Bare
      // argument aliases still go through the existing argument escape check.
      this.inspectReturnedEffect(
        origin,
        fn,
        inspect,
        path.isNewExpression() ? "fresh" : false,
        this.observedInvocation(path),
        unresolved
      );
      return;
    }
    // Only the invoked value's anchored captures can stop extraction. Unknown
    // functions with no link to the selected rule do not contaminate it.
    if (callee.isIdentifier()) unresolved(this.resolve(callee));
  }

  private returnedReceiver(path: NodePath<t.ThisExpression>) {
    for (
      let child: NodePath = path;
      child.parentPath;
      child = child.parentPath
    ) {
      const parent = child.parentPath;
      if (parent.isFunction() && !parent.isArrowFunctionExpression()) {
        if (parent.isObjectMethod() && child.key === "key") continue;
        return this.returnedEffectReceivers.get(parent.node);
      }
      if (
        parent.isStaticBlock() ||
        ((parent.isClassProperty() ||
          parent.isClassPrivateProperty() ||
          parent.isClassAccessorProperty()) &&
          child.key === "value")
      )
        return;
    }
  }

  private ownReturnedMethod(origin: ObjectReference, name: string) {
    if (!origin.path.isObjectExpression() || !origin.parameterFrame) return;
    const selected = selectObjectLiteralMember(origin.path.node, name, true);
    if (
      selected.kind !== "property" ||
      !t.isObjectMethod(selected.property, { kind: "method" })
    )
      return;
    const member = child(origin.path, selected.path);
    return member.isObjectMethod({ kind: "method" }) ? member : undefined;
  }

  private returnedReceiverMethod(callee: NodePath<t.Node>) {
    if (!callee.isMemberExpression() && !callee.isOptionalMemberExpression())
      return;
    const object = child(callee, "object");
    const name = selectedMemberName(callee);
    if (!object.isThisExpression() || name === null) return;
    const receiver = this.returnedReceiver(object);
    if (!receiver) return;
    const method = this.ownReturnedMethod(receiver, name);
    return method ? { receiver, method } : undefined;
  }

  inspectDeliveredCall(
    call: NodePath<t.CallExpression | t.OptionalCallExpression>,
    receiver: ObjectReference,
    values: readonly ObjectReference[],
    inspect: ReturnedEffectInspector,
    unresolved: UnresolvedEffect
  ): void {
    const args = this.observedInvocation(call);
    for (const value of values)
      this.inspectObservedCallable(value, receiver, inspect, args, unresolved);
  }

  inspectStoredKeyConversion(
    values: readonly ObjectReference[],
    receiver: ObjectReference,
    inspect: ReturnedEffectInspector,
    unresolved: UnresolvedEffect
  ): void {
    for (const value of values)
      this.inspectObservedCallable(value, receiver, inspect, [], unresolved);
  }

  private inspectObservedCallable(
    value: ObjectReference,
    receiver: ObjectReference,
    inspect: ReturnedEffectInspector,
    argumentsInCaller: InvocationArguments | null | undefined,
    unresolved?: UnresolvedEffect
  ): void {
    if (!value.parameterFrame) return;
    if (value.uncertainty) {
      unresolved?.([value]);
    } else if (value.path.isFunction() && !value.path.node.generator) {
      this.inspectReturnedEffect(
        value,
        value.path,
        inspect,
        value.path.isArrowFunctionExpression() ? false : receiver,
        argumentsInCaller,
        unresolved
      );
    }
  }

  private freshOwnHookReceiver(
    origin: ObjectReference,
    operand: NodePath<t.Node>,
    symbol: NodePath<t.Identifier>
  ): boolean {
    if (
      crossesWithEnvironment(symbol) ||
      (operand.isIdentifier() && crossesWithEnvironment(operand))
    )
      return false;
    const program = operand.scope.getProgramParent().path;
    if (!program.isProgram({ sourceType: "module" })) return false;
    if (this.hasOpenPrimitiveHookScope === undefined) {
      let open = hasDynamicScope(program);
      if (!open)
        program.traverse({
          Identifier(path) {
            if (
              (path.node.name === "Symbol" &&
                !path.scope.getBinding("Symbol") &&
                isWriteTarget(path)) ||
              (path.isReferencedIdentifier({ name: "globalThis" }) &&
                !path.scope.getBinding("globalThis"))
            ) {
              open = true;
              path.stop();
            }
          }
        });
      this.hasOpenPrimitiveHookScope = open;
    }
    if (this.hasOpenPrimitiveHookScope) return false;
    const evidence = (this.primitiveHookEvidence ??=
      collectRuntimeSourceEvidence(program));
    if (
      !evidence.bindingsCurrent ||
      evidence.hasGlobalEval ||
      evidence.writesScriptGlobal("Symbol") ||
      evidence.shadowsScriptGlobal("Symbol") ||
      evidence.mayHaveUnmodeledShadow(symbol.scope, "Symbol")
    )
      return false;
    if (origin.path.node === operand.node) return true;
    if (!operand.isIdentifier()) return false;
    const binding = operand.scope.getBinding(operand.node.name);
    if (
      !binding?.constant ||
      binding.kind !== "const" ||
      !binding.path.isVariableDeclarator() ||
      binding.path.node.init !== origin.path.node ||
      evidence.isExported(binding) ||
      evidence.mayHaveUnmodeledShadow(
        operand.scope,
        operand.node.name,
        binding.scope
      )
    )
      return false;
    const uses = evidence.references(binding);
    const declaration = binding.path.parentPath;
    const read = operand.getStatementParent();
    // Exactly one source read, in the same straight-line statement list.
    // A receiver handed to anything else may lose or change the own hook.
    return (
      uses.length === 1 &&
      uses[0]?.node === operand.node &&
      !!read &&
      declaration.parentPath === read.parentPath &&
      typeof declaration.key === "number" &&
      typeof read.key === "number" &&
      declaration.key < read.key
    );
  }

  private plainSpreadHook(
    spread: NodePath<t.SpreadElement>,
    hook: "iterator" | "asyncIterator"
  ): NodePath<t.ObjectProperty> | null | undefined {
    const source = spread.get("argument");
    if (!source.isObjectExpression()) return;
    let selected: NodePath<t.ObjectProperty> | null = null;
    for (const property of source.get("properties")) {
      this.visit();
      // CopyDataProperties reads accessors in the source frame, and a
      // nested/unknown spread has its own selection. Neither is modeled here.
      if (!property.isObjectProperty()) return;
      if (
        property.node.computed &&
        wellKnownSymbolOperand(property.get("key"), hook)
      ) {
        selected = property;
      } else if (propertyName(property.node) === null) return;
    }
    return selected;
  }

  inspectOwnSymbolHook(
    values: readonly ObjectReference[],
    operand: NodePath<t.Node>,
    counterpartSettled: boolean,
    inspect: ReturnedEffectInspector,
    unresolved: UnresolvedEffect,
    hook: "toPrimitive" | "iterator" | "asyncIterator" = "toPrimitive"
  ): ObjectReference[] {
    const iterator = hook !== "toPrimitive";
    return values.filter((origin) => {
      if (!origin.path.isObjectExpression() || origin.uncertainty) return true;
      let newerSetter = false;
      let openOwnSlot = false;
      for (const authored of origin.path.get("properties").reverse()) {
        this.visit();
        let property = authored;
        if (authored.isSpreadElement()) {
          const copied =
            hook !== "toPrimitive"
              ? this.plainSpreadHook(authored, hook)
              : undefined;
          if (copied === undefined) openOwnSlot = true;
          if (!copied) continue;
          property = copied;
        }
        if (
          (!property.isObjectProperty() && !property.isObjectMethod()) ||
          !property.node.computed
        )
          continue;
        const key = property.get("key") as NodePath<t.Node>;
        const symbol = wellKnownSymbolOperand(key, hook);
        if (!symbol) {
          if (propertyName(property.node) === null) openOwnSlot = true;
          continue;
        }
        const method = property.isObjectMethod() ? property : undefined;
        const kind = method?.node.kind;
        if (kind === "set") {
          newerSetter = true;
          continue;
        }
        if (newerSetter && kind !== "get") return true;
        const data = !method ? child(property, "value") : undefined;
        // The exact own hook is still evaluated and inspected. The fallback
        // can only be omitted when GetMethod cannot produce a nullish result
        // for this fresh receiver and the other operand has no user effects.
        this.inReferenceFrame(origin, () => {
          const values = data
            ? this.resolve(data)
            : kind === "method"
              ? [{ ...origin, path: method! }]
              : this.getterReturns(method!, new Set(), [origin]);
          if (method && kind === "get")
            this.inspectReturnedEffect(
              origin,
              method,
              inspect,
              true,
              [],
              unresolved
            );
          for (const value of values) {
            const callable = value.parameterFrame
              ? value
              : { ...origin, ...value };
            if (
              iterator &&
              callable.path.isFunction() &&
              (callable.path.node.generator || hook === "asyncIterator")
            ) {
              // Spreading consumes the generator, not merely calls it.
              unresolved([callable]);
              continue;
            }
            const inspectHook: ReturnedEffectInspector = iterator
              ? (fn, frame, skippedDefaults) => {
                  inspect(fn, frame, skippedDefaults);
                  // Delivery also consumes the returned iterator, not just
                  // its factory. Unproved effects still need a relevant origin.
                  unresolved(
                    this.returnedValues(fn, new Set([fn.node])).map((value) =>
                      value.parameterFrame ? value : { ...frame, ...value }
                    )
                  );
                }
              : inspect;
            if (
              iterator &&
              !callable.parameterFrame &&
              callable.path.isFunction()
            ) {
              if (
                hook === "iterator" &&
                (kind === "method" ||
                  data?.isArrowFunctionExpression() ||
                  data?.isFunctionExpression()) &&
                !callable.path.node.async &&
                authored === property &&
                !openOwnSlot &&
                this.freshOwnHookReceiver(origin, operand, symbol)
              )
                this.inspectReturnedEffect(
                  origin,
                  callable.path,
                  inspectHook,
                  !callable.path.isArrowFunctionExpression(),
                  [],
                  unresolved
                );
              else unresolved([origin, callable]);
            } else {
              this.inspectObservedCallable(
                callable,
                origin,
                inspectHook,
                iterator ? [] : [{ origins: [], definitelyDefined: true }],
                unresolved
              );
            }
          }
        });
        if (iterator) {
          // A nullish async hook falls back to the synchronous protocol.
          // Only settle its selection when the own callable is still known.
          return (
            hook === "asyncIterator" &&
            !(
              // Origin lists omit primitive/nullish values and therefore
              // cannot prove a getter or computed factory always supplies a
              // method. Only a definite lexical function slot can settle it.
              (kind === "method" ||
                data?.isFunctionExpression() ||
                data?.isArrowFunctionExpression()) &&
              !authored.isSpreadElement() &&
              !openOwnSlot &&
              this.freshOwnHookReceiver(origin, operand, symbol)
            )
          );
        }
        const definiteCallable =
          (kind === "method" &&
            method &&
            !method.node.async &&
            !method.node.generator) ||
          ((data?.isFunctionExpression() ||
            data?.isArrowFunctionExpression()) &&
            !data.node.async &&
            !data.node.generator);
        return !(
          counterpartSettled &&
          definiteCallable &&
          !openOwnSlot &&
          this.freshOwnHookReceiver(origin, operand, symbol)
        );
      }
      return true;
    });
  }

  equalityCounterpart(
    value: NodePath<t.Node>,
    facts: ReturnType<typeof branchEvaluationFacts>
  ): "primitive" | "does-not-convert" | "unknown" {
    const seen = new Set<t.Node>();
    for (let source = value; !seen.has(source.node);) {
      seen.add(source.node);
      const scalar = this.literalScalar(source);
      if (scalar && !(source.isIdentifier() && crossesWithEnvironment(source)))
        return scalar.value == null ? "does-not-convert" : "primitive";
      if (source.isBigIntLiteral()) return "primitive";
      if (
        source.isObjectExpression() ||
        source.isArrayExpression() ||
        source.isFunction() ||
        source.isClassExpression() ||
        source.isRegExpLiteral() ||
        source.isUnaryExpression({ operator: "void" })
      )
        return "does-not-convert";
      if (!source.isIdentifier()) break;
      const init = facts.initializedConst(source);
      if (!init) break;
      source = init;
    }
    return "unknown";
  }

  inspectPropertyKeyHooks(
    values: ObjectReference[],
    operand: NodePath<t.Node>,
    canSettleFreshReceiver: boolean,
    inspect: ReturnedEffectInspector,
    unresolved: UnresolvedEffect
  ): void {
    for (const origin of values) {
      if (origin.uncertainty) {
        if (origin.parameterFrame) unresolved([origin]);
        continue;
      }
      // These calls have no arguments and receive the actual key object.
      // Existing member dispatch supplies captures, getters, and own slots.
      this.inspectReturnedMember(
        [origin],
        "toString",
        "method",
        inspect,
        unresolved,
        undefined,
        []
      );
      const own = origin.path.isObjectExpression()
        ? selectObjectLiteralMember(origin.path.node, "toString", true)
        : undefined;
      // Only an exact unescaped inline receiver can rule out a replacement.
      // A simple primitive-returning method settles the string-first order
      // after its effects (or abrupt completion); other bodies stay possible.
      if (
        canSettleFreshReceiver &&
        origin.path.node === operand.node &&
        own?.kind === "property" &&
        t.isObjectMethod(own.property, { kind: "method" }) &&
        !own.property.async &&
        !own.property.generator &&
        own.property.body.body.length === 1 &&
        t.isReturnStatement(own.property.body.body[0]) &&
        !!own.property.body.body[0].argument &&
        isSupportedStaticCssPrimitiveLiteral(
          unwrapTransparentCssRuleExpression(own.property.body.body[0].argument)
        )
      )
        continue;

      this.inspectReturnedMember(
        [origin],
        "valueOf",
        "method",
        inspect,
        unresolved,
        undefined,
        []
      );
    }
  }

  inspectOwnGetters(
    origins: readonly ObjectReference[],
    inspect: ReturnedEffectInspector,
    unresolved: UnresolvedEffect,
    selectedName?: string,
    excludedNames?: ReadonlySet<string>
  ): void {
    for (const origin of origins) {
      if (origin.uncertainty) {
        if (origin.parameterFrame) unresolved([origin]);
        continue;
      }
      if (!origin.path.isObjectExpression()) continue;
      const seen = new Set<string>();
      for (const getter of origin.path.get("properties").reverse()) {
        this.visit();
        if (!getter.isObjectMethod({ kind: "get" })) continue;
        const name = propertyName(getter.node);
        if (name === null) {
          unresolved([{ ...origin, path: getter }]);
          continue;
        }
        if (
          (selectedName !== undefined && selectedName !== name) ||
          excludedNames?.has(name) ||
          seen.has(name)
        )
          continue;
        seen.add(name);
        // The shared descriptor selector walks the source slots again for
        // each name. Charge that pass to the existing analysis budget.
        this.visit(origin.path.node.properties.length);
        const selected = selectObjectLiteralMember(
          origin.path.node,
          name,
          true
        );
        if (selected.kind === "unknown") {
          unresolved([{ ...origin, path: getter }]);
        } else if (
          selected.kind === "property" &&
          selected.property === getter.node
        ) {
          // Both an own selected member read and CopyDataProperties call
          // the actual getter with its source receiver, not a data method.
          this.inspectReturnedEffect(
            origin,
            getter,
            inspect,
            true,
            [],
            unresolved
          );
        }
      }
    }
  }

  inspectReturnedMember(
    origins: readonly ObjectReference[],
    name: string | null,
    operation: "method" | "set" | "construct",
    inspect: ReturnedEffectInspector,
    unresolved?: UnresolvedEffect,
    site?: NodePath<
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.AssignmentExpression
      | t.ForOfStatement
    >,
    knownArguments?: InvocationArguments | null,
    inspectUnframedArgument?: (
      fn: NodePath<t.Function>,
      incoming: InvocationArguments
    ) => void
  ): void {
    const readsMember = operation !== "set";
    let observed: InvocationArguments | null | undefined = knownArguments;
    let unexecuted: boolean | undefined;
    const liveCall = () =>
      !site || !(unexecuted ??= isProvablyUnexecuted(site));
    const argumentsInCaller = () => {
      if (observed === undefined && site) {
        if (site.isAssignmentExpression())
          observed = this.observeArguments([site.get("right")]);
        else if (
          site.isCallExpression() ||
          site.isOptionalCallExpression() ||
          site.isNewExpression()
        )
          observed = this.observedInvocation(site);
      }
      return observed;
    };
    for (const origin of origins) {
      if (origin.path.isArrayExpression()) {
        if (
          operation === "method" &&
          (name === null || /^(?:0|[1-9][0-9]*)$/.test(name)) &&
          liveCall()
        ) {
          for (const value of this.select([origin], name, new Set(), true))
            this.inspectObservedCallable(
              value,
              origin,
              inspect,
              argumentsInCaller(),
              unresolved
            );
        }
        continue;
      }
      if (!origin.path.isObjectExpression()) continue;
      if (!origin.parameterFrame && operation === "method" && name !== null) {
        // The selected callable can carry a different lexical frame from
        // its holder, whether copied via spread or stored as a data value.
        if (!liveCall()) return;
        for (const value of this.select([origin], name, new Set(), true)) {
          if (value.parameterFrame) {
            this.inspectObservedCallable(
              value,
              origin,
              inspect,
              argumentsInCaller(),
              unresolved
            );
          } else if (
            inspectUnframedArgument &&
            value.path.isObjectMethod({ kind: "method" }) &&
            value.path.parentPath.node === origin.path.node &&
            !value.path.node.async &&
            !value.path.node.generator &&
            value.path
              .get("params")
              .some((parameter) => bindingPatternReadsSource(parameter.node))
          ) {
            // The receiver can be an ordinary local literal with no saved
            // frame, while the selected incoming argument carries one.
            const incoming = argumentsInCaller();
            if (incoming) inspectUnframedArgument(value.path, incoming);
          }
        }
      }
      if (!origin.parameterFrame) continue;
      // A later operation can replace a key without proving it absent at
      // this site. Inspect an own candidate only if the current selection
      // could reach it; an unknown key admits each non-shadowed candidate.
      const shadowed = new Set<string>();
      const pairedGetter = new Set<string>();
      for (const property of origin.path.get("properties").reverse()) {
        this.visit();
        if (!property.isObjectProperty() && !property.isObjectMethod())
          continue;
        // A literal prototype directive does not define an own member.
        if (isObjectPrototypeSetter(property.node)) continue;
        const key = propertyName(property.node);
        if (
          key !== null &&
          (shadowed.has(key) || (name !== null && key !== name))
        )
          continue;
        const method = property.isObjectMethod() ? property : undefined;
        const kind = method?.node.kind;
        // A getter pairs with a setter, but neither accessor pairs with a
        // data method. Definite later definitions shadow earlier candidates.
        if (operation === "set" && kind === "get") continue;
        if (readsMember && kind === "set") {
          if (key !== null) pairedGetter.add(key);
          continue;
        }
        // A newer setter can pair with an older getter, not with older data.
        const hiddenData =
          key !== null && pairedGetter.has(key) && kind !== "get";
        if (!hiddenData && method && kind === operation) {
          if (!liveCall()) return;
          this.inspectReturnedEffect(
            origin,
            method,
            inspect,
            true,
            argumentsInCaller(),
            unresolved
          );
        } else if (
          readsMember &&
          !hiddenData &&
          (property.isObjectProperty() || kind === "get")
        ) {
          if (!liveCall()) return;
          const args = argumentsInCaller();
          // A call reads this selected slot before invoking the result. Only
          // that accessor/value, not other holder members, can veto this call.
          if (method)
            this.inspectReturnedEffect(
              origin,
              method,
              inspect,
              true,
              [],
              unresolved
            );
          this.inReferenceFrame(origin, () => {
            const results = method
              ? this.getterReturns(method, new Set(), [origin])
              : this.resolve(child(property, "value"));
            for (const value of results) {
              if (value.uncertainty) {
                unresolved?.([value]);
              } else if (value.path.isFunction()) {
                // A member read may invoke a getter on its owner, but a
                // constructed function never uses that holder as its receiver.
                if (
                  operation === "construct" &&
                  ((!value.path.isFunctionExpression() &&
                    !value.path.isFunctionDeclaration()) ||
                    value.path.node.async ||
                    value.path.node.generator)
                )
                  continue;
                // Calling a generator only constructs an iterator. Default
                // evaluation and later resumption are not this body proof.
                if (value.path.node.generator) {
                  if (
                    value.path.node.params.some(
                      (parameter) => !t.isIdentifier(parameter)
                    )
                  )
                    unresolved?.([value]);
                  continue;
                }
                const frame = value.parameterFrame
                  ? {
                      ...origin,
                      parameterFrame: new Map([
                        ...origin.parameterFrame!,
                        ...value.parameterFrame
                      ])
                    }
                  : origin;
                this.inspectReturnedEffect(
                  frame,
                  value.path,
                  inspect,
                  operation === "construct"
                    ? "fresh"
                    : !value.path.isArrowFunctionExpression(),
                  args,
                  unresolved
                );
              }
            }
          });
        }
        if (key !== null) shadowed.add(key);
        if (key !== null && name !== null) break;
      }
    }
  }

  private inspectReturnedEffect(
    origin: ObjectReference,
    fn: NodePath<t.Function>,
    inspect: ReturnedEffectInspector,
    receiver: boolean | "fresh" | ObjectReference = false,
    argumentsInCaller?: InvocationArguments | null,
    unresolved?: UnresolvedEffect
  ): void {
    if (origin.uncertainty) return;
    const identity = this.identity(origin);
    const active = this.activeReturnedEffects.get(identity) ?? new Set();
    if (
      argumentsInCaller === null ||
      active.has(fn.node) ||
      (argumentsInCaller !== undefined &&
        fn.node.params.some((parameter) => t.isRestElement(parameter)))
    ) {
      this.inReferenceFrame(origin, () =>
        unresolved?.([
          { ...origin, path: fn },
          ...(argumentsInCaller ?? []).flatMap((argument) => argument.origins)
        ])
      );
      return;
    }
    active.add(fn.node);
    this.activeReturnedEffects.set(identity, active);
    const previous = this.returnedEffectReceivers.get(fn.node);
    if (receiver === "fresh") this.returnedEffectReceivers.delete(fn.node);
    else if (receiver)
      this.returnedEffectReceivers.set(
        fn.node,
        receiver === true ? origin : receiver
      );
    try {
      this.inReferenceFrame(origin, () => {
        const skippedDefaults = argumentsInCaller
          ? this.bindInvocationParameters(fn, argumentsInCaller)
          : undefined;
        inspect(
          fn,
          {
            ...origin,
            parameterFrame: new Map(this.parameterOrigins)
          },
          skippedDefaults,
          argumentsInCaller
        );
      });
    } finally {
      if (receiver) {
        if (previous) this.returnedEffectReceivers.set(fn.node, previous);
        else this.returnedEffectReceivers.delete(fn.node);
      }
      active.delete(fn.node);
      if (active.size === 0) this.activeReturnedEffects.delete(identity);
    }
  }

  countEffectNode(): void {
    this.visit();
  }

  isEffectFreeLocalCall(
    path: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >
  ): boolean {
    if (!path.isCallExpression() && !path.isOptionalCallExpression())
      return false;
    const call: NodePath<t.CallExpression | t.OptionalCallExpression> = path;
    const proof =
      this.originOptions.callResultProofs?.get(call.node) ??
      this.originOptions.callResultProof?.(call);
    if (proof?.kind === "identity-array-map" && isIdentityArrayMapCall(call))
      return true;
    if (
      proof?.kind === "primitive" &&
      proof.readOnlyInvocation === "array-includes" &&
      isDenseArrayIncludesCall(call)
    )
      return true;
    const fn = this.localCallable(child(path, "callee"), new Set());
    if (
      !fn ||
      fn.node.async ||
      fn.node.generator ||
      fn.get("params").some((parameter) => !parameter.isIdentifier())
    )
      return false;
    const inert = (value: NodePath<t.Node>): boolean => {
      this.visit();
      if (value.isIdentifier() || value.isLiteral() || value.isFunction())
        return true;
      if (value.isObjectExpression())
        return value
          .get("properties")
          .every((property) =>
            property.isObjectMethod()
              ? !property.node.computed
              : property.isObjectProperty() &&
                !property.node.computed &&
                inert(property.get("value"))
          );
      if (value.isArrayExpression())
        return value
          .get("elements")
          .every(
            (element) => !element.node || inert(element as NodePath<t.Node>)
          );
      return false;
    };
    const body = fn.get("body");
    if (!body.isBlockStatement()) return inert(body);
    const statements = body.get("body");
    return (
      statements.length === 1 &&
      statements[0].isReturnStatement() &&
      (!statements[0].node.argument ||
        inert(statements[0].get("argument") as NodePath<t.Node>))
    );
  }

  binding(
    binding: Binding,
    seen = new Set<t.Node>(),
    use?: NodePath<t.Identifier>,
    orderedInvocation = false
  ): ObjectReference[] {
    this.visit();

    const substituted = this.parameterOrigins.get(binding);
    const declaration = binding.path;
    let violations = binding.constantViolations;
    let entry = substituted;
    let replacedInitializer = false;
    if (substituted && violations.length === 0) return substituted;
    if (substituted || orderedInvocation) {
      // The initializer/actual argument is the entry state, not necessarily
      // the live value at the invocation. Only same-body, direct writes
      // prove the order; other possible writes augment the entry.
      const owner = declaration.getFunctionParent();
      const statement =
        use && use.getFunctionParent() === owner
          ? use.findParent((parent) => parent.isStatement())
          : undefined;
      const body = statement?.parentPath;
      const index = statement?.key;
      const straightBody = owner
        ? body?.isBlockStatement() &&
          body.key === "body" &&
          body.parentPath === owner
        : orderedInvocation && body?.isProgram();
      const declarationStatement = declaration.parentPath;
      const afterDeclaration =
        substituted ||
        (declarationStatement?.parentPath === body &&
          typeof declarationStatement?.key === "number" &&
          typeof index === "number" &&
          declarationStatement.key < index);
      const ordered = new Map<t.Node, number>();
      let latest: number | undefined;
      violations = violations.filter((violation) => {
        if (isProvablyUnexecuted(violation)) return false;
        if (
          !violation.isAssignmentExpression({ operator: "=" }) ||
          !violation
            .get("left")
            .isIdentifier({ name: binding.identifier.name }) ||
          !straightBody ||
          !afterDeclaration ||
          typeof index !== "number"
        )
          return true;
        const write = violation.parentPath;
        if (
          !write.isExpressionStatement() ||
          write.parentPath !== body ||
          typeof write.key !== "number"
        )
          return true;
        // A hoisted var can be assigned before its declaration. An authored
        // initializer then overwrites that assignment, not the other way around.
        if (
          !substituted &&
          declaration.isVariableDeclarator() &&
          declaration.node.init &&
          typeof declarationStatement?.key === "number" &&
          write.key < declarationStatement.key
        )
          return false;
        if (write.key >= index)
          return (
            write.key === index &&
            !use?.findParent((parent) => parent === violation)
          );
        ordered.set(violation.node, write.key);
        if (latest === undefined || write.key > latest) latest = write.key;
        return true;
      });
      const latestIndex = latest;
      if (latestIndex !== undefined) {
        entry = [];
        replacedInitializer = !substituted;
        violations = violations.filter(
          (violation) =>
            (ordered.get(violation.node) ?? latestIndex) >= latestIndex
        );
      }
    }
    const values: ObjectReference[] = [...(entry ?? [])];

    if (
      declaration.isImportSpecifier() ||
      declaration.isImportDefaultSpecifier() ||
      declaration.isImportNamespaceSpecifier()
    )
      return [
        {
          path: declaration,
          provedIdentity: this.originOptions.moduleOriginIdentity
        }
      ];

    if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration())
      values.push({ path: declaration });

    if (declaration.isVariableDeclarator() && !replacedInitializer) {
      const iteration = declaration.parentPath.parentPath;
      const initial =
        !declaration.node.init && iteration?.isForOfStatement()
          ? this.select(this.resolve(iteration.get("right"), seen), null, seen)
          : this.resolve(declaration.get("init"), seen);

      values.push(
        ...this.pattern(
          declaration.get("id"),
          binding.identifier.name,
          initial,
          seen
        )
      );
    }

    for (const violation of violations) {
      if (violation.isAssignmentExpression()) {
        values.push(
          ...this.pattern(
            violation.get("left"),
            binding.identifier.name,
            this.resolve(violation.get("right"), seen),
            seen
          )
        );
      } else if (violation.isForOfStatement()) {
        values.push(
          ...this.pattern(
            violation.get("left"),
            binding.identifier.name,
            this.select(this.resolve(violation.get("right"), seen), null, seen),
            seen
          )
        );
      }
    }

    return values;
  }

  storedValues(
    pattern: NodePath<t.Node>,
    value: NodePath<t.Expression>,
    member?: t.MemberExpression
  ): ObjectReference[] {
    return this.pattern(
      pattern,
      undefined,
      this.resolve(value),
      new Set(),
      member
    );
  }

  observeAssignedArgument(
    assignment: NodePath<t.AssignmentExpression>,
    member: NodePath<t.MemberExpression>
  ): InvocationArguments | null {
    // For fixed array slots, reuse the caller argument/default binder on
    // the same value selected by the assignment pattern. Other patterns lack
    // a definedness proof here and stay conservative at the live setter.
    const slots: number[] = [];
    let target: NodePath<t.Node> = member;
    const pattern = assignment.get("left");
    while (target.node !== pattern.node) {
      this.visit();
      if (
        !target.parentPath?.isArrayPattern() ||
        typeof target.key !== "number"
      )
        return null;
      slots.push(target.key);
      target = target.parentPath;
    }
    let value: NodePath<t.Node | null | undefined> = assignment.get("right");
    for (const index of slots.reverse()) {
      this.visit();
      if (!value.isArrayExpression()) return null;
      const elements = value.get("elements");
      if (elements.slice(0, index + 1).some((item) => item.isSpreadElement()))
        return null;
      const element = elements[index];
      if (!element?.node) return null;
      value = element;
    }
    return this.hasNativeDelivery(assignment)
      ? this.observeArguments([value as NodePath<t.Node>])
      : null;
  }

  private hasNativeDelivery(site: NodePath<t.Node>): boolean {
    const realm = (site.scope.getProgramParent() as ProgramScope).minchoData
      ?.extractCalls?.arrayMapIntrinsics;
    // Prepared graph evidence can withdraw the local native-iteration premise,
    // never replace the check of the current program.
    if ((realm?.iterationIntact ?? realm?.intact) === false) return false;
    if (this.assignmentIterationIsIntact === undefined) {
      const program = site.findParent((parent) => parent.isProgram());
      const environment = createArrayMapIntrinsicEnvironment();
      if (program?.isProgram()) environment.observe(program);
      this.assignmentIterationIsIntact =
        program?.isProgram() === true && environment.snapshot().iterationIntact;
    }
    return this.assignmentIterationIsIntact;
  }

  observeArrayPatternSlot(
    site: NodePath<t.Node>,
    values: ObjectReference[],
    index: number
  ): ObjectReference[] | null {
    if (
      !this.hasNativeDelivery(site) ||
      !values.every(
        (origin) =>
          !origin.uncertainty &&
          (origin.arrayElements !== undefined ||
            (origin.path.isArrayExpression() &&
              origin.path
                .get("elements")
                .slice(0, index + 1)
                .every((element) => !element.isSpreadElement())))
      )
    )
      return null;
    return this.select(values, String(index));
  }

  observeLoopArguments(value: NodePath<t.Node>): InvocationArguments[] | null {
    if (!value.isArrayExpression() || !this.hasNativeDelivery(value))
      return null;
    const elements = value.get("elements");
    const deliveries: InvocationArguments[] = [];
    for (const element of elements) {
      this.visit();
      if (!element.isExpression()) return null;
      deliveries.push(this.observeArguments([element]));
    }
    return deliveries;
  }

  private pattern(
    pattern: NodePath<t.Node>,
    name: string | undefined,
    values: ObjectReference[],
    seen: Set<t.Node>,
    member?: t.MemberExpression,
    invocation?: { source?: NodePath<t.Node> }
  ): ObjectReference[] {
    this.visit();

    if (pattern.isIdentifier()) return pattern.node.name === name ? values : [];
    if (pattern.isMemberExpression())
      return name === undefined && (!member || pattern.node === member)
        ? values
        : [];
    if (pattern.isAssignmentPattern()) {
      const target = pattern.get("left");
      if (this.originOptions.skippedPatternDefaults?.has(pattern.node))
        return this.pattern(target, name, values, seen, member, invocation);
      const fallback = pattern.get("right");
      const defaultValues = this.resolve(fallback, seen);
      if (invocation) {
        // The incoming delivery and selected literal default are separate
        // origins. A default does not inherit an opaque argument's transport.
        return [
          ...this.pattern(target, name, values, seen, member, invocation),
          ...this.pattern(target, name, defaultValues, seen, member, {
            source: fallback
          })
        ];
      }
      return this.pattern(
        target,
        name,
        [...values, ...defaultValues],
        seen,
        member
      );
    }

    if (pattern.isRestElement()) {
      const parent = pattern.parentPath;
      const excluded = new Set<string>();

      if (parent.isObjectPattern()) {
        for (const property of parent.node.properties) {
          if (t.isObjectProperty(property)) {
            const key = propertyName(property);

            if (key !== null) excluded.add(key);
          }
        }
      }

      // Rest creates a shallow copy: its own writes do not affect the source,
      // while references in the retained properties remain shared.
      const copy: ObjectReference = {
        path: pattern,
        rest: {
          sources: values,
          excluded,
          offset: parent.isArrayPattern()
            ? parent.node.elements.indexOf(pattern.node)
            : undefined
        }
      };

      return this.pattern(
        pattern.get("argument"),
        name,
        [copy],
        seen,
        member,
        invocation && {}
      );
    }

    if (pattern.isArrayPattern()) {
      const source = invocation?.source;
      const elements =
        source?.isArrayExpression() && this.hasNativeDelivery(source)
          ? source.get("elements")
          : undefined;
      if (
        invocation &&
        (!elements || elements.some((element) => !element.isExpression()))
      ) {
        // Parameter iteration can deliver a different value than a numeric
        // property. Keep that uncertainty linked to the actual input, so a
        // later write only vetoes rules the active argument can reach.
        return name &&
          Object.hasOwn(t.getBindingIdentifiers(pattern.node), name)
          ? values.map((value) => ({
              ...value,
              uncertainty: value.uncertainty ?? {
                reason: "unsupported-origin",
                path: pattern
              }
            }))
          : [];
      }
      return pattern.get("elements").flatMap((element, index) =>
        element.node
          ? this.pattern(
              element as NodePath<t.Node>,
              name,
              element.isRestElement()
                ? values
                : this.select(values, String(index), seen),
              seen,
              member,
              invocation && {
                source: elements?.[index] as NodePath<t.Node> | undefined
              }
            )
          : []
      );
    }
    if (pattern.isObjectPattern()) {
      return pattern.get("properties").flatMap((property) => {
        if (property.isRestElement())
          return this.pattern(
            property,
            name,
            values,
            seen,
            member,
            invocation && {}
          );
        if (!property.isObjectProperty()) return [];

        return this.pattern(
          property.get("value"),
          name,
          this.select(values, propertyName(property.node), seen),
          seen,
          member,
          invocation && {}
        );
      });
    }

    return [];
  }

  select(
    objects: ObjectReference[],
    name: string | null,
    seen = new Set<t.Node>(),
    ownOnly = false,
    receiver?: ObjectReference[]
  ): ObjectReference[] {
    return this.selectProperties(
      objects,
      (key) => name === null || key === null || key === name,
      seen,
      ownOnly,
      name,
      receiver
    );
  }

  private selectProperties(
    objects: ObjectReference[],
    accepts: (key: string | null) => boolean,
    seen: Set<t.Node>,
    ownOnly = false,
    name?: string | null,
    receiver?: ObjectReference[]
  ): ObjectReference[] {
    return objects.flatMap((reference) =>
      this.inReferenceFrame(reference, () => {
        this.visit();

        const object = reference.path;
        if (reference.uncertainty) return [reference];
        if (reference.modulePrimitivePaths && name !== undefined) {
          if (
            name !== null &&
            reference.modulePrimitivePaths.some(
              (path) => path.length === 1 && path[0] === name
            )
          )
            return [];
          return [
            {
              ...reference,
              modulePrimitivePaths:
                name === null
                  ? undefined
                  : reference.modulePrimitivePaths
                      .filter((path) => path[0] === name)
                      .map((path) => path.slice(1))
            }
          ];
        }
        if (reference.ownShape) {
          const shape = reference.ownShape;
          const entries =
            shape.kind === "object"
              ? Object.entries(shape.properties)
              : shape.kind === "array"
                ? shape.elements.map(
                    (value, index) => [String(index), value] as const
                  )
                : [];
          // Only internal own enumeration omits a key. An actual unknown key
          // may read a shared prototype, even for a fresh own allocation.
          if (
            name === null ||
            (name !== undefined && !entries.some(([key]) => key === name))
          )
            return [
              {
                ...reference,
                uncertainty: { reason: "unsupported-origin", path: object }
              }
            ];
          return entries.flatMap(([key, value]): ObjectReference[] => {
            if (!accepts(key)) return [];
            // Partial own-field metadata cannot turn a missing shape into a primitive.
            if (!value)
              return [
                {
                  ...reference,
                  uncertainty: { reason: "unsupported-origin", path: object }
                }
              ];
            return value.kind !== "primitive"
              ? [{ ...reference, ownShape: value }]
              : [];
          });
        }
        if (reference.arrayElements)
          return reference.arrayElements.flatMap((elements, index) =>
            elements && accepts(String(index))
              ? elements.map((element) =>
                  reference.call && reference.owner
                    ? this.atCall(element, reference.call, reference.owner)
                    : element
                )
              : []
          );
        const readReceiver = receiver ?? [reference];
        // Opaque contents, including callable prototypes, need not come from
        // object literals. Keep their identity when following nested aliases.
        if (
          object.isImportSpecifier() ||
          object.isImportDefaultSpecifier() ||
          object.isImportNamespaceSpecifier() ||
          object.isCallExpression() ||
          object.isOptionalCallExpression() ||
          object.isFunction() ||
          object.isClass() ||
          object.isNewExpression()
        )
          return [reference];
        if (seen.has(object.node)) return [];

        const next = new Set(seen).add(object.node);

        const inherit = (values: ObjectReference[]) =>
          reference.call && reference.owner
            ? values.map((value) =>
                this.atCall(value, reference.call!, reference.owner!)
              )
            : values;

        if (reference.rest) {
          const { sources, excluded, offset } = reference.rest;

          return inherit(
            this.selectProperties(
              sources,
              (key) => {
                if (key === null) return accepts(null);
                if (offset === undefined)
                  return !excluded.has(key) && accepts(key);

                const index = Number(key);

                return (
                  Number.isInteger(index) &&
                  index >= offset &&
                  String(index) === key &&
                  accepts(String(index - offset))
                );
              },
              next,
              true
            )
          );
        }

        if (object.isObjectExpression()) {
          if (name !== undefined && name !== null) {
            const selected = selectObjectLiteralMember(
              object.node,
              name,
              ownOnly
            );
            if (selected.kind === "missing") return [];
            if (selected.kind === "prototype") {
              const prototype = this.resolve(
                child(object, selected.path),
                next
              );
              // The inherited __proto__ accessor can expose this allocation;
              // this is a possible alias, not proof of an own data property.
              return inherit([
                ...(name === "__proto__" ? prototype : []),
                ...this.select(prototype, name, next, false, readReceiver)
              ]);
            }
            if (
              selected.kind === "property" &&
              !this.mayDelete(reference, name)
            ) {
              const property = child(object, selected.path);
              if (property.isObjectMethod({ kind: "get" }))
                return inherit(
                  this.getterReturns(
                    property,
                    next,
                    property.parentPath.node === object.node
                      ? readReceiver
                      : [
                          {
                            path: property.parentPath as NodePath<t.ObjectExpression>
                          }
                        ]
                  )
                );
              return inherit(
                property.isObjectProperty()
                  ? this.resolve(property.get("value"), next)
                  : property.isObjectMethod({ kind: "method" })
                    ? [{ path: property }]
                    : []
              );
            }
          }
          return inherit(
            object.get("properties").flatMap((property) => {
              this.visit();

              if (property.isSpreadElement())
                return this.selectProperties(
                  this.resolve(property.get("argument"), next),
                  accepts,
                  next,
                  true,
                  name
                );

              if (
                property.isObjectProperty() &&
                isObjectPrototypeSetter(property.node)
              ) {
                if (ownOnly) return [];
                const prototype = this.resolve(property.get("value"), next);
                return [
                  ...(name === null || name === "__proto__" ? prototype : []),
                  ...this.selectProperties(
                    prototype,
                    accepts,
                    next,
                    false,
                    name,
                    readReceiver
                  )
                ];
              }

              if (
                property.isObjectProperty() &&
                accepts(propertyName(property.node))
              )
                return this.resolve(property.get("value"), next);
              if (
                property.isObjectMethod({ kind: "method" }) &&
                accepts(propertyName(property.node))
              )
                return [{ path: property }];
              if (
                property.isObjectMethod({ kind: "get" }) &&
                accepts(propertyName(property.node))
              )
                return this.getterReturns(property, next, readReceiver);

              return [];
            })
          );
        }
        if (!object.isArrayExpression()) return [];

        let spread = false;

        return inherit(
          object.get("elements").flatMap((element, index) => {
            this.visit();

            if (element.isSpreadElement()) {
              spread = true;

              return this.select(
                this.resolve(element.get("argument"), next),
                null,
                next
              );
            }

            return element.node && accepts(spread ? null : String(index))
              ? this.resolve(element, next)
              : [];
          })
        );
      })
    );
  }

  // Getter selection returns its value, not the accessor function. Track
  // captured allocations without executing the body; receiver-dependent
  // returns remain unknown because this analysis has no getter call receiver.
  private getterReturns(
    getter: NodePath<t.ObjectMethod>,
    seen: Set<t.Node>,
    receiver: ObjectReference[]
  ): ObjectReference[] {
    const returned: ObjectReference[] = [];
    let unknownReceiver = false;
    const nested = new Set(seen).add(getter.node);
    getter.get("body").traverse({
      enter: () => this.visit(),
      Function(inner) {
        // Arrows share the getter's receiver, even when invoked via an IIFE.
        if (!inner.isArrowFunctionExpression()) inner.skip();
      },
      ThisExpression: () => {
        unknownReceiver = true;
      },
      Super: () => {
        unknownReceiver = true;
      },
      ReturnStatement: (statement) => {
        if (statement.getFunctionParent() === getter)
          returned.push(...this.resolve(statement.get("argument"), nested));
      }
    });
    return unknownReceiver
      ? [
          ...returned,
          ...receiver.map((value) => ({
            ...value,
            uncertainty: { reason: "getter-receiver" as const, path: getter }
          }))
        ]
      : returned;
  }

  readsImportedMember(
    objects: ObjectReference[],
    name: string | null,
    seen = new Set<t.Node>()
  ): ImportedOriginProof {
    return combineImportedOrigins(
      objects.map((reference): ImportedOriginProof => {
        this.visit();
        if (isImportedReference(reference)) return { kind: "imported" };
        const object = reference.path;
        if (reference.uncertainty)
          return { kind: "unknown", ...reference.uncertainty };
        if (reference.ownShape) {
          const selected = this.select([reference], name);
          const uncertainty = selected.find(
            (value) => value.uncertainty
          )?.uncertainty;
          return uncertainty
            ? { kind: "unknown", ...uncertainty }
            : { kind: "local" };
        }
        if (!object.isObjectExpression() || seen.has(object.node))
          return { kind: "local" };
        const next = new Set(seen).add(object.node);
        if (name !== null) {
          const selected = selectObjectLiteralMember(object.node, name);
          if (
            selected.kind === "missing" ||
            (selected.kind === "property" && !this.mayDelete(reference, name))
          )
            return { kind: "local" };
          if (selected.kind === "prototype")
            return this.readsImportedMember(
              this.resolve(child(object, selected.path), next),
              name,
              next
            );
        }
        return combineImportedOrigins(
          object
            .get("properties")
            .filter(
              (property) =>
                property.isObjectProperty() &&
                isObjectPrototypeSetter(property.node)
            )
            .map((property) =>
              this.readsImportedMember(
                this.resolve(child(property, "value"), next),
                name,
                next
              )
            )
        );
      })
    );
  }

  reachable(objects: ObjectReference[]): Set<object> {
    return this.reachability(objects).nodes;
  }

  reachability(objects: ObjectReference[]): {
    nodes: Set<object>;
    sourceNodes: Set<object>;
    unknowns: Map<object, OriginUncertainty>;
  } {
    const unknowns = new Map<object, OriginUncertainty>();
    const nodes = new Set<object>();
    const sourceNodes = new Set<object>();
    const capturedNodes = new Set<object>();
    const queue = objects.map((reference) => ({
      reference,
      captures: false,
      uncertainty: reference.uncertainty
    }));

    for (let index = 0; index < queue.length; index++) {
      this.visit();
      const { reference: object } = queue[index];
      const uncertainty = object.uncertainty ?? queue[index].uncertainty;
      const captures = queue[index].captures || uncertainty !== undefined;
      const identity = this.identity(object);
      if (nodes.has(identity) && (!captures || capturedNodes.has(identity)))
        continue;
      nodes.add(identity);
      if (
        !object.ownShape &&
        (object.path.isObjectExpression() || object.path.isArrayExpression())
      )
        sourceNodes.add(identity);
      if (uncertainty) unknowns.set(identity, uncertainty);
      if (captures) capturedNodes.add(identity);

      // An unproved receiver-dependent getter can call its receiver's methods.
      // Include those closures only for this uncertain result, not file-wide.
      if (captures && (object.path.isFunction() || object.path.isClass())) {
        const captured: NodePath<t.Node>[] = object.path.isFunction()
          ? planEvaluation(object.path).captures
          : [];
        if (object.path.isClass())
          object.path.traverse({
            ReferencedIdentifier: (path) => {
              this.visit();
              captured.push(path);
            }
          });
        for (const path of captured) {
          this.visit();
          queue.push(
            ...this.inReferenceFrame(object, () => this.resolve(path)).map(
              (reference) => ({
                reference,
                captures,
                uncertainty
              })
            )
          );
        }
      }
      const contents = object.ownShape
        ? this.selectProperties(
            [{ ...object, uncertainty: undefined }],
            () => true,
            new Set()
          )
        : this.select([{ ...object, uncertainty: undefined }], null);
      queue.push(
        ...contents.map((reference) => ({ reference, captures, uncertainty }))
      );
    }
    return { nodes, sourceNodes, unknowns };
  }
}

/** Follow the selected value's origin, without conflating container contents. */
export function analyzeImportedValueOrigin(
  path: NodePath<t.Node>,
  memberPath: readonly (string | null)[] = [],
  options: MutationOriginOptions = {}
): ImportedOriginProof {
  try {
    const objects = new ObjectReferences(
      new Set(),
      undefined,
      path.scope.getProgramParent().path,
      options
    );
    let values = objects.resolve(path);
    for (const member of memberPath) values = objects.select(values, member);

    return combineImportedOrigins(
      values.map((value): ImportedOriginProof =>
        isImportedReference(value)
          ? { kind: "imported" }
          : value.uncertainty
            ? { kind: "unknown", ...value.uncertainty }
            : { kind: "local" }
      )
    );
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit)
      return { kind: "unknown", reason: "analysis-limit", path };
    throw error;
  }
}

function isImportedReference({
  path,
  provedModuleOrigin
}: ObjectReference): boolean {
  return (
    provedModuleOrigin === true ||
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier() ||
    (path.isCallExpression() &&
      isStaticCssEvalLiteralRequireCallExpression(path.node, path.scope))
  );
}

/** Whether a property read can reach a live imported receiver, including a prototype. */
export function analyzeImportedMemberReadOrigin(
  path: NodePath<t.Node>,
  member: string | null,
  memberPath: readonly (string | null)[] = [],
  options: MutationOriginOptions = {}
): ImportedOriginProof {
  try {
    const objects = new ObjectReferences(
      new Set(),
      undefined,
      path.scope.getProgramParent().path,
      options
    );
    let values = objects.resolve(path);
    for (const key of memberPath) values = objects.select(values, key);
    return objects.readsImportedMember(values, member);
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit)
      return { kind: "unknown", reason: "analysis-limit", path };
    throw error;
  }
}

/** Compatibility adapters keep unknown conservative, without calling it imported. */
export function hasImportedValueOrigin(
  path: NodePath<t.Node>,
  memberPath: readonly (string | null)[] = [],
  options: MutationOriginOptions = {}
): boolean {
  return analyzeImportedValueOrigin(path, memberPath, options).kind !== "local";
}

export function hasImportedMemberReadOrigin(
  path: NodePath<t.Node>,
  member: string | null,
  memberPath: readonly (string | null)[] = [],
  options: MutationOriginOptions = {}
): boolean {
  return (
    analyzeImportedMemberReadOrigin(path, member, memberPath, options).kind !==
    "local"
  );
}

function memberName(
  member: t.MemberExpression | t.OptionalMemberExpression
): string | null {
  return staticPropertyName(member.property, member.computed);
}

function* assignedMembers(
  path: NodePath<t.Node | null | undefined>
): Generator<NodePath<t.MemberExpression>> {
  if (path.isMemberExpression()) {
    yield path;
  } else if (path.isAssignmentPattern()) {
    yield* assignedMembers(path.get("left"));
  } else if (path.isRestElement()) {
    yield* assignedMembers(path.get("argument"));
  } else if (path.isArrayPattern()) {
    for (const element of path.get("elements")) yield* assignedMembers(element);
  } else if (path.isObjectPattern()) {
    for (const property of path.get("properties")) {
      if (property.isRestElement()) yield* assignedMembers(property);
      else if (property.isObjectProperty())
        yield* assignedMembers(property.get("value"));
    }
  }
}

function wellKnownSymbolOperand(
  key: NodePath<t.Node>,
  hook: "iterator" | "asyncIterator" | "toPrimitive"
): NodePath<t.Identifier> | undefined {
  if (
    !key.isMemberExpression() ||
    staticPropertyName(key.node.property, key.node.computed) !== hook
  )
    return;
  const symbol = key.get("object");
  return symbol.isIdentifier({ name: "Symbol" }) &&
    !symbol.scope.getBinding("Symbol")
    ? symbol
    : undefined;
}

function selectedMemberName(
  member: NodePath<t.MemberExpression | t.OptionalMemberExpression>
): string | null {
  const name = memberName(member.node);
  if (name !== null || !member.node.computed) return name;
  const property = child(member, "property");
  if (!property.isIdentifier()) return null;
  const binding = property.scope.getBinding(property.node.name);
  if (
    binding?.kind !== "const" ||
    !binding.constant ||
    !binding.path.isVariableDeclarator() ||
    !binding.path.get("id").isIdentifier()
  )
    return null;
  const init = binding.path.get("init").node;
  return init ? staticPropertyName(init, true) : null;
}

const readOnlyRuntimeCalls = {
  "@mincho-js/css": ["cx"],
  "@mincho-js/css/classname": ["cx"],
  "@mincho-js/react": ["styled"]
};

function isKnownReadOnlyCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>
): boolean {
  if (path.isNewExpression()) return false;

  const callee = child(path, "callee");
  if (
    isBuiltInExtractionCall(callee) ||
    referencesModuleExports(callee, readOnlyRuntimeCalls)
  )
    return true;
  if (!callee.isMemberExpression()) return false;

  const object = child(callee, "object");

  // Object.keys returns only primitive strings, so no mutable reference escapes.
  return (
    object.isIdentifier({ name: "Object" }) &&
    !object.scope.getBinding("Object") &&
    memberName(callee.node) === "keys"
  );
}

function analyzeAliasedMutationUnchecked(
  program: NodePath<t.Program>,
  target: Binding | NodePath<t.Expression>,
  options: MutationOriginOptions & {
    opaqueCalls?: ReadonlySet<t.CallExpression>;
    selectedBranches?: ReadonlyMap<t.Node, NodePath<t.Expression>>;
    isReadOnlyCall?: (
      path: NodePath<
        t.CallExpression | t.OptionalCallExpression | t.NewExpression
      >
    ) => boolean;
  } = {}
): StaticCssMutationProof {
  const references = new ObjectReferences(
    options.opaqueCalls ?? new Set(),
    options.selectedBranches,
    program,
    options
  );
  const evaluation = branchEvaluationFacts(program);
  const targetOrigins =
    "identifier" in target
      ? references.binding(target)
      : references.resolve(target);
  const unresolvedTarget = targetOrigins.find(
    (reference) => reference.uncertainty
  )?.uncertainty;
  if (unresolvedTarget) return { kind: "unknown", ...unresolvedTarget };
  // This fallback protects ordinary source rule objects. Compiler-owned
  // values and opaque authoring results already follow their own ownership
  // contracts; a possible invocation must not reinterpret those as rules.
  const { nodes: targets, sourceNodes: sourceRuleTargets } =
    references.reachability(targetOrigins);
  let unknown: OriginUncertainty | undefined;

  if (targets.size === 0) return { kind: "proved-unmodified" };

  const touchesObjects = (
    objects: ObjectReference[],
    deep = false,
    wanted = targets,
    ignore?: () => boolean
  ) => {
    let touched = false;
    for (const object of objects) {
      const proof =
        deep || object.uncertainty
          ? references.reachability([object])
          : {
              nodes: new Set([references.identity(object)]),
              unknowns: new Map<object, OriginUncertainty>()
            };
      for (const node of proof.nodes) {
        if (!wanted.has(node)) continue;
        if (ignore?.()) return false;
        const uncertainty = proof.unknowns.get(node);
        if (uncertainty) unknown ??= uncertainty;
        else touched = true;
      }
    }
    return touched;
  };

  function hasImmediatelyDeletedOwnSetter(
    member: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
    name: string
  ): boolean {
    // Only a prior, unconditionally executed direct delete of this exact
    // holder/slot can suppress inspecting its original setter. An intervening
    // effect (including the assignment's RHS) might reinstall it.
    const assignment = member.parentPath;
    if (
      !member.isMemberExpression() ||
      member.key !== "left" ||
      !assignment?.isAssignmentExpression({ operator: "=" })
    )
      return false;
    const value = assignment.get("right");
    if (
      !value.isStringLiteral() &&
      !value.isNumericLiteral() &&
      !value.isBooleanLiteral() &&
      !value.isNullLiteral() &&
      !value.isBigIntLiteral()
    )
      return false;
    const statement = assignment.parentPath;
    if (!statement.isExpressionStatement() || !statement.inList) return false;
    const previous = statement.getPrevSibling();
    if (!previous.isExpressionStatement()) return false;
    const deletion = previous.get("expression");
    if (!deletion.isUnaryExpression({ operator: "delete" })) return false;
    const deleted = deletion.get("argument");
    if (!deleted.isMemberExpression() || memberName(deleted.node) !== name)
      return false;
    const object = member.get("object");
    const previousObject = deleted.get("object");
    if (!object.isIdentifier() || !previousObject.isIdentifier()) return false;
    const binding = object.scope.getBinding(object.node.name);
    return (
      binding?.constant === true &&
      previousObject.scope.getBinding(previousObject.node.name) === binding
    );
  }

  const selectsReturnedSetter = (
    origin: ObjectReference,
    name: string,
    operator: t.LogicalExpression["operator"],
    member: NodePath<t.Node>
  ): boolean | undefined => {
    if (origin.uncertainty || !origin.path.isObjectExpression()) return;
    const relevant = origin.path
      .get("properties")
      .filter(
        ({ node }) =>
          t.isSpreadElement(node) ||
          propertyName(node) === null ||
          propertyName(node) === name
      );
    const setters = relevant.filter((member) =>
      member.isObjectMethod({ kind: "set" })
    );
    const getters = relevant.filter((member) =>
      member.isObjectMethod({ kind: "get" })
    );
    if (setters.length === 0 && getters.length === 0) return false;
    const evidence = (storeEvidence ??= collectRuntimeSourceEvidence(program));
    if (!evidence.bindingsCurrent || evidence.hasGlobalEval) return;
    // The receiver reference alone is not a descriptor-stability proof.
    // Walk the exact immutable alias chain back to the allocation; a second
    // use of any alias may have changed or exposed the selected descriptor.
    let receiver = child(member, "object");
    if (!receiver.isIdentifier()) return;
    const aliases = new Set<Binding>();
    while (receiver.isIdentifier()) {
      const binding = receiver.scope.getBinding(receiver.node.name);
      if (
        !binding?.constant ||
        binding.kind !== "const" ||
        !binding.path.isVariableDeclarator() ||
        !binding.path.get("id").isIdentifier() ||
        aliases.has(binding) ||
        evidence.isExported(binding)
      )
        return;
      aliases.add(binding);
      const uses = evidence.references(binding);
      if (uses.length !== 1 || uses[0]?.node !== receiver.node) return;
      const init = binding.path.get("init");
      if (!init.isIdentifier()) break;
      receiver = init;
    }
    if (
      setters.length !== 1 ||
      getters.length > 1 ||
      relevant.length !== setters.length + getters.length ||
      relevant.some(
        ({ node }) => t.isSpreadElement(node) || propertyName(node) !== name
      )
    )
      return;
    const getter = getters[0];
    if (!getter) return operator !== "&&";
    if (!getter.isObjectMethod() || getter.node.async || getter.node.generator)
      return;
    const body = getter.get("body").get("body");
    if (body.length !== 1 || !body[0].isReturnStatement()) return;
    const value = body[0].get("argument");
    // Prove the read result only for a closed primitive completion. Unknown
    // getter effects remain relevant at the active receiver, not at creation.
    if (
      value.isExpression() &&
      isSupportedStaticCssPrimitiveLiteral(
        unwrapTransparentCssRuleExpression(value.node)
      )
    )
      return evaluation.logicalAssignmentWrite(operator, value);
  };

  const writes = (
    path: NodePath<t.Node | null | undefined>,
    invokesSetter = false,
    assignmentSite?: NodePath<t.AssignmentExpression>,
    yielded?: {
      loop: NodePath<t.ForOfStatement>;
      args: InvocationArguments | null;
    }
  ): boolean => {
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const objects = references.resolve(child(path, "object"));
      if (invokesSetter) {
        const name = selectedMemberName(path);
        const deleted =
          name !== null &&
          hasImmediatelyDeletedOwnSetter(path, name) &&
          objects.every(
            ({ path, uncertainty }) =>
              !uncertainty &&
              path.isObjectExpression() &&
              path.node.properties.every(
                (property) =>
                  !t.isSpreadElement(property) &&
                  !property.computed &&
                  propertyName(property) !== "__proto__"
              )
          );
        if (!deleted) {
          const parent = path.parentPath;
          const assignment =
            path.key === "left" && parent?.isAssignmentExpression()
              ? parent
              : undefined;
          const logical =
            assignment && logicalAssignmentOperator(assignment.node.operator);
          if (logical && assignment && name !== null) {
            for (const origin of objects) {
              const selected = selectsReturnedSetter(
                origin,
                name,
                logical,
                path
              );
              if (selected === false) continue;
              if (selected === undefined && !isProvablyUnexecuted(assignment))
                references.inspectOwnGetters(
                  [origin],
                  checkReturnedEffectBody,
                  (values) =>
                    observeUnresolved(path, values, sourceRuleTargets),
                  name
                );
              references.inspectReturnedMember(
                [origin],
                name,
                "set",
                checkReturnedEffectBody,
                (values) => observeUnresolved(path, values, sourceRuleTargets),
                assignment
              );
            }
            return mutated || touchesObjects(objects);
          }
          const directAssignment =
            assignment?.node.operator === "=" ? assignment : undefined;
          const projectedAssignment =
            !directAssignment &&
            path.isMemberExpression() &&
            assignmentSite?.node.operator === "=" &&
            assignmentSite.get("left").isArrayPattern()
              ? assignmentSite
              : undefined;
          references.inspectReturnedMember(
            objects,
            name,
            "set",
            checkReturnedEffectBody,
            projectedAssignment || yielded
              ? (values) => observeUnresolved(path, values, sourceRuleTargets)
              : undefined,
            directAssignment ?? projectedAssignment ?? yielded?.loop,
            projectedAssignment && path.isMemberExpression()
              ? references.observeAssignedArgument(projectedAssignment, path)
              : yielded &&
                  (yielded.loop.node.left === path.node ? yielded.args : null)
          );
        }
      }
      return mutated || touchesObjects(objects);
    }
    if (path.isArrayPattern())
      return path
        .get("elements")
        .some((element) =>
          writes(element, invokesSetter, assignmentSite, yielded)
        );
    if (path.isObjectPattern())
      return path
        .get("properties")
        .some((property) =>
          writes(
            property.isRestElement()
              ? property.get("argument")
              : property.get("value"),
            invokesSetter,
            assignmentSite,
            yielded
          )
        );
    if (path.isAssignmentPattern())
      return writes(path.get("left"), invokesSetter, assignmentSite, yielded);
    if (path.isRestElement())
      return writes(
        path.get("argument"),
        invokesSetter,
        assignmentSite,
        yielded
      );
    if (
      path.isParenthesizedExpression() ||
      path.isTSAsExpression() ||
      path.isTSTypeAssertion() ||
      path.isTSNonNullExpression() ||
      path.isTSSatisfiesExpression()
    )
      return writes(
        child(path, "expression"),
        invokesSetter,
        assignmentSite,
        yielded
      );

    return false;
  };

  let mutated = false;

  const mark = (path: NodePath<t.Node>) => {
    mutated = true;
    path.stop();
  };

  const observeUnresolved = (
    path: NodePath<t.Node>,
    values: readonly ObjectReference[],
    wanted = targets,
    ignore?: () => boolean
  ) =>
    touchesObjects(
      values.map((value) => ({
        ...value,
        uncertainty: value.uncertainty ?? {
          reason: "unsupported-origin",
          path
        }
      })),
      true,
      wanted,
      ignore
    );

  // A return allocation is inert, not proof that later uses are inert.
  // Escalate only when this observation can reach that allocation's capture.
  const observeReturned = (
    path: NodePath<t.Node>,
    values: readonly ObjectReference[],
    ignore?: () => boolean
  ) =>
    sourceRuleTargets.size > 0 &&
    observeUnresolved(
      path,
      values.filter((value) => value.parameterFrame),
      sourceRuleTargets,
      ignore
    );

  const selectedBinding =
    "identifier" in target
      ? target
      : target.isIdentifier()
        ? target.scope.getBinding(target.node.name)
        : undefined;
  const observedExportBindings = new Set<Binding>();
  const observeExportedCallable = (
    site: NodePath<t.Node>,
    origins: ObjectReference[]
  ) =>
    observeReturned(
      site,
      // Direct callable escapes can allow a consumer to write a capture.
      // Exporting an ordinary initialized rule is not callback activation.
      origins.filter((origin) => origin.path.isFunction() || origin.uncertainty)
    );
  const observeExportedBinding = (
    site: NodePath<t.Node>,
    binding: Binding | undefined
  ) => {
    if (!binding || observedExportBindings.has(binding)) return;
    observedExportBindings.add(binding);
    observeExportedCallable(
      site,
      binding === selectedBinding ? targetOrigins : references.binding(binding)
    );
  };

  type MemberStore = {
    store: NodePath<t.AssignmentExpression | t.ForOfStatement>;
    member: NodePath<t.MemberExpression>;
  };
  const ownIterator = Symbol("own iterator slot");
  type StoredMemberName = string | typeof ownIterator | null;
  let storedMembers: Map<StoredMemberName, MemberStore[]> | undefined;
  let storeEvidence: RuntimeSourceEvidence | undefined;
  const selectsMemberStore = (
    store: NodePath<t.AssignmentExpression>,
    member: NodePath<t.MemberExpression>
  ): boolean | undefined => {
    const operator = logicalAssignmentOperator(store.node.operator);
    if (!operator) return true;
    const object = member.get("object");
    const name = selectedMemberName(member);
    const statement = store.parentPath;
    if (
      !object.isIdentifier() ||
      name === null ||
      store.node.left !== member.node ||
      !statement.isExpressionStatement() ||
      statement.parentPath !== program ||
      typeof statement.key !== "number"
    )
      return;
    const init = evaluation.initializedConst(object);
    const binding = object.scope.getBinding(object.node.name);
    if (!binding || !init?.isObjectExpression()) return;
    const evidence = (storeEvidence ??= collectRuntimeSourceEvidence(program));
    // The original slot remains known only at its first local use: another
    // reader, alias or escape before this store can replace its current value.
    const position = statement.key;
    if (
      evidence.isExported(binding) ||
      evidence.references(binding).some((use) => {
        if (use.node === object.node) return false;
        const at = use.getStatementParent();
        return (
          at?.parentPath !== program ||
          typeof at.key !== "number" ||
          at.key <= position
        );
      })
    )
      return;
    const slot = selectObjectLiteralMember(init.node, name, true);
    if (slot.kind !== "property" || !t.isObjectProperty(slot.property)) return;
    const property = child(init, slot.path);
    if (!property.isObjectProperty()) return;
    const value = property.get("value");
    return value.isExpression()
      ? evaluation.logicalAssignmentWrite(operator, value)
      : undefined;
  };
  const hasDormantLocalIterationOwner = (site: NodePath<t.Node>) => {
    const fn = site.getFunctionParent();
    const declaration = fn?.parentPath;
    if (
      program.node.sourceType !== "module" ||
      !fn?.isArrowFunctionExpression() ||
      fn.key !== "init" ||
      !declaration?.isVariableDeclarator() ||
      declaration.parentPath?.parentPath !== program
    )
      return false;
    const id = declaration.get("id");
    if (!id.isIdentifier()) return false;
    const binding = id.scope.getBinding(id.node.name);
    if (
      binding?.kind !== "const" ||
      binding.path !== declaration ||
      !binding.constant
    )
      return false;
    const evidence = (storeEvidence ??= collectRuntimeSourceEvidence(program));
    return (
      evidence.bindingsCurrent &&
      !evidence.hasGlobalEval &&
      !evidence.isExported(binding) &&
      evidence.references(binding).length === 0
    );
  };
  function* storedMemberValues(
    consumption: NodePath<t.Node>,
    holders: readonly ObjectReference[],
    name: StoredMemberName,
    valueRead?: { beforeRight?: NodePath<t.Node> },
    inspectDelivery?: (
      receiver: ObjectReference,
      values: ObjectReference[]
    ) => void
  ): Generator<ObjectReference[]> {
    if (
      sourceRuleTargets.size === 0 ||
      !holders.some(
        (holder) =>
          holder.path.isObjectExpression() ||
          (holder.path.isArrayExpression() &&
            (name === null ||
              (typeof name === "string" && /^(?:0|[1-9]\d*)$/.test(name))))
      )
    )
      return;
    if (!storedMembers) {
      const assignments = new Map<StoredMemberName, MemberStore[]>();
      const record = (
        store: MemberStore["store"],
        member: MemberStore["member"]
      ) => {
        references.countEffectNode();
        const key =
          member.node.computed &&
          wellKnownSymbolOperand(member.get("property"), "iterator")
            ? ownIterator
            : selectedMemberName(member);
        const candidates = assignments.get(key);
        if (candidates) candidates.push({ store, member });
        else assignments.set(key, [{ store, member }]);
      };
      program.traverse({
        AssignmentExpression(store) {
          if (
            store.node.operator !== "=" &&
            !logicalAssignmentOperator(store.node.operator)
          )
            return;
          for (const member of assignedMembers(store.get("left")))
            record(store, member);
        },
        ForOfStatement(store) {
          const left = store.get("left");
          if (
            !store.node.await &&
            left.isMemberExpression() &&
            store.get("right").isArrayExpression()
          )
            record(store, left);
        }
      });
      storedMembers = assignments;
    }
    const identities = new Set(
      holders.map((holder) => references.identity(holder))
    );
    const consumer = valueRead
      ? consumption.getStatementParent()
      : name === ownIterator
        ? consumption.isForOfStatement()
          ? consumption
          : consumption.getStatementParent()
        : consumption.getStatementParent();
    const beforeRight = valueRead?.beforeRight;
    const activation = consumption.getFunctionParent();
    const isOneShotRead = () => {
      if (
        activation &&
        !holders.every(
          (holder) =>
            !holder.uncertainty &&
            holder.path.getFunctionParent() === activation
        )
      )
        return false;
      for (
        let owner = consumption.parentPath;
        owner && owner !== activation;
        owner = owner.parentPath
      )
        if (owner.isLoop() || owner.isClass()) return false;
      return true;
    };
    let oneShotRead: boolean | undefined;
    const candidates =
      name === null
        ? storedMembers.values()
        : [
            storedMembers.get(name) ?? [],
            storedMembers.get(null) ?? [],
            // Named calls kept these arbitrary computed writes conservative
            // already. Only iterator consumption uses the distinct slot.
            ...(typeof name === "string"
              ? [storedMembers.get(ownIterator) ?? []]
              : [])
          ];
    for (const group of candidates)
      for (const { store, member } of group) {
        references.countEffectNode();
        const statement = store.isForOfStatement() ? store : store.parentPath;
        if (
          !valueRead &&
          name !== ownIterator &&
          store.isAssignmentExpression() &&
          store.getFunctionParent() === consumption.getFunctionParent() &&
          (store.node.right === consumption.node ||
            consumption.findParent(
              (parent) => parent.node === store.node.right
            )) &&
          (oneShotRead ??= isOneShotRead())
        )
          // An assignment's RHS sees the pre-store receiver in a fresh
          // activation; a repeated one may observe an earlier store.
          continue;
        if (
          !valueRead &&
          name !== ownIterator &&
          store.getFunctionParent() === consumption.getFunctionParent() &&
          (consumption.isCallExpression() ||
            consumption.isOptionalCallExpression() ||
            consumption.isNewExpression()) &&
          ((store.parentPath === consumption &&
            store.listKey === "arguments") ||
            store.findParent(
              (parent) =>
                parent.parentPath === consumption &&
                parent.listKey === "arguments"
            )) &&
          (oneShotRead ??= isOneShotRead())
        )
          // The callee value is already selected before its arguments run.
          // Their stores remain visible to the next invocation.
          continue;
        if (
          beforeRight &&
          store.getFunctionParent() === activation &&
          (oneShotRead ??= isOneShotRead()) &&
          (store.node === beforeRight.node ||
            store.findParent((parent) => parent.node === beforeRight.node))
        )
          continue;
        // Only the single Program sequence establishes that a later write
        // cannot have happened before this call. Other schedules stay possible.
        if (
          !consumption.getFunctionParent() &&
          (consumer?.isExpressionStatement() ||
            consumer?.isVariableDeclaration() ||
            ((name === ownIterator || valueRead) &&
              consumer?.isForOfStatement())) &&
          (statement.isExpressionStatement() || statement.isForOfStatement()) &&
          consumer.parentPath === program &&
          statement.parentPath === program &&
          typeof consumer.key === "number" &&
          typeof statement.key === "number" &&
          consumer.key < statement.key
        )
          continue;
        if (
          isProvablyUnexecuted(store) ||
          (store.isAssignmentExpression() &&
            selectsMemberStore(store, member) === false) ||
          !references
            .resolve(member.get("object"))
            .some((holder) => identities.has(references.identity(holder)))
        )
          continue;
        // Keep unproved stores relevant only at this same-holder consumption;
        // merely constructing the closure or storing it proves no effect.
        if (store.isForOfStatement()) {
          const iterable = store.get("right");
          const delivered = references.observeLoopArguments(iterable);
          const receiver = holders[0]!;
          const slot =
            inspectDelivery &&
            typeof name === "string" &&
            selectedMemberName(member) === name &&
            holders.length === 1 &&
            !receiver.uncertainty &&
            receiver.path.isObjectExpression()
              ? selectObjectLiteralMember(receiver.path.node, name)
              : undefined;
          const directData =
            slot?.kind === "property" &&
            (t.isObjectProperty(slot.property) ||
              t.isObjectMethod(slot.property, { kind: "method" }));
          for (const args of delivered ?? []) {
            if (!args[0]) continue;
            if (inspectDelivery && directData)
              inspectDelivery(receiver, args[0].origins);
            else yield args[0].origins;
          }
          if (!delivered) {
            // The array is no longer certified to use native delivery. A
            // reachable stored callback may still carry relevant captures.
            yield references
              .resolve(iterable)
              .flatMap(
                (origin) =>
                  origin.arrayElements?.flatMap((slot) => slot ?? []) ?? []
              );
          }
        } else if (store.isAssignmentExpression()) {
          const values = references.storedValues(
            store.get("left"),
            store.get("right"),
            member.node
          );
          const receiver = holders[0]!;
          const index = typeof name === "string" ? Number(name) : -1;
          if (
            inspectDelivery &&
            store.node.operator === "=" &&
            selectedMemberName(member) === name &&
            holders.length === 1 &&
            !receiver.uncertainty &&
            receiver.path.isArrayExpression() &&
            Number.isInteger(index) &&
            index >= 0 &&
            String(index) === name
          ) {
            const elements = receiver.path.get("elements");
            if (
              elements[index]?.isExpression() &&
              elements.slice(0, index).every((slot) => !slot.isSpreadElement())
            ) {
              inspectDelivery(receiver, values);
              continue;
            }
          }
          yield values;
        }
      }
  }
  const observeStoredMembers = (
    consumption: NodePath<t.Node>,
    holders: readonly ObjectReference[],
    name: StoredMemberName,
    inspectDelivery?: (
      receiver: ObjectReference,
      values: ObjectReference[]
    ) => void
  ) => {
    for (const values of storedMemberValues(
      consumption,
      holders,
      name,
      undefined,
      inspectDelivery
    ))
      observeReturned(consumption, values);
  };

  const checkCall = (
    path: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >,
    activeOrigin?: ObjectReference
  ) => {
    if (
      (path.isOptionalCallExpression() &&
        evaluation.plan(path).unexecutedBranches) ||
      isKnownReadOnlyCall(path) ||
      references.isEffectFreeLocalCall(path)
    )
      return;

    const callee = child(path, "callee");
    const unresolved = (values: ObjectReference[]) =>
      observeUnresolved(path, values);
    const live = !evaluation.isUnexecuted(path);
    let readOnly: boolean | undefined;
    const isReadOnly = () =>
      (readOnly ??= options.isReadOnlyCall?.(path) ?? false);
    let receiver = false;
    if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
      // Dispatch the selected own method in the frame of the receiver's
      // allocation, not in an unframed replay of the callee expression.
      const origins = observedOperandOrigins(
        child(callee, "object"),
        activeOrigin
      );
      const name = selectedMemberName(callee);
      const constructing = path.isNewExpression();
      references.inspectReturnedMember(
        origins,
        name,
        constructing ? "construct" : "method",
        checkReturnedEffectBody,
        unresolved,
        path,
        undefined,
        sourceRuleTargets.size > 0 ? inspectInvocationParameterReads : undefined
      );
      if (live) {
        if (!constructing) {
          // A member call on a returned callable can dispatch to that value;
          // spelling alone does not certify which function it invokes.
          observeReturned(
            path,
            origins.filter((value) => value.path.isFunction())
          );
        }
        const call =
          path.isCallExpression() || path.isOptionalCallExpression()
            ? path
            : undefined;
        observeStoredMembers(
          path,
          origins,
          name,
          call
            ? (receiver, values) =>
                references.inspectDeliveredCall(
                  call,
                  receiver,
                  values,
                  checkReturnedEffectBody,
                  unresolved
                )
            : undefined
        );
      }
      receiver = touchesObjects(origins, true);
    } else if (
      !references.inspectReturnedCallable(
        callee,
        checkReturnedEffectBody,
        path,
        unresolved,
        evaluation
      )
    ) {
      if (activeOrigin) {
        references.inspectCapturedCall(
          activeOrigin,
          path,
          checkReturnedEffectBody,
          unresolved
        );
      } else if (
        live &&
        sourceRuleTargets.size > 0 &&
        (path.isCallExpression() || path.isNewExpression())
      ) {
        references.observeDirectParameterDelivery(
          callee,
          path,
          inspectInvocationParameterReads
        );
      }
    }
    if (mutated) return path.stop();

    const argumentEscapes = path.get("arguments").some((argument) => {
      const values = references.resolve(
        argument.isSpreadElement() ? argument.get("argument") : argument
      );
      if (live) {
        // An unproved consumer may invoke this value, including conversion.
        observeReturned(path, values, isReadOnly);
      }
      return touchesObjects(values, true);
    });
    if ((receiver || argumentEscapes) && !isReadOnly()) mark(path);
  };

  const observedOperandOrigins = (
    operand: NodePath<t.Node>,
    activeOrigin?: ObjectReference
  ): ObjectReference[] => {
    const frame = activeOrigin?.parameterFrame;
    return references.resolve(operand).map((origin) =>
      frame &&
      origin.path.isObjectExpression() &&
      ((operand.isObjectExpression() && origin.path.node === operand.node) ||
        (activeOrigin.activation &&
          origin.path.getFunctionParent()?.node ===
            activeOrigin.activation.node)) &&
      !origin.parameterFrame &&
      !origin.uncertainty
        ? {
            ...origin,
            call: activeOrigin?.call,
            owner: activeOrigin?.owner,
            parameterFrame: frame
          }
        : origin
    );
  };

  const observeComputedKey = (
    site: NodePath<t.Node>,
    key: NodePath<t.Node>,
    canSettleOwn: boolean,
    activeOrigin?: ObjectReference
  ) => {
    const unresolved = (values: ObjectReference[]) =>
      observeUnresolved(site, values, sourceRuleTargets);
    const origins = observedOperandOrigins(key, activeOrigin);
    const values = references.inspectOwnSymbolHook(
      origins,
      key,
      canSettleOwn,
      checkReturnedEffectBody,
      unresolved
    );
    // A selected property-key read can dispatch to an earlier same-object
    // store. Use the existing recorded write frame and the real key receiver.
    // The string-first ordinary operation is still behind the Symbol hook.
    for (const receiver of values) {
      if (!receiver.path.isObjectExpression()) continue;
      for (const stored of storedMemberValues(site, [receiver], "toString", {}))
        references.inspectStoredKeyConversion(
          stored,
          receiver,
          checkReturnedEffectBody,
          unresolved
        );
    }
    references.inspectPropertyKeyHooks(
      values,
      key,
      canSettleOwn,
      checkReturnedEffectBody,
      unresolved
    );
  };

  type OperationAfterValue = {
    key: ReturnType<typeof propertyKeyStep>;
    delivery: Extract<EvaluationStep, { kind: "observe" }>["sourceDelivery"];
    copy: Extract<EvaluationStep, { kind: "observe" }>["copyMembers"];
    conversions: ReturnType<typeof orderedValueConversionSteps>;
  };
  const afterValue = new WeakMap<
    NodePath<t.Node>,
    OperationAfterValue | null
  >();
  function operationsAfterValue(path: NodePath<t.Node>) {
    let operations = afterValue.get(path);
    if (operations === undefined) {
      const key = propertyKeyStep(path);
      const delivery = sourceDeliveryStep(path)?.sourceDelivery;
      const copy = objectSpreadStep(path)?.copyMembers;
      const conversions = orderedValueConversionSteps(path);
      operations =
        key || delivery || copy || conversions
          ? { key, delivery, copy, conversions }
          : null;
      afterValue.set(path, operations);
    }
    return operations;
  }

  const observeObjectPatternReads = (
    site: NodePath<t.Node>,
    pattern: NodePath<t.ObjectPattern>,
    origins: ObjectReference[],
    inspectNested: (
      pattern: NodePath<t.Node>,
      origins: ObjectReference[]
    ) => void,
    activeOrigin?: ObjectReference,
    observeKeys = true
  ) => {
    const unresolved = (values: ObjectReference[]) =>
      observeUnresolved(site, values, sourceRuleTargets);
    const excludedNames = new Set<string>();
    for (const property of pattern.get("properties")) {
      references.countEffectNode();
      if (property.isRestElement()) {
        references.inspectOwnGetters(
          origins,
          checkReturnedEffectBody,
          unresolved,
          undefined,
          excludedNames
        );
        if (patternObservesDelivery(property.node.argument))
          unresolved(origins);
        continue;
      }
      if (!property.isObjectProperty()) continue;
      // Invocation binding shares these own reads after actual delivery.
      // Computed-key activation remains with the caller's ordered plan.
      if (property.node.computed && observeKeys)
        observeComputedKey(site, property.get("key"), false, activeOrigin);
      const name = propertyName(property.node);
      if (name === null && !observeKeys) continue;
      references.inspectOwnGetters(
        origins,
        checkReturnedEffectBody,
        unresolved,
        name ?? undefined
      );
      if (name !== null) excludedNames.add(name);

      const childPattern = property.get("value");
      if (!bindingPatternReadsSource(childPattern.node)) continue;
      if (name === null) unresolved(origins);
      else inspectNested(childPattern, references.select(origins, name));
    }
  };

  type OperandReceipts = WeakMap<
    t.Node,
    { values: ObjectReference[]; hasStoredMember: boolean }
  >;
  const observeAfterOperand = (
    operand: NodePath<t.Node>,
    receipts: OperandReceipts,
    activeOrigin?: ObjectReference
  ) => {
    if (sourceRuleTargets.size === 0) return;
    const path = operand.parentPath;
    if (!path) return;
    const operations = operationsAfterValue(path);
    if (!operations) return;
    const { key: step, delivery: iteration, copy, conversions } = operations;
    const selectedConversion = conversions?.find(
      (candidate) => candidate.path.node === operand.node
    );
    const conversionAfter = selectedConversion?.valueConversion?.after;
    if (
      conversionAfter &&
      (operand.isMemberExpression() ||
        operand.isIdentifier() ||
        !path.isBinaryExpression()) &&
      !isProvablyUnexecuted(path)
    ) {
      // Save the selected GetValue at operand time; the same object may
      // dispatch a different conversion hook after the other operand runs.
      const selected = observedOperandOrigins(operand, activeOrigin);
      let hasStoredMember = false;
      if (operand.isMemberExpression())
        for (const values of storedMemberValues(
          operand,
          observedOperandOrigins(operand.get("object"), activeOrigin),
          selectedMemberName(operand),
          {
            beforeRight:
              conversionAfter.node === operand.node
                ? undefined
                : conversionAfter
          }
        )) {
          hasStoredMember ||= values.length > 0;
          selected.push(...values);
        }
      receipts.set(operand.node, { values: selected, hasStoredMember });
    }
    if (conversionAfter?.node === operand.node)
      observeCoercion(path, activeOrigin, conversions, receipts);
    if (
      iteration?.after.node === operand.node &&
      !evaluation.isUnexecuted(path)
    ) {
      // A function's declaration is neither its execution position nor an
      // activation. Unknown escapes stay possible; exactly unused local
      // owners need no captured-iterator observation.
      if (!activeOrigin && hasDormantLocalIterationOwner(path)) return;
      const unresolved = (values: ObjectReference[]) =>
        observeUnresolved(path, values, sourceRuleTargets);
      const consume = (origins: ObjectReference[]) =>
        observeIterationDelivery(
          path,
          operand,
          origins,
          unresolved,
          iteration.kind === "async-iterator"
        );
      const inspectPattern = (
        pattern: NodePath<t.Node>,
        origins: ObjectReference[]
      ) => {
        references.countEffectNode();
        if (pattern.isArrayPattern()) {
          // The RHS's selected value is consumed even for an unread binding.
          consume(origins);
          observeArrayPatternReads(
            path,
            pattern,
            origins,
            inspectPattern,
            unresolved
          );
        } else if (pattern.isObjectPattern()) {
          observeObjectPatternReads(
            path,
            pattern,
            origins,
            inspectPattern,
            activeOrigin
          );
        } else if (pattern.isAssignmentPattern()) {
          // Either the incoming value or a selected default can be consumed.
          inspectPattern(
            pattern.get("left"),
            options.skippedPatternDefaults?.has(pattern.node)
              ? origins
              : [
                  ...origins,
                  ...observedOperandOrigins(pattern.get("right"), activeOrigin)
                ]
          );
        }
      };
      const origins = observedOperandOrigins(operand, activeOrigin);
      if (iteration.kind === "binding-pattern" && iteration.pattern) {
        if (evaluation.valueNullish(operand as NodePath<t.Expression>) !== true)
          inspectPattern(iteration.pattern, origins);
      } else {
        consume(origins);
        if (iteration.pattern) {
          const delivered =
            iteration.kind === "sync-iterator"
              ? references.observeLoopArguments(operand)
              : null;
          if (delivered)
            for (const args of delivered) {
              const value = args[0];
              const source = value?.source;
              if (
                source?.isExpression() &&
                evaluation.valueNullish(source) !== true
              )
                inspectPattern(
                  iteration.pattern,
                  observedOperandOrigins(source, activeOrigin)
                );
            }
          else unresolved(origins);
        }
        if (path.isForOfStatement()) {
          const target = path.get("left");
          if (!target.isVariableDeclaration() && !target.isIdentifier()) {
            const delivered =
              iteration.kind === "sync-iterator" && target.isMemberExpression()
                ? references.observeLoopArguments(operand)
                : null;
            for (const args of delivered ?? [null]) {
              if (writes(target, true, undefined, { loop: path, args })) {
                mark(path);
                break;
              }
            }
          }
        }
      }
      return;
    }
    if (copy?.after.node === operand.node && !isProvablyUnexecuted(path)) {
      references.inspectOwnGetters(
        observedOperandOrigins(operand, activeOrigin),
        checkReturnedEffectBody,
        (values) => observeUnresolved(path, values, sourceRuleTargets)
      );
      return;
    }
    if (!step?.propertyKey) return;
    const { after, requiresObject, receiver } = step.propertyKey;
    if (receiver && evaluation.valueNullish(receiver) === true) return;
    // A definition converts after its key and before its value/body. The
    // binary operation converts only after evaluation of both operand values.
    if (after.node !== operand.node || isProvablyUnexecuted(path)) return;
    // `in` checks the RHS after evaluating it, and never converts a key
    // against a known non-object. An unknown RHS can still select conversion.
    if (requiresObject?.isExpression()) {
      const right = unwrapTransparentCssRuleExpression(requiresObject.node);
      if (
        isSupportedStaticCssPrimitiveLiteral(right) ||
        t.isBigIntLiteral(right) ||
        t.isUnaryExpression(right, { operator: "void" })
      )
        return;
    }
    observeComputedKey(
      path,
      step.path,
      !requiresObject || requiresObject.isObjectExpression(),
      activeOrigin
    );
  };

  const observeCoercion = (
    path: NodePath<t.Node>,
    activeOrigin?: ObjectReference,
    steps = planEvaluation(path).steps,
    receipts?: OperandReceipts
  ) => {
    if (sourceRuleTargets.size === 0 || isProvablyUnexecuted(path)) return;
    const abstractEquality =
      path.isBinaryExpression() &&
      (path.node.operator === "==" || path.node.operator === "!=");
    for (const step of steps) {
      if (step.kind !== "coerce" || step.propertyKey) continue;
      let counterpartSettled = false;
      if (abstractEquality) {
        const opposite = path.get(step.path.key === "left" ? "right" : "left");
        const counterpart = references.equalityCounterpart(
          opposite,
          evaluation
        );
        // Objects/nullish values do not select conversion. Unproved kinds
        // keep a possible relevant conversion, not a typed no-effect claim.
        if (counterpart === "does-not-convert") continue;
        counterpartSettled = counterpart === "primitive";
      }
      const receipt = receipts?.get(step.path.node);
      const values = references.inspectOwnSymbolHook(
        receipt?.values ?? observedOperandOrigins(step.path, activeOrigin),
        step.path,
        counterpartSettled,
        checkReturnedEffectBody,
        (values) => observeUnresolved(path, values, sourceRuleTargets)
      );
      for (const name of step.valueConversion
        ? ["valueOf", "toString"]
        : ["toString", "valueOf"]) {
        if (step.valueConversion && receipts?.has(step.path.node))
          for (const receiver of values) {
            if (!receiver.path.isObjectExpression()) continue;
            for (const stored of storedMemberValues(
              path,
              [receiver],
              name,
              {}
            )) {
              const unresolved = (relevant: ObjectReference[]) =>
                observeUnresolved(path, relevant, sourceRuleTargets);
              references.inspectStoredKeyConversion(
                stored,
                receiver,
                checkReturnedEffectBody,
                unresolved
              );
              // A stored callable without a proven invocation frame can
              // still write through this exact receiver. Do not replay it.
              if (
                stored.some(
                  (value) => !value.parameterFrame || value.uncertainty
                )
              )
                unresolved([receiver, ...stored]);
            }
          }
        // Ordinary coercion calls the selected method with the operand as
        // receiver. A method may read this.rule without capturing rule itself.
        if (
          step.valueConversion &&
          name === "valueOf" &&
          (!path.isBinaryExpression() || receipt?.hasStoredMember)
        )
          references.inspectReturnedMember(
            values,
            name,
            "method",
            checkReturnedEffectBody,
            (candidates) =>
              observeUnresolved(path, candidates, sourceRuleTargets),
            undefined,
            []
          );
        observeReturned(path, references.select(values, name));
      }
    }
  };

  const effectVisitors = (
    receipts: OperandReceipts,
    activeOrigin?: ObjectReference
  ): Visitor => ({
    exit: (operand) => observeAfterOperand(operand, receipts, activeOrigin),

    AssignmentExpression(path) {
      const target = getCjsAssignmentTarget(path.node.left, path.scope);
      const reexport =
        path.node.operator === "=" &&
        (target.kind === "property" || target.kind === "module-replacement");
      if (
        writes(path.get("left"), true, path) ||
        (!reexport &&
          touchesObjects(
            references.storedValues(path.get("left"), path.get("right")),
            true
          ))
      )
        mark(path);
    },

    UpdateExpression(path) {
      if (writes(path.get("argument"), true)) mark(path);
    },

    UnaryExpression(path) {
      if (path.node.operator === "delete") {
        if (writes(path.get("argument"))) mark(path);
      } else {
        observeCoercion(path, activeOrigin);
      }
    },

    ExportNamedDeclaration(path) {
      if (
        sourceRuleTargets.size === 0 ||
        path.node.source ||
        path.node.exportKind === "type"
      )
        return;
      const declaration = path.get("declaration");
      if (declaration.isVariableDeclaration())
        for (const name of Object.keys(
          t.getBindingIdentifiers(declaration.node)
        ))
          observeExportedBinding(path, declaration.scope.getBinding(name));
      for (const specifier of path.get("specifiers"))
        if (
          specifier.isExportSpecifier() &&
          specifier.node.exportKind !== "type"
        ) {
          const value = specifier.get("local");
          observeExportedBinding(path, value.scope.getBinding(value.node.name));
        }
    },

    ExportDefaultDeclaration(path) {
      if (sourceRuleTargets.size === 0) return;
      const value = path.get("declaration");
      if (value.isIdentifier())
        observeExportedBinding(path, value.scope.getBinding(value.node.name));
      else if (value.isExpression())
        observeExportedCallable(path, references.resolve(value));
    },

    CallExpression: (path) => checkCall(path, activeOrigin),
    OptionalCallExpression: (path) => checkCall(path, activeOrigin),
    NewExpression: (path) => checkCall(path, activeOrigin),

    ThrowStatement(path) {
      touchesObjects(
        references
          .resolve(path.get("argument"))
          .map((reference): ObjectReference => ({
            ...reference,
            uncertainty: { reason: "unsupported-origin", path }
          })),
        true
      );
    },

    "ClassProperty|ClassPrivateProperty|ClassAccessorProperty"(path) {
      touchesObjects(
        references
          .resolve(child(path, "value"))
          .map((reference): ObjectReference => ({
            ...reference,
            uncertainty: { reason: "unsupported-origin", path }
          })),
        true
      );
    },

    TemplateLiteral: (path) => observeCoercion(path, activeOrigin),

    "AwaitExpression|YieldExpression|TaggedTemplateExpression"(path) {
      // These observations may consume a target even when their result is
      // discarded. The origin proof, not a file-wide unsupported-syntax flag,
      // decides whether the uncertainty is relevant to this binding.
      touchesObjects(references.resolve(path), true);
    },

    ForInStatement(path) {
      if (writes(path.get("left"), true)) mark(path);
    },

    ForOfStatement(path) {
      if (sourceRuleTargets.size === 0 && writes(path.get("left"), true))
        mark(path);
    }
  });

  function observeIterationDelivery(
    site: NodePath<t.Node>,
    source: NodePath<t.Node>,
    origins: ObjectReference[],
    unresolved: UnresolvedEffect,
    asynchronous = false
  ) {
    // Async delivery can select its own hook before the synchronous fallback.
    const syncCandidates = asynchronous
      ? references.inspectOwnSymbolHook(
          origins,
          source,
          false,
          checkReturnedEffectBody,
          unresolved,
          "asyncIterator"
        )
      : origins;
    observeStoredMembers(site, syncCandidates, ownIterator);
    const unproved = references.inspectOwnSymbolHook(
      syncCandidates,
      source,
      false,
      checkReturnedEffectBody,
      unresolved,
      "iterator"
    );
    observeReturned(
      site,
      unproved.filter((origin) => origin.uncertainty)
    );
  }

  function observeArrayPatternReads(
    site: NodePath<t.Node>,
    pattern: NodePath<t.ArrayPattern>,
    origins: ObjectReference[],
    inspect: (pattern: NodePath<t.Node>, origins: ObjectReference[]) => void,
    unresolved: UnresolvedEffect
  ) {
    for (const [index, element] of pattern.get("elements").entries()) {
      if (element.isObjectPattern()) {
        if (!element.node.properties.length) continue;
        const delivered = references.observeArrayPatternSlot(
          site,
          origins,
          index
        );
        if (delivered === null) unresolved(origins);
        else inspect(element, delivered);
      } else if (element.node && patternObservesDelivery(element.node)) {
        // Do not invent a selected value through unmodeled delivery.
        unresolved(origins);
      }
    }
  }

  function inspectInvocationParameterReads(
    fn: NodePath<t.Function>,
    argumentsInCaller: InvocationArguments,
    origin?: ObjectReference
  ) {
    const inspectParameter = (
      pattern: NodePath<t.Node>,
      origins: ObjectReference[]
    ) => {
      if (pattern.isObjectPattern())
        observeObjectPatternReads(
          fn,
          pattern,
          origins,
          inspectParameter,
          origin,
          false
        );
      else if (pattern.isArrayPattern()) {
        const unresolved = (values: ObjectReference[]) =>
          observeUnresolved(fn, values, sourceRuleTargets);
        observeIterationDelivery(fn, pattern, origins, unresolved);
        observeArrayPatternReads(
          fn,
          pattern,
          origins,
          inspectParameter,
          unresolved
        );
      }
    };
    const parameters = fn.get("params");
    for (const [index, parameter] of (Array.isArray(parameters)
      ? parameters
      : []
    ).entries()) {
      if (!bindingPatternReadsSource(parameter.node)) continue;
      const { pattern, origins } = references.selectedParameterDelivery(
        parameter,
        argumentsInCaller[index]
      );
      if (origins.length) inspectParameter(pattern, origins);
    }
  }

  function checkReturnedEffectBody(
    fn: NodePath<t.Function>,
    origin: ObjectReference,
    skippedDefaults?: ReadonlySet<t.Node>,
    argumentsInCaller?: InvocationArguments
  ) {
    // Selected methods, setters, and plain returned functions consume their
    // actual incoming object before entering the same returned-effect body.
    if (
      (fn.isObjectMethod({ kind: "method" }) ||
        fn.isObjectMethod({ kind: "set" }) ||
        ((fn.isArrowFunctionExpression() || fn.isFunctionExpression()) &&
          !fn.node.async &&
          !("generator" in fn.node && fn.node.generator))) &&
      argumentsInCaller
    )
      inspectInvocationParameterReads(fn, argumentsInCaller, origin);
    // This is an additional mutation veto, never a proof that the invocation
    // can be replayed. A returned-but-uninvoked callback or setter does not
    // enter here.
    fn.traverse({
      ...effectVisitors(new WeakMap(), { ...origin, activation: fn }),
      enter(path) {
        references.countEffectNode();
        if (skippedDefaults?.has(path.node)) {
          path.skip();
          return;
        }
        const parent = path.parentPath;
        if (
          (parent?.isIfStatement() ||
            parent?.isConditionalExpression() ||
            parent?.isLogicalExpression()) &&
          planEvaluation(parent).unexecutedBranches?.some(
            (branch) => branch.node === path.node
          )
        )
          path.skip();
      },
      Function(inner) {
        // Follow the plan's eager key edge in the caller frame. Skipping
        // only the other child keys lets ordinary visitors see the key root
        // and never treats the deferred method body/defaults as executed.
        const eagerKey = planEvaluation(inner).operands.some(
          ({ path, execution }) => path.key === "key" && execution === "eager"
        );
        if (!eagerKey) {
          inner.skip();
          return;
        }
        // Object definition keys dispatch on the actual key child exit.
        // Keep the existing proof for class keys outside this migration.
        if (!propertyKeyStep(inner)) observeCoercion(inner);
        for (const key of t.VISITOR_KEYS[inner.node.type] ?? [])
          if (key !== "key") inner.skipKey(key);
      }
    });
  }

  program.traverse(effectVisitors(new WeakMap()));

  return mutated
    ? { kind: "may-mutate" }
    : unknown
      ? { kind: "unknown", ...unknown }
      : { kind: "proved-unmodified" };
}

export function analyzeAliasedStaticCssEvalBindingMutation(
  program: NodePath<t.Program>,
  binding: Binding,
  options: Parameters<typeof analyzeAliasedMutationUnchecked>[2] = {}
): StaticCssMutationProof {
  try {
    return analyzeAliasedMutationUnchecked(program, binding, options);
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit)
      return { kind: "unknown", reason: "analysis-limit", path: program };
    throw error;
  }
}

/** Inspect one result projection, without selecting or skipping execution.
 * CSS consumers may use this for the truthy RHS of && only while preserving
 * the original logical value and all non-CSS uses. This does not prove that
 * the omitted result is primitive (HTMLDDA can be a falsy object).
 */
export function analyzeAliasedExpressionMutation(
  program: NodePath<t.Program>,
  expression: NodePath<t.Expression>,
  options: Parameters<typeof analyzeAliasedMutationUnchecked>[2] = {}
): StaticCssMutationProof {
  try {
    return analyzeAliasedMutationUnchecked(program, expression, options);
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit)
      return { kind: "unknown", reason: "analysis-limit", path: program };
    throw error;
  }
}

/** Compatibility adapter: inability to prove immutability is never safe false. */
export function hasAliasedStaticCssEvalBindingMutation(
  program: NodePath<t.Program>,
  binding: Binding,
  options: Parameters<typeof analyzeAliasedMutationUnchecked>[2] = {}
): boolean {
  return (
    analyzeAliasedStaticCssEvalBindingMutation(program, binding, options)
      .kind !== "proved-unmodified"
  );
}

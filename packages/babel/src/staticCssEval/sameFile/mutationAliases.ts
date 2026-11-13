import type { ClosedOwnAllocationShape } from "../../extractionCalls/closedAllocation.js";
import {
  isIdentityArrayMapCall,
  isDenseArrayIncludesCall
} from "../../optimizations/arrayMapIntrinsic.js";
import { planEvaluation } from "../../extractionCalls/evaluation.js";
import { referencesModuleExports } from "../../commonjs/bindings.js";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { isBuiltInExtractionCall } from "../../extractionCalls/builtins.js";
import { STATIC_CSS_EVAL_LIMITS } from "../types.js";
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
  skippedPatternDefaults?: ReadonlySet<t.AssignmentPattern>;
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
  uncertainty?: OriginUncertainty;
  rest?: {
    sources: ObjectReference[];
    excluded: Set<string>;
    offset?: number;
  };
}

function child(path: NodePath<t.Node>, key: string): NodePath<t.Node> {
  return path.get(key) as NodePath<t.Node>;
}

export class StaticCssMutationAnalysisLimit extends Error {}

/** Tracks allocation identity without executing initializers, getters or calls. */
class ObjectReferences {
  private allocations = new WeakMap<t.Node, WeakMap<t.Node, object>>();
  private visits = 0;
  private parameterOrigins = new Map<Binding, ObjectReference[]>();
  private parameterScalars = new Map<Binding, ScalarProof>();
  private activeScalarCalls = new Map<t.Function, Set<string>>();
  private functionNodes = new WeakMap<t.Function, Set<t.Node>>();
  private deletedProperties = new Map<object, Set<string | null>>();
  private possibleDeletedNames?: Set<string | null>;

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
  private visit(): void {
    const limit = STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount;
    if (++this.visits > limit) {
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
    const selected = this.selectedBranches?.get(path.node);

    if (selected) return this.resolve(selected, next);
    if (
      path.isObjectExpression() ||
      path.isArrayExpression() ||
      path.isFunction() ||
      path.isClass()
    )
      return [{ path }];

    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);

      if (binding) return this.binding(binding, next);
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

    if (
      path.isParenthesizedExpression() ||
      path.isTSAsExpression() ||
      path.isTSTypeAssertion() ||
      path.isTSNonNullExpression() ||
      path.isTSSatisfiesExpression()
    ) {
      return this.resolve(child(path, "expression"), next);
    }

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
      const fn = this.localCallable(callee, next);
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
      const parameters = new Map(previous);
      // Evaluate arguments in the caller frame, then bind defaults left-to-right
      // so a later default can retain an earlier parameter's captured identity.
      const argumentOrigins = args.map((argument) =>
        this.resolve(argument, next)
      );
      this.parameterOrigins = parameters;
      for (const [index, parameter] of fn.get("params").entries()) {
        const values = argumentOrigins[index] ?? [];
        for (const name of Object.keys(
          t.getBindingIdentifiers(parameter.node)
        )) {
          const binding = fn.scope.getBinding(name);
          if (!binding) continue;
          parameters.set(binding, this.pattern(parameter, name, values, next));
        }
      }
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
      try {
        // Revisit the same body only under a distinct, fully-known scalar state.
        // Ordinary alias cycles retain their original seen-node guard.
        const nodes = scalarFrame ? this.localFunctionNodes(fn) : undefined;
        const nested = new Set(
          [...next].filter((node) => !nodes?.has(node))
        ).add(fn.node);
        const body = fn.get("body");
        if (!body.isBlockStatement())
          return this.resolve(body, nested).map((reference) =>
            this.atCall(reference, path.node, fn)
          );

        const returned: ObjectReference[] = [];
        body.traverse({
          enter: () => this.visit(),
          Function(inner) {
            inner.skip();
          },
          ReturnStatement: (statement) => {
            returned.push(...this.resolve(statement.get("argument"), nested));
          }
        });
        return returned.map((reference) =>
          this.atCall(reference, path.node, fn)
        );
      } finally {
        this.parameterOrigins = previous;
        this.parameterScalars = previousScalars;
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

  binding(binding: Binding, seen = new Set<t.Node>()): ObjectReference[] {
    this.visit();

    const substituted = this.parameterOrigins.get(binding);
    if (substituted) return substituted;
    const declaration = binding.path;
    const values: ObjectReference[] = [];

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

    if (declaration.isVariableDeclarator()) {
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

    for (const violation of binding.constantViolations) {
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
    value: NodePath<t.Expression>
  ): ObjectReference[] {
    return this.pattern(pattern, undefined, this.resolve(value), new Set());
  }

  private pattern(
    pattern: NodePath<t.Node>,
    name: string | undefined,
    values: ObjectReference[],
    seen: Set<t.Node>
  ): ObjectReference[] {
    this.visit();

    if (pattern.isIdentifier()) return pattern.node.name === name ? values : [];
    if (pattern.isMemberExpression()) return name === undefined ? values : [];
    if (pattern.isAssignmentPattern()) {
      return this.pattern(
        pattern.get("left"),
        name,
        this.originOptions.skippedPatternDefaults?.has(pattern.node)
          ? values
          : [...values, ...this.resolve(pattern.get("right"), seen)],
        seen
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

      return this.pattern(pattern.get("argument"), name, [copy], seen);
    }

    if (pattern.isArrayPattern()) {
      return pattern
        .get("elements")
        .flatMap((element, index) =>
          element.node
            ? this.pattern(
                element as NodePath<t.Node>,
                name,
                element.isRestElement()
                  ? values
                  : this.select(values, String(index), seen),
                seen
              )
            : []
        );
    }
    if (pattern.isObjectPattern()) {
      return pattern.get("properties").flatMap((property) => {
        if (property.isRestElement())
          return this.pattern(property, name, values, seen);
        if (!property.isObjectProperty()) return [];

        return this.pattern(
          property.get("value"),
          name,
          this.select(values, propertyName(property.node), seen),
          seen
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
    unknowns: Map<object, OriginUncertainty>;
  } {
    const unknowns = new Map<object, OriginUncertainty>();
    const nodes = new Set<object>();
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
    return { nodes, unknowns };
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
  const targetOrigins =
    "identifier" in target
      ? references.binding(target)
      : references.resolve(target);
  const unresolvedTarget = targetOrigins.find(
    (reference) => reference.uncertainty
  )?.uncertainty;
  if (unresolvedTarget) return { kind: "unknown", ...unresolvedTarget };
  const targets = references.reachable(targetOrigins);
  let unknown: OriginUncertainty | undefined;

  if (targets.size === 0) return { kind: "proved-unmodified" };

  const touchesObjects = (objects: ObjectReference[], deep = false) => {
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
        if (!targets.has(node)) continue;
        const uncertainty = proof.unknowns.get(node);
        if (uncertainty) unknown ??= uncertainty;
        else touched = true;
      }
    }
    return touched;
  };

  const touches = (path: NodePath<t.Node | null | undefined>, deep = false) =>
    touchesObjects(references.resolve(path), deep);

  const writes = (path: NodePath<t.Node | null | undefined>): boolean => {
    if (path.isMemberExpression() || path.isOptionalMemberExpression())
      return touches(child(path, "object"));
    if (path.isArrayPattern()) return path.get("elements").some(writes);
    if (path.isObjectPattern())
      return path
        .get("properties")
        .some((property) =>
          writes(
            property.isRestElement()
              ? property.get("argument")
              : property.get("value")
          )
        );
    if (path.isAssignmentPattern()) return writes(path.get("left"));
    if (path.isRestElement()) return writes(path.get("argument"));
    if (
      path.isParenthesizedExpression() ||
      path.isTSAsExpression() ||
      path.isTSTypeAssertion() ||
      path.isTSNonNullExpression() ||
      path.isTSSatisfiesExpression()
    )
      return writes(child(path, "expression"));

    return false;
  };

  let mutated = false;

  const mark = (path: NodePath<t.Node>) => {
    mutated = true;
    path.stop();
  };

  const checkCall = (
    path: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    >
  ) => {
    if (isKnownReadOnlyCall(path) || references.isEffectFreeLocalCall(path))
      return;

    const callee = child(path, "callee");
    const receiver =
      (callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
      touches(child(callee, "object"), true);

    const argumentEscapes = path
      .get("arguments")
      .some((argument) =>
        touches(
          argument.isSpreadElement() ? argument.get("argument") : argument,
          true
        )
      );
    if ((receiver || argumentEscapes) && !options.isReadOnlyCall?.(path))
      mark(path);
  };

  program.traverse({
    AssignmentExpression(path) {
      const target = getCjsAssignmentTarget(path.node.left, path.scope);
      const reexport =
        path.node.operator === "=" &&
        (target.kind === "property" || target.kind === "module-replacement");
      if (
        writes(path.get("left")) ||
        (!reexport &&
          touchesObjects(
            references.storedValues(path.get("left"), path.get("right")),
            true
          ))
      )
        mark(path);
    },

    UpdateExpression(path) {
      if (writes(path.get("argument"))) mark(path);
    },

    UnaryExpression(path) {
      if (path.node.operator === "delete" && writes(path.get("argument")))
        mark(path);
    },

    CallExpression: checkCall,
    OptionalCallExpression: checkCall,
    NewExpression: checkCall,

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

    "AwaitExpression|YieldExpression|TaggedTemplateExpression"(path) {
      // These observations may consume a target even when their result is
      // discarded. The origin proof, not a file-wide unsupported-syntax flag,
      // decides whether the uncertainty is relevant to this binding.
      touchesObjects(references.resolve(path), true);
    },

    ForInStatement(path) {
      if (writes(path.get("left"))) mark(path);
    },

    ForOfStatement(path) {
      if (writes(path.get("left"))) mark(path);
    }
  });

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

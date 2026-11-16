import { type NodePath, types as t } from "@babel/core";
import {
  isTransparentCssRuleWrapperExpression,
  unwrapTransparentCssRuleExpression
} from "../staticCssEval/candidates.js";
import { isSupportedStaticCssPrimitiveLiteral } from "../staticCssEval/sameFile/primitives.js";

/** A lowerer has selected this whole callback invocation for sidecar execution. */
export function markBuildEvaluation(call: t.CallExpression): t.CallExpression {
  call.extra = { ...call.extra, minchoEvaluationOwner: "build" };
  return call;
}

export function buildEvaluationOwner(
  path: NodePath<t.Node>
): NodePath<t.CallExpression> | undefined {
  // A returned/deferred nested function is not executed by its enclosing
  // build callback. Never search past the nearest function boundary.
  const callback = path.findParent((parent) => parent.isFunction());
  const owner = callback?.parentPath;
  return owner?.isCallExpression() &&
    owner.node.extra?.minchoEvaluationOwner === "build" &&
    owner.node.arguments.length === 1 &&
    owner.node.arguments[0] === callback?.node
    ? owner
    : undefined;
}

export type EvaluationProof = "pending" | "proven" | "unknown";

type Operand = {
  path: NodePath<t.Node>;
  execution: "eager" | "possible";
  use: "value" | "receiver" | "reference";
};

export type EvaluationStep =
  | { kind: "evaluate"; operand: Operand }
  | { kind: "coerce"; path: NodePath<t.Node> }
  | { kind: "observe"; path: NodePath<t.Node> };

export interface EvaluationPlan {
  kind: "known" | "unknown";
  operation: "inert" | "binding" | "call" | "observation";
  operands: Operand[];
  captures: NodePath<t.Node>[];
  steps: EvaluationStep[];
  result:
    | { kind: "identity" | "unknown" }
    | { kind: "primitive"; inputs: NodePath<t.Node>[] }
    | {
        kind: "operand";
        paths: NodePath<t.Node>[];
        inputs: NodePath<t.Node>[];
      };
  selectedBranches?: readonly NodePath<t.Expression>[];
  unexecutedBranches?: readonly NodePath<t.Node>[];
}

// Closed conditions and syntax plans are independent of caller proof callbacks.
// Keep them within one analysis so later AST changes cannot reuse stale facts.
interface EvaluationContext {
  plans: WeakMap<NodePath<t.Node>, EvaluationPlan>;
  conditions: WeakMap<NodePath<t.Node>, { value: unknown } | null>;
}

function createEvaluationContext(): EvaluationContext {
  return { plans: new WeakMap(), conditions: new WeakMap() };
}

/** Syntax discovery is exhaustive; an unsupported operation retains its children. */
function children(path: NodePath<t.Node>): NodePath<t.Node>[] {
  return (t.VISITOR_KEYS[path.node.type] ?? []).flatMap((key) => {
    if (
      [
        "typeAnnotation",
        "typeParameters",
        "typeArguments",
        "returnType"
      ].includes(key)
    )
      return [];
    const child = path.get(key) as NodePath<t.Node> | NodePath<t.Node>[];
    return (Array.isArray(child) ? child : [child]).filter(
      (item) =>
        item.node &&
        (item.isExpression() ||
          (!t.isTSType(item.node) && !t.isFlow(item.node)))
    );
  });
}

/**
 * Describe evaluation once for both owner discovery and order proofs. Captured
 * references are dependencies of a function value, not eager body execution.
 */
export function planEvaluation(
  path: NodePath<t.Node>,
  context = createEvaluationContext()
): EvaluationPlan {
  const previous = context.plans.get(path);
  if (previous) return previous;
  const operand = (
    value: NodePath<t.Node>,
    use: Operand["use"] = "value",
    execution: Operand["execution"] = "eager"
  ): Operand => ({ path: value, use, execution });
  const plan: EvaluationPlan = {
    kind: "known",
    operation: "inert",
    operands: children(path).map((child) => operand(child)),
    captures: [],
    steps: [],
    result: { kind: "unknown" }
  };

  let steps: EvaluationStep[] | undefined;
  const evaluate = (value: Operand): EvaluationStep => ({
    kind: "evaluate",
    operand: value
  });
  const coerce = (value: NodePath<t.Node>): EvaluationStep => ({
    kind: "coerce",
    path: value
  });
  const observe = (): EvaluationStep => ({ kind: "observe", path });

  if (path.isExpression() && isTransparentCssRuleWrapperExpression(path.node)) {
    plan.operands = [operand(path.get("expression") as NodePath<t.Node>)];
    plan.result = {
      kind: "operand",
      paths: plan.operands.map(({ path }) => path),
      inputs: []
    };
  } else if (
    path.isIfStatement() ||
    path.isConditionalExpression() ||
    path.isLogicalExpression()
  ) {
    const test = (
      path.isLogicalExpression() ? path.get("left") : path.get("test")
    ) as NodePath<t.Expression>;
    const condition = primitiveCondition(test, context);
    let selected: NodePath<t.Node>[] | undefined;
    if (condition) {
      if (path.isLogicalExpression()) {
        const readsRight =
          path.node.operator === "&&"
            ? Boolean(condition.value)
            : path.node.operator === "||"
              ? !condition.value
              : condition.value == null;
        selected = readsRight ? [test, path.get("right")] : [test];
        plan.unexecutedBranches = readsRight ? [] : [path.get("right")];
      } else {
        const branch = path.get(
          condition.value ? "consequent" : "alternate"
        ) as NodePath<t.Node | null>;
        const excluded = path.get(
          condition.value ? "alternate" : "consequent"
        ) as NodePath<t.Node | null>;
        selected = [test, ...(branch.node ? [branch as NodePath<t.Node>] : [])];
        plan.unexecutedBranches = excluded.node
          ? [excluded as NodePath<t.Node>]
          : [];
      }
    }
    if (selected) {
      if (path.isExpression())
        plan.selectedBranches = selected as NodePath<t.Expression>[];
      plan.operands = selected.map((branch) => operand(branch));
      if (path.isExpression())
        plan.result = {
          kind: "operand",
          paths: [selected[selected.length - 1]!],
          inputs: [selected[0]!]
        };
    } else {
      plan.operands = children(path).map((child, index) =>
        operand(child, "value", index === 0 ? "eager" : "possible")
      );
      if (path.isExpression())
        plan.result = {
          kind: "operand",
          paths: path.isConditionalExpression()
            ? [path.get("consequent"), path.get("alternate")]
            : [path.get("left"), path.get("right")],
          inputs: [plan.operands[0]!.path]
        };
    }
  } else if (path.isBlockStatement() || path.isReturnStatement()) {
    // Proving every statement inert is conservative across an early return.
    // Unknown control flow or observations keep the entire proof unknown.
  } else if (path.isClass()) {
    plan.result = { kind: "identity" };
    if (
      path.node.superClass ||
      path.node.decorators?.length ||
      path.node.body.body.length
    )
      plan.kind = "unknown";
    else plan.operands = [];
  } else if (path.isFunction()) {
    plan.result = { kind: "identity" };
    plan.operands = children(path)
      .filter(
        (child) =>
          child.key !== "body" &&
          child.key !== "id" &&
          child.listKey !== "params" &&
          (child.key !== "key" ||
            ("computed" in path.node && path.node.computed))
      )
      .map((child) => operand(child));
    steps = plan.operands.flatMap((value) =>
      value.path.key === "key"
        ? [evaluate(value), coerce(value.path)]
        : [evaluate(value)]
    );
    const capture = (reference: NodePath<t.Node>) => {
      if (
        plan.operands.some(
          ({ path: eager }) =>
            reference === eager ||
            reference.findParent((parent) => parent === eager)
        )
      )
        return;
      plan.captures.push(reference);
    };
    path.traverse({
      ReferencedIdentifier(reference) {
        capture(reference);
      },
      "ThisExpression|Super|MetaProperty"(reference) {
        capture(reference);
      }
    });
  } else if (path.isObjectProperty()) {
    plan.operands = children(path)
      .filter((child) => child.key !== "key" || path.node.computed)
      .map((child) => operand(child));
    steps = plan.operands.flatMap((value) =>
      value.path.key === "key"
        ? [evaluate(value), coerce(value.path)]
        : [evaluate(value)]
    );
  } else if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    const member: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
      path;
    plan.operation = "observation";
    plan.operands = [
      operand(member.get("object"), "receiver"),
      ...(member.node.computed
        ? [
            operand(
              member.get("property"),
              "value",
              member.isOptionalMemberExpression() ? "possible" : "eager"
            )
          ]
        : [])
    ];
    steps = plan.operands.flatMap((value) =>
      value.path.key === "property"
        ? [evaluate(value), coerce(value.path)]
        : [evaluate(value)]
    );
    steps.push(observe());
  } else if (path.isTemplateLiteral()) {
    plan.operands = path.get("expressions").map((value) => operand(value));
    plan.result = {
      kind: "primitive",
      inputs: plan.operands.map(({ path }) => path)
    };
    steps = path.parentPath?.isTaggedTemplateExpression()
      ? plan.operands.map(evaluate)
      : plan.operands.flatMap((value) => [evaluate(value), coerce(value.path)]);
  } else if (path.isUnaryExpression()) {
    if (path.node.operator === "delete") plan.operation = "observation";
    plan.operands = [
      operand(
        path.get("argument"),
        path.node.operator === "delete" ? "reference" : "value"
      )
    ];
    plan.result = {
      kind: "primitive",
      inputs: plan.operands.map(({ path }) => path)
    };
    steps = plan.operands.map(evaluate);
    if (["+", "-", "~"].includes(path.node.operator))
      steps.push(coerce(path.get("argument")));
    if (plan.operation === "observation") steps.push(observe());
  } else if (path.isBinaryExpression()) {
    plan.result = {
      kind: "primitive",
      inputs: plan.operands.map(({ path }) => path)
    };
    steps = plan.operands.map(evaluate);
    // Both operand values are evaluated before numeric/string coercion begins.
    if (["in", "instanceof"].includes(path.node.operator)) {
      plan.operation = "observation";
      steps.push(observe());
    } else if (!["===", "!=="].includes(path.node.operator)) {
      steps.push(...plan.operands.map((value) => coerce(value.path)));
    }
  } else if (path.isAssignmentExpression() || path.isUpdateExpression()) {
    plan.operation = "observation";
    plan.operands = plan.operands.map((value, index) => ({
      ...value,
      use: index === 0 ? "reference" : "value",
      execution:
        index > 0 &&
        path.isAssignmentExpression() &&
        ["&&=", "||=", "??="].includes(path.node.operator)
          ? "possible"
          : "eager"
    }));
    steps = [...plan.operands.map(evaluate), observe()];
    // Compound assignment reads the old value before evaluating its RHS.
    // Forming a reference alone does not prove that GetValue is inert.
    if (path.isAssignmentExpression() && path.node.operator !== "=")
      steps.splice(1, 0, { kind: "observe", path: path.get("left") });
  } else if (path.isIdentifier()) {
    plan.operation = "binding";
  } else if (
    path.isCallExpression() ||
    path.isOptionalCallExpression() ||
    path.isNewExpression() ||
    path.isTaggedTemplateExpression()
  ) {
    plan.operation = "call";
    if (path.isOptionalCallExpression())
      plan.operands = plan.operands.map((value) => ({
        ...value,
        execution: value.path.listKey === "arguments" ? "possible" : "eager"
      }));
  } else if (
    path.isSpreadElement() ||
    path.isAwaitExpression() ||
    path.isYieldExpression()
  ) {
    // Enumeration, iteration, writes, and suspension are observations even if
    // their operands are known or their resulting value is later discarded.
    plan.operation = "observation";
  } else if (path.isLiteral()) {
    plan.result = path.isRegExpLiteral()
      ? { kind: "identity" }
      : { kind: "primitive", inputs: [] };
  } else if (path.isObjectExpression() || path.isArrayExpression()) {
    plan.result = { kind: "identity" };
  } else if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    plan.result = {
      kind: "operand",
      paths: [expressions[expressions.length - 1]!],
      inputs: []
    };
  } else {
    plan.kind = "unknown";
    plan.operation = "observation";
    plan.operands = plan.operands.map((value) => ({
      ...value,
      execution: "possible"
    }));
  }

  plan.steps = steps ?? plan.operands.map(evaluate);
  if (!steps && (plan.operation === "observation" || plan.operation === "call"))
    plan.steps.push(observe());
  context.plans.set(path, plan);
  return plan;
}

export interface EvaluationRequirements {
  replay: (path: NodePath<t.Node>) => EvaluationProof;
  binding: (path: NodePath<t.Identifier>) => EvaluationProof;
  /** Reference formation only; this does not prove GetValue or a later write. */
  reference?: (path: NodePath<t.Node>) => EvaluationProof;
  observe?: (path: NodePath<t.Node>) => EvaluationProof;
  coerce?: (path: NodePath<t.Node>) => EvaluationProof;
  sharedValue?: (path: NodePath<t.Identifier>) => EvaluationProof;
}

/** Prove the operations that have already happened before a selected operand. */
export function proveEvaluationSteps(
  steps: readonly EvaluationStep[],
  requirements: EvaluationRequirements,
  allowReplay = true,
  context = createEvaluationContext()
): EvaluationProof {
  let result: EvaluationProof = "proven";
  for (const step of steps) {
    let proof: EvaluationProof;
    if (step.kind === "observe") {
      proof = requirements.observe?.(step.path) ?? "unknown";
    } else if (step.kind === "coerce") {
      proof =
        step.path.isExpression() &&
        isSupportedStaticCssPrimitiveLiteral(
          unwrapTransparentCssRuleExpression(step.path.node)
        )
          ? "proven"
          : (requirements.coerce?.(step.path) ?? "unknown");
    } else if (step.operand.use === "reference") {
      // Forming a lexical reference does not read its current value. Property
      // references can invoke key conversion or fail, and need a separate proof.
      proof = step.operand.path.isIdentifier()
        ? "proven"
        : (requirements.reference?.(step.operand.path) ?? "unknown");
    } else {
      proof = proveEvaluationOrder(
        step.operand.path,
        requirements,
        allowReplay && step.operand.execution === "eager",
        context
      );
    }
    if (proof === "unknown") return "unknown";
    if (proof === "pending") result = "pending";
  }
  return result;
}

/** A replay proof concerns the call; it never proves hooks on its result inert. */
export function proveEvaluationOrder(
  path: NodePath<t.Node>,
  requirements: EvaluationRequirements,
  allowReplay = true,
  context = createEvaluationContext()
): EvaluationProof {
  if (!path.node) return "proven";
  const plan = planEvaluation(path, context);
  if (plan.kind === "unknown") return "unknown";
  if (plan.operation === "call")
    return allowReplay ? requirements.replay(path) : "unknown";
  if (plan.operation === "binding" && path.isIdentifier()) {
    const replayed = requirements.replay(path);
    return replayed !== "unknown" ? replayed : requirements.binding(path);
  }
  return proveEvaluationSteps(plan.steps, requirements, allowReplay, context);
}

/**
 * Inert creation does not prove that a previously allocated value is shared
 * between the sidecar and runtime. Accept a closed primitive computation or
 * explicit evidence of the same generated binding; replay alone is insufficient.
 */
export function proveStableEvaluationValue(
  path: NodePath<t.Node>,
  requirements: EvaluationRequirements,
  context = createEvaluationContext()
): EvaluationProof {
  const shared = path.isIdentifier()
    ? (requirements.sharedValue?.(path) ?? "unknown")
    : "unknown";
  if (shared !== "unknown") return shared;
  const plan = planEvaluation(path, context);
  if (plan.kind === "unknown") return "unknown";
  if (plan.operation === "binding" && path.isIdentifier())
    return requirements.binding(path);
  let result: EvaluationProof = "proven";
  if (plan.result.kind !== "operand" && plan.result.kind !== "primitive")
    return "unknown";
  // A logical expression can both test and return the same operand. Prove
  // each dependency once; duplicating it at every level is exponential.
  for (const value of new Set([
    ...(plan.result.kind === "operand" ? plan.result.paths : []),
    ...plan.result.inputs
  ])) {
    const proof = proveStableEvaluationValue(value, requirements, context);
    if (proof === "unknown") return "unknown";
    if (proof === "pending") result = "pending";
  }
  const order = proveEvaluationOrder(path, requirements, true, context);
  return order === "unknown"
    ? "unknown"
    : order === "pending" || result === "pending"
      ? "pending"
      : "proven";
}

/** A binding read needs initialization and a stable value, not only const syntax. */
export function proveInitializedBindingValue(
  identifier: NodePath<t.Identifier>,
  requirements: EvaluationRequirements,
  visiting: Set<t.Node>
): EvaluationProof {
  const binding = identifier.scope.getBinding(identifier.node.name);
  if (
    !binding?.constant ||
    binding.kind !== "const" ||
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id) ||
    binding.path.node.end == null ||
    identifier.node.start == null ||
    binding.path.node.end > identifier.node.start ||
    visiting.has(binding.path.node)
  )
    return "unknown";
  const initializer = binding.path.get("init");
  if (!initializer.isExpression()) return "unknown";
  visiting.add(binding.path.node);
  try {
    return proveStableEvaluationValue(initializer, requirements);
  } finally {
    visiting.delete(binding.path.node);
  }
}

function primitiveCondition(
  path: NodePath<t.Expression>,
  context: EvaluationContext
): { value: unknown } | undefined {
  if (context.conditions.has(path))
    return context.conditions.get(path) ?? undefined;
  // Branch exclusion needs closed literal evidence. Babel's constant flag
  // does not account for direct eval or a var initializer that never runs.
  const requirements: EvaluationRequirements = {
    replay: () => "unknown",
    binding: () => "unknown"
  };
  context.conditions.set(path, null);
  if (proveStableEvaluationValue(path, requirements, context) !== "proven")
    return;
  const evaluated = path.evaluate();
  if (
    evaluated.confident &&
    (evaluated.value === null ||
      (typeof evaluated.value !== "object" &&
        typeof evaluated.value !== "function"))
  ) {
    const result = { value: evaluated.value };
    context.conditions.set(path, result);
    return result;
  }
}

/** A deferred body is not dead code; only an excluded branch supplies evidence. */
export function isProvablyUnexecuted(path: NodePath<t.Node>): boolean {
  let child = path;
  let excluded = false;
  const context = createEvaluationContext();
  for (let parent = path.parentPath; parent; parent = parent.parentPath) {
    if (parent.isFunction() || parent.isClass()) return excluded;
    if (
      parent.isIfStatement() ||
      parent.isConditionalExpression() ||
      parent.isLogicalExpression()
    ) {
      const plan = planEvaluation(parent, context);
      excluded ||= Boolean(
        plan.unexecutedBranches?.some((branch) => branch.node === child.node)
      );
    }
    child = parent;
  }
  return excluded;
}

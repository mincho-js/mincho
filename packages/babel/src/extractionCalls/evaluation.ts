import {
  collectRuntimeSourceEvidence,
  isRuntimeSourceReference
} from "../optimizations/runtimeSourceReference.js";
import { isWriteTarget } from "./closedAllocation.js";
import { isWriteTarget as isReferenceWriteTarget } from "../commonjs/bindings.js";
import { traverse, type NodePath, types as t } from "@babel/core";
import {
  isTransparentCssRuleWrapperExpression,
  unwrapTransparentCssRuleExpression
} from "../staticCssEval/candidates.js";
import { isSupportedStaticCssPrimitiveLiteral } from "../staticCssEval/sameFile/primitives.js";

/** Type-only `this` is erased; every other supported parameter keeps its slot. */
export function runtimeParameterOffset(
  parameters: readonly t.Node[]
): number | undefined {
  const first = parameters[0];
  const offset =
    t.isIdentifier(first, { name: "this" }) &&
    t.isTSTypeAnnotation(first.typeAnnotation)
      ? 1
      : 0;
  const names = new Set<string>();
  for (const parameter of parameters.slice(offset)) {
    if (!t.isIdentifier(parameter)) continue;
    if (parameter.name === "this" || names.has(parameter.name)) return;
    names.add(parameter.name);
  }
  return offset;
}

/** A lowerer has selected this whole callback invocation for sidecar execution. */
export function markBuildEvaluation(call: t.CallExpression): t.CallExpression {
  call.extra = { ...call.extra, minchoEvaluationOwner: "build" };
  return call;
}

/** Legacy decorators live on the formal or its binding wrappers, never on its default. */
function* parameterDecorators(
  path: NodePath<t.Node>
): Generator<NodePath<t.Decorator>> {
  const decorators = path.get("decorators");
  if (Array.isArray(decorators))
    for (const decorator of decorators)
      if (decorator.isDecorator()) yield decorator;
  if (path.isAssignmentPattern()) yield* parameterDecorators(path.get("left"));
  if (path.isTSParameterProperty())
    yield* parameterDecorators(path.get("parameter"));
}

export function buildEvaluationOwner(
  path: NodePath<t.Node>
): NodePath<t.CallExpression> | undefined {
  // A returned/deferred nested function is not executed by its enclosing
  // build callback. Never search past the nearest function boundary.
  let callback: NodePath<t.Node> | undefined;
  let decorator: t.Decorator | undefined;
  for (
    let child = path, parent = path.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (child.isDecorator()) decorator = child.node;
    // Instance values are evaluated by construction, not class creation.
    // Computed keys remain eager, as do static fields/blocks and extends.
    if (
      (parent.isClassProperty() ||
        parent.isClassPrivateProperty() ||
        parent.isClassAccessorProperty()) &&
      !parent.node.static &&
      parent.node.value === child.node
    )
      return;
    if (parent.isFunction()) {
      // Decorator expressions run while defining the class, not invoking its method.
      if (
        (parent.isClassMethod() || parent.isClassPrivateMethod()) &&
        ((child.isDecorator() &&
          parent.node.decorators?.includes(child.node)) ||
          (decorator &&
            child.listKey === "params" &&
            [...parameterDecorators(child)].some(
              (candidate) => candidate.node === decorator
            )))
      )
        continue;
      if (
        (parent.isObjectMethod() || parent.isClassMethod()) &&
        parent.node.computed &&
        parent.node.key === child.node
      )
        continue;
      callback = parent;
      break;
    }
  }
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
  | {
      kind: "coerce";
      path: NodePath<t.Node>;
      propertyKey?: {
        after: NodePath<t.Node>;
        requiresObject?: NodePath<t.Node>;
        receiver?: NodePath<t.Expression>;
      };
      valueConversion?: {
        after: NodePath<t.Expression>;
        hint: "default" | "number";
      };
    }
  | {
      kind: "observe";
      path: NodePath<t.Node>;
      invocation?: { callee: NodePath<t.Node> };
      sourceDelivery?: {
        after: NodePath<t.Expression>;
        kind: "sync-iterator" | "async-iterator" | "binding-pattern";
        pattern?: NodePath<t.Node>;
      };
      copyMembers?: { after: NodePath<t.Expression> };
    }
  | { kind: "abrupt"; path: NodePath<t.Node> }
  | { kind: "apply-decorator"; path: NodePath<t.Decorator> };

type ReturnCompletion = "normal" | "possible-return" | "return";

export interface EvaluationPlan {
  returnCompletion?: ReturnCompletion;
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
  bindingsCurrent?: () => boolean;
  callCondition?: (
    call: NodePath<t.CallExpression>
  ) => { value: unknown } | undefined;
  outcomes: WeakMap<NodePath<t.Expression>, BranchOutcome | null>;
  plans: WeakMap<NodePath<t.Node>, EvaluationPlan>;
  conditions: WeakMap<NodePath<t.Node>, { value: unknown } | null>;
  closedOrder: WeakMap<NodePath<t.Node>, Map<boolean, EvaluationProof>>;
  closedStable: WeakMap<NodePath<t.Node>, Map<boolean, EvaluationProof>>;
}

function createEvaluationContext(): EvaluationContext {
  return {
    outcomes: new WeakMap(),
    plans: new WeakMap(),
    conditions: new WeakMap(),
    closedOrder: new WeakMap(),
    closedStable: new WeakMap()
  };
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
 * A definition converts immediately after evaluating its key; `in` after
 * both operands; a computed read after its receiver and key. An assignment
 * separately observes PutValue after the RHS; compound assignments also do
 * GetValue before the RHS. Reference formation alone does neither.
 */
export function propertyKeyStep(
  path: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "coerce" }> | undefined {
  if (
    (path.isObjectMethod() || path.isObjectProperty()) &&
    path.node.computed &&
    path.parentPath.isObjectExpression()
  ) {
    const key = path.get("key") as NodePath<t.Node>;
    return { kind: "coerce", path: key, propertyKey: { after: key } };
  }
  if (path.isBinaryExpression({ operator: "in" })) {
    const right = path.get("right");
    return {
      kind: "coerce",
      path: path.get("left"),
      propertyKey: { after: right, requiresObject: right }
    };
  }
  // Only an actual consuming operation should convert a member key.
  if (
    path.isAssignmentExpression() &&
    !logicalAssignmentOperator(path.node.operator)
  )
    return computedMemberKey(path.get("left"), path.get("right"));
  if (path.isUpdateExpression())
    return computedMemberKey(path.get("argument"), path.get("argument"));
  if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
    let wrapped: NodePath<t.Node> = path;
    let consumer = wrapped.parentPath;
    while (
      consumer?.isExpression() &&
      isTransparentCssRuleWrapperExpression(consumer.node) &&
      consumer.node.expression === wrapped.node
    ) {
      wrapped = consumer;
      consumer = wrapped.parentPath;
    }
    const readsOrDeletes =
      (consumer?.isAssignmentExpression() &&
        consumer.node.left === wrapped.node &&
        consumer.node.operator !== "=") ||
      consumer?.isUpdateExpression() ||
      consumer?.isUnaryExpression({ operator: "delete" });
    if (!isReferenceWriteTarget(path) || readsOrDeletes)
      return computedMemberKey(path);
  }
}

function computedMemberKey(
  path: NodePath<t.Node>,
  after?: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "coerce" }> | undefined {
  while (
    path.isExpression() &&
    isTransparentCssRuleWrapperExpression(path.node)
  )
    path = path.get("expression") as NodePath<t.Node>;
  if (
    (!path.isMemberExpression() && !path.isOptionalMemberExpression()) ||
    !path.node.computed
  )
    return;
  const member: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
    path;
  const property = member.get("property");
  const receiver = member.get("object");
  if (receiver.isExpression())
    return {
      kind: "coerce",
      path: property,
      propertyKey: { after: after ?? property, receiver }
    };
}

// Apply the compound operator to the earlier GetValue and the now evaluated
// RHS, before forming the eventual write. Logical assignments only select
// and store a value; they never run this conversion.
export function orderedValueConversionSteps(
  path: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "coerce" }>[] | undefined {
  if (path.isUpdateExpression()) {
    const argument = path.get("argument");
    return [
      {
        kind: "coerce",
        path: argument,
        valueConversion: { after: argument, hint: "number" }
      }
    ];
  }
  if (path.isBinaryExpression()) {
    const { operator } = path.node;
    const left = path.get("left");
    if (
      !left.isExpression() ||
      ["in", "instanceof", "===", "!==", "|>"].includes(operator)
    )
      return;
    const right = path.get("right");
    const hint =
      operator === "+" || operator === "==" || operator === "!="
        ? "default"
        : "number";
    return [left, right].map((value) => ({
      kind: "coerce",
      path: value,
      valueConversion: { after: right, hint }
    }));
  }
  if (
    !path.isAssignmentExpression() ||
    ["=", "&&=", "||=", "??="].includes(path.node.operator)
  )
    return;
  const right = path.get("right");
  const hint = path.node.operator === "+=" ? "default" : "number";
  return [path.get("left"), right].map((value) => ({
    kind: "coerce",
    path: value,
    valueConversion: { after: right, hint }
  }));
}

/** The selected callable is evaluated before its arguments or substitutions. */
export function invocationStep(
  path: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "observe" }> | undefined {
  const callee = path.isTaggedTemplateExpression()
    ? path.get("tag")
    : path.isCallExpression() ||
        path.isOptionalCallExpression() ||
        path.isNewExpression()
      ? path.get("callee")
      : undefined;
  if (callee && !Array.isArray(callee) && callee.node)
    return { kind: "observe", path, invocation: { callee } };
}

export function patternObservesDelivery(pattern: t.Node): boolean {
  if (t.isArrayPattern(pattern)) return true;
  if (t.isObjectPattern(pattern))
    return pattern.properties.some(
      (property) =>
        (!t.isRestElement(property) && property.computed) ||
        patternObservesDelivery(
          t.isRestElement(property) ? property.argument : property.value
        )
    );
  if (t.isAssignmentPattern(pattern))
    return patternObservesDelivery(pattern.left);
  if (t.isRestElement(pattern))
    return patternObservesDelivery(pattern.argument);
  return false;
}

/** A default changes the delivered value, not the reads of its target. */
export function bindingPatternReadsSource(pattern: t.Node): boolean {
  return t.isAssignmentPattern(pattern)
    ? bindingPatternReadsSource(pattern.left)
    : t.isArrayPattern(pattern) || t.isObjectPattern(pattern);
}

export function sourceDeliveryStep(
  path: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "observe" }> | undefined {
  if (
    path.isSpreadElement() &&
    (path.parentPath.isArrayExpression() ||
      (path.listKey === "arguments" &&
        (path.parentPath.isCallExpression() ||
          path.parentPath.isOptionalCallExpression() ||
          path.parentPath.isNewExpression())))
  )
    return {
      kind: "observe",
      path,
      sourceDelivery: { after: path.get("argument"), kind: "sync-iterator" }
    };
  const pattern = path.isVariableDeclarator()
    ? path.get("id")
    : path.isAssignmentExpression()
      ? path.get("left")
      : undefined;
  // Object binding reads its selected own properties even when the local
  // destination is never referenced. Nested iterator demand is independent.
  if (pattern && bindingPatternReadsSource(pattern.node)) {
    const value = path.isVariableDeclarator()
      ? path.get("init")
      : path.isAssignmentExpression()
        ? path.get("right")
        : undefined;
    if (value?.isExpression())
      return {
        kind: "observe",
        path: pattern,
        sourceDelivery: { after: value, kind: "binding-pattern", pattern }
      };
  }
  if (path.isForOfStatement()) {
    const left = path.get("left");
    const target = left.isVariableDeclaration()
      ? left.get("declarations")[0]?.get("id")
      : left;
    return {
      kind: "observe",
      path,
      sourceDelivery: {
        after: path.get("right"),
        kind: path.node.await ? "async-iterator" : "sync-iterator",
        ...(target && bindingPatternReadsSource(target.node)
          ? { pattern: target }
          : {})
      }
    };
  }
}

/** CopyDataProperties reads enumerable own accessors after its source. */
export function objectSpreadStep(
  path: NodePath<t.Node>
): Extract<EvaluationStep, { kind: "observe" }> | undefined {
  if (path.isSpreadElement() && path.parentPath.isObjectExpression())
    return {
      kind: "observe",
      path,
      copyMembers: { after: path.get("argument") }
    };
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
    const condition = normalBranchOutcome(test, context);
    let selected: NodePath<t.Node>[] | undefined;
    if (condition) {
      if (path.isLogicalExpression()) {
        const readsRight = selectsLogicalRight(path.node.operator, condition);
        selected = readsRight ? [test, path.get("right")] : [test];
        plan.unexecutedBranches = readsRight ? [] : [path.get("right")];
      } else {
        const branch = path.get(
          condition.truthy ? "consequent" : "alternate"
        ) as NodePath<t.Node | null>;
        const excluded = path.get(
          condition.truthy ? "alternate" : "consequent"
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
    if (path.isIfStatement()) {
      const completion = (branch?: NodePath<t.Node>) =>
        branch?.isReturnStatement() ||
        branch?.isIfStatement() ||
        branch?.isBlockStatement()
          ? (planEvaluation(branch, context).returnCompletion ?? "normal")
          : "normal";
      if (selected) {
        plan.returnCompletion = completion(selected[1]);
      } else {
        const yes = completion(path.get("consequent"));
        const no = completion(path.get("alternate") as NodePath<t.Node>);
        plan.returnCompletion = yes === no ? yes : "possible-return";
      }
    }
  } else if (path.isBlockStatement()) {
    let completion: ReturnCompletion = "normal";
    steps = [];
    plan.operands = plan.operands.map((value) => {
      if (completion !== "normal") value = { ...value, execution: "possible" };
      if (completion !== "return") {
        steps!.push(evaluate(value));
        const child = value.path;
        const next =
          child.isReturnStatement() ||
          child.isIfStatement() ||
          child.isBlockStatement()
            ? planEvaluation(child, context).returnCompletion
            : undefined;
        if (next === "return") completion = "return";
        else if (next === "possible-return") completion = "possible-return";
      }
      return value;
    });
    plan.returnCompletion = completion;
  } else if (path.isReturnStatement()) {
    plan.returnCompletion = "return";
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
    const applications: EvaluationStep[] = [];
    if (path.isClassMethod() || path.isClassPrivateMethod()) {
      const parameters = path.get("params");
      if (Array.isArray(parameters))
        for (const parameter of parameters)
          for (const decorator of parameterDecorators(parameter)) {
            plan.operands.push(operand(decorator.get("expression")));
            applications.push({ kind: "apply-decorator", path: decorator });
          }
    }
    steps = plan.operands.flatMap((value) =>
      value.path.key === "key"
        ? [evaluate(value), propertyKeyStep(path) ?? coerce(value.path)]
        : [evaluate(value)]
    );
    steps.push(...applications);
    const capture = (reference: NodePath<t.Node>) => {
      if (!isRuntimeSourceReference(reference)) return;
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
      Identifier(reference) {
        if (reference.isReferencedIdentifier() || isWriteTarget(reference))
          capture(reference);
      },
      JSXIdentifier(reference) {
        // Only the opening tag's root is a lexical read. Intrinsic tags and
        // member properties are not bindings; closing tags duplicate the use.
        let tag: NodePath<t.Node> = reference;
        let member = false;
        while (
          tag.parentPath?.isJSXMemberExpression() &&
          tag.parentPath.node.object === tag.node
        ) {
          member = true;
          tag = tag.parentPath;
        }
        if (
          tag.parentPath?.isJSXOpeningElement() &&
          tag.parentPath.node.name === tag.node &&
          (member ||
            reference.node.name === "this" ||
            !t.react.isCompatTag(reference.node.name))
        )
          capture(reference);
      },
      "ThisExpression|Super|MetaProperty|PrivateName"(reference) {
        capture(reference);
      }
    });
  } else if (path.isObjectProperty()) {
    plan.operands = children(path)
      .filter((child) => child.key !== "key" || path.node.computed)
      .map((child) => operand(child));
    steps = plan.operands.flatMap((value) =>
      value.path.key === "key"
        ? [evaluate(value), propertyKeyStep(path) ?? coerce(value.path)]
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
        ? [evaluate(value), propertyKeyStep(path) ?? coerce(value.path)]
        : [evaluate(value)]
    );
    steps.push(observe());
  } else if (path.isTemplateLiteral()) {
    plan.operands = path.get("expressions").map((value) => operand(value));
    const tagged =
      path.parentPath?.isTaggedTemplateExpression() &&
      path.parentPath.node.quasi === path.node;
    // GetTemplateObject supplies site identity, not the interpolated string.
    plan.result = tagged
      ? { kind: "identity" }
      : {
          kind: "primitive",
          inputs: plan.operands.map(({ path }) => path)
        };
    steps = tagged
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
    if (path.node.operator === "delete") {
      const key = computedMemberKey(path.get("argument"));
      if (key) steps.push(key);
    }
    if (plan.operation === "observation") steps.push(observe());
    if (
      path.node.operator === "throw" ||
      (path.node.operator === "+" &&
        t.isBigIntLiteral(
          unwrapTransparentCssRuleExpression(path.node.argument)
        ))
    ) {
      steps.push({ kind: "abrupt", path });
      plan.result = { kind: "unknown" };
    }
  } else if (path.isBinaryExpression({ operator: "|>" })) {
    // Parser extensions may encode an arbitrary invocation as a binary node.
    // Its normal return value is not constrained to a primitive.
    plan.kind = "unknown";
  } else if (path.isBinaryExpression()) {
    plan.result = {
      kind: "primitive",
      inputs: plan.operands.map(({ path }) => path)
    };
    steps = plan.operands.map(evaluate);
    // Both operand values are evaluated before numeric/string coercion begins.
    if (["in", "instanceof"].includes(path.node.operator)) {
      plan.operation = "observation";
      const propertyKey = propertyKeyStep(path);
      if (propertyKey) steps.push(propertyKey);
      steps.push(observe());
    } else if (!["===", "!=="].includes(path.node.operator)) {
      steps.push(...(orderedValueConversionSteps(path) ?? []));
      const { operator, left, right } = path.node;
      const dividend = t.isExpression(left)
        ? unwrapTransparentCssRuleExpression(left)
        : left;
      const divisor = unwrapTransparentCssRuleExpression(right);
      // A coercion receipt does not make BigInt division or remainder by zero
      // complete. This bounded check inspects only literal operands.
      if (
        (operator === "/" || operator === "%") &&
        t.isBigIntLiteral(dividend) &&
        t.isBigIntLiteral(divisor) &&
        /^(?:0[xob])?0+$/i.test(divisor.value.replaceAll("_", ""))
      ) {
        steps.push({ kind: "abrupt", path });
        plan.result = { kind: "unknown" };
      }
    }
  } else if (
    path.isAssignmentExpression() &&
    (path.get("left").isObjectPattern() || path.get("left").isArrayPattern())
  ) {
    plan.operation = "observation";
    plan.operands = [
      operand(path.get("right")),
      operand(path.get("left"), "reference")
    ];
    steps = [
      evaluate(plan.operands[0]),
      sourceDeliveryStep(path) ?? {
        kind: "observe",
        path: path.get("left")
      }
    ];
  } else if (path.isAssignmentExpression() || path.isUpdateExpression()) {
    plan.operation = "observation";
    const target = path.isAssignmentExpression() ? path.node.left : undefined;
    const optionalTarget =
      t.isExpression(target) &&
      t.isOptionalMemberExpression(unwrapTransparentCssRuleExpression(target));
    plan.operands = plan.operands.map((value, index) => ({
      ...value,
      use: index === 0 ? "reference" : "value",
      execution:
        index > 0 &&
        path.isAssignmentExpression() &&
        (optionalTarget || ["&&=", "||=", "??="].includes(path.node.operator))
          ? "possible"
          : "eager"
    }));
    steps = [...plan.operands.map(evaluate), observe()];
    // Compound assignment reads the old value before evaluating its RHS.
    // Forming a reference alone does not prove that GetValue is inert.
    if (path.isAssignmentExpression()) {
      if (path.node.operator !== "=") {
        const left = path.get("left");
        const keyRead = computedMemberKey(left);
        steps.splice(1, 0, ...(keyRead ? [keyRead] : []), {
          kind: "observe",
          path: left
        });
      }
      const conversions = orderedValueConversionSteps(path);
      if (conversions) steps.splice(steps.length - 1, 0, ...conversions);
      const keyWrite = propertyKeyStep(path);
      if (keyWrite) steps.splice(steps.length - 1, 0, keyWrite);
    } else {
      const argument = path.get("argument");
      const keyRead = computedMemberKey(argument);
      const keyWrite = propertyKeyStep(path);
      steps.splice(
        1,
        0,
        ...(keyRead ? [keyRead] : []),
        { kind: "observe", path: argument },
        ...(orderedValueConversionSteps(path) ?? []),
        ...(keyWrite ? [keyWrite] : [])
      );
    }
  } else if (path.isIdentifier()) {
    plan.operation = "binding";
  } else if (
    path.isCallExpression() ||
    path.isOptionalCallExpression() ||
    path.isNewExpression() ||
    path.isTaggedTemplateExpression()
  ) {
    plan.operation = "call";
    if (path.isOptionalCallExpression()) {
      const callee = path.get("callee");
      if (
        path.node.optional &&
        callee.isExpression() &&
        normalBranchOutcome(callee, context)?.nullish === true
      ) {
        plan.unexecutedBranches = path.get("arguments");
        plan.operands = [operand(callee)];
        steps = plan.operands.map(evaluate);
      } else {
        plan.operands = plan.operands.map((value) => ({
          ...value,
          execution: value.path.listKey === "arguments" ? "possible" : "eager"
        }));
      }
    }
  } else if (path.isVariableDeclarator() && sourceDeliveryStep(path)) {
    plan.operation = "observation";
    const iteration = sourceDeliveryStep(path)!;
    const value = operand(iteration.sourceDelivery!.after);
    const target = operand(path.get("id"), "reference", "possible");
    plan.operands = [value, target];
    steps = [evaluate(value), iteration, evaluate(target)];
  } else if (path.isForOfStatement()) {
    const right = operand(path.get("right"));
    const left = operand(path.get("left"), "reference", "possible");
    const body = operand(path.get("body"), "value", "possible");
    plan.operation = "observation";
    plan.operands = [right, left, body];
    steps = [
      evaluate(right),
      sourceDeliveryStep(path)!,
      evaluate(left),
      evaluate(body)
    ];
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
    plan.steps.push(
      sourceDeliveryStep(path) ??
        objectSpreadStep(path) ??
        invocationStep(path) ??
        observe()
    );
  context.plans.set(path, plan);
  return plan;
}

export interface EvaluationRequirements {
  replay: (path: NodePath<t.Node>) => EvaluationProof;
  /** Reading the binding at this position is safe, not that its value is stable. */
  binding: (path: NodePath<t.Identifier>) => EvaluationProof;
  /** Reference formation only; this does not prove GetValue or a later write. */
  reference?: (path: NodePath<t.Node>) => EvaluationProof;
  observe?: (path: NodePath<t.Node>) => EvaluationProof;
  coerce?: (path: NodePath<t.Node>) => EvaluationProof;
  sharedValue?: (path: NodePath<t.Identifier>) => EvaluationProof;
  /** Stable primitive value, not merely a stable binding or object identity. */
  primitiveBinding?: (path: NodePath<t.Identifier>) => EvaluationProof;
}

/** Babel's static binding lookup cannot model an intervening object environment.
 * Stop at the binding's own lexical scope: a local declared inside `with` still
 * resolves lexically before reaching that object. Unlike the program-wide
 * dynamic-scope veto this keeps unrelated `with` statements out of the proof. */
export function crossesWithEnvironment(
  identifier: NodePath<t.Identifier>
): boolean {
  const bindingScope = identifier.scope.getBinding(identifier.node.name)?.scope
    .path;
  for (
    let child: NodePath<t.Node> = identifier,
      parent: NodePath<t.Node> | null = identifier.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (parent === bindingScope) return false;
    if (parent.isWithStatement() && parent.node.body === child.node)
      return true;
  }
  return false;
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
    if (step.kind === "apply-decorator") {
      // The generated invocation is not the source expression evaluated above.
      // Even replay evidence for that expression cannot discharge application.
      return "unknown";
    } else if (step.kind === "abrupt") {
      // The operands can complete normally while this operation cannot.
      return "unknown";
    } else if (step.kind === "observe") {
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
      proof =
        step.operand.path.isIdentifier() &&
        !crossesWithEnvironment(step.operand.path)
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

const closedRequirements: EvaluationRequirements = {
  replay: () => "unknown",
  binding: () => "unknown"
};
function cachedClosedProof(
  cache: WeakMap<NodePath<t.Node>, Map<boolean, EvaluationProof>>,
  path: NodePath<t.Node>,
  allowReplay: boolean,
  prove: () => EvaluationProof
): EvaluationProof {
  let modes = cache.get(path);
  if (modes?.has(allowReplay)) return modes.get(allowReplay)!;
  if (!modes) {
    modes = new Map();
    cache.set(path, modes);
  }
  modes.set(allowReplay, "unknown");
  const result = prove();
  modes.set(allowReplay, result);
  return result;
}

/** A replay proof concerns the call; it never proves hooks on its result inert. */
export function proveEvaluationOrder(
  path: NodePath<t.Node>,
  requirements: EvaluationRequirements,
  allowReplay = true,
  context = createEvaluationContext()
): EvaluationProof {
  if (requirements === closedRequirements)
    return cachedClosedProof(context.closedOrder, path, allowReplay, () =>
      proveEvaluationOrderUncached(path, requirements, allowReplay, context)
    );
  return proveEvaluationOrderUncached(path, requirements, allowReplay, context);
}
function proveEvaluationOrderUncached(
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
    const replayed = allowReplay ? requirements.replay(path) : "unknown";
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
  context = createEvaluationContext(),
  allowReplay = true
): EvaluationProof {
  if (requirements === closedRequirements)
    return cachedClosedProof(context.closedStable, path, allowReplay, () =>
      proveStableEvaluationValueUncached(
        path,
        requirements,
        context,
        allowReplay
      )
    );
  return proveStableEvaluationValueUncached(
    path,
    requirements,
    context,
    allowReplay
  );
}
function proveStableEvaluationValueUncached(
  path: NodePath<t.Node>,
  requirements: EvaluationRequirements,
  context = createEvaluationContext(),
  allowReplay = true,
  requirePrimitive = false
): EvaluationProof {
  const result = proveStableResult(
    path,
    requirements,
    context,
    requirePrimitive
  );
  if (result === "unknown") return "unknown";
  if (path.isIdentifier()) return result;
  // Result evidence cannot schedule work. Replay the admitted expression
  // once, in source order, rather than replaying selected nested operands first.
  const order = proveEvaluationOrder(path, requirements, allowReplay, context);
  return order === "unknown"
    ? "unknown"
    : order === "pending" || result === "pending"
      ? "pending"
      : "proven";
}

function proveStableResult(
  path: NodePath<t.Node>,
  requirements: EvaluationRequirements,
  context: EvaluationContext,
  requirePrimitive: boolean
): EvaluationProof {
  if (path.isIdentifier()) {
    const shared = requirePrimitive
      ? "unknown"
      : (requirements.sharedValue?.(path) ?? "unknown");
    const value =
      shared === "unknown"
        ? (requirements.primitiveBinding?.(path) ?? "unknown")
        : shared;
    if (value === "unknown") return "unknown";
    // Even a nested stable result needs a valid read at this position.
    // Replay does not establish initialization.
    const read = requirements.binding(path);
    return read === "unknown"
      ? "unknown"
      : read === "pending" || value === "pending"
        ? "pending"
        : "proven";
  }
  const plan = planEvaluation(path, context);
  if (
    plan.kind === "unknown" ||
    (plan.result.kind !== "operand" && plan.result.kind !== "primitive") ||
    // Inert property/prototype observations do not prove unchanged state.
    (path.isBinaryExpression() &&
      ["in", "instanceof"].includes(path.node.operator))
  )
    return "unknown";
  const coerced = new Set(
    plan.steps.flatMap((step) =>
      step.kind === "coerce" ? [step.path.node] : []
    )
  );
  const returned = new Set(
    plan.result.kind === "operand" ? plan.result.paths : []
  );
  let result: EvaluationProof = "proven";
  // A logical expression can both test and return the same operand.
  for (const value of new Set([
    ...(plan.result.kind === "operand" ? plan.result.paths : []),
    ...plan.result.inputs
  ])) {
    const proof = proveStableResult(
      value,
      requirements,
      context,
      coerced.has(value.node) || (requirePrimitive && returned.has(value))
    );
    if (proof === "unknown") return "unknown";
    if (proof === "pending") result = "pending";
  }
  return result;
}

/** Source position alone does not establish execution order across functions
 * or switch cases. Only a preceding declaration in the same statement list
 * (possibly enclosing the read) supplies this local initialization evidence. */
function initializationDominatesRead(
  declaration: NodePath<t.VariableDeclarator>,
  identifier: NodePath<t.Identifier>
): boolean {
  let statement: NodePath<t.Node> = declaration.parentPath;
  if (statement.parentPath?.isExportNamedDeclaration())
    statement = statement.parentPath;
  const container = statement.parentPath;
  if (
    !container ||
    !(
      container.isProgram() ||
      container.isBlockStatement() ||
      container.isSwitchCase()
    )
  )
    return false;
  for (
    let child: NodePath<t.Node> = identifier,
      parent: NodePath<t.Node> | null = identifier.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (
      parent.isVariableDeclarator() &&
      parent.parentPath.node === declaration.parentPath.node
    ) {
      const list = declaration.parentPath.node;
      if (!t.isVariableDeclaration(list)) return false;
      const declared = list.declarations.indexOf(declaration.node);
      const read = list.declarations.indexOf(parent.node);
      return declared >= 0 && read > declared;
    }
    if (parent.node === container.node)
      return (
        typeof child.key === "number" &&
        typeof statement.key === "number" &&
        child.key >= statement.key
      );
    if (
      parent.isFunction() &&
      !(
        (parent.isObjectMethod() || parent.isClassMethod()) &&
        parent.node.computed &&
        parent.node.key === child.node
      )
    )
      return false;
    if (
      (parent.isClassProperty() ||
        parent.isClassPrivateProperty() ||
        parent.isClassAccessorProperty()) &&
      !parent.node.static &&
      parent.node.value === child.node
    )
      return false;
  }
  return false;
}

function initializedConstDeclaration(
  identifier: NodePath<t.Identifier>,
  bindingsCurrent: () => boolean
): NodePath<t.VariableDeclarator> | undefined {
  const candidate = identifier.scope.getBinding(identifier.node.name);
  if (
    candidate?.kind !== "const" ||
    !candidate.path.isVariableDeclarator() ||
    !bindingsCurrent()
  )
    return;
  // Traversal can refresh scope metadata and statement positions. Read all
  // authority after the current-source observation, not before it.
  const binding = identifier.scope.getBinding(identifier.node.name);
  if (
    crossesWithEnvironment(identifier) ||
    !binding?.constant ||
    binding.kind !== "const" ||
    !binding.path.isVariableDeclarator() ||
    !isRuntimeSourceReference(binding.path) ||
    !t.isIdentifier(binding.path.node.id) ||
    binding.path.node.end == null ||
    identifier.node.start == null ||
    binding.path.node.end > identifier.node.start ||
    !initializationDominatesRead(binding.path, identifier)
  )
    return;
  return binding.path;
}

/** A binding read needs initialization and a stable value, not only const syntax. */
export function proveInitializedBindingValue(
  identifier: NodePath<t.Identifier>,
  requirements: EvaluationRequirements,
  visiting: Set<t.Node>,
  requirePrimitive = false,
  context = createEvaluationContext()
): EvaluationProof {
  const declaration = initializedConstDeclaration(
    identifier,
    context.bindingsCurrent ??
      (() => {
        const program = identifier.scope.getProgramParent().path;
        return (
          program.isProgram() &&
          collectRuntimeSourceEvidence(program).bindingsCurrent
        );
      })
  );
  if (!declaration || visiting.has(declaration.node)) return "unknown";
  const initializer = declaration.get("init");
  if (!initializer.isExpression()) return "unknown";
  visiting.add(declaration.node);
  try {
    return requirePrimitive
      ? proveStableEvaluationValueUncached(
          initializer,
          requirements,
          context,
          true,
          true
        )
      : proveStableEvaluationValue(initializer, requirements, context);
  } finally {
    visiting.delete(declaration.node);
  }
}

/** No calls, property reads, bindings, or user hooks enter this evaluator. */
function closedConditionExpression(
  path: NodePath<t.Expression>,
  context: EvaluationContext
): t.Expression | undefined {
  if (isTransparentCssRuleWrapperExpression(path.node))
    return closedConditionExpression(
      path.get("expression") as NodePath<t.Expression>,
      context
    );
  if (path.isLogicalExpression() || path.isConditionalExpression()) {
    const test = path.isLogicalExpression()
      ? path.get("left")
      : path.get("test");
    const condition = primitiveCondition(test, context);
    if (!condition) return;
    const selected = path.isConditionalExpression()
      ? condition.value
        ? path.get("consequent")
        : path.get("alternate")
      : (
            path.node.operator === "&&"
              ? Boolean(condition.value)
              : path.node.operator === "||"
                ? !condition.value
                : condition.value == null
          )
        ? path.get("right")
        : path.get("left");
    return closedConditionExpression(selected, context);
  }
  if (isSupportedStaticCssPrimitiveLiteral(path.node))
    return t.cloneNode(path.node);
  if (
    !(
      path.isUnaryExpression() &&
      !["delete", "throw"].includes(path.node.operator)
    ) &&
    !(
      path.isBinaryExpression() &&
      !["|>", "in", "instanceof"].includes(path.node.operator)
    ) &&
    !path.isSequenceExpression() &&
    !path.isTemplateLiteral()
  )
    return;
  const clone = t.cloneNode(path.node, true);
  for (const key of t.VISITOR_KEYS[path.node.type] ?? []) {
    const child = path.get(key) as NodePath<t.Node> | NodePath<t.Node>[];
    const paths = Array.isArray(child) ? child : [child];
    const nodes: t.Node[] = [];
    for (const value of paths) {
      if (value.isTemplateElement()) {
        nodes.push(t.cloneNode(value.node));
        continue;
      }
      if (!value.isExpression()) return;
      const reduced = closedConditionExpression(value, context);
      if (!reduced) return;
      nodes.push(reduced);
    }
    (clone as unknown as Record<string, unknown>)[key] = Array.isArray(child)
      ? nodes
      : nodes[0];
  }
  return clone;
}

function primitiveCondition(
  path: NodePath<t.Expression>,
  context: EvaluationContext
): { value: unknown } | undefined {
  if (context.conditions.has(path))
    return context.conditions.get(path) ?? undefined;
  // Branch exclusion needs closed literal evidence. Babel's constant flag
  // does not account for direct eval or a var initializer that never runs.
  const requirements = closedRequirements;
  context.conditions.set(path, null);
  if (proveStableEvaluationValue(path, requirements, context) !== "proven")
    return;
  // Reduce only the closed, selected syntax before invoking Babel's evaluator.
  // In particular, never hand it an excluded logical/conditional subtree: it
  // may eagerly execute supported builtins there, even when JS would not.
  const reduced = closedConditionExpression(path, context);
  if (!reduced) return;
  let evaluated: { confident: boolean; value?: unknown } = { confident: false };
  try {
    traverse(t.file(t.program([t.expressionStatement(reduced)])), {
      ExpressionStatement(statement) {
        evaluated = statement.get("expression").evaluate();
        statement.stop();
      }
    });
  } catch {
    // A closed operator can still throw (for example BigInt division by zero).
    return;
  }
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

type BranchOutcome = { truthy: boolean; nullish: boolean };

function selectsLogicalRight(
  operator: t.LogicalExpression["operator"],
  value: BranchOutcome
): boolean {
  return operator === "&&"
    ? value.truthy
    : operator === "||"
      ? !value.truthy
      : value.nullish;
}

export function logicalAssignmentOperator(
  operator: t.AssignmentExpression["operator"]
): t.LogicalExpression["operator"] | undefined {
  switch (operator) {
    case "&&=":
      return "&&";
    case "||=":
      return "||";
    case "??=":
      return "??";
  }
}

/** Facts about a normal result never discharge evaluation of the test itself. */
function normalBranchOutcome(
  path: NodePath<t.Expression>,
  context: EvaluationContext
): BranchOutcome | undefined {
  if (context.outcomes.has(path))
    return context.outcomes.get(path) ?? undefined;
  let outcome: BranchOutcome | undefined;
  if (path.isSequenceExpression()) {
    outcome = normalBranchOutcome(path.get("expressions").at(-1)!, context);
  } else if (isTransparentCssRuleWrapperExpression(path.node)) {
    outcome = normalBranchOutcome(
      path.get("expression") as NodePath<t.Expression>,
      context
    );
  } else if (
    path.isObjectExpression() ||
    path.isArrayExpression() ||
    path.isFunction()
  ) {
    outcome = { truthy: true, nullish: false };
  } else if (path.isUnaryExpression({ operator: "void" })) {
    outcome = { truthy: false, nullish: true };
  } else if (path.isConditionalExpression() || path.isLogicalExpression()) {
    const selected = planEvaluation(path, context).selectedBranches?.at(-1);
    if (selected) outcome = normalBranchOutcome(selected, context);
  } else {
    const declaration =
      path.isIdentifier() && context.bindingsCurrent
        ? initializedConstDeclaration(path, context.bindingsCurrent)
        : undefined;
    const initializer = declaration?.get("init");
    const result = initializer?.isExpression()
      ? primitiveCondition(initializer, context)
      : path.isCallExpression()
        ? context.callCondition?.(path)
        : primitiveCondition(path, context);
    if (result)
      outcome = {
        truthy: Boolean(result.value),
        nullish: result.value == null
      };
  }
  context.outcomes.set(path, outcome ?? null);
  return outcome;
}

/** Scope this index to one unchanged AST analysis. The result path alone is
 * sufficient for alias selection, but replay must keep all selected operands.
 */
export function branchEvaluationFacts(
  program: NodePath<t.Program>,
  callCondition?: EvaluationContext["callCondition"]
) {
  const context = createEvaluationContext();
  context.callCondition = callCondition;
  let current: boolean | undefined;
  context.bindingsCurrent = () =>
    (current ??= collectRuntimeSourceEvidence(program).bindingsCurrent);
  const paths = new WeakMap<t.Node, NodePath<t.Node>>();
  let indexed = false;
  function branches(path: NodePath<t.Node>) {
    if (path.isConditionalExpression() || path.isLogicalExpression()) {
      paths.set(path.node, path);
      return planEvaluation(path, context).selectedBranches;
    }
  }
  return {
    initializedConst(path: NodePath<t.Identifier>) {
      const init = initializedConstDeclaration(
        path,
        context.bindingsCurrent!
      )?.get("init");
      return init?.isExpression() ? init : undefined;
    },
    valueNullish(path: NodePath<t.Expression>) {
      return normalBranchOutcome(path, context)?.nullish;
    },
    hasClosedCondition(path: NodePath<t.Expression>) {
      return primitiveCondition(path, context) !== undefined;
    },
    logicalAssignmentWrite(
      operator: t.LogicalExpression["operator"],
      readValue: NodePath<t.Expression>
    ) {
      const value = normalBranchOutcome(readValue, context);
      return value ? selectsLogicalRight(operator, value) : undefined;
    },
    plan(path: NodePath<t.Node>) {
      return planEvaluation(path, context);
    },
    branches,
    result(path: NodePath<t.Node>) {
      return branches(path)?.at(-1);
    },
    // Only a node-only JSX visitor needs a path index. Do not evaluate
    // other conditions merely because their paths were indexed.
    branchesForNode(node: t.ConditionalExpression | t.LogicalExpression) {
      if (!paths.has(node) && !indexed) {
        indexed = true;
        program.traverse({
          "ConditionalExpression|LogicalExpression"(branch) {
            paths.set(branch.node, branch);
          }
        });
      }
      const path = paths.get(node);
      return path && branches(path);
    },
    excludesChild(child: NodePath<t.Node>) {
      const parent = child.parentPath;
      return (
        !!parent &&
        (parent.isIfStatement() ||
          parent.isConditionalExpression() ||
          parent.isLogicalExpression()) &&
        planEvaluation(parent, context).unexecutedBranches?.some(
          (branch) => branch.node === child.node
        )
      );
    },
    isUnexecuted(path: NodePath<t.Node>) {
      return isProvablyUnexecuted(path, context);
    },
    proveBinding(
      identifier: NodePath<t.Identifier>,
      requirements: EvaluationRequirements,
      visiting: Set<t.Node>,
      requirePrimitive = false
    ) {
      return proveInitializedBindingValue(
        identifier,
        requirements,
        visiting,
        requirePrimitive,
        context
      );
    },
    proveStableValue(
      path: NodePath<t.Node>,
      requirements: EvaluationRequirements
    ) {
      return proveStableEvaluationValue(path, requirements, context);
    },
    proveSteps(
      steps: readonly EvaluationStep[],
      requirements: EvaluationRequirements
    ) {
      return proveEvaluationSteps(steps, requirements, true, context);
    }
  };
}

/** A deferred body is not dead code; only an excluded branch supplies evidence. */
export function isProvablyUnexecuted(
  path: NodePath<t.Node>,
  context = createEvaluationContext()
): boolean {
  let child = path;
  let excluded = false;
  for (let parent = path.parentPath; parent; parent = parent.parentPath) {
    if (parent.isFunction() || parent.isClass()) return excluded;
    if (
      parent.isOptionalCallExpression() &&
      child.listKey === "arguments" &&
      planEvaluation(parent, context).unexecutedBranches?.some(
        (branch) => branch.node === child.node
      )
    )
      return true;
    if (
      parent.isIfStatement() ||
      parent.isConditionalExpression() ||
      parent.isLogicalExpression()
    ) {
      const plan = planEvaluation(parent, context);
      if (
        plan.unexecutedBranches?.some((branch) => branch.node === child.node)
      ) {
        // Dropping a required candidate needs a closed predicate. A normal
        // outcome alone only selects operands when replay retains that predicate.
        const test = (
          parent.isLogicalExpression() ? parent.get("left") : parent.get("test")
        ) as NodePath<t.Expression>;
        excluded ||= !!primitiveCondition(test, context);
      }
    }
    child = parent;
  }
  return excluded;
}

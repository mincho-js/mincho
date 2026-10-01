import { types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";
import { hasStaticCssEvalBindingMutation } from "../staticCssEval/sameFile/mutation.js";
import {
  createPartialEvalContext,
  reducePartialEvalExpression
} from "../staticCssEval/partialEvaluator/index.js";
import { getStaticPrimitiveValue } from "../staticCssEval/partialEvaluator/literals.js";

export class StaticExpressionDeopt extends Error {}

export interface StaticExpressionBudget {
  nodes: number;
  calls: number;
  readonly bindingMutations: WeakMap<Binding, boolean>;
  readonly active: Set<t.Node>;
  readonly proved: Set<t.Node>;
}

export const createStaticExpressionBudget = (): StaticExpressionBudget => ({
  nodes: 0,
  calls: 0,
  bindingMutations: new WeakMap(),
  active: new Set(),
  proved: new Set()
});

type Environment = ReadonlyMap<Binding, t.Expression>;

const deopt = (): never => {
  throw new StaticExpressionDeopt();
};

function hasBindingMutation(
  module: SourceModule,
  binding: Binding,
  budget: StaticExpressionBudget
): boolean {
  const cached = budget.bindingMutations.get(binding);
  if (cached !== undefined) return cached;

  const mutated = hasStaticCssEvalBindingMutation(module.program, binding);
  budget.bindingMutations.set(binding, mutated);

  return mutated;
}

function* proveFunction(
  graph: ModuleGraph,
  module: SourceModule,
  fn: NodePath<t.Node>,
  budget: StaticExpressionBudget,
  active = new Set<t.Node>(),
  depth = 0
): ModuleGraphFlow<void> {
  if (active.has(fn.node) || depth > 50) return deopt();
  if (budget.proved.has(fn.node)) return;
  if (
    !(
      fn.isFunctionDeclaration() ||
      fn.isFunctionExpression() ||
      fn.isArrowFunctionExpression()
    ) ||
    fn.node.async ||
    fn.node.generator
  )
    return deopt();
  if (
    fn.parentPath?.isVariableDeclarator() &&
    !fn.parentPath.parentPath.isVariableDeclaration({ kind: "const" })
  )
    return deopt();

  const calls: NodePath<t.CallExpression>[] = [];
  fn.traverse({
    enter(path) {
      if (++budget.nodes > 10000) deopt();
      if (
        path.isAssignmentExpression() ||
        path.isUpdateExpression() ||
        path.isThisExpression() ||
        path.isAwaitExpression() ||
        path.isYieldExpression() ||
        path.isNewExpression() ||
        path.isObjectMethod() ||
        path.isLoop() ||
        path.isOptionalCallExpression()
      )
        deopt();
      if (path.isCallExpression()) calls.push(path);
    }
  });
  active.add(fn.node);

  try {
    for (const call of calls) {
      const target = yield* graph.valueTarget(
        module,
        call.get("callee"),
        new Set()
      );
      if (!target || "external" in target) return deopt();

      yield* proveFunction(
        graph,
        target.module,
        target.path,
        budget,
        active,
        depth + 1
      );
    }

    budget.proved.add(fn.node);
  } finally {
    active.delete(fn.node);
  }
}

/** Interpret a closed subset of syntax. No application code or getters execute. */
export function* evaluateStaticExpression(
  graph: ModuleGraph,
  module: SourceModule,
  path: NodePath<t.Node>,
  budget = createStaticExpressionBudget(),
  environment: Environment = new Map(),
  depth = 0
): ModuleGraphFlow<t.Expression> {
  if (++budget.nodes > 10000 || depth > 50) return deopt();

  const child = (value: NodePath<t.Node>) =>
    evaluateStaticExpression(
      graph,
      module,
      value,
      budget,
      environment,
      depth + 1
    );

  const node = path.node;

  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSSatisfiesExpression() ||
    path.isTSNonNullExpression() ||
    path.isParenthesizedExpression()
  )
    return yield* child(path.get("expression") as NodePath<t.Node>);
  if (
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    (t.isNumericLiteral(node) && Number.isFinite(node.value))
  )
    return t.cloneNode(node);

  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding)
      return path.node.name === "undefined"
        ? t.unaryExpression("void", t.numericLiteral(0))
        : deopt();

    const parameter = environment.get(binding);
    if (parameter) return t.cloneNode(parameter, true);
    if (!binding.constant || budget.active.has(binding.path.node))
      return deopt();

    if (binding.path.isVariableDeclarator()) {
      if (!binding.path.parentPath.isVariableDeclaration({ kind: "const" }))
        return deopt();

      // Do not turn an access before initialization into a successful value.
      if ((binding.path.node.start ?? 0) > (path.node.start ?? Infinity))
        return deopt();
      if (hasBindingMutation(module, binding, budget)) return deopt();
    }

    const target = yield* graph.bindingTarget(module, binding, new Set());
    if (!target || "external" in target) return deopt();

    const declaration = target.path.parentPath;

    if (
      declaration?.isVariableDeclarator() &&
      t.isIdentifier(declaration.node.id)
    ) {
      const resolved = declaration.scope.getBinding(declaration.node.id.name);
      if (
        !declaration.parentPath.isVariableDeclaration({ kind: "const" }) ||
        !resolved ||
        hasBindingMutation(target.module, resolved, budget)
      )
        return deopt();
    }

    budget.active.add(binding.path.node);

    try {
      const result = yield* evaluateStaticExpression(
        graph,
        target.module,
        target.path,
        budget,
        environment,
        depth + 1
      );
      if (
        (t.isObjectExpression(result) || t.isArrayExpression(result)) &&
        (target.module !== module ||
          declaration?.parentPath?.parentPath?.isExportNamedDeclaration())
      )
        return deopt();

      return result;
    } finally {
      budget.active.delete(binding.path.node);
    }
  }

  if (path.isCallExpression()) {
    const target = yield* graph.valueTarget(
      module,
      path.get("callee"),
      new Set()
    );
    if (!target || "external" in target) return deopt();

    const candidate = target.path;
    yield* proveFunction(graph, target.module, candidate, budget);

    if (
      !(
        candidate.isFunctionDeclaration() ||
        candidate.isFunctionExpression() ||
        candidate.isArrowFunctionExpression()
      )
    )
      return deopt();

    const fn = candidate as NodePath<
      t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression
    >;
    if (fn.node.async || fn.node.generator || budget.active.has(fn.node))
      return deopt();
    if (
      fn.parentPath?.isVariableDeclarator() &&
      !fn.parentPath.parentPath.isVariableDeclaration({ kind: "const" })
    )
      return deopt();

    const args: t.Expression[] = [];

    for (const arg of path.get("arguments")) {
      if (!arg.isExpression()) return deopt();

      args.push(yield* child(arg));
    }

    const local = new Map(environment);

    const inside = (value: NodePath<t.Node>) =>
      evaluateStaticExpression(
        graph,
        target.module,
        value,
        budget,
        local,
        depth + 1
      );

    budget.active.add(fn.node);

    try {
      for (const [index, parameter] of fn.get("params").entries()) {
        const name = parameter.isAssignmentPattern()
          ? parameter.get("left")
          : parameter;
        if (!name.isIdentifier()) return deopt();

        const binding = fn.scope.getBinding(name.node.name);
        if (!binding || !binding.constant) return deopt();

        let value = args[index];

        if (
          (!value || t.isUnaryExpression(value, { operator: "void" })) &&
          parameter.isAssignmentPattern()
        )
          value = yield* inside(parameter.get("right"));

        local.set(
          binding,
          value ?? t.unaryExpression("void", t.numericLiteral(0))
        );
      }

      const body = fn.get("body");
      let result: t.Expression;

      if (body.isBlockStatement()) {
        const statements = body.get("body");
        const last = statements.at(-1);
        if (!last?.isReturnStatement() || !last.node.argument) return deopt();

        for (const statement of statements.slice(0, -1)) {
          if (!statement.isVariableDeclaration({ kind: "const" }))
            return deopt();

          for (const declaration of statement.get("declarations")) {
            const id = declaration.get("id");
            const init = declaration.get("init");
            if (!id.isIdentifier() || !init.isExpression()) return deopt();

            const binding = declaration.scope.getBinding(id.node.name);
            if (!binding?.constant) return deopt();

            local.set(binding, yield* inside(init));
          }
        }

        result = yield* inside(last.get("argument") as NodePath<t.Node>);
      } else result = yield* inside(body);

      budget.calls++;

      return result;
    } finally {
      budget.active.delete(fn.node);
    }
  }

  if (path.isConditionalExpression() || path.isLogicalExpression()) {
    const test = yield* child(
      path.get(
        path.isConditionalExpression() ? "test" : "left"
      ) as NodePath<t.Node>
    );

    const value = getStaticPrimitiveValue(test);
    if (value === undefined) return deopt();
    if (path.isConditionalExpression())
      return yield* child(path.get(value ? "consequent" : "alternate"));

    const operator = path.node.operator;

    return (
      operator === "&&"
        ? Boolean(value)
        : operator === "||"
          ? !value
          : value === null
    )
      ? yield* child(path.get("right"))
      : test;
  }

  let expression: t.Expression;

  if (path.isObjectExpression()) {
    const properties: Array<t.ObjectProperty | t.SpreadElement> = [];

    for (const property of path.get("properties")) {
      if (property.isSpreadElement()) {
        properties.push(
          t.spreadElement(yield* child(property.get("argument")))
        );
        continue;
      }

      if (!property.isObjectProperty()) return deopt();

      const key = property.node.computed
        ? yield* child(property.get("key"))
        : t.cloneNode(property.node.key);
      if (
        (!property.node.computed &&
          t.isIdentifier(key, { name: "__proto__" })) ||
        t.isStringLiteral(key, { value: "__proto__" })
      )
        return deopt();

      properties.push(
        t.objectProperty(
          key,
          yield* child(property.get("value")),
          property.node.computed
        )
      );
    }

    expression = t.objectExpression(properties);
  } else if (path.isArrayExpression()) {
    const elements: Array<t.Expression | t.SpreadElement> = [];

    for (const item of path.get("elements")) {
      if (!item.node) return deopt();

      elements.push(
        item.isSpreadElement()
          ? t.spreadElement(yield* child(item.get("argument")))
          : yield* child(item as NodePath<t.Node>)
      );
    }

    expression = t.arrayExpression(elements);
  } else if (path.isMemberExpression()) {
    // Namespace values use the same ESM/CommonJS export resolver as functions.
    const target = yield* graph.valueTarget(module, path, new Set());
    if (target && !("external" in target) && target.path.node !== path.node)
      return yield* evaluateStaticExpression(
        graph,
        target.module,
        target.path,
        budget,
        environment,
        depth + 1
      );

    expression = t.memberExpression(
      yield* child(path.get("object")),
      path.node.computed
        ? yield* child(path.get("property"))
        : t.cloneNode(path.node.property),
      path.node.computed
    );
  } else if (path.isBinaryExpression()) {
    expression = t.binaryExpression(
      path.node.operator,
      yield* child(path.get("left")),
      yield* child(path.get("right"))
    );
  } else if (path.isUnaryExpression() && path.node.operator !== "delete") {
    expression = t.unaryExpression(
      path.node.operator,
      yield* child(path.get("argument"))
    );
  } else if (path.isTemplateLiteral()) {
    const values: t.Expression[] = [];

    for (const value of path.get("expressions"))
      values.push(yield* child(value));

    expression = t.templateLiteral(
      path.node.quasis.map((item) => t.cloneNode(item)),
      values
    );
  } else return deopt();

  // The existing literal reducer defines operator, member and spread semantics.
  t.traverseFast(expression, () => {
    if (++budget.nodes > 10000) deopt();
  });

  const result = reducePartialEvalExpression({
    expression,
    context: createPartialEvalContext({
      owner: { file: module.id },
      limits: { maxDepth: 50 - depth, maxNodeCount: 10000 - budget.nodes }
    })
  });

  return result.kind === "confident" ? result.expression : deopt();
}

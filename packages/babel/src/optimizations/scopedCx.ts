import { types as t, type NodePath } from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";
import { expressionKey } from "./pureFunctions.js";
import { readSidecarString } from "./sidecarStrings.js";
import { hasInitializedReferences } from "./initializedReferences.js";
import {
  createStaticExpressionBudget,
  evaluateStaticExpression
} from "./staticExpression.js";

const source = "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
const factory = "createCompiledDefineRulesCxRuntime";

export interface ScopedCxCall {
  key: string;
  identity: string;
  artifact: {
    classWrites: [string, number][];
    segments?: [string, number[]][];
  };
  args: CxData[];
}

type CxData =
  | string
  | number
  | boolean
  | null
  | undefined
  | CxData[]
  | { [key: string]: CxData };

function* operand(
  graph: ModuleGraph,
  owner: SourceModule,
  path: NodePath<t.Expression>,
  budget = { nodes: 10000 },
  depth = 0
): ModuleGraphFlow<CxData> {
  if (--budget.nodes < 0 || depth > 32) throw new Error("operand-budget");

  if (path.isArrayExpression()) {
    const values: CxData[] = [];

    for (const element of path.get("elements")) {
      if (!element.isExpression()) throw new Error("operand-shape");

      values.push(yield* operand(graph, owner, element, budget, depth + 1));
    }

    return values;
  }

  if (path.isObjectExpression()) {
    const values: Record<string, CxData> = Object.create(null);

    for (const property of path.get("properties")) {
      if (!property.isObjectProperty() || property.node.computed)
        throw new Error("operand-shape");

      const key = t.isIdentifier(property.node.key)
        ? property.node.key.name
        : t.isStringLiteral(property.node.key)
          ? property.node.key.value
          : null;

      const value = property.get("value");
      if (
        key === null ||
        key in values ||
        key in Object.prototype ||
        !value.isExpression()
      )
        throw new Error("operand-shape");

      values[key] = yield* operand(graph, owner, value, budget, depth + 1);
    }

    return values;
  }

  try {
    return yield* readSidecarString(graph, owner, path);
  } catch {
    /* Ordinary literals and immutable local aliases use the normal proof. */
  }

  const expressionBudget = createStaticExpressionBudget();
  const value = literal(
    yield* evaluateStaticExpression(graph, owner, path, expressionBudget)
  );
  if (expressionBudget.calls) throw new Error("operand-call");

  return value;
}

/** No getters, computed keys, coercion, calls or mutable artifact aliases. */
function literal(node: t.Node, budget = { nodes: 10000 }, depth = 0): CxData {
  if (--budget.nodes < 0 || depth > 32) throw new Error("operand-budget");
  if (
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  )
    return t.isNullLiteral(node) ? null : node.value;
  if (t.isNumericLiteral(node) && Number.isFinite(node.value))
    return node.value;
  if (
    t.isUnaryExpression(node, { operator: "void" }) &&
    t.isNumericLiteral(node.argument, { value: 0 })
  )
    return undefined;
  if (t.isArrayExpression(node))
    return node.elements.map((item) => {
      if (!item || t.isSpreadElement(item)) throw new Error("operand-shape");

      return literal(item, budget, depth + 1);
    });

  if (t.isObjectExpression(node)) {
    const value: Record<string, CxData> = Object.create(null);

    for (const property of node.properties) {
      if (!t.isObjectProperty(property) || property.computed)
        throw new Error("operand-shape");

      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key)
          ? property.key.value
          : null;
      if (key === null || key in value || key in Object.prototype)
        throw new Error("operand-shape");

      value[key] = literal(property.value, budget, depth + 1);
    }

    return value;
  }

  throw new Error("operand-shape");
}

function artifact(node: t.Node): ScopedCxCall["artifact"] | null {
  const data = literal(node);
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (
    Object.keys(data).some((key) => !["classWrites", "segments"].includes(key))
  )
    return null;
  if (!Array.isArray(data.classWrites)) return null;

  const names = new Set<string>();
  const writes = new Set<number>();

  for (const entry of data.classWrites) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[0] ||
      /\s/.test(entry[0]) ||
      names.has(entry[0]) ||
      typeof entry[1] !== "number" ||
      !Number.isSafeInteger(entry[1]) ||
      entry[1] < 0
    )
      return null;

    names.add(entry[0]);
    writes.add(entry[1]);
  }

  if (data.segments !== undefined) {
    if (!Array.isArray(data.segments)) return null;

    for (const entry of data.segments) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !entry[0] ||
        /\s/.test(entry[0]) ||
        names.has(entry[0]) ||
        !Array.isArray(entry[1]) ||
        !entry[1].every((id) => typeof id === "number" && writes.has(id))
      )
        return null;

      names.add(entry[0]);
    }
  }

  return data as ScopedCxCall["artifact"];
}

export function isCompiledScopedCx(path: NodePath<t.CallExpression>): boolean {
  const reference = getModuleReference(path.get("callee"));

  return (
    !reference?.unsafe &&
    reference?.source === source &&
    reference.members.join(".") === factory
  );
}

/** Describe calls as literal data; the integration executes the real cx runtime. */
export function* analyzeScopedCx(
  graph: ModuleGraph,
  owner: SourceModule,
  diagnostics?: Record<string, number>
): ModuleGraphFlow<ScopedCxCall[]> {
  const candidates: NodePath<t.CallExpression>[] = [];
  owner.program.traverse({
    CallExpression(path) {
      if (
        !path.node.optional &&
        !isCompiledScopedCx(path) &&
        (path.get("callee").isIdentifier() ||
          path.get("callee").isMemberExpression())
      )
        candidates.push(path);
    }
  });

  const result: ScopedCxCall[] = [];

  const count = (reason: string) => {
    if (diagnostics) diagnostics[reason] = (diagnostics[reason] ?? 0) + 1;
  };

  for (const path of candidates) {
    try {
      const target = yield* graph.valueTarget(
        owner,
        path.get("callee"),
        new Set()
      );
      if (
        !target ||
        "external" in target ||
        !target.path.isCallExpression() ||
        !isCompiledScopedCx(target.path)
      )
        continue;

      count("candidate");

      if (
        !hasInitializedReferences(path) ||
        !hasInitializedReferences(target.path)
      ) {
        count("initialization-order");
        continue;
      }

      const inputs = target.path.node.arguments;

      if (inputs.length !== 1 || !t.isObjectExpression(inputs[0])) {
        count("artifact-provenance");
        continue;
      }

      const data = artifact(inputs[0]);

      if (!data) {
        count("artifact-shape");
        continue;
      }

      const args: CxData[] = [];

      for (const argument of path.get("arguments")) {
        if (!argument.isExpression()) throw new Error("operand-shape");

        args.push(yield* operand(graph, owner, argument));
      }

      result.push({
        key: expressionKey(path),
        identity: `${target.module.id}\0${expressionKey(target.path)}`,
        artifact: data,
        args
      });
    } catch {
      count("unproved-operand");
    }
  }

  return result;
}

/** Remove only private, now unused, literal compiled factories. */
export function pruneScopedCxFactories(program: NodePath<t.Program>): void {
  program.scope.crawl();
  program.traverse({
    VariableDeclarator(path) {
      if (
        !t.isIdentifier(path.node.id) ||
        !path.parentPath.isVariableDeclaration({ kind: "const" }) ||
        path.parentPath.parentPath?.isExportNamedDeclaration()
      )
        return;

      const binding = path.scope.getBinding(path.node.id.name);
      const init = path.get("init");
      if (
        !binding?.constant ||
        binding.referenced ||
        !init.isCallExpression() ||
        !isCompiledScopedCx(init) ||
        !hasInitializedReferences(init) ||
        init.node.arguments.length !== 1
      )
        return;

      try {
        if (artifact(init.node.arguments[0]!)) path.remove();
      } catch {
        /* Preserve observable inputs. */
      }
    }
  });
  program.scope.crawl();

  for (const statement of program.get("body")) {
    if (
      !statement.isImportDeclaration() ||
      statement.node.source.value !== source
    )
      continue;

    for (const specifier of statement.get("specifiers"))
      if (!program.scope.getBinding(specifier.node.local.name)?.referenced)
        specifier.remove();

    // This known runtime module has no CSS or registration side effects.
    if (!statement.node.specifiers.length) statement.remove();
  }
}

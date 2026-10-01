import {
  types as t,
  transformSync,
  type NodePath,
  type TransformOptions
} from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow
} from "../moduleGraph.js";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";
import {
  evaluateStaticExpression,
  createStaticExpressionBudget
} from "./staticExpression.js";
import { applyPureFunctions, expressionKey } from "./pureFunctions.js";

export type StaticData =
  | undefined
  | null
  | string
  | number
  | boolean
  | StaticData[]
  | { [key: string]: StaticData };

export interface StaticRecipeCall {
  readonly key: string;
  readonly identity: string;
  readonly config: StaticData;
  readonly options?: StaticData;
}

/** Read only serialized factories emitted by the existing sidecar evaluator. */
export function* analyzeRuntimeExpressions(options: {
  filename: string;
  source: string;
  parserCache?: SourceAstCache;
  pureFunctions?: boolean;
}): ModuleGraphFlow<{ calls: StaticRecipeCall[]; dependencies: string[] }> {
  const graph = createModuleGraph({
    isExternal: (id) =>
      /(?:^|\/)(?:node_modules|\.yarn)\//.test(id) ||
      (/\.css\.[cm]?[jt]s$/.test(id) && !/extracted_[^/]+\.css\.ts$/.test(id)),

    parse: (id, source, jsx) =>
      parseModuleProgram(id, source, jsx, options.parserCache)
  });

  const owner = {
    id: options.filename,
    program: parseModuleProgram(
      options.filename,
      options.source,
      true,
      options.parserCache
    )
  };

  graph.modules.set(owner.id, owner);

  const candidates: NodePath<t.CallExpression>[] = [];
  owner.program.traverse({
    CallExpression(path) {
      candidates.push(path);
    }
  });

  const calls: StaticRecipeCall[] = [];

  for (const path of candidates) {
    if (path.node.arguments.length > 1 || path.node.optional) continue;

    const reference = getModuleReference(path.get("callee"));
    if (
      reference &&
      [
        "@mincho-js/css",
        "@mincho-js/css/runtime",
        "@mincho-js/react/runtime",
        "@mincho-js/css/rules/createRuntimeFn"
      ].includes(reference.source)
    )
      continue;

    try {
      const target = yield* graph.valueTarget(
        owner,
        path.get("callee"),
        new Set()
      );
      if (!target || "external" in target || !target.path.isCallExpression())
        continue;

      const factory = getModuleReference(target.path.get("callee"));
      if (
        factory?.unsafe ||
        factory?.source !== "@mincho-js/css/rules/createRuntimeFn" ||
        factory.members.join(".") !== "createRuntimeFn" ||
        target.path.node.arguments.length !== 1
      )
        continue;

      const configPath = target.path.get("arguments")[0]!;
      const argument = path.get("arguments")[0];
      if (!configPath.isExpression() || (argument && !argument.isExpression()))
        continue;

      const budget = createStaticExpressionBudget();
      const config = yield* evaluateStaticExpression(
        graph,
        target.module,
        configPath,
        budget
      );

      // Serialized configuration must be literal data, never helper code.
      if (budget.calls) continue;

      const value = argument
        ? yield* evaluateStaticExpression(graph, owner, argument, budget)
        : undefined;
      if (options.pureFunctions === false && budget.calls) continue;

      calls.push({
        key: expressionKey(path),
        identity: `${target.module.id}\0${expressionKey(target.path)}`,
        config: staticData(config),
        ...(value ? { options: staticData(value) } : {})
      });
    } catch {
      /* Preserve the existing runtime for every unproved call. */
    }
  }

  return { calls, dependencies: [...graph.dependencies] };
}

export function applyRuntimeExpressions(options: {
  filename: string;
  source: string;
  replacements: ReadonlyArray<{ key: string; value: string }>;
  sourceMaps?: boolean;
  inputSourceMap?: TransformOptions["inputSourceMap"];
}) {
  return transformSync(options.source, {
    filename: options.filename,
    configFile: false,
    babelrc: false,
    sourceType: "unambiguous",
    parserOpts: { plugins: ["jsx", "typescript"] },
    sourceMaps: options.sourceMaps,
    inputSourceMap: options.inputSourceMap,
    plugins: [
      () => ({
        visitor: {
          Program(program: NodePath<t.Program>) {
            applyPureFunctions(program, {
              replacements: options.replacements.map((item) => ({
                key: item.key,
                expression: t.stringLiteral(item.value)
              })),
              dependencies: [],
              diagnostics: []
            });
          }
        }
      })
    ]
  });
}

function staticData(node: t.Expression): StaticData {
  if (t.isUnaryExpression(node, { operator: "void" })) return undefined;
  if (
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNumericLiteral(node)
  )
    return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isArrayExpression(node))
    return node.elements.map((item) => {
      if (!item || !t.isExpression(item)) throw new Error("Non-static array");

      return staticData(item);
    });

  if (t.isObjectExpression(node)) {
    const result: Record<string, StaticData> = Object.create(null);

    for (const property of node.properties) {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        !t.isExpression(property.value)
      )
        throw new Error("Non-static object");

      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
          ? String(property.key.value)
          : null;
      if (
        key === null ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        throw new Error("Unsupported key");

      result[key] = staticData(property.value);
    }

    return result;
  }

  throw new Error("Non-static value");
}

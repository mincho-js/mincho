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
  type ModuleGraphFlow,
  type ModuleGraph,
  type SourceModule
} from "../moduleGraph.js";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";
import {
  evaluateStaticExpression,
  createStaticExpressionBudget
} from "./staticExpression.js";
import {
  applyPureFunctions,
  expressionKey,
  preserveModuleEffects
} from "./pureFunctions.js";

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

export interface StaticStyledElement extends StaticRecipeCall {
  readonly tag: string;
  readonly variants: string[];
  readonly className: string;
}

/** Both bundlers understand call annotations on the known pure serialized factory. */
export function annotateRecipeFactories(
  source: string,
  filename: string
): string {
  if (!source.includes("@mincho-js/css/rules/createRuntimeFn")) return source;

  return (
    transformSync(source, {
      filename,
      configFile: false,
      babelrc: false,
      sourceType: "unambiguous",
      plugins: [
        () => ({
          visitor: {
            CallExpression(path: NodePath<t.CallExpression>) {
              const reference = getModuleReference(path.get("callee"));

              if (
                !reference?.unsafe &&
                reference?.source === "@mincho-js/css/rules/createRuntimeFn" &&
                reference.members.join(".") === "createRuntimeFn"
              )
                t.addComment(path.node, "leading", "#__PURE__");
            }
          }
        })
      ]
    })?.code ?? source
  );
}

/** Read only serialized factories emitted by the existing sidecar evaluator. */
export function* analyzeRuntimeExpressions(options: {
  filename: string;
  source: string;
  parserCache?: SourceAstCache;
  pureFunctions?: boolean;
  staticRecipes?: boolean;
  styledComponents?: boolean;
}): ModuleGraphFlow<{
  calls: StaticRecipeCall[];
  elements: StaticStyledElement[];
  dependencies: string[];
}> {
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
  const jsx: NodePath<t.JSXElement>[] = [];
  owner.program.traverse({
    CallExpression(path) {
      if (options.staticRecipes !== false) candidates.push(path);
    },

    JSXElement(path) {
      if (options.styledComponents !== false) jsx.push(path);
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
      const recipe = yield* serializedRecipe(graph, owner, path.get("callee"));
      if (!recipe) continue;

      const argument = path.get("arguments")[0];
      if (argument && !argument.isExpression()) continue;

      const budget = createStaticExpressionBudget();
      const value = argument
        ? yield* evaluateStaticExpression(graph, owner, argument, budget)
        : undefined;
      if (options.pureFunctions === false && budget.calls) continue;

      calls.push({
        key: expressionKey(path),
        ...recipe,
        ...(value ? { options: staticData(value) } : {})
      });
    } catch {
      /* Preserve the existing runtime for every unproved call. */
    }
  }

  const elements: StaticStyledElement[] = [];

  for (const element of jsx) {
    try {
      const opening = element.get("openingElement");
      const name = opening.get("name");
      if (name.isJSXIdentifier() && /^[a-z]/.test(name.node.name)) continue;

      if (name.isJSXIdentifier()) {
        const declaration = name.scope.getBinding(name.node.name)?.path;
        if (
          declaration?.isVariableDeclarator() &&
          (name.node.start ?? Infinity) < (declaration.node.end ?? 0) &&
          name.getFunctionParent() === declaration.getFunctionParent()
        )
          continue;
      }

      const target = yield* graph.valueTarget(owner, name, new Set());
      if (!target || "external" in target || !target.path.isCallExpression())
        continue;

      const factory = getModuleReference(target.path.get("callee"));
      if (
        factory?.unsafe ||
        factory?.source !== "@mincho-js/react/runtime" ||
        factory.members.join(".") !== "$$styled"
      )
        continue;

      const args = target.path.get("arguments");
      if (
        args.length !== 2 ||
        !args[0]!.isStringLiteral() ||
        !/^[a-z][\w-]*$/.test(args[0]!.node.value)
      )
        continue;
      if (elementIdentityObserved(element)) continue;

      const recipe = yield* serializedRecipe(graph, target.module, args[1]!);
      if (
        !recipe ||
        !recipe.config ||
        typeof recipe.config !== "object" ||
        Array.isArray(recipe.config)
      )
        continue;

      const groups = recipe.config.variantClassNames;
      if (!groups || typeof groups !== "object" || Array.isArray(groups))
        continue;

      const variants = Object.keys(groups);
      if (
        variants.some((key) =>
          [
            "as",
            "ref",
            "key",
            "children",
            "className",
            "__self",
            "__source"
          ].includes(key)
        )
      )
        continue;

      const selection: Record<string, StaticData> = Object.create(null);
      const seen = new Set<string>();
      const budget = createStaticExpressionBudget();
      let className = "";

      for (const attribute of opening.get("attributes")) {
        if (
          !attribute.isJSXAttribute() ||
          !t.isJSXIdentifier(attribute.node.name)
        )
          throw new Error("Unproved JSX props");

        const key = attribute.node.name.name;
        if (["as", "ref", "__self", "__source"].includes(key) || seen.has(key))
          throw new Error("Observable styled props");

        seen.add(key);

        if (!variants.includes(key) && key !== "className") continue;

        const valuePath = attribute.get("value");
        let value: StaticData = true;

        if (valuePath.isStringLiteral()) {
          // JSX compilers normalize literal attribute whitespace differently.
          if (/[\r\n\t]/.test(valuePath.node.value))
            throw new Error("JSX whitespace normalization");

          value = valuePath.node.value;
        } else if (valuePath.isJSXExpressionContainer())
          value = staticData(
            yield* evaluateStaticExpression(
              graph,
              owner,
              valuePath.get("expression"),
              budget
            )
          );
        else if (valuePath.node) throw new Error("Non-static JSX prop");

        if (value !== null && typeof value === "object")
          throw new Error("Non-primitive JSX prop");

        if (key === "className") className = value == null ? "" : String(value);
        else selection[key] = value;
      }

      if (options.pureFunctions === false && budget.calls) continue;
      if (!(yield* componentUsesAreSafe(graph, target.path))) continue;

      const recipeTarget = yield* graph.valueTarget(
        target.module,
        args[1]!,
        new Set()
      );
      if (
        !recipeTarget ||
        "external" in recipeTarget ||
        !recipeTarget.path.isCallExpression() ||
        !(yield* componentUsesAreSafe(graph, recipeTarget.path, true))
      )
        continue;

      elements.push({
        key: expressionKey(element),
        ...recipe,
        options: selection,
        tag: args[0]!.node.value,
        variants,
        className
      });
    } catch {
      /* Dynamic props or observable component identity keep the wrapper. */
    }
  }

  return { calls, elements, dependencies: [...graph.dependencies] };
}

function* serializedRecipe(
  graph: ModuleGraph,
  module: SourceModule,
  path: NodePath<t.Node>
): ModuleGraphFlow<Omit<StaticRecipeCall, "key" | "options"> | null> {
  const target = yield* graph.valueTarget(module, path, new Set());
  if (!target || "external" in target || !target.path.isCallExpression())
    return null;

  const factory = getModuleReference(target.path.get("callee"));
  if (
    factory?.unsafe ||
    factory?.source !== "@mincho-js/css/rules/createRuntimeFn" ||
    factory.members.join(".") !== "createRuntimeFn" ||
    target.path.node.arguments.length !== 1
  )
    return null;

  const configPath = target.path.get("arguments")[0]!;
  if (!configPath.isExpression()) return null;

  const budget = createStaticExpressionBudget();
  const config = yield* evaluateStaticExpression(
    graph,
    target.module,
    configPath,
    budget
  );
  if (budget.calls) return null;

  return {
    identity: `${target.module.id}\0${expressionKey(target.path)}`,
    config: staticData(config)
  };
}

/** Refuse aliases that escape, observe identity or modify the component in the loaded graph. */
function* componentUsesAreSafe(
  graph: ModuleGraph,
  factory: NodePath<t.CallExpression>,
  recipe = false
): ModuleGraphFlow<boolean> {
  let visited = 0;

  for (const module of graph.modules.values()) {
    const observed: NodePath<t.Node>[] = [];
    module.program.traverse({
      ReferencedIdentifier(path) {
        if (!safeComponentReference(path, recipe)) observed.push(path);
      },

      MemberExpression(path) {
        if (!safeComponentReference(path, recipe)) observed.push(path);
      }
    });

    for (const path of observed) {
      if (++visited > 10000) return false;

      const source = getModuleReference(path)?.source;
      if (
        source === "@mincho-js/react/runtime" ||
        source === "@mincho-js/css/rules/createRuntimeFn"
      )
        continue;

      try {
        const target = yield* graph.valueTarget(module, path, new Set());
        if (
          target &&
          !("external" in target) &&
          target.path.node === factory.node
        )
          return false;
      } catch {
        // Unrelated unsupported bindings cannot expose this component.
      }
    }
  }

  return true;
}

function safeComponentReference(
  path: NodePath<t.Node>,
  recipe: boolean
): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (recipe && parent.isCallExpression()) {
    if (parent.node.callee === path.node) return true;

    const callee = getModuleReference(parent.get("callee"));
    if (
      !callee?.unsafe &&
      callee?.source === "@mincho-js/react/runtime" &&
      callee.members.join(".") === "$$styled" &&
      parent.node.arguments[1] === path.node
    )
      return true;
  }

  if (
    recipe &&
    parent.isMemberExpression() &&
    parent.node.object === path.node
  ) {
    const use = parent.parentPath;
    if (
      !use.isAssignmentExpression() &&
      !use.isUpdateExpression() &&
      !use.isUnaryExpression({ operator: "delete" })
    )
      return true;
  }

  if (
    parent.isJSXOpeningElement() ||
    parent.isJSXClosingElement() ||
    parent.isJSXMemberExpression()
  )
    return true;
  if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration())
    return true;
  if (
    parent.isVariableDeclarator() &&
    parent.node.init === path.node &&
    t.isIdentifier(parent.node.id)
  )
    return Boolean(parent.scope.getBinding(parent.node.id.name)?.constant);

  if (parent.isAssignmentExpression() && parent.node.right === path.node) {
    const left = parent.get("left");

    if (left.isMemberExpression()) {
      const object = left.get("object");

      return (
        (object.isIdentifier({ name: "exports" }) &&
          !object.scope.getBinding("exports")) ||
        (object.isIdentifier({ name: "module" }) &&
          !object.scope.getBinding("module") &&
          t.isIdentifier(left.node.property, { name: "exports" }))
      );
    }
  }

  return false;
}

function elementIdentityObserved(element: NodePath<t.JSXElement>): boolean {
  const parent = element.parentPath;
  if (parent.isMemberExpression() || parent.isCallExpression()) return true;
  if (!parent.isVariableDeclarator() || !t.isIdentifier(parent.node.id))
    return false;

  const binding = parent.scope.getBinding(parent.node.id.name);

  return (
    !binding?.constant ||
    binding.referencePaths.some((reference) => {
      const use = reference.parentPath;

      return (
        !use?.isReturnStatement() &&
        !use?.isJSXExpressionContainer() &&
        !(use?.isArrowFunctionExpression() && use.node.body === reference.node)
      );
    })
  );
}

export function applyRuntimeExpressions(options: {
  filename: string;
  source: string;
  replacements: ReadonlyArray<{ key: string; value: string }>;
  elements?: ReadonlyArray<{
    key: string;
    tag: string;
    variants: readonly string[];
    className: string;
  }>;
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
            const elements = new Map(
              options.elements?.map((element) => [element.key, element])
            );

            const matches: Array<{
              path: NodePath<t.JSXElement>;
              element: NonNullable<typeof options.elements>[number];
            }> = [];

            program.traverse({
              JSXElement(path) {
                const element = elements.get(expressionKey(path));

                if (element) matches.push({ path, element });
              }
            });
            preserveModuleEffects(program, () => {
              applyPureFunctions(program, {
                replacements: options.replacements.map((item) => ({
                  key: item.key,
                  expression: t.stringLiteral(item.value)
                })),
                dependencies: [],
                diagnostics: []
              });

              for (const { path, element } of matches.reverse()) {
                const opening = path.node.openingElement;
                opening.name = t.jsxIdentifier(element.tag);

                if (path.node.closingElement)
                  path.node.closingElement.name = t.jsxIdentifier(element.tag);

                opening.attributes = opening.attributes.filter(
                  (attribute) =>
                    !t.isJSXAttribute(attribute) ||
                    !t.isJSXIdentifier(attribute.name) ||
                    (attribute.name.name !== "className" &&
                      !element.variants.includes(attribute.name.name))
                );
                opening.attributes.push(
                  t.jsxAttribute(
                    t.jsxIdentifier("className"),
                    t.jsxExpressionContainer(t.stringLiteral(element.className))
                  )
                );
              }
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
        (property.computed && t.isIdentifier(property.key)) ||
        !t.isExpression(property.value)
      )
        throw new Error("Non-static object");

      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
          ? String(property.key.value)
          : null;
      if (key === null || key === "prototype" || key in Object.prototype)
        throw new Error("Unsupported key");

      result[key] = staticData(property.value);
    }

    return result;
  }

  throw new Error("Non-static value");
}

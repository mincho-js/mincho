import { types as t, type NodePath } from "@babel/core";
import { addNamed } from "@babel/helper-module-imports";
import type { Binding } from "@babel/traverse";
import { getModuleReference } from "../commonjs/bindings.js";
import type { ModuleGraphFlow } from "../moduleGraph.js";
import type { StaticData } from "./runtimeExpressions.js";
import { isIntrinsicElement } from "./intrinsicElements.js";
import { primitiveKind } from "./runtimeCodegen.js";
import { hasDynamicScope } from "./dynamicScope.js";

export interface DynamicStyledElement {
  key: string;
  tag: string;
  recipe: t.Expression;
  component: t.Expression;
  variants: string[];
}

export interface StyledChain {
  key: string;
  tag: string;
  stages: { recipe: t.Expression; variantKeys: string[] }[];
}

interface Component {
  binding: Binding;
  path: NodePath<t.CallExpression>;
  parent?: Component;
  tag?: string;
  stages?: StyledChain["stages"];
  recipeBindings?: (Binding | undefined)[];
  elements: NodePath<t.JSXElement>[];
  safe: boolean;
}

const reserved = new Set([
  "as",
  "ref",
  "key",
  "__self",
  "__source",
  "className",
  "children"
]);

// SourceAstCache clones retain locations, but Babel cloneNode drops start/end.
const keyOf = (node: t.Node) =>
  [
    node.loc?.start.line,
    node.loc?.start.column,
    node.loc?.end.line,
    node.loc?.end.column
  ].join(":");

function precedesEnd(node: t.Node, declaration: t.Node): boolean {
  const start = node.loc?.start;
  const end = declaration.loc?.end;

  return (
    !start ||
    !end ||
    start.line < end.line ||
    (start.line === end.line && start.column < end.column)
  );
}

/** A closed graph is required because replacing a wrapper can change reconciliation. */
export function* analyzeStyledRuntime(
  program: NodePath<t.Program>,
  resolveRecipe: (
    path: NodePath<t.Node>
  ) => ModuleGraphFlow<{ config: StaticData } | null>
): ModuleGraphFlow<{
  dynamicElements: DynamicStyledElement[];
  chains: StyledChain[];
}> {
  if (hasDynamicScope(program)) return { dynamicElements: [], chains: [] };

  const components = new Map<Binding, Component>();
  program.traverse({
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;

      const init = path.get("init");
      if (!init.isCallExpression() || init.node.arguments.length !== 2) return;

      const factory = getModuleReference(init.get("callee"));
      if (
        !factory ||
        !["@mincho-js/react", "@mincho-js/react/runtime"].includes(
          factory.source
        ) ||
        factory.unsafe ||
        factory.members.join(".") !== "$$styled"
      )
        return;

      const binding = path.scope.getBinding(path.node.id.name);

      if (binding?.constant)
        components.set(binding, {
          binding,
          path: init,
          elements: [],
          safe: true
        });
    }
  });

  const visiting = new Set<Component>();

  function* prepare(component: Component): ModuleGraphFlow<void> {
    if (component.stages || !component.safe) return;

    if (visiting.has(component)) {
      component.safe = false;

      return;
    }

    visiting.add(component);

    const [base, recipePath] = component.path.get("arguments");

    if (!base?.isExpression() || !recipePath?.isIdentifier()) {
      component.safe = false;

      return;
    }

    if (base.isStringLiteral() && isIntrinsicElement(base.node.value))
      component.tag = base.node.value;
    else if (base.isIdentifier()) {
      const binding = base.scope.getBinding(base.node.name);
      const parent = binding && components.get(binding);

      if (parent) {
        if (
          base.getFunctionParent() === parent.path.getFunctionParent() &&
          precedesEnd(base.node, parent.path.node)
        ) {
          component.safe = false;

          return;
        }

        component.parent = parent;
        yield* prepare(parent);
        component.tag = parent.tag;
      }
    }

    const recipe = yield* resolveRecipe(recipePath);
    const config = recipe?.config;

    if (
      !component.tag ||
      !config ||
      typeof config !== "object" ||
      Array.isArray(config)
    ) {
      component.safe = false;

      return;
    }

    const variants = config.variantClassNames;

    if (
      !variants ||
      typeof variants !== "object" ||
      Array.isArray(variants) ||
      Object.keys(variants).some((key) => reserved.has(key))
    ) {
      component.safe = false;

      return;
    }

    component.stages = [
      {
        recipe: t.cloneNode(recipePath.node),
        variantKeys: Object.keys(variants)
      },
      ...(component.parent?.stages ?? [])
    ];
    component.recipeBindings = [
      recipePath.scope.getBinding(recipePath.node.name),
      ...(component.parent?.recipeBindings ?? [])
    ];

    if (!sameRecipeBindings(component, component.path)) component.safe = false;

    visiting.delete(component);
  }

  for (const component of components.values()) {
    yield* prepare(component);

    for (const reference of component.binding.referencePaths) {
      const parent = reference.parentPath;

      if (
        reference.isJSXIdentifier() &&
        (parent?.isJSXOpeningElement() || parent?.isJSXClosingElement())
      ) {
        const element = parent.parentPath;

        if (
          !element.isJSXElement() ||
          !sameRecipeBindings(component, element) ||
          (reference.getFunctionParent() ===
            component.path.getFunctionParent() &&
            precedesEnd(reference.node, component.path.node)) ||
          !safeElement(
            element,
            component.stages?.flatMap((stage) => stage.variantKeys) ?? []
          )
        )
          component.safe = false;
        else if (parent.isJSXOpeningElement()) component.elements.push(element);
      } else if (
        !(
          parent?.isCallExpression() &&
          parent.get("arguments")[0] === reference &&
          [...components.values()].some((item) => item.path === parent)
        )
      )
        component.safe = false;
    }

    // Babel records exports as references; also reject declaration exports explicitly.
    if (
      component.binding.path.parentPath?.parentPath?.isExportNamedDeclaration()
    )
      component.safe = false;
  }

  let changed = true;

  while (changed) {
    changed = false;

    for (const component of components.values())
      if (component.parent && component.safe !== component.parent.safe) {
        component.safe = component.parent.safe = false;
        changed = true;
      }
  }

  const dynamicElements: DynamicStyledElement[] = [];
  const chains: StyledChain[] = [];

  for (const component of components.values()) {
    if (!component.safe || !component.stages || !component.tag) continue;

    if (component.stages.length > 1)
      chains.push({
        key: keyOf(component.path.node),
        tag: component.tag,
        stages: component.stages
      });
    else
      for (const element of component.elements)
        dynamicElements.push({
          key: keyOf(element.node),
          tag: component.tag,
          recipe: component.stages[0]!.recipe,
          component: t.identifier(component.binding.identifier.name),
          variants: component.stages[0]!.variantKeys
        });
  }

  return { dynamicElements, chains };
}

function sameRecipeBindings(
  component: Component,
  destination: NodePath
): boolean {
  return Boolean(
    component.stages?.every(
      (stage, index) =>
        t.isIdentifier(stage.recipe) &&
        component.recipeBindings?.[index] &&
        destination.scope.getBinding(stage.recipe.name) ===
          component.recipeBindings[index]
    )
  );
}

function provenPrimitive(
  path: NodePath<t.Node>,
  seen = new Set<Binding>()
): boolean {
  if (primitiveKind(path.node)) return true;
  if (!path.isIdentifier()) return false;

  const binding = path.scope.getBinding(path.node.name);
  if (
    !binding?.constant ||
    !binding.path.isVariableDeclarator() ||
    seen.has(binding)
  )
    return false;

  seen.add(binding);

  const init = binding.path.get("init");

  return init.isExpression() && provenPrimitive(init, seen);
}

function safeElement(
  path: NodePath<t.JSXElement>,
  variants: string[]
): boolean {
  // Generated staging uses the same global Object.keys as the runtime module.
  if (path.scope.getBinding("Object")) return false;

  const names = new Set<string>();

  for (const attribute of path.get("openingElement").get("attributes")) {
    if (!attribute.isJSXAttribute() || !t.isJSXIdentifier(attribute.node.name))
      return false;

    const name = attribute.node.name.name;
    if (
      name === "__proto__" ||
      names.has(name) ||
      (reserved.has(name) && name !== "className")
    )
      return false;

    names.add(name);

    const value = attribute.get("value");

    if (value.isJSXExpressionContainer()) {
      const expression = value.get("expression");
      if (
        !provenPrimitive(expression) &&
        !(
          !variants.includes(name) &&
          name !== "className" &&
          (expression.isArrowFunctionExpression() ||
            expression.isFunctionExpression())
        )
      )
        return false;
    } else if (
      value.node &&
      (!value.isStringLiteral() || /[\r\n\t]/.test(value.node.value))
    )
      return false;
  }

  let safeChildren = true;
  path.traverse({
    JSXSpreadChild() {
      safeChildren = false;
    },

    JSXElement(child) {
      if (
        !t.isJSXIdentifier(child.node.openingElement.name) ||
        !isIntrinsicElement(child.node.openingElement.name.name)
      )
        safeChildren = false;
    },

    JSXExpressionContainer(child) {
      if (child.parentPath.isJSXAttribute()) return;
      if (
        !child.get("expression").isJSXEmptyExpression() &&
        !provenPrimitive(child.get("expression"))
      )
        safeChildren = false;
    }
  });

  if (!safeChildren) return false;

  let current: NodePath<t.Node> = path;

  while (current.parentPath && !current.parentPath.isFunction()) {
    const parent = current.parentPath;

    if (parent.isJSXElement()) {
      if (
        !t.isJSXIdentifier(parent.node.openingElement.name) ||
        !isIntrinsicElement(parent.node.openingElement.name.name)
      )
        return false;
    } else if (
      !parent.isJSXFragment() &&
      !parent.isReturnStatement() &&
      !parent.isBlockStatement()
    )
      return false;

    current = parent;
  }

  const fn = current.parentPath;
  if (!fn?.isFunction() || fn.parentPath.isCallExpression()) return false;

  let returns = 0;
  fn.traverse({
    Function(inner) {
      inner.skip();
    },

    ReturnStatement() {
      returns++;
    }
  });

  return returns <= 1;
}

export function applyStyledRuntime(
  program: NodePath<t.Program>,
  elements: readonly DynamicStyledElement[],
  chains: readonly StyledChain[]
): void {
  const byElement = new Map(elements.map((item) => [item.key, item]));
  const byFactory = new Map(chains.map((item) => [item.key, item]));
  let chainHelper: t.Identifier | undefined;
  let createElement: t.Identifier | undefined;
  program.traverse({
    CallExpression(path) {
      const chain = byFactory.get(keyOf(path.node));
      if (!chain) return;

      chainHelper ??= addNamed(
        program,
        "$$styledChain",
        "@mincho-js/react/runtime"
      );

      const base = path.node.arguments[0];
      const replacement = t.callExpression(t.cloneNode(chainHelper), [
        t.stringLiteral(chain.tag),
        t.arrayExpression(
          chain.stages.map((stage) =>
            t.objectExpression([
              t.objectProperty(
                t.identifier("styles"),
                t.cloneNode(stage.recipe)
              ),
              t.objectProperty(
                t.identifier("variantKeys"),
                t.arrayExpression(
                  stage.variantKeys.map((key) => t.stringLiteral(key))
                )
              )
            ])
          )
        )
      ]);

      // Preserve the original parent binding read, including a possible TDZ.
      path.replaceWith(
        t.isExpression(base)
          ? t.sequenceExpression([t.cloneNode(base), replacement])
          : replacement
      );
    },

    JSXElement: {
      exit(path) {
        const element = byElement.get(keyOf(path.node));
        if (
          !element ||
          t.isJSXIdentifier(path.node.openingElement.name, {
            name: element.tag
          })
        )
          return;

        const jsx = t.cloneNode(path.node, true);

        // The original JSX type is read before its props or children evaluate.
        const effects: t.Expression[] = [t.cloneNode(element.component)];

        const snapshot = (expression: t.Expression): t.Expression => {
          const id = path.scope.generateUidIdentifier("styledProp");
          path.scope.push({ id, kind: "let" });
          effects.push(
            t.assignmentExpression("=", t.cloneNode(id), expression)
          );

          return t.cloneNode(id);
        };

        const props: { name: string; value: t.Expression }[] = [];

        for (const attribute of jsx.openingElement.attributes) {
          if (
            !t.isJSXAttribute(attribute) ||
            !t.isJSXIdentifier(attribute.name)
          )
            continue;

          let value: t.Expression = t.booleanLiteral(true);

          if (t.isStringLiteral(attribute.value))
            value = t.stringLiteral(attribute.value.value);

          if (
            t.isJSXExpressionContainer(attribute.value) &&
            t.isExpression(attribute.value.expression)
          ) {
            value = snapshot(attribute.value.expression);
            attribute.value.expression = value;
          }

          props.push({ name: attribute.name.name, value });
        }

        // JSX children are evaluated before React invokes the original wrapper.
        jsx.children = jsx.children.map((child) => {
          if (
            t.isJSXExpressionContainer(child) &&
            t.isExpression(child.expression)
          )
            child.expression = snapshot(child.expression);
          if (t.isJSXElement(child) || t.isJSXFragment(child))
            return t.jsxExpressionContainer(snapshot(child));

          return child;
        });

        const children = t.react.buildChildren(jsx);

        if (children.length)
          props.push({
            name: "children",
            value:
              children.length === 1
                ? (children[0]! as t.Expression)
                : t.arrayExpression(children as t.Expression[])
          });

        // Match the wrapper's reads and ordinary writes. An inherited setter
        // may consume a variant, change rest's prototype, or install getters.
        const uid = (name: string) => path.scope.generateUidIdentifier(name);

        const input = uid("styledInput");
        const as = uid("styledAs");
        const className = uid("styledClassName");
        const remaining = uid("styledRemaining");
        const selection = uid("styledSelection");
        const rest = uid("styledRest");
        const key = uid("styledKey");
        const value = uid("styledValue");
        const classes = uid("styledClasses");

        const member = (object: t.Identifier) =>
          t.memberExpression(t.cloneNode(object), t.cloneNode(key), true);

        const assign = (object: t.Identifier) =>
          t.expressionStatement(
            t.assignmentExpression("=", member(object), t.cloneNode(value))
          );

        const condition = element.variants
          .map((name) =>
            t.binaryExpression("===", t.cloneNode(key), t.stringLiteral(name))
          )
          .reduce<t.Expression>(
            (left, right) => t.logicalExpression("||", left, right),
            t.booleanLiteral(false)
          );

        const joined = t.callExpression(
          t.memberExpression(
            t.arrayExpression([
              t.callExpression(t.cloneNode(element.recipe), [
                t.cloneNode(selection)
              ]),
              className
            ]),
            t.identifier("join")
          ),
          [t.stringLiteral(" ")]
        );

        createElement ??= addNamed(program, "createElement", "react");

        const rendered = t.callExpression(t.cloneNode(createElement), [
          t.logicalExpression("??", as, t.stringLiteral(element.tag)),
          t.objectExpression([
            t.spreadElement(t.cloneNode(rest)),
            t.objectProperty(t.identifier("className"), classes),
            t.objectProperty(t.identifier("ref"), t.nullLiteral())
          ])
        ]);

        // Keep getter receivers and object-rest snapshots intact. The runtime
        // module is strict even when the consumer itself is CommonJS.
        const body = t.blockStatement(
          [
            t.variableDeclaration("const", [
              t.variableDeclarator(
                t.objectPattern([
                  t.objectProperty(t.identifier("as"), as),
                  t.objectProperty(t.identifier("className"), className),
                  t.restElement(remaining)
                ]),
                t.cloneNode(input)
              )
            ]),
            t.variableDeclaration("const", [
              t.variableDeclarator(selection, t.objectExpression([])),
              t.variableDeclarator(rest, t.objectExpression([]))
            ]),
            t.forOfStatement(
              t.variableDeclaration("const", [t.variableDeclarator(key)]),
              t.callExpression(
                t.memberExpression(
                  t.identifier("Object"),
                  t.identifier("keys")
                ),
                [t.cloneNode(remaining)]
              ),
              t.blockStatement([
                t.variableDeclaration("const", [
                  t.variableDeclarator(value, member(remaining))
                ]),
                t.ifStatement(condition, assign(selection), assign(rest))
              ])
            ),
            t.variableDeclaration("const", [
              t.variableDeclarator(classes, joined)
            ]),
            t.returnStatement(rendered)
          ],
          [t.directive(t.directiveLiteral("use strict"))]
        );

        const stage = t.callExpression(
          t.arrowFunctionExpression([input], body),
          [
            t.objectExpression(
              props.map((prop) =>
                t.objectProperty(t.stringLiteral(prop.name), prop.value)
              )
            )
          ]
        );

        const expression = t.sequenceExpression([...effects, stage]);
        path.replaceWith(
          (path.parentPath.isJSXElement() || path.parentPath.isJSXFragment()) &&
            !t.isJSXElement(expression)
            ? t.jsxExpressionContainer(expression)
            : expression
        );
        path.skip();
      }
    }
  });
}

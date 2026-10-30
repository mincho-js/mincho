import {
  layoutPropKeys,
  isLayoutOwnedStyle,
  layoutStaticAttribute
} from "@mincho-js/css/layout/core";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { addSideEffect } from "@babel/helper-module-imports";
import { flattenJsxElement } from "./intrinsicElements.js";
import { registerImportMethod } from "../utils.js";

/**
 * Lowers static `@mincho-js/react/layout` elements to intrinsic elements with a
 * `compileLayoutClass(...)` call, which the normal extraction moves into the
 * CSS sidecar. The class holds the same parent-independent declarations the
 * React renderer writes inline, and the shared layout stylesheet applies them
 * for the actual parent, so no component, context or effect remains. Elements
 * that need runtime values or behavior stay components.
 */
const componentSource = "@mincho-js/react/layout";
const classSource = "@mincho-js/css/layout";
const stylesheetSource = "@mincho-js/css/layout.css";
const kinds = ["Box", "Stack", "HStack", "VStack", "Item"] as const;
type Kind = (typeof kinds)[number];

/** Props whose behavior needs the runtime component. */
const runtimeKeys = new Set(["debugLayout"]);

type Static =
  string | number | boolean | null | Static[] | { [key: string]: Static };

interface LoweringPlan {
  kind: Kind;
  props: Record<string, Static>;
  kept: t.JSXAttribute[];
  tag: string;
  axis: Static | undefined;
  className: t.Expression | t.StringLiteral | undefined;
  classNamePosition: number | undefined;
  styleConflict: [NodePath<t.JSXAttribute>, string] | undefined;
}

function layoutKind(name: NodePath<t.Node>): Kind | undefined {
  return kinds.find((kind) => name.referencesImport(componentSource, kind));
}

function isStatic(value: unknown): value is Static {
  if (value === null) return true;
  if (["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isStatic);
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.values(value as object).every(isStatic);
  return false;
}

function attributeValue(
  attribute: NodePath<t.JSXAttribute>
): { value: Static } | undefined {
  const value = attribute.get("value");
  if (!value.node) return { value: true };
  if (value.isStringLiteral()) return { value: value.node.value };
  if (!value.isJSXExpressionContainer()) return undefined;
  const expression = value.get("expression");
  // A confident value does not prove evaluation can be removed: Babel can
  // ignore sequence operands and the argument of void, including nested calls.
  if (expression.isJSXEmptyExpression() || !expression.isPure())
    return undefined;
  const result = (expression as NodePath<t.Expression>).evaluate();
  return result.confident && isStatic(result.value)
    ? { value: result.value }
    : undefined;
}

/** Keys of a style object literal, when every key is static. */
function styleKeys(attribute: NodePath<t.JSXAttribute>): string[] | undefined {
  const value = attribute.node.value;
  if (
    !t.isJSXExpressionContainer(value) ||
    !t.isObjectExpression(value.expression)
  )
    return undefined;
  const keys: string[] = [];
  for (const property of value.expression.properties) {
    if (!t.isObjectProperty(property) || property.computed) return undefined;
    if (t.isIdentifier(property.key)) keys.push(property.key.name);
    else if (t.isStringLiteral(property.key)) keys.push(property.key.value);
    else return undefined;
  }
  return keys;
}

function toExpression(value: Static): t.Expression {
  return t.valueToNode(value) as t.Expression;
}

/** A remaining component or opaque child can still consume LayoutParent. */
function hasContextFreeChildren(
  path: NodePath<t.JSXElement | t.JSXFragment>,
  canLower: (child: NodePath<t.JSXElement>) => boolean
): boolean {
  if (path.isJSXElement()) {
    for (const attribute of path.get("openingElement").get("attributes")) {
      if (!attribute.isJSXAttribute()) return false;
      if (t.isJSXIdentifier(attribute.node.name, { name: "children" }))
        return false;
    }
  }
  for (const child of path.get("children")) {
    if (child.isJSXText()) continue;
    if (child.isJSXElement()) {
      const opening = child.get("openingElement");
      if (layoutKind(opening.get("name"))) {
        if (!canLower(child)) return false;
        continue;
      }
      const name = opening.node.name;
      if (!t.isJSXIdentifier(name) || !/^[a-z]/.test(name.name)) return false;
      if (!hasContextFreeChildren(child, canLower)) return false;
    } else if (child.isJSXFragment()) {
      if (!hasContextFreeChildren(child, canLower)) return false;
    } else if (child.isJSXExpressionContainer()) {
      const expression = child.get("expression");
      if (expression.isJSXEmptyExpression()) continue;
      // Primitive constants cannot hide a runtime Item. Unknown values,
      // callbacks and components are intentionally not executed or unfolded.
      if (!expression.isPure()) return false;
      const result = (expression as NodePath<t.Expression>).evaluate();
      if (
        !result.confident ||
        (result.value !== null &&
          !["undefined", "string", "number", "boolean"].includes(
            typeof result.value
          ))
      )
        return false;
    } else return false;
  }
  return true;
}

function planElement(
  path: NodePath<t.JSXElement>,
  canLower: (child: NodePath<t.JSXElement>) => boolean
): LoweringPlan | false {
  const opening = path.get("openingElement");
  const kind = layoutKind(opening.get("name"));
  if (!kind) return false;
  // Development metadata must use the bundler's environment, not a local
  // application binding named process.
  if (path.scope.getBinding("process")) return false;

  const props: Record<string, Static> = {};
  const kept: Array<t.JSXAttribute> = [];
  let tag = "div";
  let className: t.Expression | t.StringLiteral | undefined;
  let classNamePosition: number | undefined;
  let styleConflict: [NodePath<t.JSXAttribute>, string] | undefined;
  for (const attribute of opening.get("attributes")) {
    if (!attribute.isJSXAttribute()) return false;
    const nameNode = attribute.node.name;
    if (!t.isJSXIdentifier(nameNode)) return false;
    const name = nameNode.name;
    if (runtimeKeys.has(name)) return false;
    if (layoutPropKeys.has(name) || name === "as") {
      const result = attributeValue(attribute);
      if (!result) return false;
      if (name === "as") {
        if (
          typeof result.value !== "string" ||
          !/^[a-z][a-z0-9]*$/.test(result.value)
        )
          return false;
        tag = result.value;
      } else props[name] = result.value;
      continue;
    }
    if (name === "style") {
      const keys = styleKeys(attribute);
      if (!keys) return false;
      const owned = keys.find(isLayoutOwnedStyle);
      if (owned) {
        // Undefined values are ignored by the renderer. Unknown values may
        // become undefined, so leave their validation on the runtime path.
        if (!attributeValue(attribute)) return false;
        styleConflict = [attribute, owned];
      }
    }
    if (name === "className") {
      if (classNamePosition !== undefined) return false;
      const value = attribute.node.value;
      if (t.isStringLiteral(value)) className = value;
      else if (
        t.isJSXExpressionContainer(value) &&
        !t.isJSXEmptyExpression(value.expression)
      )
        className = value.expression;
      else return false;
      classNamePosition = kept.length;
      kept.push(attribute.node);
      continue;
    }
    kept.push(attribute.node);
  }

  const axis: Static | undefined =
    kind === "HStack"
      ? "horizontal"
      : kind === "VStack"
        ? "vertical"
        : kind === "Stack"
          ? props.axis
          : undefined;
  if (kind === "Stack" && axis !== "horizontal" && axis !== "vertical")
    return false;
  // Plan the whole subtree before changing any element. Every runtime layout
  // element provides context (null for Box/Item), and its children must keep
  // their runtime registrations when that boundary cannot be removed.
  if (!hasContextFreeChildren(path, canLower)) return false;

  return {
    kind,
    props,
    kept,
    tag,
    axis,
    className,
    classNamePosition,
    styleConflict
  };
}

function lowerElement(path: NodePath<t.JSXElement>, plan: LoweringPlan): void {
  const {
    kind,
    props,
    kept,
    tag,
    axis,
    className,
    classNamePosition,
    styleConflict
  } = plan;
  // Diagnose only elements in a subtree that can be lowered. Runtime layout
  // boundaries keep validation of their descendants on the runtime path too.
  if (styleConflict)
    throw styleConflict[0].buildCodeFrameError(
      `E_LAYOUT_CAPABILITY: style.${styleConflict[1]} conflicts with layout semantics; use a layout prop.`
    );

  const compile = t.callExpression(
    registerImportMethod(path, "compileLayoutClass", classSource),
    [t.stringLiteral(kind), toExpression(props)]
  );
  const merged = !className
    ? compile
    : t.isStringLiteral(className)
      ? className.value
        ? t.binaryExpression(
            "+",
            compile,
            t.stringLiteral(` ${className.value}`)
          )
        : compile
      : // Matches the renderer: falsy decoration adds nothing.
        t.callExpression(
          t.memberExpression(
            t.callExpression(
              t.memberExpression(
                t.arrayExpression([compile, className]),
                t.identifier("filter")
              ),
              [
                t.arrowFunctionExpression(
                  [t.identifier("value")],
                  t.identifier("value")
                )
              ]
            ),
            t.identifier("join")
          ),
          [t.stringLiteral(" ")]
        );

  const attribute = (name: string, value: t.Expression | t.StringLiteral) =>
    t.jsxAttribute(
      t.jsxIdentifier(name),
      t.isStringLiteral(value) ? value : t.jsxExpressionContainer(value)
    );
  const attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute> = [
    ...kept,
    attribute("data-mincho-layout", t.stringLiteral(kind)),
    ...(typeof axis === "string"
      ? [attribute("data-mincho-layout-axis", t.stringLiteral(axis))]
      : []),
    ...(props.position === "absolute"
      ? [attribute("data-mincho-layout-out", t.stringLiteral(""))]
      : [])
  ];
  // Keep decoration evaluation in its authored position relative to other
  // attributes; moving it to the end can reorder application side effects.
  const classAttribute = attribute("className", merged);
  if (classNamePosition === undefined) attributes.push(classAttribute);
  else attributes[classNamePosition] = classAttribute;
  // A separately compiled component may render into a runtime Stack whose
  // diagnostics still need its input. Production renders no metadata, and
  // minification removes the empty spread and its unreachable branch.
  attributes.push(
    t.jsxSpreadAttribute(
      t.conditionalExpression(
        t.binaryExpression(
          "!==",
          t.memberExpression(
            t.memberExpression(t.identifier("process"), t.identifier("env")),
            t.identifier("NODE_ENV")
          ),
          t.stringLiteral("production")
        ),
        t.objectExpression([
          t.objectProperty(
            t.stringLiteral(layoutStaticAttribute),
            t.stringLiteral(JSON.stringify(props))
          )
        ]),
        t.objectExpression([])
      )
    )
  );
  flattenJsxElement(path, tag, attributes);
}

/** Returns whether any element was lowered. */
export function lowerLayoutJsx(program: NodePath<t.Program>): boolean {
  let lowered = false;
  const plans = new WeakMap<t.JSXElement, LoweringPlan | false>();
  const getPlan = (path: NodePath<t.JSXElement>): LoweringPlan | false => {
    const cached = plans.get(path.node);
    if (cached !== undefined) return cached;
    const plan = planElement(path, (child) => Boolean(getPlan(child)));
    plans.set(path.node, plan);
    return plan;
  };
  program.traverse({
    JSXElement(path) {
      if (!layoutKind(path.get("openingElement").get("name"))) return;
      const plan = getPlan(path);
      if (!plan) {
        path.skip();
        return;
      }
      lowerElement(path, plan);
      lowered = true;
    }
  });
  if (lowered) {
    addSideEffect(program, stylesheetSource);
    // Register the inserted import bindings so extraction recognizes the calls.
    program.scope.crawl();
  }
  return lowered;
}

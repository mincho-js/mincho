import { types as t, type NodePath } from "@babel/core";

/** Binding writes are not all Babel referenced identifiers (notably `x =`). */
export function isWriteTarget(path: NodePath<t.Identifier>): boolean {
  let child: NodePath<t.Node> = path;
  for (
    let parent = path.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (parent.isAssignmentExpression()) return parent.node.left === child.node;
    if (parent.isUpdateExpression()) return parent.node.argument === child.node;
    if (parent.isForInStatement() || parent.isForOfStatement())
      return parent.node.left === child.node;
    if (
      parent.isObjectProperty() &&
      parent.parentPath.isObjectPattern() &&
      parent.node.value === child.node
    )
      continue;
    if (
      parent.isObjectPattern() ||
      parent.isArrayPattern() ||
      (parent.isRestElement() && parent.node.argument === child.node) ||
      (parent.isAssignmentPattern() && parent.node.left === child.node)
    )
      continue;
    return false;
  }
  return false;
}

/** Private environments are lexical class bindings, not ordinary scope bindings. */
function ownsPrivateName(
  path: NodePath<t.PrivateName>,
  callback: t.Node
): boolean {
  const name = path.node.id.name;
  for (
    let child: NodePath<t.Node> = path,
      owner: NodePath<t.Node> | null = path.parentPath;
    owner;
    child = owner, owner = owner.parentPath
  ) {
    // A class's heritage/decorator expressions run outside its private body
    // environment. They may instead refer to an enclosing class's name.
    if (!owner.isClass() || child.node !== owner.node.body) continue;
    if (
      owner.node.body.body.some(
        (member) =>
          "key" in member &&
          t.isPrivateName(member.key) &&
          member.key.id.name === name
      )
    )
      return Boolean(owner.findParent((parent) => parent.node === callback));
  }
  return false;
}

/** Fresh own-property allocations only, not the entire reachable object graph.
 * Object/Array/Function prototypes remain shared and require separate authority.
 * This does not certify an invocation's effects, return value, or order.
 */
export function isClosedFreshAllocationFactory(
  path: NodePath<t.Node | null | undefined>
): boolean {
  if (
    !path.isFunctionDeclaration() &&
    !path.isFunctionExpression() &&
    !path.isArrowFunctionExpression()
  )
    return false;
  if (
    path.node.async ||
    (!path.isArrowFunctionExpression() && path.node.generator)
  )
    return false;
  // Defaults and destructuring execute during invocation, outside this narrow
  // allocation description. Caller arguments still retain their own effects.
  if (!path.node.params.every((parameter) => t.isIdentifier(parameter)))
    return false;
  const fn: NodePath<
    t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression
  > = path;
  const body = fn.get("body");
  const statements = body.isBlockStatement() ? body.get("body") : [];
  const result = body.isExpression()
    ? body
    : statements.length === 1 && statements[0].isReturnStatement()
      ? statements[0].get("argument")
      : undefined;
  if (
    !result?.isExpression() ||
    (!result.isObjectExpression() &&
      !result.isArrayExpression() &&
      !result.isFunction())
  )
    return false;
  let budget = 256;
  const allocation = (value: NodePath<t.Node>): boolean => {
    if (--budget < 0) return false;
    if (
      value.isStringLiteral() ||
      value.isBooleanLiteral() ||
      value.isNullLiteral() ||
      (value.isNumericLiteral() && Number.isFinite(value.node.value))
    )
      return true;
    if (value.isObjectExpression())
      return value.get("properties").every((property) => {
        if (
          !property.isObjectProperty() ||
          property.node.computed ||
          property.node.shorthand
        )
          return false;
        const key = property.node.key;
        if (
          (!t.isIdentifier(key) &&
            !t.isStringLiteral(key) &&
            !t.isNumericLiteral(key)) ||
          (t.isIdentifier(key) ? key.name : String(key.value)) === "__proto__"
        )
          return false;
        return allocation(property.get("value") as NodePath<t.Node>);
      });
    if (value.isArrayExpression())
      return value
        .get("elements")
        .every((element) => element.isExpression() && allocation(element));
    if (!value.isFunctionExpression() && !value.isArrowFunctionExpression())
      return false;
    if (
      value.node.async ||
      (!value.isArrowFunctionExpression() && value.node.generator)
    )
      return false;
    let closed = true;
    const functionScope = value.scope;
    value.traverse({
      enter(node) {
        if (
          --budget < 0 ||
          (node.isPrivateName() && !ownsPrivateName(node, value.node)) ||
          // JSX retains implicit runtime dependencies even for intrinsic/local tags.
          node.isJSXElement() ||
          node.isJSXFragment() ||
          node.isThisExpression() ||
          node.isSuper() ||
          node.isMetaProperty() ||
          node.isWithStatement() ||
          node.isAwaitExpression() ||
          node.isYieldExpression() ||
          node.isImport() ||
          node.node.type === "ImportExpression"
        ) {
          closed = false;
          node.stop();
        }
      },
      Identifier(reference) {
        if (!reference.isReferencedIdentifier() && !isWriteTarget(reference))
          return;
        // Even a lexically bound arguments/eval is outside this initial subset.
        if (["arguments", "eval"].includes(reference.node.name)) {
          closed = false;
          reference.stop();
          return;
        }
        const binding = reference.scope.getBinding(reference.node.name);
        let scope = binding?.scope;
        while (scope && scope !== functionScope) scope = scope.parent;
        if (!scope) {
          closed = false;
          reference.stop();
        }
      }
    });
    return closed;
  };
  return allocation(result);
}

/** The shape deliberately excludes every inherited property and prototype. */
export type ClosedOwnAllocationShape =
  | { readonly kind: "primitive" }
  | {
      readonly kind: "object";
      readonly properties: Readonly<
        Partial<Record<string, ClosedOwnAllocationShape>>
      >;
    }
  | {
      readonly kind: "array";
      readonly elements: readonly (ClosedOwnAllocationShape | undefined)[];
    }
  | { readonly kind: "function" };

export function describeClosedOwnAllocationFactory(
  path: NodePath<t.Node | null | undefined>
): ClosedOwnAllocationShape | undefined {
  if (
    !isClosedFreshAllocationFactory(path) ||
    (!path.isFunctionDeclaration() &&
      !path.isFunctionExpression() &&
      !path.isArrowFunctionExpression())
  )
    return;
  const fn: NodePath<
    t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression
  > = path;
  const body = fn.get("body");
  const statement = body.isBlockStatement() ? body.get("body")[0] : undefined;
  const result = body.isExpression()
    ? body
    : statement?.isReturnStatement()
      ? statement.get("argument")
      : undefined;
  if (!result?.isExpression()) return;
  const shape = (node: t.Node): ClosedOwnAllocationShape => {
    if (t.isObjectExpression(node))
      return {
        kind: "object",
        properties: Object.assign(
          Object.create(null) as Record<string, ClosedOwnAllocationShape>,
          Object.fromEntries(
            node.properties.map((property) => {
              // The validator above rejects methods, spreads, computed keys and __proto__.
              if (!t.isObjectProperty(property))
                throw new Error("Invalid validated own property");
              const key = property.key;
              const name = t.isIdentifier(key)
                ? key.name
                : t.isStringLiteral(key) || t.isNumericLiteral(key)
                  ? String(key.value)
                  : "";
              return [name, shape(property.value)];
            })
          )
        )
      };
    if (t.isArrayExpression(node))
      return {
        kind: "array",
        elements: node.elements.map((element) => {
          if (!element) throw new Error("Invalid validated array hole");
          return shape(element);
        })
      };
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node))
      return { kind: "function" };
    return { kind: "primitive" };
  };
  return shape(result.node);
}

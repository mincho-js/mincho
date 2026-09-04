import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { extractionAPIs } from "../../utils.js";
import { STATIC_CSS_EVAL_LIMITS } from "../types.js";

type ObjectPath = NodePath<
  t.ObjectExpression | t.ArrayExpression | t.RestElement
>;

interface ObjectReference {
  path: ObjectPath;
  call?: t.Node;
  owner?: NodePath<t.Function>;
  rest?: {
    sources: ObjectReference[];
    excluded: Set<string>;
    offset?: number;
  };
}

function child(path: NodePath<t.Node>, key: string): NodePath<t.Node> {
  return path.get(key) as NodePath<t.Node>;
}

/** Tracks allocation identity without executing initializers, getters or calls. */
class ObjectReferences {
  private allocations = new WeakMap<t.Node, WeakMap<t.Node, object>>();
  private visits = 0;

  // Count repeated work too: acyclic helper graphs can expand exponentially.
  private visit(): void {
    const limit = STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount;
    if (++this.visits > limit) {
      throw new Error(
        `Cannot statically evaluate css prop value: mutation analysis node visit limit exceeded (${this.visits} visits > ${limit} visits)`
      );
    }
  }

  identity(reference: ObjectReference): object {
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
      ? { ...reference, call, owner }
      : reference;
  }

  resolve(
    path: NodePath<t.Node | null | undefined>,
    seen = new Set<t.Node>()
  ): ObjectReference[] {
    if (!path.node) return [];

    this.visit();

    if (seen.has(path.node)) return [];

    const next = new Set(seen).add(path.node);
    if (path.isObjectExpression() || path.isArrayExpression())
      return [{ path }];

    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);

      return binding ? this.binding(binding, next) : [];
    }

    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      return this.select(
        this.resolve(child(path, "object"), next),
        memberName(path.node),
        next
      );
    }
    if (path.isConditionalExpression()) {
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
      const callee = child(path, "callee");
      if (!callee.isIdentifier()) return [];

      const binding = callee.scope.getBinding(callee.node.name);
      const owner = binding?.path;
      const fn = owner?.isVariableDeclarator() ? owner.get("init") : owner;
      if (!fn || !fn.isFunction() || next.has(fn.node)) return [];

      const nested = new Set(next).add(fn.node);
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

      return returned.map((reference) => this.atCall(reference, path.node, fn));
    }

    return [];
  }

  binding(binding: Binding, seen = new Set<t.Node>()): ObjectReference[] {
    this.visit();

    const declaration = binding.path;
    const values: ObjectReference[] = [];

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

  private pattern(
    pattern: NodePath<t.Node>,
    name: string,
    values: ObjectReference[],
    seen: Set<t.Node>
  ): ObjectReference[] {
    this.visit();

    if (pattern.isIdentifier()) return pattern.node.name === name ? values : [];
    if (pattern.isAssignmentPattern()) {
      return this.pattern(
        pattern.get("left"),
        name,
        [...values, ...this.resolve(pattern.get("right"), seen)],
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
    seen = new Set<t.Node>()
  ): ObjectReference[] {
    return this.selectProperties(
      objects,
      (key) => name === null || key === null || key === name,
      seen
    );
  }

  private selectProperties(
    objects: ObjectReference[],
    accepts: (key: string | null) => boolean,
    seen: Set<t.Node>
  ): ObjectReference[] {
    return objects.flatMap((reference) => {
      this.visit();

      const object = reference.path;
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
            next
          )
        );
      }

      if (object.isObjectExpression()) {
        return inherit(
          object.get("properties").flatMap((property) => {
            this.visit();

            if (property.isSpreadElement())
              return this.selectProperties(
                this.resolve(property.get("argument"), next),
                accepts,
                next
              );

            return property.isObjectProperty() &&
              accepts(propertyName(property.node))
              ? this.resolve(property.get("value"), next)
              : [];
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
    });
  }

  reachable(objects: ObjectReference[]): Set<object> {
    const nodes = new Set<object>();
    const queue = [...objects];

    for (let index = 0; index < queue.length; index++) {
      this.visit();

      const object = queue[index];
      const identity = this.identity(object);
      if (nodes.has(identity)) continue;

      nodes.add(identity);
      queue.push(...this.select([object], null));
    }

    return nodes;
  }
}

function propertyName(property: t.ObjectProperty): string | null {
  if (!property.computed && t.isIdentifier(property.key))
    return property.key.name;

  return t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
    ? String(property.key.value)
    : null;
}

function memberName(
  member: t.MemberExpression | t.OptionalMemberExpression
): string | null {
  if (!member.computed && t.isIdentifier(member.property))
    return member.property.name;

  return t.isStringLiteral(member.property) ||
    t.isNumericLiteral(member.property)
    ? String(member.property.value)
    : null;
}

function isKnownReadOnlyCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>
): boolean {
  if (path.isNewExpression()) return false;

  const callee = child(path, "callee");
  if (
    [...extractionAPIs, "cx"].some((name) =>
      callee.referencesImport("@mincho-js/css", name)
    )
  )
    return true;
  if (callee.referencesImport("@mincho-js/react", "styled")) return true;
  if (!callee.isMemberExpression()) return false;

  const object = child(callee, "object");

  // Object.keys returns only primitive strings, so no mutable reference escapes.
  return (
    object.isIdentifier({ name: "Object" }) &&
    !object.scope.getBinding("Object") &&
    memberName(callee.node) === "keys"
  );
}

export function hasAliasedStaticCssEvalBindingMutation(
  program: NodePath<t.Program>,
  binding: Binding
): boolean {
  const references = new ObjectReferences();
  const targets = references.reachable(references.binding(binding));
  if (targets.size === 0) return false;

  const touches = (path: NodePath<t.Node | null | undefined>, deep = false) => {
    const objects = references.resolve(path);
    const nodes = deep
      ? references.reachable(objects)
      : new Set(objects.map((object) => references.identity(object)));

    return [...nodes].some((node) => targets.has(node));
  };

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
    if (isKnownReadOnlyCall(path)) return;

    const callee = child(path, "callee");
    const receiver =
      (callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
      touches(child(callee, "object"), true);

    if (
      receiver ||
      path
        .get("arguments")
        .some((argument) =>
          touches(
            argument.isSpreadElement() ? argument.get("argument") : argument,
            true
          )
        )
    )
      mark(path);
  };

  program.traverse({
    AssignmentExpression(path) {
      if (
        writes(path.get("left")) ||
        (path.get("left").isMemberExpression() &&
          touches(path.get("right"), true))
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

    ForInStatement(path) {
      if (writes(path.get("left"))) mark(path);
    },

    ForOfStatement(path) {
      if (writes(path.get("left"))) mark(path);
    }
  });

  return mutated;
}

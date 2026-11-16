import { referencesModuleExports } from "../../commonjs/bindings.js";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { isBuiltInExtractionCall } from "../../extractionCalls/builtins.js";
import { STATIC_CSS_EVAL_LIMITS } from "../types.js";
import { isStaticCssEvalLiteralRequireCallExpression } from "../cjsBindings.js";
import { getCjsAssignmentTarget } from "../cjsExportTargets.js";
import {
  isObjectPrototypeSetter,
  selectObjectLiteralMember,
  staticObjectMemberName as propertyName,
  staticPropertyName
} from "../propertySelection.js";

type ObjectPath = NodePath<
  | t.ObjectExpression
  | t.Function
  | t.Class
  | t.NewExpression
  | t.ArrayExpression
  | t.RestElement
  | t.ImportSpecifier
  | t.ImportDefaultSpecifier
  | t.ImportNamespaceSpecifier
  | t.CallExpression
  | t.OptionalCallExpression
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

export class StaticCssMutationAnalysisLimit extends Error {}

/** Tracks allocation identity without executing initializers, getters or calls. */
class ObjectReferences {
  private allocations = new WeakMap<t.Node, WeakMap<t.Node, object>>();
  private visits = 0;
  private deletedProperties = new Map<object, Set<string | null>>();
  private possibleDeletedNames?: Set<string | null>;

  constructor(
    private opaqueCalls: ReadonlySet<t.CallExpression>,
    private selectedBranches?: ReadonlyMap<t.Node, NodePath<t.Expression>>,
    program?: NodePath
  ) {
    if (!program) return;

    const deletions: NodePath<
      t.MemberExpression | t.OptionalMemberExpression
    >[] = [];
    program.traverse({
      UnaryExpression(path) {
        const argument = path.get("argument");
        if (
          path.node.operator === "delete" &&
          (argument.isMemberExpression() ||
            argument.isOptionalMemberExpression())
        )
          deletions.push(argument);
      }
    });
    // Resolve deletion receivers with every possibly deleted slot open first.
    // Narrowing to allocation identities afterwards preserves unrelated shadows.
    this.possibleDeletedNames = new Set(
      deletions.map((path) => memberName(path.node))
    );
    for (const deletion of deletions) {
      const name = memberName(deletion.node);
      for (const reference of this.resolve(deletion.get("object"))) {
        const identity = this.identity(reference);
        const names = this.deletedProperties.get(identity) ?? new Set();
        names.add(name);
        this.deletedProperties.set(identity, names);
      }
    }
    this.possibleDeletedNames = undefined;
  }

  private mayDelete(reference: ObjectReference, name: string): boolean {
    const names =
      this.possibleDeletedNames ??
      this.deletedProperties.get(this.identity(reference));
    return names?.has(null) === true || names?.has(name) === true;
  }

  // Count repeated work too: acyclic helper graphs can expand exponentially.
  private visit(): void {
    const limit = STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount;
    if (++this.visits > limit) {
      throw new StaticCssMutationAnalysisLimit(
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
    const selected = this.selectedBranches?.get(path.node);

    if (selected) return this.resolve(selected, next);
    if (
      path.isObjectExpression() ||
      path.isArrayExpression() ||
      path.isFunction() ||
      path.isClass() ||
      path.isNewExpression()
    )
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
      if (
        path.isCallExpression() &&
        (this.opaqueCalls.has(path.node) ||
          isStaticCssEvalLiteralRequireCallExpression(path.node, path.scope))
      )
        return [{ path }];
      const callee = child(path, "callee");
      const binding = callee.isIdentifier()
        ? callee.scope.getBinding(callee.node.name)
        : undefined;
      const owner = binding?.path;
      const fn = callee.isFunction()
        ? callee
        : owner?.isVariableDeclarator()
          ? owner.get("init")
          : owner;
      // An uninspected result can still be an object. Preserve its identity
      // instead of treating a missing return proof as a primitive value.
      if (!fn || !fn.isFunction() || next.has(fn.node)) return [{ path }];

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

    if (
      declaration.isImportSpecifier() ||
      declaration.isImportDefaultSpecifier() ||
      declaration.isImportNamespaceSpecifier()
    )
      return [{ path: declaration }];

    if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration())
      values.push({ path: declaration });

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

  storedValues(
    pattern: NodePath<t.Node>,
    value: NodePath<t.Expression>
  ): ObjectReference[] {
    return this.pattern(pattern, undefined, this.resolve(value), new Set());
  }

  private pattern(
    pattern: NodePath<t.Node>,
    name: string | undefined,
    values: ObjectReference[],
    seen: Set<t.Node>
  ): ObjectReference[] {
    this.visit();

    if (pattern.isIdentifier()) return pattern.node.name === name ? values : [];
    if (pattern.isMemberExpression()) return name === undefined ? values : [];
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
    seen = new Set<t.Node>(),
    ownOnly = false
  ): ObjectReference[] {
    return this.selectProperties(
      objects,
      (key) => name === null || key === null || key === name,
      seen,
      ownOnly,
      name
    );
  }

  private selectProperties(
    objects: ObjectReference[],
    accepts: (key: string | null) => boolean,
    seen: Set<t.Node>,
    ownOnly = false,
    name?: string | null
  ): ObjectReference[] {
    return objects.flatMap((reference) => {
      this.visit();

      const object = reference.path;
      // Opaque contents, including callable prototypes, need not come from
      // object literals. Keep their identity when following nested aliases.
      if (
        object.isImportSpecifier() ||
        object.isImportDefaultSpecifier() ||
        object.isImportNamespaceSpecifier() ||
        object.isCallExpression() ||
        object.isOptionalCallExpression() ||
        object.isFunction() ||
        object.isClass() ||
        object.isNewExpression()
      )
        return [reference];
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
            next,
            true
          )
        );
      }

      if (object.isObjectExpression()) {
        if (name !== undefined && name !== null) {
          const selected = selectObjectLiteralMember(
            object.node,
            name,
            ownOnly
          );
          if (selected.kind === "missing") return [];
          if (selected.kind === "prototype") {
            const prototype = this.resolve(child(object, selected.path), next);
            // The inherited __proto__ accessor can expose this allocation;
            // this is a possible alias, not proof of an own data property.
            return inherit([
              ...(name === "__proto__" ? prototype : []),
              ...this.select(prototype, name, next)
            ]);
          }
          if (
            selected.kind === "property" &&
            !this.mayDelete(reference, name)
          ) {
            const property = child(object, selected.path);
            return inherit(
              property.isObjectProperty()
                ? this.resolve(property.get("value"), next)
                : property.isObjectMethod({ kind: "method" })
                  ? [{ path: property }]
                  : []
            );
          }
        }
        return inherit(
          object.get("properties").flatMap((property) => {
            this.visit();

            if (property.isSpreadElement())
              return this.selectProperties(
                this.resolve(property.get("argument"), next),
                accepts,
                next,
                true,
                name
              );

            if (
              property.isObjectProperty() &&
              isObjectPrototypeSetter(property.node)
            ) {
              if (ownOnly) return [];
              const prototype = this.resolve(property.get("value"), next);
              return [
                ...(name === null || name === "__proto__" ? prototype : []),
                ...this.selectProperties(prototype, accepts, next, false, name)
              ];
            }

            if (
              property.isObjectProperty() &&
              accepts(propertyName(property.node))
            )
              return this.resolve(property.get("value"), next);
            if (
              property.isObjectMethod({ kind: "method" }) &&
              accepts(propertyName(property.node))
            )
              return [{ path: property }];

            return [];
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

  readsImportedMember(
    objects: ObjectReference[],
    name: string | null,
    seen = new Set<t.Node>()
  ): boolean {
    return objects.some((reference) => {
      this.visit();
      if (isImportedReference(reference)) return true;
      const object = reference.path;
      if (!object.isObjectExpression() || seen.has(object.node)) return false;
      const next = new Set(seen).add(object.node);
      if (name !== null) {
        const selected = selectObjectLiteralMember(object.node, name);
        if (
          selected.kind === "missing" ||
          (selected.kind === "property" && !this.mayDelete(reference, name))
        )
          return false;
        if (selected.kind === "prototype")
          return this.readsImportedMember(
            this.resolve(child(object, selected.path), next),
            name,
            next
          );
      }
      // An unknown own selection can still fall through to the explicit
      // prototype. Spread/rest copies themselves contain own data properties.
      return object
        .get("properties")
        .some(
          (property) =>
            property.isObjectProperty() &&
            isObjectPrototypeSetter(property.node) &&
            this.readsImportedMember(
              this.resolve(property.get("value"), next),
              name,
              next
            )
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

/** Follow the selected value's origin, without conflating container contents. */
export function hasImportedValueOrigin(
  path: NodePath<t.Node>,
  memberPath: readonly (string | null)[] = []
): boolean {
  try {
    const objects = new ObjectReferences(
      new Set(),
      undefined,
      path.scope.getProgramParent().path
    );
    let values = objects.resolve(path);
    for (const member of memberPath) values = objects.select(values, member);

    return values.some(isImportedReference);
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit) return true;
    throw error;
  }
}

function isImportedReference({ path }: ObjectReference): boolean {
  return (
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier() ||
    (path.isCallExpression() &&
      isStaticCssEvalLiteralRequireCallExpression(path.node, path.scope))
  );
}

/** Whether a property read can reach a live imported receiver, including a prototype. */
export function hasImportedMemberReadOrigin(
  path: NodePath<t.Node>,
  member: string | null,
  memberPath: readonly (string | null)[] = []
): boolean {
  try {
    const objects = new ObjectReferences(
      new Set(),
      undefined,
      path.scope.getProgramParent().path
    );
    let values = objects.resolve(path);
    for (const key of memberPath) values = objects.select(values, key);
    return objects.readsImportedMember(values, member);
  } catch (error) {
    if (error instanceof StaticCssMutationAnalysisLimit) return true;
    throw error;
  }
}

function memberName(
  member: t.MemberExpression | t.OptionalMemberExpression
): string | null {
  return staticPropertyName(member.property, member.computed);
}

const readOnlyRuntimeCalls = {
  "@mincho-js/css": ["cx"],
  "@mincho-js/css/classname": ["cx"],
  "@mincho-js/react": ["styled"]
};

function isKnownReadOnlyCall(
  path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>
): boolean {
  if (path.isNewExpression()) return false;

  const callee = child(path, "callee");
  if (
    isBuiltInExtractionCall(callee) ||
    referencesModuleExports(callee, readOnlyRuntimeCalls)
  )
    return true;
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
  binding: Binding,
  options: {
    opaqueCalls?: ReadonlySet<t.CallExpression>;
    selectedBranches?: ReadonlyMap<t.Node, NodePath<t.Expression>>;
    isReadOnlyCall?: (
      path: NodePath<
        t.CallExpression | t.OptionalCallExpression | t.NewExpression
      >
    ) => boolean;
  } = {}
): boolean {
  const references = new ObjectReferences(
    options.opaqueCalls ?? new Set(),
    options.selectedBranches,
    program
  );
  const targets = references.reachable(references.binding(binding));

  if (targets.size === 0) return false;

  const touchesObjects = (objects: ObjectReference[], deep = false) => {
    const nodes = deep
      ? references.reachable(objects)
      : new Set(objects.map((object) => references.identity(object)));

    return [...nodes].some((node) => targets.has(node));
  };

  const touches = (path: NodePath<t.Node | null | undefined>, deep = false) =>
    touchesObjects(references.resolve(path), deep);

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

    const argumentEscapes = path
      .get("arguments")
      .some((argument) =>
        touches(
          argument.isSpreadElement() ? argument.get("argument") : argument,
          true
        )
      );
    if ((receiver || argumentEscapes) && !options.isReadOnlyCall?.(path))
      mark(path);
  };

  program.traverse({
    AssignmentExpression(path) {
      const target = getCjsAssignmentTarget(path.node.left, path.scope);
      const reexport =
        path.node.operator === "=" &&
        (target.kind === "property" || target.kind === "module-replacement");
      if (
        writes(path.get("left")) ||
        (!reexport &&
          touchesObjects(
            references.storedValues(path.get("left"), path.get("right")),
            true
          ))
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

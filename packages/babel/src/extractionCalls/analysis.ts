import { everyPatternExpression } from "../jsxCssProp/patternExpressions.js";
import type { SourceInvocationResult } from "./types.js";
import type { ClosedOwnAllocationShape } from "./closedAllocation.js";
import type { AuthoringCallContract } from "./authoringContract.js";
import { types as t, type NodePath } from "@babel/core";
import {
  createModuleGraph,
  isExternalModule as isExternal,
  parseModuleProgram as parseProgram,
  exportedName,
  type SourceModule as Module,
  type ModuleTarget as Target
} from "../moduleGraph.js";
import {
  getModuleReference,
  isWriteTarget,
  staticMemberName
} from "../commonjs/bindings.js";
import { commonJsExports } from "../commonjs/modules.js";
import { isObjectPrototypeSetter } from "../staticCssEval/propertySelection.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";
import {
  getCjsAssignmentTarget,
  getCjsExportSurfaceExpression
} from "../staticCssEval/cjsExportTargets.js";
import {
  getDestructuredBindingSource,
  resolveStaticMemberPath
} from "../staticCssEval/partialEvaluator/destructuring.js";
import type { Binding } from "@babel/traverse";
import { isAbsolute, relative, resolve } from "node:path";
import { isLocalExtractCallsSource, normalizeExtractCalls } from "./config.js";
import { canonicalExtractCallsFile } from "./filesystem.js";
import {
  ExtractCallsError,
  type ExtractCallsAnalysis,
  type ExtractCallsAnalysisOptions,
  type ExtractCallsRequest
} from "./types.js";

type Flow<T> = Generator<
  ExtractCallsRequest,
  T,
  import("../moduleGraph.js").ModuleGraphResponse
>;

function referencedMemberName(
  reference: NodePath<t.Identifier>
): string | null {
  const member = reference.parentPath;
  if (!member.isMemberExpression() || member.node.object !== reference.node)
    return null;
  if (!member.node.computed && t.isIdentifier(member.node.property))
    return member.node.property.name;

  return t.isStringLiteral(member.node.property)
    ? member.node.property.value
    : null;
}

type Receiver = { module: Module; path: NodePath<t.ObjectExpression> };
type RegisteredTarget = { target: Target; receiver?: Receiver };
type LocalRootVisit = { active: boolean; selections: Set<string> };
type LocalRootState = {
  nodes: Map<t.Node, LocalRootVisit>;
  commonJs?: ReadonlyMap<string | null, NodePath<t.Node>>;
};
type LocalSelection =
  | string
  | null
  | { rest: readonly string[] }
  | { arrayRest: number }
  | { call: true };
type LocalBindingSource = {
  path: NodePath<t.Node>;
  selection: readonly LocalSelection[];
};

function localBindingSources(binding: Binding): LocalBindingSource[] {
  const declaration = binding.path;
  if (!declaration.isVariableDeclarator()) return [];

  const init = declaration.get("init");
  if (!init.isExpression()) {
    const statement = declaration.parentPath;
    const loop = statement?.parentPath;
    return statement?.isVariableDeclaration() &&
      loop?.isForOfStatement() &&
      loop.node.left === statement.node
      ? localPatternSources(
          declaration.get("id"),
          loop.get("right"),
          binding.identifier.name,
          [null]
        )
      : [];
  }

  const source = getDestructuredBindingSource(binding, binding.identifier.name);
  if (source) return [{ path: init, selection: source.memberPath }];

  return localPatternSources(
    declaration.get("id"),
    init,
    binding.identifier.name
  );
}

function hasDefinedLiteralSelection(
  init: NodePath<t.Expression>,
  selection: readonly LocalSelection[]
): boolean {
  let value: t.Expression | null = init.node;

  for (const member of selection) {
    if (typeof member !== "string" || !value) return false;
    if (
      t.isArrayExpression(value) &&
      value.elements
        .slice(0, Number(member) + 1)
        .some((element) => t.isSpreadElement(element))
    )
      return false;

    value = resolveStaticMemberPath(value, [member]);
  }

  return (
    t.isLiteral(value) ||
    t.isObjectExpression(value) ||
    t.isArrayExpression(value) ||
    t.isFunctionExpression(value) ||
    t.isArrowFunctionExpression(value)
  );
}

function localPatternSources(
  pattern: NodePath<t.Node>,
  init: NodePath<t.Expression>,
  target: string | NodePath<t.MemberExpression>,
  initialSelection: readonly LocalSelection[] = []
): LocalBindingSource[] {
  let current: NodePath<t.Node> | undefined =
    typeof target === "string"
      ? pattern.getBindingIdentifierPaths()[target]
      : target;
  if (!current) return [];

  const selection: LocalSelection[] = [];
  const sources: LocalBindingSource[] = [];
  const canSelectArrayIndices = everyPatternExpression(
    pattern,
    () => true,
    init.node,
    undefined,
    {
      nativeArrayIteration: true,
      requireReplaySafety: true
    }
  );

  while (current && current.node !== pattern.node) {
    const parent: NodePath<t.Node> | null = current.parentPath;
    if (parent?.isAssignmentPattern()) {
      sources.push({ path: parent.get("right"), selection: [...selection] });
      current = parent;
    } else if (parent?.isObjectProperty()) {
      selection.unshift(staticMemberName(parent.node));
      current = parent.parentPath;
    } else if (parent?.isArrayPattern()) {
      selection.unshift(canSelectArrayIndices ? String(current.key) : null);
      current = parent;
    } else if (parent?.isRestElement()) {
      const container = parent.parentPath;
      selection.unshift(
        container?.isObjectPattern()
          ? {
              rest: container.node.properties.flatMap((property) => {
                if (!t.isObjectProperty(property)) return [];
                const name = staticMemberName(property);
                return name === null ? [] : [name];
              })
            }
          : container?.isArrayPattern()
            ? { arrayRest: Number(parent.key) }
            : null
      );
      current = parent.parentPath ?? undefined;
    } else return [...sources, { path: init, selection: initialSelection }];
  }

  // Defaults stay possible unless an inline literal proves that the selected
  // value is defined. Referenced objects may have been mutated in the module.
  return [
    ...sources.filter(
      (source) =>
        !hasDefinedLiteralSelection(init, [
          ...initialSelection,
          ...selection.slice(0, selection.length - source.selection.length)
        ])
    ),
    { path: init, selection: [...initialSelection, ...selection] }
  ];
}

/** Only assignment targets store values; computed keys and defaults are reads. */
function memberStores(
  pattern: NodePath<t.Node | null>
): NodePath<t.MemberExpression>[] {
  if (!pattern.node) return [];
  const target = unwrapExpressionPath(pattern as NodePath<t.Node>);
  if (target.isMemberExpression()) return [target];
  if (target.isAssignmentPattern()) return memberStores(target.get("left"));
  if (target.isRestElement()) return memberStores(target.get("argument"));
  if (target.isArrayPattern())
    return target.get("elements").flatMap(memberStores);
  if (target.isObjectPattern())
    return target
      .get("properties")
      .flatMap((property) =>
        memberStores(
          property.isRestElement()
            ? property.get("argument")
            : property.get("value")
        )
      );
  return [];
}

function functionExposedValues(path: NodePath<t.Function>) {
  const values: NodePath<t.Expression>[] = [];
  const body = path.get("body");
  if (body.isExpression()) return [body];

  path.traverse({
    Function(nested) {
      nested.skip();
    },
    ReturnStatement(result) {
      const value = result.get("argument");
      if (value.isExpression()) values.push(value);
    },
    YieldExpression(result) {
      const value = result.get("argument");
      if (value.isExpression()) values.push(value);
    },
    ThrowStatement(result) {
      values.push(result.get("argument"));
    }
  });
  return values;
}

function localObjectRoots(
  path: NodePath<t.Node>,
  roots: Set<t.ObjectExpression>,
  memberOwner = true,
  seen: LocalRootState = { nodes: new Map() },
  selection: readonly LocalSelection[] = [],
  copiedPropertyExclusions?: ReadonlySet<string>
): ReadonlyMap<string, "data" | "accessor"> | undefined {
  const visited = seen.nodes.get(path.node) ?? {
    active: false,
    selections: new Set<string>()
  };
  const key = JSON.stringify([
    selection,
    copiedPropertyExclusions ? [...copiedPropertyExclusions].sort() : null
  ]);
  if (visited.active || visited.selections.has(key)) return;
  visited.active = true;
  visited.selections.add(key);
  seen.nodes.set(path.node, visited);

  try {
    if (
      path.isExpression() &&
      getCjsExportSurfaceExpression(path.node, path.scope)
    ) {
      const source = seen.commonJs?.get(null);
      if (source)
        return localObjectRoots(
          source,
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );

      const name = selection[0];
      const selected =
        typeof name === "string" ? seen.commonJs?.get(name) : undefined;
      if (selected)
        return localObjectRoots(
          selected,
          roots,
          memberOwner,
          seen,
          selection.slice(1),
          copiedPropertyExclusions
        );

      // A namespace is a container; a write to it does not mutate its values.
      if (!memberOwner && selection.length === 0)
        for (const value of seen.commonJs?.values() ?? [])
          localObjectRoots(value, roots, false, seen);
      return;
    }

    if (path.isObjectExpression() || path.isArrayExpression()) {
      const rest = selection[0];
      if (rest && typeof rest === "object" && "rest" in rest) {
        selection = selection.slice(1);

        // Rest has a fresh identity, but its retained property values are shared.
        if (memberOwner && selection.length === 0) return;
        if (
          typeof selection[0] === "string" &&
          rest.rest.includes(selection[0])
        )
          return;

        if (selection.length === 0 || selection[0] === null) {
          selection = [];
          memberOwner = false;
          copiedPropertyExclusions = new Set([
            ...(copiedPropertyExclusions ?? []),
            ...rest.rest
          ]);
        }
      }
    }

    if (path.isArrayExpression()) {
      let offset = 0;
      let hasArrayRest = false;
      let rest = selection[0];
      while (rest && typeof rest === "object" && "arrayRest" in rest) {
        hasArrayRest = true;
        offset += rest.arrayRest;
        selection = selection.slice(1);
        rest = selection[0];
      }

      if (hasArrayRest) {
        // Array rest copies the container, while its elements retain identity.
        if (memberOwner && selection.length === 0) return;

        if (typeof selection[0] === "string" && /^\d+$/.test(selection[0])) {
          selection = [
            String(Number(selection[0]) + offset),
            ...selection.slice(1)
          ];
        } else if (selection.length === 0 || selection[0] === null) {
          selection = [];
          memberOwner = false;
          copiedPropertyExclusions = new Set([
            ...Array.from({ length: offset }, (_, index) => String(index)),
            ...[...(copiedPropertyExclusions ?? [])].map((name) =>
              /^\d+$/.test(name) ? String(Number(name) + offset) : name
            )
          ]);
        }
      }
    }

    if (path.isObjectExpression()) {
      // A write through a selected shared value may also affect its owner.
      const selectsCall = selection.some(
        (step) => step && typeof step === "object" && "call" in step
      );
      if (memberOwner && selection.length > 0 && !selectsCall)
        roots.add(path.node);

      if (selection.length === 0) {
        if (!copiedPropertyExclusions) roots.add(path.node);

        if (!memberOwner) {
          const names = new Set(copiedPropertyExclusions);
          const copiedKeys = new Map<string, "data" | "accessor">();
          const setters = new Set<string>();

          for (const property of path.get("properties").toReversed()) {
            if (
              copiedPropertyExclusions &&
              isObjectPrototypeSetter(property.node)
            )
              continue;
            if (property.isSpreadElement()) {
              // A spread copies property values, not the source identity.
              const spreadKeys = localObjectRoots(
                property.get("argument"),
                roots,
                memberOwner,
                seen,
                [],
                names
              );

              for (const [name, kind] of spreadKeys ?? []) {
                if (names.has(name)) continue;
                if (!copiedKeys.has(name)) copiedKeys.set(name, kind);
                if (copiedKeys.get(name) === "data") names.add(name);
              }

              continue;
            }

            const node = property.node;
            if (!t.isObjectProperty(node) && !t.isObjectMethod(node)) continue;

            const name = t.isObjectProperty(node)
              ? staticMemberName(node)
              : !node.computed && t.isIdentifier(node.key)
                ? node.key.name
                : t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
                  ? String(node.key.value)
                  : null;

            if (name !== null) {
              if (names.has(name)) continue;
              if (property.isObjectMethod({ kind: "set" })) {
                setters.add(name);
                copiedKeys.set(name, "accessor");
                continue;
              }
              names.add(name);

              // A setter preserves an earlier getter, but an intervening data
              // declaration resets the descriptor and leaves a setter-only slot.
              if (
                setters.has(name) &&
                !property.isObjectMethod({ kind: "get" })
              )
                continue;

              // An accessor key alone does not prove a safe overwrite.
              if (!copiedKeys.has(name))
                copiedKeys.set(
                  name,
                  t.isObjectProperty(node) || node.kind === "method"
                    ? "data"
                    : "accessor"
                );
            }

            if (property.isObjectProperty()) {
              const value = property.get("value");

              if (value.isExpression())
                localObjectRoots(value, roots, memberOwner, seen);
            } else if (property.isObjectMethod({ kind: "get" })) {
              for (const value of functionExposedValues(property))
                localObjectRoots(value, roots, memberOwner, seen);
            } else if (property.isObjectMethod({ kind: "method" })) {
              localObjectRoots(property, roots, memberOwner, seen);
            }
          }

          return copiedKeys;
        }
      } else if (selection[0] === null) {
        roots.add(path.node);
        // Unknown selection retains every reachable property value. A direct
        // slot replacement has no selection and keeps only the container above.
        for (const property of path.get("properties")) {
          if (property.isSpreadElement())
            localObjectRoots(
              property.get("argument"),
              roots,
              false,
              seen,
              selection
            );
          else if (property.isObjectProperty()) {
            const value = property.get("value");
            if (value.isExpression())
              localObjectRoots(value, roots, false, seen, selection.slice(1));
          } else if (property.isObjectMethod({ kind: "get" }))
            for (const value of functionExposedValues(property))
              localObjectRoots(value, roots, false, seen, selection.slice(1));
          else if (property.isObjectMethod({ kind: "method" }))
            localObjectRoots(
              property,
              roots,
              memberOwner,
              seen,
              selection.slice(1)
            );
        }
      } else {
        let prototype: NodePath<t.Node> | undefined;
        let setter = false;
        for (const property of path.get("properties").toReversed()) {
          const node = property.node;
          if (property.isObjectProperty() && isObjectPrototypeSetter(node)) {
            if (!copiedPropertyExclusions) prototype = property.get("value");
            continue;
          }
          if (property.isSpreadElement()) {
            // A copied property retains its value's identity. Unknown spreads
            // may leave an earlier property in place, so keep tracing those too.
            const keys = localObjectRoots(
              property.get("argument"),
              roots,
              memberOwner,
              seen,
              selection,
              new Set(copiedPropertyExclusions)
            );
            if (
              typeof selection[0] === "string" &&
              keys?.get(selection[0]) === "data"
            )
              return keys;
            continue;
          }
          if (!t.isObjectProperty(node) && !t.isObjectMethod(node)) continue;

          const name = t.isObjectProperty(node)
            ? staticMemberName(node)
            : !node.computed && t.isIdentifier(node.key)
              ? node.key.name
              : t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
                ? String(node.key.value)
                : null;

          if (name !== null && name !== selection[0]) continue;

          if (property.isObjectMethod({ kind: "set" })) {
            roots.add(path.node);
            if (name !== null) setter = true;
            continue;
          }
          if (
            name !== null &&
            setter &&
            !property.isObjectMethod({ kind: "get" })
          )
            return new Map([[name, "accessor"]]);

          if (property.isObjectProperty()) {
            const value = property.get("value");
            if (value.isExpression())
              localObjectRoots(
                value,
                roots,
                memberOwner,
                seen,
                selection.slice(1)
              );
          } else if (property.isObjectMethod({ kind: "get" })) {
            if (!selectsCall) roots.add(path.node);
            for (const value of functionExposedValues(property))
              localObjectRoots(
                value,
                roots,
                memberOwner,
                seen,
                selection.slice(1)
              );
          } else if (property.isObjectMethod({ kind: "method" }))
            localObjectRoots(
              property,
              roots,
              memberOwner,
              seen,
              selection.slice(1)
            );
          else roots.add(path.node);

          if (name !== null)
            return new Map([
              [
                name,
                t.isObjectProperty(node) || node.kind === "method"
                  ? "data"
                  : "accessor"
              ]
            ]);
        }
        // Unknown spreads do not prove that an inherited value was overwritten.
        // A known own slot (including a setter-only descriptor) does shadow it.
        if (prototype && !setter && typeof selection[0] === "string")
          return localObjectRoots(
            prototype,
            roots,
            memberOwner,
            seen,
            selection
          );
      }
    }

    if (path.isArrayExpression() && !memberOwner && selection.length === 0) {
      const elements = staticArrayElements(path) ?? path.get("elements");
      let unknownOffset = false;
      for (const [index, element] of elements.entries()) {
        if (element.isSpreadElement()) unknownOffset = true;
        const value = element.isSpreadElement()
          ? element.get("argument")
          : element;
        if (
          (unknownOffset || !copiedPropertyExclusions?.has(String(index))) &&
          value.isExpression()
        )
          localObjectRoots(value, roots, memberOwner, seen);
      }
    }

    if (path.isArrayExpression() && selection.length > 0) {
      const index = selection[0];
      if (index === null) {
        for (const candidate of path.get("elements")) {
          const value = candidate.isSpreadElement()
            ? candidate.get("argument")
            : candidate;

          if (value.isExpression())
            localObjectRoots(
              value,
              roots,
              memberOwner,
              seen,
              candidate.isSpreadElement() ? selection : selection.slice(1)
            );
        }
      } else if (typeof index === "string" && /^\d+$/.test(index)) {
        const elements = staticArrayElements(path);
        const firstSpread = path.node.elements.findIndex((element) =>
          t.isSpreadElement(element)
        );
        const element = (elements ?? path.get("elements"))[Number(index)];
        if (!elements && firstSpread >= 0 && Number(index) >= firstSpread) {
          for (const candidate of path.get("elements")) {
            const value = candidate.isSpreadElement()
              ? candidate.get("argument")
              : candidate;
            if (value.isExpression())
              localObjectRoots(value, roots, false, seen);
          }
        } else if (element?.isExpression())
          localObjectRoots(
            element,
            roots,
            memberOwner,
            seen,
            selection.slice(1),
            copiedPropertyExclusions
          );
      }
    }

    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      if (isNullishOptionalChain(path)) return;
      const property = path.node.property;
      const member =
        !path.node.computed && t.isIdentifier(property)
          ? property.name
          : t.isStringLiteral(property) || t.isNumericLiteral(property)
            ? String(property.value)
            : null;
      const object = path.get("object");
      if (!Array.isArray(object))
        localObjectRoots(
          object,
          roots,
          memberOwner,
          seen,
          [member, ...selection],
          copiedPropertyExclusions
        );
    }

    if (path.isSequenceExpression()) {
      const value = path.get("expressions").at(-1);
      if (value)
        return localObjectRoots(
          value,
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );
    }

    if (path.isAssignmentExpression({ operator: "=" })) {
      return localObjectRoots(
        path.get("right"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
    }

    if (
      path.isTSAsExpression() ||
      path.isTSTypeAssertion() ||
      path.isTSNonNullExpression() ||
      path.isTSSatisfiesExpression() ||
      path.isTypeCastExpression() ||
      path.isParenthesizedExpression()
    ) {
      const expression = path.get("expression");
      if (!Array.isArray(expression))
        return localObjectRoots(
          expression,
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );
    }

    if (path.isConditionalExpression()) {
      localObjectRoots(
        path.get("consequent"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
      localObjectRoots(
        path.get("alternate"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
    }

    if (path.isLogicalExpression()) {
      // An && expression only returns its left operand when it is falsy,
      // so an object receiver can only come from the right operand.
      if (path.node.operator !== "&&")
        localObjectRoots(
          path.get("left"),
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );

      localObjectRoots(
        path.get("right"),
        roots,
        memberOwner,
        seen,
        selection,
        copiedPropertyExclusions
      );
    }

    if (path.isCallExpression() || path.isOptionalCallExpression()) {
      if (isNullishOptionalChain(path)) return;
      localObjectRoots(
        path.get("callee") as NodePath<t.Node>,
        roots,
        memberOwner,
        seen,
        [{ call: true }, ...selection],
        copiedPropertyExclusions
      );
    }

    const selected = selection[0];
    const called =
      selected && typeof selected === "object" && "call" in selected;
    if (
      path.isFunction() &&
      ((called &&
        (!memberOwner || (!path.node.async && !path.node.generator))) ||
        (!memberOwner && selection.length === 0))
    ) {
      // Async/generator calls produce wrappers, not the returned receiver.
      // Escaping wrappers can still expose their resolved/yielded values.
      // Passing a callback also exposes its returned, yielded or thrown values.
      // The caller can obtain a registered receiver without a local alias.
      for (const value of functionExposedValues(path))
        localObjectRoots(
          value,
          roots,
          memberOwner,
          seen,
          called ? selection.slice(1) : selection,
          copiedPropertyExclusions
        );
    }

    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      const declaration = binding?.path;
      if (declaration?.isFunctionDeclaration())
        localObjectRoots(
          declaration,
          roots,
          memberOwner,
          seen,
          selection,
          copiedPropertyExclusions
        );
      if (declaration?.isVariableDeclarator()) {
        if (binding)
          for (const source of localBindingSources(binding))
            localObjectRoots(
              source.path,
              roots,
              memberOwner,
              seen,
              [...source.selection, ...selection],
              copiedPropertyExclusions
            );
      }

      // Reassigned aliases may refer to any explicitly assigned object. Keep
      // their possible roots instead of guessing which assignment ran last.
      for (const violation of binding?.constantViolations ?? []) {
        if (violation.isForOfStatement()) {
          const left = violation.get("left");
          if (left.isVariableDeclaration()) continue;
          for (const source of localPatternSources(
            left,
            violation.get("right"),
            path.node.name,
            [null]
          ))
            localObjectRoots(
              source.path,
              roots,
              memberOwner,
              seen,
              [...source.selection, ...selection],
              copiedPropertyExclusions
            );
          continue;
        }
        if (!violation.isAssignmentExpression()) continue;

        for (const source of localPatternSources(
          violation.get("left"),
          violation.get("right"),
          path.node.name
        ))
          localObjectRoots(
            source.path,
            roots,
            memberOwner,
            seen,
            [...source.selection, ...selection],
            copiedPropertyExclusions
          );
      }
    }
  } finally {
    visited.active = false;
  }

  return undefined;
}

function unwrapExpressionPath(path: NodePath<t.Node>): NodePath<t.Node> {
  while (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isTypeCastExpression() ||
    path.isParenthesizedExpression()
  ) {
    const expression = path.get("expression");
    if (Array.isArray(expression)) break;
    path = expression;
  }
  return path;
}

function hasOnlyArrayReads(
  binding: Binding,
  seen = new Set<Binding>()
): boolean {
  if (!binding.constant) return false;
  if (seen.has(binding)) return true;
  seen.add(binding);

  return binding.referencePaths.every((reference) => {
    let value = reference;
    while (
      value.parentPath &&
      unwrapExpressionPath(value.parentPath).node === reference.node
    )
      value = value.parentPath;

    const parent = value.parentPath;
    if (!parent) return false;
    if (parent.isSpreadElement() || parent.isTSTypeQuery()) return true;
    if (
      parent.isVariableDeclarator() &&
      parent.node.init === value.node &&
      t.isIdentifier(parent.node.id)
    ) {
      const alias = parent.scope.getBinding(parent.node.id.name);
      return !!alias && hasOnlyArrayReads(alias, seen);
    }
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === value.node
    ) {
      if (isWriteTarget(parent)) return false;
      let member: NodePath<t.Node> = parent;
      while (
        member.parentPath &&
        unwrapExpressionPath(member.parentPath).node === parent.node
      )
        member = member.parentPath;
      const consumer = member.parentPath;
      return !(
        (consumer?.isCallExpression() ||
          consumer?.isOptionalCallExpression() ||
          consumer?.isNewExpression()) &&
        consumer.node.callee === member.node
      );
    }
    return false;
  });
}

function staticArrayElements(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): NodePath<t.Expression | t.SpreadElement | null>[] | undefined {
  const expression = unwrapExpressionPath(path);
  if (seen.has(expression.node)) return;
  seen.add(expression.node);
  try {
    if (expression.isIdentifier()) {
      const binding = expression.scope.getBinding(expression.node.name);
      if (
        !binding ||
        !hasOnlyArrayReads(binding) ||
        !binding.path.isVariableDeclarator() ||
        !binding.path.get("id").isIdentifier()
      )
        return;
      const init = binding.path.get("init");
      return init.isExpression() ? staticArrayElements(init, seen) : undefined;
    }
    if (!expression.isArrayExpression()) return;

    const elements: NodePath<t.Expression | t.SpreadElement | null>[] = [];
    for (const element of expression.get("elements")) {
      if (!element.isSpreadElement()) elements.push(element);
      else {
        const spread = staticArrayElements(element.get("argument"), seen);
        if (!spread) return;
        elements.push(...spread);
      }
    }
    return elements;
  } finally {
    seen.delete(expression.node);
  }
}

function isNullishOptionalChain(path: NodePath<t.Node>): boolean {
  const expression = unwrapExpressionPath(path);
  if (
    !expression.isOptionalCallExpression() &&
    !expression.isOptionalMemberExpression()
  )
    return false;

  const receiver = unwrapExpressionPath(
    expression.isOptionalCallExpression()
      ? expression.get("callee")
      : expression.get("object")
  );
  if (expression.node.optional) {
    const evaluated = receiver.evaluate();
    if (evaluated.confident && evaluated.value == null) return true;
  }
  return isNullishOptionalChain(receiver);
}

function isSkippedOptionalArgument(path: NodePath<t.Node>): boolean {
  for (let child = path; child.parentPath; child = child.parentPath) {
    const parent = child.parentPath;
    if (
      ((parent.isOptionalCallExpression() && child.listKey === "arguments") ||
        (parent.isOptionalMemberExpression() &&
          parent.node.computed &&
          child.key === "property")) &&
      isNullishOptionalChain(parent)
    )
      return true;
  }
  return false;
}

/** One graph walk, driven by synchronous Node I/O or asynchronous bundler I/O. */
export function* analyzeExtractCalls(
  options: ExtractCallsAnalysisOptions
): ExtractCallsAnalysis {
  const root = canonicalExtractCallsFile(options.root);
  const parseDependencyProgram = (
    id: string,
    source: string,
    jsx?: boolean
  ) => {
    // The owner can have a file-specific .mts/.cts ambiguity restriction.
    // A plain TypeScript dependency keeps its own dialect while retaining
    // shared parser options (for example, decorators).
    const parserPlugins =
      /\.[cm]ts$/i.test(options.filename) && /\.tsx?$/i.test(id)
        ? options.parserPlugins?.map((entry) =>
            Array.isArray(entry) &&
            entry[0] === "typescript" &&
            entry[1]?.disallowAmbiguousJSXLike
              ? ([
                  entry[0],
                  { ...entry[1], disallowAmbiguousJSXLike: false }
                ] as typeof entry)
              : entry
          )
        : options.parserPlugins;
    return parseProgram(id, source, jsx, options.parserCache, parserPlugins);
  };
  const {
    dependencies,
    combinedIntrinsicSnapshot,
    modules,
    resolveImport,
    load,
    bindingTarget,
    valueTarget,
    resolveExport
  } = createModuleGraph({
    onResolveBinding(module, binding) {
      if (module.id === options.filename)
        registrationBindings?.add(binding.identifier.name);
    },
    parse: parseDependencyProgram
  });
  // Consumer origins describe the values that run after host transforms.
  // Registered implementations and sidecar dependencies retain the authoring
  // graph; sharing its ASTs here would confuse two different module surfaces.
  const consumerGraph = createModuleGraph({
    loadPurpose: "consumer-runtime",
    isExternal: (id) => isExternal(id.split(/[?#]/, 1)[0]!),
    parse: (id, source, jsx) =>
      parseDependencyProgram(id.split(/[?#]/, 1)[0]!, source, jsx)
  });

  const protectedFunctions = new Map<
    string,
    Map<string, { start: number; end: number }>
  >();

  const visited = new Map<t.Node, Set<t.Node | undefined>>();
  const mutatedReceivers = new Map<Module, Set<t.ObjectExpression>>();
  const escapedReceivers = new Map<Module, Set<t.ObjectExpression>>();
  let registrationBindings: Set<string> | undefined;
  let registration = "extractCalls";

  function* resolveReceiverMember(
    target: Target,
    name: string
  ): Flow<RegisteredTarget | null> {
    if ("external" in target) return null;
    const { path, module } = target;
    if (path.isProgram()) {
      const member = yield* resolveExport(module, name, new Set());
      return member ? { target: member } : null;
    }

    if (
      !path.isObjectExpression() ||
      path.node.properties.some(
        (property) => t.isSpreadElement(property) || property.computed
      )
    )
      return null;

    let mutations = mutatedReceivers.get(module);
    if (!mutations) {
      const writes = new Set<t.ObjectExpression>();
      const escapes = new Set<t.ObjectExpression>();
      const exports = new Map<string | null, t.Expression>();
      for (const [name, entry] of commonJsExports(module.program, module.id)
        .exports)
        if (entry.kind === "expression") exports.set(name, entry.expression);
      const exportedPaths = new Map<string | null, NodePath<t.Node>>();
      if (exports.size > 0) {
        const nodes = new Set<t.Node>(exports.values());
        const paths = new Map<t.Node, NodePath<t.Node>>();
        module.program.traverse({
          enter(value) {
            if (nodes.has(value.node)) paths.set(value.node, value);
          }
        });
        for (const [name, node] of exports) {
          const value = paths.get(node);
          if (value) exportedPaths.set(name, value);
        }
      }
      const rootState = (): LocalRootState => ({
        nodes: new Map(),
        commonJs: exportedPaths
      });
      const collectArgumentEscapes = (
        call: NodePath<
          t.CallExpression | t.OptionalCallExpression | t.NewExpression
        >
      ) => {
        if (isNullishOptionalChain(call) || isSkippedOptionalArgument(call))
          return;
        for (const argument of call.get("arguments")) {
          const value = argument.isSpreadElement()
            ? argument.get("argument")
            : argument;
          if (value.isExpression())
            localObjectRoots(value, escapes, false, rootState());
        }
      };

      const collectClassFieldEscape = (
        property: NodePath<t.ClassProperty | t.ClassPrivateProperty>
      ) => {
        if (isSkippedOptionalArgument(property)) return;
        const value = property.get("value");
        if (value.isExpression())
          localObjectRoots(value, escapes, false, rootState());
      };
      module.program.traverse({
        AssignmentExpression(assignment) {
          const left = unwrapExpressionPath(assignment.get("left"));
          if (isSkippedOptionalArgument(assignment)) return;

          if (!left.isMemberExpression()) {
            for (const target of memberStores(left))
              for (const source of localPatternSources(
                left,
                assignment.get("right"),
                target
              ))
                localObjectRoots(
                  source.path,
                  escapes,
                  false,
                  rootState(),
                  source.selection
                );
            return;
          }

          const target = getCjsAssignmentTarget(left.node, left.scope);
          const published =
            target.kind === "property"
              ? exports.get(target.exportName)
              : target.kind === "module-replacement"
                ? exports.get(null)
                : undefined;
          if (
            assignment.node.operator === "=" &&
            published === assignment.node.right
          )
            return;

          // Property stores escape the local binding model. The stored value
          // may later be read or mutated through that container.
          localObjectRoots(
            assignment.get("right"),
            escapes,
            false,
            rootState()
          );
        },
        MemberExpression(member) {
          if (!isWriteTarget(member) || isSkippedOptionalArgument(member))
            return;
          localObjectRoots(member.get("object"), writes, true, rootState());
        },
        CallExpression: collectArgumentEscapes,
        OptionalCallExpression: collectArgumentEscapes,
        NewExpression: collectArgumentEscapes,
        ClassProperty: collectClassFieldEscape,
        ClassPrivateProperty: collectClassFieldEscape,
        ThrowStatement(statement) {
          if (isSkippedOptionalArgument(statement)) return;
          localObjectRoots(
            statement.get("argument"),
            escapes,
            false,
            rootState()
          );
        },
        TaggedTemplateExpression(tagged) {
          if (isSkippedOptionalArgument(tagged)) return;
          for (const substitution of tagged.get("quasi").get("expressions"))
            if (substitution.isExpression())
              localObjectRoots(substitution, escapes, false, rootState());
        }
      });
      mutations = writes;
      mutatedReceivers.set(module, writes);
      escapedReceivers.set(module, escapes);
    }

    if (mutations.has(path.node))
      throw new Error(
        `Cannot use mutated extractCalls receiver in ${module.id}`
      );

    if (escapedReceivers.get(module)?.has(path.node))
      throw new Error(
        `Cannot use escaped extractCalls receiver in ${module.id}`
      );

    const member = path.get("properties").findLast((property) => {
      const node = property.node;
      return (
        (t.isObjectMethod(node) || t.isObjectProperty(node)) &&
        (t.isIdentifier(node.key) || t.isStringLiteral(node.key)) &&
        exportedName(node.key) === name
      );
    });
    if (!member || member.isSpreadElement()) return null;
    if (member.isObjectMethod() && member.node.kind !== "method") return null;

    const value = yield* valueTarget(
      module,
      member.isObjectProperty() ? member.get("value") : member,
      new Set()
    );

    return value ? { target: value, receiver: { module, path } } : null;
  }

  function* resolveRegisteredExports(
    module: Module,
    name: string
  ): Flow<RegisteredTarget[]> {
    const targets: RegisteredTarget[] = [];
    const literal = yield* resolveExport(module, name, new Set());

    if (literal) targets.push({ target: literal });
    if (!name.includes(".")) return targets;

    const [head, ...members] = name.split(".");
    const target = yield* resolveExport(module, head!, new Set());
    let selected: RegisteredTarget | null = target ? { target } : null;

    for (const name of members)
      selected = selected
        ? yield* resolveReceiverMember(selected.target, name)
        : null;

    if (selected) targets.push(selected);

    return targets;
  }

  function rememberFunction(module: Module, path: NodePath<t.Node>): void {
    if (!path.isFunction()) return;

    const { start, end } = path.node;
    if (start == null || end == null)
      throw new Error(`Missing function source location in ${module.id}`);

    const ranges = protectedFunctions.get(module.id) ?? new Map();
    ranges.set(`${start}:${end}`, { start, end });
    protectedFunctions.set(module.id, ranges);
  }

  function* protect(target: Target, receiver?: Receiver): Flow<void> {
    if ("external" in target) return;

    const { module, path } = target;
    const owners = visited.get(path.node) ?? new Set<t.Node | undefined>();
    if (owners.has(receiver?.path.node)) return;
    owners.add(receiver?.path.node);
    visited.set(path.node, owners);

    const references: Array<{
      binding: Binding;
      reference: NodePath<t.Identifier>;
    }> = [];

    const reference = (reference: NodePath<t.Identifier>) => {
      const binding = reference.scope.getBinding(reference.node.name);

      if (
        binding &&
        binding.path !== path &&
        !binding.path.findParent((parent) => parent === path)
      )
        references.push({ binding, reference });
    };

    rememberFunction(module, path);

    if (path.isReferencedIdentifier())
      reference(path as NodePath<t.Identifier>);

    const receiverReferences: string[][] = [];
    path.traverse({
      TSType(child) {
        child.skip();
      },

      Function(child) {
        rememberFunction(module, child);
      },

      ReferencedIdentifier(child) {
        if (child.isIdentifier()) reference(child);
      },

      ThisExpression(child) {
        if (
          !receiver ||
          child.findParent(
            (parent) =>
              parent.isFunction() && !parent.isArrowFunctionExpression()
          ) !== path
        )
          return;

        const names: string[] = [];
        let value: NodePath<t.Node> = child;
        while (value.parentPath) {
          const member = value.parentPath;
          if (
            (member.isTSAsExpression() ||
              member.isTSTypeAssertion() ||
              member.isTSNonNullExpression() ||
              member.isTSSatisfiesExpression() ||
              member.isTypeCastExpression() ||
              member.isParenthesizedExpression()) &&
            member.node.expression === value.node
          ) {
            value = member;
            continue;
          }

          if (
            (!member.isMemberExpression() &&
              !member.isOptionalMemberExpression()) ||
            member.node.object !== value.node
          )
            break;

          const property = member.node.property;
          if (!member.node.computed && t.isIdentifier(property))
            names.push(property.name);
          else if (t.isStringLiteral(property)) names.push(property.value);
          else
            throw new Error(
              `Cannot identify extractCalls receiver member in ${module.id}`
            );

          value = member;
        }

        if (names.length === 0)
          throw new Error(
            `Cannot identify extractCalls receiver member in ${module.id}`
          );

        if (isWriteTarget(value))
          throw new Error(
            `Cannot use mutated extractCalls receiver in ${module.id}`
          );

        receiverReferences.push(names);
      }
    });

    for (const names of receiverReferences) {
      let dependency: RegisteredTarget | null = { target: receiver! };
      for (const name of names)
        dependency = dependency
          ? yield* resolveReceiverMember(dependency.target, name)
          : null;

      if (!dependency)
        throw new Error(
          `Cannot identify extractCalls receiver member ${names.join(".")} in ${module.id}`
        );

      yield* protect(dependency.target, dependency.receiver);
    }

    const inlineRequires: { source: string; path: NodePath<t.Node> }[] = [];
    path.traverse({
      CallExpression(call) {
        const source = getStaticCssEvalLiteralRequireImportPath(
          call.node,
          call.scope
        );
        if (source)
          inlineRequires.push({
            source,
            path: call.parentPath.isMemberExpression() ? call.parentPath : call
          });
      }
    });

    for (const { source, path: call } of inlineRequires) {
      const id = yield* resolveImport(module.id, source, "require");
      if (id ? isExternal(id) : !isLocalExtractCallsSource(source)) continue;

      const dependency = yield* valueTarget(module, call, new Set());

      if (dependency) yield* protect(dependency);
    }

    for (const { binding, reference } of references) {
      const cjs = getModuleReference(reference);

      if (cjs?.kind === "require") {
        const id = yield* resolveImport(module.id, cjs.source, "require");
        if (id ? isExternal(id) : !isLocalExtractCallsSource(cjs.source))
          continue;

        const member =
          reference.parentPath.isMemberExpression() &&
          reference.parentPath.node.object === reference.node
            ? reference.parentPath
            : reference;

        const dependency = yield* valueTarget(module, member, new Set());

        if (dependency) yield* protect(dependency);
      } else if (binding.path.isImportNamespaceSpecifier()) {
        const declaration = binding.path.parentPath;
        if (!declaration.isImportDeclaration()) continue;

        const id = yield* resolveImport(
          module.id,
          declaration.node.source.value
        );

        if (!id) {
          if (!isLocalExtractCallsSource(declaration.node.source.value))
            continue;

          throw new Error(
            `Cannot resolve ${declaration.node.source.value} from ${module.id}`
          );
        }

        if (isExternal(id)) continue;

        const name = referencedMemberName(reference);
        if (name === null)
          throw new Error(
            `Cannot identify namespace helper ${reference.node.name} in ${module.id}`
          );

        const dependency = yield* resolveExport(
          yield* load(id),
          name,
          new Set()
        );

        if (dependency) yield* protect(dependency);
      } else if (
        binding.path.isImportSpecifier() ||
        binding.path.isImportDefaultSpecifier()
      ) {
        const dependency = yield* bindingTarget(module, binding, new Set());

        if (dependency) yield* protect(dependency);
      } else {
        const name = referencedMemberName(reference);
        const init = binding.path.isVariableDeclarator()
          ? binding.path.get("init")
          : undefined;

        if (
          name &&
          binding.constant &&
          init?.isObjectExpression() &&
          init.node.properties.every(
            (property) => !t.isSpreadElement(property) && !property.computed
          )
        ) {
          const dependency = yield* resolveReceiverMember(
            { module, path: init },
            name
          );

          if (dependency) {
            yield* protect(dependency.target, dependency.receiver);
            continue;
          }
        }

        yield* protect({ module, path: binding.path });
      }
    }
  }

  try {
    const config = normalizeExtractCalls(
      options.extractCalls,
      options.parserCache
    );

    const hasTargets = Object.keys(config).length > 0;
    const imports: Record<string, readonly string[]> = Object.create(null);
    const localBindings = new Set<string>();
    const localTargets = new Map<string, Set<string>>();
    const requires: Record<string, readonly string[]> = Object.create(null);
    const resolvedSources: {
      import: Record<string, string>;
      require: Record<string, string>;
    } = { import: Object.create(null), require: Object.create(null) };
    const registeredReceiverPaths = new Map<string, string[][]>();
    const owner = {
      id: options.filename,
      program:
        options.program ??
        parseProgram(
          options.filename,
          options.source,
          options.jsx,
          options.parserCache,
          options.parserPlugins
        )
    };

    modules.set(owner.id, owner);

    for (const [source, names] of Object.entries(config)) {
      if (!isLocalExtractCallsSource(source)) {
        imports[source] = names;
        requires[source] = names;
        continue;
      }

      registration = `extractCalls[${JSON.stringify(source)}]`;
      dependencies.add(resolve(root, source).replaceAll("\\", "/"));

      const id = yield* resolveImport(
        resolve(root, "__mincho_extract_calls__.ts"),
        source,
        "require"
      );
      if (!id) throw new Error(`Cannot resolve registered module from ${root}`);

      const module = yield* load(id);
      const exports = localTargets.get(id) ?? new Set<string>();
      localTargets.set(id, exports);

      for (const name of names) {
        registration = `extractCalls[${JSON.stringify(source)}]: export ${JSON.stringify(name)}`;

        registrationBindings = localBindings;
        const targets = yield* resolveRegisteredExports(module, name);

        if (name === "default") {
          const raw = yield* resolveExport(module, null, new Set());

          if (raw && ("external" in raw || raw.path.isFunction()))
            targets.push({ target: raw });
        }

        registrationBindings = undefined;

        if (
          !targets.length ||
          targets.some(
            ({ target }) => !("external" in target) && !target.path.isFunction()
          )
        )
          throw new Error(
            `Cannot statically identify a function implementation in ${id}`
          );

        exports.add(name);

        for (const { target, receiver } of targets) {
          // Named default functions resolve directly, without visiting a binding.
          if (
            !("external" in target) &&
            target.module.id === owner.id &&
            target.path.isFunctionDeclaration() &&
            target.path.node.id
          )
            localBindings.add(target.path.node.id.name);

          yield* protect(target, receiver);
        }
      }
    }

    let needsConsumerOrigins = localBindings.size > 0;
    const requireSources = new Set<string>();
    owner.program.traverse({
      JSXAttribute(path) {
        if (t.isJSXIdentifier(path.node.name, { name: "css" }))
          needsConsumerOrigins = true;
      },
      JSXSpreadAttribute() {
        needsConsumerOrigins = true;
      },
      CallExpression(path) {
        const source = getStaticCssEvalLiteralRequireImportPath(
          path.node,
          path.scope
        );

        if (source) requireSources.add(source);
      }
    });

    for (const statement of owner.program.get("body")) {
      if (
        !statement.isImportDeclaration() ||
        statement.node.importKind === "type"
      )
        continue;

      const source = statement.node.source.value;
      if (!hasTargets) continue;

      const id = yield* resolveImport(owner.id, source);
      const runtimeId = yield* consumerGraph.resolveImport(owner.id, source);
      if (runtimeId) resolvedSources.import[source] = runtimeId;

      const names = id ? localTargets.get(id) : undefined;

      if (names)
        imports[source] = [
          ...new Set([...(imports[source] ?? []), ...names])
        ].sort();
      if (
        imports[source]?.length &&
        statement.node.specifiers.some(
          (specifier) =>
            !t.isImportSpecifier(specifier) || specifier.importKind !== "type"
        )
      )
        needsConsumerOrigins = true;
      if (names && runtimeId)
        registeredReceiverPaths.set(
          runtimeId,
          [...names].map((name) => name.split(".").slice(0, -1))
        );
    }

    for (const source of requireSources) {
      if (!hasTargets) continue;

      const id = yield* resolveImport(owner.id, source, "require");
      const runtimeId = yield* consumerGraph.resolveImport(
        owner.id,
        source,
        "require"
      );
      if (runtimeId) resolvedSources.require[source] = runtimeId;

      const names = id ? localTargets.get(id) : undefined;

      if (names)
        requires[source] = [
          ...new Set([...(requires[source] ?? []), ...names])
        ].sort();
      if (requires[source]?.length) needsConsumerOrigins = true;
      if (names && runtimeId)
        registeredReceiverPaths.set(
          runtimeId,
          [...names].map((name) => name.split(".").slice(0, -1))
        );
    }

    const consumedPaths = new Map<string, string[][]>();
    if (hasTargets)
      owner.program.traverse({
        "ReferencedIdentifier|MemberExpression"(path: NodePath<t.Node>) {
          const reference = getModuleReference(path);
          if (!reference) return;
          const id = resolvedSources[reference.kind][reference.source];
          if (!id) return;
          const members: string[] = [];
          for (const member of reference.members) {
            if (member === null) break;
            members.push(member);
          }
          const paths = consumedPaths.get(id) ?? [];
          paths.push(members);
          consumedPaths.set(id, paths);
        }
      });

    const exportOrigins: Record<
      string,
      {
        exports: Record<string, string>;
        esModule: boolean;
        unknownExports?: readonly string[];
        unknownContents?: readonly string[];
        inertInvocations?: Readonly<Record<string, "call" | "construct">>;
        recipeInvocations?: Readonly<Record<string, "class-string">>;
        authoringCalls?: Readonly<Record<string, AuthoringCallContract>>;
        closedOwnAllocations?: Readonly<
          Record<string, ClosedOwnAllocationShape>
        >;
        primitiveExports?: readonly string[];
        sourceInvocationResults?: Readonly<
          Record<string, SourceInvocationResult>
        >;
        ownDataPaths?: readonly string[];
        readablePaths?: readonly string[];
        closedDataPaths?: readonly string[];
      }
    > = Object.create(null);
    for (const id of new Set([
      ...Object.values(resolvedSources.import),
      ...Object.values(resolvedSources.require)
    ])) {
      // Registration validation above is unconditional. Runtime provenance is
      // only needed when this owner can use a registered API, including calls
      // introduced by JSX lowering; ordinary consumers need no host transforms.
      if (!needsConsumerOrigins) continue;
      const receiverPaths = [
        ...(registeredReceiverPaths.get(id) ?? []),
        ...(consumedPaths.get(id) ?? [])
      ];
      const origins = yield* consumerGraph.objectExportOrigins(
        id,
        receiverPaths
      );
      if (
        Object.keys(origins.exports).length ||
        origins.unknownExports?.length ||
        origins.unknownContents?.length ||
        origins.readablePaths?.length ||
        origins.primitiveExports?.length
      )
        exportOrigins[id] = origins;
    }

    // Both graphs have finished all requests. Earlier per-export snapshots
    // would miss a mutation discovered while resolving a later dependency.
    const authoringIntrinsics = combinedIntrinsicSnapshot();
    const runtimeIntrinsics = consumerGraph.combinedIntrinsicSnapshot();
    const authoringMath = authoringIntrinsics.math;
    const runtimeMath = runtimeIntrinsics.math;
    const mathIntrinsics = {
      intact: authoringMath.intact && runtimeMath.intact,
      bindIntact: authoringMath.bindIntact && runtimeMath.bindIntact,
      revision: authoringMath.revision + runtimeMath.revision,
      fingerprint: JSON.stringify([
        authoringMath.fingerprint,
        runtimeMath.fingerprint
      ])
    };

    const authoringArrayMap = authoringIntrinsics.arrayMap;
    const runtimeArrayMap = runtimeIntrinsics.arrayMap;
    const arrayMapIntrinsics = {
      intact: authoringArrayMap.intact && runtimeArrayMap.intact,
      iterationIntact:
        authoringArrayMap.iterationIntact && runtimeArrayMap.iterationIntact,
      prototypeAbsenceIntact:
        authoringArrayMap.prototypeAbsenceIntact &&
        runtimeArrayMap.prototypeAbsenceIntact,
      prototypeMutationKeys:
        authoringArrayMap.prototypeMutationKeys === null ||
        runtimeArrayMap.prototypeMutationKeys === null
          ? null
          : [
              ...new Set([
                ...authoringArrayMap.prototypeMutationKeys,
                ...runtimeArrayMap.prototypeMutationKeys
              ])
            ].sort(),
      revision: authoringArrayMap.revision + runtimeArrayMap.revision,
      fingerprint: JSON.stringify([
        authoringArrayMap.fingerprint,
        runtimeArrayMap.fingerprint
      ])
    };

    const fingerprintModuleId = (id: string) =>
      isAbsolute(id) ? relative(root, id).replaceAll("\\", "/") : id;

    return {
      imports,
      mathIntrinsics,
      arrayMapIntrinsics,
      localBindings: [...localBindings].sort(),
      requires,
      resolvedSources,
      exportOrigins,
      fingerprint: hasTargets
        ? JSON.stringify([
            // Identical source can resolve imports differently for each owner.
            fingerprintModuleId(owner.id),
            // Sidecar names are portable artifacts, not internal graph cache
            // keys. Keep absolute source identities and observation revisions
            // in the private snapshots; only semantic authority belongs here.
            [
              "math-intrinsics",
              mathIntrinsics.intact,
              mathIntrinsics.bindIntact
            ],
            ["array-map-intrinsics", arrayMapIntrinsics.intact],
            [
              "prototype-mutation-keys",
              arrayMapIntrinsics.prototypeMutationKeys
            ],
            ["array-iteration-intrinsics", arrayMapIntrinsics.iterationIntact],
            [
              "prototype-absence-intrinsics",
              arrayMapIntrinsics.prototypeAbsenceIntact
            ],
            config,
            [...localTargets]
              .map(([id, names]) => [
                fingerprintModuleId(id),
                [...names].sort()
              ])
              .sort(),
            (["import", "require"] as const).map((kind) =>
              Object.entries(resolvedSources[kind])
                .map(([source, id]) => [source, fingerprintModuleId(id)])
                .sort()
            ),
            Object.entries(exportOrigins)
              .map(
                ([
                  id,
                  {
                    exports,
                    esModule,
                    unknownExports,
                    unknownContents,
                    inertInvocations,
                    recipeInvocations,
                    authoringCalls,
                    closedOwnAllocations,
                    primitiveExports,
                    sourceInvocationResults,
                    ownDataPaths,
                    readablePaths,
                    closedDataPaths
                  }
                ]) => [
                  fingerprintModuleId(id),
                  esModule,
                  Object.entries(exports)
                    .map(([path, origin]) => {
                      const [moduleId, start, end] = JSON.parse(origin) as [
                        string,
                        number,
                        number
                      ];
                      return [
                        path,
                        [fingerprintModuleId(moduleId), start, end]
                      ];
                    })
                    .sort(),
                  ...(unknownExports?.length
                    ? [[...unknownExports].sort()]
                    : []),
                  ...(unknownContents?.length
                    ? [["unknownContents", [...unknownContents].sort()]]
                    : []),
                  ...(inertInvocations
                    ? [
                        [
                          "inertInvocations",
                          Object.entries(inertInvocations).sort()
                        ]
                      ]
                    : []),
                  ...(sourceInvocationResults
                    ? [
                        [
                          "sourceInvocationResults",
                          Object.entries(sourceInvocationResults).sort()
                        ]
                      ]
                    : []),
                  ...(primitiveExports?.length
                    ? [["primitiveExports", [...primitiveExports].sort()]]
                    : []),
                  ...(closedOwnAllocations
                    ? [
                        [
                          "closedOwnAllocations",
                          Object.entries(closedOwnAllocations).sort()
                        ]
                      ]
                    : []),
                  ...(authoringCalls
                    ? [
                        [
                          "authoringCalls",
                          Object.entries(authoringCalls)
                            .map(([path, contract]) => [
                              path,
                              {
                                ...contract,
                                endpoint: {
                                  ...contract.endpoint,
                                  id: fingerprintModuleId(contract.endpoint.id)
                                }
                              }
                            ])
                            .sort()
                        ]
                      ]
                    : []),
                  ...(recipeInvocations
                    ? [
                        [
                          "recipeInvocations",
                          Object.entries(recipeInvocations).sort()
                        ]
                      ]
                    : []),
                  ...(ownDataPaths?.length
                    ? [["ownDataPaths", [...ownDataPaths].sort()]]
                    : []),
                  ...(readablePaths?.length
                    ? [["readablePaths", [...readablePaths].sort()]]
                    : []),
                  ...(closedDataPaths?.length
                    ? [["closedDataPaths", [...closedDataPaths].sort()]]
                    : [])
                ]
              )
              .sort(),
            [
              "consumer-runtime-sources",
              [...consumerGraph.modules.values()]
                .filter((module) => module.runtimeSource)
                .map((module) => [
                  fingerprintModuleId(module.id),
                  module.runtimeSource!.sourceHash,
                  module.runtimeSource!.version
                ])
                .sort()
            ]
          ])
        : "",
      protectedFunctions: [
        ...(protectedFunctions.get(owner.id)?.values() ?? [])
      ],
      dependencies: [
        ...new Set([...dependencies, ...consumerGraph.dependencies])
      ]
        .filter((id) => id !== owner.id)
        .sort()
    };
  } catch (error) {
    throw new ExtractCallsError(
      `${registration}: ${error instanceof Error ? error.message : String(error)}`,
      dependencies,
      { cause: error }
    );
  }
}

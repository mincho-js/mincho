import { type NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";

// An obligation belongs to one transform's state and exact original call node.
// It certifies Babel publication only; downstream serialization can still fail.
const obligations = new WeakMap<
  object,
  Map<t.CallExpression, NodePath<t.CallExpression>>
>();
export function requireExtractionPublication(
  path: NodePath<t.CallExpression>
): void {
  const state = (path.scope.getProgramParent() as ProgramScope).minchoData;
  let pending = obligations.get(state);
  if (!pending) obligations.set(state, (pending = new Map()));
  pending.set(path.node, path);
}
export function completeExtractionPublication(
  program: ProgramScope,
  call: t.CallExpression
): void {
  obligations.get(program.minchoData)?.delete(call);
}
export function assertExtractionPublications(
  program: NodePath<t.Program>
): void {
  const pending = obligations.get((program.scope as ProgramScope).minchoData);
  const obligation = pending?.values().next().value;
  if (obligation)
    throw obligation.buildCodeFrameError(
      "Cannot complete compiler-owned output publication: the selected call was not exported and replaced by its runtime artifact reference."
    );
}

export function requiresExtractionPublication(
  program: ProgramScope,
  call: t.CallExpression
): boolean {
  return obligations.get(program.minchoData)?.has(call) === true;
}

/** Type-only wrappers do not change the exact initializer's execution. */
export function unwrapExtractionExpression(
  path: NodePath<t.Expression>,
  wrappers?: t.Expression[]
): NodePath<t.Expression> {
  while (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  ) {
    wrappers?.push(path.node);
    path = path.get("expression") as NodePath<t.Expression>;
  }
  return path;
}

/** A declaration-level opt-out applies to its direct call initializer too. */
export function isIgnoredExtractionCall(
  path: NodePath<t.CallExpression>
): boolean {
  let parent = path.parentPath;
  const owners: t.Node[] = [path.node];
  while (
    parent.isTSAsExpression() ||
    parent.isTSTypeAssertion() ||
    parent.isTSNonNullExpression() ||
    parent.isTSSatisfiesExpression() ||
    parent.isParenthesizedExpression()
  ) {
    owners.push(parent.node);
    parent = parent.parentPath!;
  }
  owners.push(parent.node);
  if (
    parent.isVariableDeclarator() &&
    parent.parentPath.isVariableDeclaration()
  )
    owners.push(parent.parentPath.node);
  return owners.some((owner) =>
    owner.leadingComments?.some(
      (comment) => comment.value.trim() === "mincho-js-ignore"
    )
  );
}

// Removal is committed only with the complete group's publication obligations.
const capturedOwnerCalls = new WeakMap<object, Set<t.CallExpression>>();
export function isCommittedCapturedAuthoringOwner(
  path: NodePath<t.CallExpression>
): boolean {
  return (
    capturedOwnerCalls
      .get((path.scope.getProgramParent() as ProgramScope).minchoData)
      ?.has(path.node) === true
  );
}
const capturedOwners = new WeakMap<
  object,
  Map<
    t.VariableDeclarator,
    {
      path: NodePath<t.VariableDeclarator>;
      id: t.VariableDeclarator["id"];
      init: t.Expression;
      value: t.Expression;
      wrappers: readonly t.Expression[];
      parent: t.Node;
      container: t.Program | t.BlockStatement;
      pattern: boolean;
      before: readonly t.Node[];
      after: readonly t.Node[];
    }
  >
>();
export function requireCapturedAuthoringOwner(
  path: NodePath<t.VariableDeclarator>
): void {
  requireCapturedOwner(path, false);
}

/** Exact declarations whose CSS-authoring destructuring is wholly published at build time. */
export function requireCapturedPatternOwner(
  path: NodePath<t.VariableDeclarator>
): void {
  requireCapturedOwner(path, true);
}
export function hasCapturedPatternOwner(
  program: ProgramScope,
  declaration: t.VariableDeclaration
): boolean {
  return declaration.declarations.some(
    (node) =>
      capturedOwners.get(program.minchoData)?.get(node)?.pattern === true
  );
}
function requireCapturedOwner(
  path: NodePath<t.VariableDeclarator>,
  pattern: boolean
): void {
  const state = (path.scope.getProgramParent() as ProgramScope).minchoData;
  const init = path.get("init");
  if (!init.isExpression() || (!pattern && !init.isCallExpression()))
    throw path.buildCodeFrameError("Missing captured authoring initializer.");
  const wrappers: t.Expression[] = [];
  const value = pattern ? unwrapExtractionExpression(init, wrappers) : init;
  let calls = capturedOwnerCalls.get(state);
  if (!calls) capturedOwnerCalls.set(state, (calls = new Set()));
  if (value.isCallExpression()) {
    if (isIgnoredExtractionCall(value))
      throw value.buildCodeFrameError(
        "Ignored authoring initializer cannot enter a required build group."
      );
    calls.add(value.node);
  }
  let owners = capturedOwners.get(state);
  if (!owners) capturedOwners.set(state, (owners = new Map()));
  const body = pattern
    ? path.parentPath.parentPath?.node
    : path.scope.getProgramParent().path.node;
  if (!body || (!t.isProgram(body) && !t.isBlockStatement(body)))
    throw path.buildCodeFrameError("Missing owner program.");
  const index = body.body.indexOf(path.parent as t.Statement);
  if (!owners.has(path.node))
    owners.set(path.node, {
      path,
      id: path.node.id,
      init: init.node,
      value: value.node,
      wrappers,
      parent: path.parent,
      container: body,
      pattern,
      before: body.body.slice(0, index),
      after: body.body.slice(index + 1)
    });
}
/** Called after sidecar cloning and publication, never relying on bundler DCE. */
export function finishCapturedAuthoringOwners(
  program: NodePath<t.Program>
): void {
  const state = (program.scope as ProgramScope).minchoData;
  const owners = capturedOwners.get(state);
  if (!owners) return;
  assertExtractionPublications(program);
  program.scope.crawl();
  for (const [node, receipt] of owners) {
    const owner = receipt.path;
    const position = receipt.container.body.indexOf(
      receipt.parent as t.Statement
    );
    const moved =
      receipt.before.some((node) => {
        const index = receipt.container.body.indexOf(node as t.Statement);
        return index >= 0 && index >= position;
      }) ||
      receipt.after.some((node) => {
        const index = receipt.container.body.indexOf(node as t.Statement);
        return index >= 0 && index <= position;
      });
    const hasOriginalValue = () => {
      const init = owner.get("init");
      if (!init.isExpression()) return false;
      if (!receipt.pattern) return init.node === receipt.init;

      // Babel can erase type syntax before publication. The surviving
      // wrappers must be the same nodes in the same order, and the operand
      // must still be the exact original producer/value.
      const surviving: t.Expression[] = [];
      if (unwrapExtractionExpression(init, surviving).node !== receipt.value)
        return false;
      let from = 0;
      for (const wrapper of surviving) {
        const index = receipt.wrappers.indexOf(wrapper, from);
        if (index < 0) return false;
        from = index + 1;
      }
      return true;
    };
    if (
      moved ||
      position < 0 ||
      owner.removed ||
      !owner.isVariableDeclarator() ||
      owner.node !== node ||
      owner.parent !== receipt.parent ||
      owner.parentPath.parentPath?.node !== receipt.container ||
      (!receipt.pattern && !owner.parentPath.parentPath?.isProgram()) ||
      owner.node.id !== receipt.id ||
      !hasOriginalValue() ||
      (!receipt.pattern && owner.get("id").isIdentifier() === false) ||
      !state.nodes.some(
        (statement) =>
          statement.type === "VariableDeclaration" &&
          statement.declarations.includes(node)
      )
    )
      throw program.buildCodeFrameError(
        "Compiler-owned authoring initializer changed before publication."
      );
    const identifiers = t.getBindingIdentifiers(owner.node.id);
    if (
      Object.keys(identifiers).length === 0 ||
      Object.keys(identifiers).some((name) => {
        const binding = owner.scope.getBinding(name);
        return (
          binding?.path.node !== node ||
          binding.referencePaths.some(
            (reference) =>
              !receipt.pattern ||
              !reference.findParent(
                (parent) =>
                  parent.isVariableDeclarator() && owners.has(parent.node)
              )
          )
        );
      })
    )
      throw owner.buildCodeFrameError(
        "Compiler-owned authoring initializer still has runtime consumers."
      );
  }
  // Validate the entire group before changing any declaration or reference.
  for (const receipt of owners.values()) receipt.path.remove();
  capturedOwners.delete(state);
  capturedOwnerCalls.delete(state);
  program.scope.crawl();
}

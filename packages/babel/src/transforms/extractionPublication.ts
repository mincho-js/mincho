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

/** A declaration-level opt-out applies to its direct call initializer too. */
export function isIgnoredExtractionCall(
  path: NodePath<t.CallExpression>
): boolean {
  const owners: t.Node[] = [path.node, path.parent];
  if (
    path.parentPath.isVariableDeclarator() &&
    path.parentPath.parentPath.isVariableDeclaration()
  )
    owners.push(path.parentPath.parentPath.node);
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
  let calls = capturedOwnerCalls.get(state);
  if (!calls) capturedOwnerCalls.set(state, (calls = new Set()));
  if (init.isCallExpression()) {
    if (isIgnoredExtractionCall(init))
      throw init.buildCodeFrameError(
        "Ignored authoring initializer cannot enter a required build group."
      );
    calls.add(init.node);
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
      owner.node.init !== receipt.init ||
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

import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { getConfidentlyExecutedBranches } from "../jsxCssProp/sidecarSafety.js";
import type { ProgramScope } from "../types.js";

interface ExtractionBindings {
  visiting: Set<t.Node>;
  completed: Set<t.Node>;
  names: Map<Binding, string>;
  owners: Map<string, Binding>;
  references: WeakMap<t.Identifier, Binding>;
  executedBranches: WeakMap<t.Node, readonly string[]>;
}

const extractionBindings = new WeakMap<
  ProgramScope["minchoData"],
  ExtractionBindings
>();

function getState(program: ProgramScope): ExtractionBindings {
  let state = extractionBindings.get(program.minchoData);

  if (!state) {
    state = {
      visiting: new Set(),
      completed: new Set(),
      names: new Map(),
      owners: new Map(),
      references: new WeakMap(),
      executedBranches: new WeakMap()
    };
    extractionBindings.set(program.minchoData, state);
  }

  return state;
}

function getRoot(path: NodePath<t.Node>): NodePath<t.Node> {
  if (
    path.isVariableDeclarator() ||
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier()
  ) {
    return path.parentPath;
  }

  return path;
}

function isInside(path: NodePath<t.Node>, root: NodePath<t.Node>): boolean {
  return path === root || Boolean(path.findParent((parent) => parent === root));
}

function recordReferences(
  path: NodePath<t.Node>,
  state: ExtractionBindings
): void {
  const record = (identifier: NodePath<t.Identifier>) => {
    const referenced = identifier.isReferencedIdentifier();
    const declared = identifier.isBindingIdentifier();
    if (!referenced && !declared) return;

    const binding = identifier.scope.getBinding(identifier.node.name);

    if (binding) state.references.set(identifier.node, binding);
  };

  if (path.isIdentifier()) record(path);

  path.traverse({ Identifier: record });
}

function visitExecutedReferences(
  path: NodePath<t.Node>,
  state: ExtractionBindings,
  visit: (reference: NodePath<t.Identifier | t.JSXIdentifier>) => void
): void {
  const branches = path.isExpression()
    ? getConfidentlyExecutedBranches(path)
    : undefined;

  if (branches) {
    state.executedBranches.set(
      path.node,
      branches.map((branch) => String(branch.key))
    );
    for (const branch of branches)
      visitExecutedReferences(branch, state, visit);

    return;
  }

  if (path.isReferencedIdentifier()) visit(path);

  path.traverse({
    "ConditionalExpression|LogicalExpression"(inner) {
      visitExecutedReferences(inner, state, visit);
      inner.skip();
    },
    ReferencedIdentifier: visit
  });
}

/** Collect declarations by lexical binding, retaining nested locals in their owner. */
export function collectExtractionBindings(path: NodePath<t.Node>): t.Node[] {
  const program = path.scope.getProgramParent() as ProgramScope;
  const state = getState(program);
  const nodes: t.Node[] = [];

  for (const binding of program.minchoData.bindings)
    state.completed.add(getRoot(binding).node);

  const registerName = (binding: Binding) => {
    if (state.names.has(binding)) return;

    const originalName = binding.identifier.name;
    const owner = state.owners.get(originalName);
    const name =
      owner && owner !== binding
        ? program.generateUidIdentifier(originalName).name
        : originalName;

    state.owners.set(name, binding);
    state.names.set(binding, name);
  };

  const collect = (binding: Binding) => {
    const root = getRoot(binding.path);
    if (!root.isStatement())
      throw path.buildCodeFrameError(
        `Cannot extract a call that captures runtime binding ${binding.identifier.name}. Register the local factory with extractCalls or use mincho-js-ignore.`
      );
    if (state.completed.has(root.node) || state.visiting.has(root.node)) return;

    // Imports from this sidecar already have a matching generated local alias.
    if (
      root.isImportDeclaration() &&
      root.node.source.value === program.minchoData.cssFile
    )
      return;

    state.visiting.add(root.node);
    registerName(binding);

    for (const identifier of Object.values(
      t.getOuterBindingIdentifiers(root.node)
    )) {
      const declared = root.scope.getBinding(identifier.name);

      if (declared && isInside(declared.path, root)) registerName(declared);
    }

    recordReferences(root, state);
    visitExecutedReferences(root, state, (reference) => {
      const dependency = reference.scope.getBinding(reference.node.name);

      if (dependency && !isInside(dependency.path, root)) collect(dependency);
    });
    state.visiting.delete(root.node);
    state.completed.add(root.node);
    program.minchoData.bindings.push(binding.path);
    nodes.push(root.node);
  };

  recordReferences(path, state);

  visitExecutedReferences(path, state, (reference) => {
    const binding = reference.scope.getBinding(reference.node.name);

    if (binding && !isInside(binding.path, path)) collect(binding);
  });

  return nodes;
}

/** Rename only sidecar clones, after other visitors finish rewriting source nodes. */
export function cloneExtractionNodes(program: ProgramScope): t.Statement[] {
  const state = getState(program);

  const rename = (source: t.Node, clone: t.Node): t.Node => {
    if (t.isIdentifier(source) && t.isIdentifier(clone)) {
      const binding = state.references.get(source);

      if (binding) clone.name = state.names.get(binding) ?? clone.name;
    }

    for (const key of t.VISITOR_KEYS[source.type] ?? []) {
      const original = (source as unknown as Record<string, t.Node | t.Node[]>)[
        key
      ];

      const copied = (clone as unknown as Record<string, t.Node | t.Node[]>)[
        key
      ];

      if (Array.isArray(original) && Array.isArray(copied)) {
        original.forEach((node, index) => {
          if (node && copied[index])
            copied[index] = rename(node, copied[index]);
        });
      } else if (
        original &&
        copied &&
        !Array.isArray(original) &&
        !Array.isArray(copied)
      ) {
        (clone as unknown as Record<string, t.Node>)[key] = rename(
          original,
          copied
        );
      }
    }

    const branches = state.executedBranches.get(source);
    if (branches) {
      const expressions = branches.map(
        (key) => (clone as unknown as Record<string, t.Expression>)[key]!
      );

      // Retain test/left evaluation, but never emit uncollected dead references.
      return expressions.length === 1
        ? t.sequenceExpression([t.numericLiteral(0), expressions[0]!])
        : t.sequenceExpression(expressions);
    }

    return clone;
  };

  return program.minchoData.nodes.map((node) => {
    const clone = t.cloneNode(node, true);
    return rename(node, clone) as t.Statement;
  });
}

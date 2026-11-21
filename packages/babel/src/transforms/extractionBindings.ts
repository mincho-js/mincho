import { hasCapturedPatternOwner } from "./extractionPublication.js";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import {
  createReplayAnalysis,
  type ReplayAnalysis
} from "../extractionCalls/replayAnalysis.js";
import type { ProgramScope } from "../types.js";

interface ExtractionBindings {
  completed: Set<t.Node>;
  names: Map<Binding, string>;
  owners: Map<string, Binding>;
  references: WeakMap<t.Identifier, Binding>;
  extractedReferences: WeakSet<t.Node>;
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
      completed: new Set(),
      names: new Map(),
      owners: new Map(),
      references: new WeakMap(),
      extractedReferences: new WeakSet(),
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

/** A captured declaration must execute in the same enclosing branch as its use. */
function sharesExecutionContext(
  declaration: NodePath<t.Node>,
  use: NodePath<t.Node>
): boolean {
  for (
    let child = declaration, parent = child.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    if (
      (parent.isFunction() ||
        parent.isIfStatement() ||
        parent.isLoop() ||
        parent.isSwitchStatement() ||
        parent.isTryStatement() ||
        parent.isCatchClause() ||
        parent.isWithStatement() ||
        parent.isStaticBlock()) &&
      !isInside(use, child)
    )
      return false;
  }
  return true;
}

function recordReferences(
  path: NodePath<t.Node>,
  state: ExtractionBindings,
  extracted = false
): void {
  const record = (identifier: NodePath<t.Identifier>) => {
    const referenced = identifier.isReferencedIdentifier();
    const declared = identifier.isBindingIdentifier();
    if (!referenced && !declared) return;
    if (extracted && referenced) state.extractedReferences.add(identifier.node);

    const binding = identifier.scope.getBinding(identifier.node.name);

    if (binding) state.references.set(identifier.node, binding);
  };

  if (path.isIdentifier()) record(path);

  path.traverse({ Identifier: record });
}

function visitExecutedReferences(
  path: NodePath<t.Node>,
  analysis: ReplayAnalysis,
  executedBranches: Pick<Map<t.Node, readonly string[]>, "set">,
  visit: (reference: NodePath<t.Identifier | t.JSXIdentifier>) => void
): void {
  const branches = analysis.branches.branches(path);

  if (branches) {
    executedBranches.set(
      path.node,
      branches.map((branch) => String(branch.key))
    );
    for (const branch of branches)
      visitExecutedReferences(branch, analysis, executedBranches, visit);

    return;
  }

  if (path.isReferencedIdentifier()) visit(path);

  path.traverse({
    "ConditionalExpression|LogicalExpression"(inner) {
      visitExecutedReferences(inner, analysis, executedBranches, visit);
      inner.skip();
    },
    ReferencedIdentifier: visit
  });
}

export function planExtractionBindings(
  path: NodePath<t.Node>,
  completed: ReadonlySet<t.Node> = new Set(),
  analysis = createReplayAnalysis(path.scope)
) {
  const program = path.scope.getProgramParent() as ProgramScope;
  const visited = new Set<t.Node>();
  const declarations: Array<{ binding: Binding; root: NodePath<t.Node> }> = [];
  const bindings: Binding[] = [];
  const branches = new Map<t.Node, readonly string[]>();
  let runtimeBinding: Binding | undefined;
  const collect = (binding: Binding) => {
    const root = getRoot(binding.path);
    if (
      !root.isStatement() ||
      !sharesExecutionContext(root, path) ||
      (binding.path.isVariableDeclarator() &&
        path.getFunctionParent() === binding.path.getFunctionParent() &&
        binding.path.node.end != null &&
        path.node.start != null &&
        binding.path.node.end > path.node.start)
    ) {
      runtimeBinding ??= binding;
      return;
    }
    const patternOwner =
      root.isVariableDeclaration() &&
      hasCapturedPatternOwner(program, root.node);
    const visitKey = patternOwner ? binding.path.node : root.node;
    if (completed.has(visitKey) || visited.has(visitKey)) return;

    // Generated imports already have a local alias in this sidecar. Their
    // declarations can be ESM imports or CommonJS require projections; copying
    // either would make the sidecar depend on itself.
    if (
      [...program.minchoData.imports].some(
        ([key, identifier]) =>
          key.startsWith(`${program.minchoData.cssFile}:`) &&
          identifier.name === binding.identifier.name &&
          program.getBinding(identifier.name) === binding
      )
    )
      return;

    visited.add(visitKey);
    bindings.push(binding);

    for (const identifier of Object.values(
      t.getOuterBindingIdentifiers(patternOwner ? binding.path.node : root.node)
    )) {
      const declared = root.scope.getBinding(identifier.name);

      if (declared && isInside(declared.path, root)) bindings.push(declared);
    }

    visitExecutedReferences(
      patternOwner ? binding.path : root,
      analysis,
      branches,
      (reference) => {
        const dependency = reference.scope.getBinding(reference.node.name);

        if (
          dependency &&
          !isInside(dependency.path, patternOwner ? binding.path : root)
        )
          collect(dependency);
      }
    );
    if (
      !declarations.some((declaration) => declaration.root.node === root.node)
    )
      declarations.push({ binding, root });
  };
  visitExecutedReferences(path, analysis, branches, (reference) => {
    const binding = reference.scope.getBinding(reference.node.name);

    if (binding && !isInside(binding.path, path)) collect(binding);
  });
  return { declarations, bindings, branches, runtimeBinding };
}

/** Babel bindings retain reference paths after their owning call is replaced. */
export function isExtractedReference(path: NodePath<t.Node>): boolean {
  const program = path.scope.getProgramParent() as ProgramScope;
  return getState(program).extractedReferences.has(path.node);
}

/** Validate a future sidecar owner without committing names or declarations. */
export function hasExtractableBindings(
  path: NodePath<t.Node>,
  analysis?: ReplayAnalysis
): boolean {
  return (
    planExtractionBindings(path, undefined, analysis).runtimeBinding ===
    undefined
  );
}

/** Collect declarations by lexical binding, retaining nested locals in their owner. */
export function collectExtractionBindings(path: NodePath<t.Node>): t.Node[] {
  const program = path.scope.getProgramParent() as ProgramScope;
  const state = getState(program);
  for (const binding of program.minchoData.bindings) {
    const root = getRoot(binding);
    state.completed.add(
      root.isVariableDeclaration() &&
        hasCapturedPatternOwner(program, root.node)
        ? binding.node
        : root.node
    );
  }
  const plan = planExtractionBindings(path, state.completed);
  if (plan.runtimeBinding)
    throw path.buildCodeFrameError(
      `Cannot extract a call that captures runtime binding ${plan.runtimeBinding.identifier.name}. Register the local factory with extractCalls or use mincho-js-ignore.`
    );

  for (const binding of plan.bindings) {
    if (state.names.has(binding)) continue;
    const originalName = binding.identifier.name;
    const owner = state.owners.get(originalName);
    const name =
      owner && owner !== binding
        ? program.generateUidIdentifier(originalName).name
        : originalName;
    state.owners.set(name, binding);
    state.names.set(binding, name);
  }
  for (const [node, branches] of plan.branches)
    state.executedBranches.set(node, branches);
  recordReferences(path, state, path.isCallExpression());
  for (const binding of plan.bindings) {
    const root = getRoot(binding.path);
    if (
      root.isVariableDeclaration() &&
      hasCapturedPatternOwner(program, root.node)
    ) {
      state.completed.add(binding.path.node);
      if (
        !program.minchoData.bindings.some(
          (path) => path.node === binding.path.node
        )
      )
        program.minchoData.bindings.push(binding.path);
    }
  }
  for (const { binding, root } of plan.declarations) {
    recordReferences(root, state);
    state.completed.add(root.node);
    if (
      !root.isVariableDeclaration() ||
      !hasCapturedPatternOwner(program, root.node)
    )
      program.minchoData.bindings.push(binding.path);
  }
  return plan.declarations.map(({ root }) => root.node);
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

  const nodes = program.minchoData.nodes.flatMap((node) => {
    if (!t.isVariableDeclaration(node) || node.declarations.length === 1)
      return [node];

    const required = new Set(
      program.minchoData.bindings.map((binding) => binding.node)
    );
    const declarations = hasCapturedPatternOwner(program, node)
      ? node.declarations.filter((declaration) => required.has(declaration))
      : node.declarations;
    return declarations.map((declaration) => {
      const statement = t.variableDeclaration(node.kind, [declaration]);

      statement.start = declaration.start;
      statement.end = declaration.end;
      return statement;
    });
  });

  for (const node of [...nodes]) {
    if (
      (!t.isVariableDeclaration(node) && !t.isClassDeclaration(node)) ||
      node.end == null
    )
      continue;

    const end = node.end;
    const current = nodes.indexOf(node);
    const before = nodes.findIndex(
      (candidate, index) =>
        index < current &&
        t.isExportNamedDeclaration(candidate) &&
        t.isVariableDeclaration(candidate.declaration) &&
        candidate.declaration.declarations.some(
          ({ init }) =>
            t.isCallExpression(init) && init.start != null && end <= init.start
        )
    );

    if (before < 0) continue;

    // A dependency first needed by a later call still observes the state
    // from its original declaration, before any intervening extraction call.
    nodes.splice(current, 1);
    nodes.splice(before, 0, node);
  }

  return nodes.map((node) => {
    const clone = t.cloneNode(node, true);
    return rename(node, clone) as t.Statement;
  });
}

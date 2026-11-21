import {
  hasCapturedPatternOwner,
  isIgnoredExtractionCall,
  requireExtractionPublication,
  requiresExtractionPublication
} from "./extractionPublication.js";
import { getModuleReference } from "../commonjs/bindings.js";
import { proveEvaluationOrder } from "../extractionCalls/evaluation.js";
import {
  builtInExtractionCalls,
  isBuiltInExtractionCall
} from "../extractionCalls/builtins.js";
import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import {
  createReplayAnalysis,
  type ReplayAnalysis
} from "../extractionCalls/replayAnalysis.js";
import type { ProgramScope } from "../types.js";
import { isSupportedStaticCssPrimitiveLiteral } from "../staticCssEval/sameFile/primitives.js";

interface ExtractionBindings {
  completed: Set<t.Node>;
  names: Map<Binding, string>;
  owners: Map<string, Binding>;
  references: WeakMap<t.Identifier, Binding>;
  extractedReferences: WeakSet<t.Node>;
  executedBranches: WeakMap<t.Node, readonly string[]>;
  selectedRoots: WeakSet<t.VariableDeclaration>;
  selfInitializers: WeakMap<t.VariableDeclarator, t.VariableDeclaration>;
  initializerDependencies: WeakMap<t.VariableDeclarator, t.VariableDeclarator>;
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
      executedBranches: new WeakMap(),
      selectedRoots: new WeakSet(),
      selfInitializers: new WeakMap(),
      initializerDependencies: new WeakMap()
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

/** A compound top-level CommonJS binding does not own its unrelated siblings. */
function isCompoundBuiltinCommonJs(path: NodePath<t.Node>): boolean {
  return (
    path.isVariableDeclaration() &&
    path.parentPath.isProgram() &&
    path.node.declarations.length > 1 &&
    path.get("declarations").some((declaration) => {
      const initializer = declaration.get("init");
      if (!initializer.isExpression()) return false;
      const reference = getModuleReference(initializer);
      return (
        reference?.kind === "require" &&
        !reference.unsafe &&
        Object.hasOwn(builtInExtractionCalls, reference.source)
      );
    })
  );
}

function isPrimitiveLiteral(node: t.Node): boolean {
  return (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node)
  );
}

/**
 * After an owned literal is allocated, its immediately following initializer
 * may set an existing own data field that the sidecar must see. Other sibling
 * initializers are not dependencies merely because they share the statement.
 */
function adjacentOwnDataWrite(
  binding: Binding,
  root: NodePath<t.Node>
): Binding | undefined {
  if (
    !binding.constant ||
    !binding.path.isVariableDeclarator() ||
    !t.isIdentifier(binding.path.node.id) ||
    !root.isVariableDeclaration({ kind: "const" }) ||
    !isCompoundBuiltinCommonJs(root)
  )
    return;
  const paths = root.get("declarations");
  const index = paths.findIndex(({ node }) => node === binding.path.node);
  const sibling = index >= 0 ? paths[index + 1] : undefined;
  const declared = sibling?.get("id");
  const write = sibling?.get("init");
  const original = binding.path.node.init;
  if (
    !declared?.isIdentifier() ||
    !write?.isAssignmentExpression({ operator: "=" }) ||
    !isPrimitiveLiteral(write.node.right) ||
    !t.isObjectExpression(original)
  )
    return;
  const left = write.get("left");
  if (!left.isMemberExpression() || left.node.computed) return;
  const source = left.get("object");
  const field = left.node.property;
  if (
    !source.isIdentifier() ||
    source.scope.getBinding(source.node.name) !== binding ||
    !t.isIdentifier(field) ||
    field.name === "__proto__" ||
    !original.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        t.isIdentifier(property.key) &&
        property.key.name !== "__proto__" &&
        isPrimitiveLiteral(property.value)
    ) ||
    !original.properties.some(
      (property) =>
        t.isObjectProperty(property) &&
        t.isIdentifier(property.key, { name: field.name })
    )
  )
    return;
  const written = declared.scope.getBinding(declared.node.name);
  return written?.path.node === sibling?.node ? written : undefined;
}

/** A closed eager initializer does not own separately created closures. */
function isCompoundWithDeferredSiblings(path: NodePath<t.VariableDeclaration>) {
  if (path.node.kind !== "const" || path.node.declarations.length < 2)
    return false;
  let eager = 0;
  for (const declaration of path.get("declarations")) {
    if (!declaration.get("id").isIdentifier()) return false;
    const initializer = declaration.get("init");
    if (
      initializer.isFunctionExpression() ||
      initializer.isArrowFunctionExpression()
    )
      continue;
    if (
      ++eager > 1 ||
      !initializer.isExpression() ||
      proveEvaluationOrder(
        initializer,
        { replay: () => "unknown", binding: () => "unknown" },
        false
      ) !== "proven"
    )
      return false;
  }
  return eager === 1;
}

function capturesSelectedDeclarators(
  program: ProgramScope,
  path: NodePath<t.Node>
): boolean {
  return (
    path.isVariableDeclaration() &&
    (getState(program).selectedRoots.has(path.node) ||
      hasCapturedPatternOwner(program, path.node) ||
      isCompoundBuiltinCommonJs(path) ||
      isCompoundWithDeferredSiblings(path))
  );
}

function isInside(path: NodePath<t.Node>, root: NodePath<t.Node>): boolean {
  return path === root || Boolean(path.findParent((parent) => parent === root));
}

/** One closed const captured exclusively by a later stock CSS call. */
function isClosedOnlyCssBinding(
  declaration: NodePath<t.Node>,
  use: NodePath<t.Node>,
  binding: Binding
): boolean {
  if (
    !declaration.isVariableDeclaration({ kind: "const" }) ||
    declaration.node.declarations.length !== 1 ||
    !binding.constant ||
    !binding.path.isVariableDeclarator() ||
    !binding.path.get("id").isIdentifier() ||
    !use.isCallExpression() ||
    !isBuiltInExtractionCall(use.get("callee")) ||
    use.getFunctionParent() !== declaration.getFunctionParent() ||
    binding.referencePaths.some((reference) => !isInside(reference, use))
  )
    return false;
  const initializer = binding.path.get("init");
  return (
    initializer.isExpression() &&
    proveEvaluationOrder(
      initializer,
      { replay: () => "unknown", binding: () => "unknown" },
      false
    ) === "proven"
  );
}

function isEarlierStaticBlockBinding(
  declaration: NodePath<t.Node>,
  use: NodePath<t.Node>,
  block: NodePath<t.StaticBlock>,
  binding: Binding
): boolean {
  const statement = use.getStatementParent();
  return (
    statement?.parentPath === block &&
    statement.isExpressionStatement() &&
    typeof statement.key === "number" &&
    typeof declaration.key === "number" &&
    declaration.key < statement.key &&
    isClosedOnlyCssBinding(declaration, use, binding)
  );
}

function isClosedSwitchFallthrough(
  declaration: NodePath<t.Node>,
  use: NodePath<t.Node>,
  parent: NodePath<t.SwitchStatement>,
  selected: NodePath<t.Node>,
  binding: Binding
): boolean {
  const [first, next] = parent.get("cases");
  if (
    first?.node !== selected.node ||
    !next ||
    next.node.test != null ||
    first.node.consequent.length !== 1 ||
    first.node.consequent[0] !== declaration.node
  )
    return false;
  const statement = use.getStatementParent();
  const value = parent.get("discriminant");
  const test = first.get("test");
  // The first selected literal case has only this closed declaration, so
  // execution reaches the immediately following default without any jump.
  const exact =
    (value.isNumericLiteral() &&
      test.isNumericLiteral({ value: value.node.value })) ||
    (value.isStringLiteral() &&
      test.isStringLiteral({ value: value.node.value })) ||
    (value.isBooleanLiteral() &&
      test.isBooleanLiteral({ value: value.node.value })) ||
    (value.isNullLiteral() && test.isNullLiteral());
  return (
    exact &&
    statement?.parentPath === next &&
    statement.isExpressionStatement() &&
    next.node.consequent[0] === statement.node &&
    isClosedOnlyCssBinding(declaration, use, binding)
  );
}

/** A captured declaration must execute in the same enclosing branch as its use. */
function sharesExecutionContext(
  declaration: NodePath<t.Node>,
  use: NodePath<t.Node>,
  analysis: ReplayAnalysis,
  binding: Binding
): boolean {
  for (
    let child = declaration, parent = child.parentPath;
    parent;
    child = parent, parent = parent.parentPath
  ) {
    // A sole module-scoped var in a definitely selected literal branch
    // already has the surrounding Program's binding. No other statements
    // or predicate effects can be lost by selecting just that declaration.
    if (
      parent.isIfStatement() &&
      parent.parentPath?.isProgram() &&
      declaration.isVariableDeclaration({ kind: "var" }) &&
      declaration.node.declarations.length === 1 &&
      (child.node === declaration.node ||
        (child.isBlockStatement() &&
          child.node.body.length === 1 &&
          child.node.body[0] === declaration.node)) &&
      isSupportedStaticCssPrimitiveLiteral(parent.node.test) &&
      analysis.branches
        .plan(parent)
        .operands.some(
          (operand) =>
            operand.execution === "eager" && operand.path.node === child.node
        )
    )
      continue;
    if (
      parent.isStaticBlock() &&
      child === declaration &&
      isEarlierStaticBlockBinding(declaration, use, parent, binding)
    )
      continue;
    if (
      parent.isSwitchStatement() &&
      isClosedSwitchFallthrough(declaration, use, parent, child, binding)
    )
      continue;
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

export function isPublishedSidecarValue(
  program: ProgramScope,
  value: NodePath<t.Node>
): boolean {
  return (
    value.isIdentifier() &&
    [...program.minchoData.imports].some(
      ([name, identifier]) =>
        name.startsWith(`${program.minchoData.cssFile}:`) &&
        identifier === value.node
    )
  );
}

function canPublishCopiedBuiltIn(
  path: NodePath<t.Node>,
  call: NodePath<t.CallExpression>
): boolean {
  return (
    path.isCallExpression() &&
    isBuiltInExtractionCall(path.get("callee")) &&
    call.node.extra?.minchoEvaluationOwner !== "runtime" &&
    !isIgnoredExtractionCall(call) &&
    isBuiltInExtractionCall(call.get("callee"))
  );
}

export function planExtractionBindings(
  path: NodePath<t.Node>,
  completed: ReadonlySet<t.Node> = new Set(),
  analysis = createReplayAnalysis(path.scope)
) {
  const program = path.scope.getProgramParent() as ProgramScope;
  const visited = new Set<t.Node>();
  const requiredDeclarators = new Set<t.Node>();
  const declarations: Array<{ binding: Binding; root: NodePath<t.Node> }> = [];
  const bindings: Binding[] = [];
  const branches = new Map<t.Node, readonly string[]>();
  let runtimeBinding: Binding | undefined;
  const collect = (binding: Binding) => {
    const root = getRoot(binding.path);
    if (
      !root.isStatement() ||
      !sharesExecutionContext(root, path, analysis, binding) ||
      (binding.path.isVariableDeclarator() &&
        path.getFunctionParent() === binding.path.getFunctionParent() &&
        binding.path.node.end != null &&
        path.node.start != null &&
        binding.path.node.end > path.node.start)
    ) {
      runtimeBinding ??= binding;
      return;
    }
    requiredDeclarators.add(binding.path.node);
    const selected = capturesSelectedDeclarators(program, root);
    const visitKey = selected ? binding.path.node : root.node;
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
      t.getOuterBindingIdentifiers(selected ? binding.path.node : root.node)
    )) {
      const declared = root.scope.getBinding(identifier.name);

      if (declared && isInside(declared.path, root)) bindings.push(declared);
    }

    if (selected) {
      const write = adjacentOwnDataWrite(binding, root);
      if (write) collect(write);
    }

    visitExecutedReferences(
      selected ? binding.path : root,
      analysis,
      branches,
      (reference) => {
        const dependency = reference.scope.getBinding(reference.node.name);

        if (
          dependency &&
          !isInside(dependency.path, selected ? binding.path : root)
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
  const copiedSiblingEffects: NodePath<t.CallExpression>[] = [];
  const initializerDependencies = new Map<
    t.VariableDeclarator,
    t.VariableDeclarator
  >();
  for (const { root, binding } of declarations) {
    if (
      !root.isVariableDeclaration() ||
      root.node.declarations.length <= 1 ||
      capturesSelectedDeclarators(program, root)
    )
      continue;
    // Track the actual initialization boundary of each closed binding. An
    // output and its pure dependents start only after its materialized alias.
    const initialized = new Map<Binding, t.VariableDeclarator | undefined>();
    const { selfInitializers } = getState(program);
    const siblings = root.get("declarations");
    const positions = new Map(siblings.map(({ node }, index) => [node, index]));
    const earlierClosed = (
      reference: NodePath<t.Identifier>,
      local: Binding
    ) => {
      const owner = getRoot(local.path);
      return (
        owner.isVariableDeclaration({ kind: "const" }) &&
        owner.parentPath.isProgram() &&
        owner.parentPath === root.parentPath &&
        typeof owner.key === "number" &&
        typeof root.key === "number" &&
        owner.key < root.key &&
        (completed.has(owner.node) ||
          declarations.some(({ root }) => root.node === owner.node)) &&
        analysis.branches.proveBinding(
          reference,
          {
            replay: () => "unknown",
            binding: () => "unknown"
          },
          new Set(),
          true
        ) === "proven"
      );
    };
    for (const sibling of siblings) {
      const required = requiredDeclarators.has(sibling.node);
      const id = sibling.get("id");
      const initializer = sibling.get("init");
      if (!initializer.node) continue;
      let predecessor: t.VariableDeclarator | undefined;
      const prove = (value: NodePath<t.Node>) =>
        proveEvaluationOrder(
          value,
          {
            replay: () => "unknown",
            binding: (reference) => {
              const local = reference.scope.getBinding(reference.node.name);
              if (local && initialized.has(local)) {
                const after = initialized.get(local);
                if (
                  after &&
                  (!predecessor ||
                    positions.get(after)! > positions.get(predecessor)!)
                )
                  predecessor = after;
                return "proven";
              }
              return isPublishedSidecarValue(program, reference) ||
                (local && earlierClosed(reference, local))
                ? "proven"
                : "unknown";
            }
          },
          false
        ) === "proven";
      if (!id.isIdentifier()) {
        // A fresh literal's inert own reads are already certified by the
        // shared pattern replay checker; defaults/unknown operations aren't.
        if (
          !required &&
          !(
            id.isObjectPattern() &&
            initializer.isObjectExpression() &&
            prove(initializer) &&
            analysis.everyPattern(
              id,
              (path) => !path.node || (path.isExpression() && prove(path)),
              initializer.node
            ) &&
            !predecessor
          )
        )
          runtimeBinding ??= binding;
        continue;
      }
      const local = id.scope.getBinding(id.node.name);
      const ownBinding = local?.path.node === sibling.node ? local : undefined;
      if (initializer.node === path.node) {
        if (ownBinding) initialized.set(ownBinding, sibling.node);
        continue;
      }
      if (initializer.isExpression() && prove(initializer)) {
        const after = selfInitializers.has(sibling.node)
          ? sibling.node
          : predecessor;
        if (ownBinding) initialized.set(ownBinding, after);
        if (predecessor && after === predecessor)
          initializerDependencies.set(sibling.node, predecessor);
        continue;
      }
      if (required) continue;
      if (initializer.isCallExpression()) {
        copiedSiblingEffects.push(initializer);
        if (
          ownBinding &&
          (requiresExtractionPublication(program, initializer.node) ||
            canPublishCopiedBuiltIn(path, initializer))
        )
          initialized.set(ownBinding, sibling.node);
      } else runtimeBinding ??= binding;
    }
  }
  return {
    declarations,
    bindings,
    branches,
    runtimeBinding,
    copiedSiblingEffects,
    initializerDependencies
  };
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
  const program = path.scope.getProgramParent() as ProgramScope;
  const plan = planExtractionBindings(path, undefined, analysis);
  return (
    plan.runtimeBinding === undefined &&
    plan.copiedSiblingEffects.every((call) =>
      requiresExtractionPublication(program, call.node)
    )
  );
}

/** Collect declarations by lexical binding, retaining nested locals in their owner. */
export function collectExtractionBindings(path: NodePath<t.Node>): t.Node[] {
  const program = path.scope.getProgramParent() as ProgramScope;
  const state = getState(program);
  for (const binding of program.minchoData.bindings) {
    const root = getRoot(binding);
    state.completed.add(
      capturesSelectedDeclarators(program, root) ? binding.node : root.node
    );
  }
  const plan = planExtractionBindings(path, state.completed);
  if (plan.runtimeBinding)
    throw path.buildCodeFrameError(
      `Cannot extract a call that captures runtime binding ${plan.runtimeBinding.identifier.name}. Register the local factory with extractCalls or use mincho-js-ignore.`
    );

  const nextOutputs: NodePath<t.CallExpression>[] = [];
  const unownedSibling = plan.copiedSiblingEffects.find((call) => {
    if (requiresExtractionPublication(program, call.node)) return false;
    if (canPublishCopiedBuiltIn(path, call)) {
      nextOutputs.push(call);
      return false;
    }
    return true;
  });
  if (unownedSibling)
    throw unownedSibling.buildCodeFrameError(
      "Cannot extract a call that would repeat an unproved sibling initializer."
    );
  // Exact sibling nodes still have to pass their own ordinary lowering and
  // capture checks. The Program cannot publish if any obligation survives.
  for (const call of nextOutputs) requireExtractionPublication(call);
  for (const [dependent, predecessor] of plan.initializerDependencies)
    state.initializerDependencies.set(dependent, predecessor);

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
    if (capturesSelectedDeclarators(program, root)) {
      state.completed.add(binding.path.node);
      if (
        !program.minchoData.bindings.some(
          (path) => path.node === binding.path.node
        )
      )
        program.minchoData.bindings.push(binding.path);
    }
  }
  const published: t.Node[] = [];
  for (const { binding, root } of plan.declarations) {
    // All selected declarators are read at emission, even when a later
    // extraction first selected another sibling in a previously captured root.
    const selected = capturesSelectedDeclarators(program, root);
    if (selected && root.isVariableDeclaration())
      state.selectedRoots.add(root.node);
    if (!selected || !state.completed.has(root.node)) published.push(root.node);
    recordReferences(root, state);
    state.completed.add(root.node);
    if (!selected) program.minchoData.bindings.push(binding.path);
  }
  return published;
}

/** Place a copied output initializer after the alias it will read. */
export function recordExtractionInitializer(
  path: NodePath<t.CallExpression>,
  alias: t.VariableDeclaration
): void {
  const declarator = path.parentPath;
  const program = path.scope.getProgramParent() as ProgramScope;
  if (
    !declarator.isVariableDeclarator() ||
    !t.isIdentifier(declarator.node.id) ||
    declarator.node.init !== path.node ||
    !declarator.parentPath.isVariableDeclaration() ||
    declarator.parentPath.node.declarations.length < 2 ||
    capturesSelectedDeclarators(program, declarator.parentPath) ||
    !program.minchoData.nodes.includes(declarator.parentPath.node)
  )
    return;
  getState(program).selfInitializers.set(declarator.node, alias);
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

  const compoundDeclarations = new WeakSet<t.Node>();
  const afterAlias = new Map<t.VariableDeclaration, t.Statement[]>();
  const nodes = program.minchoData.nodes.flatMap((node) => {
    if (!t.isVariableDeclaration(node) || node.declarations.length === 1)
      return [node];

    const required = new Set(
      program.minchoData.bindings.map((binding) => binding.node)
    );
    const selected =
      hasCapturedPatternOwner(program, node) || state.selectedRoots.has(node);
    const declarations = selected
      ? node.declarations.filter((declaration) => required.has(declaration))
      : node.declarations;
    return declarations.flatMap((declaration) => {
      const statement = t.variableDeclaration(node.kind, [declaration]);

      statement.start = declaration.start;
      statement.end = declaration.end;
      if (selected) compoundDeclarations.add(statement);
      const predecessor = state.initializerDependencies.get(declaration);
      const alias = state.selfInitializers.get(predecessor ?? declaration);
      if (!alias) {
        if (predecessor)
          throw new Error("Missing predecessor of extraction initializer");
        return [statement];
      }
      const pending = afterAlias.get(alias) ?? [];
      pending.push(statement);
      afterAlias.set(alias, pending);
      return [];
    });
  });

  // The synthesized alias has no source position; relate it to the copied
  // authored initializer by node identity rather than comparing offsets.
  for (const [alias, statements] of afterAlias) {
    const position = nodes.indexOf(alias);
    if (position < 0) throw new Error("Missing extraction initializer alias");
    nodes.splice(position + 1, 0, ...statements);
  }

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
        ((compoundDeclarations.has(candidate) &&
          candidate.start != null &&
          end <= candidate.start) ||
          (t.isExportNamedDeclaration(candidate) &&
            t.isVariableDeclaration(candidate.declaration) &&
            candidate.declaration.declarations.some(
              ({ init }) =>
                t.isCallExpression(init) &&
                init.start != null &&
                end <= init.start
            )))
    );

    if (before < 0) continue;

    // A dependency first needed by a later call still observes the state
    // from its original declaration, before any intervening extraction call
    // or selected sibling that initializes later in source order.
    nodes.splice(current, 1);
    nodes.splice(before, 0, node);
  }

  return nodes.map((node) => {
    const clone = t.cloneNode(node, true);
    return rename(node, clone) as t.Statement;
  });
}

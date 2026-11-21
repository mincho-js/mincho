import { createReplayAnalysis, type ReplayAnalysis } from "./replayAnalysis.js";
import {
  capturedAuthoringOwner,
  type CapturedAuthoringOwner
} from "./capturedAuthoringOwner.js";
import {
  requireExtractionPublication,
  requireCapturedAuthoringOwner,
  isCommittedCapturedAuthoringOwner,
  isIgnoredExtractionCall
} from "../transforms/extractionPublication.js";
import { isRuntimeSourceReference } from "../optimizations/runtimeSourceReference.js";
import { sourceInvocationResultProof } from "./sourceInvocationResult.js";
import {
  isStaticCssEvalRequireCallExpression,
  getStaticCssEvalLiteralRequireImportPath
} from "../staticCssEval/cjsBindings.js";
import { type NodePath, types as t } from "@babel/core";
export { markBuildEvaluation } from "./evaluation.js";
import {
  getExtractionModuleReference,
  getModuleReference,
  type ModuleReference,
  type ExtractionReferenceRole
} from "../commonjs/bindings.js";
import type { PluginState, ProgramScope } from "../types.js";
import { proveAuthoringCallSite } from "./authoringCallSite.js";
import { analyzeExtractCalls } from "./analysis.js";
import { builtInExtractionCalls, isBuiltInExtractionCall } from "./builtins.js";
import {
  canonicalExtractCallsFile,
  runExtractCallsAnalysisSync
} from "./filesystem.js";
import type { ExtractCalls, PreparedExtractCalls } from "./types.js";
import { jsxCssPropExtractCalls } from "../jsxCssProp/options.js";
import { analyzeAliasedStaticCssEvalBindingMutation } from "../staticCssEval/sameFile/mutationAliases.js";
import { commonJsExports } from "../commonjs/modules.js";
import { getCjsAssignmentTarget } from "../staticCssEval/cjsExportTargets.js";
import { hasDynamicScope } from "../optimizations/dynamicScope.js";
import {
  hasExtractableBindings,
  isExtractedReference,
  isPublishedSidecarValue,
  planExtractionBindings
} from "../transforms/extractionBindings.js";
import type { Binding } from "@babel/traverse";
import {
  buildEvaluationOwner,
  type EvaluationProof,
  type EvaluationRequirements
} from "./evaluation.js";

export function prepareExtractCalls(
  path: NodePath<t.Program>,
  state: PluginState
): PreparedExtractCalls | undefined {
  if (state.opts.preparedExtractCalls) return state.opts.preparedExtractCalls;
  const extractCalls = jsxCssPropExtractCalls(
    state.opts.jsxCssProp,
    state.opts.extractCalls
  );
  if (extractCalls === undefined) return undefined;

  const root = state.file.opts.root ?? process.cwd();
  const filename = canonicalExtractCallsFile(
    state.file.opts.filename ?? `${root}/__mincho_owner__.ts`
  );

  return runExtractCallsAnalysisSync(
    analyzeExtractCalls({
      extractCalls,
      root,
      filename,
      source: state.file.code,
      program: path,
      parserPlugins: state.file.opts.parserOpts?.plugins
    })
  );
}

function isLocalExtractionBinding(callee: NodePath<t.Node>): boolean {
  const program = callee.scope.getProgramParent() as ProgramScope;
  const config = program.minchoData?.extractCalls;

  if (
    callee.isIdentifier() &&
    config?.localBindings.includes(callee.node.name)
  ) {
    const binding = callee.scope.getBinding(callee.node.name);

    if (binding && binding === program.getBinding(callee.node.name))
      return true;
  }
  return false;
}

function localProviderBinding(callee: NodePath<t.Node>): Binding | undefined {
  if (!callee.isIdentifier()) return;
  let binding = callee.scope.getBinding(callee.node.name);
  const seen = new Set<Binding>();
  while (binding?.constant && !seen.has(binding)) {
    seen.add(binding);
    if (
      !binding.path.isVariableDeclarator() ||
      !binding.path.get("id").isIdentifier({ name: binding.identifier.name })
    )
      break;
    const init = binding.path.get("init");
    if (!init.isIdentifier()) break;
    const dependency = init.scope.getBinding(init.node.name);
    if (!dependency) break;
    binding = dependency;
  }
  return binding;
}

function localInvocationsShareState(binding: Binding): boolean {
  const implementation = binding.path.isVariableDeclarator()
    ? binding.path.get("init")
    : binding.path;
  if (!implementation.isFunction()) return true;

  let shared = false;
  implementation.traverse({
    TSType(path) {
      path.skip();
    },
    ReferencedIdentifier(path) {
      // Intrinsic CSS APIs already execute in the build phase. Other captured
      // values can carry provider state between otherwise unrelated calls.
      if (isBuiltInExtractionCall(path)) return;
      const dependency = path.scope.getBinding(path.node.name);
      if (
        !dependency ||
        (dependency.path !== implementation &&
          !dependency.path.findParent((parent) => parent === implementation))
      )
        shared = true;
    },
    "ThisExpression|Super"() {
      shared = true;
    }
  });
  return shared;
}

function matchingExtractionExports(
  callee: NodePath<t.Node>,
  registrations?: ExtractCalls
) {
  const config = (callee.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  const reference = getModuleReference(callee);
  if ((!config && !registrations) || !reference) return [];

  return Object.entries(
    registrations ??
      (reference.kind === "require"
        ? (config!.requires ?? config!.imports)
        : config!.imports)
  ).flatMap(([source, names]) =>
    names
      .filter((name) => matchesExtractionExport(reference, source, name))
      .map((name) => ({ source, name }))
  );
}

/** Registration is a potential authoring effect, not a safety certificate. */
export function isRegisteredExtractionReference(
  callee: NodePath<t.Node>
): boolean {
  return (
    isBuiltInExtractionCall(callee, false) ||
    matchingExtractionExports(callee, builtInExtractionCalls).length > 0 ||
    isLocalExtractionBinding(callee) ||
    matchingExtractionExports(callee).length > 0
  );
}

/**
 * A lowerer may capture a callable while retaining its invocation at runtime.
 * Babel preserves `extra` in cloneNode, unlike node-identity-only ownership.
 */
export function retainRuntimeInvocation(call: t.CallExpression): void {
  call.extra = { ...call.extra, minchoEvaluationOwner: "runtime" };
}

function isRuntimeInvocation(callee: NodePath<t.Node>): boolean {
  const call = callee.parentPath;
  return (
    !!call?.isCallExpression() &&
    call.node.callee === callee.node &&
    call.node.extra?.minchoEvaluationOwner === "runtime"
  );
}

/**
 * Prove capture of a selected imported API endpoint under the existing
 * reference/namespace contract. Invocation and arguments stay in place;
 * selection does not establish a readonly consumer or general purity.
 */
export function canCaptureExtractionCallable(
  callee: NodePath<t.Node>
): boolean {
  // Builtins are the existing selected compiler API contract, not arbitrary
  // registered functions. Local bindings have no complete capture proof:
  // binding.constant alone does not rule out function property/alias effects.
  if (isBuiltInExtractionCall(callee, false)) return true;
  if (isLocalExtractionBinding(callee)) return false;

  return matchingExtractionExports(callee).some(({ source, name }) =>
    referencesExtractionExport(callee, source, name, false, "callable")
  );
}

/**
 * Check registered invocation/reference/evaluation obligations. Dependency
 * collection must still prove that captured bindings can move to the sidecar.
 */
export function isExtractionCall(
  callee: NodePath<t.Node>,
  strict = true
): boolean {
  if (isRuntimeInvocation(callee)) return false;
  if (isBuiltInExtractionCall(callee, strict)) return true;
  if (isLocalExtractionBinding(callee))
    return proveExtractionReference(callee, strict, "invocation");

  return matchingExtractionExports(callee).some(({ source, name }) =>
    referencesExtractionExport(callee, source, name, strict, "invocation")
  );
}

function collectArgumentEvaluation(
  argument: NodePath<t.Node>,
  analysis: ReplayAnalysis,
  isPublishedSidecarRead: (value: NodePath<t.Node>) => boolean,
  capturedBindings?: ReadonlySet<Binding>,
  ownsPatternRead?: (binding: Binding) => boolean
): {
  values: NodePath<t.Node>[];
  unknown: NodePath<t.Node>[];
  selectedBranches: Map<t.Node, NodePath<t.Expression>>;
  ownedCalls: Set<t.CallExpression>;
} {
  const values: NodePath<t.Node>[] = [];
  const unknown: NodePath<t.Node>[] = [];
  const selectedBranches = new Map<t.Node, NodePath<t.Expression>>();
  const ownedCalls = new Set<t.CallExpression>();
  const seen = new Map<t.Node, boolean>();
  const visit = (value: NodePath<t.Node>, owned: boolean) => {
    if (!value.node || seen.get(value.node) || (seen.has(value.node) && !owned))
      return;
    const firstVisit = !seen.has(value.node);
    seen.set(value.node, owned);
    if (firstVisit) values.push(value);
    // The exact generated import reads an output already owned by this sidecar.
    // Its CommonJS projection belongs to runtime, not to the replay of the read.
    if (isPublishedSidecarRead(value)) return;
    const plan = analysis.branches.plan(value);
    if (firstVisit && plan.kind === "unknown") unknown.push(value);
    if (owned && value.isCallExpression()) ownedCalls.add(value.node);
    if (plan.selectedBranches)
      selectedBranches.set(
        value.node,
        plan.selectedBranches[plan.selectedBranches.length - 1]!
      );

    if (value.isIdentifier()) {
      const binding = value.scope.getBinding(value.node.name);
      if (binding?.path.isVariableDeclarator()) {
        const initializer = binding.path.get("init");
        if (initializer.isExpression())
          visit(initializer, capturedBindings?.has(binding) ?? false);
        if (
          !analysis.everyPattern(
            binding.path.get("id"),
            (expression) => {
              if (expression.node) visit(expression as NodePath<t.Node>, false);
              return true;
            },
            binding.path.node.init,
            undefined,
            {
              nativeArrayIteration: true,
              canReplayOwnRead: (source) =>
                source === initializer.node && !!ownsPatternRead?.(binding),
              canReplayIteration: (source) =>
                source === initializer.node && !!ownsPatternRead?.(binding)
            }
          )
        )
          unknown.push(binding.path);
      } else if (
        binding &&
        binding.kind !== "module" &&
        binding.kind !== "param" &&
        !binding.path.isIdentifier()
      ) {
        // Unknown declaration forms still expose their dependencies and make
        // the result unproven; they are not silently treated as owner-free.
        visit(binding.path, false);
      }
    }

    for (const operand of plan.operands) {
      // A resolved imported member already names its exact owner. Its whole
      // namespace is not an additional consumer of a leaf-function argument.
      if (operand.use === "receiver" && getModuleReference(value)) continue;
      visit(operand.path, owned && operand.execution === "eager");
    }
    // Deferred bodies remain dependencies, not eager evaluations. Initializers
    // are owned only when the sidecar's binding plan includes their declaration.
    for (const capture of plan.captures) visit(capture, false);
  };
  visit(argument, true);
  return { values, unknown, selectedBranches, ownedCalls };
}

function isUnconditionalModuleCall(
  callee: NodePath<t.Node>,
  analysis: ReplayAnalysis,
  replay: (value: NodePath<t.Node>) => EvaluationProof,
  sharedValue: (value: NodePath<t.Node>) => EvaluationProof,
  reference: NonNullable<EvaluationRequirements["reference"]>
): boolean {
  const invocation = callee.parentPath;
  if (
    invocation?.isCallExpression() &&
    invocation.node.callee === callee.node &&
    invocation.node.extra?.minchoEvaluationOwner === "build"
  )
    // JSX has already selected this complete expression for compilation.
    // Its component's runtime placement is not the operation's build phase;
    // captured bindings must still pass the actual sidecar capture plan.
    return hasExtractableBindings(invocation, analysis);
  const enclosing = callee.parentPath?.findParent(
    (parent) =>
      parent.isFunction() ||
      (parent.isCallExpression() && replay(parent) !== "unknown")
  );
  let insideReplayedCall = enclosing?.isCallExpression() === true;
  const bindingValues = new Set<t.Node>();
  const requirements: EvaluationRequirements = {
    replay,
    sharedValue,
    reference,
    primitiveBinding(identifier) {
      return analysis.branches.proveBinding(
        identifier,
        requirements,
        bindingValues,
        true
      );
    },
    binding(identifier: NodePath<t.Identifier>): EvaluationProof {
      return analysis.branches.proveBinding(
        identifier,
        requirements,
        bindingValues
      );
    }
  };

  for (let child = callee.parentPath; child; child = child.parentPath) {
    const parent = child.parentPath;
    if (!parent) return false;
    if (parent.isProgram()) return true;
    if (child === enclosing) insideReplayedCall = false;

    // Statement/declaration order is retained by extractionBindings. All
    // expression execution and preceding observations come from the same plan.
    if (
      parent.isExpressionStatement() ||
      parent.isVariableDeclaration() ||
      parent.isExportNamedDeclaration() ||
      parent.isExportDefaultDeclaration() ||
      (parent.isVariableDeclarator() && child.key === "init")
    )
      continue;

    const plan = analysis.branches.plan(parent);
    if (plan.kind === "unknown") return false;
    const stepIndex = plan.steps.findIndex(
      (step) => step.kind === "evaluate" && step.operand.path === child
    );
    const step = plan.steps[stepIndex];
    if (!step || step.kind !== "evaluate") return false;

    if (step.operand.execution !== "eager") return false;
    if (
      !insideReplayedCall &&
      analysis.branches.proveSteps(
        plan.steps.slice(0, stepIndex),
        requirements
      ) === "unknown"
    )
      return false;
  }
  return false;
}

function extractionExportMembers(target: ModuleReference, name: string) {
  return target.members.length === 1 && target.members[0] === name
    ? [name]
    : target.kind === "require" &&
        target.members.length === 0 &&
        name === "default"
      ? []
      : name.split(".");
}

function matchesExtractionExport(
  target: ModuleReference,
  source: string,
  name: string
): boolean {
  const members = extractionExportMembers(target, name);
  return (
    target.source === source &&
    target.members.length === members.length &&
    target.members.every(
      (member, index) => member === null || member === members[index]
    )
  );
}

/**
 * Export-only callbacks are deferred only across a closed initialization:
 * moving a call to a sidecar must not cross another dependency or observation
 * that can reenter the owner. The provider itself initializes before either
 * the original call or the sidecar call, including a provider-to-owner cycle.
 */
function hasClosedProviderInitialization(
  program: NodePath<t.Program>,
  source: string
): boolean {
  const expression = (path: NodePath<t.Node | null | undefined>): boolean => {
    if (path.isIdentifier())
      return (
        path.scope.getBinding(path.node.name) !== undefined ||
        ["undefined", "NaN", "Infinity"].includes(path.node.name)
      );
    if (
      path.isStringLiteral() ||
      path.isNumericLiteral() ||
      path.isBooleanLiteral() ||
      path.isNullLiteral() ||
      path.isFunctionExpression() ||
      path.isArrowFunctionExpression()
    )
      return true;
    if (path.isObjectExpression())
      return path
        .get("properties")
        .every((property) =>
          property.isObjectProperty() && !property.node.computed
            ? expression(property.get("value"))
            : false
        );
    if (path.isArrayExpression())
      return path
        .get("elements")
        .every((element) => (!element.node ? true : expression(element)));
    if (path.isCallExpression()) {
      const reference = getModuleReference(path.get("callee"));
      return (
        reference?.kind === "import" &&
        reference.source === source &&
        path.get("arguments").every(expression)
      );
    }
    return false;
  };
  const declaration = (path: NodePath<t.Node | null | undefined>): boolean => {
    if (path.isFunctionDeclaration()) return true;
    if (path.isVariableDeclaration())
      return path.get("declarations").every((item) => {
        const init = item.get("init");
        return (
          item.get("id").isIdentifier() && (!init.node || expression(init))
        );
      });
    return false;
  };
  return program.get("body").every((statement) => {
    if (statement.isImportDeclaration()) {
      if (statement.node.source.value === source) return true;
      // Previously proven calls have already moved to this same sidecar.
      if (
        statement.node.source.value ===
        (program.scope as ProgramScope).minchoData.cssFile
      )
        return true;
      // The compiler's own class merger has a fixed inert runtime contract;
      // do not infer that contract from a user import's spelling alone.
      const generatedCx = (
        program.scope as ProgramScope
      ).minchoData.imports?.get("@mincho-js/css/classname:cx");
      return (
        statement.node.source.value === "@mincho-js/css/classname" &&
        statement.node.specifiers.length === 1 &&
        generatedCx !== undefined &&
        statement.node.specifiers[0].local.name === generatedCx.name
      );
    }
    if (statement.isExportAllDeclaration())
      return statement.node.source.value === source;
    if (statement.isExportNamedDeclaration()) {
      if (statement.node.source) return statement.node.source.value === source;
      const value = statement.get("declaration");
      return !value.node || declaration(value);
    }
    if (statement.isExportDefaultDeclaration())
      return declaration(statement.get("declaration"));
    return declaration(statement);
  });
}

/** No executable local reference may invoke or expose this deferred function. */
function isDeferredProviderInvocation(call: NodePath<t.Node>): boolean {
  for (
    let fn = call.getFunctionParent();
    fn;
    fn = fn.parentPath?.getFunctionParent() ?? null
  ) {
    const declaration = fn.isFunctionDeclaration()
      ? fn
      : fn.parentPath?.isVariableDeclarator() && fn.key === "init"
        ? fn.parentPath
        : undefined;
    if (!declaration) continue;
    const id = declaration.get("id") as NodePath<t.Node>;
    if (!id.isIdentifier()) continue;
    const binding = declaration.scope.getBinding(id.node.name);
    if (!binding?.constant) continue;
    if (
      binding.referencePaths.every(
        (reference) =>
          reference.isExportNamedDeclaration() ||
          reference.parentPath?.isExportSpecifier() ||
          reference.findParent((parent) => parent === fn)
      )
    )
      return true;
  }
  return false;
}

type ExtractionProofIntent = "callable" | "invocation";

function referencesExtractionExport(
  callee: NodePath<t.Node>,
  source: string,
  name: string,
  strict: boolean,
  intent: ExtractionProofIntent
): boolean {
  return proveExtractionReference(callee, strict, intent, { source, name });
}

type ExtractionProofReference =
  | ModuleReference
  | {
      kind: "local";
      unsafe?: string;
    };

function proveExtractionReference(
  callee: NodePath<t.Node>,
  strict: boolean,
  intent: ExtractionProofIntent,
  registration?: { source: string; name: string }
): boolean {
  const { source, name } = registration ?? {};
  const analysis = createReplayAnalysis(callee.scope);
  // No AST edits occur during a proof. Reuse plain reference resolution within
  // this query; mutation-sensitive extraction proofs remain separate below.
  const references = new WeakMap<t.Node, ModuleReference | null>();
  const moduleReference = (path: NodePath<t.Node>) => {
    if (!references.has(path.node))
      references.set(path.node, getModuleReference(path));
    return references.get(path.node)!;
  };
  if (analysis.branches.isUnexecuted(callee)) return false;
  const target = moduleReference(callee);
  // Literal dotted exports and bare CommonJS defaults use the same safety
  // checks as nested paths. An undotted export can share a namespace too.
  if (registration) {
    if (
      !target ||
      !matchesExtractionExport(target, registration.source, registration.name)
    )
      return false;
  } else if (!isLocalExtractionBinding(callee)) return false;
  const members =
    target && registration
      ? extractionExportMembers(target, registration.name)
      : [];

  const config = (callee.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  const receiverOrigins = (reference: ModuleReference) => {
    const id = config?.resolvedSources?.[reference.kind][reference.source];
    const metadata = id ? config?.exportOrigins?.[id] : undefined;
    let receiver = reference.members.slice(0, -1);
    if (
      receiver[0] === "default" &&
      reference.interop &&
      (reference.interop === "node" || !metadata?.esModule)
    )
      receiver = receiver.slice(1);

    if (receiver.length === 0 || receiver.includes(null)) return [];

    return Object.entries(metadata?.exports ?? {}).flatMap(
      ([encoded, origin]) => {
        const prefix = JSON.parse(encoded) as string[];
        return prefix.every((member, index) => receiver[index] === member)
          ? [{ origin, members: receiver.slice(prefix.length) }]
          : [];
      }
    );
  };
  const selectedOrigins = target ? receiverOrigins(target) : [];
  const selectedModule = target
    ? config?.resolvedSources?.[target.kind][target.source]
    : undefined;
  const selectedKind = target?.kind;
  const selectedLocal = !registration
    ? localProviderBinding(callee)
    : undefined;
  const providerInvocations: NodePath<t.Node>[] = [];
  if (
    intent === "invocation" &&
    (selectedLocal
      ? localInvocationsShareState(selectedLocal)
      : members.length === 1)
  ) {
    const program = callee.scope.getProgramParent().path;
    const closedInitialization =
      program.isProgram() &&
      !hasDynamicScope(program) &&
      target?.kind === "import" &&
      source !== undefined &&
      hasClosedProviderInitialization(program, source);
    program.traverse({
      "CallExpression|OptionalCallExpression"(call) {
        if (analysis.branches.isUnexecuted(call)) return;
        const sibling = call.get("callee") as NodePath<t.Node>;
        if (sibling.node === callee.node) return;
        if (selectedLocal) {
          if (localProviderBinding(sibling) === selectedLocal)
            providerInvocations.push(sibling);
          return;
        }
        // A function boundary does not prove deferred execution: an IIFE,
        // locally invoked initializer, or synchronous callback can mutate the
        // provider before this call. Keep those uses in the invocation/order
        // proof rather than moving a later call ahead of unknown execution.
        if (closedInitialization && isDeferredProviderInvocation(call)) return;
        const reference = moduleReference(sibling);
        if (!reference || reference.members.length !== 1) return;
        const id = config?.resolvedSources?.[reference.kind][reference.source];
        const sameProvider =
          (selectedModule !== undefined && id === selectedModule) ||
          (selectedModule === undefined &&
            id === undefined &&
            reference.kind === selectedKind &&
            reference.source === source);
        if (sameProvider) providerInvocations.push(sibling);
      }
    });
  }
  // Provenance only. Module exports may alias through reexports, mixed ESM/CJS
  // access, or repeated loads, so use one conservative identity, not fresh calls.
  const moduleOriginIdentity = {};
  const validatedModuleCalls = new Set<t.CallExpression>();
  const groupModuleCalls = new Map<
    t.CallExpression,
    NodePath<t.CallExpression>
  >();
  let moduleOriginsComplete = true;
  const moduleProgram = callee.scope.getProgramParent().path;
  let loaderStable =
    moduleProgram.isProgram() && !hasDynamicScope(moduleProgram);
  callee.scope.getProgramParent().path.traverse({
    CallExpression(path) {
      if (!isStaticCssEvalRequireCallExpression(path.node, path.scope)) return;
      // Resolving a constant specifier is not permission to move its read
      // before initialization. Prove its actual evaluation before granting
      // either source-backed or registered-loader provenance.
      const visiting = new Set<t.Node>();
      const specifierRequirements: EvaluationRequirements = {
        replay: () => "unknown",
        primitiveBinding: (identifier) =>
          analysis.branches.proveBinding(
            identifier,
            specifierRequirements,
            visiting,
            true
          ),
        binding: (identifier) =>
          analysis.branches.proveBinding(
            identifier,
            specifierRequirements,
            visiting
          )
      };
      const specifier = path.get("arguments")[0];
      if (
        !specifier ||
        analysis.branches.proveStableValue(specifier, specifierRequirements) !==
          "proven"
      ) {
        moduleOriginsComplete = false;
        return;
      }
      const source = getStaticCssEvalLiteralRequireImportPath(
        path.node,
        path.scope
      );
      const id =
        source === null
          ? undefined
          : config?.resolvedSources?.require?.[source];
      if (id && config?.exportOrigins?.[id])
        validatedModuleCalls.add(path.node);
      else if (
        source !== null &&
        (config?.requires ?? config?.imports)?.[source]?.length
      )
        groupModuleCalls.set(path.node, path);
      else moduleOriginsComplete = false;
    },
    Identifier(path) {
      if (
        !isRuntimeSourceReference(path) ||
        path.scope.getBinding(path.node.name)
      )
        return;
      if (
        ["globalThis", "global", "window", "self"].includes(path.node.name) &&
        path.isReferencedIdentifier()
      )
        loaderStable = false;
      if (path.node.name !== "require") return;
      const parent = path.parentPath;
      const referenced = path.isReferencedIdentifier();
      const declared = path.isBindingIdentifier();
      if (
        (referenced || declared) &&
        !(parent.isCallExpression() && parent.node.callee === path.node)
      )
        loaderStable = false;
    }
  });
  if (groupModuleCalls.size && !loaderStable) moduleOriginsComplete = false;
  type SafetyCheck = {
    local: EvaluationProof;
    dependencies: Set<SafetyCheck>;
    dependents: Set<SafetyCheck>;
  };
  const pendingCheck = (): SafetyCheck => ({
    local: "pending",
    dependencies: new Set(),
    dependents: new Set()
  });
  const root = pendingCheck();
  let current = root;
  const requireCheck = (
    requirement: SafetyCheck,
    owner = current
  ): EvaluationProof => {
    owner.dependencies.add(requirement);
    requirement.dependents.add(owner);
    return requirement.local === "unknown"
      ? "unknown"
      : requirementsProven(requirement)
        ? "proven"
        : "pending";
  };
  // Local completion is not a replay proof while a reachable obligation is
  // pending. A cycle is proven only when every member has completed its work.
  const requirementsProven = (check: SafetyCheck): boolean => {
    const pending = [check];
    const seen = new Set<SafetyCheck>();
    while (pending.length) {
      const requirement = pending.pop()!;
      if (seen.has(requirement)) continue;
      seen.add(requirement);
      if (requirement.local !== "proven") return false;
      pending.push(...requirement.dependencies);
    }
    return true;
  };
  // A callable read cannot discharge invocation/argument obligations for the
  // same node. Namespace consumers always request the stronger proof below.
  const callableChecks = new Map<t.Node, SafetyCheck>();
  const invocationChecks = new Map<t.Node, SafetyCheck>();
  const groupModuleChecks = new Map<t.CallExpression, SafetyCheck>();
  const capturedOwnerCandidates = new Map<
    t.CallExpression,
    CapturedAuthoringOwner
  >();
  const publicationCandidates = new Map<
    t.CallExpression,
    NodePath<t.CallExpression>
  >();
  (intent === "callable" ? callableChecks : invocationChecks).set(
    callee.node,
    root
  );
  // A recursive query adds an obligation; it does not prove that obligation.
  // The root is accepted only after every reachable local check has completed.
  const orderChecks = new Map<t.Node, SafetyCheck>();
  const buildChecks = new Map<t.CallExpression, SafetyCheck>();
  const programScope = callee.scope.getProgramParent() as ProgramScope;
  const { cssFile } = programScope.minchoData;
  const isPublishedSidecarRead = (value: NodePath<t.Node>): boolean =>
    isPublishedSidecarValue(programScope, value);
  const isSharedValue = (value: NodePath<t.Node>): EvaluationProof =>
    value.isIdentifier() &&
    (isPublishedSidecarRead(value) ||
      moduleReference(value)?.source === cssFile)
      ? "proven"
      : "unknown";
  const isReplayedValue = (value: NodePath<t.Node>): EvaluationProof => {
    const reference = value.isCallExpression() ? value.get("callee") : value;
    const checked = invocationChecks.get(reference.node);
    if (checked) return requireCheck(checked);
    if (value.isCallExpression()) {
      if (!isRegisteredCall(reference)) return "unknown";
      const dependency = invocationChecks.get(reference.node);
      return dependency ? requireCheck(dependency) : "proven";
    }
    return isSharedValue(value);
  };
  let publicationReferences: Set<t.Node> | undefined;
  const referenceFormation = (path: NodePath<t.Node>): EvaluationProof => {
    if (!publicationReferences) {
      publicationReferences = new Set();
      const program = path.scope.getProgramParent().path;
      if (program.isProgram() && !hasDynamicScope(program)) {
        for (const entry of commonJsExports(program, "").exports.values()) {
          if (
            entry.kind !== "expression" ||
            !t.isExpressionStatement(entry.declaration)
          )
            continue;
          const assignment = entry.declaration.expression;
          if (
            !t.isAssignmentExpression(assignment, { operator: "=" }) ||
            entry.expression !== assignment.right
          )
            continue;
          const target = getCjsAssignmentTarget(assignment.left, program.scope);
          // The canonical collector proves this is the intact CJS exports
          // alias. Its direct slot reference does not read that slot. Nested
          // module.exports reads still need a separate getter/effect proof.
          if (target.kind === "property" && target.surface === "exports")
            publicationReferences.add(assignment.left);
        }
      }
    }
    return publicationReferences.has(path.node) ? "proven" : "unknown";
  };
  const argumentConsumers = new Set<t.Node>();
  let moduleSuspensions: Array<number | null | undefined> | undefined;

  const crossesModuleSuspension = (sibling: NodePath<t.Node>) => {
    if (!moduleSuspensions) {
      moduleSuspensions = [];

      const recordSuspension = (path: NodePath<t.Node>) => {
        for (let child = path; child.parentPath; child = child.parentPath) {
          const parent = child.parentPath;

          // Method keys run when their object/class is created. Function
          // bodies run later and do not suspend the surrounding module.
          if (
            parent.isFunction() &&
            !(
              child.key === "key" &&
              "computed" in parent.node &&
              parent.node.computed
            )
          )
            return;
        }

        // An enclosing await starts before its operand's callee. Its resume
        // boundary can still separate that call from a later provider call.
        // A for-await loop first resumes after evaluating its iterable, not
        // after its entire body has completed.
        moduleSuspensions!.push(
          path.node.start,
          path.isForOfStatement() ? path.node.right.end : path.node.end
        );
      };

      callee.scope.getProgramParent().path.traverse({
        AwaitExpression: recordSuspension,
        ForOfStatement(path) {
          if (path.node.await) recordSuspension(path);
        }
      });
    }

    const first = callee.node.start;
    const second = sibling.node.start;

    return moduleSuspensions.some(
      (position) =>
        position == null ||
        first == null ||
        second == null ||
        (Math.min(first, second) < position &&
          position < Math.max(first, second))
    );
  };

  const reject = (check: SafetyCheck) => {
    const pending = [check];

    while (pending.length) {
      const unsafe = pending.pop()!;
      if (unsafe.local === "unknown") continue;

      unsafe.local = "unknown";
      pending.push(...unsafe.dependents);
    }
  };

  const proveCandidate = (
    sibling: NodePath<t.Node>,
    proofIntent: ExtractionProofIntent,
    callOrder?: SafetyCheck
  ): boolean => {
    // Cache only within this analysis: extraction can change the AST before
    // the next call. A cycle is provisional until all its dependencies pass.
    const checks =
      proofIntent === "callable" ? callableChecks : invocationChecks;
    const previous = checks.get(sibling.node);
    if (previous) {
      requireCheck(previous);
      if (callOrder) requireCheck(callOrder, previous);
      return previous.local !== "unknown";
    }

    const check = pendingCheck();
    requireCheck(check);
    checks.set(sibling.node, check);
    if (callOrder) requireCheck(callOrder, check);
    const parent = current;
    current = check;

    try {
      // A CommonJS namespace's broad unsafe result may concern another export.
      // Decide safety only after checking this candidate's exact member path.
      const candidate =
        proofIntent === "callable"
          ? getSafeReference(sibling, "callable")
          : getCallReference(sibling);

      if (candidate && !candidate.unsafe && check.local !== "unknown")
        check.local = "proven";
      else reject(check);

      return check.local !== "unknown";
    } finally {
      current = parent;
    }
  };

  const isRegisteredCall = (
    sibling: NodePath<t.Node>,
    role: ExtractionReferenceRole = "callee",
    capturedFunctions?: ReadonlySet<t.Node>,
    ownedCalls?: ReadonlySet<t.CallExpression>,
    requestedIntent: ExtractionProofIntent = "invocation"
  ): boolean => {
    const target = moduleReference(sibling);
    const siblingModule = target
      ? config?.resolvedSources?.[target.kind][target.source]
      : undefined;
    const sameEndpoint =
      sibling.node === callee.node ||
      (target !== null &&
        target.members.length === members.length &&
        target.members.every((member, index) => member === members[index]) &&
        ((selectedModule !== undefined && siblingModule === selectedModule) ||
          (sibling.isIdentifier() &&
            callee.isIdentifier() &&
            sibling.scope.getBinding(sibling.node.name) !== undefined &&
            sibling.scope.getBinding(sibling.node.name) ===
              callee.scope.getBinding(callee.node.name))));
    // A callable can reach the selected owner through unknown contents or
    // captures even when it receives no owner argument. Observing the exact
    // selected endpoint still asks the candidate's proof question; it does
    // not turn a callable capture into movement of that invocation.
    const invokesTrackedOwner =
      role === "consumer" ||
      (role === "invocation" &&
        (!sameEndpoint || requestedIntent === "invocation"));
    // A call being checked must not become its own unsafe consumer through
    // recursive checks of a registered function passed as an argument.
    if (role === "consumer" && argumentConsumers.has(sibling.node)) {
      const consumer = invocationChecks.get(sibling.node);
      return consumer !== undefined && requireCheck(consumer) !== "unknown";
    }

    // Ignored calls stay at runtime and may mutate the shared namespace.
    const call = sibling.parentPath;
    if (call?.isCallExpression() && isIgnoredExtractionCall(call)) return false;

    if (
      (invokesTrackedOwner || requestedIntent === "invocation") &&
      isRuntimeInvocation(sibling)
    )
      return false;

    const buildOwner =
      role === "build" &&
      call?.isCallExpression() &&
      call.node.extra?.minchoEvaluationOwner === "build"
        ? call
        : buildEvaluationOwner(sibling);
    if (buildOwner) {
      let check = buildChecks.get(buildOwner.node);
      if (check) {
        requireCheck(check);
        return check.local !== "unknown";
      }
      check = pendingCheck();
      buildChecks.set(buildOwner.node, check);
      requireCheck(check);
      const parent = current;
      current = check;
      try {
        // This is a dependency on the actual compiler-selected owner, not a
        // registration or purity fact for its nested calls. Use the same
        // capture plan that the eventual sidecar collector must commit.
        if (
          target?.unsafe ||
          isInsideExtractCallsImplementation(buildOwner) ||
          !hasExtractableBindings(buildOwner) ||
          !isRegisteredCall(buildOwner.get("callee"))
        )
          reject(check);
        else if (check.local !== "unknown") check.local = "proven";
        return check.local !== "unknown";
      } finally {
        current = parent;
      }
    }

    if (isBuiltInExtractionCall(sibling, false)) return true;

    const local = isLocalExtractionBinding(sibling);
    if (!config || (!local && (!target || target.members.includes(null))))
      return false;

    const receiver = members.slice(0, -1);
    const siblingReceiver = target?.members.slice(0, -1) ?? [];
    const sharesReceiver =
      target !== null &&
      ((receiver.length > 0 &&
        receiver.every((member, index) => target.members[index] === member)) ||
        (siblingReceiver.length > 0 &&
          siblingReceiver.every(
            (member, index) => members[index] === member
          )) ||
        // Renamed barrel exports retain the original receiver's execution order.
        receiverOrigins(target).some((sibling) =>
          selectedOrigins.some(
            (selected) =>
              selected.origin === sibling.origin &&
              (selected.members.every(
                (member, index) => sibling.members[index] === member
              ) ||
                sibling.members.every(
                  (member, index) => selected.members[index] === member
                ))
          )
        ));
    const proofIntent =
      invokesTrackedOwner || (sharesReceiver && sibling.node !== callee.node)
        ? "invocation"
        : requestedIntent;
    if (proofIntent === "invocation" && isRuntimeInvocation(sibling))
      return false;
    const consumesNamespace =
      proofIntent === "invocation" &&
      call?.isCallExpression() &&
      call
        .get("arguments")
        .flatMap(
          (argument) =>
            collectArgumentEvaluation(
              argument,
              analysis,
              isPublishedSidecarRead
            ).values
        )
        .some((argument) => {
          const reference = moduleReference(argument);
          if (!reference) return false;

          const exports =
            reference.kind === "require"
              ? (config.requires ?? config.imports)
              : config.imports;

          return exports[reference.source]?.some((name) => {
            const receiver = name.split(".").slice(0, -1);
            return (
              reference.members.length <= receiver.length &&
              reference.members.every(
                (member, index) => member === null || member === receiver[index]
              )
            );
          });
        });

    // Sharing a receiver can make call order observable. Distinct calls must
    // keep their unconditional module execution in the sidecar. Independent
    // and standalone component-local authoring stays valid. Check direct
    // consumers before extraction can detach their namespace references.
    let callOrder: SafetyCheck | undefined;
    if (
      invokesTrackedOwner ||
      consumesNamespace ||
      (proofIntent === "invocation" &&
        providerInvocations.some(
          (invocation) => invocation.node === sibling.node
        )) ||
      (sharesReceiver && sibling.node !== callee.node)
    ) {
      callOrder = orderChecks.get(sibling.node);
      if (callOrder) requireCheck(callOrder);
      else {
        callOrder = pendingCheck();
        requireCheck(callOrder);
        orderChecks.set(sibling.node, callOrder);
        const parent = current;
        current = callOrder;
        try {
          if (
            !isUnconditionalModuleCall(
              callee,
              analysis,
              isReplayedValue,
              isSharedValue,
              referenceFormation
            ) ||
            !isUnconditionalModuleCall(
              sibling,
              analysis,
              isReplayedValue,
              isSharedValue,
              referenceFormation
            ) ||
            crossesModuleSuspension(sibling)
          )
            reject(callOrder);
          else if (callOrder.local !== "unknown") callOrder.local = "proven";
        } finally {
          current = parent;
        }
      }
      if (callOrder.local === "unknown") return false;
    }

    // An eager argument call moves as part of its extraction root. This is an
    // execution-ownership fact, not an independent extraction or purity proof.
    // Other uses of the same binding must still pass their own safety checks.
    if (
      call?.isCallExpression() &&
      call.node.callee === sibling.node &&
      ownedCalls?.has(call.node) &&
      !target?.unsafe
    )
      return true;

    // A registered wrapper owns direct leaf calls inside its callback, not
    // consumers of captured values or namespace receiver calls.
    if (
      role === "callee" &&
      capturedFunctions &&
      sibling.isIdentifier() &&
      call?.isCallExpression() &&
      call.node.callee === sibling.node &&
      target?.members.length === 1 &&
      !target.unsafe &&
      sibling.findParent((parent) => capturedFunctions.has(parent.node))
    )
      return true;

    if (local) return proveCandidate(sibling, proofIntent, callOrder);
    if (!target) return false;

    const exports =
      target.kind === "require"
        ? (config.requires ?? config.imports)
        : config.imports;
    const exportName =
      target.kind === "require" && target.members.length === 0
        ? "default"
        : target.members.join(".");

    if (exports[target.source]?.includes(exportName) !== true) return false;

    return proveCandidate(sibling, proofIntent, callOrder);
  };
  const getSafeReference = (
    candidate: NodePath<t.Node>,
    candidateIntent: ExtractionProofIntent
  ): ExtractionProofReference | null => {
    if (analysis.branches.isUnexecuted(candidate)) return null;
    if (candidate.isIdentifier() && isLocalExtractionBinding(candidate)) {
      const binding = candidate.scope.getBinding(candidate.node.name);
      return binding?.constant ? { kind: "local" } : null;
    }
    return getExtractionModuleReference(candidate, (sibling, role) =>
      isRegisteredCall(
        sibling,
        role,
        undefined,
        undefined,
        sibling.node === candidate.node ? candidateIntent : "callable"
      )
    );
  };
  const getCallReference = (
    candidate: NodePath<t.Node>
  ): ExtractionProofReference | null => {
    if (
      isRuntimeInvocation(candidate) ||
      analysis.branches.isUnexecuted(candidate)
    )
      return null;
    // The root keeps its invocation/order obligations. Neighboring callee
    // uses need a safe reference, not permission to move their invocations;
    // consumer/shared-receiver uses still request the stronger proof.
    const reference = getSafeReference(candidate, "invocation");
    if (!reference || reference.unsafe) return reference;

    // Flat named exports can close over shared provider state without exposing
    // a receiver. A guarded sibling must not be replayed unconditionally before
    // this call; use the same invocation/order proof as namespace consumers.
    for (const sibling of providerInvocations) {
      if (
        sibling.node !== candidate.node &&
        !isRegisteredCall(sibling, "invocation")
      )
        return { ...reference, unsafe: "Unproven provider invocation order" };
    }

    const call = candidate.parentPath;
    if (!call?.isCallExpression()) return reference;

    argumentConsumers.add(candidate.node);
    try {
      const bindingPlan = planExtractionBindings(call, undefined, analysis);
      if (bindingPlan.runtimeBinding)
        return {
          ...reference,
          unsafe: `Runtime binding ${bindingPlan.runtimeBinding.identifier.name}`
        };
      const capturedBindings = new Set(bindingPlan.bindings);
      const bindingOwners = new Map<Binding, SafetyCheck>();
      const buildOnlyBinding = (binding: Binding): boolean => {
        const previous = bindingOwners.get(binding);
        if (previous) {
          requireCheck(previous);
          return previous.local !== "unknown";
        }
        const check = pendingCheck();
        bindingOwners.set(binding, check);
        requireCheck(check);
        const parent = current;
        current = check;
        try {
          const declaration = binding.path.isVariableDeclarator()
            ? binding.path.parentPath
            : binding.path;
          if (
            declaration.parentPath?.isExportDeclaration() ||
            !binding.referencePaths.every(buildOnlyUse)
          )
            reject(check);
          else if (check.local !== "unknown") check.local = "proven";
          return check.local !== "unknown";
        } finally {
          current = parent;
        }
      };
      const buildOnlyUse = (use: NodePath<t.Node>): boolean => {
        if (isExtractedReference(use)) return true;
        if (use === call || use.findParent((parent) => parent === call))
          return true;
        for (
          let owner: NodePath<t.Node> | null = use;
          owner;
          owner = owner.parentPath
        ) {
          if (owner.isCallExpression()) {
            const callee = owner.get("callee");
            if (isRegisteredExtractionReference(callee))
              return isRegisteredCall(callee, "consumer");
          }
          if (owner.isVariableDeclarator() || owner.isFunctionDeclaration()) {
            if (!owner.node.id) return false;
            const identifiers = t.getBindingIdentifiers(owner.node.id);
            return (
              Object.keys(identifiers).length > 0 &&
              Object.keys(identifiers).every((name) => {
                const alias = owner.scope.getBinding(name);
                return alias !== undefined && buildOnlyBinding(alias);
              })
            );
          }
        }
        return false;
      };
      const argumentsEvaluation = call.get("arguments").map((argument) =>
        collectArgumentEvaluation(
          argument,
          analysis,
          isPublishedSidecarRead,
          capturedBindings,
          (binding) =>
            capturedBindings.has(binding) &&
            binding.path.isVariableDeclarator() &&
            Object.keys(t.getBindingIdentifiers(binding.path.node.id)).every(
              (name) => {
                const sibling = binding.scope.getBinding(name);
                return (
                  !!sibling &&
                  sibling.path.node === binding.path.node &&
                  buildOnlyBinding(sibling)
                );
              }
            )
        )
      );
      const ownedCalls = new Set(
        argumentsEvaluation.flatMap((argument) => [...argument.ownedCalls])
      );
      // This token exists only for this replay proof. Opaque producers in the
      // same group can share any result; none receives a fresh identity.
      const replayGroupIdentity = {};
      // A runtime observation boundary conditional on enforced publication,
      // not physical freshness. Artifacts may share hidden runtime state. This
      // token never escapes this proof context into general mutation analysis.
      const runtimeArtifactIdentity = {};
      const hasBuildConsumer = (
        output: Binding,
        seen = new Set<Binding>()
      ): boolean => {
        if (seen.has(output)) return false;
        const next = new Set(seen).add(output);
        return output.referencePaths.some((reference) => {
          for (
            let owner: NodePath<t.Node> | null = reference.parentPath;
            owner;
            owner = owner.parentPath
          ) {
            if (
              owner.isCallExpression() &&
              (!owner.getFunctionParent() || buildEvaluationOwner(owner)) &&
              !isRuntimeInvocation(owner.get("callee")) &&
              isRegisteredExtractionReference(owner.get("callee"))
            )
              return true;
            if (owner.isVariableDeclarator() || owner.isFunctionDeclaration()) {
              if (!owner.node.id || !t.isIdentifier(owner.node.id)) return true;
              const alias = owner.scope.getBinding(owner.node.id.name);
              return alias !== undefined && hasBuildConsumer(alias, next);
            }
          }
          return false;
        });
      };
      const proveTerminalPublication = (
        producer: NodePath<t.CallExpression>
      ): boolean => {
        const declaration = producer.parentPath;
        if (
          !declaration.isVariableDeclarator() ||
          declaration.node.init !== producer.node ||
          !t.isIdentifier(declaration.node.id) ||
          producer.getFunctionParent()
        )
          return false;
        const output = declaration.scope.getBinding(declaration.node.id.name);
        if (
          !output?.constant ||
          hasBuildConsumer(output) ||
          isInsideExtractCallsImplementation(producer) ||
          isIgnoredExtractionCall(producer) ||
          !hasExtractableBindings(producer, analysis) ||
          isReplayedValue(producer) === "unknown"
        )
          return false;
        publicationCandidates.set(producer.node, producer);
        return true;
      };
      for (const sibling of bindingPlan.copiedSiblingEffects) {
        // The binding emitter would copy this complete declaration. Only an
        // existing terminal publication proof may transfer the extra effect.
        if (
          !isRegisteredExtractionReference(sibling.get("callee")) ||
          !proveTerminalPublication(sibling)
        )
          return {
            ...reference,
            unsafe: "Unproven copied sibling initializer"
          };
      }
      const hasEagerGroupUses = (
        output: Binding,
        seen = new Set<Binding>()
      ): boolean => {
        if (seen.has(output)) return true;
        const next = new Set(seen).add(output);
        return output.referencePaths.every((reference) => {
          for (
            let owner: NodePath<t.Node> | null = reference.parentPath;
            owner;
            owner = owner.parentPath
          ) {
            if (
              owner.isFunction() ||
              owner.isAssignmentPattern() ||
              owner.isAwaitExpression() ||
              owner.isYieldExpression()
            )
              return false;
            if (owner.isCallExpression())
              return (
                (!owner.getFunctionParent() ||
                  buildEvaluationOwner(owner) !== undefined) &&
                !isRuntimeInvocation(owner.get("callee")) &&
                isRegisteredExtractionReference(owner.get("callee"))
              );
            if (owner.isVariableDeclarator()) {
              if (!t.isIdentifier(owner.node.id)) return false;
              const alias = owner.scope.getBinding(owner.node.id.name);
              return alias !== undefined && hasEagerGroupUses(alias, next);
            }
            if (owner.isStatement()) return false;
          }
          return false;
        });
      };
      const groupOwnsResult = (
        producer: NodePath<t.CallExpression>
      ): boolean => {
        for (
          let owner: NodePath<t.Node> | null = producer.parentPath;
          owner;
          owner = owner.parentPath
        ) {
          if (
            owner.isFunction() ||
            owner.isAssignmentExpression() ||
            owner.isAssignmentPattern() ||
            owner.isAwaitExpression() ||
            owner.isYieldExpression()
          )
            return false;
          if (owner.isVariableDeclarator()) {
            if (!t.isIdentifier(owner.node.id)) return false;
            const output = owner.scope.getBinding(owner.node.id.name);
            if (!output || !hasEagerGroupUses(output)) return false;
            const captured =
              capturedBindings.has(output) ||
              output.referencePaths.some((reference) => {
                const consumer = reference.findParent((path) =>
                  path.isCallExpression()
                );
                return (
                  consumer?.isCallExpression() &&
                  isRegisteredExtractionReference(consumer.get("callee")) &&
                  planExtractionBindings(
                    consumer,
                    undefined,
                    analysis
                  ).bindings.includes(output)
                );
              });
            return captured && buildOnlyBinding(output);
          }
          if (owner.isCallExpression())
            return (
              isRegisteredExtractionReference(owner.get("callee")) &&
              isReplayedValue(owner) !== "unknown"
            );
          if (owner.isExpressionStatement())
            return owner.node.expression === producer.node;
          if (owner.isStatement()) return false;
        }
        return false;
      };
      const proveGroupModule = (
        loader: NodePath<t.CallExpression>
      ): boolean => {
        const previous = groupModuleChecks.get(loader.node);
        if (previous) return requireCheck(previous) !== "unknown";
        const check = pendingCheck();
        groupModuleChecks.set(loader.node, check);
        requireCheck(check);
        const parent = current;
        current = check;
        try {
          const reference = getExtractionModuleReference(loader, (use, role) =>
            isRegisteredCall(use, role, undefined, ownedCalls)
          );
          if (!reference || reference.unsafe || reference.kind !== "require")
            reject(check);
          else if (check.local !== "unknown") check.local = "proven";
          return check.local !== "unknown";
        } finally {
          current = parent;
        }
      };
      for (const { values, unknown, selectedBranches } of argumentsEvaluation) {
        let reassigned: string | undefined;
        const capturedFunctions = new Set<t.Node>();
        if (unknown.length > 0)
          return {
            ...reference,
            unsafe: `Unknown argument evaluation ${unknown[0]!.node.type}`
          };
        for (const value of values) {
          if (value.isFunction()) capturedFunctions.add(value.node);
          if (value.isIdentifier()) {
            const binding = value.scope.getBinding(value.node.name);
            if (binding?.constant === false) reassigned = value.node.name;

            const program = value.scope.getProgramParent().path;
            if (
              (binding?.path.isVariableDeclarator() ||
                binding?.path.isFunctionDeclaration() ||
                binding?.path.isClassDeclaration()) &&
              isSharedValue(value) !== "proven" &&
              program.isProgram()
            ) {
              const mutation = analyzeAliasedStaticCssEvalBindingMutation(
                program,
                binding,
                {
                  selectedBranches,
                  moduleOriginIdentity:
                    moduleOriginsComplete && validatedModuleCalls.size > 0
                      ? moduleOriginIdentity
                      : undefined,
                  callResultProof(value) {
                    if (
                      moduleOriginsComplete &&
                      value.isCallExpression() &&
                      (validatedModuleCalls.has(value.node) ||
                        groupModuleCalls.has(value.node)) &&
                      [...groupModuleCalls.values()].every(proveGroupModule)
                    ) {
                      const source = getStaticCssEvalLiteralRequireImportPath(
                        value.node,
                        value.scope
                      )!;
                      const id = config?.resolvedSources?.require?.[source];
                      const metadata = id
                        ? config?.exportOrigins?.[id]
                        : undefined;
                      const primitivePaths = metadata?.primitiveExports
                        ?.map((encoded) => JSON.parse(encoded) as string[])
                        .filter((path) => {
                          const encoded = JSON.stringify(path);
                          if (!(
                            metadata.readablePaths?.includes(encoded) ||
                            metadata.ownDataPaths?.includes(encoded)
                          ))
                            return false;
                          return ![
                            ...(metadata.unknownExports ?? []),
                            ...(metadata.unknownContents ?? [])
                          ].some((unknown) => {
                            const prefix = JSON.parse(unknown) as string[];
                            return (
                              prefix.length <= path.length &&
                              prefix.every(
                                (name, index) => path[index] === name
                              )
                            );
                          });
                        });
                      return {
                        kind: "module-origin",
                        identity: moduleOriginIdentity,
                        primitivePaths
                      };
                    }
                    const artifact = analysis.artifactResult(value);
                    if (artifact) return artifact;
                    if (!value.isCallExpression()) return;
                    const sourceResult = sourceInvocationResultProof(
                      value,
                      (use, role) =>
                        isRegisteredCall(
                          use,
                          role,
                          capturedFunctions,
                          ownedCalls
                        )
                    );
                    if (sourceResult) return sourceResult;
                    // Earlier group publication may already have replaced a sibling
                    // callback. Its committed exact-node obligation remains in force.
                    if (isCommittedCapturedAuthoringOwner(value))
                      return {
                        kind: "build-owned",
                        identity: replayGroupIdentity
                      };
                    const capturedOwner = capturedAuthoringOwner(
                      value,
                      isRegisteredExtractionReference
                    );
                    if (
                      capturedOwner &&
                      capturedBindings.has(
                        capturedOwner.declaration.scope.getBinding(
                          (capturedOwner.declaration.node.id as t.Identifier)
                            .name
                        )!
                      ) &&
                      capturedOwner.consumers.every(
                        (consumer) => isReplayedValue(consumer) !== "unknown"
                      )
                    ) {
                      capturedOwnerCandidates.set(value.node, capturedOwner);
                      for (const consumer of capturedOwner.consumers)
                        publicationCandidates.set(consumer.node, consumer);
                      return {
                        kind: "build-owned",
                        identity: replayGroupIdentity
                      };
                    }

                    if (
                      isRegisteredExtractionReference(value.get("callee")) &&
                      groupOwnsResult(value) &&
                      isReplayedValue(value) !== "unknown"
                    )
                      return {
                        kind: "build-owned",
                        identity: replayGroupIdentity
                      };
                    if (
                      isRegisteredExtractionReference(value.get("callee")) &&
                      proveTerminalPublication(value)
                    )
                      return {
                        kind: "materialized-artifact",
                        identity: runtimeArtifactIdentity
                      };
                    const sourceReference = getModuleReference(
                      value.get("callee")
                    );
                    if (
                      sourceReference &&
                      !sourceReference.unsafe &&
                      !sourceReference.members.includes(null)
                    ) {
                      const id =
                        config?.resolvedSources?.[sourceReference.kind][
                          sourceReference.source
                        ];
                      const metadata = id
                        ? config?.exportOrigins?.[id]
                        : undefined;
                      const syntheticDefault =
                        sourceReference.interop === "node" ||
                        (Boolean(sourceReference.interop) &&
                          !metadata?.esModule);
                      const members =
                        syntheticDefault &&
                        sourceReference.members[0] === "default"
                          ? sourceReference.members.slice(1)
                          : sourceReference.members;
                      const shape =
                        metadata?.closedOwnAllocations?.[
                          JSON.stringify(members)
                        ];
                      const declaration = value.parentPath;
                      const producerBinding =
                        declaration?.isVariableDeclarator() &&
                        declaration.node.init === value.node &&
                        t.isIdentifier(declaration.node.id)
                          ? declaration.scope.getBinding(
                              declaration.node.id.name
                            )
                          : undefined;
                      if (
                        shape &&
                        buildOnlyUse(value) &&
                        ((metadata?.inertInvocations?.[
                          JSON.stringify(members)
                        ] === "call" &&
                          producerBinding !== undefined &&
                          capturedBindings.has(producerBinding)) ||
                          isReplayedValue(value) !== "unknown")
                      )
                        return {
                          kind: "closed-own-allocation",
                          identity: value.node,
                          shape
                        };
                    }
                    const proof = proveAuthoringCallSite(value, (use, role) =>
                      isRegisteredCall(use, role, capturedFunctions, ownedCalls)
                    );
                    if (
                      !proof ||
                      proof.calls.some(
                        (dependency) =>
                          isReplayedValue(dependency) === "unknown"
                      )
                    )
                      return;
                    // Replay may still be pending; isReplayedValue records its
                    // requirement on the current check. Final acceptance waits
                    // for the entire existing obligation graph to complete.
                    return proof.terminal === "style"
                      ? { kind: "primitive" }
                      : { kind: "build-owned", identity: value.node };
                  },
                  skippedPatternDefaults: analysis.skippedDefaults,
                  isReadOnlyCall(consumer) {
                    // The call need not be readonly when its entire input graph
                    // moves with it. Every consumer must prove that ownership;
                    // registration alone cannot hide a runtime-observed mutation.
                    if (!buildOnlyUse(consumer)) return false;
                    const init = binding.path.isVariableDeclarator()
                      ? binding.path.get("init")
                      : undefined;
                    // A value produced by another replayed call remains shared
                    // across sidecar consumers and publications. Keep that call's
                    // proof obligation; explicit writes still reject extraction.
                    return (
                      (init?.isCallExpression() &&
                        isReplayedValue(init) !== "unknown") ||
                      buildOnlyBinding(binding)
                    );
                  }
                }
              );
              if (mutation.kind !== "proved-unmodified")
                return {
                  ...reference,
                  unsafe:
                    mutation.kind === "unknown"
                      ? `Unproven argument binding ${value.node.name}: ${mutation.reason} (${mutation.path.node.type})`
                      : `Mutated argument binding ${value.node.name}`
                };
            }
          }
          const consumed = getExtractionModuleReference(
            value,
            (sibling, role) =>
              isRegisteredCall(sibling, role, capturedFunctions, ownedCalls)
          );
          if (consumed?.unsafe)
            return { ...reference, unsafe: consumed.unsafe };
        }
        if (reassigned)
          return { ...reference, unsafe: `Reassigned binding ${reassigned}` };
      }
    } finally {
      argumentConsumers.delete(candidate.node);
    }

    return reference;
  };
  const reference =
    intent === "callable"
      ? getSafeReference(callee, "callable")
      : getCallReference(callee);
  if (
    !reference ||
    (registration
      ? reference.kind === "local" ||
        reference.source !== source ||
        reference.members.length !== members.length ||
        reference.members.some(
          (member, index) => member !== null && member !== members[index]
        )
      : reference.kind !== "local")
  )
    return false;

  if (!reference.unsafe && root.local !== "unknown") root.local = "proven";
  const unsafe =
    reference.unsafe ??
    (!requirementsProven(root) ? "Unproven registered dependency" : undefined);

  if (
    unsafe ||
    (reference.kind !== "local" && reference.members.includes(null))
  ) {
    if (reference.kind === "require" && strict)
      throw callee.buildCodeFrameError(
        `Cannot safely extract ${JSON.stringify(source)} export ${JSON.stringify(name)}: ${unsafe ?? "dynamic member"}. Use mincho-js-ignore to leave this call in place.`
      );

    return false;
  }

  if (intent === "invocation") {
    for (const publication of publicationCandidates.values())
      requireExtractionPublication(publication);
    for (const owner of capturedOwnerCandidates.values())
      requireCapturedAuthoringOwner(owner.declaration);
  }
  return true;
}

export function isInsideExtractCallsImplementation(
  path: NodePath<t.Node>
): boolean {
  const config = (path.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;

  return Boolean(
    config?.protectedFunctions.length &&
    path.findParent(
      (parent) =>
        parent.isFunction() &&
        config.protectedFunctions.some(
          ({ start, end }) =>
            parent.node.start === start && parent.node.end === end
        )
    )
  );
}

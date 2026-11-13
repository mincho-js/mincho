import { type NodePath, types as t } from "@babel/core";
import {
  getExtractionModuleReference,
  getModuleReference,
  referencesModuleExport
} from "../commonjs/bindings.js";
import type { PluginState, ProgramScope } from "../types.js";
import { analyzeExtractCalls } from "./analysis.js";
import { isBuiltInExtractionCall } from "./builtins.js";
import {
  canonicalExtractCallsFile,
  runExtractCallsAnalysisSync
} from "./filesystem.js";
import type { PreparedExtractCalls } from "./types.js";
import { jsxCssPropExtractCalls } from "../jsxCssProp/options.js";

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

export function isExtractionCall(
  callee: NodePath<t.Node>,
  strict = true
): boolean {
  if (isBuiltInExtractionCall(callee, strict)) return true;

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

  return (
    config !== undefined &&
    Object.entries(
      getModuleReference(callee)?.kind === "require"
        ? (config.requires ?? config.imports)
        : config.imports
    ).some(([source, names]) =>
      names.some((name) =>
        referencesExtractionExport(callee, source, name, strict)
      )
    )
  );
}

function isUnconditionalModuleCall(callee: NodePath<t.Node>): boolean {
  for (let child = callee.parentPath; child; child = child.parentPath) {
    const parent = child.parentPath;
    if (!parent) return false;
    if (parent.isProgram()) return true;

    if (
      parent.isExpressionStatement() ||
      parent.isVariableDeclaration() ||
      parent.isExportNamedDeclaration() ||
      parent.isExportDefaultDeclaration() ||
      parent.isSpreadElement() ||
      (parent.isObjectProperty() &&
        (child.key === "value" ||
          (child.key === "key" && parent.node.computed))) ||
      (parent.isVariableDeclarator() && child.key === "init")
    )
      continue;

    if (
      parent.isExpression() &&
      !parent.isFunction() &&
      !parent.isClassExpression() &&
      !parent.isAwaitExpression() &&
      !parent.isYieldExpression() &&
      !parent.isOptionalCallExpression() &&
      !parent.isOptionalMemberExpression() &&
      !(
        parent.isLogicalExpression() &&
        child.key === "right" &&
        !(
          parent.node.operator === "&&" &&
          t.isMemberExpression(callee.node) &&
          t.isNodesEquivalent(parent.node.left, callee.node.object)
        )
      ) &&
      !(parent.isConditionalExpression() && child.key !== "test") &&
      !(
        parent.isAssignmentExpression() &&
        ["&&=", "||=", "??="].includes(parent.node.operator) &&
        child.key === "right"
      )
    )
      continue;

    return false;
  }

  return false;
}

/** A preset may group its authoring functions under a named export. */
function referencesExtractionExport(
  callee: NodePath<t.Node>,
  source: string,
  name: string,
  strict: boolean
): boolean {
  if (!name.includes("."))
    return referencesModuleExport(callee, source, name, strict);

  // Preserve literal export names containing dots as well as nested members.
  if (referencesModuleExport(callee, source, name, strict)) return true;

  const target = getModuleReference(callee);
  const members = name.split(".");
  if (
    !target ||
    target.source !== source ||
    target.members.length !== members.length ||
    target.members.some(
      (member, index) => member !== null && member !== members[index]
    )
  )
    return false;

  const config = (callee.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls;
  type SafetyCheck = {
    result: boolean | undefined;
    dependents: Set<SafetyCheck>;
  };

  const root: SafetyCheck = { result: undefined, dependents: new Set() };
  const checks = new Map<t.Node, SafetyCheck>([[callee.node, root]]);
  let current = root;

  const reject = (check: SafetyCheck) => {
    const pending = [check];

    while (pending.length) {
      const unsafe = pending.pop()!;
      if (unsafe.result === false) continue;

      unsafe.result = false;
      pending.push(...unsafe.dependents);
    }
  };

  const isRegisteredCall = (sibling: NodePath<t.Node>): boolean => {
    // Ignored calls stay at runtime and may mutate the shared namespace.
    const call = sibling.parentPath;
    if (
      call?.isCallExpression() &&
      (call.node.leadingComments?.some(
        (comment) => comment.value.trim() === "mincho-js-ignore"
      ) ||
        call.parent.leadingComments?.some(
          (comment) => comment.value.trim() === "mincho-js-ignore"
        ))
    )
      return false;

    if (isBuiltInExtractionCall(sibling, false)) return true;

    const target = getModuleReference(sibling);
    if (!config || !target || target.members.includes(null)) return false;

    const receiver = members.slice(0, -1);
    const siblingReceiver = target.members.slice(0, -1);
    const sharesReceiver =
      (receiver.length > 0 &&
        receiver.every((member, index) => target.members[index] === member)) ||
      (siblingReceiver.length > 0 &&
        siblingReceiver.every((member, index) => members[index] === member));

    // Sharing a receiver can make call order observable. Distinct calls must
    // keep their unconditional module execution in the sidecar. Independent
    // and standalone component-local authoring stays valid.
    if (
      sharesReceiver &&
      sibling.node !== callee.node &&
      (!isUnconditionalModuleCall(callee) ||
        !isUnconditionalModuleCall(sibling))
    )
      return false;

    const exports =
      target.kind === "require"
        ? (config.requires ?? config.imports)
        : config.imports;
    const exportName =
      target.kind === "require" && target.members.length === 0
        ? "default"
        : target.members.join(".");

    if (exports[target.source]?.includes(exportName) !== true) return false;

    // Cache only within this analysis: extraction can change the AST before
    // the next call. A cycle is provisional until all its dependencies pass.
    const previous = checks.get(sibling.node);
    if (previous) {
      previous.dependents.add(current);
      return previous.result !== false;
    }

    const check: SafetyCheck = {
      result: undefined,
      dependents: new Set([current])
    };
    checks.set(sibling.node, check);
    const parent = current;
    current = check;

    try {
      // A CommonJS namespace's broad unsafe result may concern another export.
      // Decide safety only after checking this candidate's exact member path.
      const candidate = getExtractionModuleReference(sibling, isRegisteredCall);

      if (candidate && !candidate.unsafe && check.result !== false)
        check.result = true;
      else reject(check);

      return check.result !== false;
    } finally {
      current = parent;
    }
  };
  const reference = getExtractionModuleReference(callee, isRegisteredCall);
  if (
    !reference ||
    reference.source !== source ||
    reference.members.length !== members.length ||
    reference.members.some(
      (member, index) => member !== null && member !== members[index]
    )
  )
    return false;

  const unsafe =
    reference.unsafe ??
    (root.result === false ? "Escaped registered dependency" : undefined);

  if (unsafe || reference.members.includes(null)) {
    if (reference.kind === "require" && strict)
      throw callee.buildCodeFrameError(
        `Cannot safely extract ${JSON.stringify(source)} export ${JSON.stringify(name)}: ${unsafe ?? "dynamic member"}. Use mincho-js-ignore to leave this call in place.`
      );

    return false;
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

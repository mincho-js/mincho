import { requireCapturedPatternOwner } from "../transforms/extractionPublication.js";
import type { ProgramScope } from "../types.js";
import {
  arrayMapResultProof,
  arrayIncludesResultProof
} from "../extractionCalls/arrayMapResult.js";
import { types as t, type NodePath } from "@babel/core";
import { addNamespace } from "@babel/helper-module-imports";
import type { Binding } from "@babel/traverse";
import {
  isProvenPrimitiveImport,
  getModuleReference,
  isProvenModuleDataRead,
  staticMemberName
} from "../commonjs/bindings.js";
import {
  canCaptureExtractionCallable,
  isExtractionCall,
  markBuildEvaluation,
  retainRuntimeInvocation
} from "../extractionCalls/index.js";
import { sourceRecipeInvocationResult } from "../extractionCalls/authoringCallSite.js";
import {
  mathResultProof,
  mathNamespaceOwnReadProof,
  mathReferenceProof,
  mathBindingIdentityProof
} from "../extractionCalls/mathResult.js";
import { compiledRecipeResultProof } from "../extractionCalls/compiledRecipeResult.js";
import { recipeRuntimeFactories } from "../optimizations/recipeFactories.js";
import { hasDynamicScope } from "../optimizations/dynamicScope.js";
import {
  getDestructuredBindingSource,
  resolveStaticMemberPath
} from "../staticCssEval/partialEvaluator/destructuring.js";
import {
  analyzeAliasedStaticCssEvalBindingMutation,
  analyzeAliasedExpressionMutation,
  type StaticCssMutationProof,
  analyzeImportedValueOrigin,
  analyzeImportedMemberReadOrigin
} from "../staticCssEval/sameFile/mutationAliases.js";
import { hasStaticCssEvalBindingMutation } from "../staticCssEval/sameFile/mutation.js";
import {
  isObjectPrototypeSetter,
  staticPropertyName
} from "../staticCssEval/propertySelection.js";
import { registerImportMethod } from "../utils.js";
import { analyzeCssPropSidecarHoistability } from "./modeAnalysis.js";
import { cssPropImportSource } from "./options.js";
import {
  everyPatternExpression as everyLocalPatternExpression,
  collectSkippedPatternDefaults as collectLocalSkippedPatternDefaults
} from "./patternExpressions.js";
import {
  getConfidentlyExecutedBranches,
  isSidecarSafeCssRuleExpression
} from "./sidecarSafety.js";

/** Loaded-graph revocation and the helper's fresh local observation both apply. */
function everyPatternExpression(
  ...args: Parameters<typeof everyLocalPatternExpression>
): boolean {
  const [pattern, predicate, selected, skippedDefault, environment] = args;
  const graph = (pattern.scope.getProgramParent() as ProgramScope).minchoData
    ?.extractCalls?.arrayMapIntrinsics;
  const declarator = pattern.parentPath;
  const initializer = declarator?.isVariableDeclarator()
    ? declarator.get("init")
    : undefined;
  return everyLocalPatternExpression(
    pattern,
    predicate,
    selected,
    skippedDefault,
    {
      requireReplaySafety: true,
      canReadPrimitiveImport: isProvenPrimitiveImport,
      canReplayIteration: environment?.canReplayIteration,
      canReplayOwnRead: (source, operation) =>
        (source === selected &&
          !!initializer?.isExpression() &&
          initializer.node === selected &&
          mathNamespaceOwnReadProof(initializer)) ||
        !!environment?.canReplayOwnRead?.(source, operation),
      prototypeMutationKeys: graph?.prototypeMutationKeys,
      nativeArrayIteration:
        environment?.nativeArrayIteration !== false &&
        (graph?.iterationIntact ?? graph?.intact) !== false,
      standardPrototypeAbsence:
        environment?.standardPrototypeAbsence !== false &&
        (graph?.prototypeAbsenceIntact ?? graph?.intact) !== false
    }
  );
}

function collectSkippedPatternDefaults(program: NodePath<t.Program>) {
  const graph = (program.scope as ProgramScope).minchoData?.extractCalls
    ?.arrayMapIntrinsics;
  return collectLocalSkippedPatternDefaults(program, {
    canReadPrimitiveImport: isProvenPrimitiveImport,
    prototypeMutationKeys: graph?.prototypeMutationKeys,
    nativeArrayIteration: (graph?.iterationIntact ?? graph?.intact) !== false,
    standardPrototypeAbsence:
      (graph?.prototypeAbsenceIntact ?? graph?.intact) !== false
  });
}

const runtimeCxBindings = new WeakMap<t.Program, Map<string, t.Identifier>>();
// Classification avoids repeated JSX lowering. Invocation ownership is a
// separate, clone-preserving fact shared with ordinary call extraction.
const preparedClassValues = new WeakSet<t.Node>();
const configuredCxCalls = new WeakSet<t.CallExpression>();
const sharedFactoryClasses = new WeakMap<t.VariableDeclarator, t.Identifier>();

/** Compiled stylesheet callables and extracted recipe results run in React. */
export function prepareRuntimeClassValue(path: NodePath<t.Node>): boolean {
  return visitCssValue(path, true);
}

/** Capture after JSX lowering has published its complete, current bindings. */
export function captureRuntimeClassCallables(program: NodePath<t.Program>) {
  const captures: Array<{ callee: NodePath<t.Expression>; source: string }> =
    [];
  program.traverse({
    CallExpression(call) {
      if (call.node.extra?.minchoEvaluationOwner !== "runtime") return;
      const callee = call.get("callee");
      if (!callee.isExpression()) return;
      const reference = getModuleReference(callee);
      if (
        reference &&
        reference.source === cssPropImportSource(call.scope) &&
        reference.members.length === 1 &&
        reference.members[0] === "cx" &&
        canCaptureExtractionCallable(callee)
      )
        captures.push({ callee, source: reference.source });
    }
  });

  // Decide against one stable scope snapshot before replacing any references.
  for (const { callee, source } of captures)
    callee.replaceWith(runtimeCxBinding(callee, source));

  return captures.length > 0;
}

function visitCssValue(path: NodePath<t.Node>, prepare: boolean): boolean {
  const value = path.isExpression() ? unwrapCxArgument(path) : path;
  if (!value.isArrayExpression()) {
    return visitClassValue(path, new Set(), prepare);
  }

  const elements = value.get("elements");
  let hasCallable = false;
  const supported = elements.every((element) => {
    if (!element.isExpression()) return false;

    const callable = visitCssValue(element, false);
    hasCallable ||= callable;
    return callable || isStaticClassBranch(element);
  });

  // Keep complete style arrays in their existing atomic compilation path.
  // Only the JSX consumer is visited; shared array initializers stay intact.
  if (!supported || !hasCallable) return false;

  if (prepare) {
    for (const element of elements) {
      if (element.isExpression()) visitCssValue(element, true);
    }

    // These elements are already classes. Avoid interpreting a runtime recipe
    // call inside an array branch as a second style factory during lowering.
    const cx = runtimeCxBinding(value, cssPropImportSource(value.scope), true);
    value.replaceWith(t.callExpression(cx, [t.cloneNode(value.node)]));
    preparedClassValues.add(value.node);
  }

  return true;
}

function visitClassValue(
  path: NodePath<t.Node>,
  seen: Set<t.Node>,
  prepare: boolean,
  consumer: NodePath<t.Node> = path,
  allowStyleBranches = false
): boolean {
  if (preparedClassValues.has(path.node)) return true;
  if (seen.has(path.node)) return false;
  const next = new Set(seen).add(path.node);

  if (allowStyleBranches && hasStaticRuleBranchShape(path)) {
    if (prepare) {
      if (
        path.isExpression() &&
        (hasRuntimeCalls([path]) ||
          hasMutableStyleInputs(path, [path]) ||
          !isStaticRuleBranch(path))
      )
        throw path.buildCodeFrameError(
          "Mixed JSX css prop style branches require static token values without runtime calls or mutated inputs. Use compiled recipes or React style for runtime values."
        );

      lowerStaticFactory(consumer);
      preparedClassValues.add(consumer.node);
    }

    return true;
  }

  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return visitClassValue(
      path.get("expression") as NodePath<t.Node>,
      next,
      prepare,
      consumer,
      allowStyleBranches
    );

  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (
      !binding ||
      !hasOnlyInitializerWrites(binding) ||
      !binding.path.isVariableDeclarator()
    )
      return false;

    const initializer = binding.path.get("init");
    if (
      prepare &&
      initializer.isExpression() &&
      containsStaticFactory(initializer, next)
    )
      requirePatternOwnerChain(binding.path);
    if (
      prepare &&
      initializer.isExpression() &&
      containsStaticFactory(initializer, next)
    ) {
      const mutation = analyzeFactoryValueMutation(binding, consumer);
      if (mutation?.kind === "unknown")
        throw path.buildCodeFrameError(
          `Cannot prove CSS factory value ${binding.identifier.name} is unmodified: ${mutation.reason} (${mutation.path.node.type}). Simplify the value's origin or alias flow before extraction.`
        );
      if (mutation?.kind === "may-mutate")
        throw path.buildCodeFrameError(
          "CSS factory values must not be mutated or passed to mutable consumers before extraction. Pass the final style to the factory instead."
        );
    }

    if (!binding.path.get("id").isIdentifier()) {
      const init = binding.path.get("init");
      if (
        !init.isExpression() ||
        !visitClassValue(init, next, false, init, allowStyleBranches) ||
        !containsStaticFactory(init, next)
      )
        return false;

      if (
        !isStaticPatternValue(init) ||
        !everyPatternExpression(
          binding.path.get("id"),
          isStaticPatternValue,
          init.node,
          undefined,
          {
            nativeArrayIteration: true,
            // Conditional on the mandatory mincho$ publication below. The
            // extraction proof must still capture every binding in one group.
            canReplayOwnRead: (source) => source === init.node,
            canReplayIteration: (source) => source === init.node
          }
        )
      )
        throw path.buildCodeFrameError(
          "Destructured CSS factory values must be statically evaluable. Keep runtime selections as individual CSS expressions or precompiled classes."
        );

      if (prepare) {
        requirePatternOwnerChain(binding.path);
        lowerStaticFactory(consumer);
        preparedClassValues.add(consumer.node);
      }
      return true;
    }

    const sharedClass = sharedFactoryClasses.get(binding.path.node);
    if (sharedClass) {
      if (prepare) useSharedFactoryClass(consumer, sharedClass);
      return true;
    }

    const init = binding.path.get("init");
    if (!prepare)
      return (
        init.isExpression() &&
        visitClassValue(init, next, false, init, allowStyleBranches)
      );

    const sharedKind = init.isExpression()
      ? sharedFactoryValueKind(init)
      : undefined;
    if (
      init.isExpression() &&
      sharedKind &&
      visitClassValue(init, next, false, init, allowStyleBranches) &&
      containsStaticFactory(init, next) &&
      hasNonCssReferences(binding.path)
    ) {
      if (prepare) {
        const sharedClass = prepareSharedFactoryClass(
          binding.path,
          init,
          binding.scope
        );
        useSharedFactoryClass(consumer, sharedClass);
      }
      return true;
    }

    return (
      init.isExpression() &&
      visitClassValue(
        init,
        next,
        prepare,
        sharedKind === "alias" && containsStaticFactory(init, next)
          ? init
          : consumer,
        allowStyleBranches
      )
    );
  }

  if (path.isCallExpression()) {
    const callee = path.get("callee");
    const reference = getModuleReference(callee);

    if (
      reference &&
      !reference.unsafe &&
      reference.members.length === 1 &&
      reference.members[0] === "cx" &&
      reference.source === cssPropImportSource(path.scope)
    ) {
      if (prepare) configuredCxCalls.add(path.node);

      if (prepare && !isStaticCall(path)) {
        retainRuntimeInvocation(path.node);
        for (const argument of path.get("arguments")) {
          prepareCxArgument(argument, next);
        }
      }

      if (prepare) preparedClassValues.add(path.node);

      return true;
    }

    const importedOrExtracted = Boolean(
      (reference &&
        !reference.unsafe &&
        reference.members.length > 0 &&
        /\.css(?:\.[cm]?[jt]sx?)?(?:\?.*)?$/.test(reference.source)) ||
      isExtractedResult(callee, next)
    );

    if (!importedOrExtracted) return false;
    if (!prepare) return true;

    if (isStaticCall(path)) {
      lowerStaticFactory(consumer);
      preparedClassValues.add(consumer.node);
    } else {
      retainRuntimeInvocation(path.node);
      callee.replaceWith(serializedRecipeReference(callee));
      preparedClassValues.add(path.node);
    }

    return true;
  }

  if (path.isConditionalExpression()) {
    const consequent = path.get("consequent");
    const alternate = path.get("alternate");
    const consequentClass = visitClassValue(consequent, next, false);
    const alternateClass = visitClassValue(alternate, next, false);
    const allowBranches =
      allowStyleBranches || consequentClass || alternateClass;
    const consequentValue =
      consequentClass ||
      (allowBranches &&
        visitClassValue(consequent, next, false, consequent, true));
    const alternateValue =
      alternateClass ||
      (allowBranches &&
        visitClassValue(alternate, next, false, alternate, true));
    const supported =
      (consequentValue || isStaticClassBranch(consequent)) &&
      (alternateValue || isStaticClassBranch(alternate)) &&
      allowBranches;

    if (supported && prepare) {
      if (consequentValue)
        visitClassValue(consequent, next, true, consequent, true);

      if (alternateValue)
        visitClassValue(alternate, next, true, alternate, true);
    }

    return supported;
  }

  if (path.isLogicalExpression({ operator: "&&" })) {
    const right = path.get("right");
    return visitClassValue(right, next, prepare, right, allowStyleBranches);
  }

  return false;
}

function isStaticPatternValue(
  value: NodePath<t.Node | null | undefined>,
  seenValues = new Set<t.Node>()
): boolean {
  if (!value.isExpression()) return false;
  const expression = unwrapCxArgument(value);
  if (seenValues.has(expression.node)) return false;
  const following = new Set(seenValues).add(expression.node);

  if (
    expression.isConditionalExpression() ||
    expression.isLogicalExpression()
  ) {
    const branches = getConfidentlyExecutedBranches(expression);
    return (
      !!branches &&
      branches.every((branch) => isStaticPatternValue(branch, following))
    );
  }

  if (expression.isIdentifier()) {
    const source = expression.scope.getBinding(expression.node.name);
    if (source?.constant && source.path.isVariableDeclarator()) {
      const initializer = source.path.get("init");
      return (
        isStaticPatternValue(initializer, following) &&
        everyPatternExpression(
          source.path.get("id"),
          (item) => isStaticPatternValue(item, following),
          initializer.node
        )
      );
    }
  }

  return isSidecarSafeCssRuleExpression({
    expression: t.arrayExpression([expression.node]),
    path: expression,
    state: {
      scope: expression.scope,
      visiting: new Set(),
      localNames: new Set()
    }
  });
}

function requirePatternOwnerChain(
  declaration: NodePath<t.VariableDeclarator>
): void {
  const owners: NodePath<t.VariableDeclarator>[] = [];
  const seen = new Set<t.Node>();
  let current: NodePath<t.VariableDeclarator> | undefined = declaration;
  while (current && !seen.has(current.node)) {
    seen.add(current.node);
    owners.push(current);
    const init: NodePath<t.Expression | null | undefined> = current.get("init");
    const binding: Binding | undefined = init.isIdentifier()
      ? init.scope.getBinding(init.node.name)
      : undefined;
    current =
      binding?.constant && binding.path.isVariableDeclarator()
        ? binding.path
        : undefined;
  }
  // A literal class-string container is runtime data, not an authoring producer.
  if (!owners[owners.length - 1]?.get("init").isCallExpression()) return;
  const firstPattern = owners.findIndex(
    (owner) => !t.isIdentifier(owner.node.id)
  );
  if (firstPattern >= 0)
    owners.slice(firstPattern).forEach(requireCapturedPatternOwner);
}

function hasOnlyInitializerWrites(binding: Binding): boolean {
  // A loop var repeats its own initializer; unrelated assignments remain unsafe.
  return (
    binding.constant ||
    (binding.kind === "var" &&
      binding.constantViolations.length > 0 &&
      binding.constantViolations.every(
        (violation) => violation.node === binding.path.node
      ))
  );
}

function sharedFactoryValueKind(
  path: NodePath<t.Node>
): "alias" | "conditional" | undefined {
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  ) {
    return sharedFactoryValueKind(path.get("expression") as NodePath<t.Node>);
  }

  if (path.isIdentifier()) return "alias";
  if (
    path.isConditionalExpression() ||
    path.isLogicalExpression({ operator: "&&" })
  )
    return "conditional";

  return undefined;
}

function containsStaticFactory(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>(),
  calls?: Set<t.CallExpression>
): boolean {
  if (seen.has(path.node) || preparedClassValues.has(path.node)) return false;
  const next = new Set(seen).add(path.node);

  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  ) {
    return containsStaticFactory(
      path.get("expression") as NodePath<t.Node>,
      next,
      calls
    );
  }
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (
      !binding ||
      !hasOnlyInitializerWrites(binding) ||
      !binding.path.isVariableDeclarator()
    )
      return false;
    if (!calls && sharedFactoryClasses.has(binding.path.node)) return true;
    const init = binding.path.get("init");
    return init.isExpression() && containsStaticFactory(init, next, calls);
  }
  if (calls && path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    return containsStaticFactory(
      expressions[expressions.length - 1],
      next,
      calls
    );
  }
  if (path.isConditionalExpression()) {
    const consequent = containsStaticFactory(
      path.get("consequent"),
      next,
      calls
    );
    const alternate = containsStaticFactory(path.get("alternate"), next, calls);
    return consequent || alternate;
  }
  if (path.isLogicalExpression({ operator: "&&" })) {
    return containsStaticFactory(path.get("right"), next, calls);
  }
  if (hasStaticRuleBranchShape(path)) return true;
  if (
    path.isCallExpression() &&
    isStaticCall(path) &&
    visitClassValue(path, seen, false)
  ) {
    calls?.add(path.node);
    return true;
  }
  return false;
}

function hasNonCssReferences(
  declaration: NodePath<t.VariableDeclarator>,
  seen = new Set<t.Node>(),
  allowCxArguments = false
): boolean {
  if (seen.has(declaration.node) || !t.isIdentifier(declaration.node.id))
    return true;
  const next = new Set(seen).add(declaration.node);
  const binding = declaration.scope.getBinding(declaration.node.id.name);
  if (!binding || declaration.parentPath.parentPath?.isExportNamedDeclaration())
    return true;

  return binding.referencePaths.some((reference) => {
    let current = reference;
    let parent = current.parentPath;
    let loweredCx = false;
    while (parent) {
      if (
        allowCxArguments &&
        parent.isCallExpression() &&
        current.listKey === "arguments"
      ) {
        const reference = getModuleReference(parent.get("callee"));
        if (
          configuredCxCalls.has(parent.node) ||
          (reference &&
            !reference.unsafe &&
            reference.members.length === 1 &&
            reference.members[0] === "cx" &&
            reference.source === cssPropImportSource(parent.scope))
        ) {
          loweredCx ||= configuredCxCalls.has(parent.node);
          current = parent;
          parent = current.parentPath;
          continue;
        }
      }

      if (
        parent.isTSAsExpression() ||
        parent.isTSTypeAssertion() ||
        parent.isTSNonNullExpression() ||
        parent.isTSSatisfiesExpression() ||
        parent.isParenthesizedExpression() ||
        (parent.isConditionalExpression() && current.key !== "test") ||
        (parent.isLogicalExpression({ operator: "&&" }) &&
          current.key === "right") ||
        (allowCxArguments &&
          (parent.isArrayExpression() || parent.isSpreadElement()))
      ) {
        current = parent;
        parent = current.parentPath;
        continue;
      }
      if (parent.isVariableDeclarator() && current.key === "init") {
        return hasNonCssReferences(parent, next, allowCxArguments);
      }
      return !(
        parent.isJSXExpressionContainer() &&
        parent.parentPath.isJSXAttribute() &&
        (t.isJSXIdentifier(parent.parentPath.node.name, { name: "css" }) ||
          (loweredCx &&
            t.isJSXIdentifier(parent.parentPath.node.name, {
              name: "className"
            })))
      );
    }
    return true;
  });
}

function analyzeFactoryValueMutation(
  binding: Binding,
  consumer: NodePath<t.Node>
): StaticCssMutationProof | undefined {
  const program = consumer.scope.getProgramParent().path;
  if (!program.isProgram() || !binding.path.isVariableDeclarator()) return;

  const init = binding.path.get("init");
  if (!init.isExpression()) return;

  const opaqueCalls = new Set<t.CallExpression>();
  containsStaticFactory(init, new Set(), opaqueCalls);

  const mutationOptions = {
    opaqueCalls,
    callResultProof: (
      call: NodePath<t.CallExpression | t.OptionalCallExpression>
    ) =>
      compiledRecipeResultProof(call) ??
      sourceRecipeInvocationResult(call) ??
      mathResultProof(call) ??
      arrayMapResultProof(call) ??
      arrayIncludesResultProof(call),
    skippedPatternDefaults: collectSkippedPatternDefaults(program),
    isReadOnlyCall(
      call: NodePath<
        t.CallExpression | t.OptionalCallExpression | t.NewExpression
      >
    ) {
      if (preparedClassValues.has(call.node)) return true;

      const callee = call.get("callee") as NodePath<t.Node>;
      const reference = getModuleReference(callee);
      if (
        reference &&
        !reference.unsafe &&
        reference.source === cssPropImportSource(call.scope) &&
        reference.members.length === 1 &&
        (reference.members[0] === "css" || reference.members[0] === "cx")
      )
        return true;

      // An enclosing call consumes its JSX argument after the CSS value.
      // A callback body may run during that call, so stop at function boundaries.
      return (
        consumer.findParent(
          (parent) => parent === call || parent.isFunction()
        ) === call
      );
    }
  };
  const projection = truthyCssResultOrigins(init);
  if (projection.projected) {
    // Only the CSS-producing value is the target. The analyzer still traverses
    // the entire program, including the predicate and every non-CSS alias use.
    // No claim is made that a falsy result (e.g. HTMLDDA) is primitive or immutable.
    const proofs = projection.origins.map((origin) =>
      analyzeAliasedExpressionMutation(program, origin, mutationOptions)
    );
    return (
      proofs.find((proof) => proof.kind === "may-mutate") ??
      proofs.find((proof) => proof.kind === "unknown") ?? {
        kind: "proved-unmodified"
      }
    );
  }
  return analyzeAliasedStaticCssEvalBindingMutation(
    program,
    binding,
    mutationOptions
  );
}

function truthyCssResultOrigins(
  path: NodePath<t.Expression>,
  seen = new Set<t.Node>()
): { origins: NodePath<t.Expression>[]; projected: boolean } {
  if (seen.has(path.node)) return { origins: [path], projected: false };
  const next = new Set(seen).add(path.node);
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return truthyCssResultOrigins(
      path.get("expression") as NodePath<t.Expression>,
      next
    );
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (
      binding &&
      hasOnlyInitializerWrites(binding) &&
      binding.path.isVariableDeclarator()
    ) {
      const init = binding.path.get("init");
      if (init.isExpression()) return truthyCssResultOrigins(init, next);
    }
  }
  if (path.isSequenceExpression()) {
    const expressions = path.get("expressions");
    return truthyCssResultOrigins(expressions[expressions.length - 1], next);
  }
  if (path.isLogicalExpression({ operator: "&&" })) {
    const right = truthyCssResultOrigins(path.get("right"), next);
    return { ...right, projected: true };
  }
  if (path.isConditionalExpression()) {
    const yes = truthyCssResultOrigins(path.get("consequent"), next);
    const no = truthyCssResultOrigins(path.get("alternate"), next);
    return {
      origins: [...yes.origins, ...no.origins],
      projected: yes.projected || no.projected
    };
  }
  return { origins: [path], projected: false };
}

function useSharedFactoryClass(
  consumer: NodePath<t.Node>,
  sharedClass: t.Identifier
): void {
  if (!consumer.isExpression()) {
    throw consumer.buildCodeFrameError("Expected CSS factory expression.");
  }
  consumer.replaceWith(
    t.logicalExpression(
      "??",
      t.cloneNode(sharedClass),
      t.cloneNode(consumer.node)
    )
  );
  preparedClassValues.add(consumer.node);
}

function prepareSharedFactoryClass(
  declaration: NodePath<t.VariableDeclarator>,
  init: NodePath<t.Expression>,
  bindingScope: NodePath["scope"]
): t.Identifier {
  if (declaration.scope.path.isForStatement()) {
    throw declaration.buildCodeFrameError(
      "Shared conditional CSS factory aliases in for initializers are not supported. Declare the shared value in a surrounding block."
    );
  }

  const sharedClass = bindingScope.generateUidIdentifier("cssClass");
  bindingScope.push({ id: t.cloneNode(sharedClass), kind: "let" });
  sharedFactoryClasses.set(declaration.node, sharedClass);

  const prepareBranch = (branch: NodePath<t.Node>): void => {
    if (
      branch.isTSAsExpression() ||
      branch.isTSTypeAssertion() ||
      branch.isTSNonNullExpression() ||
      branch.isTSSatisfiesExpression() ||
      branch.isParenthesizedExpression()
    ) {
      prepareBranch(branch.get("expression") as NodePath<t.Node>);
    } else if (branch.isConditionalExpression()) {
      prepareBranch(branch.get("consequent"));
      prepareBranch(branch.get("alternate"));
    } else if (branch.isLogicalExpression({ operator: "&&" })) {
      prepareBranch(branch.get("right"));
    } else if (branch.isExpression() && containsStaticFactory(branch)) {
      const original = t.cloneNode(branch.node);

      visitClassValue(branch, new Set(), true, branch, true);

      branch.replaceWith(
        t.sequenceExpression([
          t.assignmentExpression("=", t.cloneNode(sharedClass), branch.node),
          original
        ])
      );
    } else {
      visitClassValue(branch, new Set(), true);
    }
  };

  // Record the selected compiled branch without replacing its original value.
  // Reset on each initializer evaluation, including short-circuited loop runs.
  prepareBranch(init);
  init.replaceWith(
    t.sequenceExpression([
      t.assignmentExpression(
        "=",
        t.cloneNode(sharedClass),
        t.unaryExpression("void", t.numericLiteral(0))
      ),
      init.node
    ])
  );
  return sharedClass;
}

function unwrapCxArgument(
  path: NodePath<t.Expression>
): NodePath<t.Expression> {
  while (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    path = path.get("expression") as NodePath<t.Expression>;
  return path;
}

function prepareCxArgument(
  path: NodePath<t.Node | null>,
  seen: Set<t.Node>
): void {
  if (!path.node || seen.has(path.node)) return;
  const next = new Set(seen).add(path.node);

  if (path.isExpression()) {
    const unwrapped = unwrapCxArgument(path);
    if (unwrapped !== path) {
      prepareCxArgument(unwrapped, next);
      return;
    }
  }

  if (path.isArrayExpression()) {
    for (const element of path.get("elements"))
      prepareCxArgument(element, next);
  } else if (path.isSpreadElement()) {
    prepareCxArgument(path.get("argument"), next);
  } else if (path.isConditionalExpression()) {
    prepareCxArgument(path.get("consequent"), next);
    prepareCxArgument(path.get("alternate"), next);
  } else if (path.isLogicalExpression()) {
    if (path.node.operator !== "&&") prepareCxArgument(path.get("left"), next);
    prepareCxArgument(path.get("right"), next);
  } else if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    const initializer =
      binding?.constant && binding.path.isVariableDeclarator()
        ? binding.path.get("init")
        : undefined;
    const init = initializer?.isExpression()
      ? unwrapCxArgument(initializer)
      : undefined;
    if (init?.isArrayExpression() || init?.isIdentifier()) {
      // Native cx can consume the original array. Keep shared initializers
      // intact so ordinary consumers retain their values and runtime calls.
      if (
        binding?.path.isVariableDeclarator() &&
        !hasNonCssReferences(binding.path, new Set(), true)
      )
        prepareCxArgument(init, next);
    } else {
      visitClassValue(path, seen, true);
    }
  } else if (path.isExpression()) {
    visitClassValue(path, seen, true);
  }
}

function isStaticCall(path: NodePath<t.CallExpression>) {
  if (hasRuntimeLocalBinding(path) || hasRuntimeCalls(path.get("arguments")))
    return false;
  // Receipts belong only to this root and this unchanged AST snapshot.
  // Never cache or share them with another candidate call.
  const unmodifiedBindings = new Set<Binding>();
  if (hasMutableStyleInputs(path, path.get("arguments"), unmodifiedBindings))
    return false;
  return (
    analyzeCssPropSidecarHoistability({
      expression: path.node,
      path,
      scope: path.scope,
      unmodifiedBindings
    }).kind === "hoistable"
  );
}

function hasMutableStyleInputs(
  path: NodePath<t.Expression>,
  inputs: readonly NodePath[],
  unmodifiedBindings?: Set<Binding>
): boolean {
  const program = path.scope.getProgramParent().path;
  if (!program.isProgram()) return true;

  const inspected = new Set<Binding>();
  const selectedBranches = new Map<t.Node, NodePath<t.Expression>>();
  const inspect = (value: NodePath): void => {
    if (value.isExpression()) {
      const branches = getConfidentlyExecutedBranches(value);
      if (branches) {
        selectedBranches.set(value.node, branches[branches.length - 1]);
        branches.forEach(inspect);
        return;
      }
    }

    const visit = (reference: NodePath<t.Identifier | t.JSXIdentifier>) => {
      // Arguments can read mutable method receivers as well as direct values.
      const binding = reference.scope.getBinding(reference.node.name);
      if (
        !binding ||
        inspected.has(binding) ||
        (!binding.path.isVariableDeclarator() &&
          !binding.path.isFunctionDeclaration() &&
          !binding.path.isImportSpecifier() &&
          !binding.path.isImportDefaultSpecifier() &&
          !binding.path.isImportNamespaceSpecifier())
      )
        return;
      inspected.add(binding);

      if (binding.path.isVariableDeclarator()) {
        const init = binding.path.get("init");
        if (init.isExpression()) inspect(init);
        everyPatternExpression(
          binding.path.get("id"),
          (expression) => {
            if (expression.node) inspect(expression as NodePath<t.Node>);
            return true;
          },
          binding.path.node.init
        );
      } else if (binding.path.isFunctionDeclaration()) {
        inspect(binding.path);
      }
    };

    if (value.isReferencedIdentifier()) visit(value);
    value.traverse({
      "ConditionalExpression|LogicalExpression"(inner) {
        if (!inner.isExpression()) return;
        const branches = getConfidentlyExecutedBranches(inner);
        if (!branches) return;

        selectedBranches.set(inner.node, branches[branches.length - 1]);
        branches.forEach(inspect);
        inner.skip();
      },
      ReferencedIdentifier: visit
    });
  };

  inputs.forEach(inspect);

  const skippedPatternDefaults = collectSkippedPatternDefaults(program);
  return [...inspected].some((binding) => {
    if (mathBindingIdentityProof(binding)) {
      unmodifiedBindings?.add(binding);
      return false;
    }
    const mutated = hasStaticCssEvalBindingMutation(program, binding, {
      selectedBranches,
      skippedPatternDefaults,
      callResultProof: (
        call: NodePath<t.CallExpression | t.OptionalCallExpression>
      ) =>
        compiledRecipeResultProof(call) ??
        sourceRecipeInvocationResult(call) ??
        mathResultProof(call) ??
        arrayMapResultProof(call) ??
        arrayIncludesResultProof(call),
      // The factory consumes a style value. Nested argument helpers can still
      // mutate their inputs, so their calls retain the ordinary escape checks.
      isReadOnlyCall: (call) =>
        call.node === path.node || isReadOnlyArgumentCall(call)
    });
    if (!mutated) unmodifiedBindings?.add(binding);
    return mutated;
  });
}

/** A result-type receipt alone never grants this no-user-code guarantee. */
function isReadOnlyArgumentCall(
  call: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>
): boolean {
  if (!call.isCallExpression() || call.node.optional) return false;
  const callee = call.get("callee");
  // Restrict effect evidence to the direct intrinsic. Bound/aliased calls may
  // carry hidden bound arguments whose coercions are not visible at this node.
  if (!callee.isMemberExpression() || callee.node.computed) return false;
  const receiver = callee.get("object");
  if (
    !receiver.isIdentifier({ name: "Math" }) ||
    receiver.scope.getBinding("Math")
  )
    return false;
  if (!mathResultProof(call)) return false;
  // Native Math with these primitive inputs cannot invoke coercion hooks or
  // spread iterators. Runtime nondeterminism remains checked separately.
  return call
    .get("arguments")
    .every(
      (argument) =>
        argument.isStringLiteral() ||
        argument.isBooleanLiteral() ||
        argument.isNullLiteral() ||
        (argument.isNumericLiteral() && Number.isFinite(argument.node.value))
    );
}

function hasRuntimeCalls(inputs: readonly NodePath[]): boolean {
  const program = inputs[0]?.scope.getProgramParent().path;
  const originOptions = {
    callResultProof: (
      call: NodePath<t.CallExpression | t.OptionalCallExpression>
    ) =>
      compiledRecipeResultProof(call) ??
      sourceRecipeInvocationResult(call) ??
      mathResultProof(call) ??
      arrayMapResultProof(call) ??
      arrayIncludesResultProof(call),
    skippedPatternDefaults: program?.isProgram()
      ? collectSkippedPatternDefaults(program)
      : undefined
  };
  const hasImportedValueOrigin = (
    path: NodePath<t.Node>,
    members: readonly (string | null)[] = []
  ) =>
    analyzeImportedValueOrigin(path, members, originOptions).kind !== "local";
  const hasImportedMemberReadOrigin = (
    path: NodePath<t.Node>,
    member: string | null,
    members: readonly (string | null)[] = []
  ) =>
    analyzeImportedMemberReadOrigin(path, member, members, originOptions)
      .kind !== "local";
  // Follow local wrappers and callbacks as well as direct imported calls.
  // A binding can refer back to itself through aliases or recursive helpers.
  const inspectedHelpers = new Set<Binding>();
  const inspectedArgumentValues = new Set<Binding>();
  type ReferenceUse = "execution" | "argument-value";
  const isImportedRead = (path: NodePath): boolean => {
    // Spreading consumes properties or an iterator just as an explicit member
    // access consumes a property. Merely referring to an import does neither.
    if (path.isSpreadElement())
      return hasImportedValueOrigin(path.get("argument"));
    if (!(path.isMemberExpression() || path.isOptionalMemberExpression()))
      return false;
    const invocation = path.parentPath;
    if (
      invocation?.isCallExpression() &&
      invocation.node.callee === path.node &&
      mathResultProof(invocation)
    )
      return false;
    const intrinsicRead = mathReferenceProof(path);
    if (intrinsicRead)
      return intrinsicRead.dependencies.some((dependency) =>
        containsRuntimeCall(dependency)
      );
    if (isProvenModuleDataRead(path)) return false;
    const member: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
      path;
    const object = member.get("object");
    return (
      getModuleReference(path) !== null ||
      getModuleReference(object) !== null ||
      hasImportedMemberReadOrigin(
        object,
        staticPropertyName(member.node.property, member.node.computed)
      )
    );
  };
  // Math is available to the sidecar, but sampling it must stay with its
  // runtime consumer, including constant object and destructured aliases.
  const isRuntimeGlobal = (
    reference: NodePath,
    members: readonly (string | null)[] = [],
    seen = new Set<Binding>()
  ): boolean => {
    const value = reference.isExpression()
      ? unwrapCxArgument(reference)
      : reference;
    if (value.isMemberExpression() || value.isOptionalMemberExpression()) {
      const access: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
        value;
      const property = access.get("property");
      const evaluated = access.node.computed ? property.evaluate() : null;
      const member =
        !access.node.computed && property.isIdentifier()
          ? property.node.name
          : evaluated?.confident
            ? String(evaluated.value)
            : null;
      return isRuntimeGlobal(access.get("object"), [member, ...members], seen);
    }
    if (!value.isIdentifier()) return false;

    const binding = value.scope.getBinding(value.node.name);
    if (!binding)
      return (
        value.node.name === "Math" &&
        (members[0] === "random" || members[0] === null)
      );
    if (
      !binding.constant ||
      seen.has(binding) ||
      !binding.path.isVariableDeclarator()
    )
      return false;

    const source = getDestructuredBindingSource(binding, value.node.name, {
      nativeArrayIteration: (() => {
        const snapshot = (value.scope.getProgramParent() as ProgramScope)
          .minchoData?.extractCalls?.arrayMapIntrinsics;
        return snapshot?.iterationIntact ?? snapshot?.intact;
      })()
    });
    const init = binding.path.get("init");
    return (
      source !== null &&
      init.isExpression() &&
      isRuntimeGlobal(
        init,
        [...source.memberPath, ...members],
        new Set(seen).add(binding)
      )
    );
  };

  const patternReadsImport = (
    pattern: NodePath<t.Node | null | undefined>,
    source: NodePath<t.Expression>,
    members: readonly (string | null)[] = []
  ): boolean => {
    if (pattern.isAssignmentPattern()) {
      const selected = members.includes(null)
        ? null
        : resolveStaticMemberPath(
            unwrapCxArgument(source).node,
            members as readonly string[]
          );
      const defined =
        t.isLiteral(selected) ||
        t.isObjectExpression(selected) ||
        t.isArrayExpression(selected) ||
        t.isFunctionExpression(selected) ||
        t.isArrowFunctionExpression(selected);

      return (
        patternReadsImport(pattern.get("left"), source, members) ||
        (!defined &&
          patternReadsImport(pattern.get("left"), pattern.get("right")))
      );
    }
    if (!pattern.isObjectPattern() && !pattern.isArrayPattern()) return false;
    if (hasImportedValueOrigin(source, members)) return true;

    // Inspect the receiver at each nested pattern, not the origin of the
    // resulting binding: `{ size: token }` reads only the fresh outer object.
    return pattern.isObjectPattern()
      ? pattern
          .get("properties")
          .some((property) =>
            property.isObjectProperty()
              ? hasImportedMemberReadOrigin(
                  source,
                  staticMemberName(property.node),
                  members
                ) ||
                patternReadsImport(property.get("value"), source, [
                  ...members,
                  staticMemberName(property.node)
                ])
              : false
          )
      : pattern
          .get("elements")
          .some((element, index) =>
            element.node
              ? patternReadsImport(element, source, [...members, String(index)])
              : false
          );
  };

  const containsHelperRuntime = (
    reference: NodePath,
    use: ReferenceUse
  ): boolean => {
    if (!reference.isIdentifier()) return false;
    if (isRuntimeGlobal(reference)) return true;
    const intrinsicRead =
      use === "execution" ? mathReferenceProof(reference) : undefined;
    if (intrinsicRead)
      return intrinsicRead.dependencies.some((dependency) =>
        containsRuntimeCall(dependency)
      );
    if (use === "argument-value" && getModuleReference(reference)) return true;

    const binding = reference.scope.getBinding(reference.node.name);
    const inspected =
      use === "argument-value" ? inspectedArgumentValues : inspectedHelpers;
    if (!binding?.constant || inspected.has(binding)) return false;

    inspected.add(binding);

    const declaration = binding.path;
    const initializer = declaration.isVariableDeclarator()
      ? declaration.get("init")
      : declaration;

    if (declaration.isVariableDeclarator()) {
      const pattern = declaration.get("id");
      if (
        (initializer.isExpression() &&
          patternReadsImport(pattern, initializer)) ||
        !everyPatternExpression(
          pattern,
          (expression) =>
            !expression.isExpression() ||
            (!hasCoercionCallback(expression) &&
              !containsRuntimeCall(expression)),
          declaration.node.init
        )
      )
        return true;
    }

    const helper = initializer.isExpression()
      ? unwrapCxArgument(initializer)
      : initializer;

    if (helper.isIdentifier()) return containsHelperRuntime(helper, use);

    return (
      (helper.isFunctionDeclaration() || helper.isExpression()) &&
      containsRuntimeCall(helper, use)
    );
  };

  // An import is available to the sidecar, but calling it can still read
  // render-time state. Preserve those calls as arguments to runtime recipes.
  const isImportedCall = (candidate: NodePath): boolean => {
    if (!(
      candidate.isCallExpression() ||
      candidate.isOptionalCallExpression() ||
      candidate.isNewExpression()
    ))
      return false;

    const call: NodePath<
      t.CallExpression | t.OptionalCallExpression | t.NewExpression
    > = candidate;
    const callee = call.get("callee");
    if (getModuleReference(callee)) return true;
    // Only the verified native invocation is non-coercing. Its receiver and
    // search expressions are still traversed normally below the call node.
    if (
      (call.isCallExpression() || call.isOptionalCallExpression()) &&
      arrayIncludesResultProof(call)
    )
      return false;

    // An imported value may be a callback, including through a container or
    // another function. Unknown callees must consume those values at runtime.
    return call
      .get("arguments")
      .some((argument) => containsRuntimeCall(argument, "argument-value"));
  };

  const containsRuntimeCall = (
    argument: NodePath,
    use: ReferenceUse = "execution"
  ): boolean => {
    if (
      argument.isReferencedIdentifier() &&
      containsHelperRuntime(argument, use)
    )
      return true;

    if (argument.isExpression()) {
      const branches = getConfidentlyExecutedBranches(argument);
      if (branches)
        return branches.some((branch) => containsRuntimeCall(branch, use));
    }
    if (
      isImportedCall(argument) ||
      isImportedRead(argument) ||
      isRuntimeGlobal(argument) ||
      isRuntimeCoercion(argument)
    )
      return true;

    let found = false;
    const visit = (candidate: NodePath) => {
      found ||=
        isImportedCall(candidate) ||
        isImportedRead(candidate) ||
        isRuntimeGlobal(candidate) ||
        isRuntimeCoercion(candidate);
      if (found) candidate.stop();
    };
    argument.traverse({
      AssignmentPattern(inner) {
        if (originOptions.skippedPatternDefaults?.has(inner.node)) {
          // The default is unexecuted, but nested patterns and computed keys
          // on its left still run and must retain their effects.
          found ||= containsRuntimeCall(inner.get("left"), use);
          inner.skip();
          if (found) inner.stop();
          return;
        }
        if (!patternReadsImport(inner, inner.get("right"))) return;

        found = true;
        inner.stop();
      },
      ReferencedIdentifier(inner) {
        if (!containsHelperRuntime(inner, use)) return;

        found = true;
        inner.stop();
      },
      "ConditionalExpression|LogicalExpression"(inner) {
        if (!inner.isExpression()) return;
        const branches = getConfidentlyExecutedBranches(inner);
        if (!branches) return;

        found ||= branches.some((branch) => containsRuntimeCall(branch, use));
        inner.skip();
        if (found) inner.stop();
      },
      CallExpression: visit,
      OptionalCallExpression: visit,
      NewExpression: visit,
      UnaryExpression: visit,
      BinaryExpression: visit,
      TemplateLiteral: visit,
      MemberExpression: visit,
      OptionalMemberExpression: visit,
      ObjectProperty: visit,
      ObjectMethod: visit,
      SpreadElement: visit
    });

    return found;
  };

  const hasCoercionCallback = (
    value: NodePath,
    seen = new Set<t.Node>()
  ): boolean => {
    if (!value.isExpression() || seen.has(value.node)) return false;
    const next = new Set(seen).add(value.node);
    const branches = getConfidentlyExecutedBranches(value);
    if (branches)
      return branches.some((branch) => hasCoercionCallback(branch, next));

    // Imported primitives stay static; only an object's conversion hook is
    // implicitly called by these operators.
    const resolved = unwrapCxArgument(value).resolve();
    if (resolved.node !== value.node)
      return hasCoercionCallback(resolved, next);

    if (value.isArrayExpression())
      return value
        .get("elements")
        .some((element) =>
          element.isSpreadElement()
            ? hasCoercionCallback(element.get("argument"), next)
            : element.isExpression() && hasCoercionCallback(element, next)
        );

    if (!value.isObjectExpression()) return false;

    return value.get("properties").some((property) => {
      if (property.isSpreadElement())
        return hasCoercionCallback(property.get("argument"), next);
      if (property.isObjectProperty() && isObjectPrototypeSetter(property.node))
        return hasCoercionCallback(property.get("value"), next);
      if (!(property.isObjectProperty() || property.isObjectMethod()))
        return false;

      const member: NodePath<t.ObjectProperty | t.ObjectMethod> = property;
      const key = member.get("key");
      const resolvedKey = member.node.computed ? key.resolve() : undefined;
      const name =
        (!member.node.computed && key.isIdentifier()
          ? key.node.name
          : key.isStringLiteral() || key.isNumericLiteral()
            ? String(key.node.value)
            : undefined) ??
        (resolvedKey?.isStringLiteral() ? resolvedKey.node.value : undefined);
      const unknownComputedKey = member.node.computed && name === undefined;
      const primitiveSymbol =
        member.node.computed &&
        key.isMemberExpression() &&
        key.get("object").isIdentifier({ name: "Symbol" }) &&
        !key.scope.getBinding("Symbol") &&
        staticMemberName(key.node) === "toPrimitive";
      if (
        name !== "valueOf" &&
        name !== "toString" &&
        !primitiveSymbol &&
        !unknownComputedKey
      )
        return false;

      if (property.isObjectMethod())
        return containsRuntimeCall(
          property,
          property.node.kind === "get" ? "argument-value" : "execution"
        );

      const hook = property.get("value");
      return containsRuntimeCall(
        hook,
        hook.resolve().isFunction() ? "execution" : "argument-value"
      );
    });
  };

  const isRuntimeCoercion = (candidate: NodePath): boolean => {
    if (
      (candidate.isMemberExpression() ||
        candidate.isOptionalMemberExpression()) &&
      candidate.node.computed
    ) {
      const member: NodePath<t.MemberExpression | t.OptionalMemberExpression> =
        candidate;
      return hasCoercionCallback(member.get("property"));
    }
    if (
      (candidate.isObjectProperty() || candidate.isObjectMethod()) &&
      candidate.node.computed
    ) {
      const property: NodePath<t.ObjectProperty | t.ObjectMethod> = candidate;
      return hasCoercionCallback(property.get("key"));
    }
    if (candidate.isUnaryExpression())
      return (
        ["+", "-", "~"].includes(candidate.node.operator) &&
        hasCoercionCallback(candidate.get("argument"))
      );
    if (candidate.isBinaryExpression({ operator: "in" }))
      return hasCoercionCallback(candidate.get("left"));
    if (candidate.isBinaryExpression())
      return (
        !["===", "!==", "instanceof"].includes(candidate.node.operator) &&
        (hasCoercionCallback(candidate.get("left")) ||
          hasCoercionCallback(candidate.get("right")))
      );
    return (
      candidate.isTemplateLiteral() &&
      candidate
        .get("expressions")
        .some((expression) => hasCoercionCallback(expression))
    );
  };

  return inputs.some((argument) => containsRuntimeCall(argument));
}

// Classify the literal branch before testing its safety so rejected mixed
// values retain the mixed-style diagnostic instead of falling into AST retry.
function hasStaticRuleBranchShape(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): boolean {
  if (seen.has(path.node)) return false;
  const next = new Set(seen).add(path.node);
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return hasStaticRuleBranchShape(
      path.get("expression") as NodePath<t.Node>,
      next
    );
  if (path.isObjectExpression() || path.isArrayExpression()) return true;
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return false;
  const init = binding.path.get("init");
  return init.isExpression() && hasStaticRuleBranchShape(init, next);
}

function isStaticRuleBranch(
  path: NodePath<t.Node>,
  seen = new Set<t.Node>()
): boolean {
  if (seen.has(path.node)) return false;
  const next = new Set(seen).add(path.node);

  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return isStaticRuleBranch(
      path.get("expression") as NodePath<t.Expression>,
      next
    );
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator())
      return false;
    const init = binding.path.get("init");
    if (!init.isExpression() || !isStaticRuleBranch(init, next)) return false;
  } else if (!path.isObjectExpression() && !path.isArrayExpression()) {
    return false;
  }

  return (
    path.isExpression() &&
    !hasRuntimeLocalBinding(path) &&
    isSidecarSafeCssRuleExpression({
      expression: path.node,
      path,
      state: {
        scope: path.scope,
        visiting: new Set(),
        localNames: new Set()
      }
    })
  );
}

function hasRuntimeLocalBinding(
  path: NodePath,
  seen = new Set<t.Node>(),
  candidates: readonly NodePath[] = [path]
): boolean {
  if (path.isExpression()) {
    const branches = getConfidentlyExecutedBranches(path);
    if (branches)
      return branches.some((branch) =>
        hasRuntimeLocalBinding(branch, seen, candidates)
      );
  }

  let runtime = false;
  const visit = (reference: NodePath<t.Identifier | t.JSXIdentifier>) => {
    const binding = reference.scope.getBinding(reference.node.name);
    if (!binding || seen.has(binding.path.node)) return;
    seen.add(binding.path.node);
    // Callback parameters and locals belong to the expression being evaluated;
    // only bindings captured from outside it can carry runtime-only input.
    if (binding.path.findParent((parent) => candidates.includes(parent)))
      return;
    if (binding.kind === "param") {
      runtime = true;
      return;
    }
    if (!binding.path.isVariableDeclarator()) return;

    const isRuntimeInitializer = (
      init: NodePath<t.Node | null | undefined>
    ): boolean => {
      if (!init.isExpression()) return false;
      if (binding.scope.getFunctionParent() && hasImmediateRuntimeCall(init))
        return true;
      if (init.evaluate().confident) return false;

      return hasRuntimeLocalBinding(init, seen, [...candidates, init]);
    };

    // A confident initializer does not account for expressions in its pattern.
    runtime ||=
      !everyPatternExpression(
        binding.path.get("id"),
        (expression) => !isRuntimeInitializer(expression),
        binding.path.node.init
      ) || isRuntimeInitializer(binding.path.get("init"));
  };

  if (path.isReferencedIdentifier()) visit(path);
  path.traverse({
    "ConditionalExpression|LogicalExpression"(inner) {
      if (!inner.isExpression()) return;
      const branches = getConfidentlyExecutedBranches(inner);
      if (!branches) return;

      runtime ||= branches.some((branch) =>
        hasRuntimeLocalBinding(branch, seen, candidates)
      );
      inner.skip();
      if (runtime) inner.stop();
    },
    ReferencedIdentifier: visit
  });
  return runtime;
}

function hasImmediateRuntimeCall(path: NodePath<t.Expression>): boolean {
  if (path.isFunction()) return false;
  const branches = getConfidentlyExecutedBranches(path);
  if (branches) return branches.some(hasImmediateRuntimeCall);

  let called = false;
  const found = (call: NodePath) => {
    // Babel can fold a surrounding sequence or void expression while ignoring
    // calls it executes. Inspect each call, including arguments of folded calls.
    if (call.isCallExpression() && call.evaluate().confident) return;
    called = true;
    call.stop();
  };

  if (
    path.isCallExpression() ||
    path.isOptionalCallExpression() ||
    path.isNewExpression()
  )
    found(path);
  if (called) return true;

  path.traverse({
    Function(inner) {
      inner.skip();
    },
    "ConditionalExpression|LogicalExpression"(inner) {
      if (!inner.isExpression()) return;
      const branches = getConfidentlyExecutedBranches(inner);
      if (!branches) return;
      called = branches.some(hasImmediateRuntimeCall);
      inner.skip();
      if (called) inner.stop();
    },
    CallExpression: found,
    OptionalCallExpression: found,
    NewExpression: found
  });
  return called;
}

function lowerStaticFactory(path: NodePath<t.Node>) {
  if (!path.isExpression()) {
    throw path.buildCodeFrameError("Expected a static CSS factory expression.");
  }
  const value = path.scope.generateUidIdentifier("cssValue");
  const marker = registerImportMethod(path, "mincho$");
  const css = registerImportMethod(
    path,
    "css",
    cssPropImportSource(path.scope)
  );
  const classValue = t.logicalExpression(
    "||",
    t.binaryExpression(
      "===",
      t.unaryExpression("typeof", value),
      t.stringLiteral("string")
    ),
    t.logicalExpression(
      "||",
      t.binaryExpression("==", value, t.nullLiteral()),
      t.binaryExpression("===", value, t.booleanLiteral(false))
    )
  );

  path.replaceWith(
    markBuildEvaluation(
      t.callExpression(marker, [
        t.arrowFunctionExpression(
          [],
          t.blockStatement([
            t.variableDeclaration("const", [
              t.variableDeclarator(value, t.cloneNode(path.node))
            ]),
            t.returnStatement(
              t.conditionalExpression(
                classValue,
                value,
                t.callExpression(css, [value])
              )
            )
          ])
        )
      ])
    )
  );
}

function serializedRecipeReference(path: NodePath) {
  if (!path.isExpression()) {
    throw path.buildCodeFrameError("Expected a CSS recipe callable.");
  }

  // Generated metadata validation uses the intrinsic Error, not an authoring
  // binding captured from a component or module scope.
  let errorBinding = path.scope.getBinding("Error");
  if (errorBinding) {
    const program = path.scope.getProgramParent().path;
    if (!program.isProgram() || hasDynamicScope(program))
      throw path.buildCodeFrameError(
        "Cannot safely rename a shadowed Error binding across dynamic scope."
      );
    while (errorBinding) {
      errorBinding.scope.rename("Error");
      errorBinding = path.scope.getBinding("Error");
    }
  }

  const recipe = path.scope.generateUidIdentifier("recipe");
  const metadata = path.scope.generateUidIdentifier("recipeMetadata");
  const marker = registerImportMethod(path, "mincho$");
  const factories = [
    ...recipeRuntimeFactories,
    {
      source: "@mincho-js/css/defineRules/createDefineRulesCxRuntime",
      name: "createCompiledDefineRulesCxRuntime"
    },
    {
      source: "@vanilla-extract/recipes/createRuntimeFn",
      name: "createRuntimeFn"
    }
  ];
  const supportedFactories = factories
    .map(({ source, name }) =>
      t.logicalExpression(
        "&&",
        t.binaryExpression(
          "===",
          ownDataValue(metadata, "importPath"),
          t.stringLiteral(source)
        ),
        t.binaryExpression(
          "===",
          ownDataValue(metadata, "importName"),
          t.stringLiteral(name)
        )
      )
    )
    .reduce((left, right) => t.logicalExpression("||", left, right));

  return markBuildEvaluation(
    t.callExpression(marker, [
      t.arrowFunctionExpression(
        [],
        t.blockStatement([
          t.variableDeclaration("const", [
            t.variableDeclarator(recipe, t.cloneNode(path.node))
          ]),
          t.variableDeclaration("const", [
            t.variableDeclarator(
              metadata,
              t.logicalExpression(
                "&&",
                t.binaryExpression(
                  "===",
                  t.unaryExpression("typeof", recipe),
                  t.stringLiteral("function")
                ),
                ownDataValue(recipe, "__recipe__")
              )
            )
          ]),
          t.ifStatement(
            t.unaryExpression(
              "!",
              t.logicalExpression("&&", metadata, supportedFactories)
            ),
            t.throwStatement(
              t.newExpression(t.identifier("Error"), [
                t.stringLiteral(
                  "Configured JSX css prop accepts runtime calls only to compiled Mincho or Vanilla Extract recipes. Use static token values for style factories."
                )
              ])
            )
          ),
          t.returnStatement(recipe)
        ])
      )
    ])
  );
}

function ownDataValue(object: t.Identifier, property: string) {
  return t.optionalMemberExpression(
    t.callExpression(
      t.memberExpression(
        // A source binding named Object or globalThis must not capture this
        // compiler-generated lookup in the extracted callback.
        t.memberExpression(t.objectExpression([]), t.identifier("constructor")),
        t.identifier("getOwnPropertyDescriptor")
      ),
      [object, t.stringLiteral(property)]
    ),
    t.identifier("value"),
    false,
    true
  );
}

function runtimeCxBinding(
  path: NodePath<t.Node>,
  source: string,
  allowMissing = false
) {
  const program = path.scope.getProgramParent().path;
  if (!program.isProgram()) {
    throw path.buildCodeFrameError("Expected a program for configured cx.");
  }

  let bindings = runtimeCxBindings.get(program.node);
  if (!bindings) {
    bindings = new Map();
    runtimeCxBindings.set(program.node, bindings);
  }

  const key = JSON.stringify([source, allowMissing]);
  let identifier = bindings.get(key);
  if (!identifier) {
    const cx = allowMissing
      ? t.memberExpression(addNamespace(path, source), t.identifier("cx"))
      : registerImportMethod(path, "cx", source);
    const value = t.identifier("cx");
    const body = allowMissing
      ? t.blockStatement([
          t.variableDeclaration("const", [t.variableDeclarator(value, cx)]),
          t.returnStatement(
            t.conditionalExpression(
              t.logicalExpression(
                "&&",
                t.binaryExpression(
                  "===",
                  t.unaryExpression("typeof", t.cloneNode(value)),
                  t.stringLiteral("function")
                ),
                ownDataValue(value, "__recipe__")
              ),
              t.cloneNode(value),
              t.nullLiteral()
            )
          )
        ])
      : cx;
    const marker = registerImportMethod(path, "mincho$");
    identifier = program.scope.generateUidIdentifier("runtimeCx");
    program.unshiftContainer(
      "body",
      t.variableDeclaration("const", [
        t.variableDeclarator(
          identifier,
          markBuildEvaluation(
            t.callExpression(marker, [t.arrowFunctionExpression([], body)])
          )
        )
      ])
    );
    bindings.set(key, identifier);
  }

  // Only scoped cx needs serialization; other sources keep class-name arrays.
  return allowMissing
    ? t.logicalExpression(
        "??",
        t.cloneNode(identifier),
        registerImportMethod(path, "cx", "@mincho-js/css/classname")
      )
    : t.cloneNode(identifier);
}

function isStaticClassBranch(path: NodePath<t.Node>): boolean {
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return isStaticClassBranch(path.get("expression") as NodePath<t.Node>);

  return (
    path.isStringLiteral() ||
    path.isNullLiteral() ||
    path.isBooleanLiteral({ value: false }) ||
    (path.isIdentifier({ name: "undefined" }) &&
      !path.scope.getBinding("undefined")) ||
    (path.isUnaryExpression({ operator: "void" }) &&
      path.get("argument").isNumericLiteral({ value: 0 }))
  );
}

function isExtractedResult(path: NodePath<t.Node>, seen: Set<t.Node>): boolean {
  if (seen.has(path.node)) return false;
  const next = new Set(seen).add(path.node);

  if (path.isMemberExpression())
    return isExtractedResult(path.get("object"), next);

  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return false;
  const init = binding.path.get("init");
  if (!init.isExpression()) return false;

  return init.isCallExpression()
    ? isExtractionCall(init.get("callee"), false)
    : isExtractedResult(init, next);
}

import { types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { getModuleReference } from "../commonjs/bindings.js";
import { isExtractionCall } from "../extractionCalls/index.js";
import { recipeRuntimeFactories } from "../optimizations/recipeFactories.js";
import { registerImportMethod } from "../utils.js";
import { analyzeCssPropSidecarHoistability } from "./modeAnalysis.js";
import { cssPropImportSource } from "./options.js";
import { everyPatternExpression } from "./patternExpressions.js";
import {
  getConfidentlyExecutedBranches,
  isSidecarSafeCssRuleExpression
} from "./sidecarSafety.js";

const runtimeCxBindings = new WeakMap<t.Program, Map<string, t.Identifier>>();
const preparedClassValues = new WeakSet<t.Node>();
const configuredCxCalls = new WeakSet<t.CallExpression>();
const sharedFactoryClasses = new WeakMap<t.VariableDeclarator, t.Identifier>();

/** Compiled stylesheet callables and extracted recipe results run in React. */
export function prepareRuntimeClassValue(path: NodePath<t.Node>): boolean {
  return visitCssValue(path, true);
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
    const cx = registerImportMethod(value, "cx", "@mincho-js/css/classname");
    value.replaceWith(t.callExpression(cx, [t.cloneNode(value.node)]));
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

  if (allowStyleBranches && isStaticRuleBranch(path)) {
    if (prepare) {
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
          init.node
        )
      )
        throw path.buildCodeFrameError(
          "Destructured CSS factory values must be statically evaluable. Keep runtime selections as individual CSS expressions or precompiled classes."
        );

      if (prepare) {
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
        for (const argument of path.get("arguments")) {
          prepareCxArgument(argument, next);
        }

        if (isExtractionCall(callee, false)) {
          // The configured macro can compile static cx calls. For runtime
          // inputs, serialize the callable so props and recipes stay in React.
          callee.replaceWith(runtimeCxBinding(path, reference.source));
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
  seen = new Set<t.Node>()
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
      next
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
    if (sharedFactoryClasses.has(binding.path.node)) return true;
    const init = binding.path.get("init");
    return init.isExpression() && containsStaticFactory(init, next);
  }
  if (path.isConditionalExpression()) {
    return (
      containsStaticFactory(path.get("consequent"), next) ||
      containsStaticFactory(path.get("alternate"), next)
    );
  }
  if (path.isLogicalExpression({ operator: "&&" })) {
    return containsStaticFactory(path.get("right"), next);
  }
  return (
    isStaticRuleBranch(path) ||
    (path.isCallExpression() &&
      isStaticCall(path) &&
      visitClassValue(path, seen, false))
  );
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

      if (isStaticRuleBranch(branch)) lowerStaticFactory(branch);
      else visitClassValue(branch, new Set(), true, branch, true);

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
  return (
    !hasRuntimeLocalBinding(path) &&
    !hasImportedArgumentCall(path) &&
    analyzeCssPropSidecarHoistability({
      expression: path.node,
      path,
      scope: path.scope
    }).kind === "hoistable"
  );
}

function hasImportedArgumentCall(path: NodePath<t.CallExpression>): boolean {
  // An import is available to the sidecar, but calling it can still read
  // render-time state. Preserve those calls as arguments to runtime recipes.
  const isImportedCall = (candidate: NodePath): boolean => {
    if (candidate.isCallExpression())
      return Boolean(getModuleReference(candidate.get("callee")));
    if (candidate.isOptionalCallExpression())
      return Boolean(getModuleReference(candidate.get("callee")));
    if (candidate.isNewExpression())
      return Boolean(getModuleReference(candidate.get("callee")));
    return false;
  };

  const containsImportedCall = (argument: NodePath): boolean => {
    if (argument.isExpression()) {
      const branches = getConfidentlyExecutedBranches(argument);
      if (branches) return branches.some(containsImportedCall);
    }
    if (isImportedCall(argument)) return true;

    let found = false;
    const visit = (candidate: NodePath) => {
      found ||= isImportedCall(candidate);
      if (found) candidate.stop();
    };
    argument.traverse({
      "ConditionalExpression|LogicalExpression"(inner) {
        if (!inner.isExpression()) return;
        const branches = getConfidentlyExecutedBranches(inner);
        if (!branches) return;

        found ||= branches.some(containsImportedCall);
        inner.skip();
        if (found) inner.stop();
      },
      CallExpression: visit,
      OptionalCallExpression: visit,
      NewExpression: visit
    });

    return found;
  };

  return path.get("arguments").some(containsImportedCall);
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
  );
}

function serializedRecipeReference(path: NodePath) {
  if (!path.isExpression()) {
    throw path.buildCodeFrameError("Expected a CSS recipe callable.");
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

  return t.callExpression(marker, [
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
  ]);
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

function runtimeCxBinding(path: NodePath<t.CallExpression>, source: string) {
  const program = path.scope.getProgramParent().path;
  if (!program.isProgram()) {
    throw path.buildCodeFrameError("Expected a program for configured cx.");
  }

  let bindings = runtimeCxBindings.get(program.node);
  if (!bindings) {
    bindings = new Map();
    runtimeCxBindings.set(program.node, bindings);
  }

  const existing = bindings.get(source);
  if (existing) return t.cloneNode(existing);

  const identifier = program.scope.generateUidIdentifier("runtimeCx");
  const marker = registerImportMethod(path, "mincho$");
  const cx = registerImportMethod(path, "cx", source);
  program.unshiftContainer(
    "body",
    t.variableDeclaration("const", [
      t.variableDeclarator(
        identifier,
        t.callExpression(marker, [t.arrowFunctionExpression([], cx)])
      )
    ])
  );
  bindings.set(source, identifier);

  return t.cloneNode(identifier);
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

import type { CallResultProof } from "../staticCssEval/sameFile/mutationAliases.js";
import { compiledRecipeResultProof } from "./compiledRecipeResult.js";
import {
  arrayMapResultProof,
  arrayIncludesResultProof
} from "./arrayMapResult.js";
import { sourceRecipeInvocationResult } from "./authoringCallSite.js";
import { hasRuntimeBinding } from "../optimizations/runtimeSourceReference.js";
import { mathNamespaceOwnReadProof, mathResultProof } from "./mathResult.js";
import type { NodePath, types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import { observePatternRealm } from "../optimizations/arrayMapIntrinsic.js";
import {
  createMathIntrinsicEnvironment,
  isDeterministicNumericMathMethod
} from "../optimizations/mathIntrinsic.js";
import { isProvenPrimitiveImport } from "../commonjs/bindings.js";
import {
  collectSkippedPatternDefaults,
  everyPatternExpression,
  type PatternSelectionEnvironment
} from "../jsxCssProp/patternExpressions.js";
import { branchEvaluationFacts } from "./evaluation.js";

/** One read-only decision. Discard before replacing any path or publishing a candidate. */
export function createReplayAnalysis(scope: NodePath["scope"]) {
  const program = scope.getProgramParent().path;
  if (!program.isProgram())
    throw new Error("Expected a program for replay analysis.");
  const graph = (program.scope as ProgramScope).minchoData?.extractCalls;
  const realm = graph?.arrayMapIntrinsics;
  let mathIntact: boolean | undefined;
  const closedMathCall = (call: NodePath<t.CallExpression>) => {
    const callee = call.get("callee");
    if (!callee.isMemberExpression({ computed: false })) return;
    const property = callee.get("property");
    if (
      !callee.get("object").isIdentifier({ name: "Math" }) ||
      hasRuntimeBinding(call, "Math") ||
      graph?.mathIntrinsics?.intact === false ||
      !property.isIdentifier() ||
      !isDeterministicNumericMathMethod(property.node.name) ||
      !call.get("arguments").every((arg) => arg.isNumericLiteral())
    )
      return;
    if (mathIntact === undefined) {
      const local = createMathIntrinsicEnvironment({
        bindIntact: graph?.mathIntrinsics?.bindIntact
      });
      mathIntact = local.provesPrimitiveResult(call);
    }
    if (!mathIntact) return;
    const result = call.evaluate();
    if (result.confident && typeof result.value === "number")
      return { value: result.value };
  };
  const branches = branchEvaluationFacts(program, closedMathCall);
  let localRealm: PatternSelectionEnvironment["localRealm"];
  const environment: PatternSelectionEnvironment = {
    get localRealm() {
      return (localRealm ??= {
        program,
        observation: observePatternRealm(program, branches)
      });
    },
    canReadPrimitiveImport: isProvenPrimitiveImport,
    nativeArrayIteration: (realm?.iterationIntact ?? realm?.intact) !== false,
    standardPrototypeAbsence:
      (realm?.prototypeAbsenceIntact ?? realm?.intact) !== false,
    prototypeMutationKeys: realm?.prototypeMutationKeys,
    requireReplaySafety: true
  };
  let skipped: ReadonlySet<t.AssignmentPattern> | undefined;
  const results = new WeakMap<t.Node, CallResultProof | null>();
  function artifactResult(
    call: NodePath<t.CallExpression | t.OptionalCallExpression>
  ) {
    if (!results.has(call.node))
      results.set(
        call.node,
        compiledRecipeResultProof(call) ??
          mathResultProof(call) ??
          arrayMapResultProof(call) ??
          arrayIncludesResultProof(call) ??
          null
      );
    return results.get(call.node) ?? undefined;
  }
  const sourceResults = new WeakMap<t.Node, CallResultProof | null>();
  return {
    branches,
    environment,
    closedMathCall,
    artifactResult,
    // A source-visible recipe result describes alias/value flow in JSX.
    // Required extraction separately proves its invocation and publication.
    jsxResult(call: NodePath<t.CallExpression | t.OptionalCallExpression>) {
      const artifact = artifactResult(call);
      if (artifact) return artifact;
      if (!sourceResults.has(call.node))
        sourceResults.set(
          call.node,
          sourceRecipeInvocationResult(call) ?? null
        );
      return sourceResults.get(call.node) ?? undefined;
    },
    everyPattern(
      ...[pattern, predicate, selected, skipped, extra]: Parameters<
        typeof everyPatternExpression
      >
    ) {
      const declaration = pattern.parentPath;
      const init = declaration?.isVariableDeclarator()
        ? declaration.get("init")
        : undefined;
      return everyPatternExpression(pattern, predicate, selected, skipped, {
        get localRealm() {
          return environment.localRealm;
        },
        canReadPrimitiveImport: isProvenPrimitiveImport,
        requireReplaySafety: true,
        nativeArrayIteration:
          environment.nativeArrayIteration &&
          extra?.nativeArrayIteration !== false,
        standardPrototypeAbsence:
          environment.standardPrototypeAbsence &&
          extra?.standardPrototypeAbsence !== false,
        prototypeMutationKeys: environment.prototypeMutationKeys,
        canReplayIteration: extra?.canReplayIteration,
        canReplayOwnRead: (source, operation) =>
          (source === selected &&
            init?.node === selected &&
            !!init?.isExpression() &&
            mathNamespaceOwnReadProof(init)) ||
          !!extra?.canReplayOwnRead?.(source, operation)
      });
    },
    skippedDefaults: {
      has(pattern: t.AssignmentPattern) {
        skipped ??= collectSkippedPatternDefaults(program, environment);
        return skipped.has(pattern);
      }
    }
  };
}

export type ReplayAnalysis = ReturnType<typeof createReplayAnalysis>;

export function everyReplayPattern(
  ...args: Parameters<typeof everyPatternExpression>
): boolean {
  return createReplayAnalysis(args[0].scope).everyPattern(...args);
}

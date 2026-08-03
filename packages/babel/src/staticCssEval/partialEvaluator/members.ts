import { types as t } from "@babel/core";
import type { PartialEvalDeoptResult, PartialEvalResult } from "./result.js";
import type { PartialEvalReducerNodeOptions } from "./reduction.js";
import { getStaticArrayMemberValue } from "./arrays.js";
import { getStaticStringOrNumberMemberName } from "./literals.js";
import { getStaticObjectMemberValue } from "./objects.js";

type PartialEvalStaticNameResult =
  | { readonly kind: "resolved"; readonly name: string }
  | { readonly kind: "deopt"; readonly result: PartialEvalDeoptResult };

export function reduceMemberExpression(
  options: PartialEvalReducerNodeOptions<
    t.MemberExpression | t.OptionalMemberExpression
  >
): PartialEvalResult {
  if (t.isOptionalMemberExpression(options.node)) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  if (t.isSuper(options.node.object)) {
    return options.runtime.createDeoptResult({
      expression: options.expression,
      reason: "runtime-css-shape"
    });
  }

  const objectResult = options.runtime.reduceExpression({
    expression: options.node.object,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (objectResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: objectResult
    });
  }

  const nameResult = reduceMemberName({ ...options, node: options.node });

  if (nameResult.kind === "deopt") {
    return options.runtime.createDeoptFromChild({
      expression: options.expression,
      result: nameResult.result
    });
  }

  const target = objectResult.expression;
  const memberValue = t.isObjectExpression(target)
    ? getStaticObjectMemberValue(target, nameResult.name)
    : t.isArrayExpression(target)
      ? getStaticArrayMemberValue(target, nameResult.name)
      : null;

  return memberValue
    ? options.runtime.createConfidentResult(t.cloneNode(memberValue))
    : options.runtime.createDeoptResult({
        expression: options.expression,
        reason: "runtime-css-shape"
      });
}

function reduceMemberName(
  options: PartialEvalReducerNodeOptions<t.MemberExpression>
): PartialEvalStaticNameResult {
  if (!options.node.computed && t.isIdentifier(options.node.property)) {
    return { kind: "resolved", name: options.node.property.name };
  }

  if (!t.isExpression(options.node.property)) {
    return {
      kind: "deopt",
      result: options.runtime.createDeoptResult({
        expression: options.node,
        reason: "unsupported-computed-member"
      })
    };
  }

  const keyResult = options.runtime.reduceExpression({
    expression: options.node.property,
    depth: options.depth + 1,
    reductionContext: options.reductionContext
  });

  if (keyResult.kind === "deopt") {
    return {
      kind: "deopt",
      result: options.runtime.createDeoptFromChild({
        expression: options.node,
        result: keyResult,
        reason: options.runtime.getContextualDeoptReason(
          keyResult,
          "unsupported-computed-member"
        )
      })
    };
  }

  const memberName = getStaticStringOrNumberMemberName(keyResult.expression);

  return memberName === null
    ? {
        kind: "deopt",
        result: options.runtime.createDeoptResult({
          expression: options.node,
          reason: "unsupported-computed-member"
        })
      }
    : { kind: "resolved", name: String(memberName) };
}

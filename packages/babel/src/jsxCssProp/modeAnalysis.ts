import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import { isSidecarSafeCssRuleExpression } from "./sidecarSafety.js";
import {
  getSidecarCssRuleClassification,
  hasSidecarBranch
} from "./sidecarShape.js";
import type { CssPropSidecarHoistability } from "./types.js";

type AnalysisScope = NodePath<t.JSXOpeningElement>["scope"];

export function analyzeCssPropSidecarHoistability(options: {
  readonly expression: t.Expression;
  readonly scope: AnalysisScope;
}): CssPropSidecarHoistability {
  const cssValueClassification = getSidecarCssRuleClassification(
    options.expression,
    options.scope
  );

  if (!cssValueClassification) {
    return { kind: "not-candidate" };
  }

  const safe = isSidecarSafeCssRuleExpression({
    expression: options.expression,
    state: {
      scope: options.scope,
      visiting: new Set(),
      localNames: new Set()
    }
  });

  return safe
    ? { kind: "hoistable", cssValueClassification }
    : { kind: "unsafe" };
}

export { getSidecarCssRuleClassification, hasSidecarBranch };

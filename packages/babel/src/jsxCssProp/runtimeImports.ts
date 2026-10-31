import { types as t } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import {
  createStaticCssEvalCandidate,
  getStaticCssEvalMemberReference
} from "../staticCssEval/candidates.js";
import type {
  StaticCssEvalProvider,
  StaticCssEvalResult
} from "../staticCssEval/types.js";

const runtimeImports = new WeakSet<Binding>();

export function isRuntimeCssImport(binding: Binding): boolean {
  return runtimeImports.has(binding);
}

/** Only scalar positions may fall back; unknown rule shapes still fail closed. */
export function prepareRuntimeCssImports(
  expression: t.Expression,
  scope: Scope,
  owner: string,
  provider: StaticCssEvalProvider | undefined,
  observe: (result: StaticCssEvalResult) => void
): void {
  if (t.isObjectExpression(expression)) {
    for (const property of expression.properties) {
      if (
        t.isObjectProperty(property) &&
        !property.computed &&
        t.isExpression(property.value)
      )
        prepareRuntimeCssImports(
          property.value,
          scope,
          owner,
          provider,
          observe
        );
    }
    return;
  }
  if (t.isArrayExpression(expression)) {
    for (const element of expression.elements) {
      if (element && t.isExpression(element))
        prepareRuntimeCssImports(element, scope, owner, provider, observe);
    }
    return;
  }
  if (t.isConditionalExpression(expression)) {
    prepareRuntimeCssImports(
      expression.consequent,
      scope,
      owner,
      provider,
      observe
    );
    prepareRuntimeCssImports(
      expression.alternate,
      scope,
      owner,
      provider,
      observe
    );
    return;
  }
  if (t.isLogicalExpression(expression) || t.isBinaryExpression(expression)) {
    if (t.isExpression(expression.left))
      prepareRuntimeCssImports(
        expression.left,
        scope,
        owner,
        provider,
        observe
      );
    prepareRuntimeCssImports(expression.right, scope, owner, provider, observe);
    return;
  }
  if (t.isTemplateLiteral(expression)) {
    for (const element of expression.expressions)
      if (t.isExpression(element))
        prepareRuntimeCssImports(element, scope, owner, provider, observe);
    return;
  }

  const reference = getStaticCssEvalMemberReference(expression);
  if (reference?.kind !== "supported") return;
  const binding = scope.getBinding(reference.bindingName);
  if (
    !binding ||
    !(
      binding.path.isImportSpecifier() ||
      binding.path.isImportDefaultSpecifier() ||
      binding.path.isImportNamespaceSpecifier()
    )
  )
    return;
  const candidate = createStaticCssEvalCandidate(expression, owner);
  if (!candidate) return;
  const result = provider?.getResolvedCssValue(candidate) ?? {
    kind: "not-candidate" as const
  };
  if (result.kind === "resolved") return;
  if (
    result.kind === "error" &&
    (result.diagnostic.id === "STATIC_CSS_EVAL_TDZ" ||
      result.diagnostic.id === "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED" ||
      result.diagnostic.id === "STATIC_CSS_EVAL_UNRESOLVED_IMPORT" ||
      result.diagnostic.code === "limit-exceeded" ||
      result.diagnostic.code === "cycle-detected")
  )
    return;
  observe(result);
  runtimeImports.add(binding);
}

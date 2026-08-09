import type { NodePath, types as t } from "@babel/core";
import type { PluginState } from "./types.js";
import {
  countClassOperands,
  countConditions,
  collectSupportedOperands
} from "./defineRulesCxConditionsOperands.js";
import {
  isGeneratedDefineRulesCxConditionsCall,
  optimizeDefineRulesCxConditionsCallExpression
} from "./defineRulesCxConditionsCodegen.js";
import { getExpressionRange } from "./defineRulesCxConditionsProvider.js";
import { resolveDefineRulesCxRuntime } from "./defineRulesCxConditionsRuntime.js";
import type { DefineRulesCxConditionsMetadata } from "./defineRulesCxConditionsTypes.js";

export { DEFINE_RULES_CX_CONDITIONS_METADATA_KEY } from "./defineRulesCxConditionsTypes.js";
export type {
  DefineRulesCxConditionsCallMetadata,
  DefineRulesCxConditionsMetadata,
  DefineRulesCxOperandMetadata
} from "./defineRulesCxConditionsTypes.js";

export const defineRulesCxConditionsOptimizationMetadataKey =
  "minchoDefineRulesCxConditionsOptimization";

export function isDefineRulesCxConditionsEnabled(state: PluginState): boolean {
  return state.opts.optimize?.defineRulesCxConditions === true;
}

export function analyzeDefineRulesCxConditionsCallExpression(
  path: NodePath<t.CallExpression>,
  state: PluginState
): void {
  if (!isDefineRulesCxConditionsEnabled(state)) {
    return;
  }

  if (isGeneratedDefineRulesCxConditionsCall(path)) {
    return;
  }

  const runtime = resolveDefineRulesCxRuntime(path, state);

  if (runtime === null) {
    return;
  }

  const operands = collectSupportedOperands(
    path.get("arguments"),
    runtime,
    state
  );

  if (operands === null) {
    return;
  }

  const callRange = getExpressionRange(path.node);

  if (callRange === null) {
    return;
  }

  const callMetadata = {
    callee: runtime.callee,
    ...callRange,
    operandCount: path.node.arguments.length,
    conditionCount: countConditions(operands),
    classOperandCount: countClassOperands(operands),
    operands
  };

  getOrCreateDefineRulesCxConditionsMetadata(state).calls.push(callMetadata);
  optimizeDefineRulesCxConditionsCallExpression(
    path,
    callMetadata.operands,
    runtime
  );
}

function getOrCreateDefineRulesCxConditionsMetadata(
  state: PluginState
): DefineRulesCxConditionsMetadata {
  const existing = state.file.metadata.minchoDefineRulesCxConditions;

  if (existing !== undefined) {
    return existing;
  }

  const metadata: DefineRulesCxConditionsMetadata = { calls: [] };
  state.file.metadata.minchoDefineRulesCxConditions = metadata;
  return metadata;
}

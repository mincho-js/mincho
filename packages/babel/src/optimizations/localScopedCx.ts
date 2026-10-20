import { createRequire } from "node:module";
import type { NodePath, types as t } from "@babel/core";
import { createModuleGraph } from "../moduleGraph.js";
import { createClassStringBudget } from "./classNameTables.js";
import { analyzeScopedCx, pruneScopedCxFactories } from "./scopedCx.js";
import { applyPureFunctions, preserveModuleEffects } from "./pureFunctions.js";
import { hasDynamicScope } from "./dynamicScope.js";
import { hasObservablePrototypeMutation } from "./recipeMetadata.js";

// Load the runtime only for explicit, proved local calls.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Rollup rewrites import.meta.url for CommonJS.
const require = createRequire(import.meta.url);

export function optimizeLocalScopedCx(
  program: NodePath<t.Program>,
  filename: string
) {
  const budget = createClassStringBudget();
  if (hasDynamicScope(program) || hasObservablePrototypeMutation(program))
    return budget;

  const owner = { id: filename, program };
  const graph = createModuleGraph();
  graph.modules.set(filename, owner);

  const flow = analyzeScopedCx(graph, owner);
  let step = flow.next();

  while (!step.done) step = flow.next(null);

  if (!step.value.length) return budget;

  const { createCompiledDefineRulesCxRuntime } =
    require("@mincho-js/css/defineRules/createDefineRulesCxRuntime") as typeof import("@mincho-js/css/defineRules/createDefineRulesCxRuntime");

  const replacements: { key: string; expression: t.Expression }[] = [];

  for (const call of step.value) {
    try {
      const runtime = createCompiledDefineRulesCxRuntime(call.artifact);
      const value = runtime(...(call.args as Parameters<typeof runtime>));
      if (!budget.entries || value.length > budget.units) continue;

      replacements.push({
        key: call.key,
        expression: { type: "StringLiteral", value }
      });
      budget.entries--;
      budget.units -= value.length;
    } catch {
      // Optional folding must leave unsupported calls intact.
    }
  }

  preserveModuleEffects(program, () => {
    applyPureFunctions(program, {
      replacements,
      dependencies: [],
      diagnostics: []
    });
    pruneScopedCxFactories(program);
  });

  return budget;
}

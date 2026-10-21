import { createVar } from "./compilerResources.js";
import { getVarName } from "./utils.js";

/** @internal Build-only factoring, after generated variable names are known. */
export function factorCssBooleanGates<T extends object>(rule: T): T {
  const occurrences = new Map<
    string,
    { object: Record<string, unknown>; key: string }[]
  >();

  function walk(object: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(object)) {
      if (key === "vars") continue;

      if (value && typeof value === "object" && !Array.isArray(value))
        walk(value as Record<string, unknown>);
      else if (typeof value === "string" && value.startsWith("var(")) {
        const uses = occurrences.get(value) ?? [];
        uses.push({ object, key });
        occurrences.set(value, uses);
      }
    }
  }

  walk(rule as Record<string, unknown>);

  const bytes = (value: string) => new TextEncoder().encode(value).length;

  for (const [expression, uses] of occurrences) {
    if (uses.length < 2) continue;

    const reference = createVar("gate-expression");
    const key = getVarName(reference);
    if (
      (bytes(expression) - bytes(reference)) * uses.length <=
      bytes(key) + bytes(expression) + 2
    )
      continue;

    const vars = ((rule as { vars?: Record<string, string> }).vars ??= {});
    vars[reference] = expression;

    for (const use of uses) use.object[use.key] = reference;
  }

  return rule;
}

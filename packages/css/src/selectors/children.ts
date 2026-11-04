import { readCondition } from "./condition.js";
import type { Condition } from "./condition.js";
import { elementSelectors, stringify } from "./syntax.js";
import type { Selector } from "./types.js";

/** Compile subject-local predicates against the same filtered sibling group. */
function predicate(condition: Condition, item: string): string {
  const node = readCondition(condition);
  switch (node.kind) {
    case "position":
      return `:nth-${node.end ? "last-" : ""}child(${node.formula} of ${item})`;
    case "quantity": {
      // Only the first matching sibling can witness the group's total size.
      // Its following matching siblings share the same quantity predicate.
      const first = `:nth-child(1 of ${item}):nth-last-child(${node.formula} of ${item})`;
      return `:is(${first}, ${first} ~ :is(${item}))`;
    }
    case "all":
      return node.conditions.map((value) => predicate(value, item)).join("");
    case "any":
    case "none": {
      if (!node.conditions.length) return node.kind === "any" ? ":not(*)" : "";
      const values = node.conditions.map(
        (value) => predicate(value, item) || "*"
      );
      return `:${node.kind === "any" ? "is" : "not"}(${values.join(", ")})`;
    }
  }
}

/** Apply a condition to direct children matching item, counting only that group. */
export function children(
  parent: Selector,
  item: Selector,
  condition: Condition
): Selector {
  const parents = elementSelectors(parent, false, true);
  const items = elementSelectors(item);
  const group = stringify(items);
  const subject =
    items.length === 1 &&
    items[0].nodes.every((node) => node.type !== "combinator")
      ? group
      : `:is(${group})`;
  const filter = predicate(condition, group);
  return parents
    .map((value) => `${value.toString()} > ${subject}${filter}`)
    .join(", ");
}

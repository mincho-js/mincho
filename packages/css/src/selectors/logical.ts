import { combine } from "./condition.js";
import type { Condition } from "./condition.js";

/** Empty AND matches every member of the group. */
export function all(...conditions: Condition[]): Condition {
  return combine("all", conditions);
}

/** Empty OR matches no members. */
export function any(...conditions: Condition[]): Condition {
  return combine("any", conditions);
}

/** Empty NOT ANY matches every member. */
export function none(...conditions: Condition[]): Condition {
  return combine("none", conditions);
}

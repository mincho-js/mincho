import { combine, createCondition, integer } from "./condition.js";
import type { Condition } from "./condition.js";

function quantity(formula: string): Condition {
  return createCondition({ kind: "quantity", formula });
}

export function count(n: number): Condition {
  return quantity(`${integer(n, 0, "n")}`);
}

export function countAtLeast(n: number): Condition {
  return quantity(`n+${integer(n, 0, "n")}`);
}

export function countAtMost(n: number): Condition {
  return quantity(`-n+${integer(n, 0, "n")}`);
}

/** Match a group strictly larger than n without overflowing safe integer bounds. */
export function countOver(n: number): Condition {
  integer(n, 0, "n");
  return n === Number.MAX_SAFE_INTEGER
    ? combine("any", [])
    : countAtLeast(n + 1);
}

/** Match a group strictly smaller than n; a negative count is never possible. */
export function countUnder(n: number): Condition {
  integer(n, 0, "n");
  return n === 0 ? combine("any", []) : countAtMost(n - 1);
}

/** Match groups whose total count lies within both inclusive bounds. */
export function countBetween(a: number, b: number): Condition {
  integer(a, 0, "a");
  integer(b, a, "b");
  return combine("all", [countAtLeast(a), countAtMost(b)]);
}

export function countMultipleOf(n: number): Condition {
  return quantity(`${integer(n, 1, "n")}n`);
}

export function countOdd(): Condition {
  return quantity("odd");
}

export function countEven(): Condition {
  return quantity("even");
}

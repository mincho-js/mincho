import { combine, createCondition, fromEnd, integer } from "./condition.js";
import type { Condition, EveryOptions, PositionOptions } from "./condition.js";

function position(formula: string, end = false): Condition {
  return createCondition({ kind: "position", formula, end });
}

export function first(n = 1): Condition {
  return position(`-n+${integer(n, 1, "n")}`);
}

export function last(n = 1): Condition {
  return position(`-n+${integer(n, 1, "n")}`, true);
}

export function nth(n: number): Condition {
  return position(`${integer(n, 1, "n")}`);
}

export function nthLast(n: number): Condition {
  return position(`${integer(n, 1, "n")}`, true);
}

export function from(n: number): Condition {
  return position(`n+${integer(n, 1, "n")}`);
}

export function before(n: number): Condition {
  return position(`-n+${integer(n, 1, "n") - 1}`);
}

/** Select positions strictly after n; an unrepresentable next index matches none. */
export function after(n: number): Condition {
  integer(n, 1, "n");
  return n === Number.MAX_SAFE_INTEGER ? combine("any", []) : from(n + 1);
}

/** Select an inclusive 1-based range, optionally counted from the group's end. */
export function between(
  a: number,
  b: number,
  options: PositionOptions = {}
): Condition {
  integer(a, 1, "a");
  integer(b, a, "b");
  const end = fromEnd(options);
  return combine("all", [position(`n+${a}`, end), position(`-n+${b}`, end)]);
}

/** Select startAt + k*n for k >= 0, counting from the requested end. */
export function every(n: number, options: EveryOptions = {}): Condition {
  integer(n, 1, "n");
  const end = fromEnd(options);
  const start = integer(
    options.startAt === undefined ? n : options.startAt,
    1,
    "startAt"
  );
  return position(`${n}n+${start}`, end);
}

export function odd(): Condition {
  return position("odd");
}

export function even(): Condition {
  return position("even");
}

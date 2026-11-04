// ESM and CJS consumers may exchange conditions. Share the data key while
// keeping the public type structural across the two declaration entry trees.
const conditionNode = Symbol.for("mincho.selector.condition");

type ConditionNode =
  | {
      readonly kind: "position";
      readonly formula: string;
      readonly end: boolean;
    }
  | { readonly kind: "quantity"; readonly formula: string }
  | {
      readonly kind: "all" | "any" | "none";
      readonly conditions: readonly Condition[];
    };

/** An immutable predicate on a filtered sibling group, applied by children(). */
export interface Condition {
  readonly [Symbol.toStringTag]: "MinchoSelectorCondition";
}

type ConditionValue = Condition & { readonly [conditionNode]: ConditionNode };

export interface PositionOptions {
  readonly from?: "start" | "end";
}

export interface EveryOptions extends PositionOptions {
  /** First selected position, counted from `from`. Defaults to the interval. */
  readonly startAt?: number;
}

/** Reject fractional, non-finite, unsafe or below-bound indices before arithmetic. */
export function integer(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

/** Validate the direction even for JavaScript consumers without static types. */
export function fromEnd(options: PositionOptions): boolean {
  if (
    !options ||
    typeof options !== "object" ||
    (options.from !== undefined &&
      options.from !== "start" &&
      options.from !== "end")
  )
    throw new TypeError('from must be "start" or "end"');
  return options.from === "end";
}

/** Freeze a predicate and expose it across the ESM and CJS package instances. */
export function createCondition(node: ConditionNode): Condition {
  return Object.freeze({
    [Symbol.toStringTag]: "MinchoSelectorCondition" as const,
    [conditionNode]: Object.freeze(node)
  });
}

/** Read the shared predicate data, rejecting selectors supplied as strings. */
export function readCondition(condition: Condition): ConditionNode {
  if (
    !condition ||
    typeof condition !== "object" ||
    !(conditionNode in condition)
  )
    throw new TypeError(
      "Expected a selectors Condition; use children() to apply it"
    );
  return (condition as ConditionValue)[conditionNode];
}

/** Validate and copy children so later caller mutations cannot alter a predicate. */
export function combine(
  kind: "all" | "any" | "none",
  conditions: readonly Condition[]
): Condition {
  conditions.forEach(readCondition);
  return createCondition({ kind, conditions: Object.freeze([...conditions]) });
}

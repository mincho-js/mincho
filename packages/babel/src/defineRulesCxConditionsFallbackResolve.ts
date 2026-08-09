import type {
  ClassPlan,
  CssWrite,
  FallbackExpression,
  FallbackOperandPlan,
  FallbackResolvedWrite
} from "./defineRulesCxConditionsFallbackTypes.js";

type ChainState = {
  readonly value: FallbackExpression;
};

export function createFallbackResolvedWrites(
  operands: readonly FallbackOperandPlan[]
): readonly FallbackResolvedWrite[] | null {
  const propertyCounts = countWriteProperties(operands);
  const candidateProperties = new Set(
    [...propertyCounts]
      .filter(([, count]) => count > 1)
      .map(([property]) => property)
  );

  if (candidateProperties.size === 0) {
    return null;
  }

  const states = new Map<string, ChainState>();

  for (const operand of operands) {
    if (!applyOperandWrites(operand, candidateProperties, states)) {
      return null;
    }
  }

  return collectResolvedWrites(candidateProperties, states);
}

function collectResolvedWrites(
  candidateProperties: ReadonlySet<string>,
  states: ReadonlyMap<string, ChainState>
): readonly FallbackResolvedWrite[] | null {
  const resolvedWrites: FallbackResolvedWrite[] = [];

  for (const property of candidateProperties) {
    const state = states.get(property);

    if (state === undefined) {
      return null;
    }

    resolvedWrites.push({ property, value: state.value });
  }

  return resolvedWrites;
}

function countWriteProperties(
  operands: readonly FallbackOperandPlan[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const operand of operands) {
    countOperandWriteProperties(operand, counts);
  }

  return counts;
}

function countOperandWriteProperties(
  operand: FallbackOperandPlan,
  counts: Map<string, number>
): void {
  switch (operand.kind) {
    case "class":
      countClassWriteProperties(operand.classOperand, counts);
      return;
    case "condition":
      countClassWriteProperties(operand.classOperand, counts);
      return;
    case "ternary":
      countClassWriteProperties(operand.consequent, counts);
      countClassWriteProperties(operand.alternate, counts);
      return;
    case "array":
      for (const child of operand.operands) {
        countOperandWriteProperties(child, counts);
      }
      return;
  }
}

function countClassWriteProperties(
  classPlan: ClassPlan,
  counts: Map<string, number>
): void {
  for (const write of classPlan.writes) {
    counts.set(write.property, (counts.get(write.property) ?? 0) + 1);
  }
}

function applyOperandWrites(
  operand: FallbackOperandPlan,
  candidateProperties: ReadonlySet<string>,
  states: Map<string, ChainState>
): boolean {
  switch (operand.kind) {
    case "class":
      applyAlwaysWrites(operand.classOperand, candidateProperties, states);
      return true;
    case "condition":
      return applyConditionWrites(
        operand.classOperand,
        operand.conditionIndex,
        candidateProperties,
        states
      );
    case "ternary":
      return applyTernaryWrites(operand, candidateProperties, states);
    case "array":
      for (const child of operand.operands) {
        if (!applyOperandWrites(child, candidateProperties, states)) {
          return false;
        }
      }
      return true;
  }
}

function applyAlwaysWrites(
  classPlan: ClassPlan,
  candidateProperties: ReadonlySet<string>,
  states: Map<string, ChainState>
): void {
  for (const write of classPlan.writes) {
    if (candidateProperties.has(write.property)) {
      states.set(write.property, { value: write.value });
    }
  }
}

function applyConditionWrites(
  classPlan: ClassPlan,
  conditionIndex: number,
  candidateProperties: ReadonlySet<string>,
  states: Map<string, ChainState>
): boolean {
  for (const write of classPlan.writes) {
    if (!candidateProperties.has(write.property)) {
      continue;
    }

    const previous = states.get(write.property);

    if (previous === undefined) {
      return false;
    }

    states.set(write.property, {
      value: {
        kind: "condition",
        conditionIndex,
        whenTrue: write.value,
        whenFalse: previous.value
      }
    });
  }

  return true;
}

function applyTernaryWrites(
  operand: Extract<FallbackOperandPlan, { readonly kind: "ternary" }>,
  candidateProperties: ReadonlySet<string>,
  states: Map<string, ChainState>
): boolean {
  const consequentWrites = groupWritesByProperty(operand.consequent.writes);
  const alternateWrites = groupWritesByProperty(operand.alternate.writes);
  const properties = new Set([
    ...Object.keys(consequentWrites),
    ...Object.keys(alternateWrites)
  ]);

  for (const property of properties) {
    if (!candidateProperties.has(property)) {
      continue;
    }

    const previous = states.get(property);
    const whenTrue = consequentWrites[property] ?? previous?.value;
    const whenFalse = alternateWrites[property] ?? previous?.value;

    if (whenTrue === undefined || whenFalse === undefined) {
      return false;
    }

    states.set(property, {
      value: {
        kind: "condition",
        conditionIndex: operand.conditionIndex,
        whenTrue,
        whenFalse
      }
    });
  }

  return true;
}

function groupWritesByProperty(
  writes: readonly CssWrite[]
): Record<string, FallbackExpression> {
  const grouped: Record<string, FallbackExpression> = Object.create(null);

  for (const write of writes) {
    grouped[write.property] = write.value;
  }

  return grouped;
}

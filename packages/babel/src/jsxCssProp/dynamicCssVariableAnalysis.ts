import type { NodePath } from "@babel/core";
import { types as t } from "@babel/core";
import { isNestedCssObjectKey } from "../cssProperty.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { invariant } from "../utils.js";
import {
  getStaticObjectPropertyKeyName,
  isStaticCssPrimitiveExpression,
  isStaticCssShapeExpression
} from "./expressionShape.js";
import { isSidecarSafeCssRuleExpression } from "./sidecarSafety.js";
import type {
  DynamicCssVariableDirectRule,
  DynamicCssVariableLeaf,
  DynamicCssVariableRule,
  DynamicCssVariableValueFragment
} from "./types.js";

type DynamicCssVariableDeclarationBranchExpression =
  | t.ConditionalExpression
  | t.LogicalExpression;

export function getDynamicCssVariableRule(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const expression =
    createDynamicCssVariableDeclarationBranchExpression(options) ??
    options.expression;

  const rule = collectDynamicCssVariableRule({
    expression,
    scope: options.scope
  });

  if (!rule || rule.fragment.leaves.length === 0) {
    return null;
  }

  return rule;
}

function collectDynamicCssVariableRule(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const unwrappedExpression = unwrapTransparentCssRuleExpression(
    options.expression
  );

  if (
    t.isObjectExpression(unwrappedExpression) ||
    t.isArrayExpression(unwrappedExpression)
  ) {
    return collectDirectDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  if (t.isConditionalExpression(unwrappedExpression)) {
    return collectConditionalDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  if (t.isLogicalExpression(unwrappedExpression)) {
    return collectLogicalDynamicCssVariableRule({
      expression: unwrappedExpression,
      scope: options.scope
    });
  }

  return null;
}

function collectDirectDynamicCssVariableRule(options: {
  readonly expression: t.ObjectExpression | t.ArrayExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDirectRule | null {
  const result = t.isObjectExpression(options.expression)
    ? collectDynamicCssVariableObjectExpression({
        expression: options.expression,
        declarationName: null,
        scope: options.scope
      })
    : collectDynamicCssVariableArrayExpression({
        expression: options.expression,
        scope: options.scope
      });

  if (!result) {
    return null;
  }

  return {
    kind: "direct",
    fragment: {
      kind: "static-fragment",
      expression: result.expression,
      leaves: result.leaves
    }
  };
}

function collectConditionalDynamicCssVariableRule(options: {
  readonly expression: t.ConditionalExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const consequent = collectDynamicCssVariableRule({
    expression: options.expression.consequent,
    scope: options.scope
  });

  const alternate = collectDynamicCssVariableRule({
    expression: options.expression.alternate,
    scope: options.scope
  });

  if (!consequent || !alternate) {
    return null;
  }

  const expression = t.conditionalExpression(
    t.cloneNode(options.expression.test),
    t.cloneNode(consequent.fragment.expression),
    t.cloneNode(alternate.fragment.expression)
  );

  const leaves = [...consequent.fragment.leaves, ...alternate.fragment.leaves];
  const branches = [consequent, alternate];

  return {
    kind: "branch",
    branches,
    fragment: {
      kind: "dynamic-branch-fragment",
      expression,
      leaves,
      branches: branches.map((branch) => branch.fragment)
    }
  };
}

function collectLogicalDynamicCssVariableRule(options: {
  readonly expression: t.LogicalExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableRule | null {
  const right = collectDynamicCssVariableRule({
    expression: options.expression.right,
    scope: options.scope
  });

  if (!right) {
    return null;
  }

  const expression = t.logicalExpression(
    options.expression.operator,
    t.cloneNode(options.expression.left),
    t.cloneNode(right.fragment.expression)
  );

  return {
    kind: "branch",
    branches: [right],
    fragment: {
      kind: "dynamic-branch-fragment",
      expression,
      leaves: right.fragment.leaves,
      branches: [right.fragment]
    }
  };
}

type DynamicCssVariableObjectWalkResult = {
  readonly expression: t.ObjectExpression;
  readonly leaves: readonly DynamicCssVariableLeaf[];
};

type DynamicCssVariableArrayWalkResult = {
  readonly expression: t.ArrayExpression;
  readonly leaves: readonly DynamicCssVariableLeaf[];
};

function collectDynamicCssVariableObjectExpression(options: {
  readonly expression: t.ObjectExpression;
  readonly declarationName: string | null;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableObjectWalkResult | null {
  const properties: t.ObjectExpression["properties"] = [];
  const leaves: DynamicCssVariableLeaf[] = [];

  for (const property of options.expression.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      property.shorthand ||
      !t.isExpression(property.value)
    ) {
      return null;
    }

    const propertyName = getStaticObjectPropertyKeyName(property.key);

    if (!propertyName) {
      return null;
    }

    const value = unwrapTransparentCssRuleExpression(property.value);
    const nextProperty = t.cloneNode(property);
    nextProperty.shorthand = false;

    if (t.isObjectExpression(value)) {
      const nestedResult = collectDynamicCssVariableObjectExpression({
        expression: value,
        declarationName: getNestedDeclarationName({
          propertyName,
          declarationName: options.declarationName
        }),
        scope: options.scope
      });

      if (!nestedResult) {
        return null;
      }

      nextProperty.value = nestedResult.expression;
      properties.push(nextProperty);
      leaves.push(...nestedResult.leaves);
      continue;
    }

    if (t.isArrayExpression(value)) {
      if (!isStaticCssShapeExpression(value)) {
        return null;
      }

      nextProperty.value = t.cloneNode(property.value);
      properties.push(nextProperty);
      continue;
    }

    if (isStaticCssPrimitiveExpression(value)) {
      nextProperty.value = t.cloneNode(property.value);
      properties.push(nextProperty);
      continue;
    }

    const leafPropertyName = getLeafDeclarationName({
      propertyName,
      declarationName: options.declarationName
    });

    const valueFragment = collectDynamicCssVariableValueFragment({
      expression: property.value,
      scope: options.scope
    });

    if (!leafPropertyName || !valueFragment) {
      return null;
    }

    const leaf: DynamicCssVariableLeaf = {
      propertyName: leafPropertyName,
      valueFragment,
      variableIdentifier: t.identifier("minchoDynamicCssVariable")
    };

    nextProperty.value = leaf.variableIdentifier;
    properties.push(nextProperty);
    leaves.push(leaf);
  }

  return { expression: t.objectExpression(properties), leaves };
}

function collectDynamicCssVariableArrayExpression(options: {
  readonly expression: t.ArrayExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableArrayWalkResult | null {
  const elements: t.ArrayExpression["elements"] = [];
  const leaves: DynamicCssVariableLeaf[] = [];

  for (const element of options.expression.elements) {
    if (!element || t.isSpreadElement(element)) {
      return null;
    }

    const value = unwrapTransparentCssRuleExpression(element);

    if (!t.isObjectExpression(value)) {
      return null;
    }

    const elementResult = collectDynamicCssVariableObjectExpression({
      expression: value,
      declarationName: null,
      scope: options.scope
    });

    if (!elementResult) {
      return null;
    }

    elements.push(elementResult.expression);
    leaves.push(...elementResult.leaves);
  }

  return { expression: t.arrayExpression(elements), leaves };
}

export function createDynamicCssVariableDeclarationBranchExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  let expression =
    createDynamicCssVariableDeclarationBranchExpressionOnce(options);

  if (!expression) {
    return null;
  }

  for (let depth = 1; depth < 64; depth += 1) {
    const nextExpression =
      createDynamicCssVariableDeclarationBranchExpressionOnce({
        expression,
        scope: options.scope
      });

    if (!nextExpression) {
      return expression;
    }

    expression = nextExpression;
  }

  return expression;
}

function createDynamicCssVariableDeclarationBranchExpressionOnce(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isObjectExpression(expression)) {
    return createDynamicCssVariableObjectDeclarationBranchExpression({
      expression,
      scope: options.scope
    });
  }

  if (t.isArrayExpression(expression)) {
    return createDynamicCssVariableArrayDeclarationBranchExpression({
      expression,
      scope: options.scope
    });
  }

  if (t.isConditionalExpression(expression)) {
    const consequent = createDynamicCssVariableDeclarationBranchExpression({
      expression: expression.consequent,
      scope: options.scope
    });

    const alternate = createDynamicCssVariableDeclarationBranchExpression({
      expression: expression.alternate,
      scope: options.scope
    });

    if (!consequent && !alternate) {
      return null;
    }

    return t.conditionalExpression(
      t.cloneNode(expression.test),
      consequent ?? t.cloneNode(expression.consequent),
      alternate ?? t.cloneNode(expression.alternate)
    );
  }

  if (t.isLogicalExpression(expression)) {
    const left = createDynamicCssVariableDeclarationBranchExpression({
      expression: expression.left,
      scope: options.scope
    });

    const right = createDynamicCssVariableDeclarationBranchExpression({
      expression: expression.right,
      scope: options.scope
    });

    if (!left && !right) {
      return null;
    }

    return t.logicalExpression(
      expression.operator,
      left ?? t.cloneNode(expression.left),
      right ?? t.cloneNode(expression.right)
    );
  }

  return null;
}

function createDynamicCssVariableObjectDeclarationBranchExpression(options: {
  readonly expression: t.ObjectExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  for (
    let propertyIndex = 0;
    propertyIndex < options.expression.properties.length;
    propertyIndex += 1
  ) {
    const property = options.expression.properties[propertyIndex];

    if (property && t.isSpreadElement(property)) {
      const branchExpression =
        createDynamicCssVariableObjectSpreadBranchExpression({
          expression: options.expression,
          propertyIndex,
          spread: property,
          scope: options.scope
        });

      if (branchExpression) {
        return branchExpression;
      }

      return null;
    }

    if (
      !property ||
      !t.isObjectProperty(property) ||
      property.computed ||
      property.shorthand ||
      !t.isExpression(property.value) ||
      !getStaticObjectPropertyKeyName(property.key)
    ) {
      return null;
    }

    const valueBranch =
      createDynamicCssVariableDeclarationValueBranchExpression({
        expression: property.value,
        scope: options.scope
      });

    const nestedBranch =
      valueBranch ??
      createDynamicCssVariableDeclarationBranchExpression({
        expression: property.value,
        scope: options.scope
      });

    if (nestedBranch) {
      return createDynamicCssVariableObjectPropertyBranchExpression({
        expression: options.expression,
        propertyIndex,
        branchExpression: nestedBranch
      });
    }
  }

  return null;
}

function createDynamicCssVariableObjectSpreadBranchExpression(options: {
  readonly expression: t.ObjectExpression;
  readonly propertyIndex: number;
  readonly spread: t.SpreadElement;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  const argument = unwrapTransparentCssRuleExpression(options.spread.argument);

  if (t.isLogicalExpression(argument)) {
    if (argument.operator !== "&&" && argument.operator !== "||") {
      return null;
    }

    const fragment = getDynamicCssVariableObjectSpreadFragment({
      expression: argument.right,
      scope: options.scope
    });

    if (!fragment) {
      return null;
    }

    const withFragment = createObjectExpressionWithSpreadFragment({
      expression: options.expression,
      propertyIndex: options.propertyIndex,
      fragment
    });

    const withoutFragment = createObjectExpressionWithSpreadFragment({
      expression: options.expression,
      propertyIndex: options.propertyIndex,
      fragment: null
    });

    return t.conditionalExpression(
      t.cloneNode(argument.left),
      argument.operator === "&&" ? withFragment : withoutFragment,
      argument.operator === "&&" ? withoutFragment : withFragment
    );
  }

  if (!t.isConditionalExpression(argument)) {
    return null;
  }

  const consequent = getDynamicCssVariableObjectSpreadFragment({
    expression: argument.consequent,
    scope: options.scope
  });

  const alternate = getDynamicCssVariableObjectSpreadFragment({
    expression: argument.alternate,
    scope: options.scope
  });

  if (!consequent || !alternate) {
    return null;
  }

  return t.conditionalExpression(
    t.cloneNode(argument.test),
    createObjectExpressionWithSpreadFragment({
      expression: options.expression,
      propertyIndex: options.propertyIndex,
      fragment: consequent
    }),
    createObjectExpressionWithSpreadFragment({
      expression: options.expression,
      propertyIndex: options.propertyIndex,
      fragment: alternate
    })
  );
}

function getDynamicCssVariableObjectSpreadFragment(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): t.ObjectExpression | null {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (!t.isObjectExpression(expression)) {
    return null;
  }

  const result = collectDynamicCssVariableObjectExpression({
    expression,
    declarationName: null,
    scope: options.scope
  });

  return result ? expression : null;
}

function createObjectExpressionWithSpreadFragment(options: {
  readonly expression: t.ObjectExpression;
  readonly propertyIndex: number;
  readonly fragment: t.ObjectExpression | null;
}): t.ObjectExpression {
  return t.objectExpression(
    options.expression.properties.flatMap((property, index) => {
      if (index !== options.propertyIndex) {
        return [t.cloneNode(property)];
      }

      return options.fragment
        ? options.fragment.properties.map((fragmentProperty) =>
            t.cloneNode(fragmentProperty)
          )
        : [];
    })
  );
}

function createDynamicCssVariableArrayDeclarationBranchExpression(options: {
  readonly expression: t.ArrayExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  for (
    let elementIndex = 0;
    elementIndex < options.expression.elements.length;
    elementIndex += 1
  ) {
    const element = options.expression.elements[elementIndex];

    if (!element || t.isSpreadElement(element) || !t.isExpression(element)) {
      return null;
    }

    const branchExpression =
      createDynamicCssVariableDeclarationBranchExpression({
        expression: element,
        scope: options.scope
      });

    if (branchExpression) {
      return createDynamicCssVariableArrayElementBranchExpression({
        expression: options.expression,
        elementIndex,
        branchExpression
      });
    }
  }

  return null;
}

function createDynamicCssVariableDeclarationValueBranchExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableDeclarationBranchExpression | null {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isConditionalExpression(expression)) {
    if (
      !isSupportedDynamicCssVariableDeclarationBranchValue({
        expression: expression.consequent,
        scope: options.scope
      }) ||
      !isSupportedDynamicCssVariableDeclarationBranchValue({
        expression: expression.alternate,
        scope: options.scope
      })
    ) {
      return null;
    }

    return t.conditionalExpression(
      t.cloneNode(expression.test),
      t.cloneNode(expression.consequent),
      t.cloneNode(expression.alternate)
    );
  }

  if (t.isLogicalExpression(expression) && expression.operator === "&&") {
    if (
      !isSupportedDynamicCssVariableDeclarationBranchValue({
        expression: expression.right,
        scope: options.scope
      })
    ) {
      return null;
    }

    return t.logicalExpression(
      expression.operator,
      t.cloneNode(expression.left),
      t.cloneNode(expression.right)
    );
  }

  return null;
}

function createDynamicCssVariableObjectPropertyBranchExpression(options: {
  readonly expression: t.ObjectExpression;
  readonly propertyIndex: number;
  readonly branchExpression: DynamicCssVariableDeclarationBranchExpression;
}): DynamicCssVariableDeclarationBranchExpression {
  return createDynamicCssVariableReplacementBranchExpression({
    branchExpression: options.branchExpression,

    createExpression: (value) =>
      createObjectExpressionWithPropertyValue({
        expression: options.expression,
        propertyIndex: options.propertyIndex,
        value
      })
  });
}

function createDynamicCssVariableArrayElementBranchExpression(options: {
  readonly expression: t.ArrayExpression;
  readonly elementIndex: number;
  readonly branchExpression: DynamicCssVariableDeclarationBranchExpression;
}): DynamicCssVariableDeclarationBranchExpression {
  return createDynamicCssVariableReplacementBranchExpression({
    branchExpression: options.branchExpression,

    createExpression: (value) =>
      createArrayExpressionWithElementValue({
        expression: options.expression,
        elementIndex: options.elementIndex,
        value
      })
  });
}

function createDynamicCssVariableReplacementBranchExpression(options: {
  readonly branchExpression: DynamicCssVariableDeclarationBranchExpression;
  readonly createExpression: (value: t.Expression) => t.Expression;
}): DynamicCssVariableDeclarationBranchExpression {
  if (t.isConditionalExpression(options.branchExpression)) {
    return t.conditionalExpression(
      t.cloneNode(options.branchExpression.test),
      options.createExpression(options.branchExpression.consequent),
      options.createExpression(options.branchExpression.alternate)
    );
  }

  return t.logicalExpression(
    options.branchExpression.operator,
    t.cloneNode(options.branchExpression.left),
    options.createExpression(options.branchExpression.right)
  );
}

function createObjectExpressionWithPropertyValue(options: {
  readonly expression: t.ObjectExpression;
  readonly propertyIndex: number;
  readonly value: t.Expression;
}): t.ObjectExpression {
  return t.objectExpression(
    options.expression.properties.map((property, index) => {
      if (index !== options.propertyIndex) {
        return t.cloneNode(property);
      }

      invariant(
        t.isObjectProperty(property),
        "Dynamic CSS variable declaration branch requires object properties"
      );

      const nextProperty = t.cloneNode(property);
      nextProperty.shorthand = false;
      nextProperty.value = t.cloneNode(options.value);

      return nextProperty;
    })
  );
}

function createArrayExpressionWithElementValue(options: {
  readonly expression: t.ArrayExpression;
  readonly elementIndex: number;
  readonly value: t.Expression;
}): t.ArrayExpression {
  return t.arrayExpression(
    options.expression.elements.map((element, index) => {
      if (index !== options.elementIndex) {
        return element ? t.cloneNode(element) : null;
      }

      return t.cloneNode(options.value);
    })
  );
}

function isSupportedDynamicCssVariableDeclarationBranchValue(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isConditionalExpression(expression)) {
    return (
      isSupportedDynamicCssVariableDeclarationBranchValue({
        expression: expression.consequent,
        scope: options.scope
      }) &&
      isSupportedDynamicCssVariableDeclarationBranchValue({
        expression: expression.alternate,
        scope: options.scope
      })
    );
  }

  if (t.isLogicalExpression(expression) && expression.operator === "&&") {
    return isSupportedDynamicCssVariableDeclarationBranchValue({
      expression: expression.right,
      scope: options.scope
    });
  }

  return isSupportedDynamicCssVariableDirectValueExpression({
    expression,
    scope: options.scope
  });
}

function getNestedDeclarationName(options: {
  readonly propertyName: string;
  readonly declarationName: string | null;
}): string | null {
  if (options.declarationName) {
    return options.declarationName;
  }

  return isNestedCssObjectKey(options.propertyName)
    ? null
    : options.propertyName;
}

function getLeafDeclarationName(options: {
  readonly propertyName: string;
  readonly declarationName: string | null;
}): string | null {
  return (
    options.declarationName ??
    (isNestedCssObjectKey(options.propertyName) ? null : options.propertyName)
  );
}

function collectDynamicCssVariableValueFragment(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableValueFragment | null {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (t.isConditionalExpression(expression)) {
    const consequent = collectDynamicCssVariableValueFragment({
      expression: expression.consequent,
      scope: options.scope
    });

    const alternate = collectDynamicCssVariableValueFragment({
      expression: expression.alternate,
      scope: options.scope
    });

    if (!consequent || !alternate) {
      return null;
    }

    return {
      kind: "conditional-leaf",
      test: t.cloneNode(expression.test),
      consequent,
      alternate
    };
  }

  if (t.isTemplateLiteral(expression)) {
    return collectDynamicCssVariableSuffixValueFragment({
      expression,
      scope: options.scope
    });
  }

  if (
    !isSupportedDynamicCssVariableDirectValueExpression({
      expression,
      scope: options.scope
    })
  ) {
    return null;
  }

  return {
    kind: "direct-value",
    expression: t.cloneNode(expression)
  };
}

function collectDynamicCssVariableSuffixValueFragment(options: {
  readonly expression: t.TemplateLiteral;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): DynamicCssVariableValueFragment | null {
  const [head, tail] = options.expression.quasis;
  const [valueExpression] = options.expression.expressions;

  if (
    options.expression.quasis.length !== 2 ||
    options.expression.expressions.length !== 1 ||
    !head ||
    !tail ||
    !t.isExpression(valueExpression)
  ) {
    return null;
  }

  const prefix = head.value.cooked ?? head.value.raw;
  const suffix = tail.value.cooked ?? tail.value.raw;

  if (
    prefix !== "" ||
    !isSupportedDynamicCssVariableTemplateSuffix(suffix) ||
    !isSupportedDynamicCssVariableDirectValueExpression({
      expression: valueExpression,
      scope: options.scope
    })
  ) {
    return null;
  }

  return {
    kind: "suffix-value",
    expression: t.cloneNode(valueExpression),
    suffix
  };
}

// CSS unit suffixes accepted by one-hole dynamic templates such as `${gap}px`.
// MDN Reference: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_values_and_units
// Container query units: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_container_queries#container_query_length_units
// Keep entries lowercase; matching is case-insensitive and preserves input suffix casing.
const supportedDynamicCssVariableTemplateSuffixes = new Set([
  "%",

  // Font/root-relative lengths.
  "cap",
  "ch",
  "em",
  "ex",
  "ic",
  "lh",
  "rcap",
  "rch",
  "rem",
  "rex",
  "ric",
  "rlh",

  // Viewport lengths.
  "dvb",
  "dvh",
  "dvi",
  "dvmax",
  "dvmin",
  "dvw",
  "lvb",
  "lvh",
  "lvi",
  "lvmax",
  "lvmin",
  "lvw",
  "svb",
  "svh",
  "svi",
  "svmax",
  "svmin",
  "svw",
  "vb",
  "vh",
  "vi",
  "vmax",
  "vmin",
  "vw",

  // Container query lengths.
  "cqb",
  "cqh",
  "cqi",
  "cqmax",
  "cqmin",
  "cqw",

  // Absolute lengths.
  "cm",
  "in",
  "mm",
  "pc",
  "pt",
  "px",
  "q",

  // Grid flex.
  "fr",

  // Angle.
  "deg",
  "grad",
  "rad",
  "turn",

  // Time.
  "ms",
  "s",

  // Frequency.
  "hz",
  "khz",

  // Resolution.
  "dpcm",
  "dpi",
  "dppx",
  "x"
]);

function isSupportedDynamicCssVariableTemplateSuffix(suffix: string): boolean {
  return supportedDynamicCssVariableTemplateSuffixes.has(
    suffix.replace(/[A-Z]/g, (character) => character.toLowerCase())
  );
}

function isSupportedDynamicCssVariableDirectValueExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (isStaticCssPrimitiveExpression(expression)) {
    return true;
  }

  if (
    isSidecarOwnedDynamicCssVariableReferenceExpression({
      expression,
      scope: options.scope
    })
  ) {
    return false;
  }

  if (isSupportedDynamicCssVariableReferenceExpression(options)) {
    return true;
  }

  if (t.isUnaryExpression(expression)) {
    return (
      (expression.operator === "+" || expression.operator === "-") &&
      isSupportedDynamicCssVariableDirectValueExpression({
        expression: expression.argument,
        scope: options.scope
      })
    );
  }

  if (t.isBinaryExpression(expression)) {
    return (
      isSupportedDynamicCssVariableArithmeticBinaryOperator(
        expression.operator
      ) &&
      t.isExpression(expression.left) &&
      isSupportedDynamicCssVariableDirectValueExpression({
        expression: expression.left,
        scope: options.scope
      }) &&
      isSupportedDynamicCssVariableDirectValueExpression({
        expression: expression.right,
        scope: options.scope
      })
    );
  }

  if (t.isLogicalExpression(expression)) {
    return (
      isSupportedDynamicCssVariableLogicalOperator(expression.operator) &&
      isSupportedDynamicCssVariableDirectValueExpression({
        expression: expression.left,
        scope: options.scope
      }) &&
      isSupportedDynamicCssVariableDirectValueExpression({
        expression: expression.right,
        scope: options.scope
      })
    );
  }

  if (!t.isCallExpression(expression)) {
    return false;
  }

  return isSupportedDynamicCssVariableCallExpression({
    expression,
    scope: options.scope
  });
}

function isSupportedDynamicCssVariableReferenceExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (!isDirectReferenceExpression(expression)) {
    return false;
  }

  const rootIdentifier = getDirectReferenceRootIdentifier(expression);

  return rootIdentifier
    ? !isImportedBindingIdentifier(options.scope, rootIdentifier)
    : true;
}

function isSidecarOwnedDynamicCssVariableReferenceExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  const expression = unwrapTransparentCssRuleExpression(options.expression);

  if (!t.isIdentifier(expression)) {
    return false;
  }

  const bindingPath = options.scope.getBinding(expression.name)?.path;

  return !!(
    bindingPath?.scope.path.isProgram() &&
    isSidecarSafeDynamicCssVariableValueExpression(options)
  );
}

function isSupportedDynamicCssVariableCallExpression(options: {
  readonly expression: t.CallExpression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  if (
    !t.isExpression(options.expression.callee) ||
    !isSupportedDynamicCssVariableReferenceExpression({
      expression: options.expression.callee,
      scope: options.scope
    })
  ) {
    return false;
  }

  if (
    options.expression.arguments.some((argument) => {
      return (
        t.isSpreadElement(argument) ||
        !t.isExpression(argument) ||
        !isSupportedDynamicCssVariableDirectValueExpression({
          expression: argument,
          scope: options.scope
        })
      );
    })
  ) {
    return false;
  }

  return !isSidecarSafeDynamicCssVariableValueExpression(options);
}

function isSupportedDynamicCssVariableArithmeticBinaryOperator(
  operator: t.BinaryExpression["operator"]
): boolean {
  switch (operator) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "**":
      return true;
    default:
      return false;
  }
}

function isSupportedDynamicCssVariableLogicalOperator(
  operator: t.LogicalExpression["operator"]
): boolean {
  switch (operator) {
    case "&&":
    case "||":
    case "??":
      return true;
    default:
      return false;
  }
}

function isSidecarSafeDynamicCssVariableValueExpression(options: {
  readonly expression: t.Expression;
  readonly scope: NodePath<t.JSXOpeningElement>["scope"];
}): boolean {
  return isSidecarSafeCssRuleExpression({
    expression: t.objectExpression([
      t.objectProperty(t.identifier("value"), t.cloneNode(options.expression))
    ]),
    state: {
      scope: options.scope,
      visiting: new Set(),
      localNames: new Set()
    }
  });
}

function isDirectMemberReferenceExpression(
  expression: t.Expression
): expression is t.MemberExpression | t.OptionalMemberExpression {
  if (t.isMemberExpression(expression)) {
    return (
      !expression.computed &&
      isDirectReferenceObjectExpression(expression.object)
    );
  }

  if (t.isOptionalMemberExpression(expression)) {
    return (
      !expression.computed &&
      isDirectReferenceObjectExpression(expression.object)
    );
  }

  return false;
}

export function isDirectReferenceExpression(expression: t.Expression): boolean {
  if (t.isIdentifier(expression) || t.isThisExpression(expression)) {
    return true;
  }

  return isDirectMemberReferenceExpression(expression);
}

function isDirectReferenceObjectExpression(
  expression: t.Expression | t.Super
): boolean {
  return !t.isSuper(expression) && isDirectReferenceExpression(expression);
}

export function getDirectReferenceRootIdentifier(
  expression: t.Expression | t.Super
): t.Identifier | null {
  if (t.isSuper(expression) || t.isThisExpression(expression)) {
    return null;
  }

  if (t.isIdentifier(expression)) {
    return expression;
  }

  if (!isDirectMemberReferenceExpression(expression)) {
    return null;
  }

  return getDirectReferenceRootIdentifier(expression.object);
}

function isImportedBindingIdentifier(
  scope: NodePath<t.JSXOpeningElement>["scope"],
  identifier: t.Identifier
): boolean {
  const binding = scope.getBinding(identifier.name);
  const bindingPath = binding?.path;

  return !!(
    bindingPath &&
    (bindingPath.isImportSpecifier() ||
      bindingPath.isImportDefaultSpecifier() ||
      bindingPath.isImportNamespaceSpecifier())
  );
}

import { types as t, type NodePath } from "@babel/core";
import { mayHaveShorthandConflict } from "../defineRulesCxConditionsShorthands.js";
import {
  isNestedCssObjectKey,
  isSupportedCssDeclarationProperty
} from "../cssProperty.js";
import { unwrapTransparentCssRuleExpression } from "../staticCssEval/candidates.js";
import { registerImportMethod } from "../utils.js";
import {
  createClassNameExpression,
  getDynamicCssVariableRuntimeLowering,
  registerDynamicCssVariableRuntimeLowering
} from "./classNameLowering.js";
import {
  collectDynamicCssVariableValueFragment,
  createDynamicCssVariableDeclarationBranchExpression,
  getDynamicCssVariableRule
} from "./dynamicCssVariableAnalysis.js";
import {
  createDynamicCssVariableLowering,
  createDynamicCssVariableValueExpression
} from "./dynamicCssVariableCodegen.js";
import {
  getStaticObjectPropertyKeyName,
  isStaticCssShapeExpression,
  isStaticCssPrimitiveExpression
} from "./expressionShape.js";
import type {
  DynamicCssVariableLowering,
  NormalizedJsxCssPropElement
} from "./types.js";

/** CSS sharing never authorizes sharing or moving a user's evaluations. */
export function createOrderedCssLowering(
  path: NodePath<t.JSXOpeningElement>,
  element: Omit<NormalizedJsxCssPropElement, "dynamicCssVariableLowering">,
  options: { splitConditions: boolean; nonInheritingCssVars?: boolean }
): DynamicCssVariableLowering | null {
  const source = element.cssShapeExpression;
  const split = options.splitConditions && canSplitConditions(source);
  if (!element.dynamicCssVariableRule && !split) return null;

  // Inline values run at the style attribute, or at the end when one is added.
  // Snapshot only when moving there crosses an observable attribute.
  const styleIndex =
    element.styleAttribute &&
    !element.hasSpreadBeforeCss &&
    !element.hasSpreadAfterCss
      ? element.attributesBeforeCss.indexOf(element.styleAttribute)
      : -1;
  const crossedAttributes =
    styleIndex >= 0
      ? element.attributesBeforeCss.slice(styleIndex + 1)
      : element.attributesAfterCss;

  if (
    !split &&
    element.dynamicCssVariableRule?.kind === "direct" &&
    crossedAttributes.every(
      (attribute) =>
        t.isJSXAttribute(attribute) &&
        (attribute.value === null ||
          t.isStringLiteral(attribute.value) ||
          (t.isJSXExpressionContainer(attribute.value) &&
            t.isExpression(attribute.value.expression) &&
            isStaticCssPrimitiveExpression(attribute.value.expression)))
    )
  )
    return null;

  const declarations: t.VariableDeclaration[] = [];
  const preparedValues = new Set<string>();
  let vx: t.Identifier | undefined;

  const capture = (
    value: t.Expression,
    active: t.Expression | null,
    normalized = false
  ) => {
    const id = path.scope.generateUidIdentifier(
      normalized ? "minchoCssValue" : "minchoCssTest"
    );

    declarations.push(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(id),
          active
            ? t.conditionalExpression(
                t.cloneNode(active),
                value,
                t.unaryExpression("void", t.numericLiteral(0))
              )
            : value
        )
      ])
    );

    if (normalized) preparedValues.add(id.name);

    return id;
  };

  const guard = (parent: t.Expression | null, test: t.Expression) =>
    parent ? t.logicalExpression("&&", t.cloneNode(parent), test) : test;

  function prepare(
    node: t.Expression,
    active: t.Expression | null,
    rule: boolean
  ): t.Expression {
    const expression = unwrapTransparentCssRuleExpression(node);
    if (isStaticCssPrimitiveExpression(expression))
      return t.cloneNode(expression);
    if (t.isObjectExpression(expression)) {
      return t.objectExpression(
        expression.properties.map((property) => {
          if (t.isSpreadElement(property))
            return t.spreadElement(prepare(property.argument, active, true));
          if (
            !t.isObjectProperty(property) ||
            property.computed ||
            !t.isExpression(property.value)
          )
            throw new Error("unproved CSS property");

          const result = t.cloneNode(property);
          result.value = prepare(property.value, active, false);

          return result;
        })
      );
    }

    if (t.isArrayExpression(expression)) {
      if (!rule && isStaticCssShapeExpression(expression))
        return t.cloneNode(expression);

      return t.arrayExpression(
        expression.elements.map((item) => {
          if (!item || !t.isExpression(item))
            throw new Error("unproved CSS array");

          return prepare(item, active, true);
        })
      );
    }

    if (t.isConditionalExpression(expression)) {
      const test = capture(t.cloneNode(expression.test), active);

      return t.conditionalExpression(
        t.cloneNode(test),
        prepare(expression.consequent, guard(active, t.cloneNode(test)), rule),
        prepare(
          expression.alternate,
          guard(active, t.unaryExpression("!", t.cloneNode(test))),
          rule
        )
      );
    }

    if (
      t.isLogicalExpression(expression) &&
      (rule || expression.operator === "&&")
    ) {
      const test = capture(t.cloneNode(expression.left), active);
      const rightActive =
        expression.operator === "&&"
          ? t.cloneNode(test)
          : expression.operator === "||"
            ? t.unaryExpression("!", t.cloneNode(test))
            : t.logicalExpression(
                "||",
                t.binaryExpression("===", t.cloneNode(test), t.nullLiteral()),
                t.binaryExpression(
                  "===",
                  t.cloneNode(test),
                  t.unaryExpression("void", t.numericLiteral(0))
                )
              );

      return t.logicalExpression(
        expression.operator,
        t.cloneNode(test),
        prepare(expression.right, guard(active, rightActive), rule)
      );
    }

    if (rule) throw new Error("unproved CSS rule");

    const fragment = collectDynamicCssVariableValueFragment({
      expression,
      scope: path.scope
    });
    if (!fragment) throw new Error("unproved CSS value");

    vx ??= registerImportMethod(path, "vx", "@mincho-js/transform-runtime");

    return capture(
      createDynamicCssVariableValueExpression(fragment, vx),
      active,
      true
    );
  }

  let prepared: t.Expression;

  try {
    prepared = prepare(source, null, true);
  } catch {
    return null;
  }

  const parts =
    split && t.isObjectExpression(prepared)
      ? prepared.properties.map((property) => t.objectExpression([property]))
      : [prepared];

  const classes: t.Expression[] = [];
  const styles: t.ObjectExpression["properties"] = [];

  for (const part of parts) {
    const rule = getDynamicCssVariableRule({
      expression: part,
      scope: path.scope
    });

    if (rule) {
      const lowering = createDynamicCssVariableLowering({
        path,
        rule,
        needsClassNameMerge: false,
        preparedValues,
        nonInheritingCssVars: options.nonInheritingCssVars
      });

      const runtime = getDynamicCssVariableRuntimeLowering(lowering);
      declarations.push(...(runtime?.declarations ?? []));
      styles.push(...(runtime?.styleProperties ?? lowering.styleProperties));
      classes.push(lowering.classNameExpression);
    } else {
      const branch = createDynamicCssVariableDeclarationBranchExpression({
        expression: part,
        scope: path.scope
      });

      classes.push(
        createClassNameExpression(path, {
          cssExpression: branch ?? part,
          cssValueClassification: branch ? "branch-css-rule" : "css-rule",
          classNameAttribute: null
        })
      );
    }
  }

  const cx = registerImportMethod(path, "cx", "@mincho-js/css/classname");

  return registerDynamicCssVariableRuntimeLowering(
    {
      classNameExpression:
        classes.length === 1
          ? classes[0]!
          : canSplitStaticConditions(source)
            ? classes.reduce((left, right) =>
                t.binaryExpression(
                  "+",
                  t.binaryExpression("+", left, t.stringLiteral(" ")),
                  right
                )
              )
            : t.callExpression(t.cloneNode(cx), classes),
      cxExpression: cx,
      styleProperties: []
    },
    { declarations, styleProperties: styles }
  );
}

/** Proves that no dynamic style values are needed before expanding branches. */
export function canSplitStaticConditions(expression: t.Expression): boolean {
  if (!canSplitConditions(expression)) return false;

  const staticBranches = (value: t.Expression): boolean => {
    if (t.isConditionalExpression(value))
      return (
        staticBranches(value.consequent) && staticBranches(value.alternate)
      );

    return !t.isObjectExpression(value) && isStaticCssShapeExpression(value);
  };

  return expression.properties.every(
    (property) =>
      t.isObjectProperty(property) &&
      t.isExpression(property.value) &&
      staticBranches(property.value)
  );
}

/** Split only disjoint top-level declarations; uncertain cascade relationships stay grouped. */
function canSplitConditions(
  expression: t.Expression
): expression is t.ObjectExpression {
  if (!t.isObjectExpression(expression) || expression.properties.length < 2)
    return false;

  const keys: string[] = [];
  let conditional = false;

  for (const property of expression.properties) {
    if (
      !t.isObjectProperty(property) ||
      property.computed ||
      !t.isExpression(property.value)
    )
      return false;

    const key = getStaticObjectPropertyKeyName(property.key);
    if (
      !key ||
      isNestedCssObjectKey(key) ||
      !isSupportedCssDeclarationProperty(key) ||
      !/^[a-zA-Z]+$/.test(key) ||
      /^(?:Webkit|Moz|ms|O)[A-Z]/.test(key)
    )
      return false;
    if (
      keys.some(
        (previous) =>
          previous === key ||
          mayHaveShorthandConflict(previous, key) ||
          physicalLogicalOverlap(previous, key)
      )
    )
      return false;

    keys.push(key);
    conditional ||=
      t.isConditionalExpression(property.value) ||
      t.isLogicalExpression(property.value);

    if (t.isObjectExpression(property.value)) return false;
  }

  return conditional;
}

function physicalLogicalOverlap(left: string, right: string): boolean {
  const family = (key: string) =>
    /^(?:top|right|bottom|left)$/.test(key)
      ? "inset"
      : (/^(?:margin|padding|inset|border|scrollMargin|scrollPadding|overflow|overscrollBehavior|containIntrinsic)/.exec(
          key
        )?.[0] ??
        (/^(?:(?:min|max)?(?:Width|Height|InlineSize|BlockSize)|width|height|inlineSize|blockSize)$/.test(
          key
        )
          ? "size"
          : null));

  const a = family(left);

  return a !== null && a === family(right);
}

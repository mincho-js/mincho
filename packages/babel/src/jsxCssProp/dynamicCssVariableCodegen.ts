import type { NodePath } from "@babel/core";
import { types as t } from "@babel/core";
import type { ProgramScope } from "../types.js";
import {
  getNearestIdentifier,
  invariant,
  registerImportMethod
} from "../utils.js";
import {
  createClassNameExpression,
  getClassNameExpression,
  registerDynamicCssVariableRuntimeLowering
} from "./classNameLowering.js";
import {
  cssModuleHelperImportCleanupScopes,
  cssModuleName
} from "./constants.js";
import { getStyleExpression } from "./styleExpression.js";
import type {
  DynamicCssVariableBranchRule,
  DynamicCssVariableLeaf,
  DynamicCssVariableLowering,
  DynamicCssVariableRule,
  DynamicCssVariableValueFragment
} from "./types.js";

type DynamicCssVariableHelperImportBindings = {
  readonly createVarIdentifier: t.Identifier;
  readonly getVarNameIdentifier: t.Identifier;
};

const transformRuntimeModuleName = "@mincho-js/transform-runtime";

const dynamicCssVariableHelperImportBindings = new WeakMap<
  ProgramScope,
  DynamicCssVariableHelperImportBindings
>();

const dynamicCssVariableCssImportScopes = new WeakSet<ProgramScope>();

export function createDynamicCssVariableLowering(options: {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly rule: DynamicCssVariableRule;
  readonly needsClassNameMerge: boolean;
}): DynamicCssVariableLowering {
  const programParent = options.path.scope.getProgramParent() as ProgramScope;
  const nearestIdentifier = getNearestIdentifier(options.path);
  const identifierBase = nearestIdentifier
    ? `$mincho$$${nearestIdentifier.node.name}`
    : "$mincho$$unknown";

  const classNameIdentifier =
    programParent.generateUidIdentifier(identifierBase);

  const cxIdentifier = options.needsClassNameMerge
    ? programParent.generateUidIdentifier(`${identifierBase}Cx`)
    : null;

  const preparedLeaves = options.rule.fragment.leaves.map((leaf) => {
    const propertyFragment = createIdentifierNameFragment(leaf.propertyName);
    const variableIdentifier = programParent.generateUidIdentifier(
      `${identifierBase}${propertyFragment}Var`
    );

    const variableKeyIdentifier = programParent.generateUidIdentifier(
      `${identifierBase}${propertyFragment}VarKey`
    );

    leaf.variableIdentifier.name = variableIdentifier.name;

    return {
      leaf,
      variableKeyIdentifier,
      importedVariableKeyIdentifier: registerImportMethod(
        options.path,
        variableKeyIdentifier.name,
        programParent.minchoData.cssFile
      )
    };
  });

  const importedCxIdentifier = cxIdentifier
    ? registerImportMethod(
        options.path,
        cxIdentifier.name,
        programParent.minchoData.cssFile
      )
    : null;

  const vxIdentifier = registerImportMethod(
    options.path,
    "vx",
    transformRuntimeModuleName
  );

  const generatedNodes: t.Statement[] = [];
  let helperImportBindings =
    dynamicCssVariableHelperImportBindings.get(programParent);

  if (!helperImportBindings) {
    helperImportBindings = {
      createVarIdentifier:
        programParent.generateUidIdentifier("minchoCreateVar"),
      getVarNameIdentifier:
        programParent.generateUidIdentifier("minchoGetVarName")
    };
    dynamicCssVariableHelperImportBindings.set(
      programParent,
      helperImportBindings
    );
    cssModuleHelperImportCleanupScopes.add(programParent);

    generatedNodes.push(
      createDynamicCssVariableHelperImportDeclaration(helperImportBindings)
    );
  }

  invariant(
    helperImportBindings !== undefined,
    "Dynamic CSS variable lowering requires helper import bindings"
  );

  const stylePropertyByLeaf = new Map<DynamicCssVariableLeaf, t.ObjectProperty>(
    preparedLeaves.map(({ leaf, importedVariableKeyIdentifier }) => [
      leaf,
      t.objectProperty(
        t.cloneNode(importedVariableKeyIdentifier),
        createDynamicCssVariableValueExpression(
          leaf.valueFragment,
          vxIdentifier
        ),
        true
      )
    ])
  );

  const branchLowering =
    options.rule.kind === "branch"
      ? createDynamicCssVariableBranchLowering({
          path: options.path,
          rule: options.rule,
          stylePropertyByLeaf
        })
      : null;

  generatedNodes.push(
    ...(cxIdentifier
      ? [createDynamicCssVariableCxExportDeclaration(cxIdentifier)]
      : []),
    ...preparedLeaves.map(({ leaf }) =>
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            t.cloneNode(leaf.variableIdentifier),
            t.callExpression(
              t.cloneNode(helperImportBindings.createVarIdentifier),
              [t.stringLiteral(leaf.propertyName)]
            )
          )
        ])
      )
    ),
    ...preparedLeaves.map(({ leaf, variableKeyIdentifier }) =>
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            variableKeyIdentifier,
            t.callExpression(
              t.cloneNode(helperImportBindings.getVarNameIdentifier),
              [t.cloneNode(leaf.variableIdentifier)]
            )
          )
        ])
      )
    )
  );

  if (options.rule.kind === "direct") {
    const cssIdentifier = registerImportMethod(
      options.path,
      "css",
      cssModuleName
    );

    if (!dynamicCssVariableCssImportScopes.has(programParent)) {
      generatedNodes.unshift(
        createDynamicCssVariableCssImportDeclaration(
          options.path,
          cssIdentifier
        )
      );
      dynamicCssVariableCssImportScopes.add(programParent);
    }

    generatedNodes.push(
      t.exportNamedDeclaration(
        t.variableDeclaration("var", [
          t.variableDeclarator(
            classNameIdentifier,
            t.callExpression(t.cloneNode(cssIdentifier), [
              t.cloneNode(options.rule.fragment.expression)
            ])
          )
        ])
      )
    );
  }

  programParent.minchoData.nodes.push(...generatedNodes);

  if (branchLowering) {
    return registerDynamicCssVariableRuntimeLowering(
      {
        classNameExpression: branchLowering.classNameExpression,
        cxExpression: importedCxIdentifier,
        styleProperties: []
      },
      {
        declarations: branchLowering.declarations,
        styleProperties: branchLowering.styleProperties
      }
    );
  }

  const importedClassNameIdentifier = registerImportMethod(
    options.path,
    classNameIdentifier.name,
    programParent.minchoData.cssFile
  );

  return {
    classNameExpression: importedClassNameIdentifier,
    cxExpression: importedCxIdentifier,
    styleProperties: options.rule.fragment.leaves.map((leaf) =>
      cloneDynamicCssVariableStyleProperty(stylePropertyByLeaf, leaf)
    )
  };
}

function createDynamicCssVariableValueExpression(
  fragment: DynamicCssVariableValueFragment,
  vxIdentifier: t.Identifier
): t.Expression {
  switch (fragment.kind) {
    case "direct-value":
      return t.callExpression(t.cloneNode(vxIdentifier), [
        t.cloneNode(fragment.expression)
      ]);
    case "suffix-value":
      return t.callExpression(t.cloneNode(vxIdentifier), [
        t.cloneNode(fragment.expression),
        t.stringLiteral(fragment.suffix)
      ]);
    case "conditional-leaf":
      return t.conditionalExpression(
        t.cloneNode(fragment.test),
        createDynamicCssVariableValueExpression(
          fragment.consequent,
          vxIdentifier
        ),
        createDynamicCssVariableValueExpression(
          fragment.alternate,
          vxIdentifier
        )
      );
    default: {
      const exhaustive: never = fragment;

      return exhaustive;
    }
  }
}

function createDynamicCssVariableCssImportDeclaration(
  path: NodePath<t.JSXOpeningElement>,
  cssIdentifier: t.Identifier
): t.ImportDeclaration | t.VariableDeclaration {
  const programParent = path.scope.getProgramParent() as ProgramScope;
  let cssBinding = programParent.getBinding(cssIdentifier.name);

  if (!cssBinding) {
    programParent.crawl();
    cssBinding = programParent.getBinding(cssIdentifier.name);
  }

  invariant(
    cssBinding !== undefined,
    "Dynamic CSS variable lowering requires a registered css import binding"
  );

  programParent.minchoData.bindings.push(cssBinding.path);

  const cssImportSpecifierPath = cssBinding.path;

  if (cssImportSpecifierPath.isVariableDeclarator()) {
    return t.variableDeclaration("var", [
      t.cloneNode(cssImportSpecifierPath.node, true)
    ]);
  }

  invariant(
    cssImportSpecifierPath.isImportSpecifier(),
    "Dynamic CSS variable css import binding must be an import specifier"
  );

  return t.importDeclaration(
    [t.cloneNode(cssImportSpecifierPath.node)],
    t.stringLiteral(cssModuleName)
  );
}

function createDynamicCssVariableBranchLowering(options: {
  readonly path: NodePath<t.JSXOpeningElement>;
  readonly rule: DynamicCssVariableBranchRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
}): {
  readonly declarations: readonly t.VariableDeclaration[];
  readonly classNameExpression: t.Expression;
  readonly styleProperties: readonly t.ObjectExpression["properties"][number][];
} {
  const declarations: t.VariableDeclaration[] = [];
  const decisionIdentifierByRule = new Map<
    DynamicCssVariableBranchRule,
    t.Identifier
  >();

  const branchRules: Array<{
    readonly rule: DynamicCssVariableBranchRule;
    readonly activeExpression: t.Expression | null;
  }> = [{ rule: options.rule, activeExpression: null }];

  for (const { rule, activeExpression } of branchRules) {
    const decisionIdentifier =
      options.path.scope.generateUidIdentifier("minchoCssBranch");

    const decisionExpression =
      createDynamicCssVariableBranchDecisionExpression(rule);

    declarations.push(
      t.variableDeclaration("const", [
        t.variableDeclarator(
          t.cloneNode(decisionIdentifier),
          activeExpression
            ? t.conditionalExpression(
                t.cloneNode(activeExpression),
                t.cloneNode(decisionExpression),
                t.unaryExpression("void", t.numericLiteral(0))
              )
            : t.cloneNode(decisionExpression)
        )
      ])
    );
    decisionIdentifierByRule.set(rule, decisionIdentifier);

    for (const [branchIndex, branch] of rule.branches.entries()) {
      if (branch.kind === "branch") {
        const branchActiveExpression =
          createDynamicCssVariableNestedBranchActiveExpression(
            rule,
            decisionIdentifier,
            branchIndex
          );

        branchRules.push({
          rule: branch,
          activeExpression: activeExpression
            ? t.logicalExpression(
                "&&",
                t.cloneNode(activeExpression),
                branchActiveExpression
              )
            : branchActiveExpression
        });
      }
    }
  }

  const decisionIdentifier = getDynamicCssVariableBranchDecisionIdentifier(
    decisionIdentifierByRule,
    options.rule
  );

  const cssExpression = createDynamicCssVariableBranchClassNameExpression({
    rule: options.rule,
    decisionExpression: decisionIdentifier,
    decisionIdentifierByRule
  });

  const classNameExpression = createClassNameExpression(options.path, {
    cssExpression,
    cssValueClassification: "branch-css-rule",
    classNameAttribute: null
  });

  const styleProperties = [
    t.spreadElement(
      createDynamicCssVariableBranchStyleExpression({
        rule: options.rule,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression: decisionIdentifier,
        decisionIdentifierByRule
      })
    )
  ];

  return { declarations, classNameExpression, styleProperties };
}

function createDynamicCssVariableBranchDecisionExpression(
  rule: DynamicCssVariableBranchRule
): t.Expression {
  if (t.isConditionalExpression(rule.fragment.expression)) {
    return t.cloneNode(rule.fragment.expression.test);
  }

  return t.cloneNode(rule.fragment.expression.left);
}

function createDynamicCssVariableNestedBranchActiveExpression(
  rule: DynamicCssVariableBranchRule,
  decisionIdentifier: t.Identifier,
  branchIndex: number
): t.Expression {
  if (t.isConditionalExpression(rule.fragment.expression)) {
    return branchIndex === 0
      ? t.cloneNode(decisionIdentifier)
      : t.unaryExpression("!", t.cloneNode(decisionIdentifier));
  }

  if (rule.fragment.expression.operator === "&&") {
    return t.cloneNode(decisionIdentifier);
  }

  if (rule.fragment.expression.operator === "??") {
    return createDynamicCssVariableNullishDecisionExpression(
      decisionIdentifier
    );
  }

  return t.unaryExpression("!", t.cloneNode(decisionIdentifier));
}

function createDynamicCssVariableNullishDecisionExpression(
  decisionExpression: t.Expression
): t.LogicalExpression {
  return t.logicalExpression(
    "||",
    t.binaryExpression("===", t.cloneNode(decisionExpression), t.nullLiteral()),
    t.binaryExpression(
      "===",
      t.cloneNode(decisionExpression),
      t.unaryExpression("void", t.numericLiteral(0))
    )
  );
}

function createDynamicCssVariableBranchClassNameExpression(options: {
  readonly rule: DynamicCssVariableBranchRule;
  readonly decisionExpression: t.Expression;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.ConditionalExpression | t.LogicalExpression {
  if (t.isConditionalExpression(options.rule.fragment.expression)) {
    const consequent = options.rule.branches[0];
    const alternate = options.rule.branches[1];

    invariant(
      consequent !== undefined && alternate !== undefined,
      "Conditional dynamic CSS variable branch requires both branches"
    );

    return t.conditionalExpression(
      t.cloneNode(options.decisionExpression),
      createDynamicCssVariableRuleClassNameExpression(
        consequent,
        options.decisionIdentifierByRule
      ),
      createDynamicCssVariableRuleClassNameExpression(
        alternate,
        options.decisionIdentifierByRule
      )
    );
  }

  const right = options.rule.branches[0];

  invariant(
    right !== undefined,
    "Logical dynamic CSS variable branch requires a right branch"
  );

  return t.logicalExpression(
    options.rule.fragment.expression.operator,
    t.cloneNode(options.decisionExpression),
    createDynamicCssVariableRuleClassNameExpression(
      right,
      options.decisionIdentifierByRule
    )
  );
}

function createDynamicCssVariableRuleClassNameExpression(
  rule: DynamicCssVariableRule,
  decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >
): t.Expression {
  if (rule.kind === "direct") {
    return t.cloneNode(rule.fragment.expression);
  }

  return createDynamicCssVariableBranchClassNameExpression({
    rule,
    decisionExpression: getDynamicCssVariableBranchDecisionIdentifier(
      decisionIdentifierByRule,
      rule
    ),
    decisionIdentifierByRule
  });
}

function getDynamicCssVariableBranchDecisionIdentifier(
  decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >,
  rule: DynamicCssVariableBranchRule
): t.Identifier {
  const identifier = decisionIdentifierByRule.get(rule);

  invariant(
    identifier !== undefined,
    "Dynamic CSS variable branch requires a prepared decision binding"
  );

  return identifier;
}

function createDynamicCssVariableBranchStyleExpression(options: {
  readonly rule: DynamicCssVariableBranchRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
  readonly decisionExpression: t.Expression;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.Expression {
  if (t.isConditionalExpression(options.rule.fragment.expression)) {
    const consequent = options.rule.branches[0];
    const alternate = options.rule.branches[1];

    invariant(
      consequent !== undefined && alternate !== undefined,
      "Conditional dynamic CSS variable style requires both branches"
    );

    return t.conditionalExpression(
      t.cloneNode(options.decisionExpression),
      createDynamicCssVariableStyleObjectExpression({
        rule: consequent,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression:
          consequent.kind === "branch"
            ? getDynamicCssVariableBranchDecisionIdentifier(
                options.decisionIdentifierByRule,
                consequent
              )
            : null,
        decisionIdentifierByRule: options.decisionIdentifierByRule
      }),
      createDynamicCssVariableStyleObjectExpression({
        rule: alternate,
        stylePropertyByLeaf: options.stylePropertyByLeaf,
        decisionExpression:
          alternate.kind === "branch"
            ? getDynamicCssVariableBranchDecisionIdentifier(
                options.decisionIdentifierByRule,
                alternate
              )
            : null,
        decisionIdentifierByRule: options.decisionIdentifierByRule
      })
    );
  }

  const right = options.rule.branches[0];

  invariant(
    right !== undefined,
    "Logical dynamic CSS variable style requires a right branch"
  );

  const decisionExpression = t.cloneNode(options.decisionExpression);
  const rightStyle = createDynamicCssVariableStyleObjectExpression({
    rule: right,
    stylePropertyByLeaf: options.stylePropertyByLeaf,
    decisionExpression:
      right.kind === "branch"
        ? getDynamicCssVariableBranchDecisionIdentifier(
            options.decisionIdentifierByRule,
            right
          )
        : null,
    decisionIdentifierByRule: options.decisionIdentifierByRule
  });

  const emptyStyle = t.objectExpression([]);

  if (options.rule.fragment.expression.operator === "&&") {
    return t.conditionalExpression(decisionExpression, rightStyle, emptyStyle);
  }

  if (options.rule.fragment.expression.operator === "??") {
    return t.conditionalExpression(
      createDynamicCssVariableNullishDecisionExpression(decisionExpression),
      rightStyle,
      emptyStyle
    );
  }

  return t.conditionalExpression(decisionExpression, emptyStyle, rightStyle);
}

function createDynamicCssVariableStyleObjectExpression(options: {
  readonly rule: DynamicCssVariableRule;
  readonly stylePropertyByLeaf: ReadonlyMap<
    DynamicCssVariableLeaf,
    t.ObjectProperty
  >;
  readonly decisionExpression: t.Expression | null;
  readonly decisionIdentifierByRule: ReadonlyMap<
    DynamicCssVariableBranchRule,
    t.Identifier
  >;
}): t.ObjectExpression {
  switch (options.rule.kind) {
    case "direct":
      return t.objectExpression(
        options.rule.fragment.leaves.map((leaf) =>
          cloneDynamicCssVariableStyleProperty(
            options.stylePropertyByLeaf,
            leaf
          )
        )
      );
    case "branch":
      invariant(
        options.decisionExpression !== null,
        "Dynamic CSS variable branch style requires a decision expression"
      );

      return t.objectExpression([
        t.spreadElement(
          createDynamicCssVariableBranchStyleExpression({
            rule: options.rule,
            stylePropertyByLeaf: options.stylePropertyByLeaf,
            decisionExpression: options.decisionExpression,
            decisionIdentifierByRule: options.decisionIdentifierByRule
          })
        )
      ]);
    default: {
      const exhaustive: never = options.rule;

      return exhaustive;
    }
  }
}

function cloneDynamicCssVariableStyleProperty(
  stylePropertyByLeaf: ReadonlyMap<DynamicCssVariableLeaf, t.ObjectProperty>,
  leaf: DynamicCssVariableLeaf
): t.ObjectProperty {
  const property = stylePropertyByLeaf.get(leaf);

  invariant(
    property !== undefined,
    "Dynamic CSS variable style property requires a prepared leaf"
  );

  return t.cloneNode(property);
}

export function createDynamicCssVariableClassNameAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  classNameAttribute: t.JSXAttribute | null,
  lowering: DynamicCssVariableLowering
): t.JSXAttribute["value"] {
  if (!classNameAttribute) {
    return t.jsxExpressionContainer(t.cloneNode(lowering.classNameExpression));
  }

  invariant(
    lowering.cxExpression !== null,
    "Dynamic CSS variable className merge requires a generated cx export"
  );

  return t.jsxExpressionContainer(
    t.callExpression(t.cloneNode(lowering.cxExpression), [
      getClassNameExpression(path, classNameAttribute),
      t.cloneNode(lowering.classNameExpression)
    ])
  );
}

export function createDynamicCssVariableStyleAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  styleAttribute: t.JSXAttribute | null,
  styleProperties: readonly t.ObjectExpression["properties"][number][]
): t.JSXAttribute["value"] {
  if (!styleAttribute) {
    return t.jsxExpressionContainer(
      t.objectExpression(
        styleProperties.map((property) => t.cloneNode(property))
      )
    );
  }

  const styleExpression = getStyleExpression(path, styleAttribute);
  const userStyleProperties = t.isObjectExpression(styleExpression)
    ? styleExpression.properties.map((property) => t.cloneNode(property))
    : [t.spreadElement(t.cloneNode(styleExpression))];

  return t.jsxExpressionContainer(
    t.objectExpression([
      ...userStyleProperties,
      ...styleProperties.map((property) => t.cloneNode(property))
    ])
  );
}

export function assertDynamicCssVariableStyleAttributeValue(
  path: NodePath<t.JSXOpeningElement>,
  styleAttribute: t.JSXAttribute | null
): void {
  if (!styleAttribute) {
    return;
  }

  getStyleExpression(path, styleAttribute);
}

function createDynamicCssVariableCxExportDeclaration(
  exportedIdentifier: t.Identifier
): t.ExportNamedDeclaration {
  return t.exportNamedDeclaration(
    null,
    [t.exportSpecifier(t.identifier("cx"), t.cloneNode(exportedIdentifier))],
    t.stringLiteral("@mincho-js/css/classname")
  );
}

function createDynamicCssVariableHelperImportDeclaration(
  bindings: DynamicCssVariableHelperImportBindings
): t.ImportDeclaration {
  return t.importDeclaration(
    [
      t.importSpecifier(
        t.cloneNode(bindings.createVarIdentifier),
        t.identifier("createVar")
      ),
      t.importSpecifier(
        t.cloneNode(bindings.getVarNameIdentifier),
        t.identifier("getVarName")
      )
    ],
    t.stringLiteral(cssModuleName)
  );
}

function createIdentifierNameFragment(value: string): string {
  const fragments = value.match(/[A-Za-z0-9_$]+/g);

  if (!fragments) {
    return "Value";
  }

  return fragments.map(capitalizeIdentifierFragment).join("");
}

function capitalizeIdentifierFragment(fragment: string): string {
  return `${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}`;
}

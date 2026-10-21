import { types as t, type NodePath } from "@babel/core";
import type { PluginState, ProgramScope } from "../types.js";
import { registerImportMethod } from "../utils.js";
import { isIntrinsicElement } from "../optimizations/intrinsicElements.js";
import { registerDynamicCssVariableRuntimeLowering } from "./classNameLowering.js";
import type {
  DynamicCssVariableLowering,
  NormalizedJsxCssPropElement
} from "./types.js";

const properties = new Set([
  "color",
  "backgroundColor",
  "opacity",
  "display",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "visibility",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "order",
  "cursor"
]);

const unitless = new Set([
  "opacity",
  "fontWeight",
  "lineHeight",
  "zIndex",
  "order"
]);

const keyOf = (node: t.Node) =>
  t.isIdentifier(node)
    ? node.name
    : t.isStringLiteral(node)
      ? node.value
      : null;

type Leaf = { index: number; values: string[]; shape: t.ObjectExpression };

type Branch = {
  test: t.Expression;
  yes: Tree;
  no: Tree;
  start: number;
  end: number;
  on?: t.Identifier;
  off?: t.Identifier;
};

type Tree = Leaf | Branch;

function value(node: t.Node, property: string): string {
  if (
    t.isNumericLiteral(node) &&
    Number.isFinite(node.value) &&
    (node.value === 0 || unitless.has(property))
  )
    return String(node.value);
  if (
    !t.isStringLiteral(node) ||
    !node.value.trim() ||
    /(?:^\s*(?:initial|inherit|unset|revert|revert-layer)\s*$)|[!;{}\\]|\/\*|\*\/|(?:var|env|attr|url)\s*\(/i.test(
      node.value
    )
  )
    throw new Error("value");

  // Unbalanced tokens in an inactive branch must not invalidate the active value.
  let depth = 0;
  let quote = "";

  for (const ch of node.value) {
    if (quote) {
      if (ch === quote) quote = "";

      continue;
    }

    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) throw new Error("value");
    else if (/[\r\n]/.test(ch)) throw new Error("value");
  }

  if (depth || quote) throw new Error("value");

  return node.value;
}

function shape(
  node: t.ObjectExpression,
  values: string[],
  names: string[],
  prefix = "",
  mode: "rule" | "queries" | "selectors" = "rule"
): void {
  const seen = new Set<string>();

  for (const entry of node.properties) {
    if (!t.isObjectProperty(entry) || entry.computed) throw new Error("shape");

    const key = keyOf(entry.key);
    if (!key || seen.has(key)) throw new Error("shape");

    seen.add(key);

    if (mode !== "rule") {
      if (
        !t.isObjectExpression(entry.value) ||
        (mode === "selectors"
          ? !/^&:(hover|focus|focus-visible|active|disabled)$/.test(key)
          : /[{};]/.test(key))
      )
        throw new Error("condition");

      shape(entry.value, values, names, `${prefix}/${key}`);
    } else if (t.isObjectExpression(entry.value)) {
      if (!["selectors", "@media", "@supports"].includes(key))
        throw new Error("condition");

      shape(
        entry.value,
        values,
        names,
        `${prefix}/${key}`,
        key === "selectors" ? "selectors" : "queries"
      );
    } else {
      if (!properties.has(key)) throw new Error("property");

      names.push(`${prefix}/${key}`);
      values.push(value(entry.value, key));
    }
  }
}

const concat = (a: t.Expression, b: t.Expression) =>
  t.binaryExpression("+", a, b);

function fallback(
  variable: t.Identifier,
  expression: t.Expression
): t.Expression {
  return concat(
    concat(
      t.callExpression(
        t.memberExpression(t.cloneNode(variable), t.identifier("slice")),
        [t.numericLiteral(0), t.unaryExpression("-", t.numericLiteral(1))]
      ),
      t.stringLiteral(", ")
    ),
    concat(expression, t.stringLiteral(")"))
  );
}

/** Complete, finite branches only. Unsupported inputs keep the existing lowering. */
export function createCssBooleanGateLowering(
  path: NodePath<t.JSXOpeningElement>,
  element: Omit<NormalizedJsxCssPropElement, "dynamicCssVariableLowering">,
  state: PluginState
): DynamicCssVariableLowering | null {
  if (
    !state.opts.experimental?.cssBooleanGates ||
    !t.isConditionalExpression(element.cssExpression)
  )
    return null;

  const report = (reason: string) => {
    if (!state.opts.diagnostics) return;

    const counts = (state.file.metadata.minchoCssBooleanGates ??= {}) as Record<
      string,
      number
    >;

    counts[reason] = (counts[reason] ?? 0) + 1;
  };

  if (
    !t.isJSXIdentifier(path.node.name) ||
    !isIntrinsicElement(path.node.name.name) ||
    element.classNameAttribute ||
    element.styleAttribute ||
    element.hasSpreadBeforeCss ||
    element.hasSpreadAfterCss
  ) {
    report("element-shape");

    return null;
  }

  let count = 0;
  const leaves: Leaf[] = [];
  const branches: Branch[] = [];
  let signature: string | undefined;
  let tree: Tree;

  try {
    const read = (node: t.Expression): Tree => {
      if (t.isConditionalExpression(node)) {
        if (++count > 4) throw new Error("budget");

        let blocked = false;
        t.traverseFast(node.test, (child) => {
          if (t.isAwaitExpression(child) || t.isYieldExpression(child))
            blocked = true;
        });

        if (blocked) throw new Error("condition");

        const start = leaves.length;
        const yes = read(node.consequent);
        const end = leaves.length;
        const no = read(node.alternate);
        const branch: Branch = { test: node.test, yes, no, start, end };
        branches.push(branch);

        return branch;
      }

      if (!t.isObjectExpression(node)) throw new Error("incomplete-branch");

      const values: string[] = [],
        names: string[] = [];

      shape(node, values, names);

      if (!values.length || values.length > 64) throw new Error("budget");

      const current = JSON.stringify(names);
      if (signature !== undefined && signature !== current)
        throw new Error("incomplete-branch");

      signature = current;

      const leaf = { index: leaves.length, values, shape: node };
      leaves.push(leaf);

      return leaf;
    };

    tree = read(element.cssExpression);
  } catch (error) {
    report(error instanceof Error ? error.message : "unproved");

    return null;
  }

  const program = path.scope.getProgramParent() as ProgramScope;
  const createVar = program.generateUidIdentifier("gateVar");
  const getVarName = program.generateUidIdentifier("gateKey");
  const css = program.generateUidIdentifier("gateCss");
  const factor = program.generateUidIdentifier("factorGateCss");
  const generated: t.Statement[] = [
    t.importDeclaration(
      [
        t.importSpecifier(createVar, t.identifier("createVar")),
        t.importSpecifier(getVarName, t.identifier("getVarName")),
        t.importSpecifier(css, t.identifier("css"))
      ],
      t.stringLiteral("@mincho-js/css")
    ),
    t.importDeclaration(
      [t.importSpecifier(factor, t.identifier("factorCssBooleanGates"))],
      t.stringLiteral("@mincho-js/css/defineRules/registry")
    )
  ];

  const vars: t.ObjectProperty[] = [];
  const styles: t.ObjectProperty[] = [];
  const selection = program.generateUidIdentifier("minchoGateBranch");

  const exported = (id: t.Identifier, init: t.Expression) =>
    t.exportNamedDeclaration(
      t.variableDeclaration("var", [t.variableDeclarator(id, init)])
    );

  for (const branch of branches) {
    const active = t.logicalExpression(
      "&&",
      t.binaryExpression(
        ">=",
        t.cloneNode(selection),
        t.numericLiteral(branch.start)
      ),
      t.binaryExpression(
        "<",
        t.cloneNode(selection),
        t.numericLiteral(branch.end)
      )
    );

    for (const kind of ["on", "off"] as const) {
      const variable = program.generateUidIdentifier(`minchoGate${kind}`);
      const key = program.generateUidIdentifier(`minchoGate${kind}Key`);
      branch[kind] = variable;
      generated.push(
        exported(
          variable,
          t.callExpression(t.cloneNode(createVar), [
            t.stringLiteral(`gate-${kind}`)
          ])
        ),
        exported(
          key,
          t.callExpression(t.cloneNode(getVarName), [t.cloneNode(variable)])
        )
      );
      vars.push(
        t.objectProperty(
          t.cloneNode(variable),
          t.stringLiteral(kind === "on" ? "initial" : " "),
          true
        )
      );
      styles.push(
        t.objectProperty(
          registerImportMethod(path, key.name, program.minchoData.cssFile),
          t.conditionalExpression(
            t.cloneNode(active),
            // React 16–18 trim inline custom-property values. A CSS comment
            // survives trimming while contributing no tokens to var().
            t.stringLiteral(kind === "on" ? "initial" : "/**/"),
            t.stringLiteral(kind === "on" ? "/**/" : "initial")
          ),
          true
        )
      );
    }
  }

  function expression(node: Tree, index: number): t.Expression {
    return "index" in node
      ? t.stringLiteral(node.values[index]!)
      : concat(
          concat(
            fallback(node.on!, expression(node.yes, index)),
            t.stringLiteral(" ")
          ),
          fallback(node.off!, expression(node.no, index))
        );
  }

  let index = 0;
  const rule = t.cloneNode(leaves[0]!.shape, true);

  function replace(node: t.ObjectExpression): void {
    for (const entry of node.properties)
      if (t.isObjectProperty(entry)) {
        if (t.isObjectExpression(entry.value)) replace(entry.value);
        else entry.value = expression(tree, index++);
      }
  }

  replace(rule);
  rule.properties.unshift(
    t.objectProperty(t.identifier("vars"), t.objectExpression(vars))
  );

  const className = program.generateUidIdentifier("minchoGateClass");
  generated.push(
    exported(
      className,
      t.callExpression(t.cloneNode(css), [
        t.callExpression(t.cloneNode(factor), [rule])
      ])
    )
  );
  program.minchoData.nodes.push(...generated);

  function choose(node: Tree): t.Expression {
    return "index" in node
      ? t.numericLiteral(node.index)
      : t.conditionalExpression(
          t.cloneNode(node.test, true),
          choose(node.yes),
          choose(node.no)
        );
  }

  report("applied");

  return registerDynamicCssVariableRuntimeLowering(
    {
      classNameExpression: registerImportMethod(
        path,
        className.name,
        program.minchoData.cssFile
      ),
      cxExpression: registerImportMethod(
        path,
        "cx",
        "@mincho-js/css/classname"
      ),
      styleProperties: []
    },
    {
      declarations: [
        t.variableDeclaration("const", [
          t.variableDeclarator(selection, choose(tree))
        ])
      ],
      styleProperties: styles
    }
  );
}

import { parseSync, types as t, type NodePath } from "@babel/core";
import { getBoundHelperFunctions } from "../staticCssEval/cjsHelperLookup.js";
import { getBoundEsbuildHelperFunctions } from "../staticCssEval/cjsEsbuildHelperLookup.js";
import { isSupportedEsbuildCopyPropsHelper } from "../staticCssEval/cjsEsbuildToCommonJsHelperFingerprint.js";

// The shape, its referenced helpers and their bindings must all agree. A helper
// name alone is never evidence that wrapping a require preserves its exports.
const esbuildToEsm = parseSync(
  `const helper = (mod, isNodeMode, target) => (
  target = mod != null ? __create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule ?
    __defProp(target, "default", { value: mod, enumerable: true }) : target, mod)
);`,
  { babelrc: false, configFile: false }
)!.program.body[0] as t.VariableDeclaration;

export function isSupportedImportInterop(
  path: NodePath<t.CallExpression>
): boolean {
  if (!t.isIdentifier(path.node.callee)) return false;

  const binding = path.scope.getBinding(path.node.callee.name);
  if (!binding?.constant) return false;

  const direct = getBoundEsbuildHelperFunctions(
    path.node.callee.name,
    path.scope
  );

  const functions = direct.length
    ? direct
    : getBoundHelperFunctions(path.node.callee.name, path.scope);
  if (functions.length !== 1) return false;

  const fn = functions[0]!;
  const parameter = fn.params[0];

  if (
    t.isIdentifier(parameter) &&
    fn.params.length === 1 &&
    path.node.arguments.length === 1
  ) {
    const expression =
      t.isBlockStatement(fn.body) &&
      fn.body.body.length === 1 &&
      t.isReturnStatement(fn.body.body[0])
        ? fn.body.body[0].argument
        : t.isExpression(fn.body)
          ? fn.body
          : null;

    if (
      t.isConditionalExpression(expression) &&
      t.isLogicalExpression(expression.test, { operator: "&&" }) &&
      t.isIdentifier(expression.test.left, { name: parameter.name }) &&
      t.isMemberExpression(expression.test.right, { computed: false }) &&
      t.isIdentifier(expression.test.right.object, { name: parameter.name }) &&
      t.isIdentifier(expression.test.right.property, { name: "__esModule" }) &&
      t.isIdentifier(expression.consequent, { name: parameter.name }) &&
      t.isObjectExpression(expression.alternate) &&
      expression.alternate.properties.length === 1
    ) {
      const property = expression.alternate.properties[0];
      if (
        t.isObjectProperty(property, { computed: false }) &&
        (t.isIdentifier(property.key, { name: "default" }) ||
          t.isStringLiteral(property.key, { value: "default" })) &&
        t.isIdentifier(property.value, { name: parameter.name })
      )
        return true;
    }
  }

  if (
    !t.isArrowFunctionExpression(fn) ||
    !t.isNodesEquivalent(fn, esbuildToEsm.declarations[0]!.init!)
  )
    return false;
  if (
    path.node.arguments.length > 2 ||
    (path.node.arguments.length === 2 &&
      !t.isNumericLiteral(path.node.arguments[1], { value: 1 }))
  )
    return false;
  if (
    !path.scope.getBinding("__copyProps")?.constant ||
    !isSupportedEsbuildCopyPropsHelper("__copyProps", path.scope)
  )
    return false;

  for (const [local, name] of [
    ["__create", "create"],
    ["__getProtoOf", "getPrototypeOf"],
    ["__defProp", "defineProperty"]
  ]) {
    const helper = path.scope.getBinding(local!);
    if (
      !helper?.constant ||
      !helper.path.isVariableDeclarator() ||
      helper.path.scope.getBinding("Object") ||
      !t.isMemberExpression(helper.path.node.init, { computed: false }) ||
      !t.isIdentifier(helper.path.node.init.object, { name: "Object" }) ||
      !t.isIdentifier(helper.path.node.init.property, { name: name! })
    )
      return false;
  }

  return true;
}

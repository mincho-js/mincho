import { parseSync, types as t, type NodePath } from "@babel/core";
import { scopedFileScopeRuntime } from "./fileScopeRuntime.js";

const fileScopeApi = "@vanilla-extract/css/fileScope";
const compilerWrapper = (
  parseSync(scopedFileScopeRuntime, { configFile: false, babelrc: false })!
    .program.body[0] as t.ExpressionStatement
).expression;

// TypeScript erasure may leave own null/undefined generic-argument metadata where
// the parser omitted it. Normalize only these absent annotations on a comparison
// copy; runtime children, fields, values and ordering remain exact.
function withoutAbsentTypeArguments(node: t.Node): t.Node {
  const copy = { ...node } as unknown as Record<string, unknown>;
  for (const field of ["typeParameters", "typeArguments"])
    if (copy[field] == null) delete copy[field];
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const value = copy[key];
    if (Array.isArray(value))
      copy[key] = value.map(
        (child) => child && withoutAbsentTypeArguments(child)
      );
    else if (value && typeof value === "object" && "type" in value)
      copy[key] = withoutAbsentTypeArguments(value as t.Node);
  }
  return copy as unknown as t.Node;
}

/** Exact origin forwarding only, not general helper purity or module authority.
 * The compiler-owned wrapper preserves the supplied literal scope arguments.
 * Changed wrappers are intentionally not guessed from their variable names.
 */
export function getVerifiedFileScopeRequire(
  path: NodePath<t.Node>
): NodePath<t.CallExpression> | undefined {
  if (!path.isCallExpression()) return;
  if (
    path.get("callee").isIdentifier({ name: "require" }) &&
    !path.scope.getBinding("require") &&
    path.node.arguments.length === 1 &&
    t.isStringLiteral(path.node.arguments[0], { value: fileScopeApi })
  )
    return path;
  if (
    !t.isCallExpression(compilerWrapper) ||
    path.node.callee.type !== compilerWrapper.callee.type ||
    path.node.arguments.length !== compilerWrapper.arguments.length ||
    !t.isNodesEquivalent(withoutAbsentTypeArguments(path.node), compilerWrapper)
  )
    return;
  const argument = path.get("arguments")[0];
  return argument && getVerifiedFileScopeRequire(argument);
}

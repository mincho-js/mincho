import { types as t, type NodePath } from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";
import { expressionKey } from "./pureFunctions.js";
import { hasInitializedReferences } from "./initializedReferences.js";

/** Only primitive named exports qualify. Mutable token containers retain evaluation. */
export function* symbolicTokenReferences(
  graph: ModuleGraph,
  owner: SourceModule
): ModuleGraphFlow<{ key: string; expression: t.Expression }[]> {
  const candidates: NodePath<t.Node>[] = [];
  owner.program.traverse({
    ReferencedIdentifier(path) {
      if (
        !path.parentPath.isMemberExpression() &&
        !path.parentPath.isOptionalMemberExpression()
      )
        candidates.push(path);
    },

    MemberExpression(path) {
      if (path.isReferenced() && !path.parentPath.isMemberExpression())
        candidates.push(path);
    }
  });

  const output: { key: string; expression: t.Expression }[] = [];

  for (const path of candidates) {
    const reference = getModuleReference(path);
    if (
      !reference ||
      reference.unsafe ||
      reference.members.length !== 1 ||
      !hasInitializedReferences(path)
    )
      continue;
    if (
      path.parentPath?.isExportSpecifier() ||
      path.parentPath?.isImportSpecifier()
    )
      continue;

    try {
      const id = yield* graph.resolveImport(
        owner.id,
        reference.source,
        reference.kind
      );
      if (!id) continue;

      const value = yield {
        kind: "token-reference",
        id,
        name: reference.members[0]!
      };

      if (value !== null) {
        graph.dependencies.add(id);
        output.push({
          key: expressionKey(path),
          expression: t.stringLiteral(value)
        });
        continue;
      }

      // Re-exports retain the normal resolver and lexical binding checks.
      const target = yield* graph.valueTarget(owner, path, new Set());
      if (!target || "external" in target || !target.path.isStringLiteral())
        continue;

      const verified = yield {
        kind: "token-reference",
        id: target.module.id,
        value: target.path.node.value
      };

      if (verified !== null)
        output.push({
          key: expressionKey(path),
          expression: t.stringLiteral(verified)
        });
    } catch {
      /* Unsupported provider, mutable bindings and cycles retain runtime reads. */
    }
  }

  return output;
}

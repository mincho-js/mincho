import { createHash } from "node:crypto";
import { types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";

/** Preserve syntax/value distinctions and property order, but never caller locations. */
export function syntaxKey(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (
      [
        "loc",
        "start",
        "end",
        "extra",
        "leadingComments",
        "trailingComments",
        "innerComments"
      ].includes(key)
    )
      return undefined;

    return typeof item === "number" && Object.is(item, -0)
      ? { negativeZero: true }
      : item;
  });
}

const moduleDigests = new WeakMap<t.Program, string>();

function moduleDigest(module: SourceModule): string {
  let digest = moduleDigests.get(module.program.node);

  if (!digest) {
    digest = createHash("sha256")
      .update(syntaxKey(module.program.node))
      .digest("hex");
    moduleDigests.set(module.program.node, digest);
  }

  return digest;
}

/** Resolve captures before a hit so that imports, closures and watch edges stay current. */
export function* pureFunctionMemoKey(
  graph: ModuleGraph,
  module: SourceModule,
  fn: NodePath<t.Node>,
  args: readonly t.Expression[],
  environment: ReadonlyMap<Binding, t.Expression>,
  depth: number
): ModuleGraphFlow<string | null> {
  const visited = new Set<t.Node>();
  const parts: unknown[] = [
    "pure-function:v1",
    depth,
    args,
    [...environment].map(([binding, value]) => [
      binding.identifier.name,
      binding.path.node.start,
      value
    ])
  ];

  function* visit(
    owner: SourceModule,
    path: NodePath<t.Node>
  ): ModuleGraphFlow<boolean> {
    if (visited.has(path.node)) return true;
    if (visited.size >= 128) return false;

    visited.add(path.node);
    parts.push([
      owner.id,
      moduleDigest(owner),
      path.node.type,
      path.node.start,
      path.node.end
    ]);

    const references: NodePath<t.Identifier>[] = [];

    if (path.isReferencedIdentifier())
      references.push(path as NodePath<t.Identifier>);

    path.traverse({
      ReferencedIdentifier(reference) {
        if (reference.isIdentifier()) references.push(reference);
      }
    });

    for (const reference of references) {
      const binding = reference.scope.getBinding(reference.node.name);

      if (!binding) {
        if (reference.node.name === "undefined") continue;

        return false;
      }

      if (
        binding.path === path ||
        binding.path.findParent((parent) => parent === path)
      )
        continue;
      if (environment.has(binding)) continue;
      if (!binding.constant) return false;

      const target = yield* graph.bindingTarget(owner, binding, new Set());
      if (
        !target ||
        "external" in target ||
        !(yield* visit(target.module, target.path))
      )
        return false;
    }

    return true;
  }

  try {
    return (yield* visit(module, fn))
      ? `helper:${createHash("sha256").update(syntaxKey(parts)).digest("hex")}`
      : null;
  } catch {
    return null;
  }
}

export interface PureFunctionMemoValue {
  readonly result: t.Expression;
  readonly nodes: number;
  readonly calls: number;
}

import { types as t, type NodePath } from "@babel/core";
import { getModuleReference } from "../commonjs/bindings.js";
import type {
  ModuleGraph,
  ModuleGraphFlow,
  SourceModule
} from "../moduleGraph.js";
import { expressionKey } from "./pureFunctions.js";

const generatedSidecar = /(?:^|\/)extracted_[^/]+\.css\.ts$/;
const viteSidecarPrefix = "\0mincho-extracted-css:";

function isGeneratedSidecar(id: string): boolean {
  // Vite wraps owned sidecars in a virtual JavaScript module after extraction.
  // Accept that exact wrapper, without treating arbitrary .css.ts.js files as
  // compiler-generated immutable exports.
  if (id.startsWith(viteSidecarPrefix) && id.endsWith(".js"))
    id = id.slice(viteSidecarPrefix.length, -3);

  return generatedSidecar.test(id);
}

export function isSidecarCssVariableKey(
  path: NodePath<t.ObjectProperty>
): boolean {
  const reference = path.node.computed
    ? getModuleReference(path.get("key"))
    : null;

  return (
    !!reference &&
    !reference.unsafe &&
    isGeneratedSidecar(reference.source) &&
    !!path.findParent(
      (parent) =>
        parent.isJSXAttribute() &&
        t.isJSXIdentifier(parent.node.name, { name: "style" })
    )
  );
}

/** Vanilla Extract emits immutable literal exports with `var`, not `const`. */
export function* readSidecarString(
  graph: ModuleGraph,
  owner: SourceModule,
  path: NodePath<t.Node>
): ModuleGraphFlow<string> {
  const reference = getModuleReference(path);
  if (!reference || reference.unsafe || !isGeneratedSidecar(reference.source))
    throw new Error("Unproved sidecar reference");

  const target = yield* graph.valueTarget(owner, path, new Set());
  if (
    !target ||
    "external" in target ||
    !isGeneratedSidecar(target.module.id) ||
    !target.path.isStringLiteral()
  )
    throw new Error("Nonliteral sidecar string");

  return target.path.node.value;
}

export function* inlineCssVariableKeys(
  graph: ModuleGraph,
  owner: SourceModule
): ModuleGraphFlow<{ key: string; expression: t.Expression }[]> {
  const properties: NodePath<t.ObjectProperty>[] = [];
  owner.program.traverse({
    ObjectProperty(path) {
      if (isSidecarCssVariableKey(path)) properties.push(path);
    }
  });

  const replacements: { key: string; expression: t.Expression }[] = [];

  for (const property of properties) {
    try {
      const key = property.get("key");
      const value = yield* readSidecarString(graph, owner, key);

      if (value.startsWith("--"))
        replacements.push({
          key: expressionKey(key),
          expression: t.stringLiteral(value)
        });
    } catch {
      // A runtime or mutable key must retain its original evaluation.
    }
  }

  return replacements;
}

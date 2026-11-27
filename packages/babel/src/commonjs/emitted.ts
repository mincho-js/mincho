import { types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import { hasDynamicScope } from "../optimizations/dynamicScope.js";
import { hasObservablePrototypeMutation } from "../optimizations/recipeMetadata.js";
import { commonJsExports } from "./modules.js";
import type { ExportMapEntry } from "../staticCssEval/moduleCache.js";

interface EmittedCommonJs {
  readonly exports: ReadonlyMap<string, ExportMapEntry>;
  /** Actual own slots of the validated default namespace, before export renames. */
  readonly defaultExports: ReadonlyMap<string | null, ExportMapEntry>;
  readonly publications: ReadonlySet<t.Node>;
  readonly inertExpressions: ReadonlySet<t.Node>;
}

function declaration(binding: Binding | undefined) {
  return binding?.constant &&
    binding.path.isVariableDeclarator() &&
    binding.path.parentPath.parentPath?.isProgram()
    ? binding.path
    : undefined;
}

function memberName(path: NodePath<t.Node>): string | undefined {
  if (!path.isMemberExpression()) return;
  const property = path.node.property;
  return !path.node.computed && t.isIdentifier(property)
    ? property.name
    : path.node.computed && t.isStringLiteral(property)
      ? property.value
      : undefined;
}

/**
 * Recover candidate publications from a closed wrapper. Ordinary assignments
 * rely on the compiler's standard-intrinsics assumption. Withdraw recovery
 * when prototype mutation is observable locally or in the caller's module graph.
 * The caller must supply actual host output. Names and raw-source spans confer
 * no trust: every use of the private allocations is checked by binding identity.
 */
export function inspectEmittedCommonJs(
  program: NodePath<t.Program>,
  filename: string
): EmittedCommonJs | undefined {
  if (hasDynamicScope(program) || hasObservablePrototypeMutation(program))
    return;
  const body = program.get("body");
  const exported = body.find((path) => path.isExportDefaultDeclaration());
  if (!exported?.isExportDefaultDeclaration()) return;
  const value = exported.get("declaration");
  if (!value.isIdentifier()) return;
  const snapshotBinding = value.scope.getBinding(value.node.name);
  const snapshot = declaration(snapshotBinding);
  if (!snapshot || !snapshotBinding) return;
  const snapshotInit = snapshot.get("init");
  if (
    !snapshotInit.isMemberExpression() ||
    memberName(snapshotInit) !== "exports"
  )
    return;
  const moduleObject = snapshotInit.get("object");
  if (!moduleObject.isIdentifier()) return;
  const moduleBinding = moduleObject.scope.getBinding(moduleObject.node.name);
  const moduleDeclaration = declaration(moduleBinding);
  if (!moduleDeclaration || !moduleBinding) return;
  const moduleInit = moduleDeclaration.get("init");
  if (
    !moduleInit.isObjectExpression() ||
    moduleInit.node.properties.length !== 1
  )
    return;
  const property = moduleInit.node.properties[0];
  if (
    !t.isObjectProperty(property) ||
    property.computed ||
    !t.isIdentifier(property.key, { name: "exports" }) ||
    !t.isObjectExpression(property.value) ||
    property.value.properties.length
  )
    return;

  const moduleReads = moduleBinding.referencePaths.filter(
    (path) => path.node !== moduleObject.node
  );
  if (moduleReads.length !== 1) return;
  const aliasInit = moduleReads[0]!.parentPath;
  if (
    !aliasInit?.isMemberExpression() ||
    memberName(aliasInit) !== "exports" ||
    aliasInit.get("object").node !== moduleReads[0]!.node
  )
    return;
  const aliasDeclaration = aliasInit.parentPath;
  if (
    !aliasDeclaration.isVariableDeclarator() ||
    aliasDeclaration.get("init").node !== aliasInit.node ||
    !t.isIdentifier(aliasDeclaration.node.id)
  )
    return;
  const aliasBinding = aliasDeclaration.scope.getBinding(
    aliasDeclaration.node.id.name
  );
  if (declaration(aliasBinding) !== aliasDeclaration || !aliasBinding) return;

  const position = (path: NodePath<t.Node>) =>
    body.findIndex(
      (statement) => statement.node === path.getStatementParent()?.node
    );
  const start = position(aliasDeclaration);
  const end = position(snapshot);
  if (start < 0 || end <= start || position(moduleDeclaration) !== start)
    return;

  const publications = new Set<t.Node>();
  for (const reference of aliasBinding.referencePaths) {
    const slot = reference.parentPath;
    if (
      !slot?.isMemberExpression() ||
      slot.node.computed ||
      slot.get("object").node !== reference.node ||
      memberName(slot) === "__proto__"
    )
      return;
    const write = slot.parentPath;
    if (
      !write.isAssignmentExpression({ operator: "=" }) ||
      write.get("left").node !== slot.node ||
      !write.parentPath.isExpressionStatement() ||
      !write.parentPath.parentPath.isProgram() ||
      position(write) <= start ||
      position(write) >= end
    )
      return;
    publications.add(write.parentPath.node);
  }

  const shape = commonJsExports(program, filename, aliasBinding);
  if (
    !publications.size ||
    [...shape.exports.values()].some((entry) => entry.kind !== "expression")
  )
    return;
  const exports = new Map<string, ExportMapEntry>();
  const inertExpressions = new Set<t.Node>([
    moduleInit.node,
    aliasInit.node,
    snapshotInit.node
  ]);
  for (const reference of snapshotBinding.referencePaths) {
    if (reference.node === value.node) continue;
    const read = reference.parentPath;
    const name = read && memberName(read);
    if (
      name === undefined ||
      !read?.isMemberExpression() ||
      read.get("object").node !== reference.node
    )
      return;
    const projection = read.parentPath;
    if (
      !projection.isVariableDeclarator() ||
      projection.get("init").node !== read.node ||
      !t.isIdentifier(projection.node.id) ||
      position(projection) <= end
    )
      return;
    const binding = projection.scope.getBinding(projection.node.id.name);
    if (!binding || declaration(binding) !== projection) return;
    const entry = shape.exports.get(name);
    if (!entry || entry.kind !== "expression") return;
    for (const use of binding.referencePaths) {
      const specifier = use.parentPath;
      if (
        !specifier?.isExportSpecifier() ||
        specifier.get("local").node !== use.node ||
        !specifier.parentPath.isExportNamedDeclaration() ||
        specifier.parentPath.node.source
      )
        return;
      const exportedName = specifier.node.exported;
      exports.set(
        t.isIdentifier(exportedName) ? exportedName.name : exportedName.value,
        entry
      );
    }
    inertExpressions.add(read.node);
  }
  return {
    exports,
    defaultExports: shape.exports,
    publications,
    inertExpressions
  };
}

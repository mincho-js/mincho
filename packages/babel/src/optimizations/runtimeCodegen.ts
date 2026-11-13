import { types as t, type NodePath } from "@babel/core";
import {
  getModuleReference,
  type ModuleReference
} from "../commonjs/bindings.js";
import type { ProgramScope } from "../types.js";
import { hasDynamicScope } from "./dynamicScope.js";
import { builtInExtractionCalls } from "../extractionCalls/builtins.js";
import { getStaticCssEvalLiteralRequireImportPath } from "../staticCssEval/cjsBindings.js";

/** Authoring imports already evaluated in the sidecar need no client runtime. */
export function removeUnusedExtractedImports(
  program: NodePath<t.Program>
): void {
  const data = (program.scope as ProgramScope).minchoData;
  if (!data || hasDynamicScope(program)) return;

  const extracted = new Set(data.nodes);
  if (!extracted.size) return;

  program.scope.crawl();
  const candidates: {
    declaration: NodePath<t.VariableDeclarator>;
    reference: ModuleReference;
    names: readonly string[];
    initializesSource: boolean;
  }[] = [];
  for (const path of program.get("body")) {
    if (!path.isVariableDeclaration() || !extracted.has(path.node)) continue;
    for (const declaration of path.get("declarations")) {
      const init = declaration.get("init");
      if (!init.isExpression()) continue;
      const reference = getModuleReference(init);
      if (!reference || reference.unsafe) continue;
      const names = Object.hasOwn(builtInExtractionCalls, reference.source)
        ? builtInExtractionCalls[reference.source]
        : undefined;
      if (!names) continue;

      let initializesSource = false;
      const collectRequire = (call: NodePath<t.CallExpression>) => {
        if (
          getStaticCssEvalLiteralRequireImportPath(call.node, call.scope) ===
          reference.source
        )
          initializesSource = true;
      };
      if (init.isCallExpression()) collectRequire(init);
      init.traverse({ CallExpression: collectRequire });
      candidates.push({ declaration, reference, names, initializesSource });
    }
  }

  // Plan the complete dead alias chain before deciding which sources still
  // execute at runtime. A reference inside another dead declaration is unused.
  const removed = new Set<t.Node>();
  const isRemoved = (path: NodePath<t.Node>) =>
    removed.has(path.node) ||
    Boolean(path.findParent((parent) => removed.has(parent.node)));
  const unused = (path: NodePath<t.Node>, name: string) => {
    const binding = path.scope.getBinding(name);
    return binding?.constant && binding.referencePaths.every(isRemoved);
  };
  let changed: boolean;
  do {
    const size = removed.size;
    for (const { declaration, reference, names } of candidates) {
      if (removed.has(declaration.node)) continue;
      const pattern = declaration.get("id");
      if (pattern.isIdentifier()) {
        if (
          (!reference.members.length ||
            (reference.members.length === 1 &&
              names.includes(reference.members[0]!))) &&
          unused(pattern, pattern.node.name)
        )
          removed.add(declaration.node);
        continue;
      }
      if (
        !pattern.isObjectPattern() ||
        reference.members.length ||
        pattern.node.properties.some((property) => t.isRestElement(property))
      )
        continue;

      for (const property of pattern.get("properties")) {
        if (
          !property.isObjectProperty() ||
          property.node.computed ||
          !t.isIdentifier(property.node.value)
        )
          continue;
        const key = property.node.key;
        const name = t.isIdentifier(key)
          ? key.name
          : t.isStringLiteral(key)
            ? key.value
            : undefined;
        if (
          name &&
          names.includes(name) &&
          unused(property, property.node.value.name)
        )
          removed.add(property.node);
      }

      if (pattern.node.properties.every((property) => removed.has(property)))
        removed.add(declaration.node);
    }
    changed = removed.size !== size;
  } while (changed);

  const runtimeRequires = new Set<string>();
  let unknownRuntimeRequire = false;
  program.traverse({
    enter(path) {
      if (removed.has(path.node)) path.skip();
    },
    ReferencedIdentifier(path) {
      if (
        !path.isIdentifier({ name: "require" }) ||
        path.scope.getBinding("require")
      )
        return;
      const call = path.parentPath;
      const source =
        call.isCallExpression() && call.node.callee === path.node
          ? getStaticCssEvalLiteralRequireImportPath(call.node, call.scope)
          : null;
      // Escaped loaders and dynamic specifiers can request any source, so their
      // surviving uses still require the original initialization order.
      if (source === null) unknownRuntimeRequire = true;
      else runtimeRequires.add(source);
    }
  });

  for (const { declaration, reference, initializesSource } of candidates) {
    const retainInitialization =
      initializesSource &&
      (unknownRuntimeRequire || runtimeRequires.has(reference.source));
    if (removed.has(declaration.node) && !retainInitialization) {
      declaration.remove();
      continue;
    }
    const pattern = declaration.get("id");
    if (pattern.isObjectPattern())
      for (const property of pattern.get("properties"))
        if (removed.has(property.node)) property.remove();
  }

  // Removing a destructured authoring binding can make its namespace import
  // unused. Recompute references after pruning, independent of statement order.
  program.scope.crawl();
  for (const path of program.get("body")) {
    if (!path.isImportDeclaration() || !extracted.has(path.node)) continue;

    const names = Object.hasOwn(builtInExtractionCalls, path.node.source.value)
      ? builtInExtractionCalls[path.node.source.value]
      : undefined;
    if (!names) continue;

    for (const specifier of path.get("specifiers")) {
      const binding = program.scope.getBinding(specifier.node.local.name);
      if (specifier.isImportNamespaceSpecifier()) {
        if (binding?.constant && !binding.referenced) specifier.remove();
        continue;
      }
      if (!specifier.isImportSpecifier()) continue;

      const imported = specifier.node.imported;
      const name = t.isIdentifier(imported) ? imported.name : imported.value;

      if (names.includes(name) && binding?.constant && !binding.referenced)
        specifier.remove();
    }

    if (
      !path.node.specifiers.length &&
      !data.effectImports?.has(path.node.source.value)
    )
      path.remove();
  }
}

/** Generated bindings have no user-requested module effects. Never infer ownership by name. */
export function removeUnusedGeneratedImports(
  program: NodePath<t.Program>
): void {
  const generated = (program.scope as ProgramScope).minchoData?.imports;
  if (!generated?.size) return;

  program.scope.crawl();

  for (const identifier of generated.values()) {
    const binding = program.scope.getBinding(identifier.name);
    if (!binding || binding.referenced || !binding.constant) continue;

    const path = binding.path;

    if (path.isImportSpecifier()) {
      const declaration = path.parentPath;
      path.remove();

      if (
        declaration.isImportDeclaration() &&
        !declaration.node.specifiers.length &&
        !(program.scope as ProgramScope).minchoData.effectImports?.has(
          declaration.node.source.value
        )
      )
        declaration.remove();
    } else if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) {
      // helper-module-imports emits a private `var _cx = require(...).cx` in CJS.
      const init = path.get("init");

      if (init.isExpression() && getModuleReference(init)) path.remove();
    }
  }
}

/** Syntax proof, never TypeScript annotations: false means retain the runtime check. */
export function primitiveKind(node: t.Node): "value" | "absent" | null {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isTemplateLiteral(node)
  )
    return "value";
  if (t.isBooleanLiteral(node) || t.isNullLiteral(node)) return "absent";

  if (t.isUnaryExpression(node)) {
    if (["+", "-", "~", "typeof"].includes(node.operator)) return "value";
    if (["!", "void", "delete"].includes(node.operator)) return "absent";
  }

  if (t.isBinaryExpression(node)) {
    if (
      [
        "==",
        "===",
        "!=",
        "!==",
        "<",
        ">",
        "<=",
        ">=",
        "in",
        "instanceof"
      ].includes(node.operator)
    )
      return "absent";

    // `+` also coerces objects, but a successful operation is still primitive.
    return "value";
  }

  if (t.isConditionalExpression(node)) {
    const left = primitiveKind(node.consequent);

    return left === primitiveKind(node.alternate) ? left : null;
  }

  if (t.isSequenceExpression(node))
    return primitiveKind(node.expressions.at(-1)!);
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
  )
    return primitiveKind(node.expression);

  return null;
}

const unknown = Symbol("dynamic class value");

function staticClass(node: t.Node): string | typeof unknown {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value ? String(node.value) : "";
  if (t.isNullLiteral(node) || t.isBooleanLiteral(node)) return "";

  if (t.isArrayExpression(node)) {
    const items: string[] = [];

    for (const item of node.elements) {
      // Holes and object literals can observe inherited enumerable properties.
      if (!item || t.isSpreadElement(item)) return unknown;

      const value = staticClass(item);
      if (value === unknown) return unknown;
      if (value) items.push(value);
    }

    return items.join(" ");
  }

  return unknown;
}

function freshObject(node: t.Node): boolean {
  if (t.isConditionalExpression(node))
    return freshObject(node.consequent) && freshObject(node.alternate);

  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        !(
          t.isIdentifier(property.key, { name: "__proto__" }) ||
          t.isStringLiteral(property.key, { value: "__proto__" })
        )
    )
  );
}

/** Reduce only known helpers and fresh literals; expressions with observable reads stay in order. */
export function optimizeRuntimeCodegen(program: NodePath<t.Program>): void {
  if (hasDynamicScope(program)) return;

  program.traverse({
    CallExpression: {
      exit(path) {
        const reference = getModuleReference(path.get("callee"));
        if (!reference || reference.unsafe || path.node.optional) return;

        const args = path.node.arguments;
        if (!args.every((argument) => t.isExpression(argument))) return;

        if (
          reference.members.join(".") === "cx" &&
          ["@mincho-js/css", "@mincho-js/css/classname"].includes(
            reference.source
          )
        ) {
          const reduced: t.Expression[] = [];
          const pending: string[] = [];

          const flush = () => {
            if (pending.length)
              reduced.push(t.stringLiteral(pending.join(" ")));

            pending.length = 0;
          };

          for (const argument of args) {
            const value = staticClass(argument);

            if (value === unknown) {
              flush();
              reduced.push(argument);
            } else if (value) pending.push(value);
          }

          flush();

          if (!reduced.length) path.replaceWith(t.stringLiteral(""));
          else if (reduced.length === 1 && t.isStringLiteral(reduced[0]))
            path.replaceWith(reduced[0]);
          else path.node.arguments = reduced;
        } else if (
          reference.source === "@mincho-js/transform-runtime" &&
          reference.members.join(".") === "vx" &&
          args.length >= 1 &&
          args.length <= 2
        ) {
          const value = args[0]!;
          const suffix = args[1];
          if (suffix && !t.isStringLiteral(suffix) && !t.isNullLiteral(suffix))
            return;

          const kind = primitiveKind(value);

          if (kind === "absent")
            path.replaceWith(
              t.sequenceExpression([value, t.stringLiteral("var(--c-, )")])
            );
          if (kind === "value")
            path.replaceWith(
              t.isStringLiteral(suffix) && suffix.value
                ? t.templateLiteral(
                    [
                      t.templateElement({ raw: "", cooked: "" }),
                      t.templateElement(
                        {
                          raw: suffix.value
                            .replace(/[`\\$]/g, "\\$&")
                            .replace(/\r/g, "\\r"),
                          cooked: suffix.value
                        },
                        true
                      )
                    ],
                    [value]
                  )
                : value
            );
        }
      }
    },
    ObjectExpression: {
      exit(path) {
        // A single fresh branch already is the required snapshot. Do not remove
        // copies of user objects, accessors, methods or custom prototypes.
        const [property] = path.node.properties;

        if (
          path.node.properties.length === 1 &&
          t.isSpreadElement(property) &&
          freshObject(property.argument)
        )
          path.replaceWith(property.argument);
      }
    }
  });
}

import {
  internalHasObservablePrototypeMutation,
  internalRecipeFactoryKind,
  internalDecodeRecipePayload
} from "@mincho-js/babel";
import { parseSync, traverse, types as t, type NodePath } from "@babel/core";
import { createClassRuntimeFn } from "@mincho-js/css/rules/createClassRuntimeFn";
import type { PrivateRecipeUse } from "./vanillaCssIr.js";

export interface ClosedAppModule {
  id: string;
  code: string;
  entry?: boolean;
  unresolved?: boolean;
  imports: ReadonlyMap<string, string>;
}
export interface ClosedAppUsageOptions {
  mode: "closed";
  preserve?: readonly { module: string; exports?: readonly string[] }[];
}

/** Analyze every loaded module; exports/aliases are followed without executing code. */
export function analyzeClosedAppUsage(
  input: readonly ClosedAppModule[],
  options: ClosedAppUsageOptions
) {
  const programs = new Map<string, NodePath<t.Program>>();
  const modules = new Map(input.map((value) => [value.id, value]));
  const recipes = new Map<
    t.CallExpression,
    {
      id: string;
      used: Set<string> | null;
      classes: Set<string>;
      runtime: ReturnType<typeof createClassRuntimeFn>;
    }
  >();
  const variableReferences = new Set<string>();
  const classReferences = new Set<string>();
  let opaque = input.some((module) => module.unresolved);
  const pinTokens = (value: unknown) => {
    if (typeof value === "string")
      for (const match of value.matchAll(/--[\w-]+/g))
        variableReferences.add(match[0]);
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) pinTokens(child);
  };
  try {
    for (const module of input) {
      const ast = parseSync(module.code, {
        configFile: false,
        babelrc: false,
        sourceType: "unambiguous",
        parserOpts: { plugins: ["jsx", "typescript"] }
      });
      if (!ast) throw new Error("No AST");
      traverse(ast, {
        Program(path) {
          programs.set(module.id, path);
          path.stop();
        }
      });
    }
    const target = (
      id: string,
      name: string,
      exported = false,
      seen = new Set<string>()
    ): NodePath | undefined => {
      const key = `${id}:${name}:${exported}`;
      if (seen.size > 128 || seen.has(key)) return;
      seen.add(key);
      const program = programs.get(id);
      if (!program) return;
      if (exported) {
        for (const statement of program.get("body")) {
          if (statement.isExportAllDeclaration()) {
            opaque = true;
            continue;
          }
          if (!statement.isExportNamedDeclaration()) continue;
          for (const specifier of statement.get("specifiers")) {
            if (!specifier.isExportSpecifier()) {
              opaque = true;
              continue;
            }
            const key = specifier.node.exported;
            if ((t.isIdentifier(key) ? key.name : key.value) !== name) continue;
            const source = statement.node.source?.value;
            const next = source ? modules.get(id)?.imports.get(source) : id;
            return next
              ? target(next, specifier.node.local.name, !!source, seen)
              : undefined;
          }
        }
      }
      const binding = program.scope.getBinding(name);
      if (!binding?.constant) return;
      if (
        binding.path.isImportSpecifier() ||
        binding.path.isImportDefaultSpecifier()
      ) {
        const declaration = binding.path.parentPath;
        if (!declaration.isImportDeclaration()) return;
        const next = modules
          .get(id)
          ?.imports.get(declaration.node.source.value);
        const specifier = binding.path.node;
        const imported = t.isImportDefaultSpecifier(specifier)
          ? "default"
          : t.isIdentifier(specifier.imported)
            ? specifier.imported.name
            : specifier.imported.value;
        return next ? target(next, imported, true, seen) : undefined;
      }
      if (binding.path.isVariableDeclarator()) {
        const init = binding.path.get("init");
        if (init.isIdentifier()) return target(id, init.node.name, false, seen);
        return init.node ? (init as NodePath<t.Node>) : undefined;
      }
    };
    const dynamicRoots = new Set<string>();
    for (const [id, program] of programs)
      program.traverse({
        CallExpression(path) {
          if (
            t.isIdentifier(path.node.callee, { name: "eval" }) ||
            t.isIdentifier(path.node.callee, { name: "require" })
          )
            opaque = true;
          if (t.isImport(path.node.callee)) {
            const source = path.node.arguments[0];
            if (!t.isStringLiteral(source)) opaque = true;
            else {
              const next = modules.get(id)?.imports.get(source.value);
              if (next) dynamicRoots.add(next);
              else opaque = true;
            }
          }
          if (!t.isIdentifier(path.node.callee)) return;
          const binding = path.scope.getBinding(path.node.callee.name);
          if (
            !binding?.path.isImportSpecifier() ||
            !binding.path.parentPath.isImportDeclaration()
          )
            return;
          const imported = binding.path.node.imported;
          const name = t.isIdentifier(imported)
            ? imported.name
            : imported.value;
          const factory = internalRecipeFactoryKind({
            source: binding.path.parentPath.node.source.value,
            members: [name]
          });
          if (!factory?.compiled || !path.node.arguments.length) return;
          const configPath = path.get("arguments.0") as NodePath;
          const config = configPath.evaluate();
          if (config.confident && factory.packed)
            config.value = internalDecodeRecipePayload(config.value);
          if (
            !config.confident ||
            !config.value ||
            typeof config.value.defaultClassName !== "string"
          )
            return;
          const parent = path.parentPath;
          // Only immutable program bindings can be followed by target().
          const tracked =
            parent.isVariableDeclarator() &&
            parent.node.init === path.node &&
            t.isIdentifier(parent.node.id) &&
            program.scope.getBinding(parent.node.id.name)?.path === parent &&
            program.scope.getBinding(parent.node.id.name)?.constant;
          recipes.set(path.node, {
            id: config.value.defaultClassName,
            used: tracked ? new Set() : null,
            classes: new Set(
              [
                config.value.defaultClassName,
                ...Object.values(
                  config.value.variantClassNames as Record<
                    string,
                    Record<string, string>
                  >
                ).flatMap(Object.values),
                ...(config.value.compoundVariants as [unknown, string][]).map(
                  ([, value]) => value
                )
              ].flatMap((value) => value.split(/\s+/))
            ),
            runtime: createClassRuntimeFn(config.value)
          });
        }
      });
    for (const [id, program] of programs) {
      const preserve = options.preserve?.find((item) => item.module === id);
      if (internalHasObservablePrototypeMutation(program)) opaque = true;
      program.traverse({
        ImportNamespaceSpecifier() {
          opaque = true;
        },
        ExportNamespaceSpecifier() {
          opaque = true;
        },
        ExportAllDeclaration() {
          opaque = true;
        },
        StringLiteral(path) {
          if (
            path.findParent(
              (parent) => parent.isCallExpression() && recipes.has(parent.node)
            )
          )
            return;
          if (
            path.parentPath.isImportDeclaration() ||
            path.parentPath.isExportNamedDeclaration() ||
            path.parentPath.isExportAllDeclaration()
          )
            return;
          const declaration = path.findParent((parent) =>
            parent.isVariableDeclarator()
          );
          if (
            declaration?.isVariableDeclarator() &&
            declaration.get("init").evaluate().confident
          )
            return;
          pinTokens(path.node.value);
          for (const name of path.node.value.split(/\s+/).filter(Boolean))
            classReferences.add(name);
        },
        ReferencedIdentifier(path) {
          if (
            path.scope.getBinding(path.node.name) !==
            program.scope.getBinding(path.node.name)
          )
            return;
          const resolved = target(id, path.node.name);
          if (!resolved) return;
          const recipe = resolved.isCallExpression()
            ? recipes.get(resolved.node)
            : undefined;
          const parent = path.parentPath;
          if (
            parent.isVariableDeclarator() &&
            parent.node.init === path.node &&
            t.isIdentifier(parent.node.id) &&
            parent.parentPath.isVariableDeclaration({ kind: "const" }) &&
            program.scope.getBinding(parent.node.id.name)?.path === parent
          )
            return;
          if (parent.isExportSpecifier() || parent.isExportNamedDeclaration()) {
            const exported = parent.isExportSpecifier()
              ? parent.node.exported
              : undefined;
            const name = exported
              ? t.isIdentifier(exported)
                ? exported.name
                : exported.value
              : path.node.name;
            if (
              !modules.get(id)?.entry &&
              !dynamicRoots.has(id) &&
              !(
                preserve &&
                (!preserve.exports || preserve.exports.includes(name))
              )
            )
              return;
          }
          if (recipe) {
            if (!recipe.used) return;
            if (
              parent.isCallExpression() &&
              parent.node.callee === path.node &&
              parent.node.arguments.length <= 1
            ) {
              const arg = parent.get("arguments.0") as NodePath | undefined;
              const values: unknown[] = [];
              const collect = (value: NodePath | undefined) => {
                if (!value?.node) {
                  values.push(undefined);
                  return;
                }
                if (value.isConditionalExpression()) {
                  collect(value.get("consequent"));
                  collect(value.get("alternate"));
                  return;
                }
                const result = value.evaluate();
                if (!result.confident || values.length >= 256)
                  throw new Error("Dynamic recipe selection");
                values.push(result.value);
              };
              try {
                collect(arg);
                for (const value of values)
                  for (const name of recipe
                    .runtime(value as never)
                    .split(/\s+/)
                    .filter(Boolean))
                    recipe.used.add(name);
              } catch {
                recipe.used = null;
              }
            } else recipe.used = null;
          } else {
            let value = resolved.evaluate();
            let cursor: NodePath = path;
            while (
              value.confident &&
              cursor.parentPath?.isMemberExpression() &&
              cursor.parentPath.node.object === cursor.node
            ) {
              const member = cursor.parentPath.node;
              const key =
                !member.computed && t.isIdentifier(member.property)
                  ? member.property.name
                  : t.isStringLiteral(member.property) ||
                      t.isNumericLiteral(member.property)
                    ? member.property.value
                    : undefined;
              if (
                key === undefined ||
                !value.value ||
                typeof value.value !== "object" ||
                !Object.hasOwn(value.value, key)
              )
                break;
              value = {
                confident: true,
                value: value.value[key],
                deopt: null as never
              };
              cursor = cursor.parentPath;
            }
            if (value.confident) pinTokens(value.value);
          }
        },
        ExportNamedDeclaration(path) {
          const names = path.node.declaration
            ? Object.keys(t.getBindingIdentifiers(path.node.declaration))
            : path.node.specifiers
                .filter((specifier) => t.isExportSpecifier(specifier))
                .map((specifier) =>
                  t.isIdentifier(specifier.exported)
                    ? specifier.exported.name
                    : specifier.exported.value
                );
          for (const name of names) {
            if (
              !modules.get(id)?.entry &&
              !dynamicRoots.has(id) &&
              !(
                preserve &&
                (!preserve.exports || preserve.exports.includes(name))
              )
            )
              continue;
            const value = target(id, name, true);
            if (value?.isCallExpression()) {
              const recipe = recipes.get(value.node);
              if (recipe) recipe.used = null;
            }
            if (value) {
              const literal = value.evaluate();
              if (literal.confident) pinTokens(literal.value);
            }
          }
        }
      });
    }
  } catch {
    opaque = true;
  }
  return {
    opaque,
    recipes: [...recipes.values()].map(
      (recipe): PrivateRecipeUse => ({
        id: recipe.id,
        used:
          opaque || recipe.used === null
            ? null
            : [
                ...new Set([
                  ...recipe.used,
                  ...[...classReferences].filter((name) =>
                    recipe.classes.has(name)
                  )
                ])
              ].sort()
      })
    ),
    variableReferences: [...variableReferences].sort(),
    reason: opaque ? "open-or-opaque-graph" : "closed-import-graph"
  };
}

export function staticModuleSpecifiers(source: string): string[] {
  const names = new Set<string>();
  const ast = parseSync(source, {
    configFile: false,
    babelrc: false,
    sourceType: "unambiguous",
    parserOpts: { plugins: ["jsx", "typescript"] }
  });
  if (!ast) return [];
  traverse(ast, {
    ImportDeclaration(path) {
      names.add(path.node.source.value);
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) names.add(path.node.source.value);
    },
    ExportAllDeclaration(path) {
      names.add(path.node.source.value);
    },
    CallExpression(path) {
      if (
        t.isImport(path.node.callee) &&
        t.isStringLiteral(path.node.arguments[0])
      )
        names.add(path.node.arguments[0].value);
    }
  });
  return [...names];
}

/** Demand slicing is confined to an acyclic, closed, non-throwing ESM data graph. */
import {
  parseSync,
  transformFromAstSync,
  traverse,
  types as t
} from "@babel/core";
import type { NodePath } from "@babel/core";
import type { InternalSourceAstCache } from "@mincho-js/babel";
import type { PluginBuild } from "esbuild";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { recordCompilationDiagnostic } from "./diagnostics.js";
import { configurationFiles } from "./compilationInputs.js";

type Value =
  | null
  | string
  | number
  | boolean
  | Value[]
  | { [key: string]: Value };

type Demand = Set<string>; // JSON member paths; [] means the complete value.

interface Edge {
  source: string;
  target?: Module;
}

interface Module {
  path: string;
  source: string;
  ast: t.File;
  imports: Map<string, { edge: Edge; imported: string }>;
  edges: Edge[];
  exports: Map<
    string,
    {
      local?: string;
      expression?: t.Expression;
      edge?: Edge;
      imported?: string;
    }
  >;
  declarations: Map<string, t.Expression>;
  closed?: boolean;
  proving?: boolean;
  values?: Record<string, Value>;
  demand: Map<string, Demand>;
}

const whole = () => new Set(["[]"]);

const failure = Symbol("unproved");

// Remove only familiar imports that compile() always treats as external. Any
// remaining import/from token includes aliases and re-exports, not just relative
// paths. Unfamiliar spelling proceeds to the existing AST/resolver proof.
const intrinsicImports =
  /\bimport\s*(?:\{[^{}]*\}\s*from\s*)?(["'])(?:@mincho-js\/css|@vanilla-extract\/css)(?:\/[^"'\\\r\n]*)?\1\s*;?/g;

function key(node: t.ObjectProperty | t.MemberExpression): string | undefined {
  const property = t.isObjectProperty(node) ? node.key : node.property;
  const value =
    !node.computed && t.isIdentifier(property)
      ? property.name
      : t.isStringLiteral(property) || t.isNumericLiteral(property)
        ? String(property.value)
        : undefined;

  return value !== undefined &&
    !["__proto__", "constructor", "prototype"].includes(value)
    ? value
    : undefined;
}

function unwrap(node: t.Expression): t.Expression {
  return t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
    ? unwrap(node.expression)
    : node;
}

function valueOf(
  node: t.Expression,
  bindings: Map<string, Value>,
  depth = 0
): Value | typeof failure {
  if (depth > 64) return failure;

  node = unwrap(node);

  if (
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNumericLiteral(node)
  )
    return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isIdentifier(node))
    return bindings.has(node.name) ? bindings.get(node.name)! : failure;
  if (
    t.isUnaryExpression(node) &&
    (node.operator === "+" || node.operator === "-") &&
    t.isNumericLiteral(node.argument)
  )
    return node.operator === "-" ? -node.argument.value : node.argument.value;

  if (t.isMemberExpression(node) && t.isExpression(node.object)) {
    const object = valueOf(node.object, bindings, depth + 1);
    const property = key(node);

    return property !== undefined &&
      object !== failure &&
      object !== null &&
      typeof object === "object" &&
      Object.hasOwn(object, property)
      ? (object as Record<string, Value>)[property]!
      : failure;
  }

  if (t.isArrayExpression(node)) {
    const result: Value[] = [];

    for (const entry of node.elements) {
      if (!t.isExpression(entry)) return failure;

      const value = valueOf(entry, bindings, depth + 1);
      if (value === failure) return failure;

      result.push(value);
    }

    return result;
  }

  if (t.isObjectExpression(node)) {
    const result: Record<string, Value> = {};

    for (const entry of node.properties) {
      if (!t.isObjectProperty(entry) || !t.isExpression(entry.value))
        return failure;

      const property = key(entry);
      if (property === undefined || Object.hasOwn(result, property))
        return failure;

      const value = valueOf(entry.value, bindings, depth + 1);
      if (value === failure) return failure;

      result[property] = value;
    }

    return result;
  }

  return failure;
}

function addDemand(
  map: Map<string, Demand>,
  name: string,
  incoming: Demand
): boolean {
  const previous = map.get(name);
  if (previous?.has("[]")) return false;

  if (incoming.has("[]")) {
    map.set(name, whole());

    return true;
  }

  const next = previous ?? new Set<string>();
  let changed = !previous;

  for (const value of incoming)
    if (!next.has(value)) {
      next.add(value);
      changed = true;
    }

  map.set(name, next);

  return changed;
}

function expressionDemand(path: NodePath): Demand {
  const members: string[] = [];
  let current = path;

  while (current.parentPath?.isMemberExpression() && current.key === "object") {
    const property = key(current.parentPath.node);
    if (property === undefined) return whole();

    members.push(property);
    current = current.parentPath;
  }

  // Optional access, mutation, reflection or an escaping binding requests its full value.
  if (current.parentPath?.isOptionalMemberExpression()) return whole();

  return new Set([JSON.stringify(members)]);
}

function inspect(
  source: string,
  path: string,
  parser?: InternalSourceAstCache,
  loader = "tsx"
): Module | undefined {
  try {
    const jsx = loader === "jsx" || loader === "tsx";
    const typescript = loader === "ts" || loader === "tsx";
    const input = {
      resolvedFile: path,
      source,
      parserOptions: {
        plugins: [],
        sourceType: "module" as const,
        jsx,
        typescript
      }
    };

    const ast =
      parser?.parse(input) ??
      parseSync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        sourceType: "module",
        parserOpts: {
          plugins: [
            ...(typescript ? ["typescript" as const] : []),
            ...(jsx ? ["jsx" as const] : [])
          ]
        }
      });
    if (!ast) return;

    const module: Module = {
      path,
      source,
      ast,
      imports: new Map(),
      edges: [],
      exports: new Map(),
      declarations: new Map(),
      demand: new Map()
    };

    for (const statement of ast.program.body) {
      if (
        t.isImportDeclaration(statement) ||
        t.isExportAllDeclaration(statement) ||
        (t.isExportNamedDeclaration(statement) && statement.source)
      ) {
        if (
          ("importKind" in statement && statement.importKind === "type") ||
          ("exportKind" in statement && statement.exportKind === "type")
        )
          continue;

        const edge: Edge = { source: statement.source!.value };
        module.edges.push(edge);

        if (t.isImportDeclaration(statement)) {
          if (!statement.specifiers.length) module.closed = false;

          for (const specifier of statement.specifiers) {
            if (
              t.isImportSpecifier(specifier) &&
              specifier.importKind === "type"
            )
              continue;

            module.imports.set(specifier.local.name, {
              edge,
              imported: t.isImportDefaultSpecifier(specifier)
                ? "default"
                : t.isImportNamespaceSpecifier(specifier)
                  ? "*"
                  : t.isIdentifier(specifier.imported)
                    ? specifier.imported.name
                    : specifier.imported.value
            });
          }
        } else if (t.isExportNamedDeclaration(statement)) {
          for (const specifier of statement.specifiers) {
            if (!t.isExportSpecifier(specifier)) {
              module.closed = false;
              continue;
            }

            module.exports.set(
              t.isIdentifier(specifier.exported)
                ? specifier.exported.name
                : specifier.exported.value,
              { edge, imported: specifier.local.name }
            );
          }
        } else module.closed = false;

        continue;
      }

      if (t.isExportDefaultDeclaration(statement)) {
        if (t.isExpression(statement.declaration))
          module.exports.set("default", { expression: statement.declaration });
        else module.closed = false;

        continue;
      }

      const exported = t.isExportNamedDeclaration(statement);
      if (exported && statement.exportKind === "type") continue;

      const node = exported ? statement.declaration : statement;

      if (!node && exported) {
        for (const specifier of statement.specifiers) {
          if (!t.isExportSpecifier(specifier)) {
            module.closed = false;
            continue;
          }

          module.exports.set(
            t.isIdentifier(specifier.exported)
              ? specifier.exported.name
              : specifier.exported.value,
            { local: specifier.local.name }
          );
        }
      } else if (t.isVariableDeclaration(node) && node.kind === "const") {
        for (const declaration of node.declarations) {
          if (
            !t.isIdentifier(declaration.id) ||
            !t.isExpression(declaration.init)
          ) {
            module.closed = false;
            continue;
          }

          module.declarations.set(declaration.id.name, declaration.init);

          if (exported)
            module.exports.set(declaration.id.name, {
              local: declaration.id.name
            });
        }
      } else if (
        !(
          t.isTSTypeAliasDeclaration(node) ||
          t.isTSInterfaceDeclaration(node) ||
          t.isEmptyStatement(node)
        )
      )
        module.closed = false;
    }

    return module;
  } catch {
    return;
  }
}

function prove(module: Module): boolean {
  if (module.closed !== undefined) return module.closed;
  if (module.proving) return false;

  module.proving = true;

  const bindings = new Map<string, Value>();
  const exports: Record<string, Value> = {};
  let closed = module.edges.every((edge) => edge.target && prove(edge.target));

  if (closed) {
    for (const [name, imported] of module.imports) {
      const values = imported.edge.target!.values!;

      if (
        imported.imported !== "*" &&
        !Object.hasOwn(values, imported.imported)
      ) {
        closed = false;
        break;
      }

      bindings.set(
        name,
        imported.imported === "*" ? values : values[imported.imported]!
      );
    }

    // Default export expressions execute at their source position, unlike
    // named export bindings. Check them before later const declarations exist.
    for (const statement of module.ast.program.body) {
      const declaration = t.isExportNamedDeclaration(statement)
        ? statement.declaration
        : statement;

      if (t.isVariableDeclaration(declaration)) {
        for (const entry of declaration.declarations) {
          const value = valueOf(entry.init as t.Expression, bindings);

          if (value === failure) {
            closed = false;
            break;
          }

          bindings.set((entry.id as t.Identifier).name, value);
        }
      } else if (
        t.isExportDefaultDeclaration(statement) &&
        valueOf(statement.declaration as t.Expression, bindings) === failure
      )
        closed = false;

      if (!closed) break;
    }

    for (const [name, entry] of module.exports) {
      const values = entry.edge?.target?.values;
      const value = entry.local
        ? bindings.has(entry.local)
          ? bindings.get(entry.local)!
          : failure
        : entry.expression
          ? valueOf(entry.expression, bindings)
          : values && Object.hasOwn(values, entry.imported!)
            ? values[entry.imported!]!
            : failure;

      if (value === failure || name === "__proto__") {
        closed = false;
        break;
      }

      exports[name] = value;
    }
  }

  module.proving = false;
  module.closed = closed;

  if (closed) module.values = exports;

  return closed;
}

function sliceExpression(
  node: t.Expression,
  demand: Demand,
  request: (name: string, demand: Demand) => void
): t.Expression {
  const expression = t.cloneNode(node, true);

  if (
    t.isTSAsExpression(expression) ||
    t.isTSSatisfiesExpression(expression) ||
    t.isTSNonNullExpression(expression)
  ) {
    expression.expression = sliceExpression(
      expression.expression,
      demand,
      request
    );
  } else if (t.isIdentifier(expression)) request(expression.name, demand);
  else if (
    t.isMemberExpression(expression) &&
    t.isExpression(expression.object)
  ) {
    const property = key(expression)!;
    expression.object = sliceExpression(
      expression.object,
      new Set(
        [...demand].map((path) =>
          JSON.stringify([property, ...JSON.parse(path)])
        )
      ),
      request
    );
  } else if (t.isObjectExpression(expression)) {
    expression.properties = expression.properties.flatMap((property) => {
      const entry = property as t.ObjectProperty;
      const name = key(entry)!;
      const paths = demand.has("[]")
        ? whole()
        : new Set(
            [...demand].flatMap((path) => {
              const [first, ...rest] = JSON.parse(path);

              return first === name ? [JSON.stringify(rest)] : [];
            })
          );
      if (!paths.size) return [];

      entry.value = sliceExpression(
        entry.value as t.Expression,
        paths,
        request
      );

      return [entry];
    });
  } else if (t.isArrayExpression(expression))
    expression.elements = expression.elements.map((entry) =>
      sliceExpression(entry as t.Expression, whole(), request)
    );

  return expression;
}

export interface EvaluationDependencyGraph {
  readonly sources: ReadonlyMap<string, string>;
  readonly watchFiles: readonly string[];
}

/** Reads are routed through the same transaction as compilation; no global mutable graph. */
export async function prepareEvaluationDependencyGraph(input: {
  source: string;
  filePath: string;
  cwd: string;
  build: PluginBuild;
  readFile: (file: string) => Promise<string>;
  parser?: InternalSourceAstCache;
  loaderForFile?: (file: string) => string | undefined;
}): Promise<EvaluationDependencyGraph | undefined> {
  try {
    if (Buffer.byteLength(input.source) > 2 * 1024 * 1024)
      throw new Error("graph-limit");

    if (!/\\|\/[/*]/.test(input.source)) {
      const remainder = input.source.replace(intrinsicImports, "");

      if (
        remainder !== input.source &&
        !/\b(?:import|from|require|eval)\b/.test(remainder)
      ) {
        recordCompilationDiagnostic("dependency-graph-bypass", {
          reason: "external-intrinsic-imports-only"
        });

        return;
      }
    }

    const root = inspect(input.source, input.filePath, input.parser);
    if (!root) return;

    const modules = new Map([[resolve(input.filePath), root]]);
    let bytes = Buffer.byteLength(input.source);
    let opaque = false;

    const discover = async (module: Module, depth: number): Promise<void> => {
      if (depth > 32 || modules.size > 128 || bytes > 2 * 1024 * 1024)
        throw new Error("graph-limit");

      traverse(module.ast, {
        CallExpression(path) {
          if (
            t.isImport(path.node.callee) ||
            (t.isIdentifier(path.node.callee) &&
              ["require", "eval"].includes(path.node.callee.name))
          ) {
            opaque = true;
            recordCompilationDiagnostic(
              "dependency-reachability-widened",
              () => ({
                file: module.path,
                reason: t.isIdentifier(path.node.callee)
                  ? path.node.callee.name === "require"
                    ? "commonjs"
                    : "dynamic-eval"
                  : "dynamic-import"
              })
            );
          }
        },

        ImportExpression() {
          opaque = true;
          recordCompilationDiagnostic(
            "dependency-reachability-widened",
            () => ({
              file: module.path,
              reason: "dynamic-import"
            })
          );
        }
      });

      for (const edge of module.edges) {
        const resolved = await input.build.resolve(edge.source, {
          resolveDir: dirname(module.path),
          kind: "import-statement"
        });
        if (
          resolved.errors.length ||
          resolved.external ||
          resolved.namespace !== "file" ||
          resolved.suffix ||
          !/\.[cm]?[jt]sx?$/.test(resolved.path)
        )
          continue;

        // Package modules and custom namespaces keep their original import/effect contract.
        const local = relative(resolve(input.cwd), resolved.path);
        const loader =
          input.loaderForFile?.(resolved.path) ??
          (/\.[cm]?tsx?$/.test(resolved.path) ? "ts" : "js");
        if (
          !["js", "jsx", "ts", "tsx"].includes(loader) ||
          !isAbsolute(resolved.path) ||
          /[/\\]node_modules[/\\]/.test(resolved.path) ||
          local.startsWith("..") ||
          isAbsolute(local)
        )
          continue;

        let target = modules.get(resolved.path);

        if (!target) {
          const source = await input.readFile(resolved.path);
          bytes += Buffer.byteLength(source);

          if (bytes > 2 * 1024 * 1024) throw new Error("graph-limit");

          target = inspect(source, resolved.path, input.parser, loader);

          if (!target) {
            opaque = true;
            continue;
          }

          modules.set(resolved.path, target);
          await discover(target, depth + 1);
        }

        edge.target = target;
      }
    };

    await discover(root, 0);

    if (opaque) {
      recordCompilationDiagnostic("dependency-graph-bypass", {
        reason: "opaque-module-edge"
      });

      return;
    }

    for (const module of modules.values()) prove(module);

    if (
      ![...modules.values()].some((module) => module !== root && module.closed)
    ) {
      recordCompilationDiagnostic("dependency-graph-bypass", {
        reason: "no-closed-data-dependencies"
      });

      return;
    }

    // Root exports always remain observable. Only dependency source is sliced.
    root.closed = false;

    // An effectful sibling can mutate an imported object before another module
    // evaluates it. Only primitive reads may leave the closed data graph. An
    // escaping object, write or direct eval invalidates the purity proof; merely
    // requesting all of its members would still permit suppressing a throw.
    let widened = true;

    while (widened) {
      widened = false;

      for (const module of modules.values()) {
        if (
          module.closed &&
          module.edges.some((edge) => !edge.target?.closed)
        ) {
          module.closed = false;
          widened = true;
        }

        if (module.closed) continue;

        // An escaping re-export must revoke its leaf's proof too: there may be
        // no local import reference for Babel's binding traversal to discover.
        for (const entry of module.exports.values()) {
          const target = entry.edge?.target;
          const value = target?.values?.[entry.imported!];

          if (target?.closed && value !== null && typeof value === "object") {
            target.closed = false;
            widened = true;
          }
        }

        for (const statement of module.ast.program.body)
          if (t.isExportAllDeclaration(statement)) {
            const target = module.edges.find(
              (edge) => edge.source === statement.source.value
            )?.target;

            if (target?.closed) {
              recordCompilationDiagnostic(
                "dependency-reachability-widened",
                () => ({
                  file: module.path,
                  reason: "export-star",
                  target: target.path
                })
              );
              target.closed = false;
              widened = true;
            }
          }

        traverse(module.ast, {
          Program(path) {
            for (const [name, imported] of module.imports) {
              const target = imported.edge.target;
              if (!target?.closed) continue;

              const binding = path.scope.getBinding(name);
              let open = Boolean(binding?.constantViolations.length);

              for (const reference of binding?.referencePaths ?? []) {
                let current: NodePath = reference;
                let value: Value | undefined =
                  imported.imported === "*"
                    ? target.values
                    : target.values?.[imported.imported];

                while (
                  current.parentPath?.isMemberExpression() &&
                  current.key === "object"
                ) {
                  const property = key(current.parentPath.node);

                  if (property === undefined) {
                    open = true;
                    break;
                  }

                  value =
                    value !== null &&
                    typeof value === "object" &&
                    Object.hasOwn(value, property)
                      ? (value as Record<string, Value>)[property]
                      : undefined;
                  current = current.parentPath;
                }

                if (
                  (value !== null && typeof value === "object") ||
                  current.parentPath?.isOptionalMemberExpression() ||
                  ((current.parentPath?.isCallExpression() ||
                    current.parentPath?.isOptionalCallExpression()) &&
                    current.key === "callee") ||
                  (current.parentPath?.isAssignmentExpression() &&
                    current.key === "left") ||
                  current.parentPath?.isUpdateExpression() ||
                  (current.parentPath?.isUnaryExpression() &&
                    current.parentPath.node.operator === "delete")
                )
                  open = true;
              }

              if (open) {
                target.closed = false;
                widened = true;
              }
            }

            path.stop();
          }
        });
      }
    }

    if (![...modules.values()].some((module) => module.closed)) {
      recordCompilationDiagnostic("dependency-graph-bypass", {
        reason: "no-closed-data-after-escape"
      });

      return;
    }

    const configurations = configurationFiles(modules.keys()).filter((file) =>
      /(?:[/\\]package\.json$|\.babelrc(?:\.|$)|\.babelignore$|babel\.config\.)/.test(
        file
      )
    );

    for (const file of configurations) {
      let source: string;

      try {
        source = await input.readFile(file);
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? ""
          )
        )
          continue;

        throw error;
      }

      if (!file.endsWith("package.json") || JSON.parse(source).babel) {
        recordCompilationDiagnostic("dependency-graph-bypass", {
          reason: "external-babel-configuration",
          file
        });

        return;
      }
    }

    const queue = new Set<Module>();

    const request = (module: Module, name: string, demand: Demand) => {
      if (!module.closed) return;

      if (name === "*") {
        if (demand.has("[]"))
          for (const exported of module.exports.keys())
            request(module, exported, whole());
        else
          for (const member of demand) {
            const [first, ...rest] = JSON.parse(member);
            request(module, first, new Set([JSON.stringify(rest)]));
          }
      } else if (
        module.exports.has(name) &&
        addDemand(module.demand, name, demand)
      )
        queue.add(module);
    };

    const importedRequest = (
      imported: { edge: Edge; imported: string },
      demand: Demand
    ) => {
      if (imported.edge.target)
        request(imported.edge.target, imported.imported, demand);
    };

    for (const module of modules.values())
      if (!module.closed) {
        traverse(module.ast, {
          Program(path) {
            for (const [name, imported] of module.imports) {
              const binding = path.scope.getBinding(name);
              const references = binding?.referencePaths;

              if (!references?.length) importedRequest(imported, whole());
              else
                for (const reference of references)
                  importedRequest(imported, expressionDemand(reference));
            }

            for (const statement of module.ast.program.body) {
              if (t.isExportAllDeclaration(statement)) {
                const target = module.edges.find(
                  (edge) => edge.source === statement.source.value
                )?.target;

                if (target) request(target, "*", whole());
              }
            }

            for (const entry of module.exports.values())
              if (entry.edge?.target)
                request(entry.edge.target, entry.imported!, whole());

            path.stop();
          }
        });
      }

    const sources = new Map<string, string>();

    const slice = (module: Module): void => {
      const locals = new Map<string, Demand>();
      const pending = new Set<string>();

      const localRequest = (name: string, demand: Demand) => {
        if (addDemand(locals, name, demand)) pending.add(name);
      };

      for (const [name, demand] of module.demand) {
        const entry = module.exports.get(name)!;

        if (entry.local) localRequest(entry.local, demand);
        else if (entry.expression)
          sliceExpression(entry.expression, demand, localRequest);
        else if (entry.edge?.target)
          request(entry.edge.target, entry.imported!, demand);
      }

      for (const name of pending) {
        pending.delete(name);

        const demand = locals.get(name)!;
        const imported = module.imports.get(name);

        if (imported) importedRequest(imported, demand);
        else {
          const expression = module.declarations.get(name);

          if (expression) sliceExpression(expression, demand, localRequest);
        }
      }

      const body: t.Statement[] = [];

      for (const statement of module.ast.program.body) {
        if (t.isImportDeclaration(statement)) {
          const kept = t.cloneNode(statement, true);
          kept.specifiers = kept.specifiers.filter((specifier) =>
            locals.has(specifier.local.name)
          );

          if (kept.specifiers.length) body.push(kept);

          continue;
        }

        if (t.isExportDefaultDeclaration(statement)) {
          const demand = module.demand.get("default");

          if (demand)
            body.push(
              t.exportDefaultDeclaration(
                sliceExpression(
                  statement.declaration as t.Expression,
                  demand,
                  () => {}
                )
              )
            );

          continue;
        }

        if (t.isExportNamedDeclaration(statement) && !statement.declaration) {
          const kept = t.cloneNode(statement, true);
          kept.specifiers = kept.specifiers.filter((specifier) =>
            module.demand.has(
              t.isIdentifier(specifier.exported)
                ? specifier.exported.name
                : specifier.exported.value
            )
          );

          if (kept.specifiers.length) body.push(kept);

          continue;
        }

        const declaration = t.isExportNamedDeclaration(statement)
          ? statement.declaration
          : statement;

        if (t.isVariableDeclaration(declaration)) {
          for (const entry of declaration.declarations) {
            const name = (entry.id as t.Identifier).name;
            const demand = locals.get(name);
            if (!demand) continue;

            body.push(
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier(name),
                  sliceExpression(entry.init as t.Expression, demand, () => {})
                )
              ])
            );

            if (
              t.isExportNamedDeclaration(statement) &&
              module.demand.has(name)
            )
              body.push(
                t.exportNamedDeclaration(null, [
                  t.exportSpecifier(t.identifier(name), t.identifier(name))
                ])
              );
          }
        }
      }

      if (!body.length) body.push(t.exportNamedDeclaration(null, []));

      const result = transformFromAstSync(
        t.file(t.program(body, module.ast.program.directives)),
        module.source,
        {
          filename: module.path,
          babelrc: false,
          configFile: false,
          ast: false,
          code: true
        }
      );
      if (!result?.code) throw new Error("graph-codegen");

      sources.set(module.path, result.code);
    };

    for (const module of modules.values()) if (module.closed) queue.add(module);

    let iterations = 0;

    for (const module of queue) {
      queue.delete(module);

      if (++iterations > 1024) throw new Error("graph-widen-limit");

      slice(module);
    }

    recordCompilationDiagnostic("dependency-graph", {
      modules: modules.size,
      closedModules: sources.size,
      iterations,
      inputBytes: bytes,
      outputBytes: [...sources.values()].reduce(
        (total, source) => total + Buffer.byteLength(source),
        0
      )
    });

    return {
      sources,
      watchFiles: [...new Set([...modules.keys(), ...configurations])].filter(
        (path) => path !== root.path
      )
    };
  } catch (error) {
    recordCompilationDiagnostic("dependency-graph-bypass", {
      reason: error instanceof Error ? error.message : "unproved-graph"
    });

    return;
  }
}

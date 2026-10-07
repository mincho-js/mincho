import {
  parseSync,
  transformFromAstSync,
  traverse,
  types as t,
  type NodePath
} from "@babel/core";
import type { Binding } from "@babel/traverse";
import { getModuleReference } from "../commonjs/bindings.js";
import { hasDynamicScope } from "./dynamicScope.js";

const runtimeSources = new Map([
  ["@mincho-js/react/jsx-runtime", "@mincho-js/react/compiled-jsx-runtime"],
  [
    "@mincho-js/react/jsx-dev-runtime",
    "@mincho-js/react/compiled-jsx-dev-runtime"
  ]
]);

const runtimeNames = new Set(["jsx", "jsxs", "jsxDEV"]);

function parse(source: string, filename: string) {
  const ast = parseSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }
  });

  let program: NodePath<t.Program> | undefined;

  if (ast)
    traverse(ast, {
      Program(path) {
        program = path;
        path.stop();
      }
    });

  return ast && program ? { ast, program } : undefined;
}

/** Original-source evidence. Unknown module requests cannot establish provenance. */
export function hasExplicitJsxRuntimeImport(
  source: string,
  filename: string
): boolean {
  try {
    const parsed = parse(source, filename);

    return !parsed || hasExplicitRuntimeReference(parsed.program);
  } catch {
    return true;
  }
}

function hasExplicitRuntimeReference(program: NodePath<t.Program>): boolean {
  let explicit = false;
  program.traverse({
    StringLiteral(path) {
      if (runtimeSources.has(path.node.value)) explicit = true;
    },

    TemplateLiteral(path) {
      if (
        !path.node.expressions.length &&
        runtimeSources.has(path.node.quasis[0]!.value.cooked ?? "")
      )
        explicit = true;
    },

    CallExpression(path) {
      if (
        t.isImport(path.node.callee) ||
        t.isIdentifier(path.node.callee, { name: "require" })
      ) {
        if (!t.isStringLiteral(path.node.arguments[0])) explicit = true;
      }
    },

    TSImportEqualsDeclaration(path) {
      const reference = path.node.moduleReference;

      if (
        t.isTSExternalModuleReference(reference) &&
        t.isStringLiteral(reference.expression) &&
        runtimeSources.has(reference.expression.value)
      )
        explicit = true;
    }
  });

  return explicit;
}

function staticKey(
  node: t.ObjectProperty | t.ObjectMethod
): string | undefined {
  if (!node.computed && t.isIdentifier(node.key)) return node.key.name;

  return t.isStringLiteral(node.key) || t.isNumericLiteral(node.key)
    ? String(node.key.value)
    : undefined;
}

function snapshotUsesOnly(binding: Binding): boolean {
  if (!binding.constant) return false;

  return binding.referencePaths.every((reference) => {
    const parent = reference.parentPath;

    return (
      (parent?.isJSXSpreadAttribute() &&
        parent.node.argument === reference.node) ||
      (parent?.isSpreadElement() && parent.parentPath.isObjectExpression())
    );
  });
}

/** Object rest makes a fresh snapshot; removing css is enough even for Proxy input. */
function cssExcludedRest(binding: Binding): boolean {
  const declaration = binding.path;
  if (
    !declaration.isVariableDeclarator() ||
    !t.isObjectPattern(declaration.node.id)
  )
    return false;

  return (
    declaration.node.id.properties.some(
      (property) =>
        t.isRestElement(property) &&
        t.isIdentifier(property.argument, { name: binding.identifier.name })
    ) &&
    declaration.node.id.properties.some(
      (property) =>
        t.isObjectProperty(property) && staticKey(property) === "css"
    )
  );
}

function safeProps(path: NodePath<t.Node>, seen = new Set<Binding>()): boolean {
  if (
    path.isTSAsExpression() ||
    path.isTSTypeAssertion() ||
    path.isTSNonNullExpression() ||
    path.isTSSatisfiesExpression() ||
    path.isParenthesizedExpression()
  )
    return safeProps(path.get("expression") as NodePath<t.Node>, seen);
  if (path.isNullLiteral()) return true;
  if (path.isConditionalExpression())
    return (
      safeProps(path.get("consequent"), seen) &&
      safeProps(path.get("alternate"), seen)
    );
  if (path.isObjectExpression()) {
    return path.get("properties").every((property) => {
      if (property.isSpreadElement())
        return safeProps(property.get("argument"), seen);
      if (!property.isObjectProperty()) return false;

      const key = staticKey(property.node);

      return key !== undefined && key !== "css" && key !== "__proto__";
    });
  }
  if (!path.isIdentifier()) return false;

  const binding = path.scope.getBinding(path.node.name);
  if (!binding || seen.has(binding) || !snapshotUsesOnly(binding)) return false;
  if (cssExcludedRest(binding)) return true;

  const declaration = binding.path;
  if (
    !declaration.isVariableDeclarator() ||
    !t.isIdentifier(declaration.node.id)
  )
    return false;

  const init = declaration.get("init");

  return init.isExpression() && safeProps(init, new Set(seen).add(binding));
}

/** Proof for esbuild's automatic JSX import, scoped to its final onLoad contents. */
export function canBypassJsxRuntimeGuards(
  source: string,
  filename: string
): boolean {
  try {
    const parsed = parse(source, filename);
    if (
      !parsed ||
      hasExplicitRuntimeReference(parsed.program) ||
      hasDynamicScope(parsed.program)
    )
      return false;

    let safe = true;
    parsed.program.traverse({
      JSXOpeningElement(path) {
        for (const attribute of path.get("attributes")) {
          if (attribute.isJSXSpreadAttribute()) {
            if (!safeProps(attribute.get("argument"))) safe = false;
          } else if (
            attribute.isJSXAttribute() &&
            t.isJSXIdentifier(attribute.node.name, { name: "css" })
          )
            safe = false;
        }
      }
    });

    return safe;
  } catch {
    return false;
  }
}

/** The adapter must prove these imports were introduced after the original-source pass. */
export function transformJsxRuntimeGuards(source: string, filename: string) {
  try {
    const parsed = parse(source, filename);
    if (!parsed || hasDynamicScope(parsed.program)) return null;

    const { ast, program } = parsed;
    const imports = new Map<string, t.Identifier>();
    const originalImports: NodePath<t.ImportDeclaration>[] = [];
    const originalRequires: NodePath<t.VariableDeclarator>[] = [];
    let changed = false;
    program.traverse({
      ImportDeclaration(path) {
        if (runtimeSources.has(path.node.source.value))
          originalImports.push(path);
      },

      VariableDeclarator(path) {
        const init = path.get("init");
        if (!init.isExpression()) return;

        const reference = getModuleReference(init);

        if (
          reference &&
          !reference.unsafe &&
          runtimeSources.has(reference.source)
        )
          originalRequires.push(path);
      },

      CallExpression: {
        exit(path) {
          const reference = getModuleReference(path.get("callee"));
          if (
            !reference ||
            reference.unsafe ||
            reference.members.length !== 1 ||
            !runtimeNames.has(reference.members[0] ?? "")
          )
            return;

          const target = runtimeSources.get(reference.source);
          if (
            !target ||
            path.node.optional ||
            path.node.arguments.some((argument) => t.isSpreadElement(argument))
          )
            return;

          const props = path.get("arguments")[1];
          if (!props?.isExpression() || !safeProps(props)) return;

          const name = reference.members[0]!;
          const key = `${reference.kind}:${target}:${name}`;
          let identifier = imports.get(key);

          if (!identifier) {
            identifier = program.scope.generateUidIdentifier(
              `minchoCompiled${name}`
            );
            imports.set(key, identifier);

            if (reference.kind === "import") {
              program.unshiftContainer(
                "body",
                t.importDeclaration(
                  [
                    t.importSpecifier(
                      t.cloneNode(identifier),
                      t.identifier(name)
                    )
                  ],
                  t.stringLiteral(target)
                )
              );
            } else {
              program.unshiftContainer(
                "body",
                t.variableDeclaration("var", [
                  t.variableDeclarator(
                    t.cloneNode(identifier),
                    t.memberExpression(
                      t.callExpression(t.identifier("require"), [
                        t.stringLiteral(target)
                      ]),
                      t.identifier(name)
                    )
                  )
                ])
              );
            }
          }

          path.get("callee").replaceWith(t.cloneNode(identifier));
          changed = true;
        }
      }
    });

    if (!changed) return null;

    program.scope.crawl();

    for (const declaration of originalImports) {
      for (const specifier of declaration.get("specifiers")) {
        const binding = declaration.scope.getBinding(specifier.node.local.name);

        if (binding && !binding.referenced) specifier.remove();
      }

      if (!declaration.node.specifiers.length) declaration.remove();
    }

    for (const declaration of originalRequires) {
      const names = Object.keys(t.getBindingIdentifiers(declaration.node.id));

      if (
        names.length &&
        names.every((name) => !declaration.scope.getBinding(name)?.referenced)
      )
        declaration.remove();
    }

    const result = transformFromAstSync(ast, source, {
      filename,
      sourceFileName: filename,
      configFile: false,
      babelrc: false,
      cloneInputAst: false,
      sourceMaps: true
    });

    return result?.code ? { code: result.code, map: result.map ?? null } : null;
  } catch {
    return null;
  }
}

import { parseSync, traverse, types as t, type NodePath } from "@babel/core";

/** Read final compiler literals without importing or executing application modules. */
export function readStaticStringExport(
  source: string,
  exported: string
): string | undefined {
  let result: string | undefined;
  const ast = parseSync(source, {
    configFile: false,
    babelrc: false,
    sourceType: "module"
  });
  if (!ast) return;
  traverse(ast, {
    Program(path) {
      let local = exported;
      for (const statement of path.node.body)
        if (t.isExportNamedDeclaration(statement) && !statement.source)
          for (const specifier of statement.specifiers)
            if (
              t.isExportSpecifier(specifier) &&
              (t.isIdentifier(specifier.exported)
                ? specifier.exported.name
                : specifier.exported.value) === exported
            )
              local = specifier.local.name;
      const binding = path.scope.getBinding(local);
      if (!binding?.constant || !binding.path.isVariableDeclarator()) return;
      const init = binding.path.get("init");
      const value = init.evaluate();
      if (!value.confident) return;
      if (t.isIdentifier(binding.path.node.id))
        result = typeof value.value === "string" ? value.value : undefined;
      else if (t.isArrayPattern(binding.path.node.id)) {
        const index = binding.path.node.id.elements.findIndex((item) =>
          t.isIdentifier(item, { name: local })
        );
        if (
          Array.isArray(value.value) &&
          typeof value.value[index] === "string"
        )
          result = value.value[index];
      }
      path.stop();
    }
  });
  return result;
}

/** Resolve extracted/reexported theme constants before final chunks are rendered. */
export async function readStaticStringExportGraph(
  id: string,
  exported: string,
  provider: {
    source(id: string): string | undefined;
    resolve(importer: string, source: string): Promise<string | undefined>;
  }
): Promise<string | undefined> {
  const seen = new Set<string>();
  const programs = new Map<string, NodePath<t.Program>>();
  const read = async (
    id: string,
    name: string,
    exported: boolean
  ): Promise<unknown> => {
    const key = `${id}:${name}:${exported}`;
    if (seen.has(key) || seen.size > 64) return;
    seen.add(key);
    let program = programs.get(id);
    if (!program) {
      const source = provider.source(id);
      if (source === undefined) return;
      const ast = parseSync(source, {
        configFile: false,
        babelrc: false,
        sourceType: "module"
      });
      if (!ast) return;
      traverse(ast, {
        Program(path) {
          program = path;
          programs.set(id, path);
          path.stop();
        }
      });
    }
    if (!program) return;
    if (exported)
      for (const statement of program.get("body")) {
        if (!statement.isExportNamedDeclaration()) continue;
        for (const specifier of statement.node.specifiers) {
          if (
            !t.isExportSpecifier(specifier) ||
            (t.isIdentifier(specifier.exported)
              ? specifier.exported.name
              : specifier.exported.value) !== name
          )
            continue;
          const source = statement.node.source?.value;
          const next = source ? await provider.resolve(id, source) : id;
          return next ? read(next, specifier.local.name, !!source) : undefined;
        }
      }
    const binding = program.scope.getBinding(name);
    if (!binding?.constant) return;
    if (
      binding.path.isImportSpecifier() &&
      binding.path.parentPath.isImportDeclaration()
    ) {
      const next = await provider.resolve(
        id,
        binding.path.parentPath.node.source.value
      );
      const imported = binding.path.node.imported;
      return next
        ? read(
            next,
            t.isIdentifier(imported) ? imported.name : imported.value,
            true
          )
        : undefined;
    }
    if (!binding.path.isVariableDeclarator()) return;
    const expression = async (path: NodePath): Promise<unknown> => {
      const evaluated = path.evaluate();
      if (evaluated.confident) return evaluated.value;
      if (path.isIdentifier()) return read(id, path.node.name, false);
      if (path.isMemberExpression()) {
        const key =
          !path.node.computed && t.isIdentifier(path.node.property)
            ? path.node.property.name
            : t.isStringLiteral(path.node.property) ||
                t.isNumericLiteral(path.node.property)
              ? path.node.property.value
              : undefined;
        const value = await expression(path.get("object"));
        if (
          key !== undefined &&
          value &&
          typeof value === "object" &&
          Object.hasOwn(value, key)
        )
          return (value as Record<string | number, unknown>)[key];
      }
    };
    const value = await expression(binding.path.get("init") as NodePath);
    if (t.isArrayPattern(binding.path.node.id)) {
      const index = binding.path.node.id.elements.findIndex((element) =>
        t.isIdentifier(element, { name })
      );
      return Array.isArray(value) ? value[index] : undefined;
    }
    return value;
  };
  try {
    const value = await read(id, exported, true);
    return typeof value === "string" ? value : undefined;
  } catch {
    return;
  }
}

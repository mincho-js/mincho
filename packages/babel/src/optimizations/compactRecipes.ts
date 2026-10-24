import { transformFromAstSync, types as t, type NodePath } from "@babel/core";
import { addNamed } from "@babel/helper-module-imports";
import { getModuleReference } from "../commonjs/bindings.js";
import { hasDynamicScope } from "./dynamicScope.js";
import { hasObservablePrototypeMutation } from "./recipeMetadata.js";
import {
  bundleSizeMetric,
  measureBundleMetric,
  runtimeHelperOverhead,
  type BundleBytes,
  type BundleSizeOptions
} from "../bundleSize.js";

type Literal =
  | string
  | boolean
  | number
  | null
  | undefined
  | Literal[]
  | { [key: string]: Literal };

function literal(node: t.Node): Literal {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node)
  )
    return node.value;
  if (t.isNullLiteral(node)) return null;
  if (
    t.isUnaryExpression(node, { operator: "void" }) &&
    t.isNumericLiteral(node.argument)
  )
    return undefined;
  if (t.isArrayExpression(node))
    return node.elements.map((item) => {
      if (!item || !t.isExpression(item)) throw new Error("Opaque array");
      return literal(item);
    });
  if (t.isObjectExpression(node)) {
    const value: Record<string, Literal> = {};
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop) || prop.computed)
        throw new Error("Opaque object");
      const key = t.isIdentifier(prop.key)
        ? prop.key.name
        : t.isStringLiteral(prop.key)
          ? prop.key.value
          : undefined;
      if (key === undefined || key === "__proto__" || Object.hasOwn(value, key))
        throw new Error("Observable key");
      value[key] = literal(prop.value);
    }
    return value;
  }
  throw new Error("Nonliteral compiler config");
}

function print(node: t.Expression) {
  return transformFromAstSync(
    t.file(t.program([t.expressionStatement(node)])),
    undefined,
    {
      configFile: false,
      babelrc: false,
      compact: true,
      minified: true,
      comments: false
    }
  )!.code!;
}

function pack(value: Literal): t.Expression {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const key = (text: string) => {
    if (!index.has(text)) {
      index.set(text, strings.length);
      strings.push(text);
    }
    return index.get(text)!;
  };
  const encode = (item: Literal): unknown => {
    if (typeof item === "string") return ["s", key(item)];
    if (item === undefined) return ["u"];
    if (Array.isArray(item)) return ["a", item.map(encode)];
    if (item && typeof item === "object")
      return [
        "o",
        Object.entries(item).map(([name, val]) => [key(name), encode(val)])
      ];
    return item;
  };
  const root = encode(value);
  return t.valueToNode([1, strings, root]) as t.Expression;
}

/** Only literal configurations of compiler-owned immutable factory APIs qualify. */
export function compactRecipes(
  program: NodePath<t.Program>,
  options: {
    compactRuntime?: boolean;
    compactMetadata?: boolean;
    bundleSize?: BundleSizeOptions;
  }
): boolean {
  if (
    (!options.compactRuntime && !options.compactMetadata) ||
    hasDynamicScope(program) ||
    hasObservablePrototypeMutation(program)
  )
    return false;

  const overheadCache = new Map<
    string,
    ReturnType<typeof runtimeHelperOverhead>
  >();
  const helperOverhead = (
    before: string,
    after: string,
    metric: keyof BundleBytes
  ) => {
    const key = `${before}\0${after}\0${metric}`;

    if (!overheadCache.has(key))
      overheadCache.set(key, runtimeHelperOverhead(before, after, metric));

    return overheadCache.get(key);
  };

  let changed = false;
  const imports = new Map<string, t.Identifier>();
  program.traverse({
    CallExpression(path) {
      const factory = getModuleReference(path.get("callee"));
      if (!factory || factory.unsafe) return;
      const name = factory.members.join(".");
      const full =
        factory.source === "@mincho-js/css/rules/createRuntimeFn" &&
        name === "createCompiledRuntimeFn";
      const classes =
        factory.source === "@mincho-js/css/rules/createClassRuntimeFn" &&
        name === "createCompiledClassRuntimeFn";
      if (!full && !classes) return;
      const configNode = path.node.arguments[0];
      if (!t.isObjectExpression(configNode)) return;

      let config: Record<string, Literal>;
      try {
        config = literal(configNode) as Record<string, Literal>;
      } catch {
        return;
      }
      const variants = config.variantClassNames;
      const compounds = config.compoundVariants;
      if (
        !variants ||
        typeof variants !== "object" ||
        Array.isArray(variants) ||
        !Array.isArray(compounds) ||
        typeof config.defaultClassName !== "string"
      )
        return;
      if (
        compounds.some(
          (item) =>
            !Array.isArray(item) || !item[0] || typeof item[0] !== "object"
        )
      )
        return;
      const work =
        Object.keys(variants).length +
        compounds.length +
        compounds.reduce<number>(
          (count, item) =>
            count + Object.keys((item as Literal[])[0] as object).length,
          0
        );
      const compact = options.compactRuntime && work < 32;
      let packed: t.Expression | undefined;
      if (options.compactMetadata) {
        const candidate = pack(config);
        const metric = bundleSizeMetric(options.bundleSize);
        const overhead = helperOverhead(
          factory.source,
          `@mincho-js/css/rules/create${compact ? "PackedCompact" : "Packed"}RuntimeFn`,
          metric
        );
        if (
          overhead !== undefined &&
          measureBundleMetric(print(candidate), metric) + overhead <
            measureBundleMetric(print(configNode), metric)
        )
          packed = candidate;
      }
      if (!compact && !packed) return;
      const stem = packed ? (compact ? "PackedCompact" : "Packed") : "Compact";
      const imported = `create${stem}${classes ? "Class" : ""}RuntimeFn`;
      const source = `@mincho-js/css/rules/create${stem}RuntimeFn`;
      const key = source + ":" + imported;
      let local = imports.get(key);
      if (!local) {
        local = addNamed(program, imported, source);
        imports.set(key, local);
      }
      path.node.callee = t.cloneNode(local);
      if (packed) path.node.arguments[0] = packed;
      t.addComment(path.node, "leading", "#__PURE__");
      changed = true;
    }
  });
  program.scope.crawl();
  // These are pure compiler runtime subpaths. Preserve explicit bare imports.
  for (const path of program.get("body")) {
    if (path.isVariableDeclaration()) {
      for (const declaration of path.get("declarations")) {
        const init = declaration.node.init;
        if (
          !t.isObjectPattern(declaration.node.id) ||
          !t.isCallExpression(init) ||
          !t.isIdentifier(init.callee, { name: "require" }) ||
          declaration.scope.getBinding("require") ||
          !t.isStringLiteral(init.arguments[0]) ||
          !/^@mincho-js\/css\/rules\/create(?:Class)?RuntimeFn$/.test(
            init.arguments[0].value
          )
        )
          continue;
        const id = declaration.get("id");
        if (!id.isObjectPattern()) continue;
        for (const property of id.get("properties")) {
          if (
            !property.isObjectProperty() ||
            property.node.computed ||
            !t.isIdentifier(property.node.value)
          )
            continue;
          const binding = program.scope.getBinding(property.node.value.name);
          if (binding?.constant && !binding.referenced) property.remove();
        }
        if (!id.node.properties.length) declaration.remove();
      }
      if (path.node && !path.node.declarations.length) path.remove();
      continue;
    }
    if (
      !path.isImportDeclaration() ||
      !path.node.specifiers.length ||
      !/^@mincho-js\/css\/rules\/create(?:Class)?RuntimeFn$/.test(
        path.node.source.value
      )
    )
      continue;
    for (const specifier of path.get("specifiers")) {
      const binding = program.scope.getBinding(specifier.node.local.name);
      if (binding?.constant && !binding.referenced) specifier.remove();
    }
    if (!path.node.specifiers.length) path.remove();
  }
  return changed;
}

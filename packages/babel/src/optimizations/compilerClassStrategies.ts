import { types as t, type NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";
import {
  getModuleReference,
  referencesModuleExport
} from "../commonjs/bindings.js";
import { isExtractionCall } from "../extractionCalls/index.js";
import type { PluginState, ProgramScope } from "../types.js";
import { registerImportMethod } from "../utils.js";
import { hasDynamicScope } from "./dynamicScope.js";
import { isIntrinsicElement } from "./intrinsicElements.js";

const privateOwners = new WeakMap<
  PluginState,
  NodePath<t.VariableDeclarator>[]
>();

/**
 * Only explicit build-time calls whose complete owner and result use graph is
 * private are eligible. In particular, a generated compound class is never
 * allowed to reach cx, a selector, a component, or a public export.
 */
export function prepareCompilerClassStrategies(
  program: NodePath<t.Program>,
  state: PluginState
): void {
  const { globalAtomicClasses, compileClass } = state.opts.experimental ?? {};
  if ((!globalAtomicClasses && !compileClass) || hasDynamicScope(program))
    return;

  const calls: Array<{
    call: NodePath<t.CallExpression>;
    extract: NodePath<t.CallExpression>;
  }> = [];

  const definitions = new Set<t.Node>();
  const owners: NodePath<t.VariableDeclarator>[] = [];
  program.traverse({
    VariableDeclarator(path) {
      if (
        !path.parentPath.isVariableDeclaration({ kind: "const" }) ||
        !path.parentPath.parentPath.isProgram()
      )
        return;

      const init = path.get("init");
      if (
        !init.isCallExpression() ||
        !referencesModuleExport(
          init.get("callee"),
          "@mincho-js/css",
          "defineRules"
        ) ||
        init.node.arguments.length !== 1 ||
        !isConfig(init.node.arguments[0])
      )
        return;

      const id = path.node.id;
      let binding: Binding | undefined;
      let namespace = false;

      if (t.isIdentifier(id)) {
        binding = path.scope.getBinding(id.name);
        namespace = true;
      } else if (
        t.isObjectPattern(id) &&
        id.properties.length === 1 &&
        t.isObjectProperty(id.properties[0]) &&
        !id.properties[0].computed &&
        propertyName(id.properties[0].key) === "css" &&
        t.isIdentifier(id.properties[0].value)
      ) {
        binding = path.scope.getBinding(id.properties[0].value.name);
      }

      if (!binding?.constant || !binding.referencePaths.length) return;

      const ownerCalls: typeof calls = [];

      for (const reference of binding.referencePaths) {
        let callee: NodePath<t.Node> = reference;

        if (namespace) {
          const member = reference.parentPath;
          if (
            !member?.isMemberExpression() ||
            member.node.object !== reference.node ||
            member.node.computed ||
            !t.isIdentifier(member.node.property, { name: "css" })
          )
            return;

          callee = member;
        }

        const call = callee.parentPath;
        if (
          !call?.isCallExpression() ||
          call.node.callee !== callee.node ||
          call.node.arguments.length !== 1 ||
          !isIndependentInput(
            call.node.arguments[0],
            conditionNames(init.node.arguments[0]!)
          )
        )
          return;

        const composition = call.parentPath;
        const extract = composition?.parentPath;
        if (
          !composition?.isArrayExpression() ||
          composition.node.elements.length !== 1 ||
          composition.node.elements[0] !== call.node ||
          !extract?.isCallExpression() ||
          extract.node.arguments.length !== 1 ||
          extract.node.arguments[0] !== composition.node ||
          [
            ...(extract.node.leadingComments ?? []),
            ...(extract.parent.leadingComments ?? [])
          ].some((comment) => comment.value.trim() === "mincho-js-ignore") ||
          !referencesModuleExport(
            extract.get("callee"),
            "@mincho-js/css",
            "css"
          ) ||
          !isPrivateClassResult(extract)
        )
          return;

        ownerCalls.push({ call, extract });
      }

      calls.push(...ownerCalls);
      definitions.add(init.node);
      owners.push(path);
    }
  });

  if (!calls.length) return;

  const wrappers = new Set(calls.map(({ extract }) => extract.node));

  // A configured extraction API is a barrier when it is called in this file.
  // Merely configuring one elsewhere must not disable independent private styles.
  let closedStyles = true;
  program.traverse({
    JSXAttribute(path) {
      // JSX preprocessing runs next and can otherwise introduce an intervening
      // extracted selector that was not yet present as a css() call.
      if (t.isJSXIdentifier(path.node.name, { name: "css" }))
        closedStyles = false;
    },

    CallExpression(path) {
      if (definitions.has(path.node) || wrappers.has(path.node)) return;

      const callee = path.get("callee");
      const reference = getModuleReference(callee);

      if (
        isExtractionCall(callee, false) ||
        reference?.source.startsWith("@mincho-js/") ||
        reference?.source.startsWith("@vanilla-extract/")
      )
        closedStyles = false;
    }
  });

  // Re-emitting a previously cached atom inside a new compound can also move
  // it past an intervening global selector. Both strategies need this boundary.
  if (!closedStyles) {
    if (calls.length)
      state.file.metadata.minchoClassStrategies = {
        transformedCalls: 0,
        atomicDomain: "scoped",
        fallback: "intervening-or-unknown-styles"
      };

    return;
  }

  for (const { call, extract } of calls) {
    const helper = registerImportMethod(
      call,
      "compilePrivateDefineRulesClass",
      "@mincho-js/css/defineRules/registry"
    );

    // This single-input composition has no public selector/composition uses.
    // Its otherwise empty alias class can disappear with the opt-in strategy.
    extract.replaceWith(
      t.callExpression(helper, [
        t.cloneNode(call.node.callee as t.Expression, true),
        t.cloneNode(call.node.arguments[0] as t.Expression, true),
        t.objectExpression([
          t.objectProperty(t.identifier("version"), t.numericLiteral(1)),
          ...(state.opts.optimize?.sizeAware
            ? [
                t.objectProperty(
                  t.identifier("sizeAware"),
                  t.booleanLiteral(true)
                ),
                t.objectProperty(
                  t.identifier("metric"),
                  t.stringLiteral(state.opts.bundleSize?.metric ?? "brotli")
                )
              ]
            : []),
          t.objectProperty(
            t.identifier("globalAtomicClasses"),
            t.booleanLiteral(globalAtomicClasses === true)
          ),
          t.objectProperty(
            t.identifier("compileClass"),
            t.booleanLiteral(compileClass === true)
          ),
          t.objectProperty(
            t.identifier("source"),
            t.stringLiteral(state.file.opts.filename ?? "")
          )
        ])
      ])
    );
  }

  // Babel's import insertion helper does not register the new binding eagerly.
  // Extraction must recognize the generated helper by its actual module.
  program.scope.crawl();
  privateOwners.set(state, owners);

  if (calls.length)
    state.file.metadata.minchoClassStrategies = {
      transformedCalls: calls.length,
      atomicDomain: "file"
    };
}

/** The sidecar clones have been collected; no authoring factory is needed in JS. */
export function finishCompilerClassStrategies(
  program: NodePath<t.Program>,
  state: PluginState
): void {
  const owners = privateOwners.get(state);
  if (!owners) return;

  privateOwners.delete(state);
  program.scope.crawl();

  for (const owner of owners) {
    if (owner.removed) continue;
    if (
      Object.keys(t.getBindingIdentifiers(owner.node.id)).every(
        (name) => !owner.scope.getBinding(name)?.referenced
      )
    )
      owner.remove();
  }

  program.scope.crawl();

  const effects = (program.scope as ProgramScope).minchoData.effectImports;

  for (const statement of program.get("body")) {
    if (
      !statement.isImportDeclaration() ||
      statement.node.source.value !== "@mincho-js/css"
    )
      continue;

    for (const specifier of statement.get("specifiers")) {
      if (
        (specifier.isImportSpecifier() &&
          ["defineRules", "css"].includes(
            propertyName(specifier.node.imported) ?? ""
          )) ||
        specifier.isImportNamespaceSpecifier()
      ) {
        const binding = program.scope.getBinding(specifier.node.local.name);

        if (binding?.constant && !binding.referenced) specifier.remove();
      }
    }

    if (
      !statement.node.specifiers.length &&
      !effects?.has(statement.node.source.value)
    )
      statement.remove();
  }
}

function propertyName(node: t.Node): string | undefined {
  return t.isIdentifier(node)
    ? node.name
    : t.isStringLiteral(node)
      ? node.value
      : undefined;
}

function isConfig(node: t.Node | null | undefined): boolean {
  return (
    t.isObjectExpression(node) &&
    node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        ["properties", "debugId", "conditions"].includes(
          propertyName(property.key) ?? ""
        ) &&
        (propertyName(property.key) === "debugId"
          ? t.isStringLiteral(property.value)
          : propertyName(property.key) === "conditions"
            ? t.isObjectExpression(property.value) &&
              property.value.properties.every(
                (entry) =>
                  t.isObjectProperty(entry) &&
                  !entry.computed &&
                  !!propertyName(entry.key) &&
                  isIndependentCondition(entry.value)
              )
            : t.isObjectExpression(property.value) &&
              property.value.properties.every(
                (entry) =>
                  t.isObjectProperty(entry) &&
                  !entry.computed &&
                  independentProperties.has(propertyName(entry.key) ?? "") &&
                  t.isBooleanLiteral(entry.value, { value: true })
              ))
    )
  );
}

// A deliberately small subset of the runtime's independent-longhand check.
// Requiring the whole owner to stay within it excludes intervening selector,
// shorthand, token resolver, and conditional writes from other owner calls.
const independentProperties = new Set([
  "color",
  "display",
  "opacity",
  "width",
  "height",
  "visibility",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "order",
  "cursor"
]);

function conditionNames(node: t.Node): Set<string> {
  if (!t.isObjectExpression(node)) return new Set();

  const conditions = node.properties.find(
    (entry) =>
      t.isObjectProperty(entry) && propertyName(entry.key) === "conditions"
  );

  return new Set(
    t.isObjectProperty(conditions) && t.isObjectExpression(conditions.value)
      ? conditions.value.properties.flatMap((entry) =>
          t.isObjectProperty(entry) ? [`_${propertyName(entry.key)}`] : []
        )
      : []
  );
}

function isIndependentCondition(node: t.Node): boolean {
  if (t.isStringLiteral(node))
    return (
      /^(?:@media\s+)?(?:\(|screen\b|print\b|all\b|not\b|only\b)/.test(
        node.value
      ) && !/[&{};]/.test(node.value)
    );

  return (
    t.isObjectExpression(node) &&
    node.properties.length > 0 &&
    node.properties.every((entry) => {
      if (
        !t.isObjectProperty(entry) ||
        entry.computed ||
        !t.isStringLiteral(entry.value)
      )
        return false;

      const key = propertyName(entry.key);
      if (key === "selector")
        return /^&(?::(?:hover|focus|focus-visible|active|disabled))?$/.test(
          entry.value.value
        );

      return (
        ["@media", "@supports", "@layer"].includes(key ?? "") &&
        !!entry.value.value &&
        !/[{};]/.test(entry.value.value)
      );
    })
  );
}

function isIndependentInput(
  node: t.Node | null | undefined,
  conditions = new Set<string>(),
  depth = 0
): boolean {
  return (
    depth < 16 &&
    t.isObjectExpression(node) &&
    node.properties.length > 0 &&
    node.properties.every(
      (property) =>
        t.isObjectProperty(property) &&
        !property.computed &&
        (conditions.has(propertyName(property.key) ?? "")
          ? isIndependentInput(property.value, conditions, depth + 1)
          : independentProperties.has(propertyName(property.key) ?? "") &&
            (t.isStringLiteral(property.value)
              ? !/url\s*\(/i.test(property.value.value) &&
                !property.value.value.includes("\\")
              : t.isNumericLiteral(property.value)
                ? Number.isFinite(property.value.value)
                : t.isUnaryExpression(property.value) &&
                  ["-", "+"].includes(property.value.operator) &&
                  t.isNumericLiteral(property.value.argument) &&
                  Number.isFinite(property.value.argument.value)))
    )
  );
}

function isPrivateClassResult(path: NodePath<t.Expression>): boolean {
  if (isSoleIntrinsicClass(path)) return true;

  const declaration = path.parentPath;
  if (
    !declaration?.isVariableDeclarator() ||
    declaration.node.init !== path.node ||
    !t.isIdentifier(declaration.node.id) ||
    !declaration.parentPath.isVariableDeclaration({ kind: "const" }) ||
    !declaration.parentPath.parentPath.isProgram()
  )
    return false;

  const binding = declaration.scope.getBinding(declaration.node.id.name);

  return (
    !!binding?.constant &&
    binding.referencePaths.length > 0 &&
    binding.referencePaths.every(isSoleIntrinsicClass)
  );
}

function isSoleIntrinsicClass(path: NodePath<t.Node>): boolean {
  const container = path.parentPath;
  const attribute = container?.parentPath;
  const opening = attribute?.parentPath;

  return !!(
    container?.isJSXExpressionContainer() &&
    attribute?.isJSXAttribute() &&
    t.isJSXIdentifier(attribute.node.name, { name: "className" }) &&
    opening?.isJSXOpeningElement() &&
    t.isJSXIdentifier(opening.node.name) &&
    isIntrinsicElement(opening.node.name.name) &&
    opening.node.attributes.every(
      (item) =>
        t.isJSXAttribute(item) &&
        (item === attribute.node ||
          !t.isJSXIdentifier(item.name) ||
          !["className", "css"].includes(item.name.name))
    )
  );
}

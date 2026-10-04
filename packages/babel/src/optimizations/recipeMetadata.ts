import { types as t, type NodePath } from "@babel/core";
import { getModuleReference, staticMemberName } from "../commonjs/bindings.js";
import { hasDynamicScope } from "./dynamicScope.js";

function hasObservablePrototypeMutation(program: NodePath<t.Program>): boolean {
  let observed = false;
  program.traverse({
    MemberExpression(path) {
      if (staticMemberName(path.node) !== "prototype") return;

      const object = path.get("object");
      const direct =
        object.isIdentifier() &&
        ["Function", "Object"].includes(object.node.name) &&
        !object.scope.getBinding(object.node.name);

      const global =
        object.isMemberExpression() &&
        ["Function", "Object"].includes(staticMemberName(object.node) ?? "") &&
        t.isIdentifier(object.node.object, { name: "globalThis" }) &&
        !object.scope.getBinding("globalThis");
      if (!direct && !global) return;

      let member: NodePath<t.Node> = path;

      while (
        member.parentPath?.isMemberExpression() &&
        member.parentPath.node.object === member.node
      )
        member = member.parentPath;

      const use = member.parentPath;

      if (
        (use?.isAssignmentExpression() && use.node.left === member.node) ||
        use?.isUpdateExpression() ||
        use?.isUnaryExpression({ operator: "delete" })
      ) {
        observed = true;

        return;
      }

      // Passing or aliasing the prototype exposes later writes that cannot be
      // inferred from the recipe's own references. Ordinary method reads do not.
      if (member === path) {
        if (
          use?.isCallExpression() ||
          use?.isNewExpression() ||
          use?.isVariableDeclarator() ||
          use?.isAssignmentExpression() ||
          use?.isReturnStatement() ||
          use?.isObjectProperty() ||
          use?.isArrayExpression() ||
          use?.isArrowFunctionExpression()
        )
          observed = true;
      } else if (use?.isCallExpression() && use.node.callee === member.node) {
        const first = path.parentPath;

        if (
          first.isMemberExpression() &&
          ["__defineGetter__", "__defineSetter__"].includes(
            staticMemberName(first.node) ?? ""
          )
        )
          observed = true;
      }
    }
  });

  return observed;
}

/** Feature pruning is confined to immutable local factories with a closed use graph. */
export function pruneRecipeMetadata(program: NodePath<t.Program>): boolean {
  if (hasDynamicScope(program) || hasObservablePrototypeMutation(program))
    return false;

  program.scope.crawl();

  let changed = false;
  program.traverse({
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;

      const init = path.get("init");
      if (!init.isCallExpression() || init.node.arguments.length !== 1) return;

      const factory = getModuleReference(init.get("callee"));
      if (
        factory?.unsafe ||
        factory?.source !== "@mincho-js/css/rules/createRuntimeFn" ||
        factory.members.join(".") !== "createCompiledRuntimeFn"
      )
        return;

      const config = init.node.arguments[0];
      if (!t.isObjectExpression(config)) return;

      const binding = path.scope.getBinding(path.node.id.name);
      if (
        !binding?.constant ||
        path.parentPath.parentPath?.isExportNamedDeclaration()
      )
        return;

      const features = { props: false, variants: false, classNames: false };

      for (const reference of binding.referencePaths) {
        const parent = reference.parentPath;
        if (parent?.isCallExpression() && parent.get("callee") === reference)
          continue;
        if (
          !parent?.isMemberExpression() ||
          parent.node.computed ||
          !t.isIdentifier(parent.node.property)
        )
          return;

        const name = parent.node.property.name;
        if (!Object.hasOwn(features, name)) return;
        if (
          parent.parentPath.isAssignmentExpression() ||
          parent.parentPath.isUpdateExpression() ||
          parent.parentPath.isUnaryExpression({ operator: "delete" })
        )
          return;

        features[name as keyof typeof features] = true;
      }

      const disabled = Object.entries(features).filter(([, used]) => !used);
      if (!disabled.length) return;

      if (!features.props) {
        // Preserve config expression effects unless the removed metadata is literal.
        config.properties = config.properties.filter((property) => {
          if (
            !t.isObjectProperty(property) ||
            property.computed ||
            !(
              t.isIdentifier(property.key, { name: "propVars" }) ||
              t.isStringLiteral(property.key, { value: "propVars" })
            )
          )
            return true;

          return (
            !t.isObjectExpression(property.value) ||
            !property.value.properties.every(
              (item) =>
                t.isObjectProperty(item) &&
                !item.computed &&
                t.isStringLiteral(item.value)
            )
          );
        });
      }

      init.node.arguments.push(
        t.objectExpression(
          disabled.map(([name]) =>
            t.objectProperty(t.identifier(name), t.booleanLiteral(false))
          )
        )
      );
      changed = true;
    }
  });

  return changed;
}

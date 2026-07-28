import { types as t } from "@babel/core";
import type { NodePath } from "@babel/core";
import type { Binding } from "@babel/traverse";

const arrayMutationMethods = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift"
]);

const objectMutationMethods = new Set([
  "assign",
  "defineProperties",
  "defineProperty",
  "setPrototypeOf"
]);

export function hasStaticCssEvalBindingMutation(
  programPath: NodePath<t.Program>,
  binding: Binding
): boolean {
  if (binding.constantViolations.length > 0) {
    return true;
  }

  let mutated = false;

  programPath.traverse({
    AssignmentExpression(path) {
      if (pathTouchesBinding(path.get("left"), binding)) {
        mutated = true;
        path.stop();
      }
    },
    CallExpression(path) {
      if (isMutatingCallExpression(path, binding)) {
        mutated = true;
        path.stop();
      }
    },
    UnaryExpression(path) {
      if (
        path.node.operator === "delete" &&
        pathTouchesBinding(path.get("argument"), binding)
      ) {
        mutated = true;
        path.stop();
      }
    },
    UpdateExpression(path) {
      if (pathTouchesBinding(path.get("argument"), binding)) {
        mutated = true;
        path.stop();
      }
    }
  });

  return mutated;
}

function isMutatingCallExpression(
  path: NodePath<t.CallExpression>,
  binding: Binding
): boolean {
  const calleePath = path.get("callee");

  if (calleePath.isMemberExpression()) {
    const methodName = getStaticMemberPropertyName(calleePath.node);

    if (
      methodName &&
      arrayMutationMethods.has(methodName) &&
      pathTouchesBinding(calleePath.get("object"), binding)
    ) {
      return true;
    }

    if (isObjectMutationCall(calleePath, methodName)) {
      const firstArgument = path.get("arguments.0");
      return Boolean(
        firstArgument?.node && pathTouchesBinding(firstArgument, binding)
      );
    }
  }

  return false;
}

function isObjectMutationCall(
  calleePath: NodePath<t.MemberExpression>,
  methodName: string | null
): boolean {
  if (!methodName || !objectMutationMethods.has(methodName)) {
    return false;
  }

  const objectPath = calleePath.get("object");
  return objectPath.isIdentifier({ name: "Object" });
}

function pathTouchesBinding(
  path: NodePath<t.Node | null>,
  binding: Binding
): boolean {
  if (!path.node) {
    return false;
  }

  if (path.isIdentifier()) {
    return path.scope.getBinding(path.node.name) === binding;
  }

  if (path.isMemberExpression()) {
    return pathTouchesBinding(path.get("object") as NodePath<t.Node>, binding);
  }

  if (path.isArrayPattern()) {
    return path.get("elements").some((elementPath) => {
      return Boolean(
        elementPath.node &&
        pathTouchesBinding(elementPath as NodePath<t.Node>, binding)
      );
    });
  }

  if (path.isObjectPattern()) {
    return path.get("properties").some((propertyPath) => {
      if (propertyPath.isObjectProperty()) {
        return pathTouchesBinding(propertyPath.get("value"), binding);
      }

      if (propertyPath.isRestElement()) {
        return pathTouchesBinding(propertyPath.get("argument"), binding);
      }

      return false;
    });
  }

  if (path.isRestElement()) {
    return pathTouchesBinding(
      path.get("argument") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSNonNullExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSAsExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isTSSatisfiesExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  if (path.isParenthesizedExpression()) {
    return pathTouchesBinding(
      path.get("expression") as NodePath<t.Node>,
      binding
    );
  }

  return false;
}

function getStaticMemberPropertyName(
  expression: t.MemberExpression
): string | null {
  if (!expression.computed && t.isIdentifier(expression.property)) {
    return expression.property.name;
  }

  if (expression.computed && t.isStringLiteral(expression.property)) {
    return expression.property.value;
  }

  if (expression.computed && t.isNumericLiteral(expression.property)) {
    return String(expression.property.value);
  }

  return null;
}

import { type NodePath, types as t } from "@babel/core";
import type { Binding } from "@babel/traverse";
import type { PluginState } from "./types.js";
import {
  DEFINE_RULES_CX_RUNTIME_IMPORT_NAME,
  DEFINE_RULES_CX_RUNTIME_IMPORT_PATH,
  DEFINE_RULES_IMPORT_NAME,
  DEFINE_RULES_IMPORT_PATH,
  type DefineRulesRuntimeRef
} from "./defineRulesCxConditionsTypes.js";
import {
  isDefineRulesCxRuntimeRecipe,
  resolveProviderStaticValue
} from "./defineRulesCxConditionsProvider.js";

export function resolveDefineRulesCxRuntime(
  path: NodePath<t.CallExpression>,
  state: PluginState
): DefineRulesRuntimeRef | null {
  const calleePath = path.get("callee");

  if (calleePath.isMemberExpression()) {
    const localMemberRuntime = resolveLocalMemberCxRuntime(calleePath);

    if (localMemberRuntime !== null) {
      return localMemberRuntime;
    }
  }

  if (calleePath.isIdentifier()) {
    const binding = path.scope.getBinding(calleePath.node.name);

    if (binding !== undefined) {
      const localRuntime = resolveLocalIdentifierCxRuntime(binding);

      if (localRuntime !== null) {
        return localRuntime;
      }
    }
  }

  if (!calleePath.isExpression()) {
    return null;
  }

  const providerValue = resolveProviderStaticValue(calleePath, state);
  return isDefineRulesCxRuntimeRecipe(providerValue)
    ? { callee: "provider-createDefineRulesCxRuntime" }
    : null;
}

export function isScopedCssCall(
  path: NodePath<t.Expression>,
  runtime: DefineRulesRuntimeRef
): boolean {
  if (runtime.callee !== "local-defineRules" || !path.isCallExpression()) {
    return false;
  }

  const calleePath = path.get("callee");

  if (calleePath.isIdentifier()) {
    const binding = path.scope.getBinding(calleePath.node.name);
    return binding !== undefined && binding === runtime.cssBinding;
  }

  if (
    !calleePath.isMemberExpression() ||
    calleePath.node.computed ||
    !t.isIdentifier(calleePath.node.object) ||
    !t.isIdentifier(calleePath.node.property) ||
    calleePath.node.property.name !== "css"
  ) {
    return false;
  }

  const objectBinding = path.scope.getBinding(calleePath.node.object.name);
  return (
    objectBinding !== undefined && objectBinding === runtime.namespaceBinding
  );
}

function resolveLocalMemberCxRuntime(
  path: NodePath<t.MemberExpression>
): DefineRulesRuntimeRef | null {
  if (path.node.computed || !t.isIdentifier(path.node.property)) {
    return null;
  }

  if (path.node.property.name !== "cx" || !t.isIdentifier(path.node.object)) {
    return null;
  }

  const binding = path.scope.getBinding(path.node.object.name);
  const initPath = binding ? getConstantBindingInitPath(binding) : null;
  return initPath !== null && isDefineRulesCall(initPath)
    ? { callee: "local-defineRules", namespaceBinding: binding }
    : null;
}

function resolveLocalIdentifierCxRuntime(
  binding: Binding
): DefineRulesRuntimeRef | null {
  if (!isConstBinding(binding)) {
    return null;
  }

  const defineRulesRuntime = resolveDestructuredDefineRulesRuntime(binding);

  if (defineRulesRuntime !== null) {
    return defineRulesRuntime;
  }

  const initPath = getConstantBindingInitPath(binding);
  return initPath !== null && isCreateDefineRulesCxRuntimeCall(initPath)
    ? { callee: "local-createDefineRulesCxRuntime" }
    : null;
}

function resolveDestructuredDefineRulesRuntime(
  binding: Binding
): DefineRulesRuntimeRef | null {
  const declaratorPath = findVariableDeclaratorPath(binding);

  if (declaratorPath === null || !isConstVariableDeclarator(declaratorPath)) {
    return null;
  }

  const initPath = declaratorPath.get("init");

  if (!initPath.isExpression() || !isDefineRulesCall(initPath)) {
    return null;
  }

  const cxBinding = getObjectPatternPropertyBinding(declaratorPath, "cx");

  if (cxBinding !== binding) {
    return null;
  }

  const cssBinding = getObjectPatternPropertyBinding(declaratorPath, "css");
  return {
    callee: "local-defineRules",
    ...(cssBinding !== null ? { cssBinding } : {})
  };
}

export function getConstantBindingInitPath(
  binding: Binding
): NodePath<t.Expression> | null {
  if (binding.kind !== "const" || !isConstBinding(binding)) {
    return null;
  }

  const declaratorPath = findVariableDeclaratorPath(binding);

  if (declaratorPath === null || !isConstVariableDeclarator(declaratorPath)) {
    return null;
  }

  const initPath = declaratorPath.get("init");
  return initPath.isExpression() ? initPath : null;
}

function isDefineRulesCall(path: NodePath<t.Expression>): boolean {
  return (
    path.isCallExpression() &&
    path
      .get("callee")
      .referencesImport(DEFINE_RULES_IMPORT_PATH, DEFINE_RULES_IMPORT_NAME)
  );
}

function isCreateDefineRulesCxRuntimeCall(
  path: NodePath<t.Expression>
): boolean {
  return (
    path.isCallExpression() &&
    path
      .get("callee")
      .referencesImport(
        DEFINE_RULES_CX_RUNTIME_IMPORT_PATH,
        DEFINE_RULES_CX_RUNTIME_IMPORT_NAME
      )
  );
}

function findVariableDeclaratorPath(
  binding: Binding
): NodePath<t.VariableDeclarator> | null {
  if (binding.kind !== "const") {
    return null;
  }

  let current: NodePath<t.Node> | null = binding.path;

  while (current !== null && !current.isProgram()) {
    if (current.isVariableDeclarator()) {
      return current;
    }
    current = current.parentPath;
  }

  return null;
}

function isConstBinding(binding: Binding): boolean {
  const declaratorPath = findVariableDeclaratorPath(binding);
  return (
    binding.constant &&
    declaratorPath !== null &&
    isConstVariableDeclarator(declaratorPath)
  );
}

function isConstVariableDeclarator(
  path: NodePath<t.VariableDeclarator>
): boolean {
  return (
    path.parentPath?.isVariableDeclaration() === true &&
    path.parentPath.node.kind === "const"
  );
}

function getObjectPatternPropertyBinding(
  declaratorPath: NodePath<t.VariableDeclarator>,
  propertyName: string
): Binding | null {
  const { id } = declaratorPath.node;

  if (!t.isObjectPattern(id)) {
    return null;
  }

  for (const property of id.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      continue;
    }

    if (
      getObjectPropertyName(property.key) === propertyName &&
      t.isIdentifier(property.value)
    ) {
      return declaratorPath.scope.getBinding(property.value.name) ?? null;
    }
  }

  return null;
}

function getObjectPropertyName(
  property: t.ObjectProperty["key"]
): string | null {
  if (t.isIdentifier(property)) {
    return property.name;
  }

  if (t.isStringLiteral(property)) {
    return property.value;
  }

  return null;
}

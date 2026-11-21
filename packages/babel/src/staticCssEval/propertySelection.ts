import { types as t } from "@babel/core";
import { unwrapTransparentCssRuleExpression } from "./candidates.js";

type ObjectMember = t.ObjectProperty | t.ObjectMethod;

export function staticObjectMemberName(property: ObjectMember): string | null {
  return staticPropertyName(property.key, property.computed);
}

export function staticPropertyName(
  key: t.Expression | t.PrivateName,
  computed: boolean
): string | null {
  if (!computed && t.isIdentifier(key)) return key.name;
  return t.isStringLiteral(key) || t.isNumericLiteral(key)
    ? String(key.value)
    : null;
}

export function isObjectPrototypeSetter(property: t.Node): boolean {
  return (
    t.isObjectProperty(property) &&
    !property.computed &&
    !property.shorthand &&
    staticObjectMemberName(property) === "__proto__"
  );
}

/** Array indices preserve their canonical property spelling (and exclude 2^32 - 1). */
export function isCanonicalArrayIndex(name: string): boolean {
  const index = Number(name);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 0xffffffff &&
    String(index) === name
  );
}

export type ObjectLiteralMemberSelection =
  | {
      readonly kind: "property";
      readonly property: ObjectMember;
      readonly path: string;
    }
  | {
      readonly kind: "prototype";
      readonly value: t.Expression;
      readonly path: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

/** Select a literal's own property before consulting its explicit prototype.
 * Paths are relative to the object and can be passed to Babel's NodePath.get.
 * Missing means no explicit property/prototype; intrinsic prototypes remain unknown.
 */
export function selectObjectLiteralMember(
  object: t.ObjectExpression,
  name: string,
  ownOnly = false
): ObjectLiteralMemberSelection {
  let prototype: ObjectLiteralMemberSelection | undefined;
  let setter:
    Extract<ObjectLiteralMemberSelection, { kind: "property" }> | undefined;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    const path = `properties.${index}`;
    if (t.isObjectProperty(property) && isObjectPrototypeSetter(property)) {
      if (t.isExpression(property.value))
        prototype = {
          kind: "prototype",
          value: property.value,
          path: `${path}.value`
        };
      continue;
    }
    if (t.isSpreadElement(property)) {
      const source = unwrapTransparentCssRuleExpression(property.argument);
      // CopyDataProperties does not copy inherited properties.
      if (!t.isObjectExpression(source)) return { kind: "unknown" };
      // CopyDataProperties invokes every enumerable own getter in key order.
      // A different getter can change the selected slot before it is copied.
      if (hasSpreadGetter(source)) return { kind: "unknown" };
      const selected = selectObjectLiteralMember(source, name, true);
      if (selected.kind === "missing") continue;
      if (selected.kind !== "property" || source !== property.argument)
        return { kind: "unknown" };
      // Spreads create data descriptors, even when their source has a getter.
      // A later setter replaces that data property rather than pairing with it.
      return (
        setter ?? { ...selected, path: `${path}.argument.${selected.path}` }
      );
    }
    const key = staticObjectMemberName(property);
    if (key === null) return { kind: "unknown" };
    if (key === name) {
      if (t.isObjectMethod(property, { kind: "set" })) {
        setter ??= { kind: "property", property, path };
        continue;
      }
      if (setter && !t.isObjectMethod(property, { kind: "get" })) return setter;
      return { kind: "property", property, path };
    }
  }
  return setter ?? ((!ownOnly && prototype) || { kind: "missing" });
}

function hasSpreadGetter(object: t.ObjectExpression): boolean {
  return object.properties.some((property) => {
    if (t.isObjectMethod(property, { kind: "get" })) return true;
    if (!t.isSpreadElement(property)) return false;
    const source = unwrapTransparentCssRuleExpression(property.argument);
    return !t.isObjectExpression(source) || hasSpreadGetter(source);
  });
}

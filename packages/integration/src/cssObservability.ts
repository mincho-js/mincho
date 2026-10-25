import { parseSync, traverse, types as t } from "@babel/core";

export interface CssObservability {
  whole: boolean;
  variables: string[];
  names: string[];
  reasons: string[];
}

/** No package allowlists: unknown aliases, CSSOM enumeration and escapes pin the graph. */
export function analyzeCssObservability(source: string): CssObservability {
  const variables = new Set<string>();
  const names = new Set<string>();
  const reasons = new Set<string>();
  const whole = (reason: string) => reasons.add(reason);
  const normalizePropertyName = (value: string) =>
    value.startsWith("--")
      ? value
      : value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
  const key = (node: t.Node): string | undefined => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      return !node.computed && t.isIdentifier(node.property)
        ? node.property.name
        : t.isStringLiteral(node.property)
          ? normalizePropertyName(node.property.value)
          : undefined;
    return t.isIdentifier(node) ? node.name : undefined;
  };
  try {
    const ast = parseSync(source, {
      configFile: false,
      babelrc: false,
      sourceType: "unambiguous",
      parserOpts: { plugins: ["jsx", "typescript"] }
    });
    if (!ast) throw new Error("No AST");
    traverse(ast, {
      ObjectProperty(path) {
        const name = t.isIdentifier(path.node.key)
          ? path.node.key.name
          : t.isStringLiteral(path.node.key)
            ? path.node.key.value
            : undefined;
        if (/^onanimation(?:start|end|iteration|cancel)$/i.test(name ?? ""))
          whole("animation-event-observation");
        if (!path.parentPath.isObjectPattern()) return;
        if (
          [
            "getComputedStyle",
            "getAnimations",
            "addEventListener",
            "getPropertyValue",
            "setProperty",
            "removeProperty",
            "style",
            "animationName",
            "animation",
            "fontFamily",
            "font",
            "cssRules",
            "styleSheets"
          ].includes(normalizePropertyName(name ?? ""))
        )
          whole("destructured-cssom-alias");
      },
      "MemberExpression|OptionalMemberExpression"(path) {
        if (!path.isMemberExpression() && !path.isOptionalMemberExpression())
          return;
        const name = key(path.node);
        const parent = path.parentPath;
        const isCallee =
          (parent?.isCallExpression() || parent?.isOptionalCallExpression()) &&
          path.key === "callee";
        if (name === "addEventListener" && !isCallee)
          whole("escaped-event-listener");
        if (/^onanimation(?:start|end|iteration|cancel)$/i.test(name ?? ""))
          whole("animation-event-observation");
        if (
          name === "style" &&
          !(
            (parent?.isMemberExpression() ||
              parent?.isOptionalMemberExpression()) &&
            path.key === "object"
          )
        )
          whole("escaped-style-object");
        if (
          ["animationName", "animation", "fontFamily", "font"].includes(
            name ?? ""
          ) &&
          parent?.isAssignmentExpression() &&
          path.key === "left"
        ) {
          const value = parent.node.right;
          if (!t.isStringLiteral(value) || parent.node.operator !== "=")
            whole("dynamic-resource-assignment");
          else {
            for (const item of value.value.matchAll(/[A-Za-z_][\w-]*/g))
              names.add(item[0]);
            for (const item of value.value.matchAll(/--[\w-]+/g))
              variables.add(item[0]);
          }
        }
        if (
          [
            "styleSheets",
            "cssRules",
            "rules",
            "cssText",
            "computedStyleMap",
            "getAnimations",
            "registerProperty",
            "adoptedStyleSheets",
            "fonts"
          ].includes(name ?? "")
        )
          whole("cssom-enumeration");
        if (!name && !t.isStringLiteral(path.node.property)) {
          // A computed CSSOM method alias cannot be distinguished from a read.
          if (
            t.isIdentifier(path.node.object) &&
            /^(?:CSS|document|window)$/.test(path.node.object.name)
          )
            whole("dynamic-cssom-member");
          if (
            (t.isMemberExpression(path.node.object) ||
              t.isOptionalMemberExpression(path.node.object)) &&
            key(path.node.object) === "style"
          )
            whole("dynamic-style-member");
        }
        if (
          [
            "getComputedStyle",
            "getPropertyValue",
            "setProperty",
            "removeProperty"
          ].includes(name ?? "") &&
          !isCallee
        )
          whole("escaped-style-method");
        if (
          ["animationName", "animation", "fontFamily", "font"].includes(
            name ?? ""
          ) &&
          !parent?.isAssignmentExpression()
        )
          whole("observed-resource-name");
      },
      ReferencedIdentifier(path) {
        if (
          [
            "getComputedStyle",
            "getAnimations",
            "addEventListener",
            "getPropertyValue",
            "setProperty",
            "removeProperty",
            "computedStyleMap",
            "registerProperty",
            "CSSStyleSheet"
          ].includes(path.node.name) &&
          !(
            (path.parentPath.isCallExpression() ||
              path.parentPath.isOptionalCallExpression()) &&
            path.key === "callee"
          )
        )
          whole("escaped-cssom-function");
      },
      "CallExpression|OptionalCallExpression"(path) {
        if (!path.isCallExpression() && !path.isOptionalCallExpression())
          return;
        const name = key(path.node.callee);
        if (name === "getAnimations") whole("animation-object-observation");
        if (name === "addEventListener") {
          const event = path.node.arguments[0];
          if (
            !t.isStringLiteral(event) ||
            /^animation(?:start|end|iteration|cancel)$/.test(event.value)
          )
            whole("animation-event-observation");
        }
        if (name === "setAttribute" || name === "setAttributeNS") {
          const attribute =
            path.node.arguments[name === "setAttributeNS" ? 1 : 0];
          if (
            !t.isStringLiteral(attribute) ||
            attribute.value.toLowerCase() === "style"
          )
            whole("unknown-style-attribute-mutation");
        }
        if (
          [
            "computedStyleMap",
            "registerProperty",
            "insertRule",
            "deleteRule",
            "replaceSync"
          ].includes(name ?? "")
        )
          whole("cssom-mutation");
        if (name === "getComputedStyle") {
          const parent = path.parentPath;
          if (
            !parent ||
            !(
              parent.isMemberExpression() || parent.isOptionalMemberExpression()
            )
          )
            whole("escaped-computed-style");
          else {
            const property = key(parent.node);
            if (
              !property ||
              [
                "cssText",
                "length",
                "item",
                "animationName",
                "animation",
                "fontFamily",
                "font"
              ].includes(property)
            )
              whole("observed-computed-style");
          }
        }
        if (
          !["getPropertyValue", "setProperty", "removeProperty"].includes(
            name ?? ""
          )
        )
          return;
        const property = path.node.arguments[0];
        if (!t.isStringLiteral(property)) {
          whole("dynamic-property-name");
          return;
        }
        if (property.value.startsWith("--")) variables.add(property.value);
        if (
          /^(?:animation(?:-name)?|font(?:-family)?)$/.test(property.value) &&
          name === "getPropertyValue"
        )
          whole("observed-resource-name");
        for (const arg of path.node.arguments.slice(1)) {
          if (!t.isStringLiteral(arg)) {
            whole("dynamic-property-value");
            continue;
          }
          for (const item of arg.value.matchAll(/[A-Za-z_][\w-]*/g))
            names.add(item[0]);
          for (const item of arg.value.matchAll(/--[\w-]+/g))
            variables.add(item[0]);
        }
      }
    });
  } catch {
    whole("unparseable-runtime");
  }
  return {
    whole: reasons.size > 0,
    variables: [...variables].sort(),
    names: [...names].sort(),
    reasons: [...reasons].sort()
  };
}

import {
  type NodePath,
  type PluginObj,
  types as t,
  transformSync
} from "@babel/core";
import { expect } from "vitest";
import { minchoBabelPlugin } from "../index.js";
import { preprocessJsxCssProp } from "../jsxCssProp.js";
import { getDynamicCssVariableRule } from "../jsxCssProp/preprocess.js";
import type { DynamicCssVariableRule } from "../jsxCssProp/types.js";
import { styledComponentPlugin } from "../styled.js";
import { typescriptPresetPath } from "../testUtils/babel.js";
import preprocess from "../transforms/preprocess.js";
import type {
  MinchoBabelFileMetadata,
  PluginOptions,
  PluginState
} from "../types.js";

export function babelTransform(
  code: string,
  pluginOptions: Partial<
    Pick<
      PluginOptions,
      "jsxCssProp" | "staticCssEvalProvider" | "optimize" | "extractCalls"
    >
  > = {},
  transformOptions: {
    filename?: string;
    root?: string;
    sourceType?: "module" | "script" | "unambiguous";
  } = {}
) {
  const options: PluginOptions = { result: ["", ""], ...pluginOptions };
  const result = transformSync(code, {
    ...(transformOptions.sourceType
      ? { sourceType: transformOptions.sourceType }
      : {}),
    plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]],
    presets: [typescriptPresetPath],
    filename: transformOptions.filename ?? "test.tsx",
    ...(transformOptions.root ? { root: transformOptions.root } : {})
  });

  if (result === null || result.code == null) {
    throw new Error("Failed to transform code");
  }

  return {
    result: options.result,
    code: result.code,
    metadata: (result.metadata ?? {}) as MinchoBabelFileMetadata
  };
}

export type RuntimeJsx = (
  tag: unknown,
  props?: Record<string, unknown>
) => Record<string, unknown>;

export type RuntimeCx = (...values: unknown[]) => string;

export type RuntimeCss = (styles: unknown) => string;

export type DefineRulesCxRuntimeButton = (...args: unknown[]) => string;

export type RuntimeVx = (
  value: string | number | boolean | null | undefined,
  suffix?: string | null
) => string | number;

export type StaticCssEvalProvider = NonNullable<
  PluginOptions["staticCssEvalProvider"]
>;

export type StaticCssEvalProviderResult = ReturnType<
  StaticCssEvalProvider["getResolvedCssValue"]
>;

export type StaticCssEvalValue = Extract<
  StaticCssEvalProviderResult,
  { kind: "resolved" }
>["value"];

export function createResolvedStaticCssEvalProvider(
  values: Record<string, StaticCssEvalValue>
): StaticCssEvalProvider {
  return {
    getResolvedCssValue(query): StaticCssEvalProviderResult {
      const key = query.memberPath?.length
        ? `${query.bindingName}.${query.memberPath.join(".")}`
        : (query.bindingName ?? "");

      const value = values[key];

      if (value === undefined) {
        return { kind: "not-candidate" };
      }

      return {
        kind: "resolved",
        value,
        dependencies: ["/provider/styles.ts"]
      };
    }
  };
}

export function createDefineRulesCxRuntimeRecipeValue(): StaticCssEvalValue {
  return {
    importPath: "@mincho-js/css/defineRules/createDefineRulesCxRuntime",
    importName: "createDefineRulesCxRuntime",
    args: [
      {
        classWrites: {
          base: 0,
          active: 0
        },
        segments: {
          __mincho_seg_base: [0],
          __mincho_seg_active: [0]
        }
      }
    ]
  };
}

export function createDefineRulesCxPermutationSource(
  conditionCount: number
): string {
  const classImports = Array.from(
    { length: conditionCount },
    (_, index) => `class${index}`
  );

  const parameters = Array.from(
    { length: conditionCount },
    (_, index) => `flag${index}: boolean`
  );

  const operands = Array.from({ length: conditionCount }, (_, index) =>
    index % 2 === 0
      ? `flag${index} && class${index}`
      : `flag${index} ? class${index} : base`
  );

  return `
      import { cx, base, ${classImports.join(", ")} } from "./styles";

      export function button(${parameters.join(", ")}) {
        return cx(base, ${operands.join(", ")});
      }
    `;
}

export function createLocalDefineRulesCxFallbackSource(
  conditionCount: number
): string {
  const colorValues = ["red", "blue", "green", "purple", "orange", "pink"];
  const classDeclarations = Array.from(
    { length: conditionCount },
    (_, index) =>
      `const color${index} = css({ color: "${colorValues[index] ?? `color-${index}`}" });`
  ).join("\n");

  const parameters = Array.from(
    { length: conditionCount },
    (_, index) => `flag${index}: boolean`
  );

  const operands = Array.from({ length: conditionCount }, (_, index) => {
    if (index % 3 === 1) {
      return `flag${index} ? color${index} : base`;
    }
    if (index % 3 === 2) {
      return `[flag${index} && color${index}]`;
    }

    return `flag${index} && color${index}`;
  });

  return `
      import { defineRules } from "@mincho-js/css";

      const { css, cx } = defineRules({
        properties: { color: true }
      });
      const base = css({ color: "black" });
      ${classDeclarations}

      export function button(${parameters.join(", ")}) {
        return cx(base, ${operands.join(", ")});
      }
    `;
}

export function createDefineRulesCxRuntimeClasses(
  conditionCount: number
): Record<string, string> {
  const classes: Record<string, string> = {
    base: "__mincho_seg_base base"
  };

  for (let index = 0; index < conditionCount; index += 1) {
    classes[`class${index}`] = `__mincho_seg_class_${index} class-${index}`;
  }

  return classes;
}

export function createJoiningCx(onCall?: () => void): RuntimeCx {
  return (...values) => {
    onCall?.();

    const strings = values.filter((value): value is string => {
      if (typeof value !== "string") {
        return false;
      }

      return value.length > 0;
    });

    return strings.join(" ");
  };
}

export function forEachBooleanPermutation(
  conditionCount: number,
  callback: (flags: readonly boolean[]) => void
): void {
  for (let mask = 0; mask < 1 << conditionCount; mask += 1) {
    callback(
      Array.from(
        { length: conditionCount },
        (_, index) => (mask & (1 << index)) !== 0
      )
    );
  }
}

export function runDefineRulesCxModule(
  code: string,
  classes: Readonly<Record<string, string>>,
  cx: RuntimeCx
): DefineRulesCxRuntimeButton {
  const result = transformSync(code, {
    plugins: [defineRulesCxRuntimeTransformPlugin()],
    presets: [typescriptPresetPath],
    filename: "runtime-test.ts"
  });

  if (result === null || result.code == null) {
    throw new Error("Failed to transform defineRules cx runtime test code");
  }

  const execute = new Function(
    "__minchoCx",
    "__minchoClasses",
    `${result.code}\nreturn button;`
  ) as (
    runtimeCx: RuntimeCx,
    runtimeClasses: Readonly<Record<string, string>>
  ) => unknown;

  const button = execute(cx, classes);

  if (typeof button !== "function") {
    throw new Error("Runtime test did not produce a button function");
  }

  return (...args) => {
    const value: unknown = button(...args);

    if (typeof value !== "string") {
      throw new Error("Runtime test button did not return a string");
    }

    return value;
  };
}

export type RuntimeDefineRules = (config: unknown) => {
  readonly css: RuntimeCss;
  readonly cx: RuntimeCx;
};

export interface InspectableDefineRulesRuntime {
  readonly defineRules: RuntimeDefineRules;

  computeClassNameStyle(className: string): Readonly<Record<string, string>>;
}

export interface InspectableClassStyle {
  readonly order: number;
  readonly style: Readonly<Record<string, string>>;
}

export function runLocalDefineRulesCxModule(
  code: string,
  defineRules: RuntimeDefineRules
): DefineRulesCxRuntimeButton {
  const result = transformSync(code, {
    plugins: [localDefineRulesCxRuntimeTransformPlugin()],
    presets: [typescriptPresetPath],
    filename: "runtime-test.ts"
  });

  if (result === null || result.code == null) {
    throw new Error(
      "Failed to transform local defineRules cx runtime test code"
    );
  }

  const execute = new Function(
    "__minchoDefineRules",
    `${result.code}\nreturn button;`
  ) as (runtimeDefineRules: RuntimeDefineRules) => unknown;

  const button = execute(defineRules);

  if (typeof button !== "function") {
    throw new Error("Runtime test did not produce a button function");
  }

  return (...args) => {
    const value: unknown = button(...args);

    if (typeof value !== "string") {
      throw new Error("Runtime test button did not return a string");
    }

    return value;
  };
}

export function localDefineRulesCxRuntimeTransformPlugin(): PluginObj {
  return {
    visitor: {
      ImportDeclaration(importPath) {
        if (
          !["@mincho-js/css", "@mincho-js/css/classname"].includes(
            importPath.node.source.value
          )
        ) {
          return;
        }

        const declarations = importPath.node.specifiers.flatMap((specifier) => {
          if (
            !t.isImportSpecifier(specifier) ||
            !t.isIdentifier(specifier.imported) ||
            !t.isIdentifier(specifier.local) ||
            specifier.imported.name !== "defineRules"
          ) {
            return [];
          }

          return t.variableDeclaration("const", [
            t.variableDeclarator(
              t.cloneNode(specifier.local),
              t.identifier("__minchoDefineRules")
            )
          ]);
        });

        if (declarations.length === 0) {
          importPath.remove();

          return;
        }

        importPath.replaceWithMultiple(declarations);
      },

      ExportNamedDeclaration(exportPath) {
        const { declaration } = exportPath.node;

        if (declaration !== null && declaration !== undefined) {
          exportPath.replaceWith(declaration);
        }
      }
    }
  };
}

export function createInspectableDefineRulesRuntime(): InspectableDefineRulesRuntime {
  let nextClassId = 0;
  const styles = new Map<string, InspectableClassStyle>();

  const css: RuntimeCss = (styleInput) => {
    if (!isInspectableStyle(styleInput)) {
      throw new Error("Inspectable css() only accepts string-valued styles");
    }

    const className = `class-${nextClassId}`;
    nextClassId += 1;
    styles.set(className, { order: nextClassId, style: styleInput });

    return className;
  };

  const cx: RuntimeCx = (...values) =>
    mergeInspectableClassValues(styles, values).join(" ");

  return {
    defineRules: () => ({ css, cx }),

    computeClassNameStyle(className) {
      return computeInspectableClassNameStyle(styles, className);
    }
  };
}

export function isInspectableStyle(
  value: unknown
): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function flattenInspectableClassValues(
  values: readonly unknown[]
): string[] {
  const classNames: string[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      if (value.length > 0) {
        classNames.push(value);
      }

      continue;
    }

    if (typeof value === "number") {
      if (value !== 0) {
        classNames.push(String(value));
      }

      continue;
    }

    if (Array.isArray(value)) {
      classNames.push(...flattenInspectableClassValues(value));
      continue;
    }

    if (typeof value === "object" && value !== null) {
      for (const [className, enabled] of Object.entries(value)) {
        if (enabled) {
          classNames.push(className);
        }
      }
    }
  }

  return classNames;
}

export function mergeInspectableClassValues(
  styles: ReadonlyMap<string, InspectableClassStyle>,
  values: readonly unknown[]
): string[] {
  const classNames = flattenInspectableClassValues(values);
  const keptClassNames: string[] = [];
  const seenProperties = new Set<string>();

  for (let index = classNames.length - 1; index >= 0; index -= 1) {
    const className = classNames[index];
    const style = className === undefined ? undefined : styles.get(className);

    if (className === undefined || style === undefined) {
      continue;
    }

    const properties = Object.keys(style.style);

    if (properties.every((property) => seenProperties.has(property))) {
      continue;
    }

    keptClassNames.push(className);

    for (const property of properties) {
      seenProperties.add(property);
    }
  }

  return keptClassNames.reverse();
}

export function computeInspectableClassNameStyle(
  styles: ReadonlyMap<string, InspectableClassStyle>,
  className: string
): Readonly<Record<string, string>> {
  const selectedTokens = new Set(className.trim().split(/\s+/).filter(Boolean));
  const selectedStyles = [...styles]
    .filter(([token]) => selectedTokens.has(token))
    .map(([, style]) => style)
    .sort((left, right) => left.order - right.order);

  const customProperties: Record<string, string> = {};
  const properties: Record<string, string> = {};

  for (const { style } of selectedStyles) {
    for (const [property, value] of Object.entries(style)) {
      if (property.startsWith("--")) {
        customProperties[property] = value;
        continue;
      }

      properties[property] = value;
    }
  }

  for (const [property, value] of Object.entries(properties)) {
    properties[property] = resolveInspectableCssValue(value, customProperties);
  }

  return properties;
}

export function resolveInspectableCssValue(
  value: string,
  customProperties: Readonly<Record<string, string>>
): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    if (!value.startsWith("var(", index)) {
      output += value[index] ?? "";
      index += 1;
      continue;
    }

    const parsed = parseInspectableVar(value, index);

    if (parsed === null) {
      output += value.slice(index);
      break;
    }

    const customValue = customProperties[parsed.name];
    output +=
      customValue === undefined || customValue === "initial"
        ? resolveInspectableCssValue(parsed.fallback, customProperties)
        : customValue;
    index = parsed.end;
  }

  return output.trim().replace(/\s+/g, " ");
}

export function parseInspectableVar(
  value: string,
  start: number
): {
  readonly name: string;
  readonly fallback: string;
  readonly end: number;
} | null {
  let depth = 1;
  let comma = -1;

  for (let index = start + 4; index < value.length; index += 1) {
    const char = value[index];

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return comma === -1
          ? null
          : {
              name: value.slice(start + 4, comma).trim(),
              fallback: value.slice(comma + 1, index).trim(),
              end: index + 1
            };
      }

      continue;
    }

    if (char === "," && depth === 1 && comma === -1) {
      comma = index;
    }
  }

  return null;
}

export function defineRulesCxRuntimeTransformPlugin(): PluginObj {
  return {
    visitor: {
      ImportDeclaration(importPath) {
        if (importPath.node.source.value !== "./styles") {
          return;
        }

        const declarations = importPath.node.specifiers.flatMap((specifier) => {
          if (
            !t.isImportSpecifier(specifier) ||
            !t.isIdentifier(specifier.imported) ||
            !t.isIdentifier(specifier.local)
          ) {
            return [];
          }

          const importedName = specifier.imported.name;
          const init =
            importedName === "cx"
              ? t.identifier("__minchoCx")
              : t.memberExpression(
                  t.identifier("__minchoClasses"),
                  t.stringLiteral(importedName),
                  true
                );

          return t.variableDeclaration("const", [
            t.variableDeclarator(t.cloneNode(specifier.local), init)
          ]);
        });

        importPath.replaceWithMultiple(declarations);
      },

      ExportNamedDeclaration(exportPath) {
        const { declaration } = exportPath.node;

        if (declaration !== null && declaration !== undefined) {
          exportPath.replaceWith(declaration);
        }
      }
    }
  };
}

export function getDefineRulesCxConditionCalls(
  metadata: MinchoBabelFileMetadata
) {
  return metadata.minchoDefineRulesCxConditions?.calls ?? [];
}

export function createUnsupportedReexportStaticCssEvalProvider(): StaticCssEvalProvider {
  return {
    getResolvedCssValue(query): StaticCssEvalProviderResult {
      return {
        kind: "error",
        diagnostic: {
          code: "unsupported-source",
          message:
            'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax',
          reason: "reexport-or-barrel",
          owner: {
            file: query.importerId,
            start: query.expressionStart,
            end: query.expressionEnd
          },
          dependency: { file: "/provider/barrel.ts" },
          importPath: "./barrel",
          exportName: "button",
          memberPath: query.memberPath ?? [],
          importChain: [query.importerId, "/provider/barrel.ts#button"]
        },
        dependencies: ["/provider/barrel.ts"]
      };
    }
  };
}

export function runJsxCssPropRuntime(
  source: string,
  returnStatement: string
): unknown {
  const { code } = babelTransform(source, { jsxCssProp: true });
  const result = transformSync(code, {
    plugins: [jsxRuntimeTransformPlugin()],
    presets: [typescriptPresetPath],
    filename: "runtime-test.tsx"
  });

  if (result === null) {
    throw new Error("Failed to transform runtime test code");
  }

  const runtimeCode = result.code;

  if (runtimeCode == null) {
    throw new Error("Failed to transform runtime test code");
  }

  const execute = new Function(
    "__minchoJsx",
    "__minchoCx",
    "__minchoCss",
    "__minchoVx",
    `${runtimeCode}\n${returnStatement}`
  ) as (
    jsx: RuntimeJsx,
    cx: RuntimeCx,
    css: RuntimeCss,
    vx: RuntimeVx
  ) => unknown;

  return execute(
    (_tag, props = {}) => props,
    (...values) => values.filter(Boolean).join(" "),
    () => "css-rule",
    (value, suffix) => {
      if (value === null || value === undefined || typeof value === "boolean") {
        return "var(--c-, )";
      }

      return suffix ? `${value}${suffix}` : value;
    }
  );
}

export function jsxRuntimeTransformPlugin(): PluginObj {
  return {
    visitor: {
      ImportDeclaration(importPath) {
        if (importPath.node.source.value.endsWith(".css.ts")) {
          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
              if (!t.isImportSpecifier(specifier)) {
                return [];
              }

              return t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.cloneNode(specifier.local),
                  isGeneratedCxImportSpecifier(specifier)
                    ? t.identifier("__minchoCx")
                    : t.stringLiteral("css-rule")
                )
              ]);
            }
          );

          if (declarations.length === 0) {
            importPath.remove();

            return;
          }

          importPath.replaceWithMultiple(declarations);

          return;
        }

        if (importPath.node.source.value === "@mincho-js/transform-runtime") {
          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
              if (
                !t.isImportSpecifier(specifier) ||
                !t.isIdentifier(specifier.imported) ||
                specifier.imported.name !== "vx"
              ) {
                return [];
              }

              return t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.cloneNode(specifier.local),
                  t.identifier("__minchoVx")
                )
              ]);
            }
          );

          if (declarations.length === 0) {
            importPath.remove();

            return;
          }

          importPath.replaceWithMultiple(declarations);

          return;
        }

        if (
          !["@mincho-js/css", "@mincho-js/css/classname"].includes(
            importPath.node.source.value
          )
        ) {
          return;
        }

        const declarations = importPath.node.specifiers.flatMap((specifier) => {
          if (
            !t.isImportSpecifier(specifier) ||
            !t.isIdentifier(specifier.imported)
          ) {
            return [];
          }

          const runtimeIdentifier = getRuntimeImportIdentifier(
            specifier.imported.name
          );

          if (!runtimeIdentifier) {
            return [];
          }

          return t.variableDeclaration("const", [
            t.variableDeclarator(
              t.cloneNode(specifier.local),
              runtimeIdentifier
            )
          ]);
        });

        if (declarations.length === 0) {
          importPath.remove();

          return;
        }

        importPath.replaceWithMultiple(declarations);
      },

      JSXElement(jsxPath) {
        jsxPath.replaceWith(
          t.callExpression(t.identifier("__minchoJsx"), [
            createRuntimeJsxTagExpression(jsxPath.node.openingElement.name),
            createRuntimeJsxPropsExpression(jsxPath.node.openingElement)
          ])
        );
      },

      JSXFragment(jsxPath) {
        jsxPath.replaceWith(
          t.callExpression(t.identifier("__minchoJsx"), [
            t.stringLiteral("Fragment"),
            t.objectExpression([])
          ])
        );
      }
    }
  };
}

export function getRuntimeImportIdentifier(
  methodName: string
): t.Identifier | null {
  if (methodName === "cx") {
    return t.identifier("__minchoCx");
  }

  if (methodName === "css") {
    return t.identifier("__minchoCss");
  }

  return null;
}

export function isGeneratedCxImportSpecifier(
  specifier: t.ImportSpecifier
): boolean {
  return (
    t.isIdentifier(specifier.imported) && /Cx\d*$/.test(specifier.imported.name)
  );
}

export function createRuntimeJsxTagExpression(
  name: t.JSXOpeningElement["name"]
): t.Expression {
  if (t.isJSXIdentifier(name)) {
    if (/^[a-z]/.test(name.name)) {
      return t.stringLiteral(name.name);
    }

    return t.identifier(name.name);
  }

  if (t.isJSXMemberExpression(name)) {
    return t.memberExpression(
      createRuntimeJsxTagExpression(name.object),
      t.identifier(name.property.name)
    );
  }

  return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
}

export function createRuntimeJsxPropsExpression(
  openingElement: t.JSXOpeningElement
): t.ObjectExpression {
  return t.objectExpression(
    openingElement.attributes.map((attribute) => {
      if (t.isJSXSpreadAttribute(attribute)) {
        return t.spreadElement(t.cloneNode(attribute.argument));
      }

      return t.objectProperty(
        createRuntimeJsxAttributeKey(attribute.name),
        createRuntimeJsxAttributeValue(attribute)
      );
    })
  );
}

export function createRuntimeJsxAttributeKey(
  name: t.JSXAttribute["name"]
): t.Identifier | t.StringLiteral {
  if (t.isJSXNamespacedName(name)) {
    return t.stringLiteral(`${name.namespace.name}:${name.name.name}`);
  }

  if (t.isValidIdentifier(name.name)) {
    return t.identifier(name.name);
  }

  return t.stringLiteral(name.name);
}

export function createRuntimeJsxAttributeValue(
  attribute: t.JSXAttribute
): t.Expression {
  if (attribute.value === null) {
    return t.booleanLiteral(true);
  }

  if (t.isStringLiteral(attribute.value)) {
    return t.cloneNode(attribute.value);
  }

  if (t.isJSXExpressionContainer(attribute.value)) {
    const { expression } = attribute.value;

    if (t.isJSXEmptyExpression(expression)) {
      return t.identifier("undefined");
    }

    return t.cloneNode(expression);
  }

  return t.identifier("undefined");
}

export const jsxCssPropErrorMessages = {
  fragmentTarget:
    "Mincho JSX css prop does not support fragments because fragments cannot receive className",
  namespacedTarget:
    "Mincho JSX css prop does not support namespaced JSX elements",
  unsupportedTarget:
    "Mincho JSX css prop only supports JSX identifiers and member expressions",
  keyRefSpread:
    "Mincho JSX css prop does not support key/ref on spread elements in compile-away mode",
  spreadAggregationContext:
    "Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode",
  expressionValue: "Mincho JSX css prop requires an expression value",
  cssValue: "Mincho JSX css prop expects a Mincho CSS object/expression",
  unsupportedFunction:
    "Mincho JSX css prop does not support function values in compile-away mode",
  unsupportedDynamicCssRule:
    "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode",
  unsupportedArraySpread:
    "Mincho JSX css prop array values do not support spread elements in compile-away mode",
  unsupportedFirstLevelArrayBranch:
    "Mincho JSX css prop array branch extraction only supports first-level dynamic branches",
  nestedAsyncGenerator:
    "Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode",
  duplicateCss: "Mincho JSX css prop must appear only once",
  duplicateClassName:
    "Mincho JSX css prop cannot merge duplicate className attributes",
  classNameValue:
    "Mincho JSX css prop requires className to be a string literal or expression",
  styleValue:
    "Mincho JSX css prop requires style to be an expression value when merging dynamic CSS variables"
} as const;

export type DynamicCssVariableRuleSnapshot = {
  readonly kind: DynamicCssVariableRule["kind"];
  readonly expressionType: string;
  readonly leafProperties: readonly string[];
  readonly branches?: readonly DynamicCssVariableRuleSnapshot[];
};

export function collectDynamicCssVariableRuleSnapshot(
  source: string
): DynamicCssVariableRuleSnapshot | null {
  let snapshot: DynamicCssVariableRuleSnapshot | null = null;
  let hasVisitedCssCandidate = false;

  transformSync(source, {
    plugins: [
      () => ({
        visitor: {
          JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
            if (hasVisitedCssCandidate) {
              return;
            }

            const cssAttribute = path.node.attributes.find(
              (attribute): attribute is t.JSXAttribute =>
                t.isJSXAttribute(attribute) &&
                t.isJSXIdentifier(attribute.name) &&
                attribute.name.name === "css"
            );

            if (
              !cssAttribute ||
              !t.isJSXExpressionContainer(cssAttribute.value)
            ) {
              return;
            }

            const { expression } = cssAttribute.value;

            if (
              t.isJSXEmptyExpression(expression) ||
              !t.isExpression(expression)
            ) {
              return;
            }

            const rule = getDynamicCssVariableRule({
              expression,
              scope: path.scope
            });

            hasVisitedCssCandidate = true;
            snapshot = rule ? createDynamicCssVariableRuleSnapshot(rule) : null;
          }
        }
      })
    ],
    presets: [typescriptPresetPath],
    filename: "collector-test.tsx"
  });

  return snapshot;
}

export function createDynamicCssVariableRuleSnapshot(
  rule: DynamicCssVariableRule
): DynamicCssVariableRuleSnapshot {
  switch (rule.kind) {
    case "direct":
      return {
        kind: rule.kind,
        expressionType: rule.fragment.expression.type,
        leafProperties: rule.fragment.leaves.map((leaf) => leaf.propertyName)
      };
    case "branch":
      return {
        kind: rule.kind,
        expressionType: rule.fragment.expression.type,
        leafProperties: rule.fragment.leaves.map((leaf) => leaf.propertyName),
        branches: rule.branches.map(createDynamicCssVariableRuleSnapshot)
      };
    default: {
      const unexpectedRule: never = rule;

      throw new Error(
        `Unexpected dynamic CSS variable rule: ${unexpectedRule}`
      );
    }
  }
}

export function expectJsxCssPropError(fixture: string, message: string) {
  expect(() =>
    babelTransform(
      `
          function App() {
            return ${fixture};
          }
        `,
      { jsxCssProp: true }
    )
  ).toThrow(message);
}

export function expectNestedJsxCssPropError(fixture: string, message: string) {
  expect(() =>
    babelTransform(
      `
          const classes = ["extra"];
          let dynamicClasses = classes;
          const condition = true;
          const props = { className: "base", css: "leaked" };
          const ref = { current: null };
          const styleA = "style-a";
          const Component = "div";

          function App() {
            const renderValue = () => ${fixture};
            return renderValue();
          }
        `,
      { jsxCssProp: true }
    )
  ).toThrow(message);
}

export function expectNestedUnsupportedJsxTargetError(
  message = jsxCssPropErrorMessages.unsupportedTarget
) {
  const options: PluginOptions = { result: ["", ""], jsxCssProp: true };
  const invalidTargetPlugin: PluginObj<PluginState> = {
    visitor: {
      Program(path) {
        path.traverse({
          JSXOpeningElement(openingElementPath) {
            Object.assign(openingElementPath.node, {
              name: t.stringLiteral("invalid-target")
            });
            openingElementPath.stop();
          }
        });
      }
    }
  };

  expect(() =>
    transformSync(
      `
          const props = { className: "base", css: "leaked" };
          const styleA = "style-a";

          function App(ok) {
            return ok ? <div {...props} css={styleA} /> : null;
          }
        `,
      {
        plugins: [
          invalidTargetPlugin,
          [minchoBabelPlugin(), options],
          [styledComponentPlugin()]
        ],
        presets: [typescriptPresetPath],
        filename: "invalid-jsx-target-test.tsx"
      }
    )
  ).toThrow(message);
}

export function expectUnsupportedSpreadAggregationContextError(
  message: string
) {
  const options: PluginOptions = { result: ["", ""], jsxCssProp: true };
  const invalidSpreadContextPlugin: PluginObj<PluginState> = {
    visitor: {
      Program(path) {
        path.traverse({
          JSXElement(jsxElementPath) {
            const parentPath = jsxElementPath.parentPath;

            if (!parentPath.isReturnStatement()) {
              return;
            }

            Object.assign(parentPath.node, {
              argument: jsxElementPath.node.openingElement
            });
            jsxElementPath.stop();
          }
        });
      }
    }
  };

  expect(() =>
    transformSync(
      `
          const props = { className: "base", css: "leaked" };
          const styleA = "style-a";

          function App() {
            return <div {...props} css={styleA} />;
          }
        `,
      {
        plugins: [
          invalidSpreadContextPlugin,
          [minchoBabelPlugin(), options],
          [styledComponentPlugin()]
        ],
        presets: [typescriptPresetPath],
        filename: "invalid-spread-context-test.tsx"
      }
    )
  ).toThrow(message);
}

export function expectNestedInvalidClassNameExpressionError() {
  const options: PluginOptions = { result: ["", ""], jsxCssProp: true };
  const invalidClassNamePlugin: PluginObj<PluginState> = {
    visitor: {
      Program(path) {
        path.traverse({
          JSXAttribute(attributePath) {
            if (
              !t.isJSXIdentifier(attributePath.node.name) ||
              attributePath.node.name.name !== "className"
            ) {
              return;
            }

            attributePath.node.value = t.jsxExpressionContainer(
              t.jsxEmptyExpression()
            );
            attributePath.stop();
          }
        });
      }
    }
  };

  expect(() =>
    transformSync(
      `
          const props = { className: "base", css: "leaked" };
          const styleA = "style-a";

          function App() {
            const renderValue = () => <div {...props} className="base" css={styleA} />;
            return renderValue();
          }
        `,
      {
        plugins: [
          invalidClassNamePlugin,
          [minchoBabelPlugin(), options],
          [styledComponentPlugin()]
        ],
        presets: [typescriptPresetPath],
        filename: "invalid-class-name-test.tsx"
      }
    )
  ).toThrow(jsxCssPropErrorMessages.classNameValue);
}

export const staticShapeDiagnosticPattern =
  /Mincho `css` requires statically known CSS shape/;

export const reactStyleGuidancePattern = /React `style=\{\.\.\.\}`/;

export function captureJsxCssPropFailure(
  code: string,
  pluginOptions: Partial<
    Pick<PluginOptions, "jsxCssProp" | "staticCssEvalProvider" | "optimize">
  > = {},
  transformOptions: { filename?: string } = {}
): {
  code: string;
  error: Error;
  metadata: MinchoBabelFileMetadata;
} {
  const options: PluginOptions = { result: ["", ""], ...pluginOptions };
  let capturedError: Error | null = null;
  let capturedMetadata: MinchoBabelFileMetadata = {};
  const capturePlugin: PluginObj<PluginState> = {
    visitor: {
      Program(path, state) {
        try {
          preprocess(path);
          preprocessJsxCssProp(path, state);
        } catch (error) {
          capturedError =
            error instanceof Error ? error : new Error(String(error));
          capturedMetadata = state.file.metadata;
          path.stop();
        }
      }
    }
  };

  const result = transformSync(code, {
    plugins: [[capturePlugin, options]],
    presets: [typescriptPresetPath],
    filename: transformOptions.filename ?? "test.tsx"
  });

  if (!capturedError) {
    throw new Error("Expected JSX css prop transform to fail");
  }

  if (result === null || result.code == null) {
    throw new Error("Failed to transform failure capture code");
  }

  return {
    code: result.code,
    error: capturedError,
    metadata: capturedMetadata
  };
}

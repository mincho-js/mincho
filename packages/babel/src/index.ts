import {
  type NodePath,
  type PluginObj,
  transformSync,
  types as t
} from "@babel/core";
import { transformCallExpression } from "./transforms/callExpression.js";
import {
  preprocessJsxCssProp,
  removeUnusedJsxCssPropCssModuleImports
} from "./jsxCssProp.js";
import {
  analyzeDefineRulesCxConditionsCallExpression,
  defineRulesCxConditionsOptimizationMetadataKey,
  isDefineRulesCxConditionsEnabled
} from "./defineRulesCxConditions.js";
import { getDynamicCssVariableRule } from "./jsxCssProp/preprocess.js";
import { supportedJsxCssPropTags } from "./jsxCssPropTags.js";
import { createImportedStaticCssEvalProvider } from "./staticCssEval/importedModules.js";
import { STATIC_CSS_EVAL_LIMITS } from "./staticCssEval/types.js";
import postprocess from "./transforms/postprocess.js";
import basePreprocess from "./transforms/preprocess.js";
import type { DynamicCssVariableRule } from "./jsxCssProp/types.js";
import type {
  MinchoBabelFileMetadata,
  PluginOptions,
  PluginState
} from "./types.js";
import { styledComponentPlugin } from "./styled.js";

const preprocess = basePreprocess as (
  path: Parameters<typeof basePreprocess>[0],
  state: PluginState
) => void;

export function minchoBabelPlugin(): PluginObj<PluginState> {
  return {
    name: "mincho-babel-plugin",
    visitor: {
      Program: {
        enter(path, state) {
          if (isDefineRulesCxConditionsEnabled(state)) {
            state.file.metadata[
              defineRulesCxConditionsOptimizationMetadataKey
            ] = true;
          }
          preprocess(path, state);
          state.opts.jsxCssPropTransformed = preprocessJsxCssProp(path, state);
        },
        exit(path, state) {
          removeUnusedJsxCssPropCssModuleImports(path);
          postprocess(path, state);
        }
      },
      CallExpression(path, state) {
        analyzeDefineRulesCxConditionsCallExpression(path, state);

        if (path.isCallExpression()) {
          transformCallExpression(path);
        }
      }
    }
  };
}

export { styledComponentPlugin as minchoStyledComponentPlugin } from "./styled.js";
export {
  appendUniqueMetadataItems as internalAppendUniqueStaticCssEvalMetadataItems,
  appendUniqueResolvedModuleIds as internalAppendUniqueStaticCssEvalResolvedModuleIds,
  createResolutionDependencyMetadataKey as internalCreateStaticCssEvalDependencyMetadataKey,
  createStaticCssEvalCacheKeyMetadataKey as internalCreateStaticCssEvalCacheKeyMetadataKey,
  createStaticCssEvalDiagnosticMetadataKey as internalCreateStaticCssEvalDiagnosticMetadataKey
} from "./jsxCssProp.js";
export {
  collectJsxCssPropStaticCssEvalCandidates as internalCollectJsxCssPropStaticCssEvalCandidates,
  getStaticCssEvalMemberReference as internalGetStaticCssEvalMemberReference,
  unwrapTransparentCssRuleExpression as internalUnwrapTransparentCssRuleExpression
} from "./staticCssEval/candidates.js";
export {
  createImportedStaticCssEvalModuleRecord as internalCreateImportedStaticCssEvalModuleRecord,
  createImportedStaticCssEvalProvider as internalCreateImportedStaticCssEvalProvider
} from "./staticCssEval/importedModules.js";
export type {
  MinchoBabelFileMetadata,
  MinchoStaticCssEvalMetadata,
  PluginOptions
} from "./types.js";
export type {
  ImportedStaticCssEvalImportResolution as InternalImportedStaticCssEvalImportResolution,
  ImportedStaticCssEvalLoadedModule as InternalImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord as InternalImportedStaticCssEvalModuleRecord
} from "./staticCssEval/importedModules.js";

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  function babelTransform(
    code: string,
    pluginOptions: Partial<
      Pick<PluginOptions, "jsxCssProp" | "staticCssEvalProvider" | "optimize">
    > = {},
    transformOptions: { filename?: string } = {}
  ) {
    const options: PluginOptions = { result: ["", ""], ...pluginOptions };
    const result = transformSync(code, {
      plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]],
      presets: ["@babel/preset-typescript"],
      filename: transformOptions.filename ?? "test.tsx"
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

  type RuntimeJsx = (
    tag: unknown,
    props?: Record<string, unknown>
  ) => Record<string, unknown>;
  type RuntimeCx = (...values: unknown[]) => string;
  type RuntimeCss = (styles: unknown) => string;
  type DefineRulesCxRuntimeButton = (...args: unknown[]) => string;
  type RuntimeVx = (
    value: string | number | boolean | null | undefined,
    suffix?: string | null
  ) => string | number;
  type StaticCssEvalProvider = NonNullable<
    PluginOptions["staticCssEvalProvider"]
  >;
  type StaticCssEvalProviderResult = ReturnType<
    StaticCssEvalProvider["getResolvedCssValue"]
  >;
  type StaticCssEvalValue = Extract<
    StaticCssEvalProviderResult,
    { kind: "resolved" }
  >["value"];

  function createResolvedStaticCssEvalProvider(
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

  function createDefineRulesCxRuntimeRecipeValue(): StaticCssEvalValue {
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

  function createDefineRulesCxPermutationSource(
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

  function createLocalDefineRulesCxFallbackSource(
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

  function createDefineRulesCxRuntimeClasses(
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

  function createJoiningCx(onCall?: () => void): RuntimeCx {
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

  function forEachBooleanPermutation(
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

  function runDefineRulesCxModule(
    code: string,
    classes: Readonly<Record<string, string>>,
    cx: RuntimeCx
  ): DefineRulesCxRuntimeButton {
    const result = transformSync(code, {
      plugins: [defineRulesCxRuntimeTransformPlugin()],
      presets: ["@babel/preset-typescript"],
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

  type RuntimeDefineRules = (config: unknown) => {
    readonly css: RuntimeCss;
    readonly cx: RuntimeCx;
  };

  interface InspectableDefineRulesRuntime {
    readonly defineRules: RuntimeDefineRules;
    computeClassNameStyle(className: string): Readonly<Record<string, string>>;
  }

  interface InspectableClassStyle {
    readonly order: number;
    readonly style: Readonly<Record<string, string>>;
  }

  function runLocalDefineRulesCxModule(
    code: string,
    defineRules: RuntimeDefineRules
  ): DefineRulesCxRuntimeButton {
    const result = transformSync(code, {
      plugins: [localDefineRulesCxRuntimeTransformPlugin()],
      presets: ["@babel/preset-typescript"],
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

  function localDefineRulesCxRuntimeTransformPlugin(): PluginObj {
    return {
      visitor: {
        ImportDeclaration(importPath) {
          if (importPath.node.source.value !== "@mincho-js/css") {
            return;
          }

          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
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
            }
          );

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

  function createInspectableDefineRulesRuntime(): InspectableDefineRulesRuntime {
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

  function isInspectableStyle(
    value: unknown
  ): value is Readonly<Record<string, string>> {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === "string")
    );
  }

  function flattenInspectableClassValues(values: readonly unknown[]): string[] {
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

  function mergeInspectableClassValues(
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

  function computeInspectableClassNameStyle(
    styles: ReadonlyMap<string, InspectableClassStyle>,
    className: string
  ): Readonly<Record<string, string>> {
    const selectedTokens = new Set(
      className.trim().split(/\s+/).filter(Boolean)
    );
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
      properties[property] = resolveInspectableCssValue(
        value,
        customProperties
      );
    }

    return properties;
  }

  function resolveInspectableCssValue(
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

  function parseInspectableVar(
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

  function defineRulesCxRuntimeTransformPlugin(): PluginObj {
    return {
      visitor: {
        ImportDeclaration(importPath) {
          if (importPath.node.source.value !== "./styles") {
            return;
          }

          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
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
            }
          );

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

  function getDefineRulesCxConditionCalls(metadata: MinchoBabelFileMetadata) {
    return metadata.minchoDefineRulesCxConditions?.calls ?? [];
  }

  function createUnsupportedReexportStaticCssEvalProvider(): StaticCssEvalProvider {
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

  function runJsxCssPropRuntime(
    source: string,
    returnStatement: string
  ): unknown {
    const { code } = babelTransform(source, { jsxCssProp: true });
    const result = transformSync(code, {
      plugins: [jsxRuntimeTransformPlugin()],
      presets: ["@babel/preset-typescript"],
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
        if (
          value === null ||
          value === undefined ||
          typeof value === "boolean"
        ) {
          return "var(--c-, )";
        }

        return suffix ? `${value}${suffix}` : value;
      }
    );
  }

  function jsxRuntimeTransformPlugin(): PluginObj {
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

          if (importPath.node.source.value !== "@mincho-js/css") {
            return;
          }

          const declarations = importPath.node.specifiers.flatMap(
            (specifier) => {
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
            }
          );

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

  function getRuntimeImportIdentifier(methodName: string): t.Identifier | null {
    if (methodName === "cx") {
      return t.identifier("__minchoCx");
    }

    if (methodName === "css") {
      return t.identifier("__minchoCss");
    }

    return null;
  }

  function isGeneratedCxImportSpecifier(specifier: t.ImportSpecifier): boolean {
    return (
      t.isIdentifier(specifier.imported) &&
      /Cx\d*$/.test(specifier.imported.name)
    );
  }

  function createRuntimeJsxTagExpression(
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

  function createRuntimeJsxPropsExpression(
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

  function createRuntimeJsxAttributeKey(
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

  function createRuntimeJsxAttributeValue(
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

  const jsxCssPropErrorMessages = {
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

  type DynamicCssVariableRuleSnapshot = {
    readonly kind: DynamicCssVariableRule["kind"];
    readonly expressionType: string;
    readonly leafProperties: readonly string[];
    readonly branches?: readonly DynamicCssVariableRuleSnapshot[];
  };

  function collectDynamicCssVariableRuleSnapshot(
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
              snapshot = rule
                ? createDynamicCssVariableRuleSnapshot(rule)
                : null;
            }
          }
        })
      ],
      presets: ["@babel/preset-typescript"],
      filename: "collector-test.tsx"
    });

    return snapshot;
  }

  function createDynamicCssVariableRuleSnapshot(
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

  function expectJsxCssPropError(fixture: string, message: string) {
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

  function expectNestedJsxCssPropError(fixture: string, message: string) {
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

  function expectNestedUnsupportedJsxTargetError(
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
          presets: ["@babel/preset-typescript"],
          filename: "invalid-jsx-target-test.tsx"
        }
      )
    ).toThrow(message);
  }

  function expectUnsupportedSpreadAggregationContextError(message: string) {
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
          presets: ["@babel/preset-typescript"],
          filename: "invalid-spread-context-test.tsx"
        }
      )
    ).toThrow(message);
  }

  function expectNestedInvalidClassNameExpressionError() {
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
          presets: ["@babel/preset-typescript"],
          filename: "invalid-class-name-test.tsx"
        }
      )
    ).toThrow(jsxCssPropErrorMessages.classNameValue);
  }

  const staticShapeDiagnosticPattern =
    /Mincho `css` requires statically known CSS shape/;
  const reactStyleGuidancePattern = /React `style=\{\.\.\.\}`/;

  function captureJsxCssPropFailure(
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
            preprocess(path, state);
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
      presets: ["@babel/preset-typescript"],
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

  describe("minchoBabelPlugin", () => {
    it("export default style", () => {
      const { result, code } = babelTransform(`
        import { style } from "@mincho-js/css";

        export default style({
          color: "red",
        });
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }, 10_000);

    it("inside jsx expression", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function App() {
          return <div class={style({
            color: 'red'
          })}>Hello</div>
        }

        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("leaves jsx css prop unchanged when css prop lowering is disabled", () => {
      const source = `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `;
      const omitted = babelTransform(source);
      const explicitFalse = babelTransform(source, { jsxCssProp: false });

      expect(omitted.result).toMatchSnapshot();
      expect(omitted.code).toMatchSnapshot();
      expect(explicitFalse.result).toEqual(omitted.result);
      expect(explicitFalse.code).toBe(omitted.code);
    });

    it("leaves output unchanged when defineRules cx optimization is inactive", () => {
      const source = `
        import { defineRules } from '@mincho-js/css';

        const rules = defineRules({
          active: { color: "red" },
          idle: { color: "blue" }
        });

        export function button(active: boolean) {
          return rules.cx(rules.css("idle"), active && rules.css("active"));
        }
      `;
      const omitted = babelTransform(source);
      const emptyOptimize = babelTransform(source, { optimize: {} });
      const disabledOptimize = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });

      expect(emptyOptimize.result).toEqual(omitted.result);
      expect(emptyOptimize.code).toBe(omitted.code);
      expect(
        emptyOptimize.metadata[defineRulesCxConditionsOptimizationMetadataKey]
      ).toBeUndefined();
      expect(disabledOptimize.result).toEqual(omitted.result);
      expect(disabledOptimize.code).toBe(omitted.code);
      expect(
        disabledOptimize.metadata[
          defineRulesCxConditionsOptimizationMetadataKey
        ]
      ).toBeUndefined();
    });

    it("accepts defineRules cx optimization independently from jsx css prop", () => {
      const source = `
        import { defineRules } from '@mincho-js/css';

        const rules = defineRules({
          active: { color: "red" },
          idle: { color: "blue" }
        });

        export function button(active: boolean) {
          return rules.cx(rules.css("idle"), active && rules.css("active"));
        }
      `;
      const disabled = babelTransform(source, { jsxCssProp: false });
      const enabled = babelTransform(source, {
        jsxCssProp: false,
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.result).toEqual(disabled.result);
      expect(enabled.code).toBe(disabled.code);
      expect(
        disabled.metadata[defineRulesCxConditionsOptimizationMetadataKey]
      ).toBeUndefined();
      expect(
        enabled.metadata[defineRulesCxConditionsOptimizationMetadataKey]
      ).toBe(true);
    });

    it("marks and precomputes safe in-file defineRules cx condition operands", () => {
      const source = `
        import { defineRules } from '@mincho-js/css';

        const { css, cx } = defineRules({
          properties: { color: true }
        });
        const base = css({ color: "blue" });
        const activeClass = css({ color: "red" });

        export function button(active: boolean, danger: boolean) {
          return cx(base, active && activeClass, [danger ? activeClass : base]);
        }
      `;
      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.result).toEqual(disabled.result);
      expect(disabled.code).toContain("return cx(");
      expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
      expect(enabled.code).toContain("return _minchoDefineRulesCx[");
      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        {
          callee: "local-defineRules",
          operandCount: 3,
          conditionCount: 2,
          classOperandCount: 4,
          operands: [
            { kind: "class", source: "local-css-call" },
            {
              kind: "condition",
              operator: "&&",
              classOperand: { kind: "class", source: "local-css-call" }
            },
            {
              kind: "array",
              operands: [
                {
                  kind: "ternary",
                  consequent: { kind: "class", source: "local-css-call" },
                  alternate: { kind: "class", source: "local-css-call" }
                }
              ]
            }
          ]
        }
      ]);
    });

    it("marks and precomputes provider-backed serialized defineRules cx calls and marker operands", () => {
      const source = `
        import { cx, base, activeClass } from "./styles";

        export function button(active: boolean) {
          return cx(base, active ? activeClass : base);
        }
      `;
      const disabled = babelTransform(source, {
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          cx: createDefineRulesCxRuntimeRecipeValue(),
          base: "__mincho_seg_base base",
          activeClass: "__mincho_seg_active active"
        }),
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          cx: createDefineRulesCxRuntimeRecipeValue(),
          base: "__mincho_seg_base base",
          activeClass: "__mincho_seg_active active"
        }),
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.result).toEqual(disabled.result);
      expect(disabled.code).toContain("return cx(");
      expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
      expect(enabled.code).toContain("return _minchoDefineRulesCx[");
      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        {
          callee: "provider-createDefineRulesCxRuntime",
          operandCount: 2,
          conditionCount: 1,
          classOperandCount: 3,
          operands: [
            { kind: "class", source: "provider-marker" },
            {
              kind: "ternary",
              consequent: { kind: "class", source: "provider-marker" },
              alternate: { kind: "class", source: "provider-marker" }
            }
          ]
        }
      ]);
    });

    it("bails out unchanged for unsupported defineRules cx condition shapes", () => {
      const unsupportedReturns = [
        "return cx(base || activeClass);",
        "return cx(...classes);",
        "return cx({ [base]: active });",
        "return cx((active || activeClass) && base);",
        "return cx(active.valueOf?.() && base);",
        "return cx(String.raw`active` && base);"
      ];

      for (const returnStatement of unsupportedReturns) {
        const source = `
          import { defineRules } from '@mincho-js/css';

          const { css, cx } = defineRules({
            properties: { color: true }
          });
          const base = css({ color: "blue" });
          const activeClass = css({ color: "red" });
          const classes = [base, activeClass];

          export function button(active: boolean) {
            ${returnStatement}
          }
        `;
        const disabled = babelTransform(source, {
          optimize: { defineRulesCxConditions: false }
        });
        const enabled = babelTransform(source, {
          optimize: { defineRulesCxConditions: true }
        });

        expect(enabled.result).toEqual(disabled.result);
        expect(enabled.code).toBe(disabled.code);
        expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
        expect(enabled.metadata.minchoStaticCssEval?.diagnostics ?? []).toEqual(
          []
        );
      }
    });

    it("leaves provider-backed external class operands on the runtime path", () => {
      const source = `
        import { cx, base, externalClass } from "./styles";

        export function button(active: boolean) {
          return cx(base, active && externalClass);
        }
      `;
      const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        base: "__mincho_seg_base base",
        externalClass: "external-class"
      });
      const disabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.code).toBe(disabled.code);
      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
    });

    it("bails out without evaluating inactive function-call class operands", () => {
      const source = `
        import { defineRules } from '@mincho-js/css';

        const { cx } = defineRules({
          properties: { color: true }
        });

        function makeClass(): string {
          throw new Error("inactive branch evaluated");
        }

        export function button(active: boolean) {
          return cx(active && makeClass());
        }
      `;
      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.result).toEqual(disabled.result);
      expect(enabled.code).toBe(disabled.code);
      expect(enabled.code).toContain("active && makeClass()");
      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
      expect(enabled.metadata.minchoStaticCssEval?.diagnostics ?? []).toEqual(
        []
      );
    });

    it("precomputes 1-4 condition defineRules cx tables that match runtime cx", () => {
      for (let conditionCount = 1; conditionCount <= 4; conditionCount += 1) {
        const source = createDefineRulesCxPermutationSource(conditionCount);
        const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
          cx: createDefineRulesCxRuntimeRecipeValue(),
          ...createDefineRulesCxRuntimeClasses(conditionCount)
        });
        const disabled = babelTransform(source, {
          staticCssEvalProvider,
          optimize: { defineRulesCxConditions: false }
        });
        const enabled = babelTransform(source, {
          staticCssEvalProvider,
          optimize: { defineRulesCxConditions: true }
        });
        const classes = createDefineRulesCxRuntimeClasses(conditionCount);
        let optimizedCxCalls = 0;
        const optimizedButton = runDefineRulesCxModule(
          enabled.code,
          classes,
          createJoiningCx(() => {
            optimizedCxCalls += 1;
          })
        );
        const optimizedCxCallsAfterInit = optimizedCxCalls;
        const referenceButton = runDefineRulesCxModule(
          disabled.code,
          classes,
          createJoiningCx()
        );

        expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
          { conditionCount }
        ]);
        expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
        expect(enabled.code).toContain("return _minchoDefineRulesCx[");
        expect(enabled.code).not.toContain("return cx(");
        expect(optimizedCxCallsAfterInit).toBe(1 << conditionCount);

        forEachBooleanPermutation(conditionCount, (flags) => {
          expect(optimizedButton(...flags)).toBe(referenceButton(...flags));
        });
        expect(optimizedCxCalls).toBe(optimizedCxCallsAfterInit);
      }
    });

    it("preserves condition evaluation count and order for optimized tables", () => {
      const source = `
        import { cx, base, class0, class1 } from "./styles";

        export function button(probe: { first: boolean; second: boolean }) {
          return cx(base, probe.first && class0, probe.second && class1);
        }
      `;
      const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        base: "__mincho_seg_base base",
        class0: "__mincho_seg_class_0 class-0",
        class1: "__mincho_seg_class_1 class-1"
      });
      const enabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: true }
      });
      const events: string[] = [];
      let optimizedCxCalls = 0;
      const button = runDefineRulesCxModule(
        enabled.code,
        createDefineRulesCxRuntimeClasses(2),
        createJoiningCx(() => {
          optimizedCxCalls += 1;
        })
      );
      const optimizedCxCallsAfterInit = optimizedCxCalls;
      const probe = {
        get first() {
          events.push("first");
          return true;
        },
        get second() {
          events.push("second");
          return false;
        }
      };

      expect(button(probe)).toBe(
        "__mincho_seg_base base __mincho_seg_class_0 class-0"
      );
      expect(events).toEqual(["first", "second"]);
      expect(optimizedCxCalls).toBe(optimizedCxCallsAfterInit);
    });

    it("leaves more than 4 defineRules cx conditions on the runtime path", () => {
      const source = createDefineRulesCxPermutationSource(5);
      const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        ...createDefineRulesCxRuntimeClasses(5)
      });
      const disabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: true }
      });

      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        { conditionCount: 5 }
      ]);
      expect(enabled.code).toBe(disabled.code);
      expect(enabled.code).toContain("return cx(");
      expect(enabled.code).not.toContain("_minchoDefineRulesCx");
    });

    it("folds 5+ local defineRules cx conflicts with fallback chains", () => {
      const conditionCount = 5;
      const source = createLocalDefineRulesCxFallbackSource(conditionCount);
      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });
      const referenceRuntime = createInspectableDefineRulesRuntime();
      const optimizedRuntime = createInspectableDefineRulesRuntime();
      const referenceButton = runLocalDefineRulesCxModule(
        disabled.code,
        referenceRuntime.defineRules
      );
      const optimizedButton = runLocalDefineRulesCxModule(
        enabled.code,
        optimizedRuntime.defineRules
      );
      const cssCallCount = enabled.code.match(/css\(\{/g)?.length ?? 0;

      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        { conditionCount }
      ]);
      expect(disabled.code).toContain("return cx(");
      expect(enabled.code).not.toContain("const _minchoDefineRulesCx = [");
      expect(enabled.code).not.toContain("return cx(");
      expect(enabled.code).toContain('.filter(Boolean).join(" ")');
      expect(cssCallCount).toBeLessThanOrEqual(conditionCount * 2 + 2);

      forEachBooleanPermutation(conditionCount, (flags) => {
        expect(
          optimizedRuntime.computeClassNameStyle(optimizedButton(...flags)),
          `flags: ${flags.join(",")}`
        ).toEqual(
          referenceRuntime.computeClassNameStyle(referenceButton(...flags))
        );
      });
    });

    it("bails out fallback chains for explicit shorthand conflicts", () => {
      const propertyPairs = [
        ["all", "color"],
        ["inset", "top"],
        ["placeItems", "alignItems"],
        ["font", "fontFamily"],
        ["border", "borderTopColor"]
      ] as const;

      for (const [shorthand, longhand] of propertyPairs) {
        const source = `
          import { defineRules } from "@mincho-js/css";

          const { css, cx } = defineRules({
            properties: { ${shorthand}: true, ${longhand}: true }
          });
          const base = css({ ${shorthand}: "initial", ${longhand}: "initial" });

          export function button(
            flag0: boolean,
            flag1: boolean,
            flag2: boolean,
            flag3: boolean,
            flag4: boolean
          ) {
            return cx(base, ${Array.from(
              { length: 5 },
              (_, index) => `flag${index} && base`
            ).join(", ")});
          }
        `;
        const disabled = babelTransform(source, {
          optimize: { defineRulesCxConditions: false }
        });
        const enabled = babelTransform(source, {
          optimize: { defineRulesCxConditions: true }
        });

        expect(enabled.code).toBe(disabled.code);
      }
    });

    it("bails out fallback chains for missing-declaration branches", () => {
      const source = `
        import { defineRules } from "@mincho-js/css";

        const { css, cx } = defineRules({
          properties: { color: true }
        });
        const color0 = css({ color: "red" });
        const color1 = css({ color: "blue" });
        const color2 = css({ color: "green" });
        const color3 = css({ color: "purple" });
        const color4 = css({ color: "orange" });

        export function button(
          flag0: boolean,
          flag1: boolean,
          flag2: boolean,
          flag3: boolean,
          flag4: boolean
        ) {
          return cx(
            flag0 && color0,
            flag1 && color1,
            flag2 && color2,
            flag3 && color3,
            flag4 && color4
          );
        }
      `;
      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });
      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });

      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        { conditionCount: 5 }
      ]);
      expect(enabled.code).toBe(disabled.code);
      expect(enabled.code).toContain("return cx(");
      expect(enabled.code).not.toContain("_minchoDefineRulesCx");
    });

    it("accepts enabled jsx css prop mode when JSX has no css prop", () => {
      const source = `
        import { style } from '@mincho-js/css';

        function App() {
          return <div class={style({ color: "red" })}>Hello</div>;
        }
      `;
      const disabled = babelTransform(source);
      const enabled = babelTransform(source, { jsxCssProp: true });

      expect(enabled.result).toEqual(disabled.result);
      expect(enabled.code).toBe(disabled.code);
      expect(enabled.result).toMatchSnapshot();
      expect(enabled.code).toMatchSnapshot();
    });

    it("lowers inline object jsx css prop through css rule mode", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_$mincho$$App2}");
    });

    it("lowers same-file const object jsx css prop like an inline object", () => {
      const inline = babelTransform(
        `
        function App() {
          return <div css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const sameFileConst = babelTransform(
        `
        const style = { color: "red" };

        function App() {
          return <div css={style} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(sameFileConst.code).not.toContain(" css=");
      expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
      expect(sameFileConst.code).not.toContain("_cx(style)");
      expect(sameFileConst.result[1]).toBe(inline.result[1]);
    });

    it("lowers same-file const member jsx css prop like an inline object", () => {
      const { result, code } = babelTransform(
        `
        const styles = {
          button: { color: "red" }
        };

        function App() {
          return <div css={styles.button} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_$mincho$$App2}");
      expect(code).not.toContain("_cx(styles.button)");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
    });

    it("lowers static computed keys and optional members like inline css rules", () => {
      const { result, code } = babelTransform(
        `
        const colorKey = "color" as const;
        const variantKey = "button" as const;
        const styles = {
          button: { color: "blue" },
          optional: { card: { padding: 16 } }
        } as const;

        function App() {
          return <>
            <div css={{ [colorKey]: "red" }} />
            <div css={styles[variantKey]} />
            <div css={styles.optional?.card} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(");
      expect(code.match(/className=\{_\$mincho\$\$App\d+\}/g)).toHaveLength(3);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).toContain("padding: 16");
    });

    it("lowers provider-resolved imported css props like inline object and array literals", () => {
      const inline = babelTransform(
        `
        function App() {
          return <>
            <div css={{ color: "red" }} />
            <div css={["base", { color: "blue" }]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const imported = babelTransform(
        `
        import { button, stack } from "./styles";

        function App() {
          return <>
            <div css={button} />
            <div css={stack} />
          </>;
        }
      `,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            button: { color: "red" },
            stack: ["base", { color: "blue" }]
          })
        }
      );

      expect(imported.result[1]).toBe(inline.result[1]);
      expect(imported.code).not.toContain(" css=");
      expect(imported.code).not.toContain("_cx(button)");
      expect(imported.code).not.toContain("_cx(stack)");
      expect(
        imported.code.match(/className=\{_\$mincho\$\$App\d+\}/g)
      ).toHaveLength(2);
    });

    it("records imported static css eval metadata during css prop lowering", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const source = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const { result, code, metadata } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const button = { color: "red" } as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );
      const staticCssEvalMetadata = metadata.minchoStaticCssEval;

      expect(staticCssEvalMetadata?.dependencies[0]?.file).toBe(stylesFile);
      expect(staticCssEvalMetadata?.dependencies[0]?.contributed).toBe(true);
      expect(staticCssEvalMetadata?.diagnostics).toEqual([]);
      expect(staticCssEvalMetadata?.cacheKeys[0]?.resolvedId).toBe(stylesFile);
      expect(staticCssEvalMetadata?.resolvedModuleIds).toContain(stylesFile);
      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(code).not.toContain("_cx(button)");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
    });

    it("lowers whole namespace object imported css prop through static provider", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const source = `
        import * as styles from "./styles";

        function App() {
          return <div css={styles} />;
        }
      `;
      const { result, code } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const button = { color: "red" } as const;
                         export const card = { color: "blue" } as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(code).not.toContain("_cx(styles)");
      expect(result[1]).toContain("button: {");
      expect(result[1]).toContain("card: {");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
    });

    it("keeps local lexical shadowing ahead of whole namespace css prop resolution", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const source = `
        import * as styles from "./styles";

        function App() {
          const styles = { color: "blue" };
          return <div css={styles} />;
        }
      `;
      const { result, code } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const remote = { color: "red" } as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(code).not.toContain("_cx(styles)");
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).not.toContain('color: "red"');
    });

    it("merges expression className before provider-resolved css rule class", () => {
      const { result, code } = babelTransform(
        `
        import { button } from "./styles";

        const base = "base";

        function App() {
          return <div className={base} css={button} />;
        }
      `,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            button: { color: "red" }
          })
        }
      );

      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_cx\(base, _\$mincho\$\$App\d+\)\}/);
      expect(code).not.toMatch(
        /className=\{_cx\(_\$mincho\$\$App\d+, base\)\}/
      );
      expect(code).not.toContain("_cx(button)");
    });

    it("preserves provider reexport fallback for whole css values but rejects them inside static rules", () => {
      const provider = createUnsupportedReexportStaticCssEvalProvider();
      const wholeExpression = babelTransform(
        `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `,
        { jsxCssProp: true, staticCssEvalProvider: provider }
      );

      expect(wholeExpression.result[1]).toBe("");
      expect(wholeExpression.code).not.toContain(" css=");
      expect(wholeExpression.code).toContain("className={_cx(button)}");
      expect(wholeExpression.code).not.toContain("_css(button)");

      expect(() =>
        babelTransform(
          `
          import { button } from "./barrel";

          function App() {
            return <div css={{ color: button }} />;
          }
        `,
          { jsxCssProp: true, staticCssEvalProvider: provider }
        )
      ).toThrow(
        'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
      );
    });

    it("respects Babel scope when same-file const css prop bindings shadow", () => {
      const { result, code } = babelTransform(
        `
        const style = { color: "red" };

        function App() {
          const style = { color: "blue" };
          return <div css={style} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_$mincho$$App2}");
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).not.toContain('color: "red"');
    });

    it("preserves dynamic and mutable identifier css props as class values", () => {
      const { result, code } = babelTransform(
        `
        const className = getClassName();
        let style = { color: "red" };

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={className} />
            <div css={style} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(className)}");
      expect(code).toContain("className={_cx(style)}");
      expect(code).not.toContain("_css(className)");
      expect(code).not.toContain("_css(style)");
      expect(result[1]).not.toContain("_css(");
    });

    it("rejects mutated same-file const object jsx css prop bindings", () => {
      expect(() =>
        babelTransform(
          `
          const style = { color: "red" };
          style.color = "blue";

          function App() {
            return <div css={style} />;
          }
        `,
          { jsxCssProp: true }
        )
      ).toThrow(
        'Cannot statically evaluate css prop value: same-file binding "style" is mutated'
      );
    });

    it("lowers same-file const practical literal grammar like an inline object", () => {
      const inline = babelTransform(
        `
        function App() {
          return <div css={{
            color: "red",
            opacity: -1,
            zIndex: +2,
            enabled: true,
            empty: null,
            fallbacks: ["red", "blue"],
            selectors: {
              "&:hover": {
                color: "blue"
              }
            }
          }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const sameFileConst = babelTransform(
        `
        const style = {
          color: \`red\`,
          opacity: -1,
          zIndex: +2,
          enabled: true,
          empty: null,
          fallbacks: ["red", \`blue\`],
          selectors: {
            "&:hover": {
              color: \`blue\`
            }
          }
        };

        function App() {
          return <div css={style} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(sameFileConst.code).not.toContain(" css=");
      expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
      expect(sameFileConst.code).not.toContain("_cx(style)");
      expect(sameFileConst.result[1]).toBe(inline.result[1]);
      expect(sameFileConst.result[1]).toContain('color: "red"');
      expect(sameFileConst.result[1]).toContain("opacity: -1");
      expect(sameFileConst.result[1]).toContain("zIndex: 2");
    });

    it("normalizes direct inline object spreads and extracts static array spreads before jsx css prop classification", () => {
      const inlineObject = babelTransform(
        `
        function App() {
          return <div css={{ display: "flex", color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const spreadObject = babelTransform(
        `
        const base = { display: "flex", color: "red" } as const;

        function App() {
          return <div css={{ ...base, color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const spreadArray = babelTransform(
        `
        const stack = [{ display: "flex" }] as const;

        function App() {
          return <div css={[...stack, { gap: 8 }]} />;
        }
      `,
        { jsxCssProp: true }
      );
      const objectOutput = `${spreadObject.code}\n${spreadObject.result.join("\n")}`;

      expect(spreadObject.result[1]).toBe(inlineObject.result[1]);
      expect(spreadObject.code).not.toContain(" css=");
      expect(spreadObject.code).not.toContain("...base");
      expect(spreadObject.code).not.toContain("_cx(base)");
      expect(spreadArray.code).not.toContain(" css=");
      expect(spreadArray.code).not.toContain("...stack");
      expect(spreadArray.code).not.toContain("_cx(stack)");
      expect(spreadArray.code).not.toContain("unsupported-array-spread");
      expect(spreadArray.result[1]).toContain("_css([...stack,");
      expect(spreadArray.result[1]).toContain('display: "flex"');
      expect(spreadArray.result[1]).toContain("gap: 8");
      expect(objectOutput).not.toContain("...base");
      expect(spreadArray.result[1]).toContain("...stack");
    });

    it("normalizes direct inline provider imported operands with metadata", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const source = `
        import { base, stack, tokens } from "./styles";
        const isActive = true;

        function App() {
          return <>
            <div css={{ ...base, color: tokens.color, active: isActive }} />
            <div css={[...stack, { gap: 8 }]} />
          </>;
        }
      `;
      const { result, code, metadata } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `
                  export const base = { display: "flex", color: "red" } as const;
                  export const stack = [{ alignItems: "center" }] as const;
                  export const tokens = { color: "blue" } as const;
                `
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );
      const staticCssEvalMetadata = metadata.minchoStaticCssEval;
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(code).not.toContain("...stack");
      expect(code).not.toContain("_cx(base)");
      expect(code).not.toContain("_cx(stack)");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain("_css([{");
      expect(result[1]).toContain('display: "flex"');
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).toContain("active: isActive");
      expect(result[1]).toContain('alignItems: "center"');
      expect(result[1]).toContain("gap: 8");
      expect(output).not.toContain("...base");
      expect(output).not.toContain("...stack");
      expect(staticCssEvalMetadata?.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stylesFile,
            exportName: "base",
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: stylesFile,
            exportName: "tokens",
            memberPath: ["color"],
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: stylesFile,
            exportName: "stack",
            inspected: true,
            contributed: true
          })
        ])
      );
      expect(staticCssEvalMetadata?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedId: stylesFile,
            staticEvalSupportVersion: "static-css-module-export-graph:v4"
          })
        ])
      );
      expect(staticCssEvalMetadata?.resolvedModuleIds).toContain(stylesFile);
    });

    it("preserves inline fallback booleans without overriding spread precedence", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const source = `
        import { base, flags } from "./styles";
        const isActive = true;

        function App() {
          return <>
            <div css={{ ...base, active: isActive }} />
            <div css={{ active: isActive, ...base }} />
            <div css={{ nested: { active: isActive, ...base } }} />
            <div css={[...flags, isActive]} />
          </>;
        }
      `;
      const { result, code } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `
                  export const base = { display: "flex", active: false } as const;
                  export const flags = [false, false, { color: "red" }] as const;
                `
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );

      expect(result[1]).toContain("active: isActive");
      expect(result[1]).toContain("active: false");
      expect(result[1]).toMatch(
        /nested: \{\s+active: false,\s+display: "flex"\s+\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(false, false, _\$mincho\$\$App\d+, isActive\)\}/
      );
    });

    it("does not count shallow alias hops as object recursion depth", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const aliases = Array.from(
        { length: 50 },
        (_, index) => `const a${index + 1} = a${index};`
      ).join("\n");
      const source = `
        import { base } from "./styles";
        const a0 = { color: "red" };
        ${aliases}

        function App() {
          return <div css={{ ...base, nested: a50 }} />;
        }
      `;
      const { result } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: stylesFile,
                source: `export const base = { display: "flex" } as const;`
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "./styles",
                resolvedId: stylesFile
              }
            ]
          })
        },
        { filename: ownerFile }
      );

      expect(result[1]).toContain('color: "red"');
    });

    it("rejects over-depth direct inline provider operands", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const nestedRule = Array.from({ length: 51 }).reduce<string>(
        (value) => `{ nested: ${value} }`,
        '"leaf"'
      );
      const source = `
        import { base } from "./styles";

        function App() {
          return <div css={{ ...base, nested: ${nestedRule} }} />;
        }
      `;

      expect(() =>
        babelTransform(
          source,
          {
            jsxCssProp: true,
            staticCssEvalProvider: createImportedStaticCssEvalProvider({
              modules: [
                { id: ownerFile, source },
                {
                  id: stylesFile,
                  source: `export const base = { display: "flex" } as const;`
                }
              ],
              importResolutions: [
                {
                  importerId: ownerFile,
                  importPath: "./styles",
                  resolvedId: stylesFile
                }
              ]
            })
          },
          { filename: ownerFile }
        )
      ).toThrow("max object/array recursion depth exceeded");
    });

    it("rejects over-node-count direct inline provider operands", () => {
      const ownerFile = "/project/src/App.tsx";
      const stylesFile = "/project/src/styles.ts";
      const classValues = Array.from({ length: 10_000 }, () => "true").join(
        ", "
      );
      const source = `
        import { stack } from "./styles";

        function App() {
          return <div css={[...stack, ${classValues}]} />;
        }
      `;

      expect(() =>
        babelTransform(
          source,
          {
            jsxCssProp: true,
            staticCssEvalProvider: createImportedStaticCssEvalProvider({
              modules: [
                { id: ownerFile, source },
                {
                  id: stylesFile,
                  source: `export const stack = ["base"] as const;`
                }
              ],
              importResolutions: [
                {
                  importerId: ownerFile,
                  importPath: "./styles",
                  resolvedId: stylesFile
                }
              ]
            })
          },
          { filename: ownerFile }
        )
      ).toThrow("max static literal node count exceeded");
    });

    it("records package data and virtual provider metadata for direct inline operands", () => {
      const ownerFile = "/project/src/App.tsx";
      const packageBarrelFile = "pkg:@scope/styles";
      const packageDataFile = "data:@scope/styles/tokens";
      const virtualFile = "virtual:mincho-styles";
      const source = `
        import { base } from "@scope/styles";
        import virtualTokens from "virtual:mincho-styles";

        function App() {
          return <div css={{ ...base, accent: virtualTokens.accent }} />;
        }
      `;
      const { result, code, metadata } = babelTransform(
        source,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createImportedStaticCssEvalProvider({
            modules: [
              { id: ownerFile, source },
              {
                id: packageBarrelFile,
                source: `export { base } from "@scope/styles/tokens";`,
                sourceKind: "package-source",
                sourceOrigin: "package"
              },
              {
                id: packageDataFile,
                source: `export const base = { color: "green" } as const;`,
                sourceKind: "static-data",
                sourceOrigin: "data"
              },
              {
                id: virtualFile,
                source: `export default { accent: "purple" } as const;`,
                sourceKind: "provider-virtual",
                sourceOrigin: "provider"
              }
            ],
            importResolutions: [
              {
                importerId: ownerFile,
                importPath: "@scope/styles",
                resolvedId: packageBarrelFile,
                sourceKind: "package-source",
                sourceOrigin: "package"
              },
              {
                importerId: packageBarrelFile,
                importPath: "@scope/styles/tokens",
                resolvedId: packageDataFile,
                sourceKind: "static-data",
                sourceOrigin: "data"
              },
              {
                importerId: ownerFile,
                importPath: "virtual:mincho-styles",
                resolvedId: virtualFile,
                sourceKind: "provider-virtual",
                sourceOrigin: "provider"
              }
            ]
          })
        },
        { filename: ownerFile }
      );
      const staticCssEvalMetadata = metadata.minchoStaticCssEval;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("...base");
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('accent: "purple"');
      expect(staticCssEvalMetadata?.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: packageDataFile,
            sourceKind: "static-data",
            sourceOrigin: "data",
            contributed: true
          }),
          expect.objectContaining({
            file: virtualFile,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            contributed: true
          })
        ])
      );
      expect(staticCssEvalMetadata?.resolvedModuleIds).toEqual(
        expect.arrayContaining([packageDataFile, virtualFile])
      );
    });

    it("resolves same-file const object member path grammar", () => {
      const fixtures = [
        {
          expression: "styles.button.primary",
          inlineCss: `{ color: "blue" }`,
          expectedColor: 'color: "blue"'
        },
        {
          expression: 'styles["button"]',
          inlineCss: `{ color: "red", primary: { color: "blue" } }`,
          expectedColor: 'color: "red"'
        },
        {
          expression: 'styles["button"].primary',
          inlineCss: `{ color: "blue" }`,
          expectedColor: 'color: "blue"'
        }
      ] as const;

      for (const { expression, inlineCss, expectedColor } of fixtures) {
        const inline = babelTransform(
          `
          function App() {
            return <div css={${inlineCss}} />;
          }
        `,
          { jsxCssProp: true }
        );
        const sameFileConst = babelTransform(
          `
          const styles = {
            button: {
              color: "red",
              primary: { color: "blue" }
            }
          };

          function App() {
            return <div css={${expression}} />;
          }
        `,
          { jsxCssProp: true }
        );

        expect(sameFileConst.code).not.toContain(" css=");
        expect(sameFileConst.code).toContain("className={_$mincho$$App2}");
        expect(sameFileConst.code).not.toContain(`_cx(${expression})`);
        expect(sameFileConst.result[1]).toBe(inline.result[1]);
        expect(sameFileConst.result[1]).toContain(expectedColor);
      }
    });

    it("rejects unsupported same-file static css literal grammar deterministically", () => {
      const fixtures = [
        {
          setup: `const tokens = { primary: "red" }; const style = { color: \`\${tokens}\` };`,
          expression: "style",
          reason: "dynamic expression is unsupported"
        },
        {
          setup: `const styles = null;`,
          expression: "styles?.button",
          reason: "dynamic expression is unsupported"
        },
        {
          setup: `function getKey() { return "button"; } const styles = { button: { color: "red" } };`,
          expression: "styles[getKey()]",
          reason: "dynamic expression is unsupported"
        }
      ] as const;

      for (const { setup, expression, reason } of fixtures) {
        expect(() =>
          babelTransform(
            `
            ${setup}

            function App() {
              return <div css={${expression}} />;
            }
          `,
            { jsxCssProp: true }
          )
        ).toThrow("Cannot statically evaluate css prop value");
        expect(() =>
          babelTransform(
            `
            ${setup}

            function App() {
              return <div css={${expression}} />;
            }
          `,
            { jsxCssProp: true }
          )
        ).toThrow(reason);
      }
    });

    it("records dynamic expression types without weakening computed member errors", () => {
      const source = `
        function getRule() {
          return { color: "red" };
        }
        const styles = { button: getRule() };

        function App() {
          return <div css={styles["button"]} />;
        }
      `;

      expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
        "dynamic expression is unsupported: CallExpression"
      );

      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
      expect(
        failure.metadata.minchoStaticCssEval?.diagnostics.map(
          ({ expressionType }) => expressionType
        )
      ).toContain("CallExpression");
    });

    it("records static css eval metadata before unsupported css prop failures", () => {
      const source = `
        const styles = {
          button: { color: "red" }
        };

        function App(variant) {
          return <div css={styles[variant]} />;
        }
      `;

      expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
        "computed member access is unsupported"
      );

      const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
      const staticCssEvalMetadata = failure.metadata.minchoStaticCssEval;

      expect(failure.error.message).toContain(
        "computed member access is unsupported"
      );
      expect(staticCssEvalMetadata?.diagnostics.map(({ id }) => id)).toContain(
        "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      );
      expect(
        staticCssEvalMetadata?.diagnostics.map(({ reason }) => reason)
      ).toContain("dynamic-member-path");
      expect(failure.code).not.toContain('from "@mincho-js/css"');
      expect(failure.code).not.toContain("_css(");
      expect(failure.code).not.toContain("_cx(");
    });

    it("preserves class-value fallback when static css rule candidacy is unproven", () => {
      const { result, code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const key = "root";
        const styles = { root: "root" };
        let mutable = { button: { color: "red" } };

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={styles[key]} />
            <div css={styles?.root} />
            <div css={styles[0]} />
            <div css={mutable.button} />
            <div css={cx(getClassName())} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(styles[key])}");
      expect(code).toContain("className={_cx(styles?.root)}");
      expect(code).toContain("className={_cx(styles[0])}");
      expect(code).toContain("className={_cx(mutable.button)}");
      expect(code).toContain("className={_cx(cx(getClassName()))}");
      expect(result[1]).not.toContain("_css(");
    });

    it("preserves unresolved top-level css prop references as class values", () => {
      const { result, code } = babelTransform(
        `
        const className = "panel";

        function App() {
          return <>
            <div css={className} />
            <div css={unknownClassName} />
            <div css={externalStyles.button} />
          </>;
        }
      `,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({})
        }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(className)}");
      expect(code).toContain("className={_cx(unknownClassName)}");
      expect(code).toContain("className={_cx(externalStyles.button)}");
      expect(code).not.toContain("_css(className)");
      expect(result[1]).not.toContain("_css(");
    });

    it("lowers direct inline css rule calls and rejects functions through static eval diagnostics", () => {
      const callRule = babelTransform(
        `
        function getColor() {
          return "red";
        }

        function App() {
          return <div css={{ color: getColor() }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const functionFailure = captureJsxCssPropFailure(
        `
        function App() {
          return <div css={{ color: () => "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(callRule.code).not.toContain(" css=");
      expect(callRule.code).not.toContain("style=");
      expect(callRule.code).not.toContain("_css(");
      expect(callRule.result[1]).toContain("_css({");
      expect(callRule.result[1]).toContain("color: getColor()");
      expect(functionFailure.error.message).toContain(
        "dynamic expression is unsupported: ArrowFunctionExpression"
      );
      expect(
        functionFailure.metadata.minchoStaticCssEval?.diagnostics.map(
          ({ id }) => id
        )
      ).toContain("STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED");
      expect(
        functionFailure.metadata.minchoStaticCssEval?.diagnostics.map(
          ({ reason }) => reason
        )
      ).toContain("runtime-dynamic-value");
    });

    it("evaluates explicit cx class-value css prop calls once", () => {
      const source = `
        import { cx } from "@mincho-js/css";

        let callCount = 0;

        function getClassName() {
          callCount += 1;
          return "dynamic";
        }

        function App() {
          return <div css={cx(getClassName())} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        "return { props: App(), callCount };"
      ) as { props: Record<string, unknown>; callCount: number };

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(cx(getClassName()))}");
      expect(code).not.toContain("_css(getClassName())");
      expect(result[1]).not.toContain("_css(");
      expect(observed.callCount).toBe(1);
      expect(observed.props.className).toBe("dynamic");
      expect("css" in observed.props).toBe(false);
    });

    it("normalizes same-file static css rule member-expression object values", () => {
      const { result, code } = babelTransform(
        `
        const theme = { color: "red" };
        const style = { color: theme.color };

        function App() {
          return <div css={style} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_$mincho$$App2}");
      expect(code).not.toContain("_cx(style)");
      expect(result[1]).toContain('color: "red"');
    });

    it("keeps conditional const object css prop values in class-value mode", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;
        const style = condition ? { color: "red" } : {};

        function App() {
          return <div css={style} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(style)}");
      expect(code).not.toContain("_$mincho$$App");
      expect(result[1]).not.toContain("_css(");
      expect(result[1]).not.toContain('color: "red"');
    });

    it("merges string literal className before generated css rule class", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div className="base" css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx("base", _$mincho$$App2)}');
    });

    it("merges expression className before class-value css prop", () => {
      const { result, code } = babelTransform(
        `
        const base = "base";
        const styles = {
          root: "root"
        };

        function App() {
          return <div className={base} css={styles.root} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(base, styles.root)}");
      expect(code).not.toContain("_css(styles.root)");
    });

    it("merges expression className before conditional string css prop", () => {
      const { code } = babelTransform(
        `
        const base = "base";
        const condition = true;

        function App() {
          return <div className={base} css={condition ? "active" : "inactive"} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toMatch(
        /className=\{_cx\(base, condition \? "active" : "inactive"\)\}/
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(condition ?");
    });

    it("keeps conditional string css prop in class-value mode", () => {
      const { code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <div css={condition ? "active" : "inactive"} />;
        }
        `,
        { jsxCssProp: true }
      );

      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
      expect(code).not.toContain("_css(condition ?");
    });

    it("keeps intrinsic expression css props in class-value mode", () => {
      const { code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const condition = true;
        const flag = true;
        const providedClass = "provided";
        const maybeClass = null;

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={condition ? "active" : "inactive"} />
            <div css={flag && "active"} />
            <div css={providedClass || "fallback"} />
            <div css={maybeClass ?? "fallback"} />
            <div css={cx(getClassName())} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
      expect(code).toContain('className={_cx(flag && "active")}');
      expect(code).toContain('className={_cx(providedClass || "fallback")}');
      expect(code).toContain('className={_cx(maybeClass ?? "fallback")}');
      expect(code).toContain("className={_cx(cx(getClassName()))}");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("_css(condition");
      expect(code).not.toContain("_css(flag");
      expect(code).not.toContain("_css(providedClass");
      expect(code).not.toContain("_css(maybeClass");
      expect(code).not.toContain("_css(getClassName");
    });

    it("direct-emits string-literal class-value jsx css props", () => {
      const { result, code } = babelTransform(
        `
        const motion = { div: "div" };

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <>
            <div css="base" />
            <div css={"base"} />
            <div css="" />
            <div css=" " />
            <div css="base active" />
            <Button css="base" />
            <motion.div css="base" />
            <my-element css="base" />
          </>;
        }
      `,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            button: { color: "red" }
          })
        }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code.match(/<div className="base" \/>/g) ?? []).toHaveLength(2);
      expect(code).toContain('<div className="" />');
      expect(code).toContain('<div className=" " />');
      expect(code).toContain('<div className="base active" />');
      expect(code).toContain('<Button className="base" />');
      expect(code).toContain('<motion.div className="base" />');
      expect(code).toContain('<my-element className="base" />');
      expect(code).not.toContain("<my-element class=");
    });

    it("keeps non-string literal class-value jsx css props through cx", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <>
            <div css={1} />
            <div css={false} />
            <div css={null} />
            <div css={undefined} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(1)}");
      expect(code).toContain("className={_cx(false)}");
      expect(code).toContain("className={_cx(null)}");
      expect(code).toContain("className={_cx(undefined)}");
    });

    it("keeps mixed literal class-value jsx css props in direct and cx modes", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";

        function App() {
          return <>
            <div css="base" />
            <div css={styleA} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain('import { cx as _cx } from "@mincho-js/css"');
      expect(code).toContain('<div className="base" />');
      expect(code).toContain("<div className={_cx(styleA)} />");
      expect(code).not.toContain('_cx("base")');
    });

    it("lowers array literal jsx css prop through css rule mode", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div css={["base", { color: "red" }]} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(result[1]).toContain('_css(["base", {');
      expect(result[1]).toContain('color: "red"');
      expect(code).toContain("className={_$mincho$$App2}");
      expect(code).not.toContain("_cx([base");
    });

    it("classifies first-level primitive jsx css prop array branches", () => {
      const { result, code } = babelTransform(
        `
        const activeClass = "active-class";
        const styles = { active: "styles-active" };
        const condition = true;
        const providedClass = "";
        const maybeClass = null;
        const suffix = "suffix";

        function getClassName() {
          return "called";
        }

        function App() {
          return <>
            <div css={["base", "active"]} />
            <div css={["base", ""]} />
            <div css={["base", false]} />
            <div css={["base", true]} />
            <div css={["base", null]} />
            <div css={["base", undefined]} />
            <div css={["base", 0]} />
            <div css={["base", 1]} />
            <div css={["base", 0n]} />
            <div css={["base", 1n]} />
            <div css={["base", activeClass]} />
            <div css={["base", "", activeClass]} />
            <div css={["base", styles.active]} />
            <div css={["base", getClassName()]} />
            <div css={["base", \`active \${suffix}\`]} />
            <div css={["base", condition && "active"]} />
            <div css={["base", providedClass || "fallback"]} />
            <div css={["base", maybeClass ?? "fallback"]} />
            <div css={["base", condition ? "active" : "inactive"]} />
            <div className="external" css={["base", condition && "active"]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain('_cx(["base"');
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(2);
      expect(result[1]).toContain('_css(["base", "active"])');
      expect(result[1]).toContain('_css(["base", ""])');
      expect(result[1]).not.toContain("activeClass");
      expect(result[1]).not.toContain("getClassName");
      expect(result[1]).not.toContain("suffix");
      expect(code).toContain('className={_cx("base", false)}');
      expect(code).toContain('className={_cx("base", true)}');
      expect(code).toContain('className={_cx("base", null)}');
      expect(code).toContain('className={_cx("base", undefined)}');
      expect(code).toContain('className={_cx("base", 0)}');
      expect(code).toContain('className={_cx("base", 1)}');
      expect(code).toContain('className={_cx("base", 0n)}');
      expect(code).toContain('className={_cx("base", 1n)}');
      expect(code).toContain('className={_cx("base", activeClass)}');
      expect(code).toContain('className={_cx("base", "", activeClass)}');
      expect(code).toContain('className={_cx("base", styles.active)}');
      expect(code).toContain('className={_cx("base", getClassName())}');
      expect(code).toContain('className={_cx("base", `active ${suffix}`)}');
      expect(code).toContain('className={_cx("base", condition && "active")}');
      expect(code).toContain(
        'className={_cx("base", providedClass || "fallback")}'
      );
      expect(code).toContain(
        'className={_cx("base", maybeClass ?? "fallback")}'
      );
      expect(code).toContain(
        'className={_cx("base", condition ? "active" : "inactive")}'
      );
      expect(code).toContain(
        'className={_cx("external", "base", condition && "active")}'
      );
    });

    it("extracts first-level CSS-rule branch array branches through cx", () => {
      const { result, code } = babelTransform(
        `
        const activeClass = "active-class";
        const condition = true;
        const providedClass = "";
        const maybeClass = null;

        function App() {
          return <>
            <div css={["base", condition && { color: "red" }]} />
            <div css={["base", providedClass || { color: "red" }]} />
            <div css={["base", maybeClass ?? { color: "red" }]} />
            <div css={["base", providedClass || [{ color: "red" }]]} />
            <div css={["base", maybeClass ?? ["active", { color: "red" }]]} />
            <div css={["base", condition && [{ color: "red" }]]} />
            <div css={["base", condition && ["active", { color: "red" }]]} />
            <div css={["base", { color: "red" }, activeClass]} />
            <div css={["base", [{ color: "red" }], condition && "active"]} />
            <div css={["base", condition ? { color: "red" } : "inactive"]} />
            <div css={["base", condition ? [{ color: "red" }] : "inactive"]} />
            <div css={["base", condition ? "active" : { color: "blue" }]} />
            <div css={["base", condition ? "active" : ["fallback", { color: "blue" }]]} />
            <div css={["base", condition ? { color: "red" } : { color: "blue" }]} />
            <div css={["base", condition ? ["red", { color: "red" }] : ["blue", { color: "blue" }]]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const expectedClassNames = [
        /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/,
        /className=\{_cx\("base", providedClass \|\| _\$mincho\$\$App\d+\)\}/,
        /className=\{_cx\("base", maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
        /className=\{_cx\("base", _\$mincho\$\$App\d+, activeClass\)\}/,
        /className=\{_cx\("base", _\$mincho\$\$App\d+, condition && "active"\)\}/,
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : "inactive"\)\}/,
        /className=\{_cx\("base", condition \? "active" : _\$mincho\$\$App\d+\)\}/,
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      ] as const;

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain('color: "red"');
      expect(code).not.toContain('color: "blue"');
      expect(code).not.toContain("[{");
      expect(code).not.toContain('["active", {');
      expect(code).not.toContain('["fallback", {');
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(17);
      expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(8);
      expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(9);
      expect(result[1]).toContain('_css(["active", {');
      expect(result[1]).toContain('_css(["fallback", {');
      expect(result[1]).toContain('_css(["red", {');
      expect(result[1]).toContain('_css(["blue", {');

      for (const expectedClassName of expectedClassNames) {
        expect(code).toMatch(expectedClassName);
      }
    });

    it("supports first-level dynamic branches with static array CSS-rule units", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <>
            <div css={["base", condition && [{ color: "red" }]]} />
            <div css={["base", condition && ["active", { color: "red" }]]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(
        code.match(
          /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/g
        ) ?? []
      ).toHaveLength(2);
      expect(code).not.toContain("[{");
      expect(code).not.toContain('["active", {');
      expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(2);
      expect(result[1]).toContain("_css([{");
      expect(result[1]).toContain('_css(["active", {');
    });

    it("lowers nested dynamic css prop array literals", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;
        const nested = true;
        const props = {
          className: "spread-base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <>
            <div css={["base", ["nested", condition && { color: "red" }]]} />
            <div css={["base", condition && ["active", nested && { color: "red" }]]} />
            <div css={["base", condition ? ["active", { color: "red" }] : ["fallback", { color: "blue" }]]} />
            <div css={["base", ["nested", condition ? { color: "red" } : "inactive"]]} />
            <div className="base" css={["outer", ["nested", condition && { color: "red" }]]} />
          </>;
        }

        function SpreadApp() {
          return <div {...props} css={["outer", ["nested", condition && { color: "red" }]]} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /className=\{_cx\("base", _cx\("nested", condition && _\$mincho\$\$App\d+\)\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", condition && _cx\("active", nested && _\$mincho\$\$App\d+\)\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", _cx\("nested", condition \? _\$mincho\$\$App\d+ : "inactive"\)\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", "outer", _cx\("nested", condition && _\$mincho\$\$App\d+\)\)\}/
      );
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
      expect(code).toMatch(
        /className=\{_cx\(_minchoClassName, "outer", _cx\("nested", condition && _\$mincho\$\$(?:App|SpreadApp)\d+\)\)\}/
      );
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(7);
      expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(5);
      expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(2);
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(6);
      expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(1);
      expect(result[1]).toContain('_css(["active", {');
      expect(result[1]).toContain('_css(["fallback", {');
      expect(output).not.toContain("_css(condition &&");
      expect(output).not.toContain("_css(nested &&");
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain('["nested", condition && {');
      expect(output).not.toContain('["active", nested && {');
    });

    it("preserves direct CSS-rule array branch units", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <>
            <div css={["base", condition && ["active", { color: "red" }]]} />
            <div css={["base", condition ? ["active", { color: "red" }] : ["fallback", { color: "blue" }]]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).not.toContain('["active", {');
      expect(code).not.toContain('["fallback", {');
      expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(3);
      expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(0);
      expect(result[1]).toContain('_css(["active", {');
      expect(result[1]).toContain('_css(["fallback", {');
    });

    it("evaluates first-level array call branches once", () => {
      const observed = runJsxCssPropRuntime(
        `
        let callCount = 0;

        function getClassName() {
          callCount += 1;
          return "dynamic";
        }

        function App() {
          return <div css={["base", getClassName()]} />;
        }
      `,
        "return { props: App(), callCount };"
      ) as { props: Record<string, unknown>; callCount: number };

      expect(observed.callCount).toBe(1);
      expect(observed.props.className).toBe("base dynamic");
      expect("css" in observed.props).toBe(false);
    });

    it("lowers transparent wrapped direct jsx css prop rules through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={{ color: "red" }!} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }]!} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={{ color: "red" } as const} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }] as const} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={{ color: "red" } satisfies ComplexCSSRule} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={[{ color: "red" }] satisfies ComplexCSSRule} />`,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={({ color: "red" })} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={(["base", { color: "red" }])} />`,
          expectedRule: '_css(["base", {'
        }
      ] as const;

      for (const { fixture, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;
          const base = "base";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );

        expect(code).not.toContain(" css=");
        expect(code).toContain("className={_$mincho$$App2}");
        expect(code).not.toContain("_cx(");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers conditional object and array jsx css prop branches through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={condition ? { color: "red" } : { color: "blue" }} />`,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? [{ color: "red" }] : [{ color: "blue" }]} />`,
          expectedRule: "_css([{"
        }
      ] as const;

      for (const { fixture, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          const condition = true;

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(
          /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
        );
        expect(code).not.toContain("_cx(condition ?");
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
        expect(result[1]).toContain('color: "blue"');
      }
    });

    it("merges explicit className before pure conditional css rule branches", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;

        function App() {
          return <div className="base" css={condition ? { color: "red" } : { color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /className=\{_cx\("base", condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      );
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("css(condition ?");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
    });

    it("lowers mixed and nullable conditional jsx css prop branches through cx", () => {
      const fixtures = [
        {
          fixture: `<div css={condition ? styleA : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? styleA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? classNameA : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? classNameA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? { color: "red" } : null} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : null\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? { color: "red" } : false} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : false\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? null : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? null : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? false : { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition \? false : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ({ color: "red" } as const) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ({ color: "red" }!) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition ? ([{ color: "red" }] as const) : styleA} />`,
          expectedClassName:
            /className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition ? styleA : ({ color: "red" } satisfies ComplexCSSRule)} />`,
          expectedClassName:
            /className=\{_cx\(condition \? styleA : _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;
          const condition = true;
          const styleA = "style-a";
          const classNameA = "class-name-a";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(output).not.toContain("_css(styleA)");
        expect(output).not.toContain("_css(classNameA)");
        expect(output).not.toContain("css(styleA)");
        expect(output).not.toContain("css(classNameA)");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers recursive conditional jsx css prop branches", () => {
      const { result, code } = babelTransform(
        `
        type ComplexCSSRule = unknown;
        const outer = true;
        const inner = false;
        const styleA = "style-a";

        function App() {
          return <>
            <div css={outer ? inner ? { color: "red" } : { color: "blue" } : styleA} />
            <div css={outer ? styleA : inner ? { color: "red" } : { color: "blue" }} />
            <div css={outer ? inner ? [{ color: "red" }] : [{ color: "blue" }] : null} />
            <div css={outer ? inner ? ({ color: "red" } as const) : ([{ color: "blue" }]! satisfies ComplexCSSRule) : styleA} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code.match(/className=\{_cx\(/g) ?? []).toHaveLength(4);
      expect(
        code.match(
          /className=\{_cx\(outer \? inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+ : styleA\)\}/g
        ) ?? []
      ).toHaveLength(2);
      expect(code).toMatch(
        /className=\{_cx\(outer \? styleA : inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(outer \? inner \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+ : null\)\}/
      );
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(8);
      expect(result[1].match(/_css\(\{/g) ?? []).toHaveLength(5);
      expect(result[1].match(/_css\(\[/g) ?? []).toHaveLength(3);
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(4);
      expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(4);
      expect(output).not.toContain("_css(outer ?");
      expect(output).not.toContain("_css(inner ?");
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("_css(styleA)");
      expect(output).not.toContain("css(styleA)");
    });

    it("does not static-evaluate branch-internal conditional identifiers", () => {
      const { result, code, metadata } = babelTransform(
        `
        import { styles } from "./styles";

        const outer = true;
        const palette = { card: "card-class" };

        function makeRule(color: string) {
          return { color };
        }

        const ruleFactory = {
          card(color: string) {
            return { color };
          }
        };

        function App() {
          return <>
            <div css={outer ? styles.red : { color: "blue" }} />
            <div css={({ color: "red" }) ? { color: "green" } : styles.red} />
            <div css={outer ? palette.card : { color: "purple" }} />
            <div css={outer ? makeRule("red") : { color: "orange" }} />
            <div css={outer ? ruleFactory.card("green") : styles.red} />
          </>;
        }
      `,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            "styles.red": { color: "red" }
          })
        }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /className=\{_cx\(outer \? styles\.red : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(\{\s+color: "red"\s+\} \? _\$mincho\$\$App\d+ : styles\.red\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(outer \? palette\.card : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{outer \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(outer \? _\$mincho\$\$App\d+ : styles\.red\)\}/
      );
      expect(output).not.toContain("_css(styles.red)");
      expect(output).not.toContain("css(styles.red)");
      expect(metadata.minchoStaticCssEval?.dependencies ?? []).toEqual([]);
      expect(metadata.minchoStaticCssEval?.resolvedModuleIds ?? []).toEqual([]);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
      expect(result[1]).toContain('_css(makeRule("red"))');
      expect(result[1]).toContain('_css(ruleFactory.card("green"))');
      expect(result[1]).not.toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('color: "purple"');
      expect(result[1]).toContain('color: "orange"');
    });

    it("lowers logical and jsx css prop branches through css rule mode", () => {
      const fixtures = [
        {
          fixture: `<div css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={condition && [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition && ([{ color: "red" }] as const)} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={condition && ({ color: "red" } as const)} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div className="base" css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div {...props} css={condition && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(_minchoClassName, condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          const props = { className: "base" };

          function App(condition: boolean) {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition &&");
        expect(output).not.toContain("css(condition &&");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("lowers logical OR and nullish right-side css rule fallbacks", () => {
      const fixtures = [
        {
          fixture: `<div css={providedClass || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={providedClass || [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={maybeClass ?? { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={maybeClass ?? [{ color: "red" }]} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        },
        {
          fixture: `<div css={providedClass || ({ color: "red" } as const)} />`,
          expectedClassName:
            /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({"
        },
        {
          fixture: `<div css={maybeClass ?? ([{ color: "red" }] satisfies ComplexCSSRule)} />`,
          expectedClassName:
            /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css([{"
        }
      ] as const;

      for (const { fixture, expectedClassName, expectedRule } of fixtures) {
        const { result, code } = babelTransform(
          `
          type ComplexCSSRule = unknown;

          function App(providedClass: string, maybeClass: string | null) {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(code).not.toMatch(/_cx\((providedClass|maybeClass), _\$mincho/);
        expect(output).not.toContain("_css(providedClass");
        expect(output).not.toContain("_css(maybeClass");
        expect(output).not.toContain("css(providedClass");
        expect(output).not.toContain("css(maybeClass");
        expect(result[1]).toContain(expectedRule);
        expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
      }
    });

    it("lowers recursive logical jsx css prop branches", () => {
      const fixtures = [
        {
          fixture: `<div css={condition && flag && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(condition && flag && _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={(condition && flag) || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(\(?condition && flag\)? \|\| _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={a || b || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(a \|\| b \|\| _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={a ?? b ?? { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\(a \?\? b \?\? _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={condition && (flag ? { color: "red" } : { color: "blue" })} />`,
          expectedClassName:
            /className=\{_cx\(condition && \(flag \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\)\}/,
          expectedColors: ["red", "blue"]
        },
        {
          fixture: `<div css={condition && (flag && { color: "red" })} />`,
          expectedClassName:
            /className=\{_cx\(condition && \(?flag && _\$mincho\$\$App\d+\)?\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={outer ? condition && { color: "red" } : styleA} />`,
          expectedClassName:
            /className=\{_cx\(outer \? condition && _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div css={{ color: "red" } && (condition && { color: "blue" })} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["blue"],
          forbiddenColors: ["red"]
        },
        {
          fixture: `<div className="base" css={condition && flag && { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", condition && flag && _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div className="base" css={(condition && flag) || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", \(?condition && flag\)? \|\| _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div className="base" css={a || b || { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", a \|\| b \|\| _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div className="base" css={a ?? b ?? { color: "red" }} />`,
          expectedClassName:
            /className=\{_cx\("base", a \?\? b \?\? _\$mincho\$\$App\d+\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div className="base" css={condition && (flag ? { color: "red" } : { color: "blue" })} />`,
          expectedClassName:
            /className=\{_cx\("base", condition && \(flag \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\)\)\}/,
          expectedColors: ["red", "blue"]
        },
        {
          fixture: `<div className="base" css={condition && (flag && { color: "red" })} />`,
          expectedClassName:
            /className=\{_cx\("base", condition && \(?flag && _\$mincho\$\$App\d+\)?\)\}/,
          expectedColors: ["red"]
        },
        {
          fixture: `<div className="base" css={outer ? condition && { color: "red" } : styleA} />`,
          expectedClassName:
            /className=\{_cx\("base", outer \? condition && _\$mincho\$\$App\d+ : styleA\)\}/,
          expectedColors: ["red"]
        }
      ] as const;

      for (const fixtureCase of fixtures) {
        const { fixture, expectedClassName, expectedColors } = fixtureCase;
        const forbiddenColors =
          "forbiddenColors" in fixtureCase ? fixtureCase.forbiddenColors : [];
        const { result, code } = babelTransform(
          `
          const styleA = "style-a";

          function App(
            condition: boolean,
            flag: boolean,
            outer: boolean,
            a: string | null,
            b: string | null
          ) {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(result[1].match(/_css\(/g) ?? []).toHaveLength(
          expectedColors.length
        );
        for (const color of expectedColors) {
          expect(result[1]).toContain(`color: "${color}"`);
        }
        for (const color of forbiddenColors ?? []) {
          expect(result[1]).not.toContain(`color: "${color}"`);
        }
        expect(code).not.toMatch(/_cx\(condition && flag, _\$mincho/);
        expect(code).not.toMatch(/_cx\(a \|\| b, _\$mincho/);
        expect(code).not.toMatch(/_cx\(a \?\? b, _\$mincho/);
        expect(output).not.toContain("_css(condition &&");
        expect(output).not.toContain("_css(condition ||");
        expect(output).not.toContain("_css(condition ??");
        expect(output).not.toContain("_css(a ||");
        expect(output).not.toContain("_css(a ??");
        expect(output).not.toContain("_css(condition ?");
      }
    });

    it("preserves recursive logical css prop call counts", () => {
      const observed = runJsxCssPropRuntime(
        `
        let conditionCalls = 0;
        let flagCalls = 0;
        let aCalls = 0;
        let bCalls = 0;

        function getCondition() {
          conditionCalls += 1;
          return true;
        }

        function getFlag() {
          flagCalls += 1;
          return true;
        }

        function getA() {
          aCalls += 1;
          return "";
        }

        function getB() {
          bCalls += 1;
          return "";
        }

        function App() {
          const andProps = <div css={getCondition() && getFlag() && { color: "red" }} />;
          const orProps = <div css={(getA() || getB()) || { color: "blue" }} />;
          return { andProps, orProps };
        }
      `,
        "return { result: App(), conditionCalls, flagCalls, aCalls, bCalls };"
      );

      expect(observed).toEqual({
        result: {
          andProps: { className: "css-rule" },
          orProps: { className: "css-rule" }
        },
        conditionCalls: 1,
        flagCalls: 1,
        aCalls: 1,
        bCalls: 1
      });
    });

    it("simplifies static-left logical OR and nullish css rule operands", () => {
      const fixtures = [
        {
          fixture: `<div css={{ color: "red" } || providedClass} />`,
          expectedRule: "_css({",
          forbiddenValues: ["providedClass", 'color: "blue"']
        },
        {
          fixture: `<div css={[{ color: "red" }] || providedClass} />`,
          expectedRule: "_css([{",
          forbiddenValues: ["providedClass", 'color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } ?? maybeClass} />`,
          expectedRule: "_css({",
          forbiddenValues: ["maybeClass", 'color: "blue"']
        },
        {
          fixture: `<div css={[{ color: "red" }] ?? maybeClass} />`,
          expectedRule: "_css([{",
          forbiddenValues: ["maybeClass", 'color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } || { color: "blue" }} />`,
          expectedRule: "_css({",
          forbiddenValues: ['color: "blue"']
        },
        {
          fixture: `<div css={{ color: "red" } ?? { color: "blue" }} />`,
          expectedRule: "_css({",
          forbiddenValues: ['color: "blue"']
        }
      ] as const;

      for (const { fixture, expectedRule, forbiddenValues } of fixtures) {
        const { result, code } = babelTransform(
          `
          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
        expect(code).not.toMatch(/className=\{_cx\(_\$mincho\$\$App\d+\)\}/);
        expect(code).not.toContain("_cx(");
        expect(result[1]).toContain(expectedRule);
        expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);

        for (const forbiddenValue of forbiddenValues) {
          expect(output).not.toContain(forbiddenValue);
        }
      }
    });

    it("treats static-left logical AND css rule operands as truthy guards", () => {
      const fixtures = [
        `<div css={{ color: "red" } && providedClass} />`,
        `<div css={[{ color: "red" }] && providedClass} />`,
        `<div css={({ color: "red" } as const) && providedClass} />`
      ] as const;

      for (const fixture of fixtures) {
        const { result, code } = babelTransform(
          `
          const providedClass = "provided";

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(/className=\{_cx\(providedClass\)\}/);
        expect(result[1]).not.toContain("_css(");
        expect(output).not.toContain('color: "red"');
      }
    });

    it("extracts only the right css rule for both-side static logical AND", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div css={{ color: "red" } && { color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(code).not.toMatch(/className=\{_cx\(_\$mincho\$\$App\d+\)\}/);
      expect(code).not.toContain("_cx(");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "blue"/g) ?? []).toHaveLength(1);
      expect(output).not.toContain('color: "red"');
    });

    it("merges explicit className before generated-only static logical css rule", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <div className="base" css={{ color: "red" } || providedClass} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_cx\("base", _\$mincho\$\$App\d+\)\}/);
      expect(output).not.toContain("providedClass");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
    });

    it("aggregates spread props before generated-only static logical css rule", () => {
      const { result, code } = babelTransform(
        `
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={{ color: "red" } || providedClass} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
      expect(code).toMatch(
        /className=\{_cx\(_minchoClassName, _\$mincho\$\$App\d+\)\}/
      );
      expect(output).not.toContain("providedClass");
      expect(result[1]).toContain("_css({");
      expect(result[1].match(/color: "red"/g) ?? []).toHaveLength(1);
    });

    it("omits cx import for generated-only static logical css rules", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <>
            <div css={{ color: "red" } || providedClass} />
            <div css={[{ color: "green" }] ?? maybeClass} />
            <div css={{ color: "blue" } && { color: "purple" }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;
      const generatedClassNames = code.match(
        /className=\{_\$mincho\$\$App\d+\}/g
      );

      expect(code).not.toContain(" css=");
      expect(generatedClassNames ?? []).toHaveLength(3);
      expect(code).not.toContain("_cx(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('color: "purple"');
      expect(output).not.toContain('color: "blue"');
      expect(output).not.toContain("providedClass");
      expect(output).not.toContain("maybeClass");
    });

    it("preserves static-left logical css branch runtime side effects", () => {
      const observed = runJsxCssPropRuntime(
        `
        let fallbackCalls = 0;
        let providedCalls = 0;

        import { cx } from "@mincho-js/css";

        function getFallback() {
          fallbackCalls += 1;
          return "fallback";
        }

        function getProvided() {
          providedCalls += 1;
          return "provided";
        }

        function App() {
          const orProps = <div css={{ color: "red" } || getFallback()} />;
          const nullishProps = <div css={[{ color: "green" }] ?? getFallback()} />;
          const andProps = <div css={{ color: "blue" } && cx(getProvided())} />;
          return { orProps, nullishProps, andProps };
        }
      `,
        "return { result: App(), fallbackCalls, providedCalls };"
      ) as {
        result: {
          orProps: Record<string, unknown>;
          nullishProps: Record<string, unknown>;
          andProps: Record<string, unknown>;
        };
        fallbackCalls: number;
        providedCalls: number;
      };

      expect(observed.fallbackCalls).toBe(0);
      expect(observed.providedCalls).toBe(1);
      expect(observed.result.orProps.className).toBe("css-rule");
      expect(observed.result.nullishProps.className).toBe("css-rule");
      expect(observed.result.andProps.className).toBe("provided");
    });

    it("lowers top-level call factory and mixin jsx css prop rules through extraction", () => {
      const { result, code } = babelTransform(
        `
        function makeRule(color: string) {
          return { color };
        }

        function getClassName() {
          return { color: "green" };
        }

        const rules = {
          card(variant: string) {
            return { color: variant };
          }
        };

        function App() {
          return <>
            <div css={makeRule("red")} />
            <div css={getClassName()} />
            <div css={rules.card("primary")} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("_cx(makeRule");
      expect(code).not.toContain("_cx(getClassName");
      expect(code).not.toContain("_cx(rules.card");
      expect(
        code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []
      ).toHaveLength(3);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(3);
      expect(result[1]).toContain("function makeRule");
      expect(result[1]).toContain("function getClassName");
      expect(result[1]).toContain("const rules");
      expect(result[1]).toContain('_css(makeRule("red"))');
      expect(result[1]).toContain("_css(getClassName())");
      expect(result[1]).toContain('_css(rules.card("primary"))');
    });

    it("emits parseable sidecar output without duplicate local factory declarations", () => {
      const { result } = babelTransform(
        `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={makeRule("green")} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(() =>
        transformSync(result[1], {
          presets: ["@babel/preset-typescript"],
          filename: "generated.css.ts"
        })
      ).not.toThrow();
      expect(result[1].match(/function makeRule/g) ?? []).toHaveLength(1);
    });

    it("emits parseable sidecar output with sibling factories using one root dedupe", () => {
      const { result } = babelTransform(
        `
        const makeColor = (color: string) => ({ color }),
          makeBackground = (background: string) => ({ background });

        function App() {
          return <>
            <div css={makeColor("green")} />
            <div css={makeBackground("black")} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(() =>
        transformSync(result[1], {
          presets: ["@babel/preset-typescript"],
          filename: "generated.css.ts"
        })
      ).not.toThrow();
      expect(result[1].match(/const makeColor/g) ?? []).toHaveLength(1);
      expect(result[1]).toContain('_css(makeColor("green"))');
      expect(result[1]).toContain('_css(makeBackground("black"))');
    });

    it("routes hoistable build-time css prop shapes through sidecar mode", () => {
      const { result, code } = babelTransform(
        `
        const base = { padding: 4 };

        function getBase() {
          return base;
        }

        function getKey() {
          return "color";
        }

        function getStack() {
          return [{ display: "grid" }];
        }

        function makeColor() {
          return "teal";
        }

        function makeRule(color: string) {
          return { color };
        }

        function App(condition: boolean) {
          return <>
            <div css={{ ...getBase(), color: "red" }} />
            <div css={[...getStack(), { gap: 8 }]} />
            <div css={{ [getKey()]: "blue" }} />
            <div css={{ color: makeColor() }} />
            <div css={makeRule("green")} />
            <div css={condition ? makeRule("purple") : { color: "orange" }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("style=");
      expect(
        code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []
      ).toHaveLength(5);
      expect(code).toMatch(
        /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
      );
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(7);
      expect(result[1]).toMatch(
        /_css\(\{\s+\.\.\.getBase\(\),\s+color: "red"\s+\}\)/
      );
      expect(result[1]).toMatch(
        /_css\(\[\s*\.\.\.getStack\(\),\s+\{\s+gap: 8\s+\}\s*\]\)/
      );
      expect(result[1]).toMatch(/_css\(\{\s+\[getKey\(\)\]: "blue"\s+\}\)/);
      expect(result[1]).toMatch(/_css\(\{\s+color: makeColor\(\)\s+\}\)/);
      expect(result[1]).toContain('_css(makeRule("green"))');
      expect(result[1]).toContain('_css(makeRule("purple"))');
      expect(output).not.toContain("padding: 4, color");
    });

    it("keeps nested rule returns with branch locals and stable globals on the sidecar path", () => {
      const { result, code } = babelTransform(
        `
        function makeRule(condition: boolean) {
          if (condition) {
            const color = String(Math.max(1, 2));
            return { color };
          }
          return "fallback";
        }

        function App() {
          return <div css={makeRule(true)} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(result[1]).toContain("_css(makeRule(true))");
    });

    it("rejects unresolved browser globals from sidecar evaluation", () => {
      const failure = captureJsxCssPropFailure(
        `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={makeRule(window.location.href)} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(failure.error.message).toContain(
        "call expressions are not evaluated by Babel"
      );
      expect(failure.code).not.toContain("_css(makeRule(");
    });

    it("locks hoistable static array spread on the extracted css path", () => {
      const { result, code } = babelTransform(
        `
        const base = [{ display: "grid" }];
        const extra = { gap: 8 };

        function App() {
          return <div css={[...base, extra]} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(
        /import\s+\{\s*_\$mincho\$\$App\d*(?:\s+as\s+_\$mincho\$\$App\d+)?\s*\}\s+from "(?:\.\/)?extracted_[^"]+\.css\.ts";/
      );
      expect(code).toMatch(/className=\{_\$mincho\$\$App\d+\}/);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(1);
      expect(result[1]).toContain("const base");
      expect(result[1]).toContain("const extra");
      expect(result[1]).toMatch(
        /export var _\$mincho\$\$App\d* = _css\(\[\s*\.\.\.base,\s+extra\s*\]\);/
      );
    });

    it("routes sidecar-safe partial-reduced factories, computed keys, and object spreads", () => {
      const { result, code } = babelTransform(
        `
          const baseRule = getBase();
          const computedRule = { [getKey()]: "blue" };
          const moduleRule = makeRule("green");
          const spreadRule = { ...getBase(), color: "red" };

          function getBase() {
            return { padding: 4 };
          }

          function getKey() {
            return "color";
          }

          function makeRule(color: string) {
            return { color };
          }

          function App(condition: boolean) {
            const branchRule = condition ? makeRule("purple") : { color: "orange" };

            return <>
              <div css={baseRule} />
              <div css={computedRule} />
              <div css={moduleRule} />
              <div css={spreadRule} />
              <div css={branchRule} />
            </>;
          }
        `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("style=");
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
      expect(result[1]).toContain("_css(getBase())");
      expect(result[1]).toMatch(/_css\(\{\s+\[getKey\(\)\]: "blue"\s+\}\)/);
      expect(result[1]).toContain('_css(makeRule("green"))');
      expect(result[1]).toMatch(
        /_css\(\{\s+\.\.\.getBase\(\),\s+color: "red"\s+\}\)/
      );
      expect(result[1]).toContain('_css(makeRule("purple"))');
      expect(result[1]).toContain('color: "orange"');
    });

    it("rejects sidecar candidate css props with render-scope declaration leaves", () => {
      const failure = captureJsxCssPropFailure(
        `
        const base = { padding: 4 };

        function getBase() {
          return base;
        }

        function App(props: { color: string }) {
          return <div css={{ ...getBase(), color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(failure.error.message).toMatch(staticShapeDiagnosticPattern);
      expect(failure.error.message).toMatch(reactStyleGuidancePattern);
      expect(failure.code).not.toContain("_css(");
      expect(failure.code).not.toContain("style={{");
    });

    it("lowers computed optional and template jsx css prop static rules", () => {
      const { result, code } = babelTransform(
        `
        const buttonKey = "button";
        const colorKey = "color";
        const brand = "red";
        const styles = {
          button: { color: "blue" }
        } as const;

        function App() {
          return <>
            <div css={styles["button"]} />
            <div css={styles[buttonKey]} />
            <div css={styles?.button} />
            <div css={styles?.[buttonKey]} />
            <div css={{ ["color"]: "red" }} />
            <div css={{ [colorKey]: \`\${brand}\` }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(
        code.match(/className=\{_\$mincho\$\$App\d+\}/g) ?? []
      ).toHaveLength(6);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).not.toContain("[colorKey]");
      expect(result[1]).not.toContain("`${brand}`");
    });

    describe("css prop partial evaluator red baseline", () => {
      type PartialEvalTransformOutcome =
        | {
            readonly kind: "ok";
            readonly transform: ReturnType<typeof babelTransform>;
          }
        | { readonly kind: "error"; readonly message: string };

      function tryPartialEvalTransform(
        source: string
      ): PartialEvalTransformOutcome {
        try {
          return {
            kind: "ok",
            transform: babelTransform(source, { jsxCssProp: true })
          };
        } catch (error) {
          return {
            kind: "error",
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }

      function expectPartialEvalTransformOk(
        label: string,
        source: string
      ): ReturnType<typeof babelTransform> {
        const outcome = tryPartialEvalTransform(source);

        if (outcome.kind === "error") {
          expect(outcome.message, label).not.toContain("BABEL_EXECUTED_");
        }

        expect(
          outcome.kind,
          outcome.kind === "error"
            ? `${label}: ${outcome.message.split("\n")[0]}`
            : label
        ).toBe("ok");

        if (outcome.kind === "error") {
          throw new Error(`${label}: expected transform success`);
        }

        return outcome.transform;
      }

      it("routes static computed key runtime leaf through css prop partial evaluator dynamic-leaf mode", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "static computed key dynamic leaf",
          `
          const keys = { foreground: "color" } as const;
          const colorKey = keys.foreground;

          function App(props: { color: string }) {
            return <div css={{ [colorKey]: props.color }} />;
          }
        `
        );

        expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
        expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
        expect(code).not.toContain(" css=");
        expect(code).not.toContain("_css(");
        expect(code).toMatch(
          /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
        );
      });

      it("normalizes same-file const object spreads, static computed keys, and shorthand on the extraction path", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "same-file const object spread static normalization",
          `
          const color = "gold";
          const display = "grid";
          const colorKey = "color";
          const numericKey = 1;
          const base = { color: "red", margin: 1 } as const;
          const override = { color: "blue", [numericKey]: "one" } as const;

          function App() {
            return <div css={{ ...base, [colorKey]: "green", ...override, color, display }} />;
          }
        `
        );

        expect(code).not.toContain(" css=");
        expect(code).not.toContain("...base");
        expect(code).not.toContain("...override");
        expect(code).not.toContain("[colorKey]");
        expect(result[1]).toContain("margin: 1");
        expect(result[1]).toContain('"1": "one"');
        expect(result[1]).toContain('color: "gold"');
        expect(result[1]).toContain('display: "grid"');
        expect(result[1]).not.toMatch(/color: "(?:red|blue|green)"/);
      });

      it("normalizes object spread override order and shorthand before dynamic-leaf lowering", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "same-file object spread last-wins dynamic leaf",
          `
          const colorKey = "color";
          const opacity = 1;
          const base = { color: "red", display: "grid" } as const;
          const override = { color: "blue", gap: 4 } as const;

          function App(props: { color: string; margin: number }) {
            return <div css={{ color: "green", ...base, ...override, [colorKey]: props.color, opacity, margin: props.margin }} />;
          }
        `
        );

        expect(result[1]).toContain('display: "grid"');
        expect(result[1]).toContain("gap: 4");
        expect(result[1]).toContain("opacity: 1");
        expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
        expect(result[1]).toMatch(/margin: _\$mincho\$\$App\w*MarginVar/);
        expect(result[1]).not.toMatch(/color: "(?:red|blue|green)"/);
        expect(code).not.toContain(" css=");
        expect(code).not.toContain("...base");
        expect(code).not.toContain("...override");
        expect(code).not.toContain("[colorKey]");
        expect(code).not.toContain("_css(");
        expect(code).toContain("_vx(props.color)");
        expect(code).toContain("_vx(props.margin)");
      });

      it("routes static object spreads through css prop partial evaluator dynamic-leaf mode", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "static object spread dynamic leaf",
          `
          const base = { display: "grid" } as const;

          function App(props: { color: string }) {
            return <div css={{ ...base, color: props.color }} />;
          }
        `
        );

        expect(result[1]).toContain('display: "grid"');
        expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
        expect(code).not.toContain(" css=");
        expect(code).not.toContain("...base");
        expect(code).not.toContain("style={{ color: props.color }}");
        expect(code).toMatch(
          /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
        );
      });

      it("routes static spread before static key through dynamic-leaf mode", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "static object spread before computed key dynamic leaf",
          `
          const base = { display: "grid" } as const;
          const keys = { foreground: "color" } as const;

          function App(props: { color: string }) {
            return <div css={{ ...base, [keys.foreground]: props.color }} />;
          }
        `
        );

        expect(result[1]).toContain('display: "grid"');
        expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
        expect(code).not.toContain(" css=");
        expect(code).not.toContain("...base");
        expect(code).not.toContain("[keys.foreground]");
        expect(code).not.toContain("style={{ color: props.color }}");
        expect(code).toMatch(
          /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
        );
      });

      it("routes same-file member paths, sidecar-safe whole-rule calls, and class-value fallback in the css prop partial evaluator matrix", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "same-file member sidecar class-value matrix",
          `
          const activeClass = "active";
          const styles = {
            button: { color: "red" }
          } as const;

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <>
              <div css={styles.button} />
              <div css={makeRule("blue")} />
              <div css={activeClass} />
            </>;
          }
        `
        );

        expect(code).not.toContain(" css=");
        expect(code).toContain("className={_cx(activeClass)}");
        expect(code).not.toContain("_cx(styles.button)");
        expect(result[1]).toContain('color: "red"');
        expect(result[1]).toContain('_css(makeRule("blue"))');
        expect(result[1]).not.toContain("activeClass");
      });

      it("preserves jsx css prop className dynamic CSS variable sidecar and spread aggregation router outputs", () => {
        const { result, code } = expectPartialEvalTransformOk(
          "router supported mode matrix",
          `
          const props = { className: "spread-base", css: "leaked", id: "root" };
          const activeClass = "active";
          const styles = { button: { color: "red" } } as const;

          function makeRule(color: string) {
            return { color };
          }

          function App(propsInput: { color: string }) {
            return <>
              <div css={styles.button} />
              <div css={makeRule("blue")} />
              <div css={{ color: propsInput.color }} />
              <div css={activeClass} />
              <div {...props} css={{ display: "grid" }} />
            </>;
          }
        `
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).not.toContain("_css(");
        expect(code).toContain("className={_cx(activeClass)}");
        expect(code).toContain("css: _minchoCssProp");
        expect(code).toMatch(
          /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(propsInput\.color\)\s+\}\}/
        );
        expect(result[1]).toContain('color: "red"');
        expect(result[1]).toContain('_css(makeRule("blue"))');
        expect(result[1]).toContain('display: "grid"');
        expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
        expect(output).not.toContain("_css(activeClass)");
        expect(output).not.toContain("propsInput.color }}");
      });

      it("keeps mutated bindings, runtime keys, runtime spreads, and props member calls unsupported in the css prop partial evaluator matrix", () => {
        const fixtures = [
          {
            label: "mutated binding",
            source: `
            const style = { color: "red" };
            style.color = "blue";

            function App() {
              return <div css={style} />;
            }
          `,
            expected:
              'Cannot statically evaluate css prop value: same-file binding "style" is mutated'
          },
          {
            label: "runtime key",
            source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `,
            expected:
              "Cannot statically evaluate css prop value: computed member access is unsupported"
          },
          {
            label: "runtime computed key dynamic value",
            source: `
            function App(props: { key: string; value: string }) {
              return <div css={{ [props.key]: props.value }} />;
            }
          `,
            expected:
              "Cannot statically evaluate css prop value: computed member access is unsupported"
          },
          {
            label: "runtime spread",
            source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `,
            expected:
              "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`."
          },
          {
            label: "props member call",
            source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `,
            expected:
              "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
          }
        ] as const;

        for (const { label, source, expected } of fixtures) {
          const failure = captureJsxCssPropFailure(source, {
            jsxCssProp: true
          });

          expect(failure.error.message.split("\n")[0], label).toBe(expected);
          expect(failure.code, label).not.toContain("_css(");
          expect(failure.code, label).not.toContain("style={{");
        }
      });

      it("keeps partial-reduced props member call aliases unsupported sidecar", () => {
        const fixtures = [
          {
            label: "aliased props member call",
            expected:
              "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
            source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              const rule = props.makeRule();

              return <div css={rule} />;
            }
          `
          },
          {
            label: "aliased props computed key",
            expected:
              "Cannot statically evaluate css prop value: computed member access is unsupported",
            source: `
            function App(props: { key: string }) {
              const rule = { [props.key]: "red" };

              return <div css={rule} />;
            }
          `
          },
          {
            label: "aliased props object spread",
            expected: "Mincho `css` requires statically known CSS shape",
            source: `
            function App(props: { styles: Record<string, string> }) {
              const rule = { ...props.styles, color: "red" };

              return <div css={rule} />;
            }
          `
          }
        ] as const;

        for (const { label, source, expected } of fixtures) {
          const failure = captureJsxCssPropFailure(source, {
            jsxCssProp: true
          });

          expect(failure.error.message.split("\n")[0], label).toBe(expected);
          expect(failure.code, label).not.toContain("_css(");
          expect(failure.code, label).not.toContain("style={{");
        }
      });

      it("keeps sidecar no execution for throwing factory and getter css prop fixtures", () => {
        const outcome = tryPartialEvalTransform(`
          const colorKey = "color";

          function throwingRule() {
            throw new Error("BABEL_EXECUTED_FUNCTION");
          }

          const throwingGetter = {
            get color() {
              throw new Error("BABEL_EXECUTED_GETTER");
            }
          };

          class ThrowingClass {
            constructor() {
              throw new Error("BABEL_EXECUTED_CLASS");
            }
          }

          function App(props: { color: string }) {
            return <>
              <div css={{ [colorKey]: props.color, background: throwingGetter.color }} />
              <div css={throwingRule()} />
              <div css={ThrowingClass} />
            </>;
          }
        `);

        if (outcome.kind === "error") {
          expect(outcome.message).not.toContain("BABEL_EXECUTED_");
          expect(outcome.message).toMatch(
            /Cannot statically evaluate|Mincho JSX css prop/
          );
        }

        expect(
          outcome.kind,
          outcome.kind === "error"
            ? `no-execution failure stayed in Mincho diagnostics: ${outcome.message.split("\n")[0]}`
            : "transform succeeded"
        ).toBe("ok");

        if (outcome.kind === "error") {
          return;
        }

        const { result, code } = outcome.transform;

        expect(code).not.toContain(" css=");
        expect(code).not.toContain("_css(");
        expect(code).toContain("props.color");
        expect(code).toContain("throwingGetter.color");
        expect(code).toContain("className={_cx(ThrowingClass)}");
        expect(result[1]).toContain("_css(throwingRule())");
      });
    });

    it("lowers first-level call branch jsx css prop rules through extraction", () => {
      const { result, code } = babelTransform(
        `
        function makeRule(color: string) {
          return { color };
        }

        function App(
          condition: boolean,
          providedClass: string,
          maybeClass: string | null
        ) {
          return <>
            <div css={condition ? makeRule("red") : { color: "blue" }} />
            <div css={condition && makeRule("red")} />
            <div css={providedClass || makeRule("red")} />
            <div css={maybeClass ?? makeRule("red")} />
            <div css={["base", condition && makeRule("red")]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css as _css");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("condition ? makeRule");
      expect(code).not.toContain("condition && makeRule");
      expect(code).not.toContain("providedClass || makeRule");
      expect(code).not.toContain("maybeClass ?? makeRule");
      expect(code).toMatch(
        /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(providedClass \|\| _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(maybeClass \?\? _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\("base", condition && _\$mincho\$\$App\d+\)\}/
      );
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(6);
      expect(result[1]).toContain('_css(makeRule("red"))');
      expect(result[1]).toContain('color: "blue"');
      expect(output).not.toContain("_css(condition");
    });

    it("lowers transparent wrapped branch jsx css prop expressions", () => {
      const fixtures = [
        {
          fixture: `<div css={(condition ? { color: "red" } : { color: "blue" }) as const} />`,
          expectedClassName:
            /className=\{condition \? _\$mincho\$\$App\d+ : _\$mincho\$\$App\d+\}/,
          expectedRule: "_css({",
          expectedBlueRule: true
        },
        {
          fixture: `<div css={(condition && { color: "red" }) as unknown} />`,
          expectedClassName:
            /className=\{_cx\(condition && _\$mincho\$\$App\d+\)\}/,
          expectedRule: "_css({",
          expectedBlueRule: false
        }
      ] as const;

      for (const {
        fixture,
        expectedClassName,
        expectedRule,
        expectedBlueRule
      } of fixtures) {
        const { result, code } = babelTransform(
          `
          function App(condition: boolean) {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(output).not.toContain("_css(condition &&");
        expect(output).not.toContain("css(condition &&");
        expect(result[1]).toContain(expectedRule);
        expect(result[1]).toContain('color: "red"');

        if (expectedBlueRule) {
          expect(result[1]).toContain('color: "blue"');
        }
      }
    });

    it("lowers explicit cx array and dictionary class values through class-value mode", () => {
      const { result, code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const isActive = true;

        function App() {
          return <>
            <div css={cx(["base", isActive && "active"])} />
            <div css={cx({ active: isActive })} />
            <div css={cx(["base", { active: isActive }])} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain(
        'className={_cx(cx(["base", isActive && "active"]))}'
      );
      expect(code).toMatch(
        /className=\{_cx\(cx\(\{\s+active: isActive\s+\}\)\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(cx\(\["base", \{\s+active: isActive\s+\}\]\)\)\}/
      );
      expect(result[1]).not.toContain("_css(");
    });

    it("keeps explicit cx call operands in class-value mode", () => {
      const { result, code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const condition = true;

        function makeRule(color: string) {
          return { color };
        }

        function getClassName() {
          return "dynamic";
        }

        function App() {
          return <>
            <div css={cx({ color: "red" })} />
            <div css={cx(makeRule("red"))} />
            <div css={cx(getClassName())} />
            <div css={condition ? cx({ color: "red" }) : { color: "blue" }} />
            <div css={condition && cx([{ color: "red" }])} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/className=\{_cx\(cx\(\{\s+color: "red"\s+\}\)\)\}/);
      expect(code).toContain('className={_cx(cx(makeRule("red")))}');
      expect(code).toContain("className={_cx(cx(getClassName()))}");
      expect(code).toMatch(
        /className=\{_cx\(condition \? cx\(\{\s+color: "red"\s+\}\) : _\$mincho\$\$App\d+\)\}/
      );
      expect(code).toMatch(
        /className=\{_cx\(condition && cx\(\[\{\s+color: "red"\s+\}\]\)\)\}/
      );
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(1);
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).not.toContain('color: "red"');
      expect(result[1]).not.toContain("makeRule");
      expect(result[1]).not.toContain("getClassName");
    });

    it("lowers simple dynamic css variable leaf into generated artifact and inline style", () => {
      const { result, code } = babelTransform(
        `
        function App(props) {
          return <div css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
      expect(result[1]).toMatch(/_minchoGetVarName\d*\(/);
      expect(result[1]).toContain("_css({");
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).toMatch(/from "extracted_[^"]+\.css\.ts"/);
      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain("className=");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).not.toContain("ix");
      expect(code).not.toMatch(/vx[^\n]+from "@mincho-js\/css"/);
    });

    it("lowers static-shape array spread dynamic leaves through CSS variables and rejects runtime spreads", () => {
      const source = `
        const base = [{ display: "flex" }];

        function App(props: { gap: number }) {
          return <div css={[...base, { gap: props.gap }]} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App({ gap: 12 });
        return { props, hasCss: "css" in props };
      `
      );
      const runtimeSpreadFailure = captureJsxCssPropFailure(
        `
        function App(props: { styles: readonly Record<string, string>[]; color: string }) {
          return <div css={[...props.styles, { color: props.color }]} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toContain("_css([");
      expect(result[1]).toContain('display: "flex"');
      expect(result[1]).toMatch(/gap: _\$mincho\$\$App\w*GapVar/);
      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain("_vx(props.gap)");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(observed).toEqual({
        hasCss: false,
        props: { className: "css-rule", style: { "css-rule": 12 } }
      });
      expect(runtimeSpreadFailure.error.message).toMatch(
        /Mincho `css` requires statically known CSS shape|array values do not support spread elements|spread operand is not statically reducible/
      );
      expect(runtimeSpreadFailure.code).not.toContain("_css(");
    });

    it("lowers dynamic css variable expression matrix into vx values", () => {
      const { result, code } = babelTransform(
        `
        function getValue(value: number) {
          return value;
        }

        class Card {
          size = 12;

          render() {
            return <div css={{ borderWidth: this.size }} />;
          }
        }

        function App(props: {
          enabled: boolean;
          fallback: number;
          frequency: number;
          gap: number;
          offset: number;
          percent: number;
          ratio: number;
          resolution: number;
          root?: { gap: number };
          size: number;
          value: number | null;
        }) {
          const enabled = props.enabled;
          const fallback = props.fallback;
          const frequency = props.frequency;
          const gap = props.gap;
          const offset = props.offset;
          const percent = props.percent;
          const ratio = props.ratio;
          const resolution = props.resolution;
          const root = props.root;
          const size = props.size;
          const value = props.value;

          return <>
            <div css={{ width: size + 100 }} />
            <div css={{ margin: \`${"${gap}"}px\` }} />
            <div css={{ inset: \`${"${percent}"}%\` }} />
            <div css={{ padding: \`${"${root?.gap}"}rem\` }} />
            <div css={{ marginBlock: \`${"${size}"}em\` }} />
            <div css={{ letterSpacing: \`${"${size}"}Q\` }} />
            <div css={{ blockSize: \`${"${size}"}svh\` }} />
            <div css={{ inlineSize: \`${"${size}"}cqw\` }} />
            <div css={{ rotate: \`${"${offset}"}deg\` }} />
            <div css={{ transitionDuration: \`${"${size}"}ms\` }} />
            <div css={{ pitch: \`${"${frequency}"}Hz\` }} />
            <div css={{ pitch: \`${"${frequency}"}KHz\` }} />
            <div css={{ gridTemplateColumns: \`${"${ratio}"}fr\` }} />
            <div css={{ imageResolution: \`${"${resolution}"}dpi\` }} />
            <div css={{ imageResolution: \`${"${resolution}"}x\` }} />
            <div css={{ color: enabled ? "red" : "blue" }} />
            <div css={{ opacity: value ?? fallback }} />
            <div css={{ height: +size }} />
            <div css={{ top: -offset }} />
            <div css={{ lineHeight: getValue(size) }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(22);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain("_vx(size + 100)");
      expect(code).toContain('_vx(gap, "px")');
      expect(code).toContain('_vx(percent, "%")');
      expect(code).toContain('_vx(root?.gap, "rem")');
      expect(code).toContain('_vx(size, "em")');
      expect(code).toContain('_vx(size, "Q")');
      expect(code).toContain('_vx(size, "svh")');
      expect(code).toContain('_vx(size, "cqw")');
      expect(code).toContain('_vx(offset, "deg")');
      expect(code).toContain('_vx(size, "ms")');
      expect(code).toContain('_vx(frequency, "Hz")');
      expect(code).toContain('_vx(frequency, "KHz")');
      expect(code).toContain('_vx(ratio, "fr")');
      expect(code).toContain('_vx(resolution, "dpi")');
      expect(code).toContain('_vx(resolution, "x")');
      expect(code).not.toContain('enabled ? _vx("red") : _vx("blue")');
      expect(code).toContain("_vx(value ?? fallback)");
      expect(code).toContain("_vx(+size)");
      expect(code).toContain("_vx(-offset)");
      expect(code).toContain("_vx(getValue(size))");
      expect(code).toContain("_vx(this.size)");
    });

    it("lowers static conditional declaration leaves to conditional class fragments", () => {
      const { result, code } = babelTransform(
        `
        function App(active: boolean) {
          return <div css={{ color: active ? "red" : "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(2);
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "blue"');
      expect(result[1]).not.toContain("createVar");
      expect(result[1]).not.toContain("getVarName");
      expect(code).toContain("className={active ?");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("style=");
      expect(code).not.toContain("_vx(");
      expect(code).not.toContain("@mincho-js/transform-runtime");
    });

    it("lowers mixed and dynamic conditional declaration leaves through lazy branch fragments", () => {
      const source = `
        const events: string[] = [];
        const state = { active: true };
        const activeColor = {
          get value() {
            events.push("active");
            return "tomato";
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            throw new Error("inactive branch evaluated");
          }
        };

        function MixedApp() {
          return <div css={{ color: state.active ? "red" : inactiveColor.value }} />;
        }

        function DynamicApp() {
          return <section css={{ color: state.active ? activeColor.value : inactiveColor.value }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const mixed = MixedApp();
        const dynamic = DynamicApp();
        return { mixed, dynamic, events };
      `
      );

      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain("const _minchoCssBranch = state.active;");
      expect(code).toContain("...(_minchoCssBranch ?");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain('_vx("red")');
      expect(observed).toEqual({
        mixed: { className: "css-rule", style: {} },
        dynamic: { className: "css-rule", style: { "css-rule": "tomato" } },
        events: ["active"]
      });
    });

    it("lowers nested conditional and logical declaration leaves without inactive style entries", () => {
      const source = `
        const events: string[] = [];
        const state = { active: true, primary: false };
        const guard = { enabled: false };
        const nested = {
          get value() {
            events.push("nested");
            return "purple";
          }
        };
        const guarded = {
          get value() {
            events.push("guarded");
            throw new Error("logical branch evaluated");
          }
        };
        const fallback = {
          get value() {
            events.push("fallback");
            return "blue";
          }
        };

        function NestedApp() {
          return <div css={{ color: state.active ? (state.primary ? "red" : nested.value) : "gray" }} />;
        }

        function LogicalApp() {
          return <section css={{ color: guard.enabled && guarded.value }} />;
        }

        function NullishApp(value: string | null | undefined) {
          return <article css={{ color: value ?? fallback.value }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const nestedProps = NestedApp();
        const logicalProps = LogicalApp();
        const nullishProps = NullishApp(null);
        return { nestedProps, logicalProps, nullishProps, events };
      `
      );

      expect(code).not.toContain(" css=");
      expect(code).toMatch(/const _minchoCssBranch\d* = guard\.enabled;/);
      expect(code).toContain("...(_minchoCssBranch");
      expect(observed).toEqual({
        nestedProps: {
          className: "css-rule",
          style: { "css-rule": "purple" }
        },
        logicalProps: { className: "", style: {} },
        nullishProps: {
          className: "css-rule",
          style: { "css-rule": "blue" }
        },
        events: ["nested", "fallback"]
      });
    });

    it("lowers static conditional object fragments through branch classes", () => {
      const { result, code } = babelTransform(
        `
        function App(active: boolean, fallback: boolean) {
          return <div css={{
            display: "block",
            ...active && { color: "red" },
            ...fallback || { backgroundColor: "blue" }
          }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1].match(/_css\(/g) ?? []).toHaveLength(4);
      expect(result[1]).toContain('display: "block"');
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('backgroundColor: "blue"');
      expect(result[1]).not.toContain("createVar");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("style=");
      expect(code).toContain("className={_cx(active ?");
      expect(code).toContain("fallback ?");
    });

    it("lowers mixed conditional object fragments without inactive getter reads", () => {
      const source = `
        const events: string[] = [];
        const state = { active: true, fallback: false, tone: true };
        const activeColor = {
          get value() {
            events.push("active");
            return "tomato";
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            throw new Error("inactive object fragment evaluated");
          }
        };
        const fallbackColor = {
          get value() {
            events.push("fallback");
            return "gold";
          }
        };

        function App() {
          return <div css={{
            padding: 4,
            ...state.active && { color: activeColor.value },
            borderColor: state.tone ? "black" : inactiveColor.value,
            ...state.fallback || { backgroundColor: fallbackColor.value },
            margin: 8
          }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style) };
      `
      ) as {
        props: Record<string, unknown>;
        events: string[];
        styleKeys: string[];
      };

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).toContain("const _minchoCssBranch = state.active;");
      expect(code).toMatch(
        /const _minchoCssBranch\d* = .* \? state\.fallback : void 0;/
      );
      expect(code).toContain("...(_minchoCssBranch ?");
      expect(observed.events).toEqual(["active", "fallback"]);
      expect(observed.styleKeys).toEqual(["css-rule"]);
      expect(observed.props).toMatchObject({
        className: "css-rule",
        style: { "css-rule": "gold" }
      });
    });

    it("lowers ternary conditional object fragments when both branches are statically shaped", () => {
      const source = `
        const events: string[] = [];
        const state = { active: false };
        const activeColor = {
          get value() {
            events.push("active");
            throw new Error("active object fragment evaluated");
          }
        };
        const inactiveColor = {
          get value() {
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          return <div css={{
            ...(state.active ? { color: activeColor.value } : { backgroundColor: inactiveColor.value })
          }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App();
        return { props, events };
      `
      ) as { props: Record<string, unknown>; events: string[] };

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).toContain("className={_minchoCssBranch ?");
      expect(code).toContain("...(_minchoCssBranch ?");
      expect(observed.events).toEqual(["inactive"]);
      expect(observed.props).toMatchObject({
        className: "css-rule",
        style: { "css-rule": "blue" }
      });
    });

    it("rejects unsupported arbitrary spread conditional object fragments", () => {
      const fixtures = [
        {
          label: "logical arbitrary object spread",
          source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...active && props.styles, color: "red" }} />;
            }
          `
        },
        {
          label: "ternary arbitrary object spread",
          source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...(active ? props.styles : { color: "red" }) }} />;
            }
          `
        },
        {
          label: "direct arbitrary object spread remains rejected",
          source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape|Complex conditions are supported only when branch CSS shape is static/
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("rejects runtime-shape conditionals before CSS emission", () => {
      const failure = captureJsxCssPropFailure(
        `
        function App(active: boolean, props: { key: string }) {
          return <div css={active ? { [props.key]: "red" } : { color: "blue" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(failure.error.message).toMatch(
        /dynamic expression is unsupported|unsupported identifier-object-value|Mincho JSX css prop|Complex conditions are supported only when branch CSS shape is static/
      );
      expect(failure.code).not.toContain("_css(");
      expect(failure.code).not.toContain("style={{");
    });

    it("blocks inherited generated custom property values for nullish and boolean dynamic leaves without @property output", () => {
      const source = `
        function Parent(value: string) {
          return <div css={{ color: value }} />;
        }

        function Child(value: string | null | undefined | boolean) {
          return <div css={{ color: value }} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const parent = Parent("parent-color");
        const generatedKey = Object.keys(parent.style)[0];
        const parentValue = parent.style[generatedKey];
        const cases = [
          ["undefined", undefined],
          ["null", null],
          ["false", false],
          ["true", true]
        ];
        const resolveGeneratedColor = (childStyle) => {
          const childValue = childStyle[generatedKey];

          if (
            childValue === undefined ||
            childValue === null ||
            typeof childValue === "boolean"
          ) {
            return parentValue;
          }

          if (childValue === "var(--c-, )") {
            return null;
          }

          return childValue;
        };

        return cases.map(([label, value]) => {
          const child = Child(value);

          return {
            label,
            childCustomPropertyValue: child.style[generatedKey],
            inheritedParentValue:
              resolveGeneratedColor(child.style) === parentValue
          };
        });
      `
      );

      expect(
        result[1],
        "Mincho has no approved output-layer plan for StyleX @property generation; vx fallback is this scope's inheritance guard."
      ).not.toContain("@property");
      expect(code).not.toContain("@property");
      expect(code).toContain(
        'import { vx as _vx } from "@mincho-js/transform-runtime";'
      );
      expect(code).toContain("_vx(value)");
      expect(observed).toEqual([
        {
          label: "undefined",
          childCustomPropertyValue: "var(--c-, )",
          inheritedParentValue: false
        },
        {
          label: "null",
          childCustomPropertyValue: "var(--c-, )",
          inheritedParentValue: false
        },
        {
          label: "false",
          childCustomPropertyValue: "var(--c-, )",
          inheritedParentValue: false
        },
        {
          label: "true",
          childCustomPropertyValue: "var(--c-, )",
          inheritedParentValue: false
        }
      ]);
    });

    it("rejects unsupported dynamic css variable value expressions", () => {
      const fixtures = [
        {
          label: "assignment",
          source: `
            let size = 1;
            function App() {
              return <div css={{ width: (size = 2) }} />;
            }
          `
        },
        {
          label: "update",
          source: `
            let size = 1;
            function App() {
              return <div css={{ width: size++ }} />;
            }
          `
        },
        {
          label: "sequence",
          source: `
            function App(size: number, fallback: number) {
              return <div css={{ width: (size, fallback) }} />;
            }
          `
        },
        {
          label: "await",
          source: `
            async function App(size: Promise<number>) {
              return <div css={{ width: await size }} />;
            }
          `
        },
        {
          label: "yield",
          source: `
            function* App(size: number) {
              return <div css={{ width: yield size }} />;
            }
          `
        },
        {
          label: "new",
          source: `
            class Size {}
            function App() {
              return <div css={{ width: new Size() }} />;
            }
          `
        },
        {
          label: "array value",
          source: `
            function App(size: number) {
              return <div css={{ width: [size] }} />;
            }
          `
        },
        {
          label: "function value",
          source: `
            function App(size: number) {
              return <div css={{ width: () => size }} />;
            }
          `
        },
        {
          label: "class value",
          source: `
            function App() {
              return <div css={{ width: class Size {} }} />;
            }
          `
        },
        {
          label: "jsx value",
          source: `
            function App() {
              return <div css={{ width: <span /> }} />;
            }
          `
        },
        {
          label: "tagged template",
          source: `
            function unit(strings: TemplateStringsArray, value: number) {
              return value;
            }
            function App(size: number) {
              return <div css={{ width: unit\`${"${size}"}px\` }} />;
            }
          `
        },
        {
          label: "multi-hole template",
          source: `
            function App(size: number, unit: string) {
              return <div css={{ width: \`${"${size}"}${"${unit}"}\` }} />;
            }
          `
        },
        {
          label: "unsafe template affix",
          source: `
            function App(size: number) {
              return <div css={{ width: \`calc(${"${size}"}px)\` }} />;
            }
          `
        },
        {
          label: "unicode-folded template suffix",
          source: `
            function App(frequency: number) {
              return <div css={{ pitch: \`${"${frequency}"}KHz\` }} />;
            }
          `
        },
        {
          label: "comparison",
          source: `
            function App(size: number) {
              return <div css={{ width: size > 1 }} />;
            }
          `
        },
        {
          label: "bitwise",
          source: `
            function App(size: number) {
              return <div css={{ width: size | 1 }} />;
            }
          `
        },
        {
          label: "in operator",
          source: `
            function App(props: Record<string, unknown>) {
              return <div css={{ width: "size" in props }} />;
            }
          `
        },
        {
          label: "instanceof operator",
          source: `
            class Size {}
            function App(value: unknown) {
              return <div css={{ width: value instanceof Size }} />;
            }
          `
        },
        {
          label: "dynamic key",
          source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          /Cannot statically evaluate|Mincho JSX css prop/
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("rejects dynamic arrays in direct, conditional leaf, and conditional fragment contexts", () => {
      const fixtures = [
        {
          label: "direct dynamic property array",
          source: `
            function App(props: { gap: number }) {
              return <div css={{ margin: [props.gap, "auto"] }} />;
            }
          `
        },
        {
          label: "conditional dynamic property array",
          source: `
            function App(props: { compact: boolean; gap: number }) {
              return <div css={{ margin: props.compact ? [props.gap] : ["auto"] }} />;
            }
          `
        },
        {
          label: "conditional object fragment dynamic property array",
          source: `
            function App(props: { active: boolean; gap: number }) {
              return <div css={{ ...props.active && { margin: [props.gap, "auto"] } }} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape/
        );
        expect(failure.error.message, label).not.toMatch(
          reactStyleGuidancePattern
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("routes static-key render values through dynamic-leaf mode", () => {
      const { result, code } = babelTransform(
        `
        function App(props: { color: string }) {
          return <div css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
      expect(result[1]).toContain("_css({");
      expect(result[1]).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("style={{ color: props.color }}");
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
    });

    it("routes uncommon static keys through dynamic-leaf mode without a property allowlist", () => {
      const { result, code } = babelTransform(
        `
        function App(props: { accent: string; scrollbar: string }) {
          return <div css={{ "--brand-accent": props.accent, scrollbarColor: props.scrollbar }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toContain('_minchoCreateVar("--brand-accent")');
      expect(result[1]).toContain('_minchoCreateVar("scrollbarColor")');
      expect(result[1]).toContain(
        '"--brand-accent": _$mincho$$AppBrandAccentVar'
      );
      expect(result[1]).toContain(
        "scrollbarColor: _$mincho$$AppScrollbarColorVar"
      );
      expect(code).toContain("_vx(props.accent)");
      expect(code).toContain("_vx(props.scrollbar)");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain('style={{ "--brand-accent": props.accent');
    });

    it("dynamic CSS variable style custom property supports props.color and render-scope makeColor", () => {
      const { result, code } = babelTransform(
        `
        function App(props: {
          color: string;
          hoverColor: string;
          background: string;
        }) {
          function makeColor() {
            return props.color;
          }

          return <>
            <div css={{ _hover: { color: props.hoverColor } }} />
            <section css={[
              { color: makeColor() },
              { background: props.background }
            ]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const artifact = result[1];

      expect(artifact).toContain("_css({");
      expect(artifact).toContain("_css([");
      expect(artifact).toContain("_hover: {");
      expect(artifact).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(artifact).toMatch(/background: _\$mincho\$\$App\w*BackgroundVar/);
      expect(code).toContain("props.hoverColor");
      expect(code).toContain("makeColor()");
      expect(code).toContain("props.background");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).not.toContain("style={{ color:");
      expect(code.match(/style=\{\{/g) ?? []).toHaveLength(2);
    });

    it("lowers dynamic css variable and static css prop without duplicate css helper aliases", () => {
      const { result, code } = babelTransform(
        `
        function App(props) {
          return <>
            <div css={{ color: "red" }} />
            <section css={{ color: props.color }} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const artifact = result[1];

      expect(artifact.match(/css as _css/g) ?? []).toHaveLength(1);
      expect(artifact).toMatch(/_minchoCreateVar\d*\(/);
      expect(artifact).toMatch(/_minchoGetVarName\d*\(/);
      expect(artifact).toContain('color: "red"');
      expect(artifact).toMatch(/color: _\$mincho\$\$App\w*ColorVar/);
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
    });

    it("lowers dynamic css variable source helper imports without duplicate helper declarations", () => {
      const createVarCase = babelTransform(
        `
        import { createVar } from "@mincho-js/css";

        const external = createVar("external");

        function App(props) {
          return <div data-var={external} css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );
      const getVarNameCase = babelTransform(
        `
        import { getVarName } from "@mincho-js/css";

        const external = getVarName("external");

        function App(props) {
          return <div data-var={external} css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(createVarCase.result[1].match(/css as _css/g) ?? []).toHaveLength(
        1
      );
      expect(createVarCase.result[1]).toContain('createVar("external")');
      expect(createVarCase.result[1]).toMatch(
        /createVar as _minchoCreateVar\d*/
      );
      expect(createVarCase.result[1]).toMatch(
        /getVarName as _minchoGetVarName\d*/
      );
      expect(createVarCase.result[1]).toMatch(
        /color: _\$mincho\$\$App\w*ColorVar/
      );
      expect(createVarCase.code).not.toContain("_css(");
      expect(createVarCase.code).not.toContain("createVar(");
      expect(createVarCase.code).not.toContain("getVarName(");

      expect(getVarNameCase.result[1].match(/css as _css/g) ?? []).toHaveLength(
        1
      );
      expect(getVarNameCase.result[1]).toMatch(
        /createVar as _minchoCreateVar\d*/
      );
      expect(getVarNameCase.result[1]).toMatch(
        /getVarName as _minchoGetVarName\d*/
      );
      expect(getVarNameCase.result[1]).toMatch(
        /color: _\$mincho\$\$App\w*ColorVar/
      );
      expect(getVarNameCase.code).toContain('getVarName("external")');
      expect(getVarNameCase.code).not.toContain("_css(");
    });

    it("emits dynamic css variable style merge without existing style", () => {
      const { code } = babelTransform(
        `
        function App(props) {
          return <div css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).not.toContain("_css(");
    });

    it("merges dynamic css variable style merge after object and expression styles", () => {
      const objectStyle = babelTransform(
        `
        function App(props) {
          const baseStyle = props.baseStyle;
          return <div
            style={{ ...baseStyle, opacity: props.opacity }}
            css={{ color: props.color, backgroundColor: props.backgroundColor }}
          />;
        }
      `,
        { jsxCssProp: true }
      ).code;
      const expressionStyle = babelTransform(
        `
        function App(props) {
          return <section
            style={props.style}
            css={{ borderColor: props.borderColor }}
          />;
        }
      `,
        { jsxCssProp: true }
      ).code;

      expect(objectStyle).toMatch(
        /style=\{\{\s+\.\.\.baseStyle,\s+opacity: props\.opacity,\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\),\s+\[_\$mincho\$\$App\w*BackgroundColorVarKey\d*\]: _vx\(props\.backgroundColor\)\s+\}\}/
      );
      expect(expressionStyle).toMatch(
        /style=\{\{\s+\.\.\.props\.style,\s+\[_\$mincho\$\$App\w*BorderColorVarKey\d*\]: _vx\(props\.borderColor\)\s+\}\}/
      );

      for (const output of [objectStyle, expressionStyle]) {
        expect(output).not.toContain(" css=");
        expect(output).not.toContain('from "@mincho-js/css"');
        expect(output).not.toContain("createVar");
        expect(output).not.toContain("getVarName");
        expect(output).not.toContain("_css(");
      }
    });

    it("merges dynamic css variable style merge after existing className", () => {
      const { code } = babelTransform(
        `
        function App(props) {
          return <div className={props.className} css={{ color: props.color }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toMatch(
        /className=\{_\$mincho\$\$App\w*Cx\d*\(props\.className, _\$mincho\$\$App\d*\)\}/
      );
      expect(code).toMatch(
        /style=\{\{\s+\[_\$mincho\$\$App\w*ColorVarKey\d*\]: _vx\(props\.color\)\s+\}\}/
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).not.toContain("_css(");
    });

    it("dynamic css variable spread aggregates pre and post styles before generated vars", () => {
      const source = `
        const pre = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre",
          style: { color: "pre" }
        };
        const post = {
          className: "from-post",
          css: "leak-post",
          title: "from-post",
          style: { backgroundColor: "post" }
        };

        function App() {
          const props = { color: "tomato" };
          return <div {...pre} css={{ color: props.color }} {...post} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
      );

      expect(result[1]).toMatch(/_minchoCreateVar\d*\(/);
      expect(result[1]).toMatch(/_minchoGetVarName\d*\(/);
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain("cx as");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain(" css=");
      expect(observed).toEqual({
        hasCss: false,
        styleKeys: ["color", "backgroundColor", "css-rule"],
        props: expect.objectContaining({
          className: "from-pre css-rule from-post",
          id: "from-pre",
          title: "from-post",
          style: {
            color: "pre",
            backgroundColor: "post",
            "css-rule": "tomato"
          }
        })
      });
    });

    it("dynamic css variable spread preserves explicit style before and after css", () => {
      const beforeCssStyle = runJsxCssPropRuntime(
        `
        const pre = {
          className: "from-pre",
          css: "leak-pre",
          style: { padding: 4 }
        };

        function App() {
          const props = { color: "tomato" };
          return <div {...pre} style={{ opacity: 0.5 }} css={{ color: props.color }} />;
        }
      `,
        `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
      );
      const afterCssStyle = runJsxCssPropRuntime(
        `
        const post = {
          className: "from-post",
          css: "leak-post",
          style: { margin: 8 }
        };

        function App() {
          const props = { color: "tomato" };
          return <div css={{ color: props.color }} style={{ opacity: 0.75 }} {...post} />;
        }
      `,
        `
        const props = App();
        return {
          props,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
      );

      expect(beforeCssStyle).toEqual({
        hasCss: false,
        styleKeys: ["padding", "opacity", "css-rule"],
        props: expect.objectContaining({
          className: "from-pre css-rule",
          style: { padding: 4, opacity: 0.5, "css-rule": "tomato" }
        })
      });
      expect(afterCssStyle).toEqual({
        hasCss: false,
        styleKeys: ["opacity", "margin", "css-rule"],
        props: expect.objectContaining({
          className: "css-rule from-post",
          style: { opacity: 0.75, margin: 8, "css-rule": "tomato" }
        })
      });
    });

    it("style getter source order for dynamic css variable spread reads each contribution once", () => {
      const observed = runJsxCssPropRuntime(
        `
        const events: string[] = [];
        const reads = {
          preStyle: 0,
          preClassName: 0,
          preCss: 0,
          explicitStyle: 0,
          postStyle: 0,
          postClassName: 0,
          postCss: 0,
          dynamic: 0
        };
        const pre = {
          id: "from-pre",
          get style() {
            reads.preStyle += 1;
            events.push("pre.style");
            return { color: "pre" };
          },
          get className() {
            reads.preClassName += 1;
            events.push("pre.className");
            return "from-pre";
          },
          get css() {
            reads.preCss += 1;
            events.push("pre.css");
            return "leak-pre";
          }
        };
        const explicitStyle = {
          get value() {
            reads.explicitStyle += 1;
            events.push("explicit.style");
            return { opacity: 0.5 };
          }
        };
        const post = {
          title: "from-post",
          get style() {
            reads.postStyle += 1;
            events.push("post.style");
            return { backgroundColor: "post" };
          },
          get className() {
            reads.postClassName += 1;
            events.push("post.className");
            return "from-post";
          },
          get css() {
            reads.postCss += 1;
            events.push("post.css");
            return "leak-post";
          }
        };
        const model = {
          get color() {
            reads.dynamic += 1;
            events.push("dynamic");
            return "tomato";
          }
        };

        function App(props) {
          return <div {...pre} style={explicitStyle.value} css={{ color: props.color }} {...post} />;
        }
      `,
        `
        const props = App(model);
        return {
          props,
          events,
          reads,
          styleKeys: Object.keys(props.style),
          hasCss: "css" in props
        };
      `
      );

      expect(observed).toEqual({
        events: [
          "pre.style",
          "pre.className",
          "pre.css",
          "explicit.style",
          "post.style",
          "post.className",
          "post.css",
          "dynamic"
        ],
        reads: {
          preStyle: 1,
          preClassName: 1,
          preCss: 1,
          explicitStyle: 1,
          postStyle: 1,
          postClassName: 1,
          postCss: 1,
          dynamic: 1
        },
        styleKeys: ["color", "opacity", "backgroundColor", "css-rule"],
        hasCss: false,
        props: expect.objectContaining({
          className: "from-pre css-rule from-post",
          id: "from-pre",
          title: "from-post",
          style: {
            color: "pre",
            opacity: 0.5,
            backgroundColor: "post",
            "css-rule": "tomato"
          }
        })
      });
    });

    it("rejects invalid dynamic css variable style merge values", () => {
      const fixtures = [
        `<div style css={{ color: props.color }} />`,
        `<div style="color:red" css={{ color: props.color }} />`,
        `<div style={"color:red"} css={{ color: props.color }} />`,
        `<div style={\`color:red\`} css={{ color: props.color }} />`
      ] as const;

      for (const fixture of fixtures) {
        const failure = captureJsxCssPropFailure(
          `
          function App(props) {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );

        expect(failure.error.message).toContain(
          jsxCssPropErrorMessages.styleValue
        );
        expect(failure.code).not.toContain("_css(");
      }
    });

    it("lowers dynamic css variable leaves across static object and array shapes", () => {
      const { result, code } = babelTransform(
        `
        function App(props) {
          return <>
            <div css={{
              color: props.color,
              backgroundColor: "white",
              borderColor: props.borderColor,
              selectors: {
                "&:hover": {
                  color: props.hoverColor
                }
              },
              "@media": {
                "screen and (min-width: 700px)": {
                  color: props.mediaColor
                }
              },
              opacity: {
                $disabled: props.disabledOpacity
              }
            }} />
            <section css={[
              { display: "block", color: props.sectionColor },
              { selectors: { "&:focus": { outlineColor: props.outlineColor } } }
            ]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );
      const artifact = result[1];

      expect(artifact.match(/_minchoCreateVar\d*\(/g) ?? []).toHaveLength(7);
      expect(artifact.match(/_minchoGetVarName\d*\(/g) ?? []).toHaveLength(7);
      expect(artifact).toContain("_css({");
      expect(artifact).toContain("_css([");
      expect(artifact).toContain('backgroundColor: "white"');
      expect(artifact).toContain('display: "block"');
      expect(artifact).toContain("selectors: {");
      expect(artifact).toContain('"@media": {');
      expect(artifact).toContain('"&:hover": {');
      expect(artifact).toContain("$disabled: ");
      expect(artifact).not.toContain("props.");
      expect(code).toMatch(/from "extracted_[^"]+\.css\.ts"/);
      expect(code.match(/style=\{\{/g) ?? []).toHaveLength(2);
      expect(code).toContain("props.color");
      expect(code).toContain("props.borderColor");
      expect(code).toContain("props.hoverColor");
      expect(code).toContain("props.mediaColor");
      expect(code).toContain("props.disabledOpacity");
      expect(code).toContain("props.sectionColor");
      expect(code).toContain("props.outlineColor");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
    });

    it("keeps static css prop still unchanged without dynamic style emission", () => {
      const { result, code } = babelTransform(
        `
        function App() {
          return <>
            <div css={{
              color: "red",
              selectors: {
                "&:hover": {
                  color: "blue"
                }
              }
            }} />
            <section css={[{ display: "block" }, { color: "green" }]} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("style=");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain("_css([");
      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('"&:hover": {');
      expect(result[1]).not.toContain("createVar(");
      expect(result[1]).not.toContain("getVarName(");
    });

    it("branch dynamic css variable evaluates once", () => {
      const source = `
        const events: string[] = [];
        const reads = {
          condition: 0,
          active: 0,
          inactive: 0
        };
        const state = {
          get condition() {
            reads.condition += 1;
            events.push("condition");
            return true;
          }
        };
        const active = {
          get color() {
            reads.active += 1;
            events.push("active");
            return "tomato";
          }
        };
        const inactive = {
          get color() {
            reads.inactive += 1;
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          return <div css={state.condition ? { color: active.color } : { color: inactive.color }} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const artifact = result[1];
      const observed = runJsxCssPropRuntime(
        source,
        "return { props: App(), events, reads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(artifact).toContain(
        'import { css as _css } from "@mincho-js/css";'
      );
      expect(artifact).toContain(
        'import { createVar as _minchoCreateVar, getVarName as _minchoGetVarName } from "@mincho-js/css";'
      );
      expect(
        artifact.match(
          /export var _\$mincho\$\$App\w*ColorVar\d* = _minchoCreateVar\("color"\);/g
        ) ?? []
      ).toHaveLength(2);
      expect(
        artifact.match(
          /export var _\$mincho\$\$App\w*ColorVarKey\d* = _minchoGetVarName\(_\$mincho\$\$App\w*ColorVar\d*\);/g
        ) ?? []
      ).toHaveLength(2);
      expect(
        artifact.match(
          /export var _\$mincho\$\$App\d* = _css\(\{\s+color: _\$mincho\$\$App\w*ColorVar\d*\s+\}\);/g
        ) ?? []
      ).toHaveLength(2);
      expect(code).toMatch(
        /import \{ _\$mincho\$\$App as _\$mincho\$\$App2, _\$mincho\$\$App3 as _\$mincho\$\$App4 \} from "extracted_[^"]+\.css\.ts";/
      );
      expect(code).toMatch(
        /import \{ _\$mincho\$\$App\w*ColorVarKey as _\$mincho\$\$App\w*ColorVarKey2, _\$mincho\$\$App\w*ColorVarKey3 as _\$mincho\$\$App\w*ColorVarKey4 \} from "extracted_[^"]+\.css\.ts";/
      );
      expect(code).toContain("const _minchoCssBranch = state.condition;");
      expect(code).toContain("className={_minchoCssBranch ?");
      expect(code).toContain("...(_minchoCssBranch ?");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code.match(/state\.condition/g) ?? []).toHaveLength(1);
      expect(observed.events).toEqual(["condition", "active"]);
      expect(observed.reads).toEqual({ condition: 1, active: 1, inactive: 0 });
      expect(observed.props).toMatchObject({
        className: "css-rule",
        style: { "css-rule": "tomato" }
      });
    });

    it("nested branch dynamic css variable decisions evaluate once", () => {
      const source = `
        const events: string[] = [];
        const reads = { outer: 0, inner: 0, inactive: 0 };
        const colors = { active: "tomato", other: "blue", fallback: "gray" };
        let inner = false;
        const decide = (name, value) => {
          reads[name] += 1;
          events.push(name);
          return value;
        };
        const flip = () => {
          events.push("flip");
          inner = true;
          return "flipped";
        };

        function App() {
          return <div css={decide("outer", true) ? decide("inner", inner) ? { color: colors.active } : { color: colors.other } : decide("inactive", false) && { color: colors.fallback }} data-flip={flip()} />;
        }
      `;
      const observed = runJsxCssPropRuntime(
        source,
        "return { props: App(), events, reads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(observed.events).toEqual(["outer", "inner", "flip"]);
      expect(observed.reads).toEqual({
        outer: 1,
        inner: 1,
        inactive: 0
      });
      expect(observed.props).toMatchObject({
        className: "css-rule",
        style: { "css-rule": "blue" },
        "data-flip": "flipped"
      });
    });

    it("conditional dynamic css variable style", () => {
      const source = `
        const events: string[] = [];
        const state = { condition: false };
        const primary = {
          get color() {
            events.push("primary");
            return "tomato";
          }
        };
        const fallback = {
          get color() {
            events.push("fallback");
            return "blue";
          }
        };

        function App() {
          return <div style={{ opacity: 0.5 }} css={state.condition ? { color: primary.color } : { color: fallback.color }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style) };
      `
      ) as {
        props: Record<string, unknown>;
        events: string[];
        styleKeys: string[];
      };

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(observed.events).toEqual(["fallback"]);
      expect(observed.styleKeys).toEqual(["opacity", "css-rule"]);
      expect(observed.props).toMatchObject({
        className: "css-rule",
        style: { opacity: 0.5, "css-rule": "blue" }
      });
    });

    it("logical dynamic css variable style", () => {
      const source = `
        const events: string[] = [];
        const reads = {
          condition: 0,
          guarded: 0,
          provided: 0,
          skippedFallback: 0,
          empty: 0,
          fallback: 0
        };
        const guard = {
          get condition() {
            reads.condition += 1;
            events.push("condition");
            return false;
          }
        };
        const provided = {
          get className() {
            reads.provided += 1;
            events.push("provided");
            return "provided";
          }
        };
        const empty = {
          get className() {
            reads.empty += 1;
            events.push("empty");
            return "";
          }
        };
        const guarded = {
          get color() {
            reads.guarded += 1;
            events.push("guarded");
            return "tomato";
          }
        };
        const skippedFallback = {
          get color() {
            reads.skippedFallback += 1;
            events.push("skipped-fallback");
            return "red";
          }
        };
        const fallback = {
          get color() {
            reads.fallback += 1;
            events.push("fallback");
            return "blue";
          }
        };

        function GuardedApp() {
          return <div css={guard.condition && { color: guarded.color }} />;
        }

        function ProvidedApp() {
          return <div css={provided.className || { color: skippedFallback.color }} />;
        }

        function FallbackApp() {
          return <div css={empty.className || { color: fallback.color }} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const guardedProps = GuardedApp();
        const providedProps = ProvidedApp();
        const fallbackProps = FallbackApp();
        return { guardedProps, providedProps, fallbackProps, events, reads };
      `
      ) as {
        guardedProps: Record<string, unknown>;
        providedProps: Record<string, unknown>;
        fallbackProps: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(code.match(/guard\.condition/g) ?? []).toHaveLength(1);
      expect(code.match(/provided\.className/g) ?? []).toHaveLength(1);
      expect(code.match(/empty\.className/g) ?? []).toHaveLength(1);
      expect(observed.events).toEqual([
        "condition",
        "provided",
        "empty",
        "fallback"
      ]);
      expect(observed.reads).toEqual({
        condition: 1,
        guarded: 0,
        provided: 1,
        skippedFallback: 0,
        empty: 1,
        fallback: 1
      });
      expect(observed.guardedProps.style).toEqual({});
      expect(observed.guardedProps.style).not.toBe(false);
      expect(observed.providedProps).toMatchObject({
        className: "provided",
        style: {}
      });
      expect(observed.fallbackProps).toMatchObject({
        className: "css-rule",
        style: { "css-rule": "blue" }
      });
    });

    it("branch dynamic css variable spread", () => {
      const source = `
        const events: string[] = [];
        const pre = {
          id: "from-pre",
          className: "from-pre",
          css: "leak-pre",
          style: { padding: 4 }
        };
        const post = {
          title: "from-post",
          className: "from-post",
          css: "leak-post",
          style: { margin: 8 }
        };
        const state = {
          get condition() {
            events.push("condition");
            return true;
          }
        };
        const active = {
          get color() {
            events.push("active");
            return "tomato";
          }
        };
        const inactive = {
          get color() {
            events.push("inactive");
            return "blue";
          }
        };

        function App() {
          const renderValue = () => <div {...pre} css={state.condition ? { color: active.color } : { color: inactive.color }} {...post} />;
          return renderValue();
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        const props = App();
        return { props, events, styleKeys: Object.keys(props.style), hasCss: "css" in props };
      `
      ) as {
        props: Record<string, unknown>;
        events: string[];
        styleKeys: string[];
        hasCss: boolean;
      };

      expect(code).toContain("(() =>");
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(");
      expect(code).not.toContain('from "@mincho-js/css"');
      expect(code).not.toContain("createVar");
      expect(code).not.toContain("getVarName");
      expect(observed.events).toEqual(["condition", "active"]);
      expect(observed.styleKeys).toEqual(["padding", "margin", "css-rule"]);
      expect(observed.hasCss).toBe(false);
      expect(observed.props).toMatchObject({
        id: "from-pre",
        title: "from-post",
        className: "from-pre css-rule from-post",
        style: { padding: 4, margin: 8, "css-rule": "tomato" }
      });
    });

    it("collects conditional dynamic css variable branch rules at model level", () => {
      const fixtures = [
        {
          source: `
            const condition = true;
            function App(props) {
              return <div css={condition ? { color: props.color } : { color: "red" }} />;
            }
          `,
          leafProperties: ["color"],
          branchLeafProperties: [["color"], []]
        },
        {
          source: `
            const condition = true;
            function App(props) {
              return <div css={condition ? { color: props.color } : { color: props.fallbackColor }} />;
            }
          `,
          leafProperties: ["color", "color"],
          branchLeafProperties: [["color"], ["color"]]
        }
      ] as const;

      for (const { source, leafProperties, branchLeafProperties } of fixtures) {
        const snapshot = collectDynamicCssVariableRuleSnapshot(source);

        expect(snapshot).toMatchObject({
          kind: "branch",
          expressionType: "ConditionalExpression",
          leafProperties
        });
        expect(
          snapshot?.branches?.map((branch) => branch.leafProperties)
        ).toEqual(branchLeafProperties);
      }
    });

    it("collects logical dynamic css variable branch rules at model level", () => {
      const fixtures = [
        `
          const condition = true;
          function App(props) {
            return <div css={condition && { color: props.color }} />;
          }
        `,
        `
          const providedClass = "provided";
          function App(props) {
            return <div css={providedClass || { color: props.color }} />;
          }
        `
      ] as const;

      for (const source of fixtures) {
        const snapshot = collectDynamicCssVariableRuleSnapshot(source);

        expect(snapshot).toMatchObject({
          kind: "branch",
          expressionType: "LogicalExpression",
          leafProperties: ["color"]
        });
        expect(
          snapshot?.branches?.map((branch) => branch.leafProperties)
        ).toEqual([["color"]]);
      }
    });

    it("rejects unsupported branch dynamic css variable rules at collector level", () => {
      const templateLiteralFixture = `
        const condition = true;
        function App(props) {
          return <div css={condition ? { color: \`${"${props.color}"}\` } : { color: "red" }} />;
        }
      `;
      const fixtures = [
        `
          const condition = true;
          function App(props) {
            return <div css={condition ? { [props.key]: props.color } : { color: "red" }} />;
          }
        `,
        `
          const condition = true;
          function App(props) {
            return <div css={condition ? { ...props.styles, color: props.color } : { color: "red" }} />;
          }
        `,
        `
          const condition = true;
          function App(props) {
            return <div css={condition ? [...props.styles, { color: props.color }] : [{ color: "red" }]} />;
          }
        `,
        `
          const condition = true;
          function makeRule(color) {
            return { color };
          }
          function App(props) {
            return <div css={condition ? makeRule(props.color) : { color: "red" }} />;
          }
        `,
        `
          function App(props) {
            return <div css={() => ({ color: props.color })} />;
          }
        `,
        `
          const condition = true;
          function App(props) {
            return <div css={condition ? (props.touch(), { color: props.color }) : { color: "red" }} />;
          }
        `,
        templateLiteralFixture
      ] as const;

      for (const source of fixtures) {
        expect(collectDynamicCssVariableRuleSnapshot(source)).toBeNull();
      }

      const templateLiteralFailure = captureJsxCssPropFailure(
        templateLiteralFixture,
        { jsxCssProp: true }
      );
      expect(templateLiteralFailure.error.message).toContain(
        jsxCssPropErrorMessages.unsupportedDynamicCssRule
      );
      expect(templateLiteralFailure.code).not.toContain("_css(");
    });

    it("rejects unsupported dynamic css variable shapes with exact compile-away diagnostics", () => {
      const fixtures = [
        {
          label: "dynamic keys",
          source: `
            function App(props) {
              return <div css={{ [props.key]: props.color }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: computed member access is unsupported"
        },
        {
          label: "dynamic object spreads",
          source: `
            function App(props) {
              return <div css={{ ...props.styles, color: props.color }} />;
            }
          `,
          expectedFirstLine:
            "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`."
        },
        {
          label: "dynamic array spreads",
          source: `
            function App(props) {
              return <div css={[...props.styles, { color: props.color }]} />;
            }
          `,
          expectedFirstLine:
            "Mincho JSX css prop array values do not support spread elements in compile-away mode"
        },
        {
          label: "call-return CSS shapes",
          source: `
            function makeRule(color) {
              return { color };
            }
            function App(props) {
              return <div css={makeRule(props.color)} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
        },
        {
          label: "member call-return CSS shapes",
          source: `
            function App(props) {
              return <div css={props.ruleFactory()} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
        },
        {
          label: "optional dynamic member CSS shapes",
          source: `
            const styles = null;
            function App() {
              return <div css={styles?.button} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalMemberExpression"
        },
        {
          label: "function values",
          source: `
            function App(props) {
              return <div css={{ color: () => props.color }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: dynamic expression is unsupported: ArrowFunctionExpression"
        },
        {
          label: "sequence-wrapped CSS rules",
          source: `
            function App(props) {
              return <div css={(0, { color: props.color })} />;
            }
          `,
          expectedFirstLine:
            "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
        },
        {
          label: "template runtime property values",
          source: `
            function App(props) {
              return <div css={{ color: \`${"${props.color}"}\` }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: template interpolation references a render-scope member"
        },
        {
          label: "template optional-member runtime property values",
          source: `
            function App(props) {
              return <div css={{ color: \`${"${props?.color}"}\` }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: template interpolation references a render-scope member"
        },
        {
          label: "template call property values",
          source: `
            function getColor() {
              return "red";
            }
            function App() {
              return <div css={{ color: \`${"${getColor()}"}\` }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
        }
      ] as const;

      for (const { label, source, expectedFirstLine } of fixtures) {
        let failure: ReturnType<typeof captureJsxCssPropFailure>;

        try {
          failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
        } catch (error) {
          throw new Error(
            `${label}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        expect(failure.error.message.split("\n")[0], label).toBe(
          expectedFirstLine
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("explains runtime CSS object spreads require statically known CSS shape", () => {
      const fixtures = [
        {
          label: "identifier object spread",
          source: `
            function App(someRuntimeObject: Record<string, string>) {
              return <div css={{ ...someRuntimeObject, color: "red" }} />;
            }
          `
        },
        {
          label: "call object spread",
          source: `
            function App(getStyles: () => Record<string, string>) {
              return <div css={{ ...getStyles(), color: "red" }} />;
            }
          `
        },
        {
          label: "array-shaped object spread",
          source: `
            function App(arrayOfStyles: ReadonlyArray<Record<string, string>>) {
              return <div css={{ ...arrayOfStyles, color: "red" }} />;
            }
          `
        },
        {
          label: "member object spread",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          staticShapeDiagnosticPattern
        );
        expect(failure.error.message, label).toMatch(reactStyleGuidancePattern);
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("omits React style guidance for non-plain static-shape diagnostics", () => {
      const fixtures = [
        {
          label: "selector composition",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ selectors: { "&:hover": { ...props.styles } } }} />;
            }
          `
        },
        {
          label: "media composition",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ "@media": { "screen and (min-width: 700px)": { ...props.styles } } }} />;
            }
          `
        },
        {
          label: "token composition",
          source: `
            function App(props: { vars: Record<string, string> }) {
              return <div css={{ vars: { ...props.vars } }} />;
            }
          `
        },
        {
          label: "condition composition",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ color: { $dark: { ...props.styles } } }} />;
            }
          `
        },
        {
          label: "class composition",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={[{ ...props.styles }, "extra"]} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          staticShapeDiagnosticPattern
        );
        expect(failure.error.message, label).not.toMatch(
          reactStyleGuidancePattern
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("explains runtime-shape conditionals require static branch CSS shape", () => {
      const fixtures = [
        {
          label: "computed-key runtime branch",
          source: `
            function App(active: boolean, props: { key: string }) {
              return <div css={active ? { [props.key]: "red" } : { color: "blue" }} />;
            }
          `
        },
        {
          label: "object-fragment runtime branch",
          source: `
            function App(active: boolean, props: { styles: Record<string, string> }) {
              return <div css={{ ...(active ? props.styles : { color: "red" }) }} />;
            }
          `
        }
      ] as const;

      for (const { label, source } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message, label).toMatch(
          /Complex conditions are supported only when branch CSS shape is static/
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("rejects optional calls that can be undefined and lowers nested build-time calls", () => {
      const optionalCall = captureJsxCssPropFailure(
        `
        function App() {
          return <div css={makeRule?.("red")} />;
        }
      `,
        { jsxCssProp: true }
      );
      const nestedCall = babelTransform(
        `
        function makeColor() {
          return "red";
        }

        function App() {
          return <div css={{ color: makeColor() }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(optionalCall.error.message).toContain(
        "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
      );
      expect(optionalCall.code).not.toContain("_css(");
      expect(nestedCall.code).not.toContain(" css=");
      expect(nestedCall.code).not.toContain("style=");
      expect(nestedCall.code).not.toContain("_cx(makeColor");
      expect(nestedCall.code).not.toContain("_css(");
      expect(nestedCall.result[1]).toContain("_css({");
      expect(nestedCall.result[1]).toContain("color: makeColor()");
    });

    it("rejects dynamic key dynamic spread runtime rule shape before emission", () => {
      const fixtures = [
        {
          label: "render computed key",
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported",
          source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
        },
        {
          label: "render spread object",
          expected:
            "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`.",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
        },
        {
          label: "render whole-rule call",
          expected:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
          source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `
        }
      ] as const;

      for (const { label, source, expected } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message.split("\n")[0], label).toBe(expected);
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    describe("Compiled/StyleX/Devup JSX css prop parity integration", () => {
      it("covers Compiled suffix/fallback/css variables and StyleX inheritance guards without the forbidden runtime helper", () => {
        const source = `
          const events: string[] = [];
          const activeColor = {
            get value() {
              events.push("active");
              return "tomato";
            }
          };
          const inactiveColor = {
            get value() {
              events.push("inactive");
              throw new Error("inactive branch evaluated");
            }
          };

          function CompiledSuffixApp(props: {
            gap: number;
            percent: number;
            size: number;
          }) {
            return <div css={{
              width: \`${"${props.size}"}px\`,
              inset: \`${"${props.percent}"}%\`,
              margin: \`${"${props.gap}"}rem\`
            }} />;
          }

          function StyleXChild(value: string | null | undefined | boolean) {
            return <span css={{ color: value }} />;
          }

          function DevupConditionalApp(active: boolean) {
            return <section css={{ color: active ? activeColor.value : inactiveColor.value }} />;
          }
        `;
        const { result, code } = babelTransform(source, { jsxCssProp: true });
        const observed = runJsxCssPropRuntime(
          source,
          `
          const child = StyleXChild(null);
          const conditional = DevupConditionalApp(true);
          return {
            child,
            conditional,
            events
          };
        `
        );
        // Assembled so the bare-token assertion below cannot match its own fixture.
        const forbiddenRuntimeHelper = ["i", "x"].join("");

        expect(result[1]).toContain('from "@mincho-js/css"');
        expect(result[1]).toContain("css as _css");
        expect(result[1]).toMatch(/createVar as _minchoCreateVar\d*/);
        expect(result[1]).toMatch(/getVarName as _minchoGetVarName\d*/);
        expect(result[1]).toMatch(/_css\(\{/);
        expect(code).toContain(
          'import { vx as _vx } from "@mincho-js/transform-runtime";'
        );
        expect(code).toContain('_vx(props.size, "px")');
        expect(code).toContain('_vx(props.percent, "%")');
        expect(code).toContain('_vx(props.gap, "rem")');
        expect(code).toContain("_vx(value)");
        expect(code).not.toContain(" css=");
        expect(code).not.toContain("_css(");
        expect(code).not.toMatch(new RegExp(`\\b${forbiddenRuntimeHelper}\\b`));
        expect(code).not.toMatch(/vx[^\n]+from "@mincho-js\/css"/);
        expect(observed).toEqual({
          child: {
            className: "css-rule",
            style: { "css-rule": "var(--c-, )" }
          },
          conditional: {
            className: "css-rule",
            style: { "css-rule": "tomato" }
          },
          events: ["active"]
        });
      });

      it("covers Compiled conditional spreads and Devup lazy class/style merge order with key/ref", () => {
        const source = `
          const events: string[] = [];
          const explicitRef = "explicit-ref";
          const state = { active: true, fallback: false };
          const pre = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre",
            style: { padding: 4 }
          };
          const post = {
            className: "from-post",
            css: "leak-post",
            title: "from-post",
            style: { margin: 8 }
          };
          const activeColor = {
            get value() {
              events.push("active-fragment");
              return "tomato";
            }
          };
          const fallbackColor = {
            get value() {
              events.push("fallback-fragment");
              return "gold";
            }
          };
          const inactiveColor = {
            get value() {
              events.push("inactive-fragment");
              throw new Error("inactive object fragment evaluated");
            }
          };

          function App() {
            return <div
              key="compiled-key"
              ref={explicitRef}
              {...pre}
              css={{
                display: "block",
                ...state.active && { color: activeColor.value },
                borderColor: state.active ? "black" : inactiveColor.value,
                ...state.fallback || { backgroundColor: fallbackColor.value }
              }}
              style={{ opacity: 0.5 }}
              {...post}
            />;
          }
        `;
        const { code } = babelTransform(source, { jsxCssProp: true });
        const observed = runJsxCssPropRuntime(
          source,
          `
          const props = App();
          return {
            props,
            events,
            hasCss: "css" in props,
            styleKeys: Object.keys(props.style)
          };
        `
        );

        expect(code).not.toContain(" css=");
        expect(code).not.toContain("_css(");
        expect(code).toContain('key="compiled-key"');
        expect(code).toContain("ref={explicitRef}");
        expect(code).not.toContain('key: "compiled-key"');
        expect(code).toContain("...(_minchoCssBranch ?");
        expect(code).toMatch(
          /const _minchoCssBranch\d* = .* \? state\.fallback : void 0;/
        );
        expect(observed).toEqual({
          hasCss: false,
          styleKeys: ["padding", "opacity", "margin", "css-rule"],
          events: ["active-fragment", "fallback-fragment"],
          props: expect.objectContaining({
            key: "compiled-key",
            ref: "explicit-ref",
            id: "from-pre",
            title: "from-post",
            className: expect.stringMatching(
              /^from-pre .*css-rule.* from-post$/
            ),
            style: expect.objectContaining({
              padding: 4,
              opacity: 0.5,
              margin: 8,
              "css-rule": "gold"
            })
          })
        });
      });

      it("covers Compiled/StyleX/Devup unsupported static-shape and dynamic-array diagnostics", () => {
        const fixtures = [
          {
            label: "StyleX static-shape boundary object spread",
            source: `
              function App(props: { styles: Record<string, string> }) {
                return <div css={{ ...props.styles, color: "red" }} />;
              }
            `,
            expected: staticShapeDiagnosticPattern
          },
          {
            label: "Compiled/Devup dynamic array remains unsupported",
            source: `
              function App(props: { gap: number }) {
                return <div css={{ margin: [props.gap, "auto"] }} />;
              }
            `,
            expected:
              /Cannot statically evaluate|Mincho JSX css prop|Mincho `css` requires statically known CSS shape/
          }
        ] as const;

        for (const { label, source, expected } of fixtures) {
          const failure = captureJsxCssPropFailure(source, {
            jsxCssProp: true
          });

          expect(failure.error.message, label).toMatch(expected);
          expect(failure.code, label).not.toContain("_css(");
          expect(failure.code, label).not.toContain("style={{");
        }
      });
    });

    it("maps partial evaluator deopt diagnostics and preserves unchanged diagnostics", () => {
      const depthBindingCount =
        STATIC_CSS_EVAL_LIMITS.maxObjectArrayRecursionDepth + 1;
      const depthBindings = Array.from(
        { length: depthBindingCount },
        (_, index) => {
          const next =
            index === depthBindingCount - 1
              ? `{ color: "red" }`
              : `style${index + 1}`;
          return `const style${index} = ${next};`;
        }
      ).join("\n");
      const largeStylePropertyCount =
        STATIC_CSS_EVAL_LIMITS.maxStaticLiteralNodeCount + 1;
      const largeStyle = Array.from(
        { length: largeStylePropertyCount },
        (_, index) => `p${index}: "${index}"`
      ).join(",");
      const fixtures = [
        {
          reason: "mutated-binding",
          expected:
            'Cannot statically evaluate css prop value: same-file binding "style" is mutated',
          source: `
            const style = { color: "red" };
            style.color = "blue";
            function App() {
              return <div css={style} />;
            }
          `
        },
        {
          reason: "unsupported-call-expression",
          expected:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel",
          source: `
            function App(props: { makeRule: () => Record<string, string> }) {
              return <div css={props.makeRule()} />;
            }
          `
        },
        {
          reason: "non-static-object-key",
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported",
          source: `
            function App(props: { key: string }) {
              return <div css={{ [props.key]: "red" }} />;
            }
          `
        },
        {
          reason: "unsupported-spread",
          expected:
            "Mincho `css` requires statically known CSS shape. Plain runtime declaration objects belong in React `style={...}`.",
          source: `
            function App(props: { styles: Record<string, string> }) {
              return <div css={{ ...props.styles, color: "red" }} />;
            }
          `
        },
        {
          reason: "unsupported-computed-member",
          expected:
            "Cannot statically evaluate css prop value: computed member access is unsupported",
          source: `
            const styles = { button: { color: "red" } };
            function App(variant: string) {
              return <div css={styles[variant]} />;
            }
          `
        },
        {
          reason: "runtime-css-shape",
          expected:
            "Cannot statically evaluate css prop value: dynamic expression is unsupported: ObjectMethod",
          source: `
            function App() {
              return <div css={{ color() { return "red"; } }} />;
            }
          `
        },
        {
          reason: "unsupported-template-interpolation",
          expected:
            "Cannot statically evaluate css prop value: template interpolation references a render-scope member",
          source: `
            function App(props: { color: string }) {
              return <div css={{ color: \`${"${props.color}"}\` }} />;
            }
          `
        },
        {
          reason: "cycle-detected",
          expected:
            'Cannot statically evaluate css prop value: binding cycle detected while resolving "styleA"',
          source: `
            const styleA = styleB;
            const styleB = styleA;
            function App() {
              return <div css={styleA} />;
            }
          `
        },
        {
          reason: "depth-limit",
          expected:
            "Cannot statically evaluate css prop value: partial evaluator depth limit exceeded",
          source: `
            ${depthBindings}
            function App() {
              return <div css={style0} />;
            }
          `
        },
        {
          reason: "node-count-limit",
          expected:
            "Cannot statically evaluate css prop value: partial evaluator node count limit exceeded",
          source: `
            function App() {
              return <div css={{ ${largeStyle} }} />;
            }
          `
        }
      ] as const;

      for (const { reason, source, expected } of fixtures) {
        let failure: ReturnType<typeof captureJsxCssPropFailure>;

        try {
          failure = captureJsxCssPropFailure(source, { jsxCssProp: true });
        } catch (error) {
          throw new Error(
            `${reason}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        expect(failure.error.message.split("\n")[0], reason).toBe(expected);
        expect(failure.code, reason).not.toContain("_css(");
        expect(failure.code, reason).not.toContain("style={{");
      }
    });

    it("preserves provider reexport diagnostic over partial evaluator deopt", () => {
      const failure = captureJsxCssPropFailure(
        `
          import { button } from "./barrel";
          function App() {
            return <div css={{ color: button }} />;
          }
        `,
        {
          jsxCssProp: true,
          staticCssEvalProvider:
            createUnsupportedReexportStaticCssEvalProvider()
        }
      );

      expect(failure.error.message).toContain(
        'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
      );
      expect(failure.error.message).not.toContain(
        "imported binding must be resolved by the static css provider"
      );
      expect(failure.code).not.toContain("_css(");
    });

    it("fails closed for dynamic computed optional and template expression css rules", () => {
      const fixtures = [
        {
          label: "computed member rule",
          source: `
            const styles = { button: { color: "red" } };
            function App(variant) {
              return <div css={styles[variant]} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: computed member access is unsupported"
        },
        {
          label: "optional member rule",
          source: `
            const styles = null;
            function App() {
              return <div css={styles?.button} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: dynamic expression is unsupported: OptionalMemberExpression"
        },
        {
          label: "template call property value",
          source: `
            function getColor() {
              return "red";
            }
            function App() {
              return <div css={{ color: \`\${getColor()}\` }} />;
            }
          `,
          expectedFirstLine:
            "Cannot statically evaluate css prop value: call expressions are not evaluated by Babel"
        }
      ] as const;

      for (const { label, source, expectedFirstLine } of fixtures) {
        const failure = captureJsxCssPropFailure(source, { jsxCssProp: true });

        expect(failure.error.message.split("\n")[0], label).toBe(
          expectedFirstLine
        );
        expect(failure.code, label).not.toContain("_css(");
        expect(failure.code, label).not.toContain("style={{");
      }
    });

    it("keeps class-value array calls out of direct rule-call lowering", () => {
      const { result, code } = babelTransform(
        `
        function makeRule(color: string) {
          return { color };
        }

        function App() {
          return <div css={["base", makeRule("red")]} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx("base", makeRule("red"))}');
      expect(code).not.toContain("_$mincho$$App");
      expect(result[1]).not.toContain("_css(");
    });

    it("keeps activeClass primitive and cx css props in class-value mode", () => {
      const { result, code } = babelTransform(
        `
        import { cx } from "@mincho-js/css";

        const activeClass = "active";

        function App() {
          return <>
            <div css={activeClass} />
            <div css={0} />
            <div css={cx(activeClass)} />
          </>;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(activeClass)}");
      expect(code).toContain("className={_cx(0)}");
      expect(code).toContain("className={_cx(cx(activeClass))}");
      expect(result[1]).not.toContain("_css(");
    });

    it("lowers identifier css result through cx without double wrapping", () => {
      const { result, code } = babelTransform(
        `
        import { css } from "@mincho-js/css";

        const styleA = css({ color: "red" });

        function App() {
          return <div css={styleA} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(styleA)}");
      expect(code).not.toContain("_css(styleA)");
      expect(code).not.toContain("css(styleA)");
    });

    it("lowers non-null identifier css result through cx without double wrapping", () => {
      const { code } = babelTransform(
        `
        const styleA = "base";

        function App() {
          return <div css={styleA!} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(styleA)}");
      expect(code).not.toContain("_css(styleA)");
      expect(code).not.toContain("css(styleA)");
    });

    it("keeps inline object class dictionary syntax in css rule mode", () => {
      const { result, code } = babelTransform(
        `
        const isActive = true;

        function App() {
          return <div css={{ active: isActive }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(result[1]).toContain("active: isActive");
      expect(code).toContain("className={_$mincho$$App2}");
      expect(code).not.toContain("_cx({");
    });

    it("lowers custom component class-value jsx css prop through cx", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "base";

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={styleA} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("return <Button className={_cx(styleA)} />");
    });

    it("forwards expression css prop through custom component className", () => {
      const { code } = babelTransform(
        `
        const flag = true;

        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={flag && "active"} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).toContain(
        'return <Button className={_cx(flag && "active")} />'
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_css(flag &&");
    });

    it("lowers custom component inline object jsx css prop through css rule mode", () => {
      const { result, code } = babelTransform(
        `
        function Button(props) {
          return <button {...props} />;
        }

        function App() {
          return <Button css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
      expect(code).not.toContain(" css=");
      expect(code).toContain("return <Button className={_$mincho$$App2} />");
    });

    it("lowers member-expression class-value jsx css prop through cx", () => {
      const { result, code } = babelTransform(
        `
        const motion = { div: "div" };
        const styleA = "base";

        function App() {
          return <motion.div css={styleA} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("return <motion.div className={_cx(styleA)} />");
    });

    it("lowers custom element class-value jsx css prop through className", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "base";

        function App() {
          return <my-element css={styleA} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("return <my-element className={_cx(styleA)} />");
      expect(code).not.toContain("<my-element class=");
    });

    it("lowers mixed conditional rule branches across jsx target kinds", () => {
      const fixtures = [
        {
          fixture: `<div css={condition ? { color: "red" } : styleA} />`,
          expectedClassName:
            /return <div className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
        },
        {
          fixture: `<Button css={condition ? { color: "red" } : styleA} />`,
          expectedClassName:
            /return <Button className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
        },
        {
          fixture: `<motion.div css={condition ? { color: "red" } : styleA} />`,
          expectedClassName:
            /return <motion\.div className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
        },
        {
          fixture: `<my-element css={condition ? { color: "red" } : styleA} />`,
          expectedClassName:
            /return <my-element className=\{_cx\(condition \? _\$mincho\$\$App\d+ : styleA\)\} \/>/
        }
      ] as const;

      for (const { fixture, expectedClassName } of fixtures) {
        const { result, code } = babelTransform(
          `
          const condition = true;
          const styleA = "style-a";
          const motion = { div: "div" };

          function Button(props) {
            return <button {...props} />;
          }

          function App() {
            return ${fixture};
          }
        `,
          { jsxCssProp: true }
        );
        const output = `${code}\n${result.join("\n")}`;

        expect(code).not.toContain(" css=");
        expect(code).toMatch(expectedClassName);
        expect(code).toMatch(/condition \? _\$mincho\$\$App\d+ : styleA/);
        expect(code).not.toContain("<my-element class=");
        expect(output).not.toContain("_css(condition ?");
        expect(output).not.toContain("css(condition ?");
        expect(output).not.toContain("_css(styleA)");
        expect(output).not.toContain("css(styleA)");
        expect(result[1]).toContain("_css({");
        expect(result[1]).toContain('color: "red"');
      }
    });

    it("css before a spread lowers explicit css before post-spread className", () => {
      const source = `
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const output = `${code}\n${result.join("\n")}`;
      const observed = runJsxCssPropRuntime(source, "return App();") as Record<
        string,
        unknown
      >;

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).not.toContain("(() =>");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
      expect(code).toContain("className={_cx(styleA, _minchoClassName)}");
      expect(output).not.toContain("className={_cx(_minchoClassName, styleA)}");
      expect(observed).toMatchObject({
        className: "style-a base",
        id: "root"
      });
      expect("css" in observed).toBe(false);

      const spreadOnly = babelTransform(
        `
        const styleA = "style-a";

        function App() {
          return <div {...{ css: styleA }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(spreadOnly.code).toContain("css: styleA");
      expect(spreadOnly.code).not.toContain("className=");
      expect(spreadOnly.code).not.toContain("_cx");
    });

    it("mixed spread around css preserves source-group className and prop overrides", () => {
      const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a",
          title: "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          title: "from-b"
        };

        function App() {
          return <div {...a} css={styleA} {...b} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(source, "return App();") as Record<
        string,
        unknown
      >;

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(observed).toMatchObject({
        className: "from-a style-a from-b",
        id: "from-a",
        title: "from-b"
      });
      expect("css" in observed).toBe(false);
    });

    it("multiple post-css spreads use the final post group className", () => {
      const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          id: "from-b",
          title: "from-b"
        };

        function App() {
          return <div css={styleA} {...a} {...b} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(source, "return App();") as Record<
        string,
        unknown
      >;

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(observed).toMatchObject({
        className: "style-a from-b",
        id: "from-b",
        title: "from-b"
      });
      expect("css" in observed).toBe(false);
    });

    it("interleaved post-css attributes preserve object-spread overrides", () => {
      const source = `
        const styleA = "style-a";
        const a = {
          className: "from-a",
          css: "leak-a",
          id: "from-a",
          title: "from-a",
          "data-source": "from-a"
        };
        const b = {
          className: "from-b",
          css: "leak-b",
          title: "from-b",
          "data-source": "from-b"
        };

        function App() {
          return <div css={styleA} {...a} id="later" data-source="later" {...b} />;
        }
      `;
      const { result, code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(source, "return App();") as Record<
        string,
        unknown
      >;

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(observed).toMatchObject({
        className: "style-a from-b",
        id: "later",
        title: "from-b"
      });
      expect(observed["data-source"]).toBe("from-b");
      expect("css" in observed).toBe(false);
    });

    it("aggregates spread props before explicit class-value css prop", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("..._minchoRest");
      expect(code).toContain("className={_cx(_minchoClassName, styleA)}");
    });

    it("aggregates multiple spreads and className before inline object css prop", () => {
      const { result, code } = babelTransform(
        `
        const a = { id: "a" };
        const b = { className: "from-b" };

        function App() {
          return <div {...a} className="base" {...b} css={{ color: "red" }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
      expect(code).not.toContain(" css=");
      expect(code).toContain("...a");
      expect(code).toContain('className: "base"');
      expect(code).toContain("...b");
      expect(code).toContain(
        "className={_cx(_minchoClassName, _$mincho$$App2)}"
      );
    });

    it("aggregates spread props before conditional object css prop branches", () => {
      const { result, code } = babelTransform(
        `
        const condition = true;
        const styleA = "style-a";
        const props = {
          className: "base",
          css: "leaked",
          id: "root"
        };

        function App() {
          return <div {...props} css={condition ? { color: "red" } : styleA} />;
        }
      `,
        { jsxCssProp: true }
      );
      const output = `${code}\n${result.join("\n")}`;

      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
      expect(code).toContain("<div {..._minchoRest} className=");
      expect(code).toMatch(
        /className=\{_cx\(_minchoClassName, condition \? _\$mincho\$\$App\d+ : styleA\)\}/
      );
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("css(condition ?");
      expect(output).not.toContain("_css(styleA)");
      expect(output).not.toContain("css(styleA)");
      expect(result[1]).toContain("_css({");
      expect(result[1]).toContain('color: "red"');
    });

    it("evaluates explicit css before post-css spread in source order", () => {
      const observed = runJsxCssPropRuntime(
        `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const style = () => {
          events.push("style");
          return "style-a";
        };
        const spread = () => {
          events.push("spread");
          return { className: "from-spread", css: "leak", id: "root" };
        };

        function App() {
          return <div css={cx(style())} {...spread()} />;
        }
      `,
        "return { props: App(), events };"
      ) as { props: Record<string, unknown>; events: string[] };

      expect(observed.events).toEqual(["style", "spread"]);
      expect(observed.props).toMatchObject({
        className: "style-a from-spread",
        id: "root"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads explicit css getter before post-css spread once in source order", () => {
      const observed = runJsxCssPropRuntime(
        `
        const events: string[] = [];
        let styleReads = 0;
        const style = {
          get value() {
            styleReads += 1;
            events.push("style");
            return "style-a";
          }
        };
        const spread = () => {
          events.push("spread");
          return { className: "from-spread", css: "leak", id: "root" };
        };

        function App() {
          return <div css={style.value} {...spread()} />;
        }
      `,
        "return { props: App(), events, styleReads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        styleReads: number;
      };

      expect(observed.events).toEqual(["style", "spread"]);
      expect(observed.styleReads).toBe(1);
      expect(observed.props).toMatchObject({
        className: "style-a from-spread",
        id: "root"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads post-spread className getter once through aggregate props", () => {
      const observed = runJsxCssPropRuntime(
        `
        const styleA = "style-a";
        let classNameReads = 0;
        const props = {
          get className() {
            classNameReads += 1;
            return "from-spread";
          },
          css: "leak",
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `,
        "return { props: App(), classNameReads };"
      ) as { props: Record<string, unknown>; classNameReads: number };

      expect(observed.classNameReads).toBe(1);
      expect(observed.props).toMatchObject({
        className: "style-a from-spread",
        id: "root"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads stripped post-spread css getter once through aggregate props", () => {
      const observed = runJsxCssPropRuntime(
        `
        const styleA = "style-a";
        let cssReads = 0;
        const props = {
          className: "from-spread",
          get css() {
            cssReads += 1;
            return "leak";
          },
          id: "root"
        };

        function App() {
          return <div css={styleA} {...props} />;
        }
      `,
        "return { props: App(), cssReads };"
      ) as { props: Record<string, unknown>; cssReads: number };

      expect(observed.cssReads).toBe(1);
      expect(observed.props).toMatchObject({
        className: "style-a from-spread",
        id: "root"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads mixed pre and post spread getters once in source order", () => {
      const observed = runJsxCssPropRuntime(
        `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const reads = {
          preClassName: 0,
          preCss: 0,
          style: 0,
          postClassName: 0,
          postCss: 0
        };
        const pre = {
          id: "from-pre",
          get className() {
            reads.preClassName += 1;
            events.push("pre.className");
            return "from-pre";
          },
          get css() {
            reads.preCss += 1;
            events.push("pre.css");
            return "leak-pre";
          }
        };
        const style = () => {
          reads.style += 1;
          events.push("style");
          return "style-a";
        };
        const post = {
          title: "from-post",
          get className() {
            reads.postClassName += 1;
            events.push("post.className");
            return "from-post";
          },
          get css() {
            reads.postCss += 1;
            events.push("post.css");
            return "leak-post";
          }
        };

        function App() {
          return <div {...pre} css={cx(style())} {...post} />;
        }
      `,
        "return { props: App(), events, reads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(observed.events).toEqual([
        "pre.className",
        "pre.css",
        "style",
        "post.className",
        "post.css"
      ]);
      expect(observed.reads).toEqual({
        preClassName: 1,
        preCss: 1,
        style: 1,
        postClassName: 1,
        postCss: 1
      });
      expect(observed.props).toMatchObject({
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("evaluates spread aggregation inputs once in source order", () => {
      const observed = runJsxCssPropRuntime(
        `
        const styleA = "style-a";
        const events: string[] = [];
        const spreadA = () => {
          events.push("spread-a");
          return { id: "a", className: "from-a", css: "leak-a" };
        };
        const spreadB = () => {
          events.push("spread-b");
          return { title: "b", className: "from-b", css: "leak-b" };
        };
        const named = () => {
          events.push("className");
          return "base";
        };

        function App() {
          return <div {...spreadA()} className={named()} {...spreadB()} css={styleA} />;
        }
      `,
        "return { props: App(), events };"
      ) as { props: Record<string, unknown>; events: string[] };

      expect(observed.events).toEqual(["spread-a", "className", "spread-b"]);
      expect(observed.props).toMatchObject({
        id: "a",
        title: "b",
        className: "from-b style-a"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads spread-provided className once through aggregate props", () => {
      const observed = runJsxCssPropRuntime(
        `
        const styleA = "style-a";
        let classNameReads = 0;
        const props = {
          get className() {
            classNameReads += 1;
            return "base";
          },
          css: "leak",
          id: "root"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
        "return { props: App(), classNameReads };"
      ) as { props: Record<string, unknown>; classNameReads: number };

      expect(observed.classNameReads).toBe(1);
      expect(observed.props).toMatchObject({
        id: "root",
        className: "base style-a"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("reads branch-lowered spread and className getters once in source order", () => {
      const observed = runJsxCssPropRuntime(
        `
        const condition = true;
        const styleA = "style-a";
        const events: string[] = [];
        const reads = {
          spreadA: 0,
          explicit: 0,
          spreadB: 0
        };
        const spreadA = {
          id: "a",
          get className() {
            reads.spreadA += 1;
            events.push("spread-a.className");
            return "from-a";
          },
          css: "leak-a"
        };
        const explicitClassName = {
          get value() {
            reads.explicit += 1;
            events.push("explicit.className");
            return "base";
          }
        };
        const spreadB = {
          title: "b",
          get className() {
            reads.spreadB += 1;
            events.push("spread-b.className");
            return "from-b";
          },
          css: "leak-b"
        };

        function App() {
          return <div {...spreadA} className={explicitClassName.value} {...spreadB} css={condition ? { color: "red" } : styleA} />;
        }
      `,
        "return { props: App(), events, reads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(observed.events).toEqual([
        "spread-a.className",
        "explicit.className",
        "spread-b.className"
      ]);
      expect(observed.reads).toEqual({
        spreadA: 1,
        explicit: 1,
        spreadB: 1
      });
      expect(observed.props).toMatchObject({
        id: "a",
        title: "b",
        className: "from-b css-rule"
      });
      expect("css" in observed.props).toBe(false);
    });

    it("preserves explicit key/ref attributes during spread aggregation", () => {
      const source = `
        const styleA = "style-a";
        const explicitRef = "explicit-ref";
        const pre = { className: "from-pre", css: "leak-pre", id: "from-pre" };
        const post = { className: "from-post", css: "leak-post", title: "from-post" };
        const keyedPre = { key: "spread-pre-key", ref: "spread-pre-ref" };
        const keyedPost = { key: "spread-post-key", ref: "spread-post-ref" };

        function BeforeApp() {
          return <div key="before-key" ref={explicitRef} {...pre} css={styleA} />;
        }

        function AfterApp() {
          return <section {...pre} css={styleA} key="after-key" ref={explicitRef} {...post} />;
        }

        function LateBeforeApp() {
          return <aside {...keyedPre} key="late-before-key" ref={explicitRef} css={styleA} />;
        }

        function LateAfterApp() {
          return <main css={styleA} {...keyedPost} key="late-after-key" ref={explicitRef} />;
        }

        function DynamicApp(color: string) {
          return <article css={{ color }} {...keyedPost} key="dynamic-key" ref={explicitRef} />;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `
        return {
          before: BeforeApp(),
          after: AfterApp(),
          lateBefore: LateBeforeApp(),
          lateAfter: LateAfterApp(),
          dynamic: DynamicApp("red")
        };
      `
      ) as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        lateBefore: Record<string, unknown>;
        lateAfter: Record<string, unknown>;
        dynamic: Record<string, unknown>;
      };

      expect(code).not.toContain(" css=");
      expect(code).toContain('key="before-key"');
      expect(code).toContain("ref={explicitRef}");
      expect(code).toContain('key="after-key"');
      expect(code).not.toContain('key: "before-key"');
      expect(code).not.toContain('key: "after-key"');
      expect(observed.before).toMatchObject({
        key: "before-key",
        ref: "explicit-ref",
        id: "from-pre",
        className: "from-pre style-a"
      });
      expect(observed.after).toMatchObject({
        key: "after-key",
        ref: "explicit-ref",
        id: "from-pre",
        title: "from-post",
        className: "from-pre style-a from-post"
      });
      expect(observed.lateBefore).toMatchObject({
        key: "late-before-key",
        ref: "explicit-ref"
      });
      expect(observed.lateAfter).toMatchObject({
        key: "late-after-key",
        ref: "explicit-ref"
      });
      expect(observed.dynamic).toMatchObject({
        key: "dynamic-key",
        ref: "explicit-ref"
      });
      expect(observed.before).not.toHaveProperty("css");
      expect(observed.after).not.toHaveProperty("css");
    });

    it("keeps spread-contained key/ref semantics during spread aggregation", () => {
      const observed = runJsxCssPropRuntime(
        `
        const styleA = "style-a";
        const props = {
          className: "from-spread",
          css: "leak",
          id: "root",
          key: "spread-key",
          ref: "spread-ref"
        };

        function App() {
          return <div {...props} css={styleA} />;
        }
      `,
        "return App();"
      ) as Record<string, unknown>;

      expect(observed).toMatchObject({
        key: "spread-key",
        ref: "spread-ref",
        id: "root",
        className: "from-spread style-a"
      });
      expect(observed).not.toHaveProperty("css");
    });

    it("reads nested mixed pre css post aggregation once in source order", () => {
      const source = `
        import { cx } from "@mincho-js/css";

        const events: string[] = [];
        const reads = {
          preClassName: 0,
          preCss: 0,
          style: 0,
          postClassName: 0,
          postCss: 0
        };
        const pre = {
          id: "from-pre",
          get className() {
            reads.preClassName += 1;
            events.push("pre.className");
            return "from-pre";
          },
          get css() {
            reads.preCss += 1;
            events.push("pre.css");
            return "leak-pre";
          }
        };
        const style = () => {
          reads.style += 1;
          events.push("style");
          return "style-a";
        };
        const post = {
          title: "from-post",
          get className() {
            reads.postClassName += 1;
            events.push("post.className");
            return "from-post";
          },
          get css() {
            reads.postCss += 1;
            events.push("post.css");
            return "leak-post";
          }
        };

        function App() {
          const renderValue = () => <div {...pre} css={cx(style())} {...post} />;
          return renderValue();
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        "return { props: App(), events, reads };"
      ) as {
        props: Record<string, unknown>;
        events: string[];
        reads: Record<string, number>;
      };

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
      expect(observed.events).toEqual([
        "pre.className",
        "pre.css",
        "style",
        "post.className",
        "post.css"
      ]);
      expect(observed.reads).toEqual({
        preClassName: 1,
        preCss: 1,
        style: 1,
        postClassName: 1,
        postCss: 1
      });
      expect(observed.props).toMatchObject({
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      });
      expect("css" in observed.props).toBe(false);
    });

    const nestedUntakenBranchLazinessFixtures = [
      {
        name: "keeps conditional untaken nested spread aggregation lazy",
        body: `return false ? <div css={style()} {...post()} /> : "alternate";`,
        expectedValue: "alternate"
      },
      {
        name: "keeps logical AND untaken nested spread aggregation lazy",
        body: `return false && <div css={style()} {...post()} />;`,
        expectedValue: false
      },
      {
        name: "keeps logical OR untaken nested spread aggregation lazy",
        body: `return "fallback" || <div css={style()} {...post()} />;`,
        expectedValue: "fallback"
      },
      {
        name: "keeps nullish untaken nested spread aggregation lazy",
        body: `return "fallback" ?? <div css={style()} {...post()} />;`,
        expectedValue: "fallback"
      }
    ] as const;

    for (const {
      name,
      body,
      expectedValue
    } of nestedUntakenBranchLazinessFixtures) {
      it(name, () => {
        const source = `
          const events: string[] = [];
          const style = () => {
            events.push("style");
            return "style-a";
          };
          const post = () => {
            events.push("post");
            return { className: "from-post", css: "leak-post" };
          };

          function App() {
            ${body}
          }
        `;
        const { code } = babelTransform(source, { jsxCssProp: true });
        const observed = runJsxCssPropRuntime(
          source,
          "return { value: App(), events };"
        ) as { value: unknown; events: string[] };

        expect(code).not.toContain(" css=");
        expect(code).toContain("(() =>");
        expect(observed.value).toBe(expectedValue);
        expect(observed.events).toEqual([]);
      });
    }

    it("preserves lexical this and arguments in nested moved expressions", () => {
      const source = `
        function App() {
          const renderValue = () => (
            <div
              {...this.preProps}
              className={arguments[0]}
              css={this.style}
              {...this.postProps}
            />
          );
          return renderValue();
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(
        source,
        `return App.call({
          preProps: { className: "from-this-pre", css: "leak-pre", id: "from-this" },
          style: "style-from-this",
          postProps: { className: "from-this-post", css: "leak-post", title: "post" }
        }, "from-arguments");`
      ) as Record<string, unknown>;

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
      expect(observed).toMatchObject({
        className: "from-arguments style-from-this from-this-post",
        id: "from-this",
        title: "post"
      });
      expect("css" in observed).toBe(false);
    });

    const nestedAsyncGeneratorRejectionFixtures = [
      {
        name: "rejects nested await inside moved css expression",
        source: `
          async function getStyle() {
            return "style-a";
          }
          const props = { className: "base" };

          async function App(ok) {
            return ok ? <div css={await getStyle()} {...props} /> : null;
          }
        `
      },
      {
        name: "rejects nested yield inside moved spread expression",
        source: `
          const styleA = "style-a";

          function* App(ok) {
            return ok ? <div {...(yield getProps())} css={styleA} /> : null;
          }
        `
      },
      {
        name: "rejects nested yield inside moved className expression",
        source: `
          const styleA = "style-a";
          const props = { className: "from-post" };

          function* App(ok) {
            return ok ? <div className={(yield getClassName())} css={styleA} {...props} /> : null;
          }
        `
      }
    ] as const;

    for (const { name, source } of nestedAsyncGeneratorRejectionFixtures) {
      it(name, () => {
        expect(() => babelTransform(source, { jsxCssProp: true })).toThrow(
          jsxCssPropErrorMessages.nestedAsyncGenerator
        );
      });
    }

    it("keeps direct await and yield spread aggregation on statement hoist path", () => {
      const directAsync = babelTransform(
        `
          async function getStyle() {
            return "style-a";
          }
          const props = { className: "base" };

          async function App() {
            return <div css={await getStyle()} {...props} />;
          }
        `,
        { jsxCssProp: true }
      );
      const directGenerator = babelTransform(
        `
          const styleA = "style-a";

          function* App() {
            return <div {...(yield getProps())} css={styleA} />;
          }
        `,
        { jsxCssProp: true }
      );

      expect(directAsync.code).not.toContain(" css=");
      expect(directAsync.code).not.toContain("(() =>");
      expect(directAsync.code).toContain("await getStyle()");
      expect(directGenerator.code).not.toContain(" css=");
      expect(directGenerator.code).not.toContain("(() =>");
      expect(directGenerator.code).toContain("yield getProps()");
    });

    it("leaves spread-only runtime css props untransformed", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";

        function App() {
          return <div {...{ css: styleA }} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
      expect(code).toContain("css: styleA");
      expect(code).not.toContain("className=");
      expect(code).not.toContain("_cx");
    });

    it("leaves nested spread-only runtime css props untransformed", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";

        function App() {
          const renderValue = () => <div {...{ css: styleA }} />;
          return renderValue();
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toBe("");
      expect(code).toContain("css: styleA");
      expect(code).not.toContain("className=");
      expect(code).not.toContain("_cx");
      expect(code).not.toContain("(() =>");
    });

    it("accepts direct post-css expression statement aggregation before unsupported context checks", () => {
      const { result, code } = babelTransform(
        `
        const styleA = "style-a";
        const props = { className: "base", css: "leaked", id: "root" };

        function App() {
          <div css={styleA} {...props} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("..._minchoRest");
      expect(code).toContain("className={_cx(styleA, _minchoClassName)}");
      expect(code).not.toContain("(() =>");
    });

    it("accepts unbraced if return consequent mixed spread aggregation through arrow IIFE", () => {
      const source = `
        const styleA = "style-a";
        const preProps = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre"
        };
        const postProps = {
          className: "from-post",
          css: "leak-post",
          title: "from-post"
        };

        function App(ok) {
          if (ok) return <div {...preProps} css={styleA} {...postProps} />;
          return null;
        }
      `;
      const { code } = babelTransform(source, { jsxCssProp: true });
      const observed = runJsxCssPropRuntime(source, "return App(true);");

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
      expect(observed).toMatchObject({
        className: "from-pre style-a from-post",
        id: "from-pre",
        title: "from-post"
      });
      expect(observed).not.toHaveProperty("css");
    });

    it("accepts unbraced if expression-statement mixed spread aggregation through arrow IIFE", () => {
      const { code } = babelTransform(
        `
        const styleA = "style-a";
        const preProps = {
          className: "from-pre",
          css: "leak-pre",
          id: "from-pre"
        };
        const postProps = {
          className: "from-post",
          css: "leak-post",
          title: "from-post"
        };

        function App(ok) {
          if (ok) <div {...preProps} css={styleA} {...postProps} />;
        }
      `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("(() =>");
    });

    const nestedSpreadAggregationRuntimeFixtures = [
      {
        name: "accepts expression-bodied arrow post-css spread aggregation",
        body: `const renderValue = () => <div css={styleA} {...postProps} />;
          return renderValue();`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts expression-bodied arrow mixed spread aggregation",
        body: `const renderValue = () => <div {...preProps} css={styleA} {...postProps} />;
          return renderValue();`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts conditional post-css spread aggregation",
        body: `return ok ? <div css={styleA} {...postProps} /> : null;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts conditional mixed spread aggregation",
        body: `return ok ? <div {...preProps} css={styleA} {...postProps} /> : null;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts logical post-css spread aggregation",
        body: `return ok && <div css={styleA} {...postProps} />;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts logical mixed spread aggregation",
        body: `return ok && <div {...preProps} css={styleA} {...postProps} />;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts logical-or post-css spread aggregation",
        body: `return fallback || <div css={styleA} {...postProps} />;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts nullish coalescing post-css spread aggregation",
        body: `return fallback ?? <div css={styleA} {...postProps} />;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts sequence expression post-css spread aggregation",
        body: `return (0, <div css={styleA} {...postProps} />);`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts call argument post-css spread aggregation",
        body: `return render(<div css={styleA} {...postProps} />);`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts call argument mixed spread aggregation",
        body: `return render(<div {...preProps} css={styleA} {...postProps} />);`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts first new argument post-css spread aggregation",
        body: `return new FirstBox(<div css={styleA} {...postProps} />).value;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts first new argument mixed spread aggregation",
        body: `return new FirstBox(<div {...preProps} css={styleA} {...postProps} />).value;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts later new argument post-css spread aggregation",
        body: `return new SecondBox("label", <div css={styleA} {...postProps} />).value;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts later new argument mixed spread aggregation",
        body: `return new SecondBox("label", <div {...preProps} css={styleA} {...postProps} />).value;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts direct variable initializer post-css spread aggregation",
        body: `const value = <div css={styleA} {...postProps} />;
          return value;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts direct variable initializer mixed spread aggregation",
        body: `const value = <div {...preProps} css={styleA} {...postProps} />;
          return value;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts assignment RHS post-css spread aggregation",
        body: `let value = null;
          value = <div css={styleA} {...postProps} />;
          return value;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts assignment RHS mixed spread aggregation",
        body: `let value = null;
          value = <div {...preProps} css={styleA} {...postProps} />;
          return value;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts array expression member post-css spread aggregation",
        body: `const values = [<div css={styleA} {...postProps} />];
          return values[0];`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts array expression member mixed spread aggregation",
        body: `const values = [<div {...preProps} css={styleA} {...postProps} />];
          return values[0];`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts object property value post-css spread aggregation",
        body: `const values = { item: <div css={styleA} {...postProps} /> };
          return values.item;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts object property value mixed spread aggregation",
        body: `const values = { item: <div {...preProps} css={styleA} {...postProps} /> };
          return values.item;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      },
      {
        name: "accepts JSX attribute expression container post-css spread aggregation",
        body: `return (<Wrapper child={<div css={styleA} {...postProps} />} />).child;`,
        expectedProps: {
          className: "style-a from-post",
          title: "from-post"
        }
      },
      {
        name: "accepts JSX attribute expression container mixed spread aggregation",
        body: `return (<Wrapper child={<div {...preProps} css={styleA} {...postProps} />} />).child;`,
        expectedProps: {
          className: "from-pre style-a from-post",
          id: "from-pre",
          title: "from-post"
        }
      }
    ] as const;

    for (const {
      name,
      body,
      expectedProps
    } of nestedSpreadAggregationRuntimeFixtures) {
      it(name, () => {
        const source = `
          const styleA = "style-a";
          const preProps = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre"
          };
          const postProps = {
            className: "from-post",
            css: "leak-post",
            title: "from-post"
          };
          const fallback = null;

          function render(value) {
            return value;
          }

          function Wrapper() {}

          function FirstBox(value) {
            this.value = value;
          }

          function SecondBox(_label, value) {
            this.value = value;
          }

          function App(ok) {
            ${body}
          }
        `;
        const { code } = babelTransform(source, { jsxCssProp: true });
        const observed = runJsxCssPropRuntime(source, "return App(true);");

        expect(code).not.toContain(" css=");
        expect(code).toContain("(() =>");
        expect(observed).toMatchObject(expectedProps);
        expect(observed).not.toHaveProperty("css");
      });
    }

    it("executes fragment-wrapped JSX css prop output", () => {
      expect(
        runJsxCssPropRuntime(
          `
            function App() {
              return <><div css="base" /></>;
            }
          `,
          "return App();"
        )
      ).toEqual({});
    });

    const nestedSpreadAggregationCodeFixtures = [
      {
        name: "accepts fragment child post-css spread aggregation",
        body: `return <><div css={styleA} {...postProps} /></>;`,
        expectedCodeSubstrings: [
          "{(() =>",
          "css: _minchoCssProp",
          "className: _minchoClassName",
          "..._minchoRest"
        ]
      },
      {
        name: "accepts fragment child mixed spread aggregation",
        body: `return <><div {...preProps} css={styleA} {...postProps} /></>;`,
        expectedCodeSubstrings: [
          "{(() =>",
          "css: _minchoPreCssProp",
          "className: _minchoPreClassName",
          "..._minchoPreRest",
          "css: _minchoPostCssProp",
          "className: _minchoPostClassName",
          "..._minchoPostRest"
        ]
      },
      {
        name: "accepts normal element child post-css spread aggregation",
        body: `return <section><div css={styleA} {...postProps} /></section>;`,
        expectedCodeSubstrings: [
          "{(() =>",
          "css: _minchoCssProp",
          "className: _minchoClassName",
          "..._minchoRest"
        ]
      },
      {
        name: "accepts normal element child mixed spread aggregation",
        body: `return <section><div {...preProps} css={styleA} {...postProps} /></section>;`,
        expectedCodeSubstrings: [
          "{(() =>",
          "css: _minchoPreCssProp",
          "className: _minchoPreClassName",
          "..._minchoPreRest",
          "css: _minchoPostCssProp",
          "className: _minchoPostClassName",
          "..._minchoPostRest"
        ]
      },
      {
        name: "accepts template interpolation post-css spread aggregation",
        body: "const label = `${<div css={styleA} {...postProps} />}`;\n          return label;",
        expectedCodeSubstrings: [
          "${(() =>",
          "css: _minchoCssProp",
          "className: _minchoClassName",
          "..._minchoRest"
        ]
      }
    ] as const;

    for (const {
      name,
      body,
      expectedCodeSubstrings
    } of nestedSpreadAggregationCodeFixtures) {
      it(name, () => {
        const { code } = babelTransform(
          `
          const styleA = "style-a";
          const preProps = {
            className: "from-pre",
            css: "leak-pre",
            id: "from-pre"
          };
          const postProps = {
            className: "from-post",
            css: "leak-post",
            title: "from-post"
          };

          function App() {
            ${body}
          }
        `,
          { jsxCssProp: true }
        );

        expect(code).not.toContain(" css=");
        for (const expectedCodeSubstring of expectedCodeSubstrings) {
          expect(code).toContain(expectedCodeSubstring);
        }
      });
    }

    it("accepts braced JSX expression child spread aggregation", () => {
      const { code } = babelTransform(
        `
          const props = { className: "base", css: "leaked" };
          const styleA = "style-a";

          function App() {
            return <section>{<div css={styleA} {...props} />}</section>;
          }
        `,
        { jsxCssProp: true }
      );

      expect(code).not.toContain(" css=");
      expect(code).toContain("{(() =>");
      expect(code).toContain("css: _minchoCssProp");
      expect(code).toContain("className: _minchoClassName");
      expect(code).toContain("..._minchoRest");
    });

    describe("jsx css prop split characterization", () => {
      it("removes unused jsx css prop helper imports as whole imports and pruned specifiers", () => {
        const wholeImport = babelTransform(
          `
          import { css } from "@mincho-js/css";

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <div css={makeRule("red")} />;
          }
        `,
          { jsxCssProp: true }
        );
        const prunedImport = babelTransform(
          `
          import { css, defineRules } from "@mincho-js/css";

          defineRules({
            properties: { color: String }
          });

          function makeRule(color: string) {
            return { color };
          }

          function App() {
            return <div css={makeRule("red")} />;
          }
        `,
          { jsxCssProp: true }
        );

        expect(wholeImport.code).not.toContain("@mincho-js/css");
        expect(wholeImport.code).not.toContain("_css(");
        expect(prunedImport.code).toContain(
          'import { defineRules } from "@mincho-js/css";'
        );
        expect(prunedImport.code).not.toContain("css, defineRules");
        expect(prunedImport.code).not.toContain("_css(");
      });

      it("characterizes jsx css prop spread aggregation statement-list and nested IIFE rewrites", () => {
        const directStatementList = babelTransform(
          `
          const props = { className: "base", css: "leaked", id: "root" };
          const styleA = "style-a";

          function App() {
            return <div {...props} css={styleA} />;
          }
        `,
          { jsxCssProp: true }
        );
        const nestedIife = babelTransform(
          `
          const props = { className: "base", css: "leaked", id: "root" };
          const styleA = "style-a";

          function App() {
            const renderValue = () => <div {...props} css={styleA} />;
            return renderValue();
          }
        `,
          { jsxCssProp: true }
        );

        expect(directStatementList.code).not.toContain("(() =>");
        expect(directStatementList.code).toContain("css: _minchoCssProp");
        expect(directStatementList.code).toContain(
          "className={_cx(_minchoClassName, styleA)}"
        );
        expect(nestedIife.code).toContain("(() =>");
        expect(nestedIife.code).toContain("css: _minchoCssProp");
        expect(nestedIife.code).toContain(
          "className={_cx(_minchoClassName, styleA)}"
        );
      });

      it("leaves representative jsx css prop class-value expressions untouched except className lowering", () => {
        const { result, code } = babelTransform(
          `
          const maybeClass = "dynamic";

          function App() {
            return <>
              <div css={new String("boxed")} />
              <div css={void maybeClass} />
            </>;
          }
        `,
          { jsxCssProp: true }
        );

        expect(code).not.toContain(" css=");
        expect(code).toContain('className={_cx(new String("boxed"))}');
        expect(code).toContain("className={_cx(void maybeClass)}");
        expect(result[1]).not.toContain("_css(");
      });

      const exactJsxCssPropErrorFixtures = [
        {
          name: "fragment target",
          fixture: `<React.Fragment css={{ color: "red" }} />`,
          message:
            "Mincho JSX css prop does not support fragments because fragments cannot receive className"
        },
        {
          name: "namespaced target",
          fixture: `<svg:path css={{ color: "red" }} />`,
          message:
            "Mincho JSX css prop does not support namespaced JSX elements"
        },
        {
          name: "missing expression value",
          fixture: `<div css />`,
          message: "Mincho JSX css prop requires an expression value"
        },
        {
          name: "non-expression JSX value",
          fixture: `<div css=<span /> />`,
          message: "Mincho JSX css prop expects a Mincho CSS object/expression"
        },
        {
          name: "function value",
          fixture: `<div css={() => ({ color: "red" })} />`,
          message:
            "Mincho JSX css prop does not support function values in compile-away mode"
        },
        {
          name: "logical arrow function value",
          fixture: `<div css={{ color: "red" } && (() => ({ color: "blue" }))} />`,
          message:
            "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
        },
        {
          name: "logical function expression value",
          fixture: `<div css={{ color: "red" } && function () { return { color: "blue" }; }} />`,
          message:
            "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
        },
        {
          name: "dynamic CSS rule value",
          fixture: `<div css={(0, { color: "red" })} />`,
          message:
            "Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode"
        },
        {
          name: "array spread value",
          fixture: `<div css={["base", ...classes]} />`,
          message:
            "Mincho JSX css prop array values do not support spread elements in compile-away mode"
        },
        {
          name: "duplicate css",
          fixture: `<div css={{ color: "red" }} css={{ color: "blue" }} />`,
          message: "Mincho JSX css prop must appear only once"
        },
        {
          name: "duplicate className",
          fixture: `<div className="base" className="extra" css={{ color: "red" }} />`,
          message:
            "Mincho JSX css prop cannot merge duplicate className attributes"
        },
        {
          name: "invalid className value",
          fixture: `<div className css={{ color: "red" }} />`,
          message:
            "Mincho JSX css prop requires className to be a string literal or expression"
        }
      ] as const;

      for (const { name, fixture, message } of exactJsxCssPropErrorFixtures) {
        it(`throws exact jsx css prop error for ${name}`, () => {
          expectJsxCssPropError(fixture, message);
        });
      }

      it("throws exact jsx css prop error for unsupported target", () => {
        expectNestedUnsupportedJsxTargetError(
          "Mincho JSX css prop only supports JSX identifiers and member expressions"
        );
      });

      it("throws exact jsx css prop error for unsupported spread aggregation context", () => {
        expectUnsupportedSpreadAggregationContextError(
          "Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode"
        );
      });

      it("throws exact jsx css prop error for nested await or yield spread aggregation", () => {
        expect(() =>
          babelTransform(
            `
            async function getStyle() {
              return "style-a";
            }
            const props = { className: "base" };

            async function App(ok) {
              return ok ? <div css={await getStyle()} {...props} /> : null;
            }
          `,
            { jsxCssProp: true }
          )
        ).toThrow(
          "Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode"
        );
      });
    });

    const unsupportedJsxCssPropFixtures = [
      {
        name: "rejects React.Fragment css prop targets",
        fixture: `<React.Fragment css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.fragmentTarget
      },
      {
        name: "rejects Fragment identifier css prop targets",
        fixture: `<Fragment css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.fragmentTarget
      },
      {
        name: "rejects namespaced JSX css prop targets",
        fixture: `<svg:path css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.namespacedTarget
      },
      {
        name: "rejects shorthand css",
        fixture: `<div css />`,
        message: jsxCssPropErrorMessages.expressionValue
      },
      {
        name: "rejects inline arrow function css values",
        fixture: `<div css={() => ({ color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedFunction
      },
      {
        name: "rejects inline function expression css values",
        fixture: `<div css={function () { return { color: "red" }; }} />`,
        message: jsxCssPropErrorMessages.unsupportedFunction
      },
      {
        name: "rejects sequence object literal css rule values",
        fixture: `<div css={(0, { color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence array literal css rule values",
        fixture: `<div css={(0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence object literal css rule values inside arrays",
        fixture: `<div css={["base", (0, { color: "red" })]} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence array literal css rule values inside arrays",
        fixture: `<div css={["base", (0, [{ color: "red" }])]} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence object literal css rule values inside conditional branches",
        fixture: `<div css={condition ? (0, { color: "red" }) : "fallback"} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence array literal css rule values inside conditional branches",
        fixture: `<div css={condition ? "active" : (0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence object literal css rule values inside logical branches",
        fixture: `<div css={condition && (0, { color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects sequence array literal css rule values inside logical branches",
        fixture: `<div css={condition || (0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects array spread css prop array values",
        fixture: `<div css={["base", ...classes]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects array spread css prop array values inside conditional branches",
        fixture: `<div css={condition ? ["active", ...classes] : "fallback"} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects array spread css prop array values inside logical branches",
        fixture: `<div css={condition && ["active", ...classes]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects array spread css prop array values at nested depth",
        fixture: `<div css={["base", ["nested", ...classes]]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects array spread css prop array values inside nested dynamic branches",
        fixture: `<div css={["base", condition && ["active", ...classes]]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects duplicate css attributes",
        fixture: `<div css={{ color: "red" }} css={{ color: "blue" }} />`,
        message: jsxCssPropErrorMessages.duplicateCss
      },
      {
        name: "rejects duplicate className attributes",
        fixture: `<div className="base" className="extra" css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.duplicateClassName
      },
      {
        name: "rejects shorthand className on css-prop elements",
        fixture: `<div className css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.classNameValue
      }
    ] as const;

    for (const { name, fixture, message } of unsupportedJsxCssPropFixtures) {
      it(name, () => {
        expectJsxCssPropError(fixture, message);
      });
    }

    const nestedUnsupportedJsxCssPropFixtures = [
      {
        name: "rejects nested React.Fragment css prop targets",
        fixture: `<React.Fragment {...props} css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.fragmentTarget
      },
      {
        name: "rejects nested Fragment identifier css prop targets",
        fixture: `<Fragment {...props} css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.fragmentTarget
      },
      {
        name: "rejects nested namespaced JSX css prop targets",
        fixture: `<svg:path {...props} css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.namespacedTarget
      },
      {
        name: "rejects nested unsupported JSX css prop targets",
        fixture: null,
        message: jsxCssPropErrorMessages.unsupportedTarget
      },
      {
        name: "rejects nested shorthand css on spread-aggregated elements",
        fixture: `<div {...props} css />`,
        message: jsxCssPropErrorMessages.expressionValue
      },
      {
        name: "rejects nested inline arrow function css values",
        fixture: `<div {...props} css={() => ({ color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedFunction
      },
      {
        name: "rejects nested inline function expression css values",
        fixture: `<div {...props} css={function () { return { color: "red" }; }} />`,
        message: jsxCssPropErrorMessages.unsupportedFunction
      },
      {
        name: "rejects nested sequence object literal css rule values",
        fixture: `<div {...props} css={(0, { color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence array literal css rule values",
        fixture: `<div {...props} css={(0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence object literal css rule values inside arrays",
        fixture: `<div {...props} css={["base", (0, { color: "red" })]} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence array literal css rule values inside arrays",
        fixture: `<div {...props} css={["base", (0, [{ color: "red" }])]} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence object literal css rule values inside conditional branches",
        fixture: `<div {...props} css={condition ? (0, { color: "red" }) : "fallback"} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence array literal css rule values inside conditional branches",
        fixture: `<div {...props} css={condition ? "active" : (0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence object literal css rule values inside logical branches",
        fixture: `<div {...props} css={condition && (0, { color: "red" })} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested sequence array literal css rule values inside logical branches",
        fixture: `<div {...props} css={condition || (0, [{ color: "red" }])} />`,
        message: jsxCssPropErrorMessages.unsupportedDynamicCssRule
      },
      {
        name: "rejects nested array spread css prop array values",
        fixture: `<div {...props} css={["base", ...dynamicClasses]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects nested array spread css prop array values inside conditional branches",
        fixture: `<div {...props} css={condition ? ["active", ...dynamicClasses] : "fallback"} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects nested array spread css prop array values inside logical branches",
        fixture: `<div {...props} css={condition && ["active", ...dynamicClasses]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects nested array spread css prop array values at nested depth",
        fixture: `<div {...props} css={["base", ["nested", ...dynamicClasses]]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects nested array spread css prop array values inside nested dynamic branches",
        fixture: `<div {...props} css={["base", condition && ["active", ...dynamicClasses]]} />`,
        message: jsxCssPropErrorMessages.unsupportedArraySpread
      },
      {
        name: "rejects nested duplicate css attributes",
        fixture: `<div {...props} css={{ color: "red" }} css={{ color: "blue" }} />`,
        message: jsxCssPropErrorMessages.duplicateCss
      },
      {
        name: "rejects nested duplicate className attributes",
        fixture: `<div {...props} className="base" className="extra" css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.duplicateClassName
      },
      {
        name: "rejects nested shorthand className on css-prop elements",
        fixture: `<div {...props} className css={{ color: "red" }} />`,
        message: jsxCssPropErrorMessages.classNameValue
      }
    ] as const;

    for (const {
      name,
      fixture,
      message
    } of nestedUnsupportedJsxCssPropFixtures) {
      it(name, () => {
        if (fixture === null) {
          expectNestedUnsupportedJsxTargetError();
          return;
        }

        expectNestedJsxCssPropError(fixture, message);
      });
    }

    it("rejects nested invalid className expression on css-prop elements", () => {
      expectNestedInvalidClassNameExpressionError();
    });

    it("keeps Babel css prop tag literals mirrored from React tags", () => {
      const babelTags = [...supportedJsxCssPropTags];
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
      const reactTagModules = import.meta.glob("../../react/src/tags.ts", {
        query: "?raw",
        import: "default",
        eager: true
      });
      const reactTagsSource = Object.values(reactTagModules)[0] as string;
      const [, reactTagsLiteral = ""] =
        /export const tags = \[([\s\S]*?)\] as const/.exec(reactTagsSource) ??
        [];
      const reactTags = Array.from(
        reactTagsLiteral.matchAll(/"([^"]+)"/g),
        ([, tag]) => tag
      );

      expect(babelTags).toEqual(reactTags);
    });

    it("hoists inline expression", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const str = \`abc \${style({ color: "red" })}\`;
        console.log(str);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("hoists object property", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const obj = {
          nested: {
            key: style({ color: "red" })
          }
        };
        console.log(obj);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("hoists array member", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const arr = [1, 2, style({ color: "red" }), 4, style({ color: "blue" })];
        console.log(arr);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("extracts style function", () => {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const red = style({ color: "red" });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("leaves defineRules call shape untouched", () => {
      const { code } = babelTransform(`
        import { defineRules } from '@mincho-js/css';

        defineRules({
          properties: {
            color: String,
          },
          shortcuts: {
            text: {
              color: 'red',
            },
          },
        });
      `);

      expect(code).toContain("defineRules({");
    });

    it("extracts $mincho function", () => {
      const { result, code } = babelTransform(`
        import { style, mincho$ } from '@mincho-js/css';
        const red = mincho$(() => {
          return 2 + 2;
        });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("multiple variable declarators in one declaration", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' }),
        blue = style({ color: 'blue' }),
        green = style({ color: 'green' });

      console.log(red, blue, green);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("move bindings along with extracted style", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      const redColor = 'red';
      const red = style({ color: redColor });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("inside block scope", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      {
        const red = style({ color: 'red' });
        console.log(red);
      }
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("already exported", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      export const red = style({ color: 'red' });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // doesn't work
    it("hoisting same variable name in different scope", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' });
      console.log(red);

      function SomeComponent() {
        const red = style({ color: 'blue' });
        console.log(red)
      }
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // it("array pattern hoisting", () => {
    //   const { result, code } = babelTransform(`
    //   import { createTheme } from '@mincho-js/css';

    //   const [themeClass, vars] = createTheme({
    //     colors: {
    //       brand: 'red'
    //     }
    //   });
    //   console.log(themeClass, vars);
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("same binding in multiple declarations", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const foreground = style({ color });
      const background = style({ background: color });

      console.log(foreground, background)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("binding ordering", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const red = style({ color });
      const longClass = \`abc \${red}\`;
      console.log(longClass)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("nested bindings", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const theme = { color: 'red' };
      const themeColor = theme.color;
      const color = themeColor;

      const red = style({ color });
      console.log(red)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    // it("css variables", () => {
    //   const { result, code } = babelTransform(`
    //   import { style, createVar } from '@mincho-js/css';

    //   const colorVar = createVar();

    //   const red = style({
    //     color: 'red',
    //     vars: {
    //       [colorVar]: 'red'
    //     }
    //   });
    //   console.log(red)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("global styles", () => {
      const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      globalStyle('html, body', {
        color: 'red',
      });
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("arrow function bindings", () => {
      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const utility = { gap: (size) => ({ gap: size }) }
        const red = style({ ...utility.gap('10px') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }

      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const getStyles = (color) => ({ color })
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }
    });

    it("function declaration bindings", () => {
      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getColor() { return 'red' }
        const red = style({ color: getColor() });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }

      {
        const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getStyles(color) { return { color } }
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

        expect(result).toMatchSnapshot();
        expect(code).toMatchSnapshot();
      }
    });

    it("mincho-ignore doesn't extract expression", () => {
      const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = /* mincho-ignore */ style({ color: "red" });
      console.log(red);
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("react styled components get converted to runtime", () => {
      const { result, code } = babelTransform(`
      import { styled } from '@mincho-js/react';

      const Button = styled("button", {
        base: { color: 'red' }
      })
      const Link = styled.a({
        base: { color: 'blue' }
      })
      console.log(Button, Link)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("non-Mincho styled calls are ignored", () => {
      const { result, code } = babelTransform(`
      import { styled } from '@emotion/styled';

      const Button = styled("button", {
        color: 'red'
      })
      const Link = styled.a({
        color: 'blue'
      })
      console.log(Button, Link)
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

    it("mincho-ignore on parent node", () => {
      const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      /* mincho-ignore */ globalStyle("html", { color: 'red' })
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });
  });
}

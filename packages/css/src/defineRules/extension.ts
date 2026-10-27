import type {
  DefineRulesConditions,
  DefineRulesCtx,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

export const defineRulesDefinition = /* @__PURE__ */ Symbol.for(
  "@mincho-js/css/defineRulesDefinition"
);

export type DefineRulesDefinition<
  Properties extends DefineRulesProperties,
  Shortcuts extends object,
  Conditions extends DefineRulesConditions,
  Context
> = Omit<
  DefineRulesCtx<Properties, Record<never, never>, Conditions, Context>,
  "shortcuts"
> & {
  shortcuts?: Shortcuts;
};

export type DefineRulesDefinitionMetadata<
  Properties extends DefineRulesProperties,
  Shortcuts extends object,
  Conditions extends DefineRulesConditions,
  Context
> = {
  readonly [defineRulesDefinition]: DefineRulesDefinition<
    Properties,
    Shortcuts,
    Conditions,
    Context
  >;
};

export type MergeDefinitions<Parent, Child> = {
  [Key in keyof Parent | keyof Child]: Key extends keyof Child
    ? Child[Key]
    : Key extends keyof Parent
      ? Parent[Key]
      : never;
};

type MergePropertyValue<Parent, Child> = Parent extends
  readonly unknown[] | ((...args: never[]) => unknown)
  ? Child
  : Child extends readonly unknown[] | ((...args: never[]) => unknown)
    ? Child
    : Parent extends object
      ? Child extends object
        ? MergeDefinitions<Parent, Child>
        : Child
      : Child;

type CheckedProperties<Value> = Value extends infer Properties extends
  DefineRulesProperties
  ? Properties
  : never;

export type ExtendedProperties<
  Parent extends DefineRulesProperties,
  Child extends DefineRulesProperties
> = CheckedProperties<{
  [Key in keyof Parent | keyof Child]: Key extends keyof Child
    ? Key extends keyof Parent
      ? MergePropertyValue<Parent[Key], Child[Key]>
      : Child[Key]
    : Key extends keyof Parent
      ? Parent[Key]
      : never;
}>;

export type DefineRulesExtendsConfig<
  ParentProperties extends DefineRulesProperties,
  ParentShortcuts extends object,
  ParentConditions extends DefineRulesConditions,
  Properties extends DefineRulesProperties,
  Shortcuts extends object,
  Conditions extends DefineRulesConditions,
  Context
> = DefineRulesDefinition<Properties, Shortcuts, Conditions, Context> & {
  shortcuts?: Pick<
    DefineRulesShortcuts<
      ExtendedProperties<ParentProperties, Properties>,
      MergeDefinitions<ParentShortcuts, Shortcuts>,
      MergeDefinitions<ParentConditions, Conditions>
    >,
    keyof Shortcuts
  >;
};

export function isDefinitionRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return true;
  if (
    Object.getPrototypeOf(prototype) !== null ||
    !Object.prototype.hasOwnProperty.call(prototype, "constructor")
  )
    return false;
  const constructor: unknown = Reflect.get(prototype, "constructor");
  return (
    typeof constructor === "function" &&
    Function.prototype.toString.call(constructor) ===
      Function.prototype.toString.call(Object)
  );
}

export function mergeProperties(
  parent: object | undefined,
  child: object | undefined
): DefineRulesProperties {
  const result: Record<string, unknown> = { ...parent };
  for (const [name, value] of Object.entries(child ?? {})) {
    const previous = Object.prototype.hasOwnProperty.call(result, name)
      ? result[name]
      : undefined;
    Object.defineProperty(result, name, {
      value:
        isDefinitionRecord(previous) && isDefinitionRecord(value)
          ? { ...previous, ...value }
          : value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return result as DefineRulesProperties;
}

export function getDefineRulesDefinition<
  Properties extends DefineRulesProperties,
  Shortcuts extends object,
  Conditions extends DefineRulesConditions,
  Context
>(parent: {
  css: DefineRulesDefinitionMetadata<
    Properties,
    Shortcuts,
    Conditions,
    Context
  >;
}) {
  const config: unknown =
    parent != null && typeof parent.css === "function"
      ? Reflect.get(parent.css, defineRulesDefinition)
      : undefined;
  if (!isDefinitionRecord(config)) {
    throw new Error(
      "defineRules.extends() expected a defineRules() result with extension metadata; rebuild the parent with a version that supports defineRules.extends()."
    );
  }
  return config as DefineRulesDefinition<
    Properties,
    Shortcuts,
    Conditions,
    Context
  >;
}

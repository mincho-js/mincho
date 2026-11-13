import {
  base as baseDefinition,
  dark as darkDefinition,
  system as systemDefinition
} from "@mincho-js/preset-theme-ui";
import {
  basePreset,
  darkPreset,
  systemPreset
} from "@mincho-js/preset-theme-ui/presets";
import { defineRules } from "@mincho-js/react";
import {
  compileComponents,
  type ComponentGroups,
  type ComponentGroupsInput,
  type Components,
  type Definition,
  type MergedGroups
} from "./components.js";

export { createComponents } from "./components.js";
export type { ComponentGroups, Components } from "./components.js";

export {
  baseClass,
  systemClass,
  darkClass,
  systemModeClasses,
  baseVars,
  systemVars,
  darkVars,
  baseContract,
  systemContract,
  darkContract,
  systemClass as themeClass,
  systemModeClasses as modeClasses,
  systemVars as vars
} from "@mincho-js/preset-theme-ui";

type BoundDefinition<Value extends Definition, Source> = ReturnType<
  typeof defineRules<Value>
> & {
  components<
    const Groups extends ComponentGroups<Value> = Record<never, never>
  >(
    groups?: Groups & ComponentGroupsInput<Value, NoInfer<Groups>>
  ): Components<MergedGroups<Source, Groups>>;
};

function bind<
  const Value extends Definition,
  const Source extends Record<string, unknown>
>(definition: Value, source: Source): BoundDefinition<Value, Source> {
  const adapted = defineRules(definition);

  function components<
    const Groups extends ComponentGroups<Value> = Record<never, never>
  >(
    groups?: Groups & ComponentGroupsInput<Value, NoInfer<Groups>>
  ): Components<MergedGroups<Source, Groups>> {
    return compileComponents(definition, groups ?? {}, source) as Components<
      MergedGroups<Source, Groups>
    >;
  }

  // The native preset getter observes atoms added by subsequent authoring calls.
  return Object.defineProperty(adapted, "components", {
    value: components,
    enumerable: true,
    configurable: true,
    writable: true
  }) as BoundDefinition<Value, Source>;
}

export const base: BoundDefinition<typeof baseDefinition, typeof basePreset> =
  /*#__PURE__*/ bind(baseDefinition, basePreset);
export const system: BoundDefinition<
  typeof systemDefinition,
  typeof systemPreset
> = /*#__PURE__*/ bind(systemDefinition, systemPreset);
export const dark: BoundDefinition<typeof darkDefinition, typeof darkPreset> =
  /*#__PURE__*/ bind(darkDefinition, darkPreset);

export const css: typeof systemDefinition.css = /*#__PURE__*/ (() =>
  systemDefinition.css)();
export const rules: typeof systemDefinition.rules = /*#__PURE__*/ (() =>
  systemDefinition.rules)();
export const cx: typeof systemDefinition.cx = /*#__PURE__*/ (() =>
  systemDefinition.cx)();
export const styled: ReturnType<
  typeof defineRules<typeof systemDefinition>
>["styled"] = /*#__PURE__*/ (() => defineRules(systemDefinition).styled)();
export const components: typeof system.components = /*#__PURE__*/ (() =>
  system.components)();

import type { CSSProperties } from "@mincho-js/transform-to-vanilla";
import { registerDefineRulesRegistryInstance } from "./registry.js";
import { createCanonicalStyleCache } from "./utils.js";
import type {
  DefineRulesComplexCssInput,
  DefineRulesCtx,
  DefineRulesPresetArtifactV3,
  DefineRulesPresetClassNameByCache,
  DefineRulesPresetInput,
  DefineRulesPresetMap,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

// == Define Rules Runtime =====================================================
export type DefineRulesRuntimeCss<CssInput> = ((args: CssInput) => string) & {
  raw(args: CssInput): CSSProperties;
};

export interface DefineRulesRuntimeResult<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
> {
  css: DefineRulesRuntimeCss<DefineRulesComplexCssInput<Properties, Shortcuts>>;
  preset: DefineRulesPresetArtifactV3;
}

export interface DefineRulesRuntimeOptions {
  preservePresetReference?: boolean;
  registerPreset?: boolean;
}

export function createDefineRulesRuntime<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  config: DefineRulesCtx<Properties, Shortcuts>,
  options: DefineRulesRuntimeOptions = {}
): DefineRulesRuntimeResult<Properties, Shortcuts> {
  type CssInput = DefineRulesComplexCssInput<Properties, Shortcuts>;
  const presetArtifact = createDefineRulesPresetArtifact(
    config.presets,
    options?.preservePresetReference === true
  );
  const styleCache = createCanonicalStyleCache(config.debugId);
  styleCache.importSnapshot(presetArtifact.classNameByCache);

  if (options.registerPreset !== false) {
    registerDefineRulesRegistryInstance({
      config,
      presetArtifact,
      getPresetSnapshot: () => ({
        ...presetArtifact.classNameByCache
      })
    });
  }

  function resolveToFragments(args: CssInput): ResolvedStyleFragment[] {
    const fragments: ResolvedStyleFragment[] = [];
    applyInput(config, fragments, args, []);
    return fragments;
  }

  function cssRaw(args: CssInput): CSSProperties {
    return flattenResolvedFragments(resolveToFragments(args));
  }

  function cssImpl(args: CssInput): string {
    const fragments = resolveToFragments(args);
    const emittedFragments = collectEmittedFragments(fragments);
    const output: string[] = [];
    let didAddFragment = false;

    for (const fragment of emittedFragments) {
      const hasFragment = styleCache.hasFragment(
        fragment.inputIdentity.property,
        fragment.inputIdentity.value,
        fragment.style
      );
      const className = styleCache.addFragment(
        fragment.inputIdentity.property,
        fragment.inputIdentity.value,
        fragment.style
      );

      if (hasFragment === false) {
        didAddFragment = true;
      }

      output.push(className);
    }

    if (didAddFragment) {
      Object.assign(
        presetArtifact.classNameByCache,
        styleCache.exportSnapshot()
      );
    }

    return output.sort().join(" ");
  }

  const css = Object.assign(cssImpl, {
    raw: cssRaw
  }) as DefineRulesRuntimeCss<CssInput>;
  return { css, preset: presetArtifact };
}

// == Define Rules Impl ========================================================
interface InputIdentity {
  property: string;
  value: unknown;
}

interface ResolvedStyleFragment {
  source: {
    key: string;
    shortcutStack: string[];
  };
  inputIdentity: InputIdentity;
  outputKeys: string[];
  style: CSSProperties;
}

function collectEmittedFragments(
  fragments: readonly ResolvedStyleFragment[]
): ResolvedStyleFragment[] {
  const occupiedKeys = new Set<string>();
  const emittedFragments: ResolvedStyleFragment[] = [];

  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment == null) continue;

    const emittedFragment = omitOccupiedKeys(fragment, occupiedKeys);
    if (emittedFragment == null) {
      continue;
    }

    emittedFragments.push(emittedFragment);

    for (const key of emittedFragment.outputKeys) {
      occupiedKeys.add(key);
    }
  }

  return emittedFragments.reverse();
}

function omitOccupiedKeys(
  fragment: ResolvedStyleFragment,
  occupiedKeys: ReadonlySet<string>
): ResolvedStyleFragment | undefined {
  const remainingOutputKeys = fragment.outputKeys.filter(
    (key) => !occupiedKeys.has(key)
  );

  if (remainingOutputKeys.length === 0) {
    return undefined;
  }

  if (remainingOutputKeys.length === fragment.outputKeys.length) {
    return fragment;
  }

  const nextStyle: Record<string, unknown> = {};

  for (const key of remainingOutputKeys) {
    nextStyle[key] = (fragment.style as Record<string, unknown>)[key];
  }

  return {
    ...fragment,
    outputKeys: remainingOutputKeys,
    style: nextStyle as CSSProperties
  };
}

function flattenResolvedFragments(
  fragments: readonly ResolvedStyleFragment[]
): CSSProperties {
  const mergedStyle: CSSProperties = {};

  for (const fragment of fragments) {
    Object.assign(mergedStyle, fragment.style);
  }

  return mergedStyle;
}

function pushResolvedFragment(
  fragmentsOut: ResolvedStyleFragment[],
  inputIdentity: InputIdentity,
  shortcutStack: readonly string[],
  style: CSSProperties
) {
  const outputKeys = Object.keys(style);
  if (outputKeys.length === 0) return;

  fragmentsOut.push({
    source: {
      key: inputIdentity.property,
      shortcutStack: [...shortcutStack]
    },
    inputIdentity,
    outputKeys,
    style
  });
}

function applyInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  input: unknown,
  shortcutStack: string[]
) {
  if (input == null || input === false) return;

  if (typeof input === "string") {
    applyInlineShortcut(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  if (Array.isArray(input)) {
    applyArray(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  if (isPlainObject(input)) {
    applyObject(ctx, fragmentsOut, input, shortcutStack);
    return;
  }

  throw new Error(`Unsupported css() argument: ${String(input)}`);
}

function applyInlineShortcut<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  shortcutName: string,
  shortcutStack: string[]
) {
  if (hasOwn(ctx.shortcuts, shortcutName)) {
    applyShortcut(ctx, fragmentsOut, shortcutName, undefined, shortcutStack);
    return;
  }
  throw new Error(`Unknown fixed style: "${shortcutName}"`);
}

function applyArray<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  arr: readonly unknown[],
  shortcutStack: string[]
) {
  for (const item of arr) {
    applyInput(ctx, fragmentsOut, item, shortcutStack);
  }
}

function applyObject<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  obj: Record<string, unknown>,
  shortcutStack: string[]
) {
  for (const [k, v] of Object.entries(obj)) {
    applyEntry(ctx, fragmentsOut, k, v, shortcutStack);
  }
}

function applyEntry<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  key: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (value == null) {
    return;
  }

  if (hasOwn(ctx.shortcuts, key)) {
    applyShortcut(ctx, fragmentsOut, key, value, shortcutStack);
    return;
  }

  applyProperty(ctx, fragmentsOut, key, value, shortcutStack);
}

function applyProperty<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  prop: string,
  value: unknown,
  shortcutStack: string[]
) {
  const propertyDefinition = ctx.properties?.[prop as keyof Properties];

  if (typeof propertyDefinition === "function") {
    const result = propertyDefinition(value);

    if (result == null) {
      return;
    }

    if (isPlainObject(result)) {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        result as CSSProperties
      );
      return;
    } else {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        {
          [prop]: result
        } as CSSProperties
      );
      return;
    }
  }

  // just assign => last one wins
  if (isPlainObject(propertyDefinition) === false) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      {
        [prop]: value
      } as CSSProperties
    );
    return;
  }

  const mappedValue = propertyDefinition[value as string];

  // Style object value => assign all
  if (isPlainObject(mappedValue)) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      mappedValue as CSSProperties
    );
    return;
  }

  // Mapped value => assign mapped value
  pushResolvedFragment(fragmentsOut, { property: prop, value }, shortcutStack, {
    [prop]: mappedValue ?? value
  } as CSSProperties);
}

function applyShortcutReference<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  targetName: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (hasOwn(ctx.shortcuts, targetName)) {
    applyShortcut(ctx, fragmentsOut, targetName, value, shortcutStack);
    return;
  }

  applyProperty(ctx, fragmentsOut, targetName, value, shortcutStack);
}

function applyShortcut<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts>
>(
  ctx: DefineRulesCtx<Properties, Shortcuts>,
  fragmentsOut: ResolvedStyleFragment[],
  name: string,
  value: unknown,
  shortcutStack: string[]
) {
  if (shortcutStack.includes(name)) {
    throw new Error(
      `Circular shortcut reference: ${[...shortcutStack, name].join(" -> ")}`
    );
  }

  const shortcutDefinition = ctx.shortcuts?.[name as keyof Shortcuts];
  if (shortcutDefinition == null) return;

  const nextShortcutStack = shortcutStack.concat(name);

  if (typeof shortcutDefinition === "string") {
    // single alias: pl -> paddingLeft
    applyShortcutReference(
      ctx,
      fragmentsOut,
      shortcutDefinition,
      value,
      nextShortcutStack
    );
    return;
  }

  if (Array.isArray(shortcutDefinition)) {
    // multi alias: px -> [pl, pr]
    for (const alias of shortcutDefinition) {
      applyShortcutReference(
        ctx,
        fragmentsOut,
        alias,
        value,
        nextShortcutStack
      );
    }
    return;
  }

  if (typeof shortcutDefinition === "function") {
    // fn shortcut
    const produced = shortcutDefinition(value);
    applyInput(ctx, fragmentsOut, produced, nextShortcutStack);
    return;
  }

  if (isPlainObject(shortcutDefinition)) {
    // fixed style shortcut
    // - "inline" shortcut flag (no value) => apply
    // - { inline: true } => apply
    // - { inline: false } => do not apply
    if (value === undefined || value === true) {
      applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
      return;
    }
    if (!value) return;
    applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
    return;
  }

  throw new Error(`Unsupported shortcut definition for "${name}"`);
}

function createDefineRulesPresetArtifact(
  presetInput: DefineRulesPresetInput | undefined,
  preserveReference: boolean
): DefineRulesPresetArtifactV3 {
  if (preserveReference && isDefineRulesPresetArtifactV3(presetInput)) {
    return presetInput;
  }

  return {
    schema: "mincho.defineRulesPreset",
    version: 3,
    classNameByCache: normalizePresetMap(presetInput, preserveReference)
  };
}

function normalizePresetMap(
  presetInput: DefineRulesPresetInput | undefined,
  preserveReference: boolean
): DefineRulesPresetMap {
  if (presetInput == null) {
    return {};
  }

  return normalizePresetInput(presetInput, preserveReference, "config.presets");
}

function normalizePresetInput(
  presetInput: unknown,
  preserveReference: boolean,
  path: string
): DefineRulesPresetMap {
  if (Array.isArray(presetInput)) {
    const mergedPreset: DefineRulesPresetMap = {};

    for (const [index, item] of presetInput.entries()) {
      Object.assign(
        mergedPreset,
        normalizePresetInput(item, false, `${path}[${index}]`)
      );
    }

    return mergedPreset;
  }

  if (isDefineRulesPresetArtifactV3(presetInput)) {
    return preserveReference
      ? presetInput.classNameByCache
      : { ...presetInput.classNameByCache };
  }

  if (isDefineRulesPresetArtifactEnvelope(presetInput)) {
    if (presetInput.version === 3) {
      throwUnsupportedPresetInput(`${path}.classNameByCache`);
    }

    throwUnsupportedPresetInput(path);
  }

  if (isDefineRulesPresetClassNameByCache(presetInput)) {
    return preserveReference ? presetInput : { ...presetInput };
  }

  throwUnsupportedPresetInput(path);
}

function isDefineRulesPresetArtifactV3(
  value: unknown
): value is DefineRulesPresetArtifactV3 {
  return (
    isDefineRulesPresetArtifactEnvelope(value) &&
    value.version === 3 &&
    isDefineRulesPresetClassNameByCache(value.classNameByCache)
  );
}

function isDefineRulesPresetArtifactEnvelope(value: unknown): value is {
  schema: "mincho.defineRulesPreset";
  version?: unknown;
  classNameByCache?: unknown;
} {
  return (
    isPlainRecordObject(value) && value.schema === "mincho.defineRulesPreset"
  );
}

function isDefineRulesPresetClassNameByCache(
  value: unknown
): value is DefineRulesPresetClassNameByCache {
  return (
    isPlainRecordObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function throwUnsupportedPresetInput(path: string): never {
  throw new Error(`Unsupported defineRules preset input at ${path}`);
}

// == Utils ====================================================================
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object | undefined, key: PropertyKey): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

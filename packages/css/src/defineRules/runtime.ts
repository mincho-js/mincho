import { collectStyleDeclarations } from "@mincho-js/transform-to-vanilla";
import type {
  ConditionAliasMap,
  CSSRule,
  NormalizedCondition
} from "@mincho-js/transform-to-vanilla";
import {
  endFileScope,
  hasFileScope,
  setFileScope
} from "@vanilla-extract/css/fileScope";
import { cx as rootCx } from "../classname/cx.js";
import type {
  ClassMultipleInput,
  ClassMultipleResult,
  ClassValue
} from "../classname/types.js";
import type { Cx } from "../classname/index.js";
import { registerDefineRulesRegistryInstance } from "./registry.js";
import { normalizeDefineRulesConditions } from "./conditions.js";
import { createCanonicalStyleCache } from "./utils.js";
import { createEngineMetadata } from "./metadata.js";
import type { EngineMetadata } from "./metadata.js";
import type {
  DefineRulesCss,
  DefineRulesComplexCssInput,
  DefineRulesCtx,
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesPresetArtifactV4,
  DefineRulesPresetInput,
  DefineRulesProperties,
  DefineRulesShortcuts
} from "./types.js";

const CONDITION_AT_RULES = [
  ["layer", "@layer"],
  ["supports", "@supports"],
  ["media", "@media"],
  ["container", "@container"]
] as const satisfies readonly (readonly [
  Exclude<keyof NormalizedCondition, "selector">,
  string
])[];

// == Define Rules Runtime =====================================================
type DefineRulesRuntimeCx = Cx;

export interface DefineRulesRuntimeResult<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
> {
  css: DefineRulesCss<
    DefineRulesComplexCssInput<Properties, Shortcuts, Conditions>
  >;
  cx: DefineRulesRuntimeCx;
  preset: DefineRulesPresetArtifactV4;
}

export interface DefineRulesRuntimeOptions {
  preservePresetReference?: boolean;
  registerPreset?: boolean;
}

export function createDefineRulesRuntime<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions>,
  options: DefineRulesRuntimeOptions = {}
): DefineRulesRuntimeResult<Properties, Shortcuts, Conditions> {
  type CssInput = DefineRulesComplexCssInput<Properties, Shortcuts, Conditions>;
  const normalizedConditions = normalizeDefineRulesConditions(
    config.conditions
  );
  const styleCache = createCanonicalStyleCache(config.debugId);
  const metadata = createEngineMetadata();
  const presetArtifact = createDefineRulesPresetArtifact(
    config.presets,
    options?.preservePresetReference === true,
    styleCache,
    metadata
  );

  if (options.registerPreset !== false) {
    registerDefineRulesRegistryInstance({
      config,
      presetArtifact,
      getPresetSnapshot: () => clonePresetArtifact(presetArtifact)
    });
  }

  function resolveToFragments(args: CssInput): ResolvedStyleFragment[] {
    const fragments: ResolvedStyleFragment[] = [];
    applyInput(config, fragments, args, []);
    return fragments;
  }

  function cssRaw(args: CssInput): CSSRule {
    return flattenAtomicWrites(
      collectEmittedAtomicWrites(
        collectAtomicWrites(resolveToFragments(args), normalizedConditions)
      )
    );
  }

  function cssImpl(args: CssInput): string {
    const atomicWrites = collectEmittedAtomicWrites(
      collectAtomicWrites(resolveToFragments(args), normalizedConditions)
    );
    const entries = [] as Array<{
      kind: "known";
      className: string;
      writeKeyId: number;
    }>;
    let didAddAtomicCacheEntry = false;

    for (const atomicWrite of atomicWrites) {
      const hasFragment = styleCache.hasFragment(
        atomicWrite.property,
        atomicWrite.value,
        atomicWrite.style
      );
      const className = styleCache.addFragment(
        atomicWrite.property,
        atomicWrite.value,
        atomicWrite.style
      );
      const writeKeyId = internAtomicWriteKey(metadata, atomicWrite);

      if (hasFragment === false) {
        registerAtomicWriteMetadata(
          metadata,
          styleCache,
          className,
          writeKeyId
        );
        didAddAtomicCacheEntry = true;
      }

      entries.push({ kind: "known", className, writeKeyId });
    }

    const className = entries.map((entry) => entry.className).join(" ");
    metadata.registerSegment(className, {
      entries,
      hasKnownAtomicClass: entries.length > 0
    });

    if (didAddAtomicCacheEntry) {
      syncPresetArtifact(presetArtifact, metadata.exportArtifact());
    }

    return className;
  }

  const css = Object.assign(cssImpl, {
    raw: cssRaw
  }) as DefineRulesCss<CssInput>;
  const cx = createDefineRulesCx(metadata);
  return { css, cx, preset: presetArtifact };
}

function createDefineRulesCx(metadata: EngineMetadata): DefineRulesRuntimeCx {
  const cxImpl = ((...inputs: ClassValue[]) => {
    const className = rootCx(...inputs);
    return metadata.mergeClassList(className);
  }) as (...inputs: ClassValue[]) => string;

  function cxMultiple<T extends ClassMultipleInput>(
    map: T
  ): ClassMultipleResult<T> {
    const result = {} as ClassMultipleResult<T>;

    for (const key in map) {
      result[key] = cxImpl(map[key]);
    }

    return result;
  }

  function cxWith<const T extends ClassValue>(
    callback?: (params: T) => ClassValue
  ) {
    const cxFunction = callback ?? ((className: T) => className);

    function cxWithImpl(...className: T[]) {
      const result = className.map((cn) => cxFunction(cn));
      return cxImpl(...result);
    }

    function cxWithMultiple<ClassNameMap extends ClassMultipleInput<T>>(
      classNameMap: ClassNameMap
    ): ClassMultipleResult<ClassNameMap> {
      type TransformedClassNameMap = Record<keyof ClassNameMap, ClassValue>;
      const transformedClassNameMap: TransformedClassNameMap =
        {} as TransformedClassNameMap;
      for (const key in classNameMap) {
        transformedClassNameMap[key] = cxFunction(classNameMap[key]);
      }
      return cxMultiple(transformedClassNameMap);
    }

    return Object.assign(cxWithImpl, { multiple: cxWithMultiple });
  }

  return Object.assign(cxImpl, {
    multiple: cxMultiple,
    with: cxWith
  }) as DefineRulesRuntimeCx;
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
  style: CSSRule;
}

interface AtomicWrite {
  condition: NormalizedCondition;
  property: string;
  value: unknown;
  style: CSSRule;
  writeKey: string;
}

function collectAtomicWrites(
  fragments: readonly ResolvedStyleFragment[],
  conditions: ConditionAliasMap
): AtomicWrite[] {
  const atomicWrites: AtomicWrite[] = [];

  for (const fragment of fragments) {
    const declarations = collectStyleDeclarations(fragment.style, {
      conditions
    });

    for (const declaration of declarations) {
      atomicWrites.push({
        condition: declaration.condition,
        property: declaration.property,
        value: declaration.value,
        style: styleForDeclarationCondition(
          declaration.condition,
          declaration.property,
          declaration.value
        ),
        writeKey: atomicWriteKey(declaration.condition, declaration.property)
      });
    }
  }

  return atomicWrites;
}

function collectEmittedAtomicWrites(
  atomicWrites: readonly AtomicWrite[]
): AtomicWrite[] {
  const occupiedWriteKeys = new Set<string>();
  const emittedWrites: AtomicWrite[] = [];

  for (let index = atomicWrites.length - 1; index >= 0; index -= 1) {
    const atomicWrite = atomicWrites[index];

    if (atomicWrite == null || occupiedWriteKeys.has(atomicWrite.writeKey)) {
      continue;
    }

    occupiedWriteKeys.add(atomicWrite.writeKey);
    emittedWrites.push(atomicWrite);
  }

  return emittedWrites.reverse();
}

function flattenAtomicWrites(atomicWrites: readonly AtomicWrite[]): CSSRule {
  const mergedStyle: CSSRule = {};

  for (const atomicWrite of atomicWrites) {
    mergeStyleInto(
      mergedStyle as unknown as Record<string, unknown>,
      atomicWrite.style as unknown as Record<string, unknown>
    );
  }

  return mergedStyle;
}

function styleForDeclarationCondition(
  condition: NormalizedCondition,
  property: string,
  value: unknown
): CSSRule {
  let style = {
    [property.startsWith("--") ? "vars" : property]: property.startsWith("--")
      ? { [property]: value }
      : value
  } as CSSRule;

  if (condition.selector !== "&") {
    style = {
      selectors: {
        [condition.selector]: style
      }
    } as CSSRule;
  }

  for (let index = CONDITION_AT_RULES.length - 1; index >= 0; index -= 1) {
    const entry = CONDITION_AT_RULES[index];
    if (entry == null) continue;

    const [conditionKey, atRule] = entry;
    const conditionValue = condition[conditionKey];
    if (conditionValue == null) continue;

    style = {
      [atRule]: {
        [conditionValue]: style
      }
    } as unknown as CSSRule;
  }

  return style;
}

function atomicWriteKey(
  condition: NormalizedCondition,
  property: string
): string {
  return JSON.stringify([
    condition.layer,
    condition.supports,
    condition.media,
    condition.container,
    condition.selector,
    property
  ]);
}

function mergeStyleInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(source)) {
    const previous = target[key];

    if (isPlainObject(previous) && isPlainObject(value)) {
      mergeStyleInto(previous, value);
      continue;
    }

    target[key] = value;
  }
}

function pushResolvedFragment(
  fragmentsOut: ResolvedStyleFragment[],
  inputIdentity: InputIdentity,
  shortcutStack: readonly string[],
  style: CSSRule
) {
  if (Object.keys(style).length === 0) return;

  fragmentsOut.push({
    source: {
      key: inputIdentity.property,
      shortcutStack: [...shortcutStack]
    },
    inputIdentity,
    style
  });
}

function applyInput<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
        result as CSSRule
      );
      return;
    } else {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        {
          [prop]: result
        } as CSSRule
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
      } as CSSRule
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
      mappedValue as CSSRule
    );
    return;
  }

  // Mapped value => assign mapped value
  pushResolvedFragment(fragmentsOut, { property: prop, value }, shortcutStack, {
    [prop]: mappedValue ?? value
  } as CSSRule);
}

function applyShortcutReference<
  Properties extends DefineRulesProperties,
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  Shortcuts extends DefineRulesShortcuts<Properties, Shortcuts, Conditions>,
  Conditions extends DefineRulesConditions
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions>,
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
  preserveReference: boolean,
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  metadata: EngineMetadata
): DefineRulesPresetArtifactV4 {
  const presetArtifact =
    preserveReference && isDefineRulesPresetArtifactV4(presetInput)
      ? presetInput
      : metadata.exportArtifact();

  importPresetInput(presetInput, styleCache, metadata);
  syncPresetArtifact(presetArtifact, metadata.exportArtifact());

  return presetArtifact;
}

function importPresetInput(
  presetInput: DefineRulesPresetInput | undefined,
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  metadata: EngineMetadata
): void {
  if (presetInput == null) {
    return;
  }

  if (Array.isArray(presetInput)) {
    for (const item of presetInput) {
      importPresetInput(item, styleCache, metadata);
    }
    return;
  }

  if (!isDefineRulesPresetArtifactV4(presetInput)) {
    throwUnsupportedPresetInput();
  }

  importV4PresetArtifact(presetInput, styleCache, metadata);
}

function isDefineRulesPresetArtifactV4(
  value: unknown
): value is DefineRulesPresetArtifactV4 {
  return (
    isPlainRecordObject(value) &&
    value.schema === "mincho.defineRulesPreset" &&
    value.version === 4 &&
    isStringRecord(value.classNameByCache) &&
    isNumberRecord(value.writeKeyByCacheKey) &&
    isPlainRecordObject(value.conditionById) &&
    Object.values(value.conditionById).every(isNormalizedCondition) &&
    isStringRecord(value.propertyById) &&
    isPlainRecordObject(value.writeKeyById) &&
    Object.values(value.writeKeyById).every(isPresetWriteKey)
  );
}

function importV4PresetArtifact(
  artifact: DefineRulesPresetArtifactV4,
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  metadata: EngineMetadata
): void {
  const conditionIdMap: Record<number, number> = {};
  const propertyIdMap: Record<number, number> = {};
  const writeKeyIdMap: Record<number, number> = {};

  for (const [artifactConditionId, condition] of Object.entries(
    artifact.conditionById
  )) {
    conditionIdMap[Number(artifactConditionId)] =
      metadata.internCondition(condition);
  }

  for (const [artifactPropertyId, property] of Object.entries(
    artifact.propertyById
  )) {
    propertyIdMap[Number(artifactPropertyId)] =
      metadata.internProperty(property);
  }

  for (const [artifactWriteKeyId, writeKey] of Object.entries(
    artifact.writeKeyById
  )) {
    const conditionId = conditionIdMap[writeKey.conditionId];
    const propertyId = propertyIdMap[writeKey.propertyId];
    if (conditionId === undefined || propertyId === undefined) {
      throwUnsupportedPresetInput();
    }
    writeKeyIdMap[Number(artifactWriteKeyId)] = metadata.internWriteKey(
      conditionId,
      propertyId
    );
  }

  styleCache.importSnapshot(artifact.classNameByCache);

  for (const [cacheKey, artifactWriteKeyId] of Object.entries(
    artifact.writeKeyByCacheKey
  )) {
    const className = artifact.classNameByCache[cacheKey];
    const writeKeyId = writeKeyIdMap[artifactWriteKeyId];

    if (className === undefined || writeKeyId === undefined) {
      throwUnsupportedPresetInput();
    }

    metadata.registerAtomicCacheEntry(cacheKey, className, writeKeyId);
  }
}

function internAtomicWriteKey(
  metadata: EngineMetadata,
  atomicWrite: AtomicWrite
): number {
  const conditionId = metadata.internCondition(atomicWrite.condition);
  const propertyId = metadata.internProperty(atomicWrite.property);
  return metadata.internWriteKey(conditionId, propertyId);
}

function registerAtomicWriteMetadata(
  metadata: EngineMetadata,
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  className: string,
  writeKeyId: number
): void {
  const cacheKey = findCacheKeyForClassName(styleCache, className);
  metadata.registerAtomicCacheEntry(cacheKey, className, writeKeyId);
}

function findCacheKeyForClassName(
  styleCache: ReturnType<typeof createCanonicalStyleCache>,
  className: string
): string {
  for (const [cacheKey, cachedClassName] of Object.entries(
    styleCache.exportSnapshot()
  )) {
    if (cachedClassName === className) {
      return cacheKey;
    }
  }

  throw new Error(`Unable to resolve defineRules cache key for ${className}`);
}

function clonePresetArtifact(
  artifact: DefineRulesPresetArtifactV4
): DefineRulesPresetArtifactV4 {
  return {
    schema: "mincho.defineRulesPreset",
    version: 4,
    classNameByCache: { ...artifact.classNameByCache },
    writeKeyByCacheKey: { ...artifact.writeKeyByCacheKey },
    conditionById: cloneConditionById(artifact.conditionById),
    propertyById: { ...artifact.propertyById },
    writeKeyById: cloneWriteKeyById(artifact.writeKeyById)
  };
}

function cloneConditionById(
  conditionById: DefineRulesPresetArtifactV4["conditionById"]
): DefineRulesPresetArtifactV4["conditionById"] {
  const clone: DefineRulesPresetArtifactV4["conditionById"] = {};

  for (const [conditionId, condition] of Object.entries(conditionById)) {
    clone[Number(conditionId)] = { ...condition };
  }

  return clone;
}

function cloneWriteKeyById(
  writeKeyById: DefineRulesPresetArtifactV4["writeKeyById"]
): DefineRulesPresetArtifactV4["writeKeyById"] {
  const clone: DefineRulesPresetArtifactV4["writeKeyById"] = {};

  for (const [writeKeyId, writeKey] of Object.entries(writeKeyById)) {
    clone[Number(writeKeyId)] = { ...writeKey };
  }

  return clone;
}

function syncPresetArtifact(
  target: DefineRulesPresetArtifactV4,
  source: DefineRulesPresetArtifactV4
): void {
  target.schema = source.schema;
  target.version = source.version;
  replaceRecord(target.classNameByCache, source.classNameByCache);
  replaceRecord(target.writeKeyByCacheKey, source.writeKeyByCacheKey);
  replaceRecord(target.conditionById, source.conditionById);
  replaceRecord(target.propertyById, source.propertyById);
  replaceRecord(target.writeKeyById, source.writeKeyById);
}

function replaceRecord<T>(
  target: Record<string, T>,
  source: Record<string, T>
) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainRecordObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isPlainRecordObject(value) &&
    Object.values(value).every((entry) => typeof entry === "number")
  );
}

function isPresetWriteKey(
  value: unknown
): value is DefineRulesPresetArtifactV4["writeKeyById"][number] {
  return (
    isPlainRecordObject(value) &&
    typeof value.conditionId === "number" &&
    typeof value.propertyId === "number"
  );
}

function isNormalizedCondition(value: unknown): value is NormalizedCondition {
  return (
    isPlainRecordObject(value) &&
    typeof value.selector === "string" &&
    (value.layer === null || typeof value.layer === "string") &&
    (value.supports === null || typeof value.supports === "string") &&
    (value.media === null || typeof value.media === "string") &&
    (value.container === null || typeof value.container === "string")
  );
}

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function throwUnsupportedPresetInput(): never {
  throw new Error(
    "Unsupported defineRules preset input at config.presets; expected version 4"
  );
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect, afterEach } = import.meta.vitest;

  afterEach(() => {
    while (hasFileScope()) {
      endFileScope();
    }
  });

  function cloneRuntimePresetArtifact(
    artifact: DefineRulesPresetArtifactV4
  ): DefineRulesPresetArtifactV4 {
    return clonePresetArtifact(artifact);
  }

  describe("defineRules runtime presets", () => {
    it("exports v4 artifacts with metadata maps and no runtime-only state", () => {
      setFileScope("runtime-v4.css.ts", "pkg");
      const runtime = createDefineRulesRuntime({
        debugId: "runtimeV4Artifact",
        properties: {
          color: true
        }
      });
      const className = runtime.css({ color: "red" });
      const artifact = runtime.preset;

      expect(Object.keys(artifact)).toEqual([
        "schema",
        "version",
        "classNameByCache",
        "writeKeyByCacheKey",
        "conditionById",
        "propertyById",
        "writeKeyById"
      ]);
      expect(artifact).not.toHaveProperty("registeredSegments");
      expect(artifact).not.toHaveProperty("segmentCache");
      expect(artifact).not.toHaveProperty("fullResultCache");
      expect(artifact).not.toHaveProperty("cx");
      expect(artifact).not.toHaveProperty("atomicClassByClassName");
      expect(artifact.version).toBe(4);
      expect(Object.values(artifact.classNameByCache)).toEqual([className]);
      expect(Object.keys(artifact.writeKeyByCacheKey)).toEqual(
        Object.keys(artifact.classNameByCache)
      );
      expect(
        JSON.stringify({
          writeKeyByCacheKey: artifact.writeKeyByCacheKey,
          conditionById: artifact.conditionById,
          propertyById: artifact.propertyById,
          writeKeyById: artifact.writeKeyById
        })
      ).not.toContain(className);
    });

    it("remaps colliding artifact-local IDs from imported v4 presets", () => {
      setFileScope("runtime-remap.css.ts", "pkg");
      const colorProvider = createDefineRulesRuntime({
        debugId: "colorProvider",
        properties: {
          color: true
        }
      });
      const backgroundProvider = createDefineRulesRuntime({
        debugId: "backgroundProvider",
        properties: {
          background: true
        }
      });
      const colorClassName = colorProvider.css({ color: "red" });
      const backgroundClassName = backgroundProvider.css({
        background: "blue"
      });
      const colorPreset = cloneRuntimePresetArtifact(colorProvider.preset);
      const backgroundPreset = cloneRuntimePresetArtifact(
        backgroundProvider.preset
      );

      expect(Object.keys(colorPreset.writeKeyById)).toEqual(["0"]);
      expect(Object.keys(backgroundPreset.writeKeyById)).toEqual(["0"]);

      const consumer = createDefineRulesRuntime({
        debugId: "remapConsumer",
        presets: [colorPreset, backgroundPreset],
        properties: {
          color: true,
          background: true
        }
      });

      expect(consumer.css({ color: "red" })).toBe(colorClassName);
      expect(consumer.css({ background: "blue" })).toBe(backgroundClassName);

      const importedCacheKeys = Object.keys(consumer.preset.writeKeyByCacheKey);
      const colorCacheKey = Object.keys(colorPreset.classNameByCache)[0];
      const backgroundCacheKey = Object.keys(
        backgroundPreset.classNameByCache
      )[0];
      const colorWriteKeyId =
        consumer.preset.writeKeyByCacheKey[colorCacheKey as string];
      const backgroundWriteKeyId =
        consumer.preset.writeKeyByCacheKey[backgroundCacheKey as string];

      expect(importedCacheKeys).toEqual(
        expect.arrayContaining([colorCacheKey, backgroundCacheKey])
      );
      expect(colorWriteKeyId).not.toBe(backgroundWriteKeyId);
      expect(
        consumer.preset.propertyById[
          consumer.preset.writeKeyById[colorWriteKeyId].propertyId
        ]
      ).toBe("color");
      expect(
        consumer.preset.propertyById[
          consumer.preset.writeKeyById[backgroundWriteKeyId].propertyId
        ]
      ).toBe("background");

      consumer.preset.classNameByCache = {};
      consumer.preset.writeKeyByCacheKey = {};
      consumer.preset.conditionById = {};
      consumer.preset.propertyById = {};
      consumer.preset.writeKeyById = {};
      expect(
        consumer.cx(colorClassName, backgroundClassName, colorClassName)
      ).toBe(`${backgroundClassName} ${colorClassName}`);
    });
  });
}

// == Utils ====================================================================
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object | undefined, key: PropertyKey): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

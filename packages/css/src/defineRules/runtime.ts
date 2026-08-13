import { collectStyleDeclarations } from "@mincho-js/transform-to-vanilla";
import type {
  ConditionAliasMap,
  CSSRule,
  NormalizedCondition
} from "@mincho-js/transform-to-vanilla";
import type { ClassValue, Cx } from "../classname/index.js";
import { isUnSafeObjectKey } from "../utils.js";
import { createCx } from "../classname/cx.js";
import { registerDefineRulesRegistryInstance } from "./registry.js";
import { normalizeDefineRulesConditions } from "./conditions.js";
import { createCanonicalStyleCache } from "./utils.js";
import { createCanonicalWriteKey, createEngineMetadata } from "./metadata.js";
import type { CompiledSegment, EngineMetadata } from "./metadata.js";
import { createRuntimePresetState } from "./runtimePreset.js";
import { createPresetOriginId } from "./presetCanonical.js";
import { createDefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";
import type { DefineRulesCxRuntimeArtifact } from "./cxRuntimeArtifact.js";
import type {
  DefineRulesCss,
  DefineRulesComplexCssInput,
  DefineRulesCtx,
  DefineRulesConditions,
  DefineRulesEmptyConditions,
  DefineRulesPresetArtifactV5,
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
  Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  Context = undefined
> {
  css: DefineRulesCss<
    DefineRulesComplexCssInput<Properties, Shortcuts, Conditions>,
    Context
  >;
  cx: DefineRulesRuntimeCx;
  readonly preset: DefineRulesPresetArtifactV5;
}

export interface DefineRulesRuntimeOptions {
  registerPreset?: boolean;
}

export function createDefineRulesRuntime<
  const Properties extends DefineRulesProperties,
  const Shortcuts extends DefineRulesShortcuts<
    Properties,
    Shortcuts,
    Conditions
  >,
  const Conditions extends DefineRulesConditions = DefineRulesEmptyConditions,
  const Context = undefined
>(
  config: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
  options: DefineRulesRuntimeOptions = {}
): DefineRulesRuntimeResult<Properties, Shortcuts, Conditions, Context> & {
  readonly getCxRuntimeArtifact: () => DefineRulesCxRuntimeArtifact;
} {
  type CssInput = DefineRulesComplexCssInput<Properties, Shortcuts, Conditions>;
  type ContextualCssInput = CssInput | ((context: Context) => CssInput);
  const normalizedConditions = normalizeDefineRulesConditions(
    config.conditions
  );
  const styleCache = createCanonicalStyleCache(config.debugId);
  const metadata = createEngineMetadata();
  const presetState = createRuntimePresetState(
    config.presets,
    styleCache,
    metadata
  );

  if (options.registerPreset !== false) {
    const registryInstance = registerDefineRulesRegistryInstance({
      config: config as DefineRulesCtx<Properties, Shortcuts, Conditions>,
      getPresetSnapshot: presetState.getSnapshot
    });

    if (registryInstance !== undefined) {
      presetState.bindOrigin(
        createPresetOriginId({
          packageName: registryInstance.fileScope.packageName,
          producerPath: registryInstance.fileScope.filePath,
          registrationIndex: registryInstance.registrationIndex
        })
      );
    }
  }

  function resolveToFragments(args: CssInput): ResolvedStyleFragment[] {
    const fragments: ResolvedStyleFragment[] = [];
    applyInput(config, fragments, args, []);
    return fragments;
  }

  function resolveContextualInput(args: ContextualCssInput): CssInput {
    if (typeof args === "function") {
      return args(config.context as Context);
    }

    return args;
  }

  function cssRaw(args: ContextualCssInput): CSSRule {
    return flattenAtomicWrites(
      collectEmittedAtomicWrites(
        collectAtomicWrites(
          resolveToFragments(resolveContextualInput(args)),
          normalizedConditions
        )
      )
    );
  }

  function cssImpl(args: ContextualCssInput): string {
    const atomicWrites = collectEmittedAtomicWrites(
      collectAtomicWrites(
        resolveToFragments(resolveContextualInput(args)),
        normalizedConditions
      )
    );
    const entries = [] as Array<{
      kind: "known";
      className: string;
      writeKeyId: number;
    }>;

    for (const atomicWrite of atomicWrites) {
      const { cacheKey, className } = styleCache.addFragment(
        atomicWrite.property,
        atomicWrite.value,
        atomicWrite.style
      );
      const inheritedWriteKeyId = metadata.getWriteKeyIdForClassName(className);
      const writeKeyId = internAtomicWriteKey(metadata, atomicWrite);

      if (inheritedWriteKeyId === undefined) {
        presetState.addOwnAtom({
          cacheKey,
          className,
          condition: atomicWrite.condition,
          property: atomicWrite.property
        });
      }

      entries.push({ kind: "known", className, writeKeyId });
    }

    const className = entries.map((entry) => entry.className).join(" ");
    const marker = metadata.registerSegment(className, {
      entries,
      hasKnownAtomicClass: entries.length > 0
    });
    const markedClassName =
      marker === undefined ? className : `${marker} ${className}`;

    return markedClassName;
  }

  const css = Object.assign(cssImpl, {
    raw: cssRaw
  }) as DefineRulesCss<CssInput, Context>;
  const cx = createDefineRulesCx(metadata);
  return {
    css,
    cx,
    getCxRuntimeArtifact() {
      return createDefineRulesCxRuntimeArtifact(
        presetState.getSnapshot(),
        metadata.getRegisteredSegmentsByMarker()
      );
    },
    get preset() {
      return presetState.getSnapshot();
    }
  };
}

function createDefineRulesCx(metadata: EngineMetadata): DefineRulesRuntimeCx {
  const cxImpl = (...inputs: ClassValue[]) => {
    return metadata.mergeCompiledSegments(
      collectClassValueSegments(metadata, inputs)
    );
  };

  return createCx(cxImpl) as DefineRulesRuntimeCx;
}

function collectClassValueSegments(
  metadata: EngineMetadata,
  inputs: readonly ClassValue[]
): CompiledSegment[] {
  const segments: CompiledSegment[] = [];

  for (const input of inputs) {
    pushClassValueSegments(metadata, segments, input);
  }

  return segments;
}

function pushClassValueSegments(
  metadata: EngineMetadata,
  segments: CompiledSegment[],
  input: ClassValue
): void {
  if (typeof input === "string") {
    pushClassStringSegments(metadata, segments, input);
    return;
  }

  if (typeof input === "number") {
    if (input) {
      segments.push(metadata.getCompiledSegment(String(input)));
    }
    return;
  }

  if (typeof input === "bigint") {
    if (input !== 0n) {
      segments.push(metadata.getCompiledSegment(String(input)));
    }
    return;
  }

  if (
    input === null ||
    input === undefined ||
    input === false ||
    input === true
  ) {
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      pushClassValueSegments(metadata, segments, item);
    }
    return;
  }

  for (const className in input) {
    if (input[className]) {
      pushClassStringSegments(metadata, segments, className);
    }
  }
}

function pushClassStringSegments(
  metadata: EngineMetadata,
  segments: CompiledSegment[],
  className: string
): void {
  if (className.length === 0) {
    return;
  }

  const registeredSegment = metadata.getRegisteredSegment(className);

  if (registeredSegment !== undefined) {
    segments.push(registeredSegment);
    return;
  }

  const tokens = className.trim().split(/\s+/);
  const externalTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) {
      continue;
    }

    const markedSegment = metadata.getSegmentByMarkerToken(token);

    if (markedSegment === undefined) {
      externalTokens.push(token);
      continue;
    }

    flushClassTokens(metadata, segments, externalTokens);
    segments.push(markedSegment);
    index = skipSegmentPayload(tokens, index + 1, markedSegment) - 1;
  }

  flushClassTokens(metadata, segments, externalTokens);
}

function flushClassTokens(
  metadata: EngineMetadata,
  segments: CompiledSegment[],
  tokens: string[]
): void {
  if (tokens.length === 0) {
    return;
  }

  segments.push(metadata.getCompiledSegment(tokens.join(" ")));
  tokens.length = 0;
}

function skipSegmentPayload(
  tokens: readonly string[],
  startIndex: number,
  segment: CompiledSegment
): number {
  let index = startIndex;

  for (const entry of segment.entries) {
    if (tokens[index] !== entry.className) {
      return startIndex;
    }

    index += 1;
  }

  return index;
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
        writeKey: createCanonicalWriteKey(
          declaration.condition,
          declaration.property
        )
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

function mergeStyleInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (isUnSafeObjectKey(key)) {
      continue;
    }

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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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
  Conditions extends DefineRulesConditions,
  Context
>(
  ctx: DefineRulesCtx<Properties, Shortcuts, Conditions, Context>,
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

function internAtomicWriteKey(
  metadata: EngineMetadata,
  atomicWrite: AtomicWrite
): number {
  const conditionId = metadata.internCondition(atomicWrite.condition);
  const propertyId = metadata.internProperty(atomicWrite.property);
  return metadata.internWriteKey(conditionId, propertyId);
}

// == Utils ====================================================================
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object | undefined, key: PropertyKey): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

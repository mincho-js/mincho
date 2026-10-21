import {
  createVar as vanillaCreateVar,
  keyframes as vanillaKeyframes
} from "@vanilla-extract/css";

export interface CompilerStyleResources {
  version: 2;
  keyframes: string[];
  foreignKeyframes?: string[];
  recipes: { id: string; classes: string[]; references: string[] }[];
  themes: string[];
}

const styleKey = Symbol.for("@mincho-js/compiler-style-resources/v2");
const styleState = globalThis as typeof globalThis & {
  [styleKey]?: (CompilerStyleResources & {
    classNames: string[];
    localKeyframe: number;
  })[];
};

export function beginCompilerStyleCapture(): CompilerStyleResources {
  const capture: CompilerStyleResources & {
    classNames: string[];
    localKeyframe: number;
  } = {
    version: 2,
    keyframes: [],
    foreignKeyframes: [],
    recipes: [],
    themes: [],
    classNames: [],
    localKeyframe: 0
  };

  (styleState[styleKey] ??= []).push(capture);

  return capture;
}

export function endCompilerStyleCapture(): void {
  styleState[styleKey]?.pop();

  if (!styleState[styleKey]?.length) delete styleState[styleKey];
}

export function recordCompilerTheme(selector: string): void {
  const captures = styleState[styleKey];
  captures?.[captures.length - 1]?.themes.push(selector);
}

export function recordCompilerClass(name: string): void {
  const captures = styleState[styleKey];
  captures?.[captures.length - 1]?.classNames.push(name);
}

export function recordCompilerKeyframeRule(name: string): void {
  const captures = styleState[styleKey];
  const capture = captures?.[captures.length - 1];

  if (capture && !capture.localKeyframe) capture.foreignKeyframes!.push(name);
}

export function compilerRecipeStart(): number | undefined {
  const captures = styleState[styleKey];
  return captures?.[captures.length - 1]?.classNames.length;
}

export function recordCompilerRecipe(
  config: {
    defaultClassName: string;
    variantClassNames: Record<string, Record<string, string>>;
    compoundVariants: readonly (readonly [unknown, string])[];
  },
  start: number | undefined
): void {
  const captures = styleState[styleKey];
  const capture = captures?.[captures.length - 1];
  if (!capture || start === undefined) return;

  const generated = new Set(capture.classNames.slice(start));
  const references = [
    ...new Set(
      [
        config.defaultClassName,
        ...Object.values(config.variantClassNames).flatMap(Object.values),
        ...config.compoundVariants.map(([, name]) => name)
      ]
        .flatMap((name) => name.split(/\s+/))
        .filter(Boolean)
    )
  ].sort();

  capture.recipes.push({
    id: config.defaultClassName,
    classes: references.filter((name) => generated.has(name)),
    references
  });
}

/** Capture only the local API; globalKeyframes always remains author-owned. */
export const keyframes: typeof vanillaKeyframes = (...args) => {
  const captures = styleState[styleKey];
  const capture = captures?.[captures.length - 1];

  if (capture) capture.localKeyframe++;

  try {
    const name = Reflect.apply(vanillaKeyframes, undefined, args) as string;
    capture?.keyframes.push(name);

    return name;
  } finally {
    if (capture) capture.localKeyframe--;
  }
};

// A symbol shares the active capture across bundled copies of the CSS package.
// Captures live only as long as an evaluation; ordinary API calls retain nothing.
const captureKey = Symbol.for("@mincho-js/compiler-resources/v1");
const state = globalThis as typeof globalThis & {
  [captureKey]?: Set<string>[];
};

const tokenKey = Symbol.for("@mincho-js/compiler-token-references/v1");
const tokenState = globalThis as typeof globalThis & {
  [tokenKey]?: Set<string>[];
};

export function beginCompilerTokenCapture(): Set<string> {
  const references = new Set<string>();
  (tokenState[tokenKey] ??= []).push(references);

  return references;
}

export function endCompilerTokenCapture(): void {
  tokenState[tokenKey]?.pop();

  if (!tokenState[tokenKey]?.length) delete tokenState[tokenKey];
}

export function compilerTokenReferences(): string[] {
  const captures = tokenState[tokenKey];
  return [...(captures?.[captures.length - 1] ?? [])];
}

export function replayCompilerTokenReferences(values: readonly string[]): void {
  const captures = tokenState[tokenKey];
  const capture = captures?.[captures.length - 1];

  if (capture) for (const value of values) capture.add(value);
}

export function beginCompilerResourceCapture(): Set<string> {
  const variables = new Set<string>();
  (state[captureKey] ??= []).push(variables);

  return variables;
}

export function endCompilerResourceCapture(): void {
  const captures = state[captureKey];
  captures?.pop();

  if (!captures?.length) delete state[captureKey];
}

/** Only freshly generated variable names qualify, never createGlobalVar names. */
export function recordCompilerVariable(value: string): void {
  const tokenCaptures = tokenState[tokenKey];
  const tokenCapture = tokenCaptures?.[tokenCaptures.length - 1];

  if (tokenCapture && /^var\(--[A-Za-z_][A-Za-z0-9_-]*\)$/.test(value))
    tokenCapture.add(value);

  const captures = state[captureKey];
  const active = captures?.[captures.length - 1];
  if (!active) return;

  const match = /^var\((--[A-Za-z_][A-Za-z0-9_-]*)\)$/.exec(value);

  if (match) active.add(match[1]!);
}

/** Preserve vanilla-extract overloads, naming, registration and errors. */
export const createVar: typeof vanillaCreateVar = (...args) => {
  const value = Reflect.apply(vanillaCreateVar, undefined, args) as ReturnType<
    typeof vanillaCreateVar
  >;

  recordCompilerVariable(value);

  return value;
};

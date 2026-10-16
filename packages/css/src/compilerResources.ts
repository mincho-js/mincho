import { createVar as vanillaCreateVar } from "@vanilla-extract/css";

// A symbol shares the active capture across bundled copies of the CSS package.
// Captures live only as long as an evaluation; ordinary API calls retain nothing.
const captureKey = Symbol.for("@mincho-js/compiler-resources/v1");
const state = globalThis as typeof globalThis & {
  [captureKey]?: Set<string>[];
};

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

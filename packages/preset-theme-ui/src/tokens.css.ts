import { normalizeTheme } from "@mincho-js/theme-ui";
import type {
  BaseTokens,
  SystemTokens,
  DarkTokens,
  ColorModeNames
} from "@mincho-js/theme-ui";

import { base } from "./presets/base.js";
import { system } from "./presets/system.js";
import { dark } from "./presets/dark.js";

// Evaluate normalization at package build so the public entry contains only data.
export const baseTokens: BaseTokens = normalizeTheme(base).tokens;
export const darkTokens: DarkTokens = normalizeTheme(dark).tokens;

const normalizedSystem = normalizeTheme(system);

export const systemTokens: SystemTokens = normalizedSystem.tokens;
export const systemModes: Record<
  ColorModeNames<typeof system>,
  SystemTokens
> = normalizedSystem.modes;

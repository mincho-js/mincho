import { theme } from "@mincho-js/css";
import type { ThemeContract, ThemeResult } from "@mincho-js/css";
import type { BaseTokens, SystemTokens, DarkTokens } from "@mincho-js/theme-ui";

import {
  baseTokens,
  systemTokens,
  darkTokens,
  systemModes
} from "./presets.js";

// This is where contracts are implemented and CSS is emitted, at package build.
const baseResult = theme(baseTokens, "base");

export const baseClass = baseResult[0];
export const baseVars: ThemeResult<BaseTokens>[1] = baseResult[1];
export const baseContract: ThemeContract<BaseTokens> = baseResult[2];

const systemResult = theme(systemTokens, "system");

export const systemClass = systemResult[0];
export const systemVars: ThemeResult<SystemTokens>[1] = systemResult[1];
export const systemContract: ThemeContract<SystemTokens> = systemResult[2];

const darkResult = theme(darkTokens, "dark");

export const darkClass = darkResult[0];
export const darkVars: ThemeResult<DarkTokens>[1] = darkResult[1];
export const darkContract: ThemeContract<DarkTokens> = darkResult[2];

export const [systemDark] = theme.extends(
  systemContract,
  systemModes.dark,
  "systemDark"
);

export const [systemDeep] = theme.extends(
  systemContract,
  systemModes.deep,
  "systemDeep"
);

export const [systemSwiss] = theme.extends(
  systemContract,
  systemModes.swiss,
  "systemSwiss"
);

export const systemModeClasses = {
  default: systemClass,
  dark: systemDark,
  deep: systemDeep,
  swiss: systemSwiss
};

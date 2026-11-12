import { theme } from "@mincho-js/css";
import type { ThemeContract, ThemeResult } from "@mincho-js/css";
import type { TailwindTokens } from "@mincho-js/tailwind";

import { tailwindTokens } from "./tokens.js";

const result = theme(tailwindTokens);

export const themeClass = result[0];
export const vars: ThemeResult<TailwindTokens>[1] = result[1];
export const contract: ThemeContract<TailwindTokens> = result[2];

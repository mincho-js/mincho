import type { Theme } from "@mincho-js/theme-ui";

// Preserve concrete token keys and tuple bounds while checking the Theme UI format.
export function definePreset<const T extends Theme>(value: T): T {
  return value;
}

import { defineRules } from "@mincho-js/css";

export function createPresetOwner() {
  return defineRules({
    properties: {
      color: true,
      display: true
    }
  });
}

export const factoryStatus = "not-executed";

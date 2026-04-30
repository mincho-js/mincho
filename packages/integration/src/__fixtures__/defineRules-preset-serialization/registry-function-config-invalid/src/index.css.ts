import { defineRules } from "@mincho-js/css";

const invalidPresetOwner = defineRules({
  properties: {
    color(value: string) {
      return value;
    }
  }
});

export const raw = invalidPresetOwner.css.raw({
  color: "rebeccapurple"
});

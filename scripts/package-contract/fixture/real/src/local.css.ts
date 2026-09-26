import { defineRules } from "@mincho-js/css";
import { preset } from "@mincho-js-proof/real-d/preset";

const rules = defineRules({ presets: preset, properties: { margin: true } });
export const local = rules.css({ margin: 2 });

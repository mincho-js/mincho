import { css, defineRules } from "@mincho-js/css";
import { preset } from "@mincho-js-proof/real-d/preset";

export { className as b } from "@mincho-js-proof/real-b";
export { className as c } from "@mincho-js-proof/real-c";
export { className as d } from "@mincho-js-proof/real-d";

const rules = defineRules({ presets: preset, properties: { margin: true } });
export const local = css([rules.css({ margin: 2 })]);

import { theme } from "@mincho-js/css";
import type { SystemTokens } from "@mincho-js/theme-ui";
import { systemTokens } from "@mincho-js/preset-theme-ui/presets";

const tokens = {
  ...systemTokens,
  colors: { ...systemTokens.colors, primary: "rebeccapurple" }
} satisfies SystemTokens;

export const [customThemeClass, customVars, contract] = theme(tokens);

export const [customDarkClass] = theme.extends(contract, {
  ...tokens,
  colors: { ...tokens.colors, text: "white", background: "#17231a" }
});

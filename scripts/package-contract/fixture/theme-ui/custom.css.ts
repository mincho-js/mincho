import { theme, defineRules } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/theme-ui";
import type { SystemTokens } from "@mincho-js/theme-ui";
import { systemTokens, systemModes } from "@mincho-js/preset-theme-ui/presets";

const tokens = {
  ...systemTokens,
  colors: { ...systemTokens.colors, primary: "rebeccapurple" }
} satisfies SystemTokens;

const [themeClass, vars, contract] = theme(tokens);
const { rules } = defineRules(themeSpec(vars));

export const custom = {
  themeClass,
  recipes: {
    text: rules({
      variants: { variant: { display: { fontFamily: "heading", fontSize: 6 } } }
    }),
    buttons: rules({
      variants: {
        variant: {
          primary: { color: "background", bg: "primary", px: 2, _sm: { px: 3 } }
        }
      }
    })
  }
};

export const [customDark] = theme.extends(contract, {
  ...systemModes.dark,
  colors: { ...systemModes.dark.colors, primary: tokens.colors.primary }
});

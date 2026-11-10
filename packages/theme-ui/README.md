# Theme UI contracts for Mincho

`@mincho-js/theme-ui` provides token types and the shared
[Theme Specification](https://theme-ui.com/theme-spec) property mappings.
It has no dependency on the preset package and ships no preset CSS.
Use Mincho's `theme()` and `defineRules()` to apply values and write styles.

```sh
npm install @mincho-js/theme-ui @mincho-js/css @vanilla-extract/css
```

## Apply tokens, then define rules

```ts
// app.css.ts
import { theme, defineRules } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/theme-ui";

const tokens = {
  colors: { text: "#111", background: "#fff", primary: "#07c" },
  space: { small: "4px", medium: "8px" },
};

export const [themeClass, vars, contract] = theme(tokens);
const { css, rules, cx } = defineRules(themeSpec(vars));

export const card = css({ p: "medium", color: "text", bg: "background" });
export const button = rules({
  base: { px: "medium", color: "background", bg: "primary" },
  variants: { emphasis: { strong: { fontWeight: 700 } } },
});
export const container = cx(themeClass, card);
```

`themeSpec(vars)` binds Theme UI's property-to-scale mappings, shortcuts and
responsive conditions to the CSS variables returned by `theme()`. It returns
configuration for `defineRules()` and does not create classes or emit CSS.
Custom styles and variants use the resulting native `css`, `rules`, and `cx`.

Configure the [Mincho build integration](https://mincho-js.github.io/mincho/docs/getting-started/)
for authored styles. In Vite, install and register both plugins:

```sh
npm install --save-dev @mincho-js/vite @vanilla-extract/vite-plugin
```

```ts
import { defineConfig } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  plugins: [minchoVitePlugin(), vanillaExtractPlugin()],
});
```

## Token contracts

`SharedTokens`, `BaseTokens`, `SystemTokens`, and `DarkTokens` describe the
normalized preset values. Check your values with `satisfies`, then pass them
directly to `theme()`.

To use the packaged values in this example, install the preset package:

```sh
npm install @mincho-js/preset-theme-ui
```

```ts
import { theme } from "@mincho-js/css";
import type { SystemTokens } from "@mincho-js/theme-ui";
import { systemTokens } from "@mincho-js/preset-theme-ui/presets";

const tokens = {
  ...systemTokens,
  colors: { ...systemTokens.colors, primary: "rebeccapurple" },
} satisfies SystemTokens;

export const [themeClass, vars] = theme(tokens);
```

Contracts preserve upstream token names: base has `fontWeights.bold`, system
and dark have `fontWeights.display`, system has `colors.accent`, and dark has
`colors.purple`. Theme Spec's property mappings are shared across all of them
and also work with custom token names. Mincho's `theme.with<T>()` remains
available when you want a reusable typed factory; no preset-specific wrapper
is needed.

## Optional normalization

Values from `@mincho-js/preset-theme-ui/presets` are already normalized.
When importing an original Theme UI theme, use `normalizeTheme()` to obtain
Mincho token values and complete color-mode values:

```ts
import { theme, defineRules } from "@mincho-js/css";
import { normalizeTheme, themeSpec } from "@mincho-js/theme-ui";
import type { Theme } from "@mincho-js/theme-ui";

const source = {
  colors: {
    text: "#111",
    background: "#fff",
    modes: { dark: { text: "#fff", background: "#111" } },
  },
  space: [0, 4, 8],
} satisfies Theme;

const normalized = normalizeTheme(source);
export const [light, vars, contract] = theme(normalized.tokens);
export const [dark] = theme.extends(contract, normalized.modes.dark);
const { css } = defineRules(themeSpec(vars));
export const card = css({ p: 2, color: "text", bg: "background" });
```

Normalization copies the input, converts numeric lengths to px, preserves
numeric scale keys and named aliases, and supplies Theme UI's omitted
`space`/`fontSizes` defaults. Weights and line heights remain unitless.
Color modes inherit base values and share the same token structure. Keys found
only in a mode have the CSS initial value in other modes; changing a scalar
token into an object is rejected.

Literal themes retain their exact mode names. For sources annotated as `Theme`,
mode lookups may be `undefined`; check a mode before passing it to `theme.extends()`.

The return value is `{ tokens, modes }`. This is a data transformation: it
creates no CSS, variables, or classes. It does not convert `styles`, component
variants, callbacks, or provider settings. Write application styles with the
native `css()` and `rules()` functions. The preset package compiles theme
variables and color modes; applications choose their component styles.

## Theme Spec

The 16 scales map to CSS properties, including logical properties and SVG
colors. Provided scales constrain values to token keys and CSS-wide keywords;
absent scales allow ordinary CSS. Nested keys use dotted paths and respect
`__default`. Margin and inset accept negative token keys; padding and gaps do
not. Shortcuts include `bg`, `m`/`p`, axis spacing, scroll spacing, and `size`.

`p` expands through `px` and `py` to `paddingLeft`, `paddingRight`,
`paddingTop`, and `paddingBottom`. Margin shortcuts use the same pattern.
`cx()` can replace horizontal spacing while retaining vertical spacing and
styles in other conditions.

Default conditions are `_sm: 40em`, `_md: 52em`, and `_lg: 64em`. Pass an array
or named conditions as the second argument. Custom breakpoints replace the
defaults, so include defaults explicitly when extending them:

```ts
themeSpec(vars, {
  sm: "40em",
  md: "52em",
  lg: "64em",
  landscape: "@media (min-width: 56em) and (orientation: landscape)",
});
```

Use concrete lengths or media-query conditions for breakpoints. CSS variables
cannot be resolved in media queries and are rejected by `themeSpec()`.

## Package boundaries

All exports come from the package root: token and Theme UI source types,
`themeSpec()`, scale/shortcut/default data, and optional `normalizeTheme()`.
The separately published [`@mincho-js/preset-theme-ui`](../preset-theme-ui)
provides normalized values, compiled theme classes and variables, and an
explicit CSS asset. Its `base`, `system`, and `dark` definitions expose native
`css`, `rules`, `cx`, and `preset` APIs. Applications compile their own
component styles and recipes through those definitions.

Public types use `@mincho-js/csstype`, the same types as Mincho.
`@theme-ui/css` and Emotion types are development-only compatibility references;
`CSSObject` from Emotion is not re-exported. TypeScript 5.9.3 is used for
validation. This package does not implement `ThemeProvider`, `sx`, hooks,
automatic OS preference, storage, or hydration behavior.

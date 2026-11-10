# Theme UI Presets

The preset package supplies Theme UI v0.17.4 token values, compiled themes, and native Mincho authoring definitions. The separate `@mincho-js/theme-ui` package supplies token types, the Theme Spec mappings, and optional normalization.

## Install and configure

Configure the Mincho and Vanilla Extract plugins to compile application styles. Import the preset stylesheet once to load the theme variables.

```sh
npm install @mincho-js/css @mincho-js/theme-ui @mincho-js/preset-theme-ui @vanilla-extract/css
npm install -D @mincho-js/vite @vanilla-extract/vite-plugin
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-theme-ui/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  plugins: [minchoVitePlugin({ extractCalls }), vanillaExtractPlugin()],
});
```

`/config` contains only extraction metadata, so it can be loaded in a Node build
configuration without loading theme CSS or authoring APIs. It registers the
`css`, `rules`, and `cx` methods of all three exported definitions for
co-location. In React apps, put the Mincho plugin before the React plugin.

```tsx
// Card.tsx
import { system, systemClass } from "@mincho-js/preset-theme-ui";
import "@mincho-js/preset-theme-ui/styles.css";

const card = system.css({ color: "text", bg: "background", p: 3 });

export function Card() {
  return (
    <section className={`${systemClass} ${card}`}>Theme UI tokens</section>
  );
}
```

## Use the shared definition

`base`, `system`, and `dark` are native `defineRules()` results. Destructure `css`, `rules`, `cx`, or `preset` from the definition you choose. Author component styles in your own `.css.ts` file.

```ts
// card.css.ts
import { system, systemClass } from "@mincho-js/preset-theme-ui";

const { css, rules, cx } = system;

export const card = cx(
  systemClass,
  css({
    color: "text",
    bg: "background",
    p: 3,
    _md: { p: 4 },
  }),
);
export const button = rules({
  base: { color: "background", bg: "primary", px: 2, py: 2 },
  variants: { size: { large: { px: 4, py: 3 } } },
});
```

```tsx
import { card, button } from "./card.css";
import "@mincho-js/preset-theme-ui/styles.css";

export function Card() {
  return (
    <section className={card}>
      <button className={button({ size: "large" })}>Create project</button>
    </section>
  );
}
```

## Package responsibilities

`styles.css` contains only the theme variables and system color modes. It does not generate document selectors, containers, headings, or application recipes. The consumer compiles those styles through the exported definition. Only the resulting class strings and recipe selectors are needed by React at runtime.

The root also exports `baseClass`, `systemClass`, `darkClass`, their `*Vars` and `*Contract` values, and `systemModeClasses`. JavaScript imports do not load CSS. Reading compiled theme data in Node/SSR needs no build plugin; calling `css()` or `rules()` belongs in a style build.

`system.preset` is Mincho's native compiled-style artifact, not a theme value object. Use `defineRules.extends(system, ...)` to extend the authoring vocabulary:

```ts
import { defineRules } from "@mincho-js/css";
import { system } from "@mincho-js/preset-theme-ui";

const { css } = defineRules.extends(system, {
  properties: { display: ["grid", "flex"] },
});
export const layout = css({ display: "grid", gap: 3, color: "primary" });
```

## Customize tokens and conditions

`/presets` exports normalized `baseTokens`, `systemTokens`, `darkTokens`, and `systemModes` as plain data. Create an independent theme using the original Mincho `theme()` function, then bind its variables with `themeSpec()`. These styles do not require the shipped stylesheet.

The type contracts preserve upstream differences: base has `fontWeights.bold`, system and dark have `fontWeights.display`, system has `colors.accent`, and dark has `colors.purple`.

```ts
// custom.css.ts
import { theme, defineRules } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/theme-ui";
import { systemTokens, systemModes } from "@mincho-js/preset-theme-ui/presets";

const tokens = {
  ...systemTokens,
  colors: { ...systemTokens.colors, primary: "rebeccapurple" },
};
export const [themeClass, vars, contract] = theme(tokens);
export const [darkClass] = theme.extends(contract, {
  ...systemModes.dark,
  colors: { ...systemModes.dark.colors, primary: tokens.colors.primary },
});
const { css, rules, cx } = defineRules(themeSpec(vars, { tablet: "48em" }));

export const panel = cx(
  themeClass,
  css({ bg: "background", _tablet: { p: 4 } }),
);
export const action = rules({ base: { bg: "primary", color: "background" } });
```

## Scales and color modes

The 16 Theme Specification scales map to CSS properties. `p: 2` selects `space[2]` (`8px`), while `mx: -2` uses its negative value. Indexed scales retain their bounds; dotted paths select nested tokens. Length tokens include units; weights and line heights remain unitless. Provided scales restrict values to their token names; absent scales accept ordinary CSS.

`p` expands through `px` and `py` to the four physical padding properties. Margin shortcuts follow the same pattern. For example, `cx(css({ p: 2 }), css({ px: 3 }))` replaces left and right padding while keeping top and bottom padding at `space[2]`. Styles in separate conditions retain their own values.

Default conditions are `_sm: 40em`, `_md: 52em`, and `_lg: 64em`. Custom breakpoints replace them. Native `rules()` and `rules.extends()` define the consumer's component variants.

`systemModeClasses` has `default`, `dark`, `deep`, and `swiss` class names. Replace the active class to switch modes. For token values, `/presets` exports `systemTokens` for the default mode and `systemModes.dark`, `systemModes.deep`, and `systemModes.swiss` for named modes. Use `theme.extends(systemContract, values)` for a mode that shares the compiled system variables. OS preference and storage belong to the application.

## Normalize original tokens

Shipped tokens are already normalized. For original Theme UI data, `normalizeTheme()` converts length units and completes color modes without generating CSS. It returns `{ tokens, modes }`. It does not interpret `sx`, source `styles`, or `variant` references; write those component choices using native `css()` and `rules()`.

Public types use Mincho's `@mincho-js/csstype`; upstream types are development-only compatibility references. Theme UI and Emotion styling packages are not consumer dependencies. Validation uses TypeScript 5.9.3. Try the React example with `yarn workspace @examples/theme-ui dev`.

```ts
import { theme } from "@mincho-js/css";
import { normalizeTheme } from "@mincho-js/theme-ui";

const normalized = normalizeTheme({
  space: [0, 4, 8],
  colors: { text: "#111", modes: { dark: { text: "#fff" } } },
});
export const [light, vars, contract] = theme(normalized.tokens);
export const [dark] = theme.extends(contract, normalized.modes.dark);
```

# Theme UI Presets

The preset package supplies Theme UI v0.17.4 token values, compiled themes, and native Mincho authoring definitions. The separate `@mincho-js/theme-ui` package supplies token types, the Theme Spec mappings, and optional normalization.

## Install and configure

In a React app, put the Mincho plugin before the React plugin to compile co-located styles. Keep the Vanilla Extract plugin for shared `.css.ts` themes. Import the preset stylesheet once to load the theme variables.

```sh
npm install @mincho-js/css @mincho-js/react @mincho-js/theme-ui @mincho-js/preset-theme-ui @vanilla-extract/css
npm install -D @mincho-js/vite @vanilla-extract/vite-plugin @vitejs/plugin-react
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-theme-ui/config";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  plugins: [
    minchoVitePlugin({ extractCalls }),
    vanillaExtractPlugin(),
    react(),
  ],
});
```

## Use the shared definition

`base`, `system`, and `dark` are native `defineRules()` results. The preset's `extractCalls` registers their `css`, `rules`, and `cx` methods, so you can call them at module scope in the component's `.tsx` file. The plugin extracts these calls, leaving class strings and recipe selectors for the component. `/config` is plain data that can be imported in Node without loading theme CSS or authoring APIs.

For React components, pass the chosen definition to `defineRules()` from `@mincho-js/react`. This preserves its native `css`, `rules`, and `cx` methods and adds intrinsic `styled` factories. Define the components in a `mincho$()` block so their styles compile at build time; select variants through props when rendering. The same definitions can also live in a separate `.css.ts` file.

[Theme UI's variant groups](https://theme-ui.com/theme-spec) organize reusable choices under names such as `text.heading` and `buttons.primary`. In this example, local `text` and `buttons` groups become Mincho recipe variants. They are application components, not extra exports from the preset. This uses Mincho's native `styled` API without implementing Theme UI's `sx` prop or resolving `variant` paths.

```tsx
// Card.tsx
import { mincho$ } from "@mincho-js/css";
import { defineRules as defineReactRules } from "@mincho-js/react";
import { system, systemClass } from "@mincho-js/preset-theme-ui";
import "@mincho-js/preset-theme-ui/styles.css";

const { Box, Heading, Button } = mincho$(() => {
  const { styled } = defineReactRules(system);
  const text = {
    heading: {
      fontFamily: "heading",
      fontWeight: "heading",
      lineHeight: "heading",
    },
    display: { fontSize: { base: 5, _sm: 6 } },
  } as const;
  const buttons = {
    primary: { color: "background", bg: "primary" },
    secondary: { color: "background", bg: "secondary" },
  } as const;

  return {
    Box: styled.section({
      base: { color: "text", bg: "background", p: { base: 3, _md: 4 } },
    }),
    Heading: styled.h2({
      base: text.heading,
      variants: {
        variant: { heading: { fontSize: 4 }, display: text.display },
      },
      defaultVariants: { variant: "heading" },
    }),
    Button: styled.button({
      base: { px: 3, py: 2 },
      variants: { variant: buttons },
      defaultVariants: { variant: "primary" },
    }),
  };
});

export function Card() {
  return (
    <Box className={systemClass}>
      <Heading variant="display">A shared vocabulary</Heading>
      <Button variant="primary">Create project</Button>
    </Box>
  );
}
```

## Package responsibilities

`styles.css` contains only the theme variables and system color modes. It does not generate document selectors, containers, headings, or application recipes. The consumer compiles those styles through the exported definition. React components use the resulting classes and recipe selectors.

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

Default conditions are `_sm: 40em`, `_md: 52em`, and `_lg: 64em`. Custom breakpoints replace them. Write responsive values as Mincho condition objects, for example `fontSize: { base: 3, _sm: 4 }`. Native `rules()`, `rules.extends()`, and the React adapter's `styled` factories define the consumer's component variants.

`systemModeClasses` has `default`, `dark`, `deep`, and `swiss` class names. Replace the active class to switch modes. Components keep semantic values such as `color: "text"` and `bg: "primary"`; the class changes the values behind those tokens, following [Theme UI's color-mode model](https://theme-ui.com/color-modes).

For token values, `/presets` exports `systemTokens` for the default mode and `systemModes.dark`, `systemModes.deep`, and `systemModes.swiss` for named modes. Use `theme.extends(systemContract, values)` for a mode that shares the compiled system variables. OS preference and storage belong to the application.

## Normalize original tokens

Shipped tokens are already normalized. For original Theme UI data, `normalizeTheme()` converts length units and completes color modes without generating CSS. It returns `{ tokens, modes }`. It does not interpret `sx`, source `styles`, or `variant` references; write those component choices using native `css()`, `rules()`, or the React adapter's `styled` factories.

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

# @mincho-js/tailwind

Tailwind CSS 4.3.5 design token contracts and style mappings for native Mincho.
Use `theme()` to implement a contract and `defineRules(themeSpec(vars))` to bind
its values to CSS properties, responsive conditions, and compound utilities.

```sh
npm install @mincho-js/css @mincho-js/tailwind @mincho-js/preset-tailwind @vanilla-extract/css
npm install -D @mincho-js/vite @vanilla-extract/vite-plugin
```

Configure the Mincho and Vanilla Extract Vite plugins as described in the
[Tailwind style setup](https://mincho-js.github.io/mincho/docs/tailwind#install-and-configure).
For preset-specific React JSX types and `styled` components, use
[@mincho-js/preset-tailwind-react](../preset-tailwind-react/README.md).

```ts
// card.css.ts
import { theme, defineRules } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/tailwind";
import { tailwindTokens } from "@mincho-js/preset-tailwind/tokens";

export const [themeClass, vars] = theme(tailwindTokens);
const { css, rules } = defineRules(themeSpec(vars));

export const card = css({
  bg: "white",
  color: "slate-900",
  p: 6,
  rounded: "xl",
  shadow: "sm",
  fontSize: "base",
  _md: { p: 8 },
});

export const button = rules({
  base: { px: 4, py: 2, rounded: "lg" },
  variants: {
    tone: {
      solid: { bg: "sky-600", color: "white" },
      soft: { bg: "sky-50", color: "sky-900" },
    },
  },
});
```

Apply `themeClass` on an ancestor. Import `@mincho-js/preset-tailwind/styles.css`
for the default animation keyframes. The optional Preflight reset is a separate
`@mincho-js/preset-tailwind/preflight.css` import.

| Tailwind style                | Native Mincho authoring                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Named palette and typography  | `color: "sky-600"`, `fontSize: "lg"`, `fontWeight: "bold"`                             |
| Spacing multipliers           | `p: 4`, `mx: -2`, `gap: 1.5`; numbers multiply the `spacing` token                     |
| Literal lengths and fractions | `p: "12px"`, `w: "1/2"`, `h: "dvh"`                                                    |
| Directional spacing           | `px` / `mx` set left and right; `py` / `my` set top and bottom                         |
| Logical directions            | `ps` / `ms` set inline-start; `pe` / `me` set inline-end                               |
| Responsive styles             | `_sm`, `_md`, `_lg`, `_xl`, `_screen2xl`                                               |
| Compound utilities            | `srOnly: true`, `notSrOnly: true`, `truncate: true`, `lineClamp: 3`, `container: true` |
| Effects                       | `shadow: "md"`, `blur: "sm"`, `dropShadow: "lg"`, `animate: "spin"`                    |

Font sizes include their original line heights. Set `lineHeight` after `fontSize`
to override that pair. Numeric `lineHeight` values are spacing multipliers;
use a string such as `"1.5"` for a literal unitless line height.

Pass a named map of literal lengths as the second argument to `themeSpec()` to
customize breakpoints. `2xl` becomes `screen2xl` because native condition names
start with a letter. Breakpoints are not CSS variables. The container utility
sets responsive maximum widths; it does not add centering or padding.

Use ordinary CSS properties for single-property styles and native selectors for
states. Combine effects with literal `css` imported from `@mincho-js/css`: its
`filter_` joins functions with spaces and `boxShadow$` joins shadows with commas.
Use resolved values from `vars` for these literal declarations. The `blur`,
`dropShadow` and `insetShadow` properties each assign a whole CSS property.

The complete `TailwindTokens` type describes the default contract. Spread the
default tokens to customize or add named values; `TailwindScales` accepts custom
keys in a complete theme. The contract package emits no CSS. It does not parse
Tailwind class strings or include Tailwind's scanner, compiler, or plugin system.
Keep the `defineRules()` definition local to a `.css.ts` module and export its
generated classes and recipes; its spacing resolvers are authoring functions.

Original styles and tokens are MIT licensed by Tailwind Labs. See `NOTICE`.

## Familiar utility vocabulary

```ts
// primary-button.css.ts
import { css } from "@mincho-js/preset-tailwind";

export const primaryButton = css([
  {
    bg: { base: "blue-500", _hover: "blue-700" },
    text: "white",
    font: "bold",
    py: 2,
    px: 3,
  },
  "rounded",
]);
```

Apply `themeClass` from `@mincho-js/preset-tailwind` to the button or an
ancestor and import `@mincho-js/preset-tailwind/styles.css` in the application
entry to load the preset's variables.

`text` selects color, font-size or alignment tokens; `font` selects font-family
or weight tokens. `"rounded"` uses the default radius, while `rounded: "lg"`
selects a named size. Property-level `base`, `_hover` and `_md` values use native
Mincho conditions.

Spacing decomposes into directional atoms: `p` refers to `px` and `py`, `px`
to `paddingLeft` and `paddingRight`, and `py` to `paddingTop` and `paddingBottom`.
The same applies to `m`. Applying `p: 4`, then `px: 3` and `pl: 1` changes only
the relevant sides. `cx()` uses the same atomic properties while keeping hover
and responsive conditions independent.

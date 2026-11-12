# @mincho-js/preset-tailwind

Tailwind CSS 4.3.5 default design tokens and compound styles, compiled with
Mincho. Original OKLCH colors, units, typography pairs and animation frames are
preserved. This is a style port; it does not accept Tailwind class strings.

```ts
// panel.css.ts
import { css, rules, cx, themeClass } from "@mincho-js/preset-tailwind";

export const panel = cx(themeClass, css({ container: true, px: 6 }));
export const label = css({ truncate: true });
export const button = rules({
  base: { px: 4, py: 2, rounded: "lg" },
  variants: {
    tone: {
      solid: { color: "white", bg: "sky-700" },
      soft: { color: "sky-900", bg: "sky-100" },
    },
  },
});
```

```tsx
import { panel, label, button } from "./panel.css";
import "@mincho-js/preset-tailwind/styles.css";
// Optional, global browser reset:
import "@mincho-js/preset-tailwind/preflight.css";

<main className={panel}>
  <p className={label}>A long description</p>
  <button className={button({ tone: "soft" })}>Create project</button>
</main>;
```

The root exposes the native `css`, `rules`, `cx`, and `preset` APIs bound to
compiled `vars`, plus `themeClass` and `contract`. Consumers define component
styles and recipes with the same Mincho APIs used for a local definition.
`styles.css` contains theme variables and animation keyframes. Container,
truncation and other compound styles are generated only when the consumer uses
them in `css()`, `rules()` or a configured JSX `css` prop. JavaScript imports
alone emit no CSS.

Configure the [Mincho and Vanilla Extract build plugins](https://mincho-js.github.io/mincho/docs/tailwind/#install-and-configure)
to author styles, including calls to the published preset APIs.

The `/config` entry exports the preset's extraction map for your build plugin:

```ts
import { minchoVitePlugin } from "@mincho-js/vite";
import { extractCalls } from "@mincho-js/preset-tailwind/config";

minchoVitePlugin({
  extractCalls,
  jsxCssProp: { importSource: "@mincho-js/preset-tailwind" },
});
```

This entry contains configuration data only, so Node can load it without
evaluating themes or the style compiler.

For inline React styles, configure `jsxCssProp.importSource` as
`"@mincho-js/preset-tailwind"` and register the preset's CSS type with
`@mincho-js/react`, following the setup above. Then write objects directly:

```tsx
import { themeClass } from "@mincho-js/preset-tailwind";
import "@mincho-js/preset-tailwind/styles.css";

<button
  className={themeClass}
  css={{
    bg: { base: "blue-500", _hover: "blue-700" },
    text: "white",
    font: "bold",
    py: 2,
    px: 3,
    rounded: true,
  }}
>
  Create project
</button>;
```

The `css` prop compiles to static classes and is removed before rendering.

To create a React component from a recipe, pass the preset definition to
`defineRules` from `@mincho-js/react` and use its `styled.span()` or
`styled.button()` builder inside `mincho$` or a `.css.ts` file. The
[React recipe guide](https://mincho-js.github.io/mincho/docs/tailwind#react-recipes)
shows how the adapter preserves preset tokens and typed variants.

To customize the tokens, create a theme and bind its values in a `.css.ts` file:

```ts
import { theme, defineRules } from "@mincho-js/css";
import { themeSpec } from "@mincho-js/tailwind";
import { tailwindTokens } from "@mincho-js/preset-tailwind/tokens";

export const [themeClass, vars] = theme({
  ...tailwindTokens,
  colors: { ...tailwindTokens.colors, brand: "rebeccapurple" },
});
const { css, rules, cx } = defineRules(themeSpec(vars));

export const card = cx(
  themeClass,
  css({
    color: "brand",
    p: 6,
    rounded: "xl",
    _md: { p: 8 },
  }),
);
```

`/tokens` contains plain token data. Its animation values reference scoped
keyframes provided by `/styles.css`; import that stylesheet when using the
default animations. Use `theme.extends(contract, tokens)` to reuse a compiled
contract's variable names. A custom palette can also be added to a fresh native
`theme()` contract, as above.

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

## Optional Preflight

Import `@mincho-js/preset-tailwind/preflight.css` explicitly to apply Tailwind's
global browser reset. It is a separate stylesheet in the
`mincho-tailwind-preflight` cascade layer. Unlayered application styles override
normal declarations in this layer; the original `[hidden]` rule remains important.
For applications using other cascade layers, declare their order deliberately.

The reset includes Tailwind's default font stacks. Upstream `--theme()` calls
are resolved at package build; no Tailwind-specific CSS functions remain. To
change reset fonts, set `font-family` (and feature/variation settings if needed)
on `html` and `code, kbd, samp, pre` in your application stylesheet. Changing a
local token theme does not change this global reset.

See [@mincho-js/tailwind](../tailwind/README.md) for mappings, numeric spacing,
responsive conditions, effect composition and limitations. Public entries are
the root, `/config`, `/tokens`, `/styles.css`, and `/preflight.css`.

Original styles and tokens are MIT licensed by Tailwind Labs. See `NOTICE`.

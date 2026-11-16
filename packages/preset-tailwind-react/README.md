# @mincho-js/preset-tailwind-react

Use Mincho's Tailwind preset directly in React JSX or create typed intrinsic
components with `styled`. The package shares the native preset's `css`, `rules`,
`cx`, `preset`, `themeClass`, `vars`, and `contract` exports.

Install the preset with the Mincho React framework. The native preset supplies
the theme stylesheet and optional Preflight. `@mincho-js/react` is a required peer:
compiled styled components import its shared runtime from the application.

```sh
npm install react react-dom @mincho-js/css @mincho-js/react @mincho-js/preset-tailwind-react @mincho-js/preset-tailwind @vanilla-extract/css
npm install -D @mincho-js/vite @vanilla-extract/vite-plugin @vitejs/plugin-react
```

Set the JSX import source in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@mincho-js/preset-tailwind-react"
  }
}
```

Use the same source in the compiler. The data-only `/config` entry registers the
native and React preset calls, including `rules.extends`, `rules.multiple`,
`styled(...)`, and `styled.button(...)`.

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { extractCalls } from "@mincho-js/preset-tailwind-react/config";

export default defineConfig({
  plugins: [
    minchoVitePlugin({
      extractCalls,
      jsxCssProp: { importSource: "@mincho-js/preset-tailwind-react" },
    }),
    vanillaExtractPlugin(),
    react({ jsxImportSource: "@mincho-js/preset-tailwind-react" }),
  ],
});
```

Import the theme CSS once and apply its class above styled elements:

```tsx
import { themeClass } from "@mincho-js/preset-tailwind-react";
import "@mincho-js/preset-tailwind/styles.css";

export function App() {
  return (
    <main className={themeClass}>
      <button
        css={[
          {
            bg: { base: "blue-500", _hover: "blue-700" },
            text: "white",
            font: "bold",
            py: 2,
            px: 3,
          },
          "rounded",
        ]}
      >
        Save
      </button>
    </main>
  );
}
```

The compiler extracts these styles into static CSS and removes the `css` prop.
The JSX types are scoped to this import source; no global module augmentation is
needed. The runtime keeps Mincho's guard against uncompiled `css` props.

`styled` accepts the same Tailwind tokens and variants as `rules`. Author calls in
a component module with the configuration above, or in a `.css.ts` module handled
by Vanilla Extract.

```tsx
import { styled } from "@mincho-js/preset-tailwind-react";

export const Badge = styled.span({
  base: { px: 2, py: 1, rounded: "full", font: "medium" },
  variants: {
    tone: {
      info: { bg: "sky-100", text: "sky-900" },
      success: { bg: "emerald-100", text: "emerald-900" },
    },
  },
  defaultVariants: { tone: "info" },
});

export function Status() {
  return <Badge tone="success">Saved</Badge>;
}
```

Both `styled.span(options)` and `styled("span", options)` create intrinsic React
components. Custom component functions are not accepted by this adapter.

For class composition, use the native `css`, `rules`, and `cx` exports. Padding
shortcuts remain atomic: `p` expands through `px` and `py` to the four physical
padding properties, so a later `px` overrides only left and right padding.

```ts
import { css, cx } from "@mincho-js/preset-tailwind-react";

const padded = css({ p: 4 });
export const compact = cx(padded, css({ px: 2 }));
```

See the [native preset](../preset-tailwind/README.md) for the token contract,
custom themes, fixed shortcuts, and optional Preflight stylesheet.

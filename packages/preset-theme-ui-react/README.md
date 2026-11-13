# @mincho-js/preset-theme-ui-react

Theme UI component variants compiled with Mincho's native React adapter. The
package provides the original `base`, `system`, and `dark` themes, typed
`css`/`rules`/`cx`/`styled` authoring, and component factories.

```tsx
import "@mincho-js/preset-theme-ui/styles.css";
import { system, systemClass } from "@mincho-js/preset-theme-ui-react";

const { Box, Heading, Button } = system.components({
  buttons: {
    primary: { color: "background", bg: "primary" },
    secondary: { variant: "buttons.primary", bg: "secondary" },
  },
});

export function Example() {
  return (
    <Box className={systemClass}>
      <Heading variant="display">A shared visual language</Heading>
      <Button variant="secondary" css={{ px: { base: 3, _sm: 4 } }}>
        Continue
      </Button>
    </Box>
  );
}
```

Configure the Vite compiler and scoped JSX runtime:

```ts
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { extractCalls } from "@mincho-js/preset-theme-ui-react/config";

export default {
  plugins: [
    minchoVitePlugin({
      extractCalls,
      jsxCssProp: { importSource: "@mincho-js/preset-theme-ui-react" },
    }),
    vanillaExtractPlugin(),
  ],
};
```

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@mincho-js/preset-theme-ui-react"
  }
}
```

Install `@mincho-js/react`, React, and React DOM alongside the preset. The core
React package remains a direct peer so compiled components resolve its small
runtime under strict package managers. Configuration imports are data only.

## Component variants

`system.components(groups)` merges properties into the corresponding original
variant. `base.components(groups)` and `dark.components(groups)` work the same
way with their own tokens. No component CSS is emitted until a factory is called
in a CSS file or a module handled by the configured compiler.

| Component   | Default element | Variant group | Default variant |
| ----------- | --------------- | ------------- | --------------- |
| `Box`       | `div`           | `variants`    | —               |
| `Flex`      | `div`           | `variants`    | —               |
| `Grid`      | `div`           | `grids`       | —               |
| `Text`      | `span`          | `text`        | `default`       |
| `Heading`   | `h2`            | `text`        | `heading`       |
| `Paragraph` | `p`             | `text`        | `paragraph`     |
| `Button`    | `button`        | `buttons`     | `primary`       |
| `Link`      | `a`             | `links`       | `styles.a`      |
| `Card`      | `div`           | `cards`       | `primary`       |
| `Container` | `div`           | `layout`      | `container`     |
| `Label`     | `label`         | `forms`       | `label`         |
| `Image`     | `img`           | `images`      | —               |
| `Divider`   | `hr`            | `variants`    | `styles.hr`     |

A component looks for a group-relative variant first, then a root path such as
`text.display` or `styles.h1`. A style's `variant` property inherits a root path;
later properties override inherited values. Missing and circular inheritance
paths fail during compilation. Native element props, refs, and polymorphic `as`
remain available, and `variant` is not forwarded to the DOM.

The factories preserve the original primitive defaults. `Grid` supplies grid
display and default gap; set columns with native styles. Interactive widgets,
ThemeProvider, `sx`, runtime theme functions, and Theme UI's responsive-array
authoring are outside this package. Use native conditions such as
`fontSize: { base: 3, _sm: 4 }`. Responsive arrays in the original preset data are
converted internally to its `sm`/`md`/`lg` conditions.

Component styles use the `mincho-theme-ui-base` and `mincho-theme-ui-variants`
cascade layers. Variants override primitive defaults, while ordinary unlayered
native `css` overrides both regardless of stylesheet order. Variant hover and
media rules stay in the variant layer: an
unlayered local base declaration also takes precedence over those rules for the
same property. Set local conditions explicitly when that distinction matters.
Existing selectors,
including nested code and table styles, remain scoped to the component class.
Identical styles are shared across components produced by a factory.

The root JSX `css` prop uses the system token contract. Apply `base` or `dark`
tokens through their corresponding component variants; applying their theme
class does not replace the system CSS variable contract. Color modes retain the
same system contract and use the exported `systemModeClasses`.

## Custom definitions

`createComponents` accepts a native definition and consumer-owned variant groups:

```tsx
import { defineRules } from "@mincho-js/css";
import { createComponents } from "@mincho-js/preset-theme-ui-react";

const definition = defineRules({
  properties: { color: { brand: "rebeccapurple" } },
});
const { Text } = createComponents(definition, {
  text: { accent: { color: "brand" } },
});

export const Brand = () => <Text variant="accent">Mincho</Text>;
```

This factory has no stock variants; it preserves the supplied definition's
tokens and conditions. The root `css`, `rules`, `cx`, and `styled` exports are
system aliases. Each bound preset also exposes these native authoring methods
and its live `preset` getter for definition composition.

The variant conventions and primitive defaults follow
[Theme UI components](https://theme-ui.com/components/variants). See `NOTICE` for
the upstream source revision.

# @mincho-js/css

The @mincho-js/css package provides framework-agnostic APIs for CSS-in-JS styling.

<p align="center">
  <img src="https://raw.githubusercontent.com/mincho-js/mincho/main/assets/logo.png" alt="logo" width="300" height="300">
  <br/>
  <a href="https://x.com/mincho_js" target="_blank">
    <img src="https://img.shields.io/twitter/follow/mincho_js?style=social" alt="Twitter Follow" />
  </a>
</p>

:seedling: Easy adoption from Vanilla Extract.

:syringe: Vanilla Extract with the power of a preprocessor — Features inspired by [Sass](https://sass-lang.com/), [Less](https://lesscss.org/), [Stylus](https://stylus-lang.com/), etc.

:cartwheeling: Syntax optimized for TypeScript — Carefully designed as if it were native to TypeScript.

:globe_with_meridians: Works with any front-end framework — or even without one.

:lock: Still type-safe styles for TypeScript.

---

## Install

This package has [vanilla extract](https://vanilla-extract.style/) as a peer dependency, so we install them together.  
You'll also need to set up [bundler integration](https://vanilla-extract.style/documentation/getting-started#bundler-integration).

```shell
npm install @mincho-js/css @vanilla-extract/css

# or
yarn add @mincho-js/css @vanilla-extract/css

# or
pnpm install @mincho-js/css @vanilla-extract/css
```

## Usage

Define styles in a file named `.css.ts`:

```typescript
// styles.css.ts
import { css } from "@mincho-js/css";

export const container = css({
  padding: 10,
});
```

`css()` returns a class name, which you can import and use in your app:

```typescript
// app.ts
import { container } from "./styles.css.ts";

document.write(`
  <section class="${container}">
    ...
  </section>
`);
```

## API

### css()

The `css()` function takes a style object and generates a unique class name for the given styles.

**Usage Example**

```typescript
// button.css.ts
import { css } from "@mincho-js/css";

export const buttonCss = css({
  backgroundColor: "blue",
  color: "white",
  padding: {
    Block: 10,
    Inline: 20
  },
  _hover: {
    backgroundColor: "darkblue"
  }
});


// button.tsx
import { buttonCss } from "./button.css";

export function MyButton() {
  return <button className={buttonCss}></button>;
}
```

### cssVariant()

The `cssVariant()` function is used to define multiple styles. It allows easy creation of components with multiple variants.

**Usage Example**

```typescript
// button.css.ts
import { cssVariant } from '@mincho-js/css';

export const buttonVariants = cssVariant({
  primary: {
    backgroundColor: "blue",
    color: "white"
  },
  secondary: {
    backgroundColor: "gray",
    color: "black",
    "%primary &":{
      color: "white"
    }
  },
  danger: {
    backgroundColor: "red",
    color: {
      base: "white",
      "@media (prefers-color-scheme: dark)": "black"
    }
  }
});

// button.tsx
import { buttonVariants } from "./button.css";

interface ButtonProps {
  state: "primary" | "secondary" | "danger";
}

export function MyButton({ state }: ButtonProps) {
  return <button className={buttonVariants[state]}></button>;
}
```

### rules()

The `rules()` function is used to define both static and dynamic styles for reusable blocks.

```typescript
// button.css.ts
import { rules } from '@mincho-js/css';

export const button = rules({
  padding: {
    Block: 10,
    Inline: 20
  },

  props: ["margin"],

  toggles: {
    rounded: { borderRadius: 999 }
  },

  variants: {
    color: {
      brand: { color: "#FFFFA0" },
      accent: { color: "#FFE4B5" }
    },
    size: {
      small: { padding: 12 },
      medium: { padding: 16 },
      large: { padding: 24 }
    }
  },

  compoundVariants: ({ color, size }) => [
    {
      condition: [color.brand, size.small],
      style: {
        fontSize: "16px"
      }
    }
  ]
});


// button.tsx
import { button } from "./button.css";

export function MyButton() {
  return (<button
    className={button(["rounded", { color: "brand", size: "small" }])}
    style={button.props({
      margin: "20px"
    })}
  ></button>);
}
```

### defineRules()

The `defineRules()` function creates a scoped authoring API and returns `css`, `cx`, and `preset` together. Use it when you want a typed styling surface for a shared package, preset, or design-system layer.

`conditions` lets you name condition aliases once in the config. Config keys are bare names, and style input uses the same names with an underscore prefix. An empty object means the base condition. A string is treated as a media query, with a leading `@media` stripped if present. Object form supports `"@layer"`, `"@supports"`, `"@media"`, `"@container"`, and `selector`.

`context` is a generic runtime authoring context for scoped `css` and `css.raw` callbacks. It is not a theme-specific API. Use it for any authoring data shape you want shared with styles.

Callbacks are top-level only: pass `css((theme) => ({ ... }))` or `css.raw((theme) => ({ ... }))` directly. Nested callbacks are not supported. Direct object, array, and string inputs still work. These callbacks are static authoring helpers, not render-time dynamic props or React context.

```typescript
import { defineRules, theme } from "@mincho-js/css";

const [themeClass, themeVars] = theme({
  color: {
    text: "black",
    accent: "rebeccapurple",
  },
  space: {
    card: "16px",
  },
});

const { css } = defineRules({
  context: themeVars,
  properties: {
    color: true,
    padding: true,
  },
});

export const card = css((theme) => ({
  color: theme.color.text,
  padding: theme.space.card,
}));

export const staticCard = css({
  color: "black",
});

export const appThemeClass = themeClass;
```

Local-only authoring context can be any value your callbacks understand. Serialized or exported usage requires serializer-compatible enumerable context, such as primitives, arrays, and plain objects.

```typescript
import { defineRules } from "@mincho-js/css";

const { css, cx, preset } = defineRules({
  conditions: {
    mobile: {},
    tablet: "screen and (min-width: 768px)",
    desktop: {
      "@media": "screen and (min-width: 1024px)",
      selector: "&[data-layout=wide]",
    },
  },
  properties: {
    color: true,
    fontSize: true,
    padding: true,
  },
});

export const card = css({
  color: {
    base: "black",
    _desktop: "white",
  },
  padding: 12,
  _tablet: {
    fontSize: 16,
  },
  fontSize: {
    _desktop: 20,
  },
});

export const cardClassName = cx(card, "external");
export const cardPreset = preset;
```

#### defineRules.propertyValues()

`defineRules.propertyValues()` helps share one `properties` value across several CSS property names. In plain terms, `properties: { [key]: value }` can be grouped as `{ source: value, properties: [key1, key2] }`.

`source` is passed as-is and is not recursively flattened. The helper assigns the same `source` value to every property listed in `properties`. Choose each target CSS property yourself, because the helper doesn't infer CSS properties from the source name.

A leaf-array source accepts the listed values directly:

```typescript
import { defineRules, theme } from "@mincho-js/css";

const [themeClass, themeVars] = theme({
  colors: {
    text: {
      default: "#111111",
      muted: "#666666",
    },
  },
});

const { css } = defineRules({
  properties: defineRules.propertyValues([
    {
      source: [themeVars.colors.text.default, themeVars.colors.text.muted],
      properties: ["color", "backgroundColor"],
    },
  ]),
});

export const quietText = css({
  color: themeVars.colors.text.muted,
});

export const appThemeClass = themeClass;
```

An object-map source keeps the existing key-based value lookup:

```typescript
const { css } = defineRules({
  properties: defineRules.propertyValues([
    {
      source: { muted: themeVars.colors.text.muted },
      properties: ["color"],
    },
  ]),
});

export const quietText = css({
  color: "muted",
});
```

For spacing leaves plus a custom variable, spread the spacing leaves into the source array:

```typescript
import { createVar, defineRules, theme } from "@mincho-js/css";

const [, themeVars] = theme({
  space: ["0px", "4px", "8px"],
});

const customSpacingVariable = createVar();

const { css } = defineRules({
  properties: defineRules.propertyValues([
    {
      source: [...themeVars.space, customSpacingVariable],
      properties: ["gap", "padding"],
    },
  ]),
});

export const padded = css({
  gap: customSpacingVariable,
  padding: themeVars.space[1],
});
```

`source: [themeVars.space, customSpacingVariable]` preserves the nested array and does not flatten. Use `source: [...themeVars.space, customSpacingVariable]` when you want each spacing leaf plus the custom variable.

The `preset` export is a V5 graph preset artifact. Pass it to another `defineRules({ presets })` call to compose and reuse class names and the graph metadata needed by scoped `cx`.

`defineRules().cx` is scoped and metadata-aware. It flattens inputs like the root `cx`, then resolves active rules by selecting the winning class according to V5 last-parent/local-wins semantics. The root `cx` export remains global and clsx-compatible; it does not read preset metadata.

Unknown or external class tokens are preserved after root `cx` has flattened the inputs. They are not dropped, deduped, sorted, or moved relative to other unknown tokens.

Known conflicts merge only when the normalized condition tuple and expanded write property are exactly equal. The condition tuple is `layer`, `supports`, `media`, `container`, and `selector`. For example, a `color` write under `_desktop` only conflicts with another `color` write under that exact tuple. There is no media range subsumption, selector equivalence, or cross-layer precedence inference.

### V5 Package, Runtime, and Stylesheet Contract

The V5 package contract establishes a strict, high-performance separation between build-time style authoring, runtime class name resolution, and static asset delivery.

#### 1. V5 Graph Schema and Resolution

- **Graph Nodes & Immutable Parents**: Presets are structured as content-addressed V5 node graphs where parent-child relationships are immutable. Each node contains a unique `nodeId`, `contentHash`, `parents` array (referenced by ID), and its own local atoms (ordered own atoms).
- **Diamond Dedupe & Traversal**: The resolution engine performs a root-first deterministic traversal (parent-first DFS) with exact diamond node deduplication.
- **Diagnostics & Rejection**: Strict validation enforces origin/content revision errors, class/AtomId conflict errors, and cycle errors (via tri-color DFS cycle diagnostics).
- **Last-Parent / Local-Wins equivalent AtomId Selection**: Conflict resolution resolves compatible classes to their selected `AtomId` using last-parent-wins or local-wins order. There is absolutely no backward compatibility, migration utilities, or fallback parsing for legacy V3/V4/maps formats.

#### 2. Package Authoring & Runtime Split

- **App Imports (`.`)**: Application components and consumer entry points import runtime-safe, graph-free compiled helpers directly from the package root `.` (e.g., `import { Button } from "my-pkg"`).
- **Authoring Imports (`./preset`)**: Downstream library authoring in `.css.ts` files imports authoring helpers, types, and preset nodes from the subpath `./preset` (e.g., `import { preset } from "my-pkg/preset"`).
- **Explicit Stylesheet Escape Hatch (`./style.css`)**: Published packages provide sidecar CSS containing only locally owned rules. Consumers or bundlers can import `./style.css` as a full escape hatch, while bundler entry roots automatically resolve and inject sidecar stylesheets relative to entry chunks.

#### 3. Compact Dynamic & Static cx Behavior

- **Dynamic Scoped cx**: Dynamic `cx` runtime outputs are optimized to exclude the full V5 graph. They carry only a compact `classWrites` lookup mapping valid classes to internal write IDs, plus optional marker `segments`. Segments are optimization prefixes: payloads must match their recorded write IDs or are handled as ordinary class tokens; duplicate sequences are safe and the last write wins.
- **Static cx**: When classes can be statically resolved at build time, `cx` emits static class literals with zero runtime table footprint or hydration overhead.

#### 4. Known Caveats & Limitations

- **Unused Rules**: Built package stylesheets contain all defined component rules; pruning unused component declarations is not performed at the asset level.
- **Native Node CSS Loading**: Native Node.js runtimes cannot load `.css.ts` or CSS-importing root exports without a bundler integration.
- **No Per-Export Hydration**: Scoped style hydration is global to the active environment; per-export or partial-hydration models are not implemented.
- **No Semantic Folding**: CSS folding across selectors or layers is not performed; parent declarations are never duplicated or compiled into child stylesheets.
- **No External Overlay / Manifest**: Style resolution and loading do not depend on external manifest JSON, import maps, or overlay registries.

## Features

Some features are already implemented in Vanilla Extract, but we're assuming a first-time reader.

Instead, we've attached an emoji to make it easier to distinguish.

- Vanilla Extract: :cupcake:
- Mincho: :icecream:

### 1. CSS Module :cupcake:

We need to have a hash value to solve the problem of overlapping class names.  
[Vanilla Extract's `style()`](https://vanilla-extract.style/documentation/api/style/) is already doing a good job.

**Code:**

```typescript
const myCss = css({
  color: "blue",
  backgroundColor: "#EEEEEE",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  color: blue;
  background-color: #eeeeee;
}
```

[Identifiers](https://vanilla-extract.style/documentation/integrations/vite/#identifiers) can be changed with settings.

### 2. Unitless Properties :cupcake:

[Unitless Properties](https://vanilla-extract.style/documentation/styling#unitless-properties) is convenient because it reduces unnecessary string representations.

**Code:**

```typescript
export const myCss = css({
  // cast to pixels
  padding: 10,
  marginTop: 25,

  // unitless properties
  flexGrow: 1,
  opacity: 0.5,
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  padding: 10px;
  margin-top: 25px;

  flex-grow: 1;
  opacity: 0.5;
}
```

### 3. Vendor Prefixes :cupcake:

[Vendor Prefixes](https://vanilla-extract.style/documentation/styling#vendor-prefixes) is convenient because it reduces unnecessary string representations.

**Code:**

```typescript
export const myCss = css({
  WebkitTapHighlightColor: "rgba(0, 0, 0, 0)",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
}
```

### 4. Fallback Styles :cupcake:

[Fallback Styles](https://vanilla-extract.style/documentation/styling#fallback-styles) is convenient because it reduces unnecessary properties.

**Code:**

```typescript
export const myCss = css({
  // In Firefox and IE the "overflow: overlay" will be
  // ignored and the "overflow: auto" will be applied
  overflow: ["auto", "overlay"],
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  overflow: auto;
  overflow: overlay;
}
```

### 5. Merge Values :icecream:

Inspired by the [Less's Merge properties](https://lesscss.org/features/#merge-feature), this feature allows you to composition long split values.

- If they end in `$`, they are joined by a comma
- if they end in `_`, they are joined by a whitespace

**Code:**

```typescript
export const myCss = css({
  boxShadow$: ["inset 0 0 10px #555", "0 0 20px black"],
  transform_: ["scale(2)", "rotate(15deg)"],
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  box-shadow:
    inset 0 0 10px #555,
    0 0 20px black;
  transform: scale(2) rotate(15deg);
}
```

For use with Fallback Styles, use a double array.  
It's automatically composited.

**Code:**

```typescript
export const myCss = css({
  transform_: [
    // Apply to all
    "scale(2)",

    //  Fallback style
    ["rotate(28.64deg)", "rotate(0.5rad)"],
  ],
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  transform: scale(2) rotate(28.64deg);
  transform: scale(2) rotate(0.5rad);
}
```

### 6. Simply Important :icecream:

Inspired by the [Tailwind's Important modifier](https://tailwindcss.com/docs/configuration#important-modifier), If `!` is at the end of the value, treat it as `!important`.

**Code:**

```typescript
export const myCss = css({
  color: "red!",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  color: red !important;
}
```

### 7. CSS Variables :icecream:

Unlike [Vanilla Extract's CSS Variables](https://vanilla-extract.style/documentation/styling#css-variables), it is supported at the top level.  
Inspired by the [SASS Variable](https://sass-lang.com/documentation/variables/), You can use `$` like you would a variable.

The conversion to prefix and `kebab-case` happens automatically.

**Code:**

```typescript
export const myCss = css({
  $myCssVariable: "purple",
  color: "$myCssVariable",
  backgroundColor: "$myOtherVariable(red)",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  --my-css-variable: purple;
  color: var(--my-css-variable);
  background-color: var(--my-other-variable, red);
}
```

### 8. Simple Pseudo Selectors :icecream:

[Simple Pseudo Selectors](https://vanilla-extract.style/documentation/styling#simple-pseudo-selectors) is convenient because these are the elements you typically use with ["&"](https://sass-lang.com/documentation/style-rules/parent-selector/), so keep it.

Inspired by the [Panda CSS's Conditional Styles](https://panda-css.com/), `_` is used as `:`.  
However, no other classes or attributes are added, it's a simple conversion.  
`camelCase` also convert to `kebab-case`.

**Code:**

```typescript
export const myCss = css({
  _hover: {
    color: "pink",
  },
  _firstOfType: {
    color: "blue",
  },
  __before: {
    content: "",
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH]:hover {
  color: pink;
}

.[FILE_NAME]_myCSS__[HASH]:first-of-type {
  color: blue;
}

.[FILE_NAME]_myCSS__[HASH]::before {
  content: "";
}
```

### 9. Simple Attribute Selectors :icecream:

Allow toplevel [`attribute selector`](https://developer.mozilla.org/en-US/docs/Web/CSS/Attribute_selectors) to prevent deep nesting.
It would be nice to be able to autocomplete [HTML attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes).

If the start is `[` without `&` treat it as `attribute selectors`.
It is a continuation of Simple Pseudo Selectors.

**Code:**

```typescript
export const myCss = css({
  "[disabled]": {
    color: "red"
  },
  `[href^="https://"][href$=".org"]`: {
    color: "blue"
  }
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH][disabled] {
  color: red;
}

.[FILE_NAME]_myCSS__[HASH][href^="https://"][href$=".org"] {
  color: blue;
}
```

### 10. Complex Selectors :cupcake: / :icecream:

Unlike [Vanilla Extract's Complex Selectors](https://vanilla-extract.style/documentation/styling#complex-selectors), it is supported at the top level.  
I want to reduce nesting as much as possible.

Exception values for all properties are treated as complex selectors.

**Code:**

```typescript
export const myCss = css({
  "&:hover:not(:active)": {
    border: "2px solid aquamarine",
  },
  "nav li > &": {
    textDecoration: "underline",
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH]:hover:not(:active) {
  border: 2px solid aquamarine;
}

nav li > .[FILE_NAME]_myCSS__[HASH] {
  text-decoration: underline;
}
```

> [!WARNING]
> Constraints like circular reference still apply.

#### Complex Selectors - Reference constraints

That it inherits all of Vanilla Extract's constraints.

```typescript
const invalid = css({
  // ❌ ERROR: Targetting `a[href]`
  "& a[href]": {...},

  // ❌ ERROR: Targetting `.otherClass`
  "& ~ div > .otherClass": {...}
});

// Also Invalid example:
export const child = css({});
export const parent = css({
  // ❌ ERROR: Targetting `child` from `parent`
  [`& ${child}`]: {...}
});

// Valid example:
export const parent = css({});
export const child = css({
  [`${parent} &`]: {...}
});
```

#### Complex Selectors - Circular reference

As above, [Circular reference](https://vanilla-extract.style/documentation/styling/#circular-selectors) is the same.

```typescript
export const child = css({
  background: "blue",
  get selectors() {
    return {
      [`${parent} &`]: {
        color: "red",
      },
    };
  },
});

export const parent = css({
  background: "yellow",
  selectors: {
    [`&:has(${child})`]: {
      padding: 10,
    },
  },
});
```

### 11. At-Rules :cupcake: / :icecream:

Allows nesting, like [Vanilla Extract's Media Queries](https://vanilla-extract.style/documentation/styling#media-queries), and also allows top-levels.

**Code:**

```typescript
export const myCss = css({
  // Nested
  "@media": {
    "screen and (min-width: 768px)": {
      padding: 10,
    },
    "(prefers-reduced-motion)": {
      transitionProperty: "color",
    },
  },

  // Top level
  "@supports (display: grid)": {
    display: "grid",
  },
});
```

**Compiled:**

```css
@media screen and (min-width: 768px) {
  .[FILE_NAME]_myCSS__[HASH] {
    padding: 10px;
  }
}

@media (prefers-reduced-motion) {
  .[FILE_NAME]_myCSS__[HASH] {
    transition-property: color;
  }
}

@supports (display: grid) {
  .[FILE_NAME]_myCSS__[HASH] {
    display: grid;
  }
}
```

### 12. Anonymous At-Rules :icecream:

Inspired by the [Griffel's Keyframes](https://griffel.js.org/react/api/make-styles#keyframes-animations), Makes [`@keyframes`](https://developer.mozilla.org/en-US/docs/Web/CSS/@keyframes) or [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) writable inline.

`fontFamily$` is used as special case of the `Merge Values` rule.

**Code:**

```typescript
export const myCss = css({
  // Keyframes
  animationName: {
    "0%": { transform: "rotate(0deg)" },
    "100%": { transform: "rotate(360deg)" },
  },
  animationDuration: "3s",

  // Fontface
  fontFamily: {
    src: "local('Comic Sans MS')",
  },
  // Fontface with multiple
  fontFamily$: [{ src: "local('Noto Sans')" }, { src: "local('Gentium')" }],
});
```

**Compiled:**

```css
@keyframes [FILE_NAME]_myCSSKeyframes__[HASH] {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@font-face {
  src: local("Comic Sans MS");
  font-family: "[FILE_NAME]_myCSSFontFace1__[HASH]";
}
@font-face {
  src: local("Noto Sans");
  font-family: "[FILE_NAME]_myCSSFontFace2__[HASH]";
}
@font-face {
  src: local("Gentium");
  font-family: "[FILE_NAME]_myCSSFontFace3__[HASH]";
}

.[FILE_NAME]_myCSS__[HASH] {
  animation-name: [FILE_NAME]_myCSSKeyframes__[HASH];
  animation-duration: 3s;

  font-family: [FILE_NAME]_myCSSFontFace1__[HASH];
  font-family:
    [FILE_NAME]_myCSSFontFace2__[HASH], [FILE_NAME]_myCSSFontFace3__[HASH];
}
```

### 13. Nested Properties :icecream:

Inspired by the [SCSS's nested properties](https://sass-lang.com/documentation/style-rules/declarations/#nesting), this feature allows nesting for property names.

Reduce redundancy and make your context stand out.

Uppercase it to distinguish it from `Property based condition`.
[`Vendor Prefixes`](./000-css-literals.md#5-vendor-prefixes) exists only in Top level, while `Nested Properties` exists only in nesting, so you can tell them apart.

**Code:**

```typescript
export const myCss = css({
  transition: {
    Property: "font-size",
    Duration: "4s",
    Delay: "2s",
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  transition-property: font-size;
  transition-duration: 4s;
  transition-delay: 2s;
}
```

### 14. Property based condition :icecream:

Inspired by the [Panda CSS](https://panda-css.com/docs/concepts/conditional-styles#property-based-condition), You can apply properties based on selectors or at-rules.

The default properties refer to `base`.

```typescript
export const myCss = css({
  color: {
    base: "red",
    _hover: "green",
    "[disabled]": "blue",
    "nav li > &": "black",
    "@media (prefers-color-scheme: dark)": "white",
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  color: red;
}

.[FILE_NAME]_myCSS__[HASH]:hover {
  color: green;
}

.[FILE_NAME]_myCSS__[HASH][disabled] {
  color: blue;
}

nav li > .[FILE_NAME]_myCSS__[HASH] {
  color: black;
}

@media (prefers-color-scheme: dark) {
  .[FILE_NAME]_myCSS__[HASH] {
    color: red;
  }
}
```

### 15. Nested Selectors :icecream:

Inspired by the [SCSS's nested selectors](https://sass-lang.com/documentation/style-rules/parent-selector/), this feature allows nesting for selectors.

It works with [Simple Pseudo Selectors](./000-css-literals.md#10-simple-pseudo-selectors) and [Complex Selectors](./000-css-literals.md#11-complex-selectors).

```typescript
export const myCss = css({
  "nav li > &": {
    color: "red",
    _hover: {
      color: "green",
    },
    "&:hover:not(:active)": {
      color: "blue",
    },
    ":root[dir=rtl] &": {
      color: "black",
    },
  },
});
```

**Compiled:**

```css
nav li > .[FILE_NAME]_myCSS__[HASH] {
  color: red;
}

nav li > .[FILE_NAME]_myCSS__[HASH]:hover {
  color: green;
}

nav li > .[FILE_NAME]_myCSS__[HASH][disabled]:hover:not(:active) {
  color: blue;
}

:root[dir="rtl"] nav li > .[FILE_NAME]_myCSS__[HASH] {
  color: black;
}
```

### 16. Nested At-Rules :icecream:

Like `Nested Selectors`, but they are hoisted and combined into a `AND` rule.

Depending on the `Ar-Rules` keyword, the combining syntax is slightly different.  
(Unlike [`@media`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media), [`@supports`](https://developer.mozilla.org/en-US/docs/Web/CSS/@supports), and [`@container`](https://developer.mozilla.org/en-US/docs/Web/CSS/@container), [`@layer`](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer) is displayed like `parent.child`.)

**Code:**

```typescript
export const myCss = css({
  "nav li > &": {
    color: "red",

    "@media (prefers-color-scheme: dark)": {
      "@media": {
        "(prefers-reduced-motion)": {
          color: "green",
        },
        "(min-width: 900px)": {
          color: "blue",
        },
      },
    },

    "@layer framework": {
      "@layer": {
        layout: {
          color: "black",
        },
        utilities: {
          color: "white",
        },
      },
    },
  },
});
```

**Compiled:**

```css
nav li > .[FILE_NAME]_myCSS__[HASH] {
  color: red;
}

@media (prefers-color-scheme: dark) and (prefers-reduced-motion) {
  nav li > .[FILE_NAME]_myCSS__[HASH] {
    color: green;
  }
}

@media (prefers-color-scheme: dark) and (min-width: 900px) {
  nav li > .[FILE_NAME]_myCSS__[HASH] {
    color: blue;
  }
}

@layer framework.layout {
  nav li > .[FILE_NAME]_myCSS__[HASH] {
    color: blue;
  }
}

@layer framework.utilities {
  nav li > .[FILE_NAME]_myCSS__[HASH] {
    color: blue;
  }
}
```

It can be used with `Property based condition`.

**Code:**

```typescript
export const myCss = css({
  "nav li > &": {
    color: {
      base: "red",
      "@media (prefers-color-scheme: dark)": {
        "@media (prefers-reduced-motion)": "green",
        "@media (min-width: 900px)": "blue",
      },
      "@layer framework": {
        "@layer": {
          layout: "black",
          utilities: "white",
        },
      },
    },
  },
});
```

### 17. Property Reference :icecream:

Inspired by the [Stylus's property lookup](https://stylus-lang.com/docs/variables.html#property-lookup), this feature can be used to refer to a property value.

**Code:**

```typescript
export const myCss = css({
  width: "50px",
  height: "@width",
  margin: "calc(@width / 2)",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  width: 50px
  height: 50px;
  margin: calc(50px / 2);
}
```

When used alone, like `"@flexGrow"`, you can use the literal value it refers to.

**Code:**

```typescript
export const myCss = css({
  flexGrow: 1,
  flexShrink: "@flexGrow",
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  flex-grow: 1;
  flex-shrink: 1;
}
```

### 18. Variants Reference :icecream:

Inspired by the [JSS plugin nested](https://cssinjs.org/jss-plugin-nested?v=v10.10.0#use-rulename-to-reference-a-local-rule-within-the-same-style-sheet), this feature can be reference a local rule.

Use the `%` symbol.

**Code:**

```typescript
export const myCss = cssVariant({
  primary: {
    color: "red",
    ":has(%secondary)": {
      color: "blue",
    },
  },
  secondary: {
    color: "black",
    "%primary &": {
      color: "white",
    },
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_myCSS_primary__[HASH] {
  color: red;
}

.[FILE_NAME]_myCSS_primary__[HASH]:has(.[FILE_NAME]_myCSS_secondary__[HASH]) {
  color: blue;
}

.[FILE_NAME]_myCSS_secondary__[HASH] {
  color: black;
}

.[FILE_NAME]_myCSS_primary__[HASH] .[FILE_NAME]_myCSS_secondary__[HASH] {
  color: white;
}
```

### 19. CSS Composition :cupcake:

[Vanilla Extract's composition](https://vanilla-extract.style/documentation/style-composition/) is well enough made, so keep it.

**Code:**

```typescript
const base = css({ padding: 12 });
const primary = css([base, { background: "blue" }]);
const secondary = css([base, { background: "aqua" }]);
```

**Compiled:**

```css
.[FILE_NAME]_base__[HASH] {
  padding: 12px;
}

.[FILE_NAME]_primary__[HASH] {
  background: blue;
}

.[FILE_NAME]_secondary__[HASH] {
  background: aqua;
}
```

### 20. CSS Rules :cupcake:

Define it as an object style, similar to css.

**Code:**

```typescript
const myRule = rules({
  color: "blue",
  backgroundColor: "red",
});
```

**Compiled:**

```css
.[FILE_NAME]_myRule__[HASH] {
  color: blue;
  background-color: red;
}
```

However, it is returned as a function, so you need to run it to use it.

```typescript
function MyComponent() {
  return <div className={myRule()}></div>;
}
```

### 21. Rules Props :icecream:

Provides dynamic styles using CSS Variables.

**Code:**

```typescript
const myRule = rules({
  props: ["color", "background", { size: { targets: ["padding", "margin"] } }],
});
```

**Compiled:**

```css
.[FILE_NAME]_myRule__[HASH] {
  color: var(--[FILE_NAME]_myRule_color__[HASH]);
  background: var(--[FILE_NAME]_myRule_background__[HASH]);
  padding: var(--[FILE_NAME]_myRule_size__[HASH]);
  margin: var(--[FILE_NAME]_myRule_size__[HASH]);
}
```

You can also set a default value.

**Code:**

```typescript
const myRule = rules({
  props: [
    "color",
    {
      background: { base: "red", targets: ["background"] },
      size: { base: "3px", targets: ["padding", "margin"] },
    },
  ],
});
```

**Compiled:**

```css
.[FILE_NAME]_myRule__[HASH] {
  color: var(--[FILE_NAME]_myRule_color__[HASH]);
  background: var(--[FILE_NAME]_myRule_background__[HASH], red);
  padding: var(--[FILE_NAME]_myRule_size__[HASH], 3px);
  margin: var(--[FILE_NAME]_myRule_size__[HASH], 3px);
}
```

You can think of use cases as those that are statically extracted and those that are dynamically assigned.

**Static Usage:**

```typescript
const myCSS = css([
  myRule.props({ color: "red", background: "blue", size: "5px" }),
  { borderRadius: 999 },
]);
```

**Compiled:**

```css
.[FILE_NAME]_myCSS__[HASH] {
  --myCSS_color__[HASH]: red;
  --myCSS_background__[HASH]: blue;
  --myCSS_size__[HASH]: 5px;
  border-radius: 999px;
}
```

If dynamic case, it is assigned as an inline style.

**Dynamic Usage**

```typescript
import { myRule } from "sample.css";

function Sample({ color }) {
  return <div style={myRule.props({ color })}>contents...</div>;
}
```

### 22. Rules Variants :cupcake:

[Stitches's `variants`](https://stitches.dev/docs/variants#adding-variants) is well enough made.

**Code:**

```typescript
const button = rules({
  color: "black",
  backgroundColor: "white",
  borderRadius: 6,

  variants: {
    color: {
      brand: {
        color: "#FFFFA0",
        backgroundColor: "blueviolet",
      },
      accent: {
        color: "#FFE4B5",
        backgroundColor: "slateblue",
      },
    },
    size: {
      small: { padding: 12 },
      medium: { padding: 16 },
      large: { padding: 24 },
    },
    rounded: {
      true: { borderRadius: 999 },
    },
  },
});
```

**Compiled:**

```css
.[FILE_NAME]_button__[HASH] {
  color: black;
  background-color: white;
  border-radius: 6px;
}

.[FILE_NAME]_button_color_brand__[HASH] {
  color: #ffffa0;
  background-color: blueviolet;
}
.[FILE_NAME]_button_color_accent__[HASH] {
  color: #ffe4b5;
  background-color: slateblue;
}

.[FILE_NAME]_button_size_small__[HASH] {
  padding: 12px;
}
.[FILE_NAME]_button_size_medium__[HASH] {
  padding: 16px;
}
.[FILE_NAME]_button_size_large__[HASH] {
  padding: 24px;
}
```

You can use it as if you were using `css`.

**Usage:**

```typescript
button({
  color: "accent",
  size: "large",
  rounded: true,
});
```

### 23. Toggle Variants :cupcake: / :icecream:

[Stitches's `boolean variants`](https://stitches.dev/docs/variants#boolean-variants) are a special case, but the syntax for defining them is awkward.

Therefore, we introduce a specialized syntax.

**Code Before:**

```typescript
const button = rules({
  // base styles

  variants: {
    // common variants
    rounded: {
      true: { borderRadius: 999 },
    },
  },
});
```

**Code After:**

```typescript
const button = rules({
  // base styles

  toggles: {
    rounded: { borderRadius: 999 }
  }

  variants: {
    // common variants
  }
});
```

### 24. Compound Variants :icecream:

[Stitches's `Compound Variants`](https://stitches.dev/docs/variants#compound-variants) is an effective way to set up additional css by leveraging the combination of variations you have already set up.

However, the method of writing the conditions seems quite inconvenient when conditions are complicated.  
So we want to improve the UX in this area.

**Code Before:**

```typescript
const button = rules({
  // base styles

  variants: {
    color: {
      brand: { color: "#FFFFA0" },
      accent: { color: "#FFE4B5" },
    },
    size: {
      small: { padding: 12 },
      medium: { padding: 16 },
      large: { padding: 24 },
    },
  },
  compoundVariants: [
    {
      variants: {
        color: "brand",
        size: "small",
      },
      style: {
        fontSize: "16px",
      },
    },
  ],
});
```

It doesn't seem uncomfortable when the conditions are not as demanding as they are now.
But if the conditions become complicated, it will be inconvenient to fill out.

**Code After:**

```typescript
const button = rules({
  // base styles

  variants: {
    color: {
      brand: { color: "#FFFFA0" },
      accent: { color: "#FFE4B5" },
    },
    size: {
      small: { padding: 12 },
      medium: { padding: 16 },
      large: { padding: 24 },
    },
  },
  compoundVariants: ({ color, size }) => [
    {
      condition: [color.brand, size.small],
      style: {
        fontSize: "16px",
      },
    },
  ],
});
```

**Compiled:**

```css
.[FILE_NAME]_button_compound_0__[HASH] {
  font-size: 16px;
}
.[FILE_NAME]_button_compound_1__[HASH] {
  font-size: 24px;
  font-weight: bold;
}
```

### 25. Default Variants :cupcake:

The way of [Stitches's `Default Variants`](https://stitches.dev/docs/variants#default-variants) is already good to use, so we keep this method in ours.

**Code:**

```typescript
const button = rules({
  // base styles

  variants: {
    color: {
      brand: {
        color: "#FFFFA0",
        backgroundColor: "blueviolet",
      },
      accent: {
        color: "#FFE4B5",
        backgroundColor: "slateblue",
      },
    },
  },
  defaultVariants: {
    color: "brand",
  },
});
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](/CONTRIBUTING.md) for more details.

## License

This project is licensed under the [MIT License](/LICENSE).

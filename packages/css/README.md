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

const cardRules = defineRules({
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

const { css, cx } = cardRules;

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
// Read the snapshot after registering the styles to share.
export const cardPreset = cardRules.preset;
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

#### Preset snapshots and registration order

`rules.preset` is an immutable V5 graph snapshot. Read it after generating the styles that downstream authors should reuse. Reading it twice without new styles returns the same snapshot. Adding a new local Atom causes the next read to produce a new snapshot; a previously captured value stays unchanged.

```typescript
// shared.css.ts
const A = defineRules({ properties: { color: true, display: true } });
export const sharedRed = A.css({ color: "red" });
export const sharedPreset = A.preset;

const B = defineRules({
  properties: { color: true, display: true },
  presets: sharedPreset,
});
export const childRed = B.css({ color: "red" }); // Reuses A's red Atom.

A.css({ display: "flex" }); // Creates a newer A snapshot on the next read.
// B continues to use sharedPreset; this addition does not update B.
```

Destructuring `const { preset } = rules` also captures a snapshot at that moment. It is not a live connection. To consume later additions, construct a new child from the newer snapshot. Combining two revisions of the same origin fails explicitly; publish and install matching JS, preset and stylesheet outputs together rather than mixing snapshots.

#### Graph order and existing classes

Parents are visited before the local node, in the order of each `parents` array. Shared nodes are applied once, on their first visit. Reordering the storage array `artifact.nodes` does not change the result. Nested `presets` arrays preserve their left-to-right order; cyclic arrays and cyclic node references are rejected.

For an equivalent Atom, later visited nodes select the class used for subsequent authoring. A local equivalent Atom therefore wins after its parents. With independent B and C branches, `[B, C]` selects C, while `[C, B]` selects B. Repeating B in `[B, C, B]` does not apply it again: C still wins. This is class selection for equivalent Atoms, not an analysis of the browser cascade.

Other classes representing that same Atom remain registered for scoped `cx`, and their originating stylesheets remain necessary. A child does not rename or invalidate a parent's existing classes. Missing parents, conflicting revisions of one origin, inconsistent class/Atom mappings, and altered hashes are rejected; hashes are validated against content, not trusted as labels.

#### Compact dynamic and static cx

- **Dynamic Scoped cx**: Dynamic `cx` runtime outputs are optimized to exclude the full V5 graph. They carry only a compact `classWrites` lookup mapping valid classes to internal write IDs, plus optional marker `segments`. Segments are optimization prefixes: payloads must match their recorded write IDs or are handled as ordinary class tokens; duplicate sequences are safe and the last write wins.
- **Static cx**: When classes can be statically resolved at build time, `cx` emits static class literals with zero runtime table footprint or hydration overhead.

#### Local authoring and V5 serialization

Local executable authoring and published preset serialization are different contracts. Supported local property/shortcut functions and top-level `css(context => ...)` callbacks can compute styles. That does not make functions serializable. Registry extraction rejects function values encountered in `conditions`, `properties` or `shortcuts`, with a config path and file/registration diagnostic. Conditions themselves still have to satisfy the documented condition API; arbitrary functions are not valid condition definitions.

Local callbacks may use a context value they understand. Serialized registry context must contain supported enumerable primitive values, arrays and plain records. Functions, symbols, bigint, cyclic context and non-plain objects are rejected. A V5 preset stores resulting Atoms and ancestry, not executable callbacks or a live context. Only V5 is supported; V3/V4 and legacy maps are rejected rather than migrated implicitly. Rebuild old producers with the current format.

#### CSS ownership and package delivery

A common ancestor and two independently generated classes are different forms of sharing. Generate genuinely shared styles in A **before** exporting A's preset, then let B and C reuse those Atoms. Generate only styles that are actually needed; pre-generating every allowed utility value increases CSS.

If B and C independently generate `.b_red` and `.c_red`, composing their presets does not remove either stylesheet rule: existing B/C consumers still refer to those classes. Final application CSS minification may merge compatible declarations while retaining both selectors. Its effect depends on the actual bundler, rule order and output file; there is no cross-file or cross-chunk deduplication guarantee. Preserve conditions, layers, specificity, `!important`, loading order, source maps and native content hashes when evaluating any optimization.

The repository's component-package contract separates application exports (`.`), authoring presets (`./preset`) and an explicit stylesheet (`./style.css`). A package author must configure those exports and keep stylesheet imports in `sideEffects`; these subpaths are not automatically created by calling `defineRules`. Root application exports should use compiled runtime helpers rather than importing the authoring graph. The compact dynamic `cx` payload contains class-write metadata, while statically resolved calls can become class literals.

Load the CSS owned by every referenced producer. The root entry's CSS wiring and an explicit `./style.css` import are package-specific delivery contracts: verify them under production tree shaking, lazy loading and multiple entries. A whole-package stylesheet may retain rules for unused components; JS export tree shaking alone does not prove CSS removal. Native Node cannot execute CSS imports without an appropriate loader or bundler.

See [preset graph performance](../../docs/preset-graph-performance.md) for reproducible cost measurements and their limits.

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

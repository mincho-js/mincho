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
  padding: 10
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
import { css } from "@mincho-js/css";

const buttonStyle = css({
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
```

### cssVariant()

The `cssVariant()` function is used to define conditional styles. It allows easy creation of components with multiple variants.

**Usage Example**

```typescript
import { cssVariant } from '@mincho-js/css';

const buttonVariants = cssVariant({
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
```

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
  backgroundColor: "#EEEEEE"
});
```

**Compiled:**
```css
.[FILE_NAME]_myCSS__[HASH] {
  color: blue;
  background-color: #EEEEEE;
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
  opacity: 0.5
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
  WebkitTapHighlightColor: "rgba(0, 0, 0, 0)"
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
  overflow: ["auto", "overlay"]
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
  transform_: ["scale(2)", "rotate(15deg)"]
});
```

**Compiled:**
```css
.[FILE_NAME]_myCSS__[HASH] {
  boxShadow: inset 0 0 10px #555, 0 0 20px black;
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
    ["rotate(28.64deg)", "rotate(0.5rad)"]
  ]
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
  color: "red!"
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
  backgroundColor: "$myOtherVariable(red)"
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
    color: "pink"
  },
  _firstOfType: {
    color: "blue"
  },
  __before: {
    content: ""
  }
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
    border: "2px solid aquamarine"
  },
  "nav li > &": {
    textDecoration: "underline"
  }
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
        color: 'red'
      }
    };
  }
});

export const parent = css({
  background: "yellow",
  selectors: {
    [`&:has(${child})`]: {
      padding: 10
    }
  }
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
      padding: 10
    },
    "(prefers-reduced-motion)": {
      transitionProperty: "color"
    }
  },

  // Top level
  "@supports (display: grid)": {
    display: "grid"
  }
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
    "100%": { transform: "rotate(360deg)" }
  },
  animationDuration: "3s",

  // Fontface
  fontFamily: {
    src: "local('Comic Sans MS')"
  },
  // Fontface with multiple
  fontfamily$: [{ src: "local('Noto Sans')" }, { src: "local('Gentium')" }]
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
  font-family: [FILE_NAME]_myCSSFontFace2__[HASH], [FILE_NAME]_myCSSFontFace3__[HASH];
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
    Delay: "2s"
  }
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
    "@media (prefers-color-scheme: dark)": "white"
  }
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
      color: "green"
    },
    "&:hover:not(:active)": {
      color: "blue"
    },
    ":root[dir=rtl] &": {
      color: "black"
    }
  }
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

:root[dir=rtl] nav li > .[FILE_NAME]_myCSS__[HASH] {
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
          color: "green"
        },
        "(min-width: 900px)": {
          color: "blue"
        }
      }
    },

    "@layer framework": {
      "@layer": {
        "layout": {
          color: "black"
        },
        "utilities": {
          color: "white"
        }
      }
    }
  }
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
        "@media (min-width: 900px)": "blue"
      },
      "@layer framework": {
        "@layer": {
          "layout": "black",
          "utilities": "white"
        }
      }
    }
  }
});
```

### 17. Property Reference :icecream:

Inspired by the [Stylus's property lookup](https://stylus-lang.com/docs/variables.html#property-lookup), this feature can be used to refer to a property value.

**Code:**
```typescript
export const myCss = css({
  width: "50px",
  height: "@width",
  margin: "calc(@width / 2)"
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
  flexShrink: "@flexGrow"
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
    }
  },
  secondary: {
    color: "black",
    "%primary &":{
      color: "white"
    }
  }
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

.[FILE_NAME]_base__[HASH] {
  background: blue;
}

.[FILE_NAME]_base__[HASH] {
  background: aqua;
}
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](/CONTRIBUTING.md) for more details.

## License

This project is licensed under the [MIT License](/LICENSE).

# @mincho-js/react

React bindings for Mincho. The package exposes the `styled` API and scoped JSX runtime entries for optional JSX `css` prop support.

## JSX css Prop

Mincho JSX `css` props are opt-in and compile away. This is not Emotion parity: Mincho does not add runtime style insertion, a runtime cache, or a runtime serializer for the `css` prop.

Enable both opt-ins:

1. TypeScript must use the scoped JSX runtime with `jsxImportSource: "@mincho-js/react"`.
2. The Mincho transform must enable `jsxCssProp: true`.

### Vite Setup

Run the Mincho plugin before the React plugin so the `css` prop is lowered before React handles JSX.

```typescript
import { minchoVitePlugin } from "@mincho-js/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [minchoVitePlugin({ jsxCssProp: true }), react()]
});
```

### TypeScript Setup

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@mincho-js/react"
  }
}
```

### Usage

```tsx
import { css } from "@mincho-js/css";

const base = css({
  display: "block"
});

export function App() {
  return <div className={base} css={{ color: "red" }} />;
}
```

With `jsxCssProp: true`, supported intrinsic elements are lowered to the existing Mincho `css(...)` extraction path. If `className` is present, merge order is the existing `className` first and the generated css class second, equivalent to `cx(existingClassName, css(style))`.

### v1 Scope

- Supported: intrinsic React DOM and SVG elements from Mincho's supported tag list, such as `div`, `button`, and `svg`.
- Rejected by the transform: custom React components such as `<Button css={{ color: "red" }} />`.
- Rejected by the transform: JSX member expressions such as `<motion.div css={{ color: "red" }} />`.
- Rejected by the transform: JSX spreads on an element that also has `css`, such as `<div {...props} css={{ color: "red" }} />`.
- Rejected by the transform: unsupported custom elements, duplicate `css`, duplicate `className`, shorthand `css`, and non-object direct values.

Custom React components are not Mincho css-prop targets in v1. If a custom component needs a prop named `css`, it must be its own independent prop surface outside Mincho css-prop lowering.

### Runtime Behavior

`@mincho-js/react/jsx-runtime` is production pass-through to React's automatic JSX runtime. If a `css` prop reaches production runtime, it is passed through unchanged and Mincho does not style it at runtime.

`@mincho-js/react/jsx-dev-runtime` only guards missed transforms. In development, an own `css` prop that reaches `jsxDEV` throws:

```text
Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.
```

### Transform Errors

When `jsxCssProp: true` is enabled, unsupported v1 cases fail during the transform with explicit diagnostics:

| Case | Message |
| --- | --- |
| Custom component or member expression | `Mincho JSX css prop only supports intrinsic elements in v1` |
| Unsupported DOM/SVG tag | `Mincho JSX css prop only supports supported React DOM/SVG tags in v1` |
| Spread on an element with `css` | `Mincho JSX css prop does not support spreads on elements with css in v1` |
| Shorthand `css` | `Mincho JSX css prop requires an expression value` |
| Raw string, number, boolean, null, or function value | `Mincho JSX css prop expects a Mincho CSS object/expression` |
| Duplicate `css` | `Mincho JSX css prop must appear only once` |
| Duplicate `className` | `Mincho JSX css prop cannot merge duplicate className attributes` |
| Shorthand or unsupported `className` value | `Mincho JSX css prop requires className to be a string literal or expression` |

The same `jsxCssProp: true` transform flag is exposed through `@mincho-js/babel`, `@mincho-js/integration`, `@mincho-js/vite`, and `@mincho-js/esbuild`.

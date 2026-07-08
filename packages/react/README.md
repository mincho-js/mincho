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

const styleA = css({
  display: "block"
});

function Panel(props: { className?: string; label: string }) {
  return <section className={props.className}>{props.label}</section>;
}

export function App() {
  return (
    <>
      <div css={{ color: "red" }} />
      <div css={styleA} />
      <Panel css={styleA} label="ClassName forwarding component" />
    </>
  );
}
```

With `jsxCssProp: true`, supported values are lowered to either the existing Mincho `css(...)` extraction path or `cx(...)` class-value merging. If `className` is present, merge order is the existing `className` first and the `css` prop class value second, equivalent to `cx(existingClassName, nextCssClassName)`.

### v2 Value Semantics

The scoped React JSX types define the `css` prop value as `ComplexCSSRule | ClassValue`.

- Inline object expressions are CSS-rule mode through `css(...)`, so `<div css={{ color: "red" }} />` extracts a Mincho CSS rule. Inline object class dictionaries are not supported in this position; assign a `ClassValue` to an identifier, call, member expression, conditional, or literal value instead.
- Inline array expressions are also CSS-rule mode through `css([...])`, so `<div css={[baseClass, { color: "red" }]} />` composes class names and CSS rule objects through Mincho's `ComplexCSSRule` path.
- Identifiers, calls, member expressions, conditionals, strings, numbers, booleans, `null`, and `undefined` are class-value mode through `cx(...)` semantics. This is the migration path for existing Mincho class values: `const styleA = css(...); <div css={styleA} />`.
- Class-value arrays must be explicit, for example `<div css={cx(["base", active && "active"])} />`, or assigned to an identifier before being passed to `css`.
- Strings are class values, not raw CSS declarations. `css="base"` means `cx("base")`, not a serialized CSS body.
- Function values are unsupported in compile-away mode.

### v2 Targets and Forwarding

The transform accepts JSX identifiers and member-expression components, including intrinsic elements, custom React components, member-expression components such as `<motion.div />`, and custom elements.

Custom components and member-expression components are supported only under a className forwarding contract: their props must accept an arbitrary string-compatible `className`, and the component must forward that `className` to the element that should receive the generated styles. The scoped JSX types add `css` through the same `className` compatibility gate.

User-typed custom elements receive typed `css` only when their React JSX intrinsic props include arbitrary-string-compatible `className`. Transformed custom elements emit `className`, not `class`.

### Spread Support

Spread aggregation has both ordering and context restrictions. Every spread must appear before an explicit `css` prop, and the JSX element must be the direct return argument or a direct expression statement. In that supported shape, the transform aggregates those props, removes any spread-provided `css`, and merges the aggregate `className` before the explicit `css` value.

Nested spread aggregation is unsupported in compile-away mode. This includes fragment-child JSX, expression-bodied arrows, conditional JSX, logical JSX, call arguments, unbraced control-flow consequents, and other nested expression contexts that would require expression-local runtime wrappers.

Spread-after-css is unsupported. Explicit `key` or `ref` on spread css-prop elements is also unsupported because the compile-away aggregation cannot preserve those React-only fields safely.

Spread-only css values are not transformed by Babel. If an own `css` prop reaches the production or development JSX runtime, the runtime own-`css` guard throws the missed-transform diagnostic instead of leaking, stripping, or styling it.

### Runtime Behavior

`@mincho-js/react/jsx-runtime` and `@mincho-js/react/jsx-dev-runtime` are thin wrappers around React's automatic JSX runtimes. They only guard missed transforms for own `css` props.

If an own `css` prop reaches either runtime, Mincho throws:

```text
Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.
```

There is no Emotion runtime parity. Mincho does not provide an Emotion runtime serializer/cache/style insertion/theme interpolation/full spread parity/post-JSX runtime wrapper behavior for the `css` prop.

### Transform Errors

When `jsxCssProp: true` is enabled, unsupported v2 cases fail during the transform with explicit diagnostics:

| Case | Message |
| --- | --- |
| Fragment target | `Mincho JSX css prop does not support fragments because fragments cannot receive className` |
| Namespaced JSX target | `Mincho JSX css prop does not support namespaced JSX elements` |
| Unsupported JSX target | `Mincho JSX css prop only supports JSX identifiers and member expressions` |
| Spread after `css` | `Mincho JSX css prop does not support spreads after css in compile-away mode` |
| Pre-css spread aggregation outside a direct return argument or direct expression statement | `Mincho JSX css prop spread aggregation only supports direct return or expression statement JSX in compile-away mode` |
| Explicit `key` or `ref` on a spread css-prop element | `Mincho JSX css prop does not support key/ref on spread elements in compile-away mode` |
| Shorthand `css` | `Mincho JSX css prop requires an expression value` |
| Function value | `Mincho JSX css prop does not support function values in compile-away mode` |
| Duplicate `css` | `Mincho JSX css prop must appear only once` |
| Duplicate `className` | `Mincho JSX css prop cannot merge duplicate className attributes` |
| Shorthand or unsupported `className` value | `Mincho JSX css prop requires className to be a string literal or expression` |

The same `jsxCssProp: true` transform flag is exposed through `@mincho-js/babel`, `@mincho-js/integration`, `@mincho-js/vite`, and `@mincho-js/esbuild`.

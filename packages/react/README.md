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

The scoped React JSX types define the `css` prop value as `ComplexCSSRule | ClassPrimitive`, not the full recursive `ClassValue` type. The primitive side reuses the existing exported `ClassPrimitive` that backs `cx(...)`; React does not duplicate it with a JSX-only union. Object and array syntax belongs to CSS-rule and composition semantics.

- Inline object expressions are CSS-rule mode through `css(...)`, so `<div css={{ color: "red" }} />` extracts a Mincho CSS rule. Transparent direct wrappers keep that mode, including `<div css={{ color: "red" }!} />`, `<div css={{ color: "red" } as const} />`, `<div css={{ color: "red" } satisfies ComplexCSSRule} />`, and `<div css={({ color: "red" })} />`.
- Strings are class values, not raw CSS declarations. Bare string-literal class values such as `<div css="base" />` and `<div css={"base"} />` lower directly to `className="base"` without `cx(...)` when no explicit `className` or spread-derived `className` must be merged.
- Dynamic primitive class values lower through `cx(...)`. This includes identifiers, members, calls, conditionals, logicals, non-string literals, and template literals. This is the migration path for existing Mincho class values: `const styleA = css(...); <div css={styleA} />`.
- If an explicit `className` or pre-css spread aggregate contributes an existing class, string-literal class values still merge through `cx(existing, cssValue)` with the existing class first.
- Class dictionaries require explicit `cx(...)`, for example `<div css={cx({ active: condition })} />`. Explicit `css={cx(...)}` remains a class-value escape hatch and is not unwrapped by the JSX transform.
- Function values are unsupported in compile-away mode.

Supported expression-valued primitive `css` props lower through `cx(...)`:

```tsx
<div css={condition ? "panel active" : "panel"} />
<div css={flag && "panel-active"} />
<div css={providedClass || "panel-fallback"} />
<div css={maybeClass ?? "panel-fallback"} />
<div css={getClassName()} />
```

Static JSX `css` arrays stay on the `css([...])` composition path. They are static `ComplexCSSRule` composition arrays, not recursive `ClassValue` arrays, and they do not lower to `cx(...)` just because they contain string items.

```tsx
<div css={["base", "active"]} />
<div css={["base", ""]} />
<div css={["base", { color: "red" }]} />
```

These are equivalent to `css(["base", "active"])`, `css(["base", ""])`, and `css(["base", { color: "red" }])` static composition.

First-level dynamic primitive array branches lower through one `cx(...)` merge. Primitive branches pass through as arguments, so the empty string stays present as a `ClassPrimitive` value in dynamic arrays.

```tsx
<div css={["base", condition && "active"]} />
<div css={["base", providedClass || "fallback"]} />
<div css={["base", maybeClass ?? "fallback"]} />
<div css={["base", activeClass]} />
<div css={["base", "", activeClass]} />
```

`<div css={["base", "", activeClass]} />` lowers through `cx(...)` with `""` preserved as a `ClassPrimitive` argument, equivalent to `cx("base", "", activeClass)`. Non-string `ClassPrimitive` literals in arrays also lower through `cx(...)`, not static composition:

```tsx
<div css={["base", false]} />
<div css={["base", true]} />
<div css={["base", null]} />
<div css={["base", undefined]} />
<div css={["base", 0]} />
<div css={["base", 1]} />
<div css={["base", 0n]} />
<div css={["base", 1n]} />
```

First-level dynamic object and array CSS-rule branches are extracted at build time, then merged or selected with `cx(...)`. Mincho extracts the static rule branch to a generated class and keeps primitive branches as written.

```tsx
<div css={["base", condition && { color: "red" }]} />
<div css={["base", providedClass || { color: "red" }]} />
<div css={["base", maybeClass ?? { color: "red" }]} />
<div css={["base", condition ? { color: "red" } : "inactive"]} />
<div css={["base", condition ? "active" : { color: "blue" }]} />
<div css={["base", condition && [{ color: "red" }]]} />
<div css={["base", condition && ["active", { color: "red" }]]} />
<div css={["base", { color: "red" }, activeClass]} />
```

The first example lowers like `cx("base", condition && generatedClass)`. Direct static CSS-rule items in otherwise dynamic arrays use the same extraction path, so `<div css={["base", { color: "red" }, activeClass]} />` lowers like `cx("base", generatedClass, activeClass)`.

First-level CSS-rule branches outside arrays are also supported. Mincho lowers each object or array branch with the same CSS-rule extraction path used for direct `css` rules, then composes the generated class names. It does not call `css(condition ? ...)` and does not generate CSS at runtime.

```tsx
<div css={condition ? { color: "red" } : { color: "blue" }} />
<div css={condition ? [{ color: "red" }] : [{ color: "blue" }]} />
<div css={condition && { color: "red" }} />
<div css={condition && [{ color: "red" }]} />
<div css={condition ? styleA : { color: "red" }} />
<div css={condition ? classNameA : { color: "red" }} />
```

Pure object/object or array/array ternaries compile to a `className` conditional between generated class identifiers. Mixed class-value/object branches keep the class-value branch as written and lower only the static CSS-rule branch inside `cx(...)`. Logical `condition && { ... }` and `condition && [{ ... }]` lower the right branch and compose through `cx(condition && generatedClass)`, so `false` does not become class text.

First-level `||` and `??` rule fallbacks are supported when a direct object or array rule is the right operand. The generated class stays inside one logical `_cx(...)` expression, for example `_cx(providedClass || generatedClass)`, not `_cx(providedClass, generatedClass)`.

```tsx
<div css={providedClass || { color: "red" }} />
<div css={providedClass || [{ color: "red" }]} />
<div css={maybeClass ?? { color: "red" }} />
<div css={maybeClass ?? [{ color: "red" }]} />
```

Static-left `||` and `??` rule operands simplify to the generated class for the left rule. The right fallback is unreachable, so Mincho does not evaluate it, reference it, or extract CSS from it. When no explicit `className` or spread aggregate must be merged, the generated-only result emits the generated class directly, not `cx(generatedClass)`. If an explicit `className` or spread aggregate is present, Mincho still merges the existing class first, equivalent to `cx(existing, generated)`.

```tsx
<div css={{ color: "red" } || providedClass} />
<div css={[{ color: "red" }] || providedClass} />
<div css={{ color: "red" } ?? providedClass} />
<div css={[{ color: "red" }] ?? providedClass} />
```

Static-left `&&` object and array rules are truthy guards only. The left rule is not applied as a style, and Mincho emits no dead CSS for it. A dynamic right operand remains `cx(dynamicRight)` because the right operand is a class-value expression, so `{ color: "red" } && providedClass` lowers as `_cx(providedClass)` or equivalent. When both sides are static rules, `{ color: "red" } && { color: "blue" }` extracts only the blue right rule and, when no merge is needed, emits that generated class directly instead of `cx(generatedClass)`. Explicit `className` or spread aggregate merges still use `cx(existing, generated)`.

```tsx
<div css={{ color: "red" } && providedClass} />
<div css={[{ color: "red" }] && providedClass} />
<div css={{ color: "red" } && { color: "blue" }} />
```

The static-rule support is first-level only. Nested dynamic arrays, array spreads, chained branches, permutation-style branches, and sequence-expression object/array CSS-rule branches remain unsupported:

```tsx
<div css={["base", ["nested", condition && { color: "red" }]]} />
<div css={["base", condition && ["active", nested && { color: "red" }]]} />
<div css={["base", ...classes]} />
<div css={outer ? inner ? { color: "red" } : { color: "blue" } : styleA} />
<div css={condition && flag && { color: "red" }} />
<div css={(condition && flag) || { color: "red" }} />
<div css={a || b || { color: "red" }} />
<div css={(0, { color: "red" })} />
<div css={(0, [{ color: "red" }])} />
```

Class-value-only `||` and `??` still lower through `cx(...)` without CSS-rule extraction:

```tsx
<div css={providedClass || "panel-fallback"} />
<div css={maybeClass ?? "panel-fallback"} />
```

The transform only treats syntactic `ObjectExpression` and `ArrayExpression` values, after transparent wrapper normalization, as static CSS rules. It does not evaluate identifiers, member expressions, imports, object variables, constants, or function calls into CSS rules. There is no static evaluation for identifier, member, call, or import-based CSS-rule discovery.

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

Supported static rule branches are converted to generated class names before JSX reaches the runtime. Mincho does not provide StyleX `stylex.props` fallback behavior, inject a StyleX helper namespace, evaluate imported files for CSS rules, or fall back to runtime CSS generation.

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
| Spread element inside a `css` array | `Mincho JSX css prop array values do not support spread elements in compile-away mode` |
| Nested dynamic array branch inside a `css` array | `Mincho JSX css prop array branch extraction only supports first-level dynamic branches` |
| Nested, chained, sequence, unsupported logical, or dynamically resolved object/array CSS-rule value | `Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode` |
| Duplicate `css` | `Mincho JSX css prop must appear only once` |
| Duplicate `className` | `Mincho JSX css prop cannot merge duplicate className attributes` |
| Shorthand or unsupported `className` value | `Mincho JSX css prop requires className to be a string literal or expression` |

The same `jsxCssProp: true` transform flag is exposed through `@mincho-js/babel`, `@mincho-js/integration`, `@mincho-js/vite`, and `@mincho-js/esbuild`.

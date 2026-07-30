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
import type { CSSProperties } from "react";
import { css } from "@mincho-js/css";

const styleA = css({
  display: "block"
});

function Panel(props: { className?: string; style?: CSSProperties; label: string }) {
  return <section className={props.className} style={props.style}>{props.label}</section>;
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

With `jsxCssProp: true`, supported values are lowered to either the existing Mincho `css(...)` extraction path or `cx(...)` class-value merging. If an explicit `className` or pre-css spread aggregate contributes an existing class, merge order is the existing `className` first and the `css` prop class value second, equivalent to `cx(existingClassName, nextCssClassName)`. Post-css spread ordering is covered in Spread Support.

### Dynamic Declaration Values

Static-shape CSS rules can use dynamic declaration values. For example, `<div css={{ color: props.color }} />` keeps the `color` key static while the value comes from runtime props.

Static-shape CSS rule branches can also use branch-local dynamic declarations when each CSS branch is a literal object or array shape:

```tsx
<div css={condition ? { color: props.color } : { color: "red" }} />
<div css={condition ? { color: props.color } : { color: props.fallbackColor }} />
<div css={condition && { color: props.color }} />
<div css={providedClass || { color: props.color }} />
```

For conditional and logical branches, the branch predicate or logical left operand is evaluated once and reused for both `className` and `style`. Inactive branch dynamic declaration values are not read.

Generated branch artifacts may export separate CSS variables per branch even when declaration keys match; treat the raw keys as opaque implementation details.

Under this model, the generated `.css.ts` owns `createVar`, `getVarName`, and `css`. It creates a CSS variable, uses that variable in the generated class rule, and exports the generated className plus the raw CSS-var key. Component modules only import those generated className/raw CSS-var bindings and write runtime values through inline style via the React `style` prop, for example `style={{ [colorVarKey]: props.color }}`. Component modules do not call `createVar`, `getVarName`, or `css` for this fallback.

A custom component receives typed Mincho `css` only when it accepts and forwards both `className` and React-style-compatible `style`. Forward `className` to the styled element, and forward `style` to the same element so generated CSS variable values can land on the element that owns the generated class.

Unsupported dynamic CSS shapes stay unsupported: dynamic keys, computed runtime CSS keys, object or array spreads as branch shapes, call-returned branch objects, function-valued css props, sequence-wrapped branch rules, broad template interpolation, and other dynamic CSS shapes. Static-shape branch rule objects and arrays are supported only when their keys, spreads, and branch shapes are statically analyzable. This is not Emotion-style runtime parity: Mincho does not add a runtime serializer, runtime CSS cache, runtime stylesheet insertion, wrapper component, or runtime CSS generation for the `css` prop.

### Value Semantics

The scoped React JSX types define the `css` prop value as `ComplexCSSRule | ClassPrimitive` plus the supported recursive array helper, not the full recursive `ClassValue` type. The primitive side reuses the existing exported `ClassPrimitive` that backs `cx(...)`; React does not duplicate it with a JSX-only union. Object and array syntax belongs to CSS-rule and composition semantics, while nested dynamic arrays are limited to the compile-away shapes documented below.

- Inline object and array expressions are CSS-rule mode through `css(...)`, so `<div css={{ color: "red" }} />` extracts a Mincho CSS rule. Transparent direct wrappers keep that mode, including `<div css={{ color: "red" }!} />`, `<div css={{ color: "red" } as const} />`, `<div css={{ color: "red" } satisfies ComplexCSSRule} />`, and `<div css={({ color: "red" })} />`.
- Strings are class values, not raw CSS declarations. Bare string-literal class values such as `<div css="base" />` and `<div css={"base"} />` lower directly to `className="base"` without `cx(...)` when no explicit `className` or spread-derived `className` must be merged.
- Dynamic primitive class values lower through `cx(...)` when they are not proven static CSS rules. This includes identifiers, members, calls, conditionals, logicals, non-string literals, and template literals. This is the migration path for existing Mincho class values: `const styleA = css(...); <div css={styleA} />`.
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

### Static Evaluation

Static evaluation can resolve CSS-rule candidates when the value is a direct object or array, a mutation-free same-file `const`, or an import that the integration/provider can resolve to deterministic source or a literal payload. Supported provider-backed sources include project files, package files, data modules, virtual modules, and static CommonJS shapes when the provider also supplies stable identity metadata. Static member paths over those values are supported, including `styles.button`, `styles.button.primary`, `styles["button"]`, `styles["button"].primary`, static computed members such as `styles[variantKey]`, and optional members over proven non-nullish static objects or arrays such as `styles?.button`.

The practical literal grammar is intentionally small: string, number, boolean, `null`, unary numeric expressions such as `-1`, no-expression template literals such as `` `grid` ``, primitive-only template interpolation, nested object/array literals, static computed object keys, static object/array spreads, and static identifier/member operands inside proven CSS-rule literals. Object spreads merge left to right, and later keys win. Array spreads inline each static array operand at the spread position. Supported values are reconstructed as AST literals and then use the same CSS-rule extraction path as inline `css={{ ... }}`.

Top-level primitive identifiers remain class values, so `css={activeClass}` still lowers through `cx(...)` when it is not proven to be a static CSS rule. Primitive identifiers and member values are only statically resolved inside object/array literals that are already proven CSS-rule candidates.

Top-level rule calls such as `css={makeRule("red")}` are supported by handing the whole call to the existing compile-time `css(...)` extraction path. Mincho does not static-evaluate those calls as arbitrary JavaScript, inspect their return values, or execute factories. Nested calls inside static values remain unsupported.

Same-file examples:

```tsx
const color = "red" as const;
const colorKey = "color" as const;
const variantKey = "button" as const;
const columns = 2 as const;
const metrics = { gap: 8 } as const;
const buttonBase = { display: "inline-flex", color: "blue" } as const;
const buttonPressed = { color: "darkred" } as const;
const button = { ...buttonBase, ...buttonPressed, [colorKey]: color, gap: metrics.gap } as const;
const stackParts = [{ display: "flex" }] as const;
const stack = [...stackParts, { gap: metrics.gap }] as const;
const optionalStyles = { card: { padding: 16 } } as const;
const styles = {
  button: { color: "blue" },
  media: { wide: { padding: 24 } }
} as const;
const makeRule = (tone: "red") => ({ color: tone });

<div css={{ ...buttonBase, color }} />
<div css={button} />
<div css={stack} />
<div css={makeRule("red")} />
<div css={styles.button} />
<div css={styles["media"].wide} />
<div css={styles[variantKey]} />
<div css={optionalStyles?.card} />
<div css={{ [colorKey]: `${color}`, gridTemplateColumns: `repeat(${columns}, 1fr)` }} />
```

Project-local import examples:

```tsx
// styles.ts
export const tone = "green" as const;
export const spacing = { card: 16 } as const;
export const cardBase = { padding: 12 } as const;
export const stackParts = [{ display: "flex" }] as const;
export const layout = { stack: [{ display: "flex" }, { gap: 8 }] } as const;

const panel = { color: "green" } as const;
export { cardBase as surface };
export default panel;

// App.tsx
import panel, { cardBase, layout, spacing, stackParts, surface as surfaceStyle, tone } from "./styles";

const card = { ...cardBase, color: tone, padding: spacing.card } as const;
const stack = [...stackParts, { gap: spacing.card }] as const;

<div css={card} />
<div css={stack} />
<div css={surfaceStyle} />
<div css={panel} />
<div css={layout.stack} />
```

Provider-backed package, data, and virtual operands use the same static rules when the integration/provider supplies deterministic source or literal payloads plus identity metadata:

```tsx
import { palette, reset, stackParts } from "@pkg/styles";
import tokens, { brandColor } from "@pkg/styles/tokens.json";
import virtualStyles from "virtual:mincho-styles";

<div css={{ ...reset, color: palette.primary }} />
<div css={{ color: brandColor, padding: tokens.card.padding }} />
<div css={[...stackParts, { color: palette.primary }]} />
<div css={virtualStyles.card} />
```

Provider-backed namespace imports, explicit and star reexports/barrels, package, `node_modules`, and outside-root ESM sources, static-data literal payloads, and virtual modules are supported when deterministic parseable source or literal ESM payload plus source identity and dependency metadata are supplied. Namespace reexports (`export * as ns`) and provider or external modules without loadable source remain unsupported.

Static CommonJS sources can also participate when the integration supplies deterministic source text and identity metadata. Supported shapes are narrow: literal `require("./styles")` namespace, member, and shallow destructure bindings; direct `module.exports` or `exports.name` export maps; static compiler output from tsc/Babel/SWC/Rollup/Vite; and recognized esbuild helper fingerprints. Mincho parses those files as AST only. It does not call Node `require()`, run package runtime resolution, or emulate Webpack/Turbopack/Parcel runtime bundles.

```tsx
const cjsStyles = require("./styles.cjs");
const { base: cjsBase, stack: cjsStack } = require("./styles.cjs");
const path = "./styles.cjs";
const cjsFromPath = require(path);
const templatePath = `./styles.cjs`;
const cjsFromTemplatePath = require(templatePath);

<div css={{ ...cjsBase, color: cjsStyles.color }} />
<div css={[...cjsStack, { padding: 16 }]} />
<div css={cjsFromPath.card} />
<div css={cjsFromTemplatePath.card} />
```

Bundlers provide source resolution and loading only. Vite and esbuild give Mincho provider-backed project, package, data, virtual, and static CommonJS source or literal payloads plus identity metadata and dependency edges. Mincho parses that source and statically evaluates the supported AST subset. No module execution is used. Mincho never executes user modules to obtain `css` prop values, and it does not call Node `require()`, use VM or `eval`, evaluate dynamic imports, or run bundler runtime code for static evaluation.

Function, factory, mixin, and nested call evaluation all remain deferred and out of scope. Mincho never executes a factory to discover returned styles. Unsupported cases include remote/http modules, dynamic CommonJS, package runtime resolution, function/factory/mixin/call values inside static CSS-rule values, optional calls, dynamic or wrong-shape object/array spread operands, computed dynamic keys, dynamic or nullish optional bases, object/call/undefined template interpolation, dynamic imports, runtime dynamic values, SWC-native integration, and full Webpack/Turbopack/Parcel bundle runtime emulation.

Failure policy:

- Existing dynamic class-value identifiers and members that cannot be proven static keep class-value behavior, so `css={activeClass}` and `css={styles.activeClass}` still lower through `cx(...)` when accepted as class values.
- Proven CSS-rule candidates with unsupported internals throw `Cannot statically evaluate css prop value` diagnostics instead of dropping CSS, guessing, or executing code.

Unsupported examples:

```tsx
const dynamicBase = getBase();
const wrongShape = [{ display: "flex" }] as const;
const runtimeColor = props.color;
const runtimeKey = props.property;
const dynamicStyles = props.styles;
const nullStyles = null as { button: { color: "red" } } | null;
const makeRule = () => ({ color: "red" });
const makeColor = () => "red";
const makeKey = () => "button";
const styles = { button: { color: "red" } } as const;
const variant = props.variant;
const dynamicModule = import("./styles");
import { cjsPath as importedCjsPath } from "./paths";
const dynamicCjsPath = props.path;
let nonConstCjsPath = "./styles.cjs";
nonConstCjsPath = "./other.cjs";
const cjsPathBox = { path: "./styles.cjs" };
cjsPathBox.path = "./other.cjs";
const cjsDynamic = require(dynamicCjsPath);
const cjsNonConst = require(nonConstCjsPath);
const cjsMutated = require(cjsPathBox.path);

<div css={{ ...dynamicBase, color: "red" }} />
<div css={{ ...wrongShape, color: "red" }} />
<div css={{ color: makeColor() }} />
<div css={makeRule?.()} />
<div css={{ ...makeRule() }} />
<div css={{ [runtimeKey]: "red" }} />
<div css={styles[makeKey()]} />
<div css={styles[variant]} />
<div css={dynamicStyles?.button} />
<div css={nullStyles?.button} />
<div css={{ color: `${runtimeColor}` }} />
<div css={{ color: `${styles.button}` }} />
<div css={{ color: `${makeColor()}` }} />
<div css={{ color: `${undefined}` }} />
<div css={dynamicModule} />
<div css={cjsDynamic.card} />
<div css={cjsNonConst.card} />
<div css={cjsMutated.card} />

function loadShadowed(require: (path: string) => unknown) {
  const path = "./styles.cjs";
  return <div css={require(path)} />;
}

const cjsImported = require(importedCjsPath);
<div css={cjsImported.card} />
```

These examples fail as static CSS-rule candidates because static evaluation rejects dynamic or wrong-shape spread operands, nested function/factory/call values, optional calls, dynamic and call-derived keys, dynamic or nullish optional bases, runtime/object/call/undefined template interpolation, dynamic import graphs, dynamic/non-const/imported/mutated/shadowed CommonJS require paths, and runtime values.

Static JSX `css` arrays stay on the `css([...])` composition path. They are static `ComplexCSSRule` composition arrays, not recursive `ClassValue` arrays, and they do not lower to `cx(...)` just because they contain string items.

```tsx
<div css={["base", "active"]} />
<div css={["base", ""]} />
<div css={["base", { color: "red" }]} />
```

These are equivalent to `css(["base", "active"])`, `css(["base", ""])`, and `css(["base", { color: "red" }])` static composition.

Dynamic `css` prop branches are recursive in result positions and guard-preserving in predicate positions. Result-vs-guard behavior means CSS-rule objects and arrays are extracted only when they are branch results, array elements, or nested array results. Conditional tests and logical guard operands are cloned as JavaScript predicates; Mincho does not extract CSS from those guards, execute them, or duplicate their side effects.

Support matrix:

| Shape | Support | Compile-away behavior |
| --- | --- | --- |
| Static direct array | Supported | Stays one `css([...])` composition rule. |
| Dynamic primitive array item | Supported | Lowers through `cx(...)`, preserving primitive leaves such as `""`, `false`, `0`, and `1n`. |
| Dynamic object/array CSS-rule branch | Supported | Extracts the static rule branch at build time and merges or selects the generated class. |
| nested/chained ternary result branch | Supported | Recurses through consequent and alternate result values; the test remains a guard. |
| Chained logical result branch | Supported | Recurses through supported right/result values without flattening guards into extra `cx(...)` arguments. |
| nested dynamic array literal | Supported | Lowers nested literal arrays through nested `cx(...)` calls or equivalent class-value composition. |
| Direct CSS-rule array branch | Supported as one CSS-rule unit | `condition && ["active", { color: "red" }]` extracts one generated array-rule class instead of decomposing the string and object. |
| Dynamic spread inside a `css` array | Rejected at any depth | Use explicit array elements; dynamic spread would require runtime array expansion. |
| Sequence expression object/array CSS-rule value | Rejected | Sequence values are not CSS-rule syntax in compile-away mode. |
| Branch-internal static eval expansion | Not performed | Identifiers, members, imports, factories, and calls inside recursive branches remain class-value expressions unless they are direct rule calls already supported at the top level. |

Dynamic primitive array branches lower through one `cx(...)` merge. Primitive branches pass through as arguments, so the empty string stays present as a `ClassPrimitive` value in dynamic arrays.

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

Dynamic object and array CSS-rule branches are extracted at build time, then merged or selected with `cx(...)`. Mincho extracts the static rule branch to a generated class and keeps primitive branches as written.

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

CSS-rule branches outside arrays are also supported recursively. Mincho lowers each object or array result branch with the same CSS-rule extraction path used for direct `css` rules, then composes the generated class names. It does not call `css(condition ? ...)` and does not generate CSS at runtime.

```tsx
<div css={condition ? { color: "red" } : { color: "blue" }} />
<div css={condition ? [{ color: "red" }] : [{ color: "blue" }]} />
<div css={condition && { color: "red" }} />
<div css={condition && [{ color: "red" }]} />
<div css={condition ? styleA : { color: "red" }} />
<div css={condition ? classNameA : { color: "red" }} />
<div css={outer ? inner ? { color: "red" } : { color: "blue" } : styleA} />
<div css={condition && flag && { color: "red" }} />
<div css={(condition && flag) || { color: "red" }} />
<div css={a || b || { color: "red" }} />
```

Pure object/object or array/array ternaries compile to a `className` conditional between generated class identifiers. Mixed class-value/object branches keep the class-value branch as written and lower only the static CSS-rule branch inside `cx(...)`. Logical `condition && { ... }` and `condition && [{ ... }]` lower the right branch and compose through `cx(condition && generatedClass)`, so `false` does not become class text.

`||` and `??` rule fallbacks are supported when a direct object or array rule is in a recursive result position. The generated class stays inside one logical `_cx(...)` expression, for example `_cx(providedClass || generatedClass)`, not `_cx(providedClass, generatedClass)`. Chained logicals preserve JavaScript short-circuiting, so `a || b || { color: "red" }` stays one chained expression ending in a generated class.

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

Nested dynamic array literals are supported when every nested array is a literal expression and every generated CSS-rule object or array appears in a result position. Direct CSS-rule array unit preservation still applies inside recursive arrays: a branch such as `condition && ["active", { color: "red" }]` becomes one generated class for the whole array rule, not independent `"active"` and object-rule class arguments.

```tsx
<div css={["base", ["nested", condition && { color: "red" }]]} />
<div css={["base", condition && ["active", nested && { color: "red" }]]} />
<div css={["base", condition ? ["active", { color: "red" }] : ["fallback", { color: "blue" }]]} />
<div css={["base", ["nested", condition ? { color: "red" } : "inactive"]]} />
```

Dynamic spread and sequence expressions remain rejected. Static array spreads inside proven CSS-rule literals remain on the static composition path described above, not recursive `ClassValue` array handling:

```tsx
<div css={["base", ...classes]} />
<div css={["base", ["nested", ...classes]]} />
<div css={["base", condition && ["active", ...classes]]} />
<div css={(0, { color: "red" })} />
<div css={(0, [{ color: "red" }])} />
```

There is no branch-internal static eval expansion. These branches may be accepted as mixed class-value/CSS-rule expressions, but Mincho does not resolve `styles.red` through static eval or execute `makeRule()` to discover returned styles inside the branch:

```tsx
<div css={outer ? styles.red : { color: "blue" }} />
<div css={condition && makeRule()} />
```

Class-value-only `||` and `??` still lower through `cx(...)` without CSS-rule extraction:

```tsx
<div css={providedClass || "panel-fallback"} />
<div css={maybeClass ?? "panel-fallback"} />
```

The transform treats direct object/array syntax plus proven same-file or provider-backed static operands as CSS rules. Unresolved identifiers, unsupported imports, calls, and runtime expressions remain class-value expressions when they are not proven CSS-rule candidates.

### Targets and Forwarding

The transform accepts JSX identifiers and member-expression components, including intrinsic elements, custom React components, member-expression components such as `<motion.div />`, and custom elements.

Custom components and member-expression components are supported only under a `className` plus `style` forwarding contract: their props must accept an arbitrary string-compatible `className` and a React-style-compatible `style`, and the component must forward both props to the element that should receive the generated styles. The scoped JSX types add `css` through the same `className` and `style` compatibility gate.

User-typed custom elements receive typed `css` only when their React JSX intrinsic props include arbitrary-string-compatible `className` and React-style-compatible `style`. Transformed custom elements emit `className`, not `class`.

### Spread Support

Spread aggregation has both ordering and context restrictions. It applies when an element has an explicit `css` prop plus pre-css spreads, post-css spreads, or both.

Direct statement-list contexts keep statement-hoist lowering. A direct return argument or direct expression statement lets the transform insert aggregate declarations before the JSX statement with no arrow IIFE. Pre-css spreads aggregate props before `css`, remove any spread-provided `css` from the explicit-css element, and merge the aggregate `className` before the explicit `css` value. Post-css spreads compile the explicit `css` value first, strip spread-provided `css`, and merge the final post-spread `className` after the explicit `css` class.

Nested expression contexts use expression-local lowering. When statement insertion is not safe, Mincho wraps the aggregate work in a local zero-argument arrow IIFE that returns the rewritten JSX. Supported nested examples include expression-bodied arrows, conditional branches, logical and nullish operands, call arguments, fragment and element children, JSX attribute expression containers, and unbraced control-flow consequents.

ClassName order is always pre-css aggregate, explicit `css`, then post-css aggregate. Within each aggregate group, object-spread semantics apply, so only the final `className` in that group contributes. Non-class props keep JSX object-spread override order. Nested arrow IIFEs are local JavaScript evaluation for those semantics only: Mincho still compiles explicit `css` away and does not add runtime style insertion, a runtime cache, a runtime serializer, a JSX wrapper component, or a helper library.

Spread-only css values, for example `<div {...{ css: styleA }} />`, are not transformed by Babel. Since there is no explicit `css` prop on the element, Mincho does not compile or strip that spread-provided `css` value. If an own `css` prop reaches the production or development JSX runtime, the runtime own-`css` guard throws the missed-transform diagnostic instead of leaking, stripping, or styling it.

Nested spread aggregation rejects moved expressions containing `await` or `yield`. Mincho does not synthesize async or generator IIFEs because that would change JSX expression result types or generator control flow.

Explicit `key` or `ref` on spread css-prop elements is unsupported because the compile-away aggregation cannot preserve those React-only fields safely.

These spread rules are not Emotion runtime parity. Mincho compiles explicit `css` away, but it does not add runtime style insertion, a runtime cache, a runtime serializer, or full runtime spread parity for the `css` prop.

### Runtime Behavior

`@mincho-js/react/jsx-runtime` and `@mincho-js/react/jsx-dev-runtime` are thin wrappers around React's automatic JSX runtimes. They only guard missed transforms for own `css` props.

Supported static rule branches are converted to generated class names before JSX reaches the runtime. Static imported values are resolved before runtime through the provider-backed AST evaluator described above. Mincho does not provide StyleX `stylex.props` fallback behavior, inject a StyleX helper namespace, execute imported files, or fall back to runtime CSS generation.

If an own `css` prop reaches either runtime, Mincho throws:

```text
Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.
```

There is no Emotion runtime parity. Mincho does not provide an Emotion runtime serializer/cache/style insertion/theme interpolation/full spread parity/post-JSX runtime wrapper behavior for the `css` prop.

### Transform Errors

When `jsxCssProp: true` is enabled, unsupported css prop cases fail during the transform with explicit diagnostics:

| Case | Message |
| --- | --- |
| Fragment target | `Mincho JSX css prop does not support fragments because fragments cannot receive className` |
| Namespaced JSX target | `Mincho JSX css prop does not support namespaced JSX elements` |
| Unsupported JSX target | `Mincho JSX css prop only supports JSX identifiers and member expressions` |
| Spread aggregation outside supported statement-list, replaceable expression, JSX attribute value, or JSX child contexts | `Mincho JSX css prop spread aggregation only supports statement-list JSX, replaceable expression JSX, JSX attribute values, or JSX children in compile-away mode` |
| Nested `await` or `yield` inside moved spread, `css`, or `className` expressions | `Mincho JSX css prop nested spread aggregation does not support await or yield expressions in compile-away mode` |
| Explicit `key` or `ref` on a spread css-prop element | `Mincho JSX css prop does not support key/ref on spread elements in compile-away mode` |
| Shorthand `css` | `Mincho JSX css prop requires an expression value` |
| Unsupported `css` expression shape | `Mincho JSX css prop expects a Mincho CSS object/expression` |
| Function value | `Mincho JSX css prop does not support function values in compile-away mode` |
| Dynamic spread element inside a `css` array at any depth | `Mincho JSX css prop array values do not support spread elements in compile-away mode` |
| Sequence expression object/array CSS-rule value | `Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode` |
| Unsupported dynamically resolved object/array CSS-rule value | `Mincho JSX css prop does not support conditional, logical, or wrapped object/array CSS rule values in compile-away mode` |
| Duplicate `css` | `Mincho JSX css prop must appear only once` |
| Duplicate `className` | `Mincho JSX css prop cannot merge duplicate className attributes` |
| Shorthand or unsupported `className` value | `Mincho JSX css prop requires className to be a string literal or expression` |

Static evaluation failures use diagnostics that start with `Cannot statically evaluate css prop value`, followed by the unsupported reason. Reasons include dynamic or wrong-shape spread operands, nested function/factory/call values, optional calls, dynamic member paths, dynamic or nullish optional member paths, runtime or non-primitive template interpolation, dynamic import graphs, unsupported source kinds such as `external-no-source` or `provider-virtual-no-source`, and unsupported dynamic CommonJS.

The same `jsxCssProp: true` transform flag is exposed through `@mincho-js/babel`, `@mincho-js/integration`, `@mincho-js/vite`, and `@mincho-js/esbuild`.

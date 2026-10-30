# Layout components

Intent-first layout patterns (`@mincho-js/css/layout`) and React DOM components
(`@mincho-js/react/layout`). The pure model lives in `@mincho-js/css/layout/core`. Numeric lengths are CSS
pixels. `Box` preserves natural content flow; `Stack`, `HStack` and `VStack`
arrange children with Flexbox. `Item` describes an exceptional sibling relation.

This first version implements a **native CSS subset** of the layout contract.
It does not include a DOM measurement/precision solver. Precision-only values are excluded from native component props. Untyped calls
are checked locally with `LayoutError` / `E_LAYOUT_CAPABILITY`; checks that need
the actual parent or siblings run in development. Production assumes those
structural contracts were validated and does not implement precision semantics. See [Development and production](#development-and-production)
for how each mode reports errors.

## Design intent

The API keeps the decisions behind a layout visible: its structure, how items
use available space, and which sibling relationships are exceptional. The goal
is to make ordinary layouts simple, exceptions explicit, and results inspectable.
The browser still performs native layout.

| Decision        | With direct Flexbox                                       | With Layout components                                                          |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Structure       | Choose display, direction and alignment properties        | Use `HStack`/`VStack` for stacks and `Box` for natural flow                     |
| Sizing          | Coordinate dimensions, basis, grow/shrink and bounds      | Declare hug, fixed or stretch sizing, with explicit constraints                 |
| Sibling spacing | Coordinate gap, margins, direction and edge cases         | Give the parent a default gap and one Item ownership of an exception            |
| Validation      | Check CSS output against the application's intended rules | Diagnose conflicting declarations and inspect relations beside browser geometry |

This is useful when layouts repeat across a product or change with content,
direction and conditional rendering. A team can review the intended relationship
without reconstructing the reason for each CSS override. Direct Flexbox remains
a good choice for a small fixed layout or an existing CSS system that already
provides these conventions. The abstraction adds API learning and, in the development React
entry, DOM validation; it does not promise faster rendering or smaller bundles.

Ordinary children need no Item wrapper. Add `Item` when a child needs a specific
layout role or relationship; its default DOM node remains a cost. `as="button"`
renders the button itself, and `as={Button}` selects a custom component using the
same polymorphic contract as styled. Keep meaningful nesting for shared
backgrounds, accessibility groups and interactions.

The original design also describes precise shrink ratios, shared allocation
between items and spaces, and strong wrapping rules. Those are design goals;
the current native subset rejects requests requiring that solver. The Inspector
reports browser geometry and canonical declarations, not a precision-solver trace.

## Class names

Use patterns in a `.css.ts` file processed by the build integration:

With Vite, authored `.css.ts` files also need `vanillaExtractPlugin()` from
`@vanilla-extract/vite-plugin` alongside `minchoVitePlugin()`. The esbuild adapter
already includes that CSS-file processing. The `extractCalls` path below
handles ordinary TS/TSX files without the additional Vite plugin.

```ts
// toolbar.css.ts
import { hstack } from "@mincho-js/css/layout";

export const toolbar = hstack({
  width: 400,
  gap: 16,
  padding: 24,
  align: "center",
  justify: "between",
});
```

```tsx
import { toolbar } from "./toolbar.css";

<header className={toolbar}>
  <button>Back</button>
  <button>Save</button>
</header>;
```

`box`, `stack`, `hstack`, `vstack` and `item` return class name strings. CSS is
extracted through the build integration; these functions are build-time authoring APIs, not
runtime stylesheet injectors. Standalone container patterns assume a natural-flow
parent. `item(options, parentStackOptions)` can express placement in a known
parent but rejects sibling relations without a complete item list.

The Vite and esbuild integrations recognize these patterns in ordinary TS/TSX
files as built-in extraction calls as well; no `extractCalls` registration is
needed. Arguments must be statically evaluable. Use React components for
runtime layout values.

For a fixed, known DOM sequence, compile all sibling relations together:

```ts
import { stackLayout } from "@mincho-js/css/layout";

export const actions = stackLayout(
  { axis: "horizontal", width: 400, gap: 12 },
  [
    { id: "cancel", props: { width: 100, gapAfter: "stretch" } },
    { id: "save", props: { width: 100 } },
  ],
);
// actions.className -> container
// actions.itemClassNames.cancel / .save -> direct children
```

That list must match the visible DOM order and participation. Class names alone
cannot observe removed/hidden children, changed parents, or conflicting styles.
Use the React entry for dynamic topology. Do not apply two layout patterns to
the same element: compose decoration with its one layout class instead.

## React DOM

```tsx
import { HStack, Item } from "@mincho-js/react/layout";

<HStack width="stretch" gap={8} padding={24} align="center">
  <Item width={100} gapAfter="stretch">
    <button>Cancel</button>
  </Item>
  <button>Previous</button>
  <button>Next</button>
</HStack>;
```

Ordinary DOM children remain ordinary flex items; no automatic wrappers are
inserted. Components accept dynamic values and do not import the build-time
compiler. Layout-owned styles must be expressed as layout props; `style` and
`className` are for decoration. Use `as="ul"` / `Item as="li"` for semantic
HTML. Native props, events and refs are typed for the selected tag.

`as` accepts an HTML tag or a React component, just like styled. Props, events,
children and refs are passed to the selected target; no child element is cloned
and no extra wrapper is inserted. Props and ref types follow that target:

```tsx
<Item as="a" href="/save" gapAfter="stretch">Save</Item>
<Item as={Link} to="/save" gapAfter="stretch">Save</Item>
```

A custom target must forward `className`, `style`, `ref`, data attributes and
needed events to one HTML root. No registration helper is required. The root,
forwarded layout attributes/styles/classes and actual parent are checked after
commit in development. Fragments, portals and multiple roots do not satisfy this
contract. The target component owns its event behavior, as with styled.

### Parent-independent rendering

An element never needs its parent to render. It writes its own declarations as
CSS variables, for example its natural width and the width it uses when it is a
Stack's main or cross axis, and Stacks expose `data-mincho-layout-axis`. The
shared layout stylesheet selects the applicable values with rules such as
`[data-mincho-layout-axis="horizontal"] > [data-mincho-layout]`. Its selectors
use doubled attributes to keep ordinary single-class decoration from overriding
layout rules. This is a cascade convention, not an isolation boundary: ID selectors,
more specific selectors, inline styles and `!important` can still win. Decoration
may set colors, shadows and typography, but must not override layout properties
or the reserved `--mincho-layout-*` variables.

- Fixed `gapBefore`/`gapAfter` become variables. The stylesheet decides from the
  actual siblings whether the Item is at an outer edge, where it receives the
  whole space, or between items, where the parent gap is subtracted. A
  component returning `null` and an element with the `hidden` attribute are not
  siblings, so a newly first Item keeps its own `gapBefore` as edge space. Hide
  siblings with conditional rendering or `hidden`, not CSS: a sibling hidden
  only by CSS still counts, and development reports the resulting mismatch.
- `"stretch"` spaces render as `auto` margins, which do not depend on position.
- Stretch weights are multiplied by one constant (10⁴), so every line uses all
  its free space without knowing its siblings. Weights must be at least 0.0001.

Production uses no layout context, measurement effects, computed-style reads or
observers. A commit ref installs the shared stylesheet in each host document
(including iframe/portal documents), using DOM writes and an existing-sheet
query without forcing style calculation. For SSR, import the stylesheet so the
server markup is styled before hydration:

```ts
import "@mincho-js/css/layout.css";
```

To provide the sheet yourself, mark its `<style>` or stylesheet `<link>` with
`data-mincho-layout-sheet`; the client then skips its own installation in that
document. An unmarked bundled CSS import can coexist with the injected copy.

Intervening DOM wrappers, anonymous text mixed with relations, and out-of-flow
siblings mixed with relations are errors. Use a relative `Box` to contain
overlays. `Box` and `Item` start a natural-flow context for descendants.

### Compiled layout JSX

Production builds through `@mincho-js/vite` or `@mincho-js/esbuild` lower
static Layout subtrees as part of the styled-component optimization by default
(`optimize.styledComponents`, enabled by the production optimization profile).
When the layout props and descendants can all be lowered, each Layout element
becomes an intrinsic element with a class extracted into the CSS sidecar:

```tsx
// Source
<HStack as="nav" gap={8} className="toolbar">…</HStack>
// Production output (illustrative)
<nav data-mincho-layout="HStack" data-mincho-layout-axis="horizontal"
     className={extractedClass + " toolbar"}>…</nav>
```

The class holds the same parent-independent declarations the React renderer
writes inline, so compiled and runtime elements can be mixed in one tree and
produce the same geometry while decoration respects the layout-owned properties.
Arbitrary CSS that overrides those properties can affect compiled and inline
declarations differently. Identical normalized declarations reuse a class within
each source-file evaluation. Separate CSS assets keep their own rules so a lazy
entry never relies on an unrelated entry having loaded first. The transformed module also imports
`@mincho-js/css/layout.css`. No component, context or effect remains for a
compiled element.

An element stays a runtime component when a layout prop, `as` or `style` is not
statically known, when it uses a custom component as its `as` target,
`debugLayout` or a spread, or when a `Stack`'s `axis` is dynamic. A static `style` that sets a layout-owned property
to a defined value fails the build, even if it matches a default, as it would
throw at runtime. Undefined style values are ignored; styles with possibly
undefined layout-owned values keep runtime validation. Development builds keep
runtime components by default so that development diagnostics still run. An explicit
`styledComponents: true` override can lower static elements in development too.
Layout elements containing runtime descendants, custom components, or opaque
children retain their runtime provider. Their nested Layout elements also stay
runtime components, preserving parent context and participant registrations for
development diagnostics. Independent static subtrees can still be lowered. Set
`optimize: { styledComponents: false }` to keep them in production too.

In development, compiled elements carry their static layout props in a private
data attribute. A runtime Stack can therefore validate a compiled root returned
by a separate component, including its stretch and spacing rules. Production
never renders this attribute; minification removes the metadata branch from
the bundle together with the development diagnostics.

## Native support boundary

`ItemOptions` and React `ItemProps` expose fixed/default-auto spacing and `allow`
breaks. `PrecisionBoundarySpace`, `PrecisionBreakPolicy` and `ItemRequirements`
are unrendered core model types for tooling and diagnostics, not promises of a
working precision renderer. Cross-item constraints still require development
validation; TypeScript cannot prove the DOM produced by arbitrary components.

The default `shrink=false` deliberately revises the initial specification, which
made hugging and percentage items shrink implicitly. Two hugging cards now
render normally; explicitly mark the one item that may yield. This keeps CSS
scaled shrink from being advertised as exact pixel-weight shrink allocation.

Responsive prop maps, token-valued spacing and Grid are outside this native API.
The current CSS class compilation removes static runtime work; it does not add
those capabilities. References to Figma, Subform, elm-ui and Reshaped describe
design influences, not full API or behavior parity.

Supported: px/percentage/hug sizes, constraints, padding, horizontal writing
mode with LTR/RTL, alignment, natural wrapping, line gaps, absolute positioning,
non-wrapped fixed relations, and unweighted auto spaces with their default
minimum. Main-axis stretch ratios support min/max and fractional weights. Cross
stretch fills its line.

The renderer conservatively rejects these requests:

- More than one layout-managed shrink participant. CSS's scaled shrink factors
  do not implement the specified pixel reduction ratios. Layout-managed fixed,
  percentage and hugging sizes are kept by default; declare `shrink` only
  on the item that may yield. Unmanaged DOM children retain their own browser
  CSS policy.
- Stretch items competing with stretch boundaries, weighted/bounded variable
  boundaries (including an explicit `minSize`, whose default differs between
  edges and boundaries), and multiple stretch items with padding/border insets.
- Explicit spacing on wrapped items, `never`/`force` boundaries, and vertical
  wrapping without an independently definite height.
- Unresolved percentage/hug dependencies, main stretch in a hugging parent,
  cross weights, conflicting cross alignment, and vertical baseline alignment.

Ordinary wrapping, sizing and text layout remain browser operations. No
water-filling, precise shrink, wrap-grouping or intrinsic measurement solver is
claimed. External CSS must preserve the layout's sizing, flow and writing mode.
The browser baseline is Chrome/Edge 115+, Firefox 113+, and Safari 17.6+.
Edge spacing uses [`:nth-child(… of S)`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:nth-child)
(Chrome 111+, Firefox 113+, Safari 9+); overflow behavior also needs
[`safe` alignment](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/justify-content),
which raises the Chromium and Safari minimums. There is no legacy-selector fallback.
Geometry is currently regression-tested in Chromium. Numeric validation and locally knowable errors also run on SSR.

SSR outputs the same declarations and variables as the client. In development,
Stacks start with `data-mincho-layout-state="pending"` until validated. There is
no server font measurement or guarantee of zero layout shift.

### Development and production

Invalid declarations in layout props, such as bounds that cannot fit or a
`style` that overrides a layout-owned property, throw during render in every
mode. They depend only on props, so the same input fails in development, tests
and SSR.

Checks that need the parent, such as an Item outside a Stack, a percentage in a
hugging parent or explicit spacing with distributed `justify`, run only in
development, where Stacks pass their semantics through context. After mounting,
the two modes differ when `process.env.NODE_ENV` is replaced by your bundler:

|                  | Development                                                                                                                                                      | Production   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Context, effects | Parent context, registrations and a validation loop per Stack                                                                                                    | None         |
| DOM reads        | Computed styles of the Stack and its direct children                                                                                                             | None         |
| Observation      | Subtree mutations, Stack and child sizes, window resize                                                                                                          | None         |
| Checks           | Parent-dependent checks, participant checks, duplicate boundary spaces, mixed text/out-of-flow siblings, CSS-hidden siblings, external CSS, custom `as` forwarding | Not detected |
| Errors           | Thrown to the nearest React error boundary; Stacks end `valid`, `hidden` or `error`                                                                              | Not detected |

Development observes the DOM because computed styles can change without a DOM
mutation, for example through media queries, container queries or ancestor
classes. Production relies on the stylesheet, so the browser applies those
changes itself. It does not detect the problems that only development checks,
so run the application in development or tests before shipping. Like React,
the React entry reads `process.env.NODE_ENV` directly, so your bundler must
define it. Production bundles then fold the checks and drop the
development-only module.

`inspectLayout(stackElement)` validates a Stack on demand in development, then
reads browser rectangles and computed CSS. It returns canonical boundaries and
edges with `path: 'native', source: 'browser'`.
`debugLayout` adds an identifying data attribute. It does not enable a solver or
continuous geometry measurement.

## Development playground

Run `yarn workspace @examples/layout-playground dev` and open `http://127.0.0.1:5173`.
The demo loads the React renderer from source. The design tab groups the API
rationale and references; the examples tab groups comparisons, the Inspector,
and the axis explorer. Tab changes preserve experiment controls, and section
links open the relevant tab. Eight interactive cases compare
Layout components with independently authored Flexbox using the same inputs: Hug/Fixed/Stretch,
nested HStack/VStack cards, boundary-specific space, conditional DOM and RTL,
bounded weights, wrapping, shrink/overflow, and actual validation diagnostics.
Each case includes code, its API benefit, and a link to the design reference.
The axis explorer additionally lets you change direction, gap and alignment.

The Layout Inspector follows the selected case and shows browser geometry,
item bounds, canonical boundary declarations and computed CSS. You can also
select the axis explorer; the panel refreshes on DOM and size changes. These
observers belong to the development demo, not the published runtime.
Run `yarn workspace @examples/layout-playground check` to check the demo's types.

## Validation

`yarn workspace @mincho-js/css test src/layout` covers normalization and
extraction; `yarn workspace @mincho-js/react test src/layout` covers SSR. `yarn workspace @examples/layout-playground test:browser` checks real
Chromium geometry, conditional roots, RTL, refs, StrictMode and hydration.
Install its browser with `yarn workspace @examples/layout-playground playwright install chromium`;
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing browser.

Package-contract checks also exercise npm and strict Yarn PnP consumers, ESM/CJS
entry points, TypeScript declarations, and Vite/esbuild class extraction.

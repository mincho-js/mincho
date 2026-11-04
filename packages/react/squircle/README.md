# SquircleMask

`SquircleMask` clips an HTML element and its contents with smoothed corners
using CSS `clip-path`.
It uses the cubic–arc–cubic construction described in Figma's
[corner smoothing article](https://www.figma.com/blog/desperately-seeking-squircles/).
This is a smoothed rounded rectangle, not an exact mathematical superellipse.

```tsx
import { SquircleMask } from "@mincho-js/react/squircle";

<SquircleMask width={240} height={160} radius={32} smoothing={0.6}>
  <img src="/photo.jpg" alt="Mountain lake" width={240} height={160} />
</SquircleMask>

<SquircleMask as="button" type="button" radius={20}
  style={{ padding: "16px 24px", background: "rebeccapurple", color: "white" }}>
  Save changes
</SquircleMask>
```

The default element is `div`. `as` selects an HTML element or a component that
forwards `style`, other host props, and `ref` to one HTML root. Attributes and ref
types follow the selected target. There is no `asChild` wrapper contract, layout
solver, or compiler configuration required. Responsive sizes share a stylesheet
installed on mount; fixed sizes need no stylesheet injection.

## Inputs and sizing

| Prop              | Default            | Meaning                                            |
| ----------------- | ------------------ | -------------------------------------------------- |
| `width`, `height` | CSS/content sizing | Fixed border-box CSS px when supplied              |
| `radius`          | `24`               | Requested corner radius in CSS px                  |
| `smoothing`       | `0.6`              | `0`: circular corners; `1`: fully smoothed corners |
| `cacheMask`       | `true`             | Reuse measured paths from a bounded cache          |

Numbers must be finite. Negative numbers clamp to zero; smoothing clamps to
`[0, 1]`. As the box gets smaller, smoothing decreases first. Once it reaches
zero, the radius is capped at half the shorter dimension. Zero radius, zero
smoothing, and boxes too small for smoothing use native `border-radius` clipping.

Explicit dimensions set matching `width`/`height`, minimum, and maximum values
with `box-sizing: border-box`. They take precedence over inline sizing styles.
Keep padding and border insets within those dimensions, and do not override them
with `!important`: the fixed-size path assumes the browser can honor the supplied
border box. To follow media/container queries, flex sizing, or content, omit the
corresponding dimension props and size the element with CSS.

The component owns `clip-path`, `border-radius`, and `overflow: hidden`.
Use other style/class properties for decoration. A
custom `as` target must retain these declarations, and its `className`.
Responsive boxes receive their `shape()` clip from a class rule, so another
rule of equal or greater specificity can override it. Base sizing and rounded
fallback styles stay inline for all boxes.

## Fixed and responsive rendering

When both dimensions are supplied, the exact `clip-path: path(...)` is part of the
server-rendered style. That path performs no geometry reads, creates no resize
observer, and encodes no image. The native rounded-corner cases also avoid
observation.

For responsive sizes, the server and client render the class names
`mincho-squircle` and one class per radius and smoothing, such as
`mincho-squircle-r20-s0_6`, alongside inline `box-sizing: border-box`,
`overflow: hidden`, and the rounded `border-radius` fallback. This preserves the
border box, including padding and borders, before and after hydration.
On mount, the component inserts the shared clip rule into the
element's document or shadow root, in one `<style data-mincho-squircle>` per
tree:

```css
.mincho-squircle-r20-s0_6 { clip-path: shape(…); }
```

The `shape()` is built from edge offsets (`calc(100% - …)`), so ordinary resizes
reuse it without rebuilding a path. A resize observer still checks whether the
available size clamps smoothing. Equal corners share one clip rule; base styles
remain inline for reliable SSR sizing and fallback clipping. Lengths stay
literal in each rule: taking them from `var()` would substitute them again for
every element.
Rules are reference counted; up to 32 unused rules stay for remounts and slider
sweeps before the oldest is removed.

The server markup contains no stylesheet. Until the client mounts, responsive
boxes use rounded corners. Once the shared rule is installed, the controller
sets `border-radius: 0` so it does not intersect the smoothed clip. This can
change corner appearance during hydration, but not the box's dimensions.

The shape is exact while both border-box axes are at least
`2 × (1 + smoothing) × radius`. Below that, the geometry must reduce smoothing
first, which CSS cannot express, so offsets are clamped to half the axis as an
approximation until measured.

After mounting, one shared `ResizeObserver` per document supplies border-box
dimensions. Boxes within the smoothing budget keep the shared rule; smaller
boxes get an exact measured `path()` written to the element's inline
`clip-path`, and return to the rule once they grow. Resizing does not update
React state or remount children. Reads are batched before writes, duplicate sizes
are ignored, and the last subscriber disconnects the observer. Iframes use their
own document's observer. Changing radius or smoothing reuses the last observed
size. Logical and physical content sizes supplied by the observer determine the
axes without reading computed styles when they match unambiguously. Square
content or legacy reports fall back to a fresh writing-mode read, so CSS-driven
axis changes remain correct.

Browsers without CSS `shape()` use measured `path()` clipping for every observed
size. The same fallback applies if CSP blocks the injected stylesheet or a
required rule cannot be inserted. An unsuccessful installation is cached per
tree, so mounting more boxes does not repeatedly attempt a blocked stylesheet.
Without `ResizeObserver` as well, the rounded fallback stays. CSP policies that
also prohibit server-rendered inline styles still require the application to
provide an allowed styling strategy; this fallback does not bypass those
policies. Measured paths draw
corners with relative commands that depend only on radius and smoothing, so they
are cached per pair and a new size formats four numbers.

The path cache retains at most 128 entries and an estimated 512 KiB of UTF-16
strings, not a guaranteed total heap size. Keys use exact effective dimensions;
animation sizes are not quantized. `cacheMask={false}` bypasses this cache.
Path-only use never encodes an SVG image; `getSquircleMask(...).image` encodes one
lazily for consumers that need a mask image, and materializing it updates the
same cache budget.

## Class names and geometry without React

Use the CSS package's fixed-size pattern in a `.css.ts` file processed by
vanilla-extract (for example, `vanillaExtractPlugin()` from
`@vanilla-extract/vite-plugin`, alongside the existing Mincho Vite plugin):

```ts
import { squircle } from "@mincho-js/css/squircle";

export const avatar = squircle({ width: 80, height: 80, radius: 20 });
```

Apply `avatar` as a normal `className`. Its fixed dimensions and `clip-path`
live in the extracted stylesheet; there is no React observer or runtime work.
Do not resize this class with another rule: generate a corresponding class for
each fixed size, or use the responsive React entry.

`@mincho-js/css/squircle/core` exposes `getSquirclePath`, `getSquircleShape`
(responsive `clip-path` value), `getSquircleGeometry`, `getSquircleStyle`,
`getSquircleMask` (cached), and `createSquircleMask` (uncached).
These helpers need neither React nor a DOM or active CSS extraction scope.
Shape and mask helpers return `null` when native rounded corners suffice.
Geometry records contain the effective radius and smoothing after clamping.

## Painting and interaction

The clip applies to all painted content, including children, outer shadows,
and focus outlines. Keep external shadows and focus indicators on an unmasked outer element,
or use a visible inset focus treatment. A CSS border is clipped too; it is not a
constant-width squircle stroke. This component does not implement such a stroke.

`clip-path` also clips hit testing: pointer events in the cut-away corners reach
whatever is underneath. The component preserves native HTML semantics
and event handling; it does not synthesize button or link behavior.

Run the interactive comparison with `yarn workspace @examples/layout-playground dev`
and open the **스쿼클** tab. The controls compare circular and smoothed corners,
including the small-box fallback and content-sized buttons.

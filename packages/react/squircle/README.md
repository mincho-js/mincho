# SquircleMask

`SquircleMask` clips an HTML element and its contents with smoothed corners.
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
solver, stylesheet injection, or compiler configuration required.

## Inputs and sizing

| Prop              | Default            | Meaning                                            |
| ----------------- | ------------------ | -------------------------------------------------- |
| `width`, `height` | CSS/content sizing | Fixed border-box CSS px when supplied              |
| `radius`          | `24`               | Requested corner radius in CSS px                  |
| `smoothing`       | `0.6`              | `0`: circular corners; `1`: fully smoothed corners |
| `cacheMask`       | `true`             | Reuse geometry and images from a bounded cache     |

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

The component owns mask properties, `border-radius`, `overflow: hidden`,
`isolation: isolate`, and its internal custom properties. Use other style/class
properties for decoration. A custom `as` target must retain these declarations.

## Fixed and responsive rendering

When both dimensions are supplied, the mask is ready during server rendering.
That path performs no geometry reads and creates no resize observer. The native
rounded-corner cases also avoid observation.

After mounting, smooth masks use a live SVG fragment. Updating dimensions or
smoothing changes the path on the existing resource instead of replacing an SVG
image URL and asking the browser to load/decode a new image on every slider event.
One invisible, noninteractive SVG resource container is shared per document or
shadow root. Each mounted smooth mask owns one mask/path pair; removing the last
mask removes the container too. Child elements and their event targets stay in
place. Native rounded corners do not allocate SVG resources.
The initial fixed-size SSR image stays as a stable hydration fallback. Mounted
updates use path data without encoding another data URL or rewriting that image
declaration.

For responsive sizes, the server and initial client render use the same rounded
fallback. After mounting, one shared `ResizeObserver` per document supplies
border-box dimensions. The component updates the SVG path directly;
resizing does not update React state or remount children. Reads are batched before
writes, duplicate sizes are ignored, and the last subscriber disconnects the
observer. Iframes use their own document's observer. Changing radius or smoothing
reuses the last observed size.
Logical and physical content sizes supplied by the observer determine the axes
without reading computed styles when they match unambiguously. Square content or
legacy reports fall back to a fresh writing-mode read, so CSS-driven axis changes
remain correct.

The mask cache retains at most 128 entries and an estimated 512 KiB of UTF-16
strings, not a guaranteed total heap size. Keys use exact effective dimensions;
animation sizes are not quantized. `cacheMask={false}` bypasses this cache.
Images are encoded lazily on the first `image` access; live path-only entries do
not retain an encoded SVG. Materializing an image updates the same cache budget.

Responsive hydration can change the visible corner shape after measurement;
there is no claim that the server knows the final geometry. Browsers without
`ResizeObserver` keep the rounded fallback. CSS masking must be supported. The
fixed server-rendered fallback and the extracted CSS pattern use SVG data URLs,
which must be allowed by the application's content security policy. The React
entry also uses inline styles.

## Class names and geometry without React

Use the CSS package's fixed-size pattern in a `.css.ts` file processed by
vanilla-extract (for example, `vanillaExtractPlugin()` from
`@vanilla-extract/vite-plugin`, alongside the existing Mincho Vite plugin):

```ts
import { squircle } from "@mincho-js/css/squircle";

export const avatar = squircle({ width: 80, height: 80, radius: 20 });
```

Apply `avatar` as a normal `className`. Its fixed dimensions and encoded SVG live
in the extracted stylesheet; there is no React observer or runtime SVG creation.
Do not resize this class with another rule: generate a corresponding class for
each fixed size, or use the responsive React entry.

`@mincho-js/css/squircle/core` exposes `getSquirclePath`, `getSquircleGeometry`,
`getSquircleStyle`, `getSquircleMask` (cached), and `createSquircleMask` (uncached).
These helpers need neither React nor a DOM or active CSS extraction scope.
Mask helpers return `null` when native rounded corners suffice. Geometry records
contain the effective radius and smoothing after clamping.

## Painting and interaction

A mask clips all painted content, including children, outer shadows, and focus
outlines. Keep external shadows and focus indicators on an unmasked outer element,
or use a visible inset focus treatment. A CSS border is clipped too; it is not a
constant-width squircle stroke. This component does not implement such a stroke.

Masking changes painting, not the DOM's hit-testing shape. Transparent corners
can still receive pointer events. The component preserves native HTML semantics
and event handling; it does not synthesize button or link behavior.

Run the interactive comparison with `yarn workspace @examples/layout-playground dev`
and open the **스쿼클** tab. The controls compare circular and smoothed corners,
including the small-box fallback and content-sized buttons.

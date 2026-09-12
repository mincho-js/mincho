# @mincho-js/transform-to-vanilla

## 1.0.0

### Major Changes

- [#366](https://github.com/mincho-js/mincho/pull/366) [`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01) Thanks [@black7375](https://github.com/black7375)! - **V5 Release: Strict Immutable Graph, Compact Scoped Runtime, and Sidecar Stylesheet Contract**

  This release introduces the complete V5 contract for defineRules preset serialization, package boundaries, and stylesheet compilation.

  ### Breaking Changes
  - **V5 Graph Schema**: Replaced the legacy V3/V4 flat preset metadata with a strict, immutable, content-addressed V5 node graph. Presets are composed of immutable parent nodes and local atoms, resolving class conflicts deterministically via last-parent-wins or local-wins Depth First Search (DFS). Legacy V3/V4 artifacts or custom mapping types are no longer supported and fail with direct validation errors.
  - **Authoring & Runtime Separation**: Established a clear package boundary split. Apps import runtime-safe, graph-free compiled exports from the package root `.`, while downstream library authoring `.css.ts` files import authoring preset nodes and types from `./preset`. Explicit full-package sidecars are accessed via `./style.css`.
  - **Compact Scoped cx**: Dynamic `cx` runtime output has been minimized to exclude the heavy V5 graph/provenance. It now carries only a compact `classWrites` lookup mapping valid classes to internal write IDs, plus optional marker `segments` for runtime state. Static `cx` emits static class name literals at build time with no runtime table.
  - **Sidecar Stylesheet Auto-Loading**: Pre-compiled package stylesheets containing own-atom rules are automatically resolved relative to the entry chunk. Hand-editing or manual stylesheet linking is no longer required, though `./style.css` remains as an explicit bundle escape hatch.

  ### Known Limitations
  - Published package stylesheets contain all defined component rules; pruning unused component declarations is not performed at the asset level.
  - Native Node.js runtimes cannot load `.css.ts` or CSS-importing root exports without a bundler integration.
  - Scoped style hydration is global to the active environment; per-export or partial-hydration models are not implemented.

  ### Migration Guidance

  Rebuild all providers using the V5 compiler and update downstream `.css.ts` style definitions to import the `./preset` subpath for authoring. Legacy V3/V4 preset compatibility is unsupported.

### Patch Changes

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- [#248](https://github.com/mincho-js/mincho/pull/248) [`0b49f8a`](https://github.com/mincho-js/mincho/commit/0b49f8a4a617273bd300879ab930d2303e53192d) Thanks [@black7375](https://github.com/black7375)! - **type**
  - add `selectors` property to CSSConditions

- Updated dependencies [[`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189)]:
  - @mincho-js/css-additional-types@0.1.1

## 0.2.2

### Patch Changes

- [#199](https://github.com/mincho-js/mincho/pull/199) [`1c89ca9`](https://github.com/mincho-js/mincho/commit/1c89ca943c9d1495230145d47cf810d820aeddbb) Thanks [@black7375](https://github.com/black7375)! - **Nested Selector with commas and parens**
  - Fixes an error that occurs when parentheses are present.

## 0.2.1

### Patch Changes

- [#195](https://github.com/mincho-js/mincho/pull/195) [`98a9c93`](https://github.com/mincho-js/mincho/commit/98a9c9335f84407717cd5fd7d62ce6c6070af284) Thanks [@black7375](https://github.com/black7375)! - **Nested Selector with commas**
  - Support for global styles with nested selectors that contain commas.

## 0.2.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

### Patch Changes

- Updated dependencies [[`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98)]:
  - @mincho-js/css-additional-types@0.1.0

## 0.1.0

### Minor Changes

- [#164](https://github.com/mincho-js/mincho/pull/164) [`69b3b39`](https://github.com/mincho-js/mincho/commit/69b3b3990e3507da43ee68058a2d02ee28aef26a) Thanks [@black7375](https://github.com/black7375)! - Support `rules` known as variants

## 0.0.3

### Patch Changes

- [#116](https://github.com/mincho-js/mincho/pull/116) [`9d5f878`](https://github.com/mincho-js/mincho/commit/9d5f878754e216b21fa233e215b25523c822a9a7) Thanks [@black7375](https://github.com/black7375)! - Variant features

## 0.0.2

### Patch Changes

- [#66](https://github.com/mincho-js/mincho/pull/66) [`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f) Thanks [@black7375](https://github.com/black7375)! - First released

- Updated dependencies [[`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f)]:
  - @mincho-js/css-additional-types@0.0.2

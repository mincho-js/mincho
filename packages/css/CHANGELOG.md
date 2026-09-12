# @mincho-js/css

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

### Minor Changes

- [#308](https://github.com/mincho-js/mincho/pull/308) [`7396e4f`](https://github.com/mincho-js/mincho/commit/7396e4f8870b0959bb1ae99e279f3544def0180f) Thanks [@black7375](https://github.com/black7375)! - - `defineRules`: Properties and shortcuts

- [#267](https://github.com/mincho-js/mincho/pull/267) [`743384f`](https://github.com/mincho-js/mincho/commit/743384fe107bc2ce523f3b1879690e8e81dfdc24) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.fallbackVar()` API

- [#219](https://github.com/mincho-js/mincho/pull/219) [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db) Thanks [@black7375](https://github.com/black7375)! - **Compatibility**
  - Separate vanilla extract API to `./compat` entry point for backward compatibility.

- [#227](https://github.com/mincho-js/mincho/pull/227) [`60ebee5`](https://github.com/mincho-js/mincho/commit/60ebee56170b3b683b72eb721fdd26bfc46ce338) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.with()` API

- [#271](https://github.com/mincho-js/mincho/pull/271) [`50145b3`](https://github.com/mincho-js/mincho/commit/50145b3eca703e9884113b58eecd0c6ecb8631d3) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.raw()` API

- [#242](https://github.com/mincho-js/mincho/pull/242) [`aafcd1c`](https://github.com/mincho-js/mincho/commit/aafcd1c4380d6778f7ee1864c08a56f46944ae91) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `rules.with()` API

- [#273](https://github.com/mincho-js/mincho/pull/273) [`1bb5010`](https://github.com/mincho-js/mincho/commit/1bb50106844d162d26f1f470ef0cae0565461708) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **rules - compat**
  - Add `recipe` in the compat layer.
  - Separate `rules` implementation to `compat-impl.ts` to support compound object variants in `recipe`.

- [#246](https://github.com/mincho-js/mincho/pull/246) [`d9445d5`](https://github.com/mincho-js/mincho/commit/d9445d541aae580053755bfc3a5f9e07620241d0) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `selector()` utility for computed property names

- [#272](https://github.com/mincho-js/mincho/pull/272) [`4a185b4`](https://github.com/mincho-js/mincho/commit/4a185b470a8d24ecc6badcb46ea4c0408e486a07) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.fallbackVar()` API

- [#265](https://github.com/mincho-js/mincho/pull/265) [`6482954`](https://github.com/mincho-js/mincho/commit/6482954eb32b6a69037d45ba1f4f0da5b80a411c) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` base usage and reference variables

- [#232](https://github.com/mincho-js/mincho/pull/232) [`c268326`](https://github.com/mincho-js/mincho/commit/c268326ae498f7c2d1f0504d517fd4d340a1169f) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `rules.raw()` API

- [#222](https://github.com/mincho-js/mincho/pull/222) [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.multiple()` API

- [#308](https://github.com/mincho-js/mincho/pull/308) [`d601036`](https://github.com/mincho-js/mincho/commit/d60103698a0cfe301d13a972de1d2ffdcc024fd2) Thanks [@black7375](https://github.com/black7375)! - - `defineRules` - functional properties and shortcuts

- [#176](https://github.com/mincho-js/mincho/pull/176) [`6f7b980`](https://github.com/mincho-js/mincho/commit/6f7b9801c216a3ae4d7a2359a78bbad6427aa63b) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **rules**
  - Add `rules.multiple()` API

- [#273](https://github.com/mincho-js/mincho/pull/273) [`ba7f2b6`](https://github.com/mincho-js/mincho/commit/ba7f2b608a402a457be00d39c6f1fb6931c80cb4) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **css - compat**
  - Add `styleVariants` in the compat layer.
  - Separate `css.multiple` implementation to `compat-impl.ts` to support mapping callback in `styleVariants`.

- [#343](https://github.com/mincho-js/mincho/pull/343) [`fe2a589`](https://github.com/mincho-js/mincho/commit/fe2a58979df78473a2b2f8e203f022d21b787076) Thanks [@black7375](https://github.com/black7375)! - Add defineRules.propertyValues for sharing property definitions across CSS properties.

### Patch Changes

- [#209](https://github.com/mincho-js/mincho/pull/209) [`df91f14`](https://github.com/mincho-js/mincho/commit/df91f148cf4c0db6a19f544fb993943cc1f50a70) Thanks [@black7375](https://github.com/black7375)! - **Types**
  - Add `VariantStyle` type for constrained variant styles
  - Allow nested selector in `globalCss` function

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- [#252](https://github.com/mincho-js/mincho/pull/252) [`089a50c`](https://github.com/mincho-js/mincho/commit/089a50c45d6807f6705acdf1165700fbb0dd7b14) Thanks [@black7375](https://github.com/black7375)! - **export**
  - `PropDefinitionOutput` type
- Updated dependencies [[`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01), [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189), [`0b49f8a`](https://github.com/mincho-js/mincho/commit/0b49f8a4a617273bd300879ab930d2303e53192d)]:
  - @mincho-js/transform-to-vanilla@1.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`1c89ca9`](https://github.com/mincho-js/mincho/commit/1c89ca943c9d1495230145d47cf810d820aeddbb)]:
  - @mincho-js/transform-to-vanilla@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`98a9c93`](https://github.com/mincho-js/mincho/commit/98a9c9335f84407717cd5fd7d62ce6c6070af284)]:
  - @mincho-js/transform-to-vanilla@0.2.1

## 0.2.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

### Patch Changes

- Updated dependencies [[`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98)]:
  - @mincho-js/transform-to-vanilla@0.2.0

## 0.1.0

### Minor Changes

- [#164](https://github.com/mincho-js/mincho/pull/164) [`69b3b39`](https://github.com/mincho-js/mincho/commit/69b3b3990e3507da43ee68058a2d02ee28aef26a) Thanks [@black7375](https://github.com/black7375)! - Support `rules` known as variants

### Patch Changes

- [#167](https://github.com/mincho-js/mincho/pull/167) [`8cb8a01`](https://github.com/mincho-js/mincho/commit/8cb8a01e378ade3a881098e65f57509eaef0c8c2) Thanks [@dependabot](https://github.com/apps/dependabot)! - update dependencies

- Updated dependencies [[`69b3b39`](https://github.com/mincho-js/mincho/commit/69b3b3990e3507da43ee68058a2d02ee28aef26a)]:
  - @mincho-js/transform-to-vanilla@0.1.0

## 0.0.4

### Patch Changes

- [#116](https://github.com/mincho-js/mincho/pull/116) [`9d5f878`](https://github.com/mincho-js/mincho/commit/9d5f878754e216b21fa233e215b25523c822a9a7) Thanks [@black7375](https://github.com/black7375)! - Variant features

- Updated dependencies [[`9d5f878`](https://github.com/mincho-js/mincho/commit/9d5f878754e216b21fa233e215b25523c822a9a7)]:
  - @mincho-js/transform-to-vanilla@0.0.3

## 0.0.3

### Patch Changes

- [#84](https://github.com/mincho-js/mincho/pull/84) [`747fc29`](https://github.com/mincho-js/mincho/commit/747fc29ef35ad113981bb31ac2e7617dc280d05b) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - Edit logo image raw path

## 0.0.2

### Patch Changes

- [#66](https://github.com/mincho-js/mincho/pull/66) [`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f) Thanks [@black7375](https://github.com/black7375)! - First released

- Updated dependencies [[`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f)]:
  - @mincho-js/transform-to-vanilla@0.0.2

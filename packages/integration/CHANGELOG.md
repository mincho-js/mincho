# @mincho-js/integration

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

- [#344](https://github.com/mincho-js/mincho/pull/344) [`06d761b`](https://github.com/mincho-js/mincho/commit/06d761b260f6fc5610cef26e76b11de661e41d64) Thanks [@black7375](https://github.com/black7375)! - Add optional React JSX `css` prop v2 support through scoped React JSX runtime exports and opt-in `jsxCssProp` transform, integration, Vite, and Esbuild options. Inline object `css` props compile through Mincho CSS-rule extraction, existing class values compile through `cx(...)`, and custom/member/custom-element targets rely on a `className` forwarding contract with runtime guards for missed transforms.

### Patch Changes

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- Updated dependencies [[`7396e4f`](https://github.com/mincho-js/mincho/commit/7396e4f8870b0959bb1ae99e279f3544def0180f), [`743384f`](https://github.com/mincho-js/mincho/commit/743384fe107bc2ce523f3b1879690e8e81dfdc24), [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db), [`60ebee5`](https://github.com/mincho-js/mincho/commit/60ebee56170b3b683b72eb721fdd26bfc46ce338), [`06d761b`](https://github.com/mincho-js/mincho/commit/06d761b260f6fc5610cef26e76b11de661e41d64), [`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01), [`50145b3`](https://github.com/mincho-js/mincho/commit/50145b3eca703e9884113b58eecd0c6ecb8631d3), [`aafcd1c`](https://github.com/mincho-js/mincho/commit/aafcd1c4380d6778f7ee1864c08a56f46944ae91), [`1bb5010`](https://github.com/mincho-js/mincho/commit/1bb50106844d162d26f1f470ef0cae0565461708), [`b12ac31`](https://github.com/mincho-js/mincho/commit/b12ac31339685b06b938fc3788718a6607d8c213), [`d9445d5`](https://github.com/mincho-js/mincho/commit/d9445d541aae580053755bfc3a5f9e07620241d0), [`4a185b4`](https://github.com/mincho-js/mincho/commit/4a185b470a8d24ecc6badcb46ea4c0408e486a07), [`6482954`](https://github.com/mincho-js/mincho/commit/6482954eb32b6a69037d45ba1f4f0da5b80a411c), [`c268326`](https://github.com/mincho-js/mincho/commit/c268326ae498f7c2d1f0504d517fd4d340a1169f), [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8), [`df91f14`](https://github.com/mincho-js/mincho/commit/df91f148cf4c0db6a19f544fb993943cc1f50a70), [`d601036`](https://github.com/mincho-js/mincho/commit/d60103698a0cfe301d13a972de1d2ffdcc024fd2), [`6f7b980`](https://github.com/mincho-js/mincho/commit/6f7b9801c216a3ae4d7a2359a78bbad6427aa63b), [`4504956`](https://github.com/mincho-js/mincho/commit/4504956736658a23a6f0a5d9510bf066a43e614c), [`ba7f2b6`](https://github.com/mincho-js/mincho/commit/ba7f2b608a402a457be00d39c6f1fb6931c80cb4), [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189), [`fe2a589`](https://github.com/mincho-js/mincho/commit/fe2a58979df78473a2b2f8e203f022d21b787076), [`089a50c`](https://github.com/mincho-js/mincho/commit/089a50c45d6807f6705acdf1165700fbb0dd7b14)]:
  - @mincho-js/css@1.0.0
  - @mincho-js/babel@1.0.0

## 0.1.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

### Patch Changes

- Updated dependencies [[`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98)]:
  - @mincho-js/babel@0.1.0

# @mincho-js/babel

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

- [#219](https://github.com/mincho-js/mincho/pull/219) [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db) Thanks [@black7375](https://github.com/black7375)! - **Compatibility**
  - Separate vanilla extract API to `./compat` entry point for backward compatibility.

- [#344](https://github.com/mincho-js/mincho/pull/344) [`06d761b`](https://github.com/mincho-js/mincho/commit/06d761b260f6fc5610cef26e76b11de661e41d64) Thanks [@black7375](https://github.com/black7375)! - Add optional React JSX `css` prop v2 support through scoped React JSX runtime exports and opt-in `jsxCssProp` transform, integration, Vite, and Esbuild options. Inline object `css` props compile through Mincho CSS-rule extraction, existing class values compile through `cx(...)`, and custom/member/custom-element targets rely on a `className` forwarding contract with runtime guards for missed transforms.

- [#222](https://github.com/mincho-js/mincho/pull/222) [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.multiple()` API

- [#275](https://github.com/mincho-js/mincho/pull/275) [`4504956`](https://github.com/mincho-js/mincho/commit/4504956736658a23a6f0a5d9510bf066a43e614c) Thanks [@black7375](https://github.com/black7375)! - **styled**
  - Add `styled.div` like shorthand API

### Patch Changes

- [#358](https://github.com/mincho-js/mincho/pull/358) [`b12ac31`](https://github.com/mincho-js/mincho/commit/b12ac31339685b06b938fc3788718a6607d8c213) Thanks [@black7375](https://github.com/black7375)! - Support nested explicit JSX `css` prop spread aggregation and additional static CSS evaluation patterns.

  Nested explicit JSX `css` prop spread aggregation now lowers safely outside direct statement-list positions, while direct return and expression-statement cases keep their existing hoisted behavior. Static evaluation now also supports static computed keys, optional members on proven values, supported primitive template interpolation, and deterministic CommonJS paths. The React README and site docs were updated to describe the new support and remaining guardrails.

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- Updated dependencies [[`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01)]:
  - @mincho-js/transform-runtime@1.0.0

## 0.1.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

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

- [#409](https://github.com/mincho-js/mincho/pull/409) [`41124c2`](https://github.com/mincho-js/mincho/commit/41124c2072d39a87acd5e6feb55018755fb90227) Thanks [@black7375](https://github.com/black7375)! - Support CommonJS style-call extraction, local factory protection and verified
  compiler re-exports. Resolve import and require conditions independently and
  normalize supported CommonJS sources for Vite builds, development, SSR and HMR.
  Preserve ignore comments and report ambiguous registered calls explicitly.

- [#410](https://github.com/mincho-js/mincho/pull/410) [`d53331e`](https://github.com/mincho-js/mincho/commit/d53331e16e5793b726b8297607a38d8e700c5165) Thanks [@black7375](https://github.com/black7375)! - Add opt-in compilation diagnostics, JSON reports and Chrome trace output to the build integrations.

- [#406](https://github.com/mincho-js/mincho/pull/406) [`4b5c613`](https://github.com/mincho-js/mincho/commit/4b5c61373d891e7fcaa3b97af501f689eb2d8fe2) Thanks [@black7375](https://github.com/black7375)! - Add declarative extractCalls registrations for package exports and root-relative
  local style factories. Protect local implementations and reachable helpers from
  independent extraction, retain mincho-js-ignore behavior, and track dependencies
  for rebuilds and HMR without treating custom calls as read-only.

- [#344](https://github.com/mincho-js/mincho/pull/344) [`06d761b`](https://github.com/mincho-js/mincho/commit/06d761b260f6fc5610cef26e76b11de661e41d64) Thanks [@black7375](https://github.com/black7375)! - Add optional React JSX `css` prop v2 support through scoped React JSX runtime exports and opt-in `jsxCssProp` transform, integration, Vite, and Esbuild options. Inline object `css` props compile through Mincho CSS-rule extraction, existing class values compile through `cx(...)`, and custom/member/custom-element targets rely on a `className` forwarding contract with runtime guards for missed transforms.

- [#222](https://github.com/mincho-js/mincho/pull/222) [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.multiple()` API

- [#275](https://github.com/mincho-js/mincho/pull/275) [`4504956`](https://github.com/mincho-js/mincho/commit/4504956736658a23a6f0a5d9510bf066a43e614c) Thanks [@black7375](https://github.com/black7375)! - **styled**
  - Add `styled.div` like shorthand API

- [#406](https://github.com/mincho-js/mincho/pull/406) [`eaf9fe1`](https://github.com/mincho-js/mincho/commit/eaf9fe1f97a06f974982559aa43691d4eaf2df58) Thanks [@black7375](https://github.com/black7375)! - Extract vanilla-extract CSS definitions, Recipes and Sprinkles factories into
  Mincho CSS sidecars from ordinary source files. Match APIs by their import
  source, support Mincho compatibility exports and preserve dynamic runtime APIs.
  Verify mixed styles and serialized runtime functions in esbuild and Vite builds.

### Patch Changes

- [#405](https://github.com/mincho-js/mincho/pull/405) [`d59d917`](https://github.com/mincho-js/mincho/commit/d59d917b3bbd15344dc2174cb7f6617bd808b5db) Thanks [@black7375](https://github.com/black7375)! - Separate compiler analysis, code generation, source-provider adapters and CSS
  state into focused modules. Share caller-based module resolution, native loader
  inference and static-evaluation metadata helpers across build integrations while
  preserving generated JavaScript, CSS ownership and package entry points.

- [#358](https://github.com/mincho-js/mincho/pull/358) [`b12ac31`](https://github.com/mincho-js/mincho/commit/b12ac31339685b06b938fc3788718a6607d8c213) Thanks [@black7375](https://github.com/black7375)! - Support nested explicit JSX `css` prop spread aggregation and additional static CSS evaluation patterns.

  Nested explicit JSX `css` prop spread aggregation now lowers safely outside direct statement-list positions, while direct return and expression-statement cases keep their existing hoisted behavior. Static evaluation now also supports static computed keys, optional members on proven values, supported primitive template interpolation, and deterministic CommonJS paths. The React README and site docs were updated to describe the new support and remaining guardrails.

- [#427](https://github.com/mincho-js/mincho/pull/427) [`994d28b`](https://github.com/mincho-js/mincho/commit/994d28b3328834a4d05fd67f79c29ce75b0cf21c) Thanks [@black7375](https://github.com/black7375)! - Expose a pure ESM/CommonJS `@mincho-js/css/classname` entry and isolate recipe and
  scoped class runtime modules so unused generated helpers can be removed without
  dropping CSS authoring or registry effects. Babel imports generated class merging
  from the classname entry and removes unused compiler-owned imports. Babel
  requires the matching CSS release as a peer dependency so generated imports
  resolve the new runtime subpath. Update the CSS package alongside Babel.

- [#388](https://github.com/mincho-js/mincho/pull/388) [`8f5d1dd`](https://github.com/mincho-js/mincho/commit/8f5d1dd118ee50bc84519181a2a95d0025f8f9b3) Thanks [@black7375](https://github.com/black7375)! - Harden static extraction, dependency loader composition, and asset handling. Preserve the existing fallback when a static CSS prepass reaches its owner traversal limits, independently of per-literal evaluation limits.

  Keep source, file scope, and dependency metadata through Vite/esbuild transformations and declare the dependencies required by strict package managers.

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- [#411](https://github.com/mincho-js/mincho/pull/411) [`1de80d1`](https://github.com/mincho-js/mincho/commit/1de80d182d5f275ce6674c181e0e06d139809f18) Thanks [@black7375](https://github.com/black7375)! - Reuse validated compiler inputs, immutable source analysis and transform results
  within bounded memory caches. Replay native build assets and publish current CSS
  transactionally while preserving dependency invalidation and error recovery.
- Updated dependencies [[`7396e4f`](https://github.com/mincho-js/mincho/commit/7396e4f8870b0959bb1ae99e279f3544def0180f), [`743384f`](https://github.com/mincho-js/mincho/commit/743384fe107bc2ce523f3b1879690e8e81dfdc24), [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db), [`60ebee5`](https://github.com/mincho-js/mincho/commit/60ebee56170b3b683b72eb721fdd26bfc46ce338), [`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01), [`50145b3`](https://github.com/mincho-js/mincho/commit/50145b3eca703e9884113b58eecd0c6ecb8631d3), [`aafcd1c`](https://github.com/mincho-js/mincho/commit/aafcd1c4380d6778f7ee1864c08a56f46944ae91), [`1bb5010`](https://github.com/mincho-js/mincho/commit/1bb50106844d162d26f1f470ef0cae0565461708), [`d9445d5`](https://github.com/mincho-js/mincho/commit/d9445d541aae580053755bfc3a5f9e07620241d0), [`4a185b4`](https://github.com/mincho-js/mincho/commit/4a185b470a8d24ecc6badcb46ea4c0408e486a07), [`6482954`](https://github.com/mincho-js/mincho/commit/6482954eb32b6a69037d45ba1f4f0da5b80a411c), [`c268326`](https://github.com/mincho-js/mincho/commit/c268326ae498f7c2d1f0504d517fd4d340a1169f), [`994d28b`](https://github.com/mincho-js/mincho/commit/994d28b3328834a4d05fd67f79c29ce75b0cf21c), [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8), [`34147d5`](https://github.com/mincho-js/mincho/commit/34147d54057a4b8e89c719a37c9340a2c4fda15b), [`df91f14`](https://github.com/mincho-js/mincho/commit/df91f148cf4c0db6a19f544fb993943cc1f50a70), [`d601036`](https://github.com/mincho-js/mincho/commit/d60103698a0cfe301d13a972de1d2ffdcc024fd2), [`6f7b980`](https://github.com/mincho-js/mincho/commit/6f7b9801c216a3ae4d7a2359a78bbad6427aa63b), [`ba7f2b6`](https://github.com/mincho-js/mincho/commit/ba7f2b608a402a457be00d39c6f1fb6931c80cb4), [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189), [`0ee56d1`](https://github.com/mincho-js/mincho/commit/0ee56d1a3ca772e9aab023b46947ee7e7b415eb9), [`fe2a589`](https://github.com/mincho-js/mincho/commit/fe2a58979df78473a2b2f8e203f022d21b787076), [`089a50c`](https://github.com/mincho-js/mincho/commit/089a50c45d6807f6705acdf1165700fbb0dd7b14)]:
  - @mincho-js/css@1.0.0
  - @mincho-js/transform-runtime@1.0.0

## 0.1.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

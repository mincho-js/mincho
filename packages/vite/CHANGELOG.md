# @mincho-js/vite

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

- [#403](https://github.com/mincho-js/mincho/pull/403) [`367d111`](https://github.com/mincho-js/mincho/commit/367d1117cbdbd1ea81d227e9e524d6bb916ed4dd) Thanks [@black7375](https://github.com/black7375)! - Link library CSS before native JavaScript hashing and source-map composition in a
  single Vite build. Support hashed split CSS, shared and lazy chunks, and fixed
  unsplit CSS through `libraryCss.fileName`. Unsplit library consumers must configure
  this path to match Vite's CSS output; implicit late CSS filename discovery has
  been removed.

  Analyze each entry's package dependency graph in a lazy Node worker by default,
  with `libraryCss.analysis: "inline"` available for hosts that prefer synchronous
  analysis. Preserve stable topological style order, isolate watch generations and
  use ESM/CJS worker entries compatible with strict Yarn PnP through the existing
  compiler-free `@mincho-js/integration/package-graph` API.

### Patch Changes

- [#405](https://github.com/mincho-js/mincho/pull/405) [`d59d917`](https://github.com/mincho-js/mincho/commit/d59d917b3bbd15344dc2174cb7f6617bd808b5db) Thanks [@black7375](https://github.com/black7375)! - Separate compiler analysis, code generation, source-provider adapters and CSS
  state into focused modules. Share caller-based module resolution, native loader
  inference and static-evaluation metadata helpers across build integrations while
  preserving generated JavaScript, CSS ownership and package entry points.

- [#426](https://github.com/mincho-js/mincho/pull/426) [`bcda3c1`](https://github.com/mincho-js/mincho/commit/bcda3c14f39573db5b72c38f4295bd26277756c7) Thanks [@black7375](https://github.com/black7375)! - Enable persistent compilation caches and guarded evaluation reuse by default in
  Vite and esbuild. Missing or unusable cache entries fall back to compilation, and
  unsupported evaluation contexts retain fresh evaluation. Use `cache: false` to
  disable compilation caching, `cache: { type: "memory" }` to avoid disk writes, or
  `execution: { evaluation: "fresh" }` to disable VM and evaluation-result reuse.

- [#422](https://github.com/mincho-js/mincho/pull/422) [`3ef613e`](https://github.com/mincho-js/mincho/commit/3ef613e8849c0bc1400d939f4e577a6a7d61d2ec) Thanks [@black7375](https://github.com/black7375)! - Add opt-in guarded vanilla-extract evaluation through
  `execution.evaluation: "auto"`. Reuse proved contexts and serialized results
  with bounded caches, input validation, independent registry snapshots, and
  fresh evaluation fallbacks. Fresh evaluation remains the default.

- [#402](https://github.com/mincho-js/mincho/pull/402) [`56db6c9`](https://github.com/mincho-js/mincho/commit/56db6c9ea524025a48029534b0e5bb0d6b04eaae) Thanks [@black7375](https://github.com/black7375)! - Build an isolated package graph worker in both ESM and CommonJS formats, with matching inline analysis, generation cancellation, deterministic ordering, and worker cleanup. This provides the internal analysis service for the subsequent native library CSS linker integration.

- [#412](https://github.com/mincho-js/mincho/pull/412) [`2e977e3`](https://github.com/mincho-js/mincho/commit/2e977e32018a92687e93b69ba8ef8a2fb8decb79) Thanks [@black7375](https://github.com/black7375)! - Add an opt-in filesystem compilation cache with validated process restart reuse,
  CSS and asset replay, and atomic coalesced writes. Keep memory-only caching as the
  default and expose the shared cache options through the bundler integrations.

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- [`916b031`](https://github.com/mincho-js/mincho/commit/916b0314e6ca73430382b0ac2971178f674c4954) Thanks [@black7375](https://github.com/black7375)! - Add opt-in compiler workers and bounded filesystem scheduling with shared CPU
  budgets, generation cancellation and bounded source transport reuse. Expose
  execution settings in Vite and esbuild while keeping compiler transforms inline
  by default, and select Vite graph execution according to payload size and budget.

- [#411](https://github.com/mincho-js/mincho/pull/411) [`1de80d1`](https://github.com/mincho-js/mincho/commit/1de80d182d5f275ce6674c181e0e06d139809f18) Thanks [@black7375](https://github.com/black7375)! - Reuse validated compiler inputs, immutable source analysis and transform results
  within bounded memory caches. Replay native build assets and publish current CSS
  transactionally while preserving dependency invalidation and error recovery.

- [#406](https://github.com/mincho-js/mincho/pull/406) [`eaf9fe1`](https://github.com/mincho-js/mincho/commit/eaf9fe1f97a06f974982559aa43691d4eaf2df58) Thanks [@black7375](https://github.com/black7375)! - Extract vanilla-extract CSS definitions, Recipes and Sprinkles factories into
  Mincho CSS sidecars from ordinary source files. Match APIs by their import
  source, support Mincho compatibility exports and preserve dynamic runtime APIs.
  Verify mixed styles and serialized runtime functions in esbuild and Vite builds.

- [#403](https://github.com/mincho-js/mincho/pull/403) [`76d6b5d`](https://github.com/mincho-js/mincho/commit/76d6b5d656bd307b88943bfb11cd0e5d9b684f47) Thanks [@black7375](https://github.com/black7375)! - Give Mincho-owned extracted sources private JavaScript virtual module IDs so
  vanilla-extract does not attempt to reload them as physical CSS files. Preserve
  physical compile paths, preset origins, generated classes and relative imports,
  and invalidate both aliases when an owner changes or is removed. Verify ESM/CJS
  coexistence and the packaged CommonJS worker path in npm and strict Yarn PnP.
- Updated dependencies [[`7396e4f`](https://github.com/mincho-js/mincho/commit/7396e4f8870b0959bb1ae99e279f3544def0180f), [`743384f`](https://github.com/mincho-js/mincho/commit/743384fe107bc2ce523f3b1879690e8e81dfdc24), [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db), [`60ebee5`](https://github.com/mincho-js/mincho/commit/60ebee56170b3b683b72eb721fdd26bfc46ce338), [`41124c2`](https://github.com/mincho-js/mincho/commit/41124c2072d39a87acd5e6feb55018755fb90227), [`d53331e`](https://github.com/mincho-js/mincho/commit/d53331e16e5793b726b8297607a38d8e700c5165), [`d59d917`](https://github.com/mincho-js/mincho/commit/d59d917b3bbd15344dc2174cb7f6617bd808b5db), [`bcda3c1`](https://github.com/mincho-js/mincho/commit/bcda3c14f39573db5b72c38f4295bd26277756c7), [`4b5c613`](https://github.com/mincho-js/mincho/commit/4b5c61373d891e7fcaa3b97af501f689eb2d8fe2), [`06d761b`](https://github.com/mincho-js/mincho/commit/06d761b260f6fc5610cef26e76b11de661e41d64), [`81d8ce2`](https://github.com/mincho-js/mincho/commit/81d8ce2bc8b789f1b0744e44d7c70d9a539aaa01), [`50145b3`](https://github.com/mincho-js/mincho/commit/50145b3eca703e9884113b58eecd0c6ecb8631d3), [`aafcd1c`](https://github.com/mincho-js/mincho/commit/aafcd1c4380d6778f7ee1864c08a56f46944ae91), [`1bb5010`](https://github.com/mincho-js/mincho/commit/1bb50106844d162d26f1f470ef0cae0565461708), [`3ef613e`](https://github.com/mincho-js/mincho/commit/3ef613e8849c0bc1400d939f4e577a6a7d61d2ec), [`d9445d5`](https://github.com/mincho-js/mincho/commit/d9445d541aae580053755bfc3a5f9e07620241d0), [`4a185b4`](https://github.com/mincho-js/mincho/commit/4a185b470a8d24ecc6badcb46ea4c0408e486a07), [`9affca1`](https://github.com/mincho-js/mincho/commit/9affca14eb360132f3aafde95fce22e9faf58de2), [`425c6b9`](https://github.com/mincho-js/mincho/commit/425c6b9b71ee15ed6c3facd142fc7b29f29317f4), [`2e977e3`](https://github.com/mincho-js/mincho/commit/2e977e32018a92687e93b69ba8ef8a2fb8decb79), [`6482954`](https://github.com/mincho-js/mincho/commit/6482954eb32b6a69037d45ba1f4f0da5b80a411c), [`c268326`](https://github.com/mincho-js/mincho/commit/c268326ae498f7c2d1f0504d517fd4d340a1169f), [`994d28b`](https://github.com/mincho-js/mincho/commit/994d28b3328834a4d05fd67f79c29ce75b0cf21c), [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8), [`34147d5`](https://github.com/mincho-js/mincho/commit/34147d54057a4b8e89c719a37c9340a2c4fda15b), [`8f5d1dd`](https://github.com/mincho-js/mincho/commit/8f5d1dd118ee50bc84519181a2a95d0025f8f9b3), [`df91f14`](https://github.com/mincho-js/mincho/commit/df91f148cf4c0db6a19f544fb993943cc1f50a70), [`d601036`](https://github.com/mincho-js/mincho/commit/d60103698a0cfe301d13a972de1d2ffdcc024fd2), [`6f7b980`](https://github.com/mincho-js/mincho/commit/6f7b9801c216a3ae4d7a2359a78bbad6427aa63b), [`ba7f2b6`](https://github.com/mincho-js/mincho/commit/ba7f2b608a402a457be00d39c6f1fb6931c80cb4), [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189), [`0ee56d1`](https://github.com/mincho-js/mincho/commit/0ee56d1a3ca772e9aab023b46947ee7e7b415eb9), [`fe2a589`](https://github.com/mincho-js/mincho/commit/fe2a58979df78473a2b2f8e203f022d21b787076), [`916b031`](https://github.com/mincho-js/mincho/commit/916b0314e6ca73430382b0ac2971178f674c4954), [`1de80d1`](https://github.com/mincho-js/mincho/commit/1de80d182d5f275ce6674c181e0e06d139809f18), [`eaf9fe1`](https://github.com/mincho-js/mincho/commit/eaf9fe1f97a06f974982559aa43691d4eaf2df58), [`0b49f8a`](https://github.com/mincho-js/mincho/commit/0b49f8a4a617273bd300879ab930d2303e53192d), [`089a50c`](https://github.com/mincho-js/mincho/commit/089a50c45d6807f6705acdf1165700fbb0dd7b14)]:
  - @mincho-js/css@1.0.0
  - @mincho-js/integration@1.0.0
  - @mincho-js/transform-to-vanilla@1.0.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`1c89ca9`](https://github.com/mincho-js/mincho/commit/1c89ca943c9d1495230145d47cf810d820aeddbb)]:
  - @mincho-js/transform-to-vanilla@0.2.2
  - @mincho-js/css@0.2.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`98a9c93`](https://github.com/mincho-js/mincho/commit/98a9c9335f84407717cd5fd7d62ce6c6070af284)]:
  - @mincho-js/transform-to-vanilla@0.2.1
  - @mincho-js/css@0.2.1

## 0.1.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

### Patch Changes

- Updated dependencies [[`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98)]:
  - @mincho-js/transform-to-vanilla@0.2.0
  - @mincho-js/integration@0.1.0
  - @mincho-js/css@0.2.0

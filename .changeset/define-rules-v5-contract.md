---
"@mincho-js/css": major
"@mincho-js/integration": major
"@mincho-js/esbuild": major
"@mincho-js/babel": major
"@mincho-js/react": major
"@mincho-js/transform-to-vanilla": major
"@mincho-js/transform-runtime": major
"@mincho-js/vite": major
---

**V5 Release: Strict Immutable Graph, Compact Scoped Runtime, and Sidecar Stylesheet Contract**

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

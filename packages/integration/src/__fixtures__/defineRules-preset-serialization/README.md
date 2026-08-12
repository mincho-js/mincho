# defineRules preset serialization fixtures

These fixtures lock the build-time contract for sharing `defineRules` preset output across package boundaries.

## Why generated files are tracked

- `provider-module/dist/esm/index.mjs` and `provider-module/dist/style.css` model the already-built output of a published preset provider.
- `node_modules/@mincho-js-proof/*` directories model consumers importing that published provider through normal package resolution.
- The generated `dist/` files and fake `node_modules` packages are intentionally committed so tests can detect drift in the serialized JS shape, sidecar CSS contract, and package-boundary resolution without depending on a separate publish step.

## Registry contract

The registry fixtures describe what actually executes while the extracted CSS module is evaluated. The eval-executed cases cover helper-wrapped calls, IIFEs, nested functions, imported helpers, const-config values, and multiple live `defineRules(...)` instances. Each one must serialize when the evaluation path invokes it.

`registry-exported-factory-not-executed` is the exported factory boundary. A factory that would call `defineRules(...)` does not serialize a preset artifact until the factory runs during `.css.ts` evaluation.

`registry-function-config-invalid` is the function-valued config boundary. Function-valued `conditions`, `properties`, or `shortcuts` can't be represented in the preset artifact, so public `defineRules(...)` calls with function-valued config are not registered and do not serialize a preset artifact. Their local `css.raw(...)` usage still executes normally.

Serialized preset artifacts use the strict V5 graph shape:

```ts
{
  schema: "mincho.defineRulesPreset",
  version: 5,
  rootNodeId: "<sha256-node-id>",
  nodes: [
    {
      nodeId: "<sha256-node-id>",
      origin: "<package>:<producer-path>#defineRules:<index>",
      contentHash: "<sha256-content-hash>",
      parents: ["<ordered-parent-node-id>"],
      atoms: [
        {
          atomId: "<sha256-atom-id>",
          cacheKey: "<cache-key>",
          className: "<class-name>",
          condition: {
            layer: null,
            supports: null,
            media: null,
            container: null,
            selector: "&"
          },
          property: "<property-name>"
        }
      ]
    }
  ]
}
```

Each node owns only its local atoms. Parent nodes are referenced by ordered node IDs and stay immutable. Child package sidecar CSS must include only rules for the child node's own atoms; parent declarations stay in the parent package's sidecar and are not copied or folded into semantic CSS files.

The package diamond fixtures model A -> B, A -> C, and D -> [B, C] across fake published packages. `[B, C]` selects C's compatible class for the shared atom, `[C, B]` selects B's, and both historical class names remain valid dynamic `cx` inputs.

## V5 Package, Runtime, and Stylesheet Contract

The V5 package contract establishes a strict, high-performance separation between build-time style authoring, runtime class name resolution, and static asset delivery.

### 1. V5 Graph Schema and Resolution

- **Graph Nodes & Immutable Parents**: Presets are structured as content-addressed V5 node graphs where parent-child relationships are immutable. Each node contains a unique `nodeId`, `contentHash`, `parents` array (referenced by ID), and its own local atoms (ordered own atoms).
- **Diamond Dedupe & Traversal**: The resolution engine performs a root-first deterministic traversal (parent-first DFS) with exact diamond node deduplication.
- **Diagnostics & Rejection**: Strict validation enforces origin/content revision errors, class/AtomId conflict errors, and cycle errors (via tri-color DFS cycle diagnostics).
- **Last-Parent / Local-Wins equivalent AtomId Selection**: Conflict resolution resolves compatible classes to their selected `AtomId` using last-parent-wins or local-wins order. There is absolutely no backward compatibility, migration utilities, or fallback parsing for legacy V3/V4/maps formats.

### 2. Package Authoring & Runtime Split

- **App Imports (`.`)**: Application components and consumer entry points import runtime-safe, graph-free compiled helpers directly from the package root `.` (e.g., `import { Button } from "my-pkg"`).
- **Authoring Imports (`./preset`)**: Downstream library authoring in `.css.ts` files imports authoring helpers, types, and preset nodes from the subpath `./preset` (e.g., `import { preset } from "my-pkg/preset"`).
- **Explicit Stylesheet Escape Hatch (`./style.css`)**: Published packages provide sidecar CSS containing only locally owned rules. Consumers or bundlers can import `./style.css` as a full escape hatch, while bundler entry roots automatically resolve and inject sidecar stylesheets relative to entry chunks.

### 3. Compact Dynamic & Static cx Behavior

- **Dynamic Scoped cx**: Dynamic `cx` runtime outputs are optimized to exclude the full V5 graph. They carry only a compact `classWrites` lookup mapping valid classes to internal write IDs, plus optional marker `segments` to handle runtime state.
- **Static cx**: When classes can be statically resolved at build time, `cx` emits static class literals with zero runtime table footprint or hydration overhead.

### 4. Known Caveats & Limitations

- **Unused Rules**: Built package stylesheets contain all defined component rules; pruning unused component declarations is not performed at the asset level.
- **Native Node CSS Loading**: Native Node.js runtimes cannot load `.css.ts` or CSS-importing root exports without a bundler integration.
- **No Per-Export Hydration**: Scoped style hydration is global to the active environment; per-export or partial-hydration models are not implemented.
- **No Semantic Folding**: CSS folding across selectors or layers is not performed; parent declarations are never duplicated or compiled into child stylesheets.
- **No External Overlay / Manifest**: Style resolution and loading do not depend on external manifest JSON, import maps, or overlay registries.

## Regeneration and verification contract

There is no separate generator script for this fixture set. When a fixture source changes, update the matching tracked `dist/` or fake package files in the same change and keep the diff limited to the expected serialized JS/CSS output.

Verify the contract with:

```bash
yarn vitest run "packages/integration/src/defineRulesPreset.ts" -t "registry fixture matrix"
yarn vitest run "packages/vite/src/index.ts" -t "defineRules|preset|fixture|build artifact|real Vite"
yarn vitest run "packages/esbuild/src/index.ts" -t "defineRules|preset|fixture|extracted-css|real esbuild"
```

Expected fixture diffs are limited to:

- class-name changes caused by intentional preset/style changes;
- serialized V5 node, atom, parent, or hash changes that match the source fixture's executed `css(...)` calls;
- sidecar CSS changes required for provider exports consumed through package imports.

Unexpected fixture diffs include removed sidecar imports, missing fake package metadata, or runtime `css({ ... })` calls left where a static class literal should be emitted.

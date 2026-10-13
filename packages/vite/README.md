# @mincho-js/vite

Compile Mincho styles with Vite using the plugin preset:

```ts
import { defineConfig } from "vite";
import { minchoVitePlugins } from "@mincho-js/vite";

export default defineConfig({
  plugins: [...minchoVitePlugins({ jsxCssProp: true })],
});
```

The preset adds automatic JSX runtime guard specialization after JSX lowering.
The compiler redirects an automatically generated runtime call to native React
only when it can prove that the call has no `css` prop. Explicit `jsx`/`jsxDEV`
imports and uncertain props retain the public runtime guard. Production mode
enables `optimize.jsxRuntimeGuards`; development mode disables it. The
`optimizationMode` profile and individual `optimize` overrides control this
behavior. The existing single `minchoVitePlugin` API remains available.

See [compilation performance](../../docs/compilation-performance.md),
[runtime optimizations](../../docs/runtime-optimizations.md),
[vanilla-extract support](../../docs/vanilla-extract.md), and
[additional extraction calls](../../docs/extract-calls.md) for other options.

## Application CSS

Choose CSS distribution and optional route-aware sharing independently:

```ts
export default defineConfig({
  plugins: minchoVitePlugins({
    appCss: {
      mode: "dist-chunk",
      sharing: { minBoundaries: 2, minBytes: 4096 },
      routes: [
        { id: "home", entry: "src/home.tsx", layouts: ["src/layout.tsx"] },
        { id: "admin", entry: "src/admin.tsx", layouts: ["src/layout.tsx"] },
      ],
    },
  }),
});
```

`mode: "native"` (default) preserves Vite configuration. `"single"` requests
one sheet. `"dist-chunk"` collects raw Mincho rules during evaluation and generates
CSS from style markers in each final output chunk, following UnoCSS's chunk-stage
model. It preserves file/cascade order and uses native Vite processing for
PostCSS, URL assets, lazy preloads, hashes, HTML and manifests. It does not purge
selectors or merge unrelated rules. Conflicting explicit `build.cssCodeSplit`
settings are errors. Development serving, library builds and SSR are unchanged.

The private adapter currently requires Vite **7.3.3**, vanilla-extract integration
**8.0.10** and CSS **1.20.1**. Unsupported versions, Lightning CSS transformation,
or opaque third-party CSS transforms fail explicitly; use `native` for those
toolchains. Native PostCSS is supported, and JS-only plugins can declare a
CSS-excluding `transform.filter.id`.

The generic route list includes each route's entry and ancestor layouts. Paths
are relative to the Vite root or exact ids in the built graph. With this list,
sharing thresholds count distinct routes that statically use the candidate CSS;
nested dynamic imports retain their own boundaries. Without it, thresholds count
native entries and dynamic import targets. Routes do not create lazy JS imports
or load missing layouts; the router owns those dependencies. Missing route
modules skip sharing with a diagnostic.

Sharing is opt-in. Only with sharing enabled, a temporary build-end IR preview
measures eligibility; final CSS is always generated from output chunks. User
`manualChunks` still controls placement. `appCss.sharing` takes precedence over
`experimental.cssChunkSharing`, including `false`. All native consumers must
still agree on the shared prefix's order. This shares whole CSS modules rather
than deduplicating atoms or promoting lazy-only CSS into the initial page. See
[CSS bundling](../../docs/css-bundling.md) for the full contract and measurements.

## Library CSS ownership

Production split libraries link each chunk to its own CSS. Component subpaths
and ESM named imports from a pure barrel in Vite consumers can therefore retain
only the selected components' styles. Native esbuild consumers should use
subpaths: esbuild 0.27.7 retains CSS from unused barrel exports. JavaScript
dependencies provide their own styles first;
shared CSS-only chunks removed by Vite still have their CSS linked.

For multiple ESM/CJS library entries, Mincho defaults `build.cssCodeSplit` to
`true` unless you configure it, select `libraryCss.mode: "entry"`, or declare
`libraryCss.fileName`. Development and explicit entry mode retain entry-wide
aggregation. Use `"chunk"` to request chunk ownership explicitly. Mark published
CSS as side effects (`"sideEffects": ["**/*.css"]`) and expose component subpaths.
Single CSS builds still require a fixed `libraryCss.fileName` matching Vite's
output. See [CSS bundling](../../docs/css-bundling.md) for examples and measurements.

## Experimental CSS sharing

Application builds can share an identical prefix of whole CSS modules across
entries and dynamic import boundaries. Sharing is disabled by default:

```ts
export default defineConfig({
  plugins: minchoVitePlugins({
    experimental: {
      cssChunkSharing: { minBoundaries: 2, minBytes: 4096 },
    },
  }),
});
```

`cssChunkSharing: true` uses the same thresholds. Vite owns CSS extraction,
asset URLs, source maps, content hashes, HTML links, manifest data and dynamic
import preloading. Shared CSS precedes each boundary's private CSS, and styles
used only by lazy modules remain lazy. Consume Vite's normal HTML or manifest;
there is no separate Mincho CSS manifest or browser style insertion runtime.

Sharing can reduce combined CSS transfers when several boundaries are visited,
at the cost of an additional stylesheet request and build analysis. Only
class-owned CSS with an agreed module order is eligible. Global rules, custom
`manualChunks`, library/SSR builds, disabled CSS splitting and opaque CSS
transforms keep the native layout. A custom transform is allowed only when its
declared regular-expression hook filter excludes the build's CSS modules.
Plugin names alone do not establish that proof. React's production plugin
without a transform hook does not disable sharing. Native Vite splitting remains
the default: an extra shared chunk can increase compressed JavaScript without
reducing CSS.

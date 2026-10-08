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
transforms keep the native layout. A custom transform plugin, including a React
plugin whose CSS behavior cannot be proven, also disables sharing. This first
version favors preserving native CSS semantics over speculative sharing.

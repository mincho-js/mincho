# @mincho-js/esbuild

Use `minchoEsbuildPlugins()` to compile Mincho styles with esbuild. Set
`jsxCssProp: true` to enable the JSX `css` prop.

Calls from vanilla-extract CSS, Recipes and Sprinkles can also live in ordinary
source files and are extracted into CSS sidecars. See the
[supported APIs and runtime behavior](../../docs/vanilla-extract.md).
Additional package and local style factories can be registered with
[`extractCalls`](../../docs/extract-calls.md).

The default `optimizationMode: "production"` enables `pureFunctions`,
`staticRecipes`, `styledComponents`, and `runtimeCodegen`. Use
`optimizationMode: "development"` for faster watch transforms; it keeps
`pureFunctions` enabled and disables the other three switches by default.
Individual `optimize` switches override the profile. See
[compilation performance](../../docs/compilation-performance.md) for defaults,
cache behavior and the benchmark harness.
The [runtime optimization guide](../../docs/runtime-optimizations.md) covers
canonical recipe order, generated helpers and the experimental runtime options.

With `jsx: "automatic"` and `jsxImportSource: "@mincho-js/react"`, production
builds use React's native JSX runtime for modules whose final JSX props are
proven to contain no `css` property. Explicit imports or `require()` calls of
Mincho's public JSX runtimes retain their guards. Unknown spreads and remaining
`css` props also retain the guards. Set `optimize.jsxRuntimeGuards: false` to
disable this optimization, or `true` to enable it in the development profile.

```ts
import { build } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

await build({
  entryPoints: ["src/app.tsx"],
  bundle: true,
  outdir: "dist",
  loader: { ".png": "file", ".svg": "dataurl" },
  assetNames: "assets/[name]-[hash]",
  publicPath: "/static",
  plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
});
```

Static `?url` imports use the configured native `file` or `dataurl` loader.
The resulting value respects esbuild's `publicPath`, `assetNames`, output
directory and `outbase`. Assets referenced only by styles are included in
`outputFiles` when `write: false`, and written to the output directory when
`write: true`. They are also included in the metafile and watched for changes.

In both `css()` and JSX `css` styles, a CSS `url(...)` expression is resolved
from the original asset so esbuild can calculate its path relative to the CSS
output. A plain string, including a CSS custom property value, keeps the native
JavaScript loader's URL. `?raw` imports evaluate to the file's text contents.

Without `publicPath`, a native file URL can differ between entry and chunk
output directories. Mincho accepts an imported static file URL when those
directories produce the same string, including a single nested entry or code
splitting into the same directory. When the values differ, the build reports an
error asking for `publicPath` or a `dataurl` loader. This check also applies when
the imported value is later wrapped in `url(...)`; it is evaluated before
esbuild assigns modules to output files. CSS `url(...)` references written
directly in CSS continue to use esbuild's native processing.

This asset support applies to files handled by native esbuild loaders.
Assets provided by another plugin's virtual namespace need that plugin's own
static evaluation integration.

## Build transactions and package CSS order

`buildWithMincho` is an opt-in, one-shot bundling API. It analyzes native CSS
output ownership, combines preset package dependency graphs for each CSS output,
and adds ordered imports before native linking. Existing
`minchoEsbuildPlugins` calls continue to order each registry's imports; they do
not provide cross-module ordering.

```ts
import { buildWithMincho } from "@mincho-js/esbuild";

await buildWithMincho({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  format: "esm",
  splitting: true,
  tsconfig: "tsconfig.json",
  loader: { ".component": "tsx" },
  plugins: (phase) => [createSourcePlugin()],
});
```

Both phases use `write: false`. Input bytes, resolved module identities and
package graphs must stay stable. The API publishes native output bytes only
after validation, or returns them for `write: false`. Changed inputs require a
new build; there is no automatic retry. A failed transaction cannot populate the
next build's snapshot.

Each output is written to a temporary file in its destination directory, then
renamed into place so readers see a complete file. Existing file permissions
are preserved during both publication and rollback.
If writing an output fails, the API restores touched existing files and removes
newly written files, and reports published paths and any rollback failures.
This recovery is not a filesystem-wide atomic publication; empty directories
may remain after failure.

The plugin factory receives `"analyze"` and `"emit"` and must return fresh plugins
with equivalent resolution and transformation behavior. Exclude publishing
hooks and other external side effects from analysis: esbuild's `write: false`
does not prevent a third-party plugin from writing files itself. Two native
build passes add processing cost; this API does not promise transform reuse.

The snapshot covers Mincho-owned source, child-compilation and asset reads,
plugin load results and resolved identities, reported `watchFiles`, local input
source maps, the explicit `tsconfig`, and package/tsconfig/PnP configuration on
loaded files' ancestor paths. It does not discover arbitrary private plugin
reads or transitive `tsconfig` extensions outside those paths. Keep those inputs
stable between phases and report additional file dependencies in `watchFiles`.
If Babel cannot parse an input that needs no CSS prelude, esbuild handles it
unchanged. The snapshot cannot observe external source maps on that fallback
path; report them in `watchFiles` if they require validation.
Source insertion preserves the original loader and TypeScript/JSX syntax; native
esbuild still applies the requested compiler settings.

Sorting follows each actual native CSS bundle, including dynamic descendants
that esbuild already places in an entry CSS file. It does not combine unrelated
CSS outputs or control the loading order of independent stylesheets. Ambiguous
CSS ownership and package dependency cycles fail before publication. Preset
node graphs retain their existing atom precedence and validity rules.
Package `style.css` files must contain local styles. Import ancestor package CSS
through JavaScript; CSS `@import` between managed packages, including through
intermediate CSS files, fails before publication because native CSS import
ordering can override the JavaScript prelude. Imports of a package's own CSS
fragments remain supported.

## Experimental CSS sharing

`buildWithMincho` can emit a shared stylesheet for an identical prefix of whole
CSS modules used by multiple entries. Production builds with an output path
enable sharing by default, requiring at least two boundaries and 4,096 source
bytes. Development builds disable it. Set `experimental.cssChunkSharing: false`
to retain native output, or override the thresholds explicitly:

```ts
const result = await buildWithMincho({
  entryPoints: ["src/account.ts", "src/settings.ts"],
  outdir: "dist",
  metafile: true,
  mincho: {
    experimental: {
      cssChunkSharing: { minBoundaries: 2, minBytes: 4096 },
    },
  },
});

// Use this ordered list when generating HTML or rendering on the server.
const stylesheets = result.minchoCssManifest?.entries["account.js"]?.css;
```

The same data is written to `mincho-css-manifest.json`. Paths are relative to
the output directory. Load the entry's `css` array in order: shared CSS first,
then private CSS. The original native `cssBundle` is retained as
`fallbackCssBundle` for integrations that do not consume this manifest. Use
either the ordered array or the fallback stylesheet; loading both duplicates
rules and can change the cascade.

Automatic sharing produces no extra CSS or manifest when no eligible prefix
exists. Explicit `true` or threshold options retain the fallback manifest even
without a shared group. Existing integrations loading the native `cssBundle`
continue to work; transfer savings require consuming the ordered manifest.

This option adds a native CSS-only build from captured inputs after the two
existing passes. User plugins still run only for `analyze` and `emit`; URLs,
source maps and content hashes are produced by esbuild. Additional outputs and
the manifest participate in the same input validation and publication rollback.
Dynamic descendants retain esbuild's existing entry CSS loading boundary.

Sharing trades additional build work and published fallback files for smaller
combined CSS transfers across entries. A first entry may need an extra CSS
request. Global rules, CSS `@import`, unknown plugin provenance, CSS banners and
footers, and conflicting module order keep the native output. Standalone
`minchoEsbuildPlugins` and context/watch builds cannot enable this option.
There is no browser CSS loader or additional lazy CSS boundary. See
[CSS bundling](../../docs/css-bundling.md) for the application/library distinction
and the reproducible benchmark.

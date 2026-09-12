# @mincho-js/esbuild

Use `minchoEsbuildPlugins()` to compile Mincho styles with esbuild. Set
`jsxCssProp: true` to enable the JSX `css` prop.

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

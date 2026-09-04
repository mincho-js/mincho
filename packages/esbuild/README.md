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

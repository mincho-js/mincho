# Package consumer verification

Build the release payloads, then run the isolated consumer checks with the pinned
toolchain:

```sh
mise exec -- yarn build:release
MINCHO_KEEP_PACKAGE_CONTRACT=1 MINCHO_BROWSER_BINARY=/usr/bin/chromium \
  mise exec -- yarn check:package-contract
```

`MINCHO_KEEP_PACKAGE_CONTRACT=1` preserves the reported temporary directory,
tarballs, installed consumers, build artifacts, `css-sizes.json`, and
`real-css-sizes.json`. Without it the directory is removed after verification.
The browser binary is optional; an unset `MINCHO_BROWSER_BINARY` produces an
explicit skipped-browser message. When supplied, Chromium checks computed
styles from the actual native entry CSS output in both build modes.

The same tarballs are installed into separate npm and Yarn 4.18.0 strict PnP
consumers. PnP has no fallback, and a negative undeclared-dependency check runs
alongside ESM/CJS imports and strict declaration checks. The verifier resolves
installed files through the consumer's PnP API without replacing the workspace's
loader. The isolated consumer redirects packed dependency names to their exact
tarballs using Yarn resolutions, including transitive semver requests; published
manifests retain normal version ranges. Packed files must resolve outside the
repository and release payloads must match current `dist` bytes.

The original unminified diamond fixtures remain static decoder and package
contract regressions. Production minification runs separately; a passing
unminified assertion does not establish a compression result.
Both Vite runs retain production mode so changing compression does not switch
Mincho's class names to development identifiers.

`real-producers.ts` also executes the actual `defineRules` API to produce four
packages. A owns one padding Atom, B/C reuse it and independently generate red
Atoms with distinct classes, and D composes both branches. Each `style.css` owns
local rules; its package's JavaScript imports the ancestor CSS first. Every
imported ancestor is declared as a dependency for strict PnP. Runtime exports,
pure authoring presets, and styles have separate subpaths.

The real consumer builds with `buildWithMincho` and Vite, with minification off
and on. It checks both B/C classes, shared ancestor CSS, and the absence of the
authoring graph in runtime JavaScript. It selects the entry stylesheet using
esbuild's metafile or Vite's manifest. The emitted entry must retain its runtime
class exports and the app's local margin rule; Chromium also checks that margin.
An in-memory esbuild probe reads the JS exports with CSS imports ignored, while
the browser separately loads the original stylesheet. Dynamic outputs remain separate; their
bytes are reported individually, and shared selectors across output files are
not treated as a global deduplication failure.

Size reports use raw bytes, gzip level 9, and Brotli quality 11 **per file**.
Compare totals for the same loading scenario, including its required lazy CSS.
The `redRules` count is a measurement of this fixture's native compressor, not a
guarantee that every pair of equal rules can be merged. A tiny file can become
larger after gzip/Brotli despite smaller raw CSS.
esbuild's default Mincho identifiers also change from debug to short with
`minify`; its size difference includes that change and generated comments, not
just declaration merging.

CSS `@import` is a separate ordering mechanism. The first exploratory fixture
used ancestor `@import` in every package stylesheet: Vite repeated ancestor
rules, and esbuild could place an ancestor after a dependent despite a JS
prelude. The package fixture now follows the repository's local-CSS ownership
contract. `buildWithMincho` rejects cross-package CSS imports among the packages
it orders, with direct/indirect import regressions; internal CSS fragments remain
supported. This is a diagnosed boundary of the new API, not a global CSS rewrite.

Browser checks here load the selected CSS explicitly. They do not establish
automatic lazy JavaScript/CSS linking, overlapping condition semantics, or
cross-stylesheet loading order. Vite's source-map, unsplit-hash, and lazy-library
linking prerequisites are tracked separately in
[the native CSS finalization gate](../../docs/vite-css-finalization.md).
`yarn check:vite-native-css-contract` must pass before `yarn publish` proceeds.

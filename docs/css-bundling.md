# CSS bundling

Mincho optimizes module ownership and loading boundaries. It does not infer
selector liveness, purge selectors, or merge equal declarations across unrelated
stylesheets. CSS Modules and cascade layers remain separate scoping and ordering
tools.

## Applications

Vite applications retain native CSS splitting: common styles plus route/feature
CSS reached through dynamic imports. MPA/SSG builds can use separate page entries.
Vite owns HTML links, recursive manifest dependencies, lazy CSS preloading,
asset URLs, hashes and source maps. Production `dist-chunk` builds enable guarded
module-prefix sharing by default; other Vite modes require explicit sharing.
Native output can already share CSS with less JavaScript metadata.

### Vite distribution and route policies

`appCss.mode` explicitly selects the client application's CSS distribution:

| Mode                 | Behavior                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `"native"` (default) | Preserve Vite's `build.cssCodeSplit` configuration.                                                                                 |
| `"single"`           | Request `cssCodeSplit: false`, including lazy styles in one sheet.                                                                  |
| `"dist-chunk"`       | Collect raw Mincho rules, then generate CSS from each final output chunk's style markers. Vite owns CSS assets and lazy preloading. |

Contradictory explicit `build.cssCodeSplit` settings fail with a configuration
error. These modes apply to client application builds; development serving,
libraries and SSR retain their existing behavior. `dist-chunk` follows UnoCSS's
chunk-stage generation model using evaluated rule data instead of utility tokens.
Module evaluation collects ordered vanilla-extract rules, scope, classes and
compositions; its JS output imports empty, side-effectful style markers. No CSS
text is generated during transformation, and no additional flag is required.

Before Vite's CSS output hook, Mincho generates the artifacts selected by actual
`chunk.modules`. Each authoring file remains an ordering barrier among ordinary
CSS imports. URLs and PostCSS resolve from its physical location. Vite then
handles minification, assets, hashes, HTML links, manifests and lazy preloads.
Repeated references to the same artifact are emitted once per chunk; unrelated
equal declarations are not merged. This does not purge selectors or rename
classes, nor promise a CSS file for every JS chunk.

The private adapter is validated against **Vite 7.3.3/7.3.7**, **vanilla-extract
integration 8.0.10/8.0.11** and **vanilla-extract CSS 1.20.1/1.21.3**. Other versions,
missing hooks, Lightning CSS transformation, and opaque third-party CSS transforms fail
explicitly for `dist-chunk`. Vite's PostCSS configuration is supported. JS-only
plugins can declare CSS-excluding regular expressions in `transform.filter.id`.
Use `native` with unsupported toolchains until their adapter contracts are tested.
External CSS output supports ES/CJS formats.

Sharing is configurable and defaults on for production `dist-chunk` builds.
While sharing is enabled, a temporary `buildEnd` IR preview measures bytes and
runs the existing safety classifier; it is never emitted. Final CSS is always generated from actual chunk membership. Unsupported
sharing layouts, including user `manualChunks`, skip additional sharing while
retaining chunk-stage generation. Diagnostics expose `css-ir-preview` and
`css-ir-generate`; setting `appCss.sharing: false` disables the sharing preview.

Evaluation caches store raw IR under a separate key/schema from CSS-text results.
Environment and output state are isolated. Watch builds retain IR for unchanged
cached transforms and replace it when an owner changes.

The distribution mode and sharing policy are independent:

```ts
minchoVitePlugins({
  appCss: {
    mode: "dist-chunk",
    sharing: { minBoundaries: 2, minBytes: 4096 },
    routes: [
      {
        id: "dashboard",
        entry: "src/pages/dashboard.tsx",
        layouts: ["src/layouts/root.tsx", "src/layouts/account.tsx"],
      },
      {
        id: "settings",
        entry: "src/pages/settings.tsx",
        layouts: ["src/layouts/root.tsx", "src/layouts/account.tsx"],
      },
    ],
  },
});
```

`routes` accepts a generic router manifest: stable, unique route ids, route entry
modules, and ancestor layouts from outermost to innermost. Files are relative to
the Vite root, absolute paths, or exact module ids already in the build. All
listed entries/layouts must already be included in the client graph. The plugin
uses Vite's resolved static imports rather than scanning source directories or
guessing framework-specific filenames. Missing or excluded route modules skip
sharing with a diagnostic, preserving the native build.

With a route list, `minBoundaries` counts distinct declared routes whose static
dependencies, including their layouts, contain the **entire** candidate prefix.
Without a route list, it counts native entry/dynamic-import boundaries. A route
alias may have its own id and share an entry with another route; repeating the
same id is an error. An empty list has no eligible routes. `routes` alone does
not enable sharing outside the automatic production `dist-chunk` policy; use
`sharing: true` or its threshold options in other supported modes.

Nested `import()` descendants stop route reach and retain their own loading
boundaries. Two optional widgets within one route do not become two routes for
sharing. All native consumers, including ones absent from the manifest, still
participate in the cascade-order proof. A stylesheet is grouped only when every
consumer agrees on its prefix. Grouping changes neither JS route imports nor
router navigation: eager routes remain eager, and the router must create the
desired lazy boundaries. Shared styles used only by lazy routes remain lazy.

This adopts route/layout reach from devup-ui's design while retaining Mincho's
whole-module ownership model. It does not implement devup-ui's atom-level class
identity, declaration deduplication, or hoisting into a global initial sheet.
Unsupported CSS syntax, custom output layouts and opaque transforms keep the
native layout, as with existing prefix sharing.

`appCss.sharing` takes precedence over the existing
`experimental.cssChunkSharing` option, including explicit `false`. Both use the
same planner. With `diagnostics.json`, `css-sharing` events identify selected
groups and their route ids, or the reason sharing was skipped. The app options
are Vite-only; esbuild's native loading boundary is described below.

### esbuild entry CSS

One-shot esbuild `buildWithMincho` production builds with an output path enable
whole-module prefix sharing at two boundaries and 4,096 source bytes. Explicit
`false` disables it; development and standalone plugin/context/watch APIs keep
native behavior. Automatic sharing emits nothing extra without an eligible
candidate. Explicit `true` or threshold options preserve the existing fallback
manifest contract. Diagnostics report thresholds, selected groups and fallback
reasons through the adapter's existing diagnostics option.

For esbuild shared output, generate HTML/SSR links from the ordered
`minchoCssManifest.entries[outputFile].css` array. Load that list **or** the native
`fallbackCssBundle`, never both. Native fallbacks remain published for consumers
that do not read the manifest. esbuild retains its entry CSS boundary, including
dynamic descendants; this API does not add a browser CSS loader. Sharing can
increase a first page's requests or compressed bytes while decreasing total
transfers across pages. Measure the visit sequence relevant to your app.

## Libraries

Use component or group entries when consumers use only a small part of a library:

```ts
export default {
  plugins: [minchoVitePlugin()],
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        button: "src/button.ts",
        dialog: "src/dialog.ts",
      },
      formats: ["es", "cjs"],
    },
  },
};
```

For multiple ESM/CJS entries, production enables `build.cssCodeSplit` when it is
unspecified. Split production builds default to `libraryCss.mode: "chunk"`:
each executable chunk imports its own CSS, after its JavaScript dependencies.
CSS-only shared chunks removed by Vite still have their stylesheet linked.
Package ancestor styles use the chunk's local module scope and existing stable
dependency order. Pure ESM barrels do not directly import every component's
stylesheet, allowing Vite consumers to discard unused component dependencies.
Mark CSS as side effects and expose the matching package subpaths:

```json
{
  "sideEffects": ["**/*.css"],
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.cjs" },
    "./button": {
      "import": "./dist/button.mjs",
      "require": "./dist/button.cjs"
    },
    "./dialog": {
      "import": "./dist/dialog.mjs",
      "require": "./dist/dialog.cjs"
    }
  }
}
```

Adjust filenames and declarations to the library's actual output. Preserve any
other real side effects in package metadata. Consumers need a CSS-aware bundler;
plain Node cannot execute CSS imports. Native esbuild 0.27.7 still bundles CSS
from unused ESM barrel exports, even when `sideEffects` correctly marks only CSS.
Use component/group subpaths for selective CSS in esbuild. The benchmark records
the named-import over-inclusion instead of claiming those styles were removed.
CJS subpaths are supported, but arbitrary
named-import tree shaking of a CJS barrel is not promised. Group entries trade
some unused component CSS for fewer files. Consumers can rebundle published
sidecars, so producer file counts are not browser request counts.

Explicit `libraryCss.mode: "entry"` retains entry-wide static CSS aggregation.
Development defaults to entry mode and does not change Vite's splitting default.
Explicit `build.cssCodeSplit` and `libraryCss.fileName` always retain the requested
layout. Small libraries can keep one fixed stylesheet with
`cssCodeSplit: false`, `lib.cssFileName: "style"`, and
`libraryCss.fileName: "style.css"`. The filename must match the emitted asset.
See [native finalization](vite-css-finalization.md) for hashes, source maps,
package graphs, multiple outputs and worker contracts.

When all consumers share a toolchain, distributing source styles for consumer
processing remains an option. This change adds no esbuild library producer API
and no automatic rule-level deduplication.

## Reproducible measurements

Build the adapter packages first, then run:

```sh
mise exec -- yarn build
MINCHO_BROWSER_BINARY=/usr/bin/chromium mise exec -- yarn benchmark:css
# Optional subsets and a stable report path:
mise exec -- yarn benchmark:css --cases=library --output=.cache/css-library.json
```

The harness retains fixtures and `report.json` in `.cache/css-benchmark/run-*`.
It compares Vite single/native/dist-chunk/shared/route-aware app CSS, esbuild
native/shared entry CSS, and single/component/group libraries at 1, 3, 6 and 12
used components. Both
ordinary Vite and esbuild consume the library's ESM named and subpath imports.
The installed package contract enforces selective CSS for Vite named imports and
both bundlers' ESM/CJS subpaths in npm and strict PnP consumers. Native esbuild
named imports are observed separately, including their retained unused CSS.

Every JS/CSS file is measured independently with raw bytes, gzip level 9 and
Brotli quality 11. Reports include build time, file counts, initial transfer,
additional route/page transfers, forward/reverse visit sequences and URL cache
reuse. Static manifest dependencies are followed recursively. Lazy JavaScript
is counted at its visit; esbuild's lazy CSS remains in its initial entry bundle.
Fallback CSS and manifest-selected CSS are never counted together. Published
file sizes remain visible separately from transferred bytes.

Duplicate measurements count repeated synthetic module markers across required
CSS files and their occurrence ratio. They do not estimate removable selectors
or declaration bytes. Cold transfer counts assume an empty cache; repeated visits
assume immutable asset URLs. These are deterministic size calculations, not
network latency forecasts.

With `MINCHO_BROWSER_BINARY`, real Chromium loads the emitted HTML and modules
in both route orders, checks computed styles at lazy module evaluation, verifies
repeat-route request reuse, and records requests and resource cache hits. Without
it, the report explicitly marks browser checks skipped. Served bytes are raw;
compression columns are offline estimates. Browser timings are not performance
thresholds.

Application fixtures now generate real Mincho `css()` and `defineRules()` styles
in shared layouts and route style modules, alongside ordinary initial CSS. They
assert output-time generation via diagnostics. SPA fixtures use a map
of route loader functions. During validation with Vite
7.3.3, a ternary containing two dynamic imports was minified into a preload call
with only the second route's CSS dependencies. This reproduced without Mincho;
the benchmark avoids that native Vite case rather than changing its preload
runtime. Route modifiers also have higher specificity than shared rules, since
native Vite can place a shared CSS-only asset after the route asset. Both
loader-map visit orders are checked in Chromium; dependency ordering in library
sidecars has separate regression tests.

### Measured fixture results

September 23, 2026; Node 24.21.0, Vite 7.3.3 and esbuild 0.27.7. All 14
application comparisons passed both size checks and Chromium style/cache checks
using actual Mincho rules. These replace the earlier ordinary-CSS measurements
of the distribution alias. Sizes are per-file Brotli quality 11 sums in bytes;
a session visits both routes/pages and revisits the first.

| Scenario                      | Initial CSS | Session CSS | CSS / JS files | Chunk-stage generations | Build ms |
| ----------------------------- | ----------: | ----------: | -------------: | ----------------------: | -------: |
| Vite SPA, native              |          44 |       1,255 |          4 / 4 |                       0 |    1,811 |
| Vite SPA, dist-chunk          |          44 |       1,255 |          4 / 4 |                       3 |    1,810 |
| Vite SPA, dist-chunk + routes |          44 |       1,255 |          4 / 4 |                       3 |    1,801 |
| Vite MPA, native              |       1,148 |       1,211 |          3 / 3 |                       0 |    1,911 |
| Vite MPA, dist-chunk          |       1,148 |       1,211 |          3 / 3 |                       3 |    1,875 |
| Vite MPA, dist-chunk + routes |       1,148 |       1,211 |          3 / 3 |                       3 |    1,816 |

These rows have no repeated CSS module markers. Session CSS raw/gzip/Brotli
totals are 7,723/2,075/1,255 B for SPA and 7,683/2,017/1,211 B for MPA.
SPA initially requests one CSS file; MPA requests two. Build times are one run
with Mincho caching disabled in a shared Node process, not evidence of a speedup.
The report also records initial/session JS, route transitions and browser cache
hits. Reproduce with `yarn benchmark:css --cases=apps --browser=/usr/bin/chromium`.

Native Vite already shares this fixture's common styles, so actual chunk-stage
generation and optional route sharing do not reduce CSS bytes here. Native
splitting remains the default. In the same run, esbuild MPA sharing reduced
session CSS from 2,207 to 1,211 B, increasing initial CSS from 1,101 to 1,148 B
and adding one initial CSS request. Repeated visits reused CSS in every case.

The unchanged library baseline (September 22, one of twelve components) is
937 B for a single sheet, 869 B for a component subpath and 899 B for a group
subpath. Native esbuild named imports retained all twelve components' styles.
These fixture results are not expected savings for every application or library.

The design uses the render-time metadata approach from
[vite-plugin-lib-inject-css](https://github.com/emosheeep/vite-plugin-lib-inject-css)
(reference checkout `6421eba`) and whole-module/distribution boundaries explored
in [UnoCSS](https://github.com/unocss/unocss) (`93b642097`). Mincho keeps Vite/esbuild
responsible for native asset generation and loading behavior.

## Low-level CSS evaluation: physical scope origins

Application code and the Vite/esbuild plugin options do not change. This section
is for custom integrations that call `compile` and then evaluate its bundled
source. A file scope is identified by its package name and logical `filePath`;
it is not an absolute asset path. Compiler-generated dependency scopes with
the entry's package name share its package root; other names use build-relative
producer paths. Separate installations stay distinct before class generation.
Special path segments are encoded reversibly (for example, `..` becomes
`%2E%2E` and a literal `%` becomes `%25`); these logical identifiers must never
be decoded to locate files. Explicit scope arguments retain their values when
Vanilla Extract's file-scope transform leaves the call untouched. Its first
matching `setFileScope` call may instead receive the generated scope. Relative
assets such as `url("./image.svg")` resolve from the recorded physical producer
directory in either case.

Keep `cssScopeOrigins` with the source returned by `compile`, and pass both to
`processDefineRulesPresetRegistryFile`:

```ts
import {
  compile,
  processDefineRulesPresetRegistryFile,
} from "@mincho-js/integration";

const compiled = await compile({
  cwd: projectRoot,
  filePath: sidecarPath,
  originalPath: componentPath,
  contents: sidecarSource,
  resolverCache: new Map(),
});

const result = await processDefineRulesPresetRegistryFile({
  source: compiled.source,
  cssScopeOrigins: compiled.cssScopeOrigins,
  filePath: sidecarPath,
  cssSourceFile: componentPath,
  cssSourceRoot: projectRoot,
  serializeCssArtifact(artifact) {
    // artifact.origin is the producer path used to resolve relative assets.
    // The custom integration publishes CSS and returns its import specifier.
    const cssSpecifier = publishCssArtifact(artifact);
    return `import ${JSON.stringify(cssSpecifier)};`;
  },
});
```

The internal `processVanillaWithExecution` evaluator accepts the same
`cssScopeOrigins` option; it is not an additional public package entry point.
Mincho's Vite and esbuild adapters forward the metadata automatically. Compile
caches preserve it, and CSS-artifact evaluation cache identities include it.
Keep the source and metadata from the same compilation; do not infer metadata
from source-map contents, filenames, or unrelated watched files.

Each metadata entry includes `{ fileScope: { filePath, packageName }, origin }`.
Compiler-produced entries may also carry an internal runtime registration. Keep
that registration intact and pass the original metadata to the evaluator.
Do not JSON-reconstruct it, modify its source or origin, or transfer it between
separate integration-module instances. These cases fail explicitly; verified
compiler cache and worker results are restored at the compiler boundary.
The registration binds a physical producer to the compiled source; the actual
file-scope calls during evaluation supply the scope arguments. Static scope
hints alone do not authorize an artifact from such a producer.

Registered CSS evaluation exposes CommonJS parent identity as metadata only,
not the parent module's dependency loader. Load authoring dependencies with
normal imports or the stylesheet's own `require`, not `module.parent.require`.

Legacy explicitly supplied entries without a runtime registration remain
valid for matching legacy compiled source. Direct execution with a custom
`require` and metadata-free CSS-text evaluation retain the original file-scope
API behavior, but cannot grant runtime artifact-origin evidence.

Native mode can publish unattributed CSS text in a cache-only virtual module
when CSS AST validation proves it has no resource-dependent or unsupported
syntax, such as a supported plain color or layout declaration. This does not
infer a physical producer or issue a provenance receipt. Relative URLs,
imports, `image-set`, raw/unrecognized syntax, and unsupported values still
require an attributed source; ambiguous known origins are never bypassed.
IR/dist-chunk output continues to require verified physical provenance.
With an unvalidated Vanilla Extract adapter, native evaluation can attach an
origin only when it can independently verify the producer for that scope.
If dynamic authoring prevents verification, CSS text may still be emitted,
but publishing a relative asset requires verified provenance; the host reports
a missing-origin diagnostic rather than resolving it from the wrong directory.

If low-level code mixes compiler-attributed and unattributed emissions in the
same logical file scope, CSS-text output retains their original cascade order
but has no shared physical origin. Native mode therefore accepts only the
resource-independent subset above for that combined scope. A relative asset
in such a mixed scope requires attributable emissions throughout; it cannot
borrow another rule's producer. Ordinary compiler-managed styles keep their
physical origins and asset resolution unchanged.

`origin` is an absolute producer/asset-base path. It is CSS output metadata,
not permission to evaluate a module, proof of purity, or a runtime-source
receipt. For host-generated virtual source, the host must explicitly identify
the matching scope and its intended producer path. The path need not itself be
a readable generated module, but relative assets must have an unambiguous
host-owned base. With compiler-issued runtime origin metadata, if two physical
producers actually emit CSS under the same explicit package/file scope, evaluation
rejects the collision instead of combining their class names, selectors, or
assets. Metadata-free legacy CSS-text evaluation cannot distinguish physical
producers for the same tuple. When the owned evaluator uses legacy CSS-text
metadata, unmatched scopes have no origin and ambiguous metadata is rejected. Merely
opening an empty scope does not claim another producer's CSS. Repeated output
from the same scope and origin remains replaceable.

When `serializeCssArtifact` emits an artifact, matching `cssScopeOrigins` metadata
is required, including owner-only scopes. File existence, package-name equality,
and matching owner-relative paths cannot distinguish two physical instances of
the same package. Missing metadata produces `Missing CSS scope provenance` and
asks the caller to forward `compile().cssScopeOrigins`; no filesystem path is
guessed. Modules that emit no CSS artifacts do not require an origin entry.
CSS-text evaluation without `serializeCssArtifact` retains its existing behavior; custom
CSS-text serializers remain responsible for distinct scope IDs.

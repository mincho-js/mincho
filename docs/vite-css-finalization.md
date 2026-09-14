# Vite library CSS finalization

Mincho links library CSS in `renderChunk`, before Rollup finalizes JavaScript
content hashes and composes source maps. `generateBundle` validates emitted CSS;
it does not rewrite JavaScript or rename assets. One Vite build produces the
library, including shared chunks, dynamic entries, ESM and CJS outputs. No
second application build, filesystem emulator or private hook patch is needed.

## Supported output contracts

With `build.cssCodeSplit: true`, Mincho reads the CSS assets recorded by Vite for
the entry and its static chunk dependencies. Hashed CSS filenames remain owned
by Vite. All chunk CSS render hooks finish before Mincho collects this metadata.
Dynamic entry CSS is linked by that entry, not hoisted into an unrelated root.
Vite's `viteMetadata.importedCss` is version-sensitive; the actual build tests
and release gate cover the installed Vite version. A styled chunk without the
required metadata fails instead of silently losing its CSS.

With `build.cssCodeSplit: false`, Vite determines the combined CSS asset after
JavaScript hashing. Mincho therefore requires an explicit, fixed output-relative
CSS path whenever an entry needs its own CSS:

```ts
import { minchoVitePlugin } from "@mincho-js/vite";

export default {
  plugins: [minchoVitePlugin({ libraryCss: { fileName: "style.css" } })],
  build: {
    cssCodeSplit: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es", "cjs"],
      cssFileName: "style",
    },
  },
};
```

`libraryCss.fileName` declares the expected asset path; it does not change Vite's
asset naming. If `rollupOptions.output.assetFileNames` overrides CSS naming, its
actual CSS output must match this path. Missing or mismatched assets fail at
final validation. The asset must carry Vite's native combined-CSS origin metadata;
an unrelated plugin asset at the same path cannot satisfy this contract. Query strings, parent traversal and `[hash]` placeholders are
rejected. CSS-free libraries and roots that only inherit package CSS do not
need this option. A fixed asset already emitted for another format may be
reused only within the same build generation and output directory.

This changes the former implicit unsplit sidecar behavior: configure matching
fixed names as above, or enable CSS splitting. Arbitrary hashed unsplit CSS
filenames remain unsupported in a single native Vite build. We do not infer a
filename from a callback or patch finalized chunk strings to make that case
appear supported. Applications retain Vite's normal CSS loading behavior;
these sidecar hooks apply to library builds.

## Package dependency analysis

`libraryCss.analysis` accepts `"worker"` (the default) or `"inline"`. The worker
is started lazily when a generated Mincho sidecar supplies a package graph.
Plain CSS builds do not start it. Set `analysis: "inline"` where worker startup
cost outweighs its benefit, or where the host does not provide Node workers.

The main build resolves modules and validates V5 presets through the existing
integration pipeline. It sends graph snapshots and actual Vite module identities
to a separate Node worker while transforms proceed. Once output roots are
known, each root requests the graph of its static dependency scope and awaits
the ordered style imports before its final chunk is returned. Independent
outputs and dynamic roots are not merged into a global graph. The worker does
not resolve modules, evaluate authoring code or run another Vite build.

Style imports use the existing stable topological package order, with declared
entry/import order as the tie breaker. Worker completion order cannot choose CSS
order. Preset classes, V5 validation, package CSS ownership and external style
export resolution retain their existing contracts.

Watch builds keep metadata for cached transforms, remove invalidated owners,
and register a new analysis generation. Results from older generations are
rejected; closing a build or watcher disposes the worker and cancels pending
render barriers. The worker inherits the host Node/PnP loader configuration.
The lightweight `@mincho-js/integration/package-graph` subpath exposes the same
package graph operations without loading compilers or registry runtimes.

Worker execution is not a speed guarantee: structured cloning, startup and the
final scope join have costs. Compare cold and warm wall time, peak memory and
serialized graph bytes against `analysis: "inline"` for representative projects.
The application transform count remains one in both modes.

An initial shared-host measurement on Node 24.21.0 used synthetic linear package
chains, one registered graph per client, and five samples per measurement:

| Packages / edges | Serialized graph | Inline first / reused | Worker first / reused |
| ---------------- | ---------------: | --------------------: | --------------------: |
| 1,000 / 999      |        358,893 B |       10.02 / 3.66 ms |      309.71 / 9.34 ms |
| 5,000 / 4,999    |      1,830,891 B |      41.16 / 12.90 ms |     381.68 / 62.78 ms |

Values are medians. First analysis covers registration through the first result,
including worker startup and graph transfer. Reused analysis queries the same
registered graph without registering it again. Input construction, V5 parsing
and hash validation, cleanup, RSS and the full Vite build are outside this
measurement. These are cost observations, not regression thresholds or evidence
that a worker makes the complete build faster. For these graph sizes, inline
analysis had lower request latency; worker overlap and main-thread responsiveness
need separate application measurements.

## Verification and release gate

`yarn check:vite-native-css-contract` is a required, passing release gate. It
checks native JS hashes, composed source maps and lazy CSS links for ESM/CJS,
using hashed split CSS and explicit fixed unsplit CSS. These cases are ordinary
assertions, not expected failures.

Additional regressions cover shared/static scopes, multiple entries and output
formats, stable ancestor ordering, worker/inline equivalence, worker generations
and termination, fixed-path diagnostics and exact directive placement. Package
contract fixtures run packed ESM/CJS graph exports and native worker builds in
npm and strict Yarn PnP consumers. CSS minification and browser cascade checks
remain in the package-contract suite; declaration merging stays with the final
bundler and does not combine independently loaded CSS files.

The timing boundary follows Rollup's documented
[`renderChunk`](https://rollupjs.org/plugin-development/#renderchunk) lifecycle.
Vite's native library CSS naming is documented under
[library mode](https://v7.vite.dev/guide/build.html#library-mode).

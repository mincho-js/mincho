# Compilation diagnostics and optimization

Vite and esbuild accept `diagnostics` with independently enabled outputs:

```ts
minchoVitePlugin({
  diagnostics: {
    console: true,
    json: ".cache/mincho/report.json",
    trace: ".cache/mincho/trace.json",
  },
});
```

Paths are relative to the project root. Diagnostics are disabled by default.
JSON reports have a version and separate build generations and environments.
Open the trace in a Chrome Trace Event compatible viewer. Nested phase durations
overlap; they must not be added to estimate wall-clock build time.

In Vite development, report writes are debounced for 200 ms after transforms
settle. Transforms do not wait for report output; shutdown cancels the timer
and awaits the final write. A new build drains scheduled and queued reports
before replacing the current generation. Background write failures are logged.

The Babel plugin accepts `diagnostics: true` and returns extraction details in
`metadata.minchoCompilation`. Build integrations add dependency diagnostics and
timings for the prepass, Babel, sidecar compilation and CSS evaluation.

Compare cold builds, unchanged rebuilds and dependency edits separately. Keep
identifier mode, minification and source-map settings equal. Package contract
reports measure raw, gzip and Brotli transfer sizes per artifact; compression
of concatenated files is not a loading-size measurement.

Module analysis shares one lexical resolver for imports, require bindings and
re-exports. It keeps import and require conditions separate and refuses mutable,
ambiguous or cyclic definitions. Graph traversals own their scopes; later
transforms do not reuse mutable Babel scopes from another traversal.

Build integrations enable a bounded, in-memory `cache` by default. Set
`cache: false` to compare uncached builds. Each Vite environment or esbuild
context owns its cache; closing it releases all entries. Source ASTs are cloned
before traversal. Transform reuse validates source-provider reads and resolutions;
sidecar reuse checks dependency contents, resolution directories and ancestor
configuration files. Pending work is shared only within a build generation.
Failures are never retained, and stale completions cannot replace newer entries.

Custom Babel configuration and unknown compilation plugins bypass reuse because
their external inputs cannot be tracked. Cache hits restore dependency watches
and native assets. CSS evaluation and registry publication still run for each
build; their mutable state is not cached across builds. Diagnostics distinguish
hits, misses, invalidations, pending work and bypasses.

See [memory compilation cache](./memory-compilation-cache.md) for input-session
validation, semantic dependency reuse and CSS publication behavior.

## Reproducible compilation benchmark

Build each revision with `PACKAGE_PUBLISH=true` before packaging it. Keep
baseline and candidate consumers in separate, fresh directories:

```sh
yarn benchmark:compilation --pack=/path/to/baseline --candidate=/tmp/mincho-baseline
yarn benchmark:compilation --pack=/path/to/candidate --candidate=/tmp/mincho-candidate
yarn benchmark:compilation \
  --baseline=/tmp/mincho-baseline --candidate=/tmp/mincho-candidate \
  --baseline-label=baseline --candidate-label=candidate \
  --rounds=5 --output=.cache/compilation-benchmark
```

The harness pins tooling versions and rejects version mismatches. It records
compiler entry-file hashes, Node/machine information and each individual run.
It also accepts prepared strict-PnP consumers with `.pnp.cjs` and the matching
ESM loader; these must declare the measured tooling as direct dependencies.
Use `--pack=... --candidate=... --linker=pnp` to prepare such a consumer.
Use `--formats=esm,cjs`, `--bundlers=esbuild,vite,vite-dev` and `--cases` to select
a subset. Cases cover static/mixed recipes, static/dynamic styled components,
24/240 style modules, shared-token edits, 240 modules without styles,
JavaScript-only edits, helper inputs, used/unused exports and client/SSR analysis.

Each round starts a new Node process for each revision and fixture, alternates
revision order, and rotates fixture order. esbuild measures the first build,
three unchanged rebuilds and three dependency edits; the shared-token case adds
three shared edits. Vite production measures a complete library build. Vite
development measures application-graph transforms and explicit invalidation,
excluding browser network, rendering and full HMR propagation. The development
comparison uses each revision's default plugin options.

Reports contain per-round incremental medians, overall medians, min/max and
quartiles. Process-to-first-result timing includes package loading; phase timing
excludes fixture creation, output compression and SSR assertions. Post-GC heap
and peak RSS describe the Node process, excluding native compiler subprocesses.
Production output checks compare exact CSS and, for esbuild, exported values and
SSR markup at the end of each measured phase. Every unchanged rebuild is also
checked against that process's first output. Sizes include raw/gzip/Brotli byte counts;
concatenated chunks are not a network transfer-size estimate.

Run `--diagnostics` separately into another output directory, using revisions
that both support diagnostic output. Reports contain the phases exposed by each
revision, such as Babel transforms, provider loads/resolutions, sidecar
compilation and CSS evaluation. Instrumented wall times are not the timing
baseline. The existing 512 KiB package-graph worker threshold is unchanged.

For Vite development, the worker reads the final report after closing the server
and groups events by their completion time within each measured phase. This
keeps deferred report writes outside the measured transform path.

Instrumented workers also count Node filesystem read and `createHash` API calls
within each measured phase, so older revisions without the new input counters
can be compared. These are API invocation counts, including failed probes and
PnP reads, rather than operating-system disk I/O counts.

Smoke runs verify harness execution and output equality. They are not timing
evidence for an optimization; record those measurements with the corresponding
feature and its actual baseline.

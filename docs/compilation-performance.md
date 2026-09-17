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

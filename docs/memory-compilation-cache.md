# Memory compilation cache

Vite and esbuild enable validated memory caches by default. Disable them when
comparing output or investigating an integration:

```ts
minchoVitePlugin({ cache: false });
minchoEsbuildPlugin({ cache: false });
```

Each environment owns its transform and sidecar compilation results. Vite can
share immutable parser facts between its client and SSR environments, while
resolutions, dependency watches, registry sessions and generated CSS remain
specific to the environment. Mutable Babel ASTs and restored transform metadata
are copied before use.

## Validation and lifetime

The cache shares pending work, source reads and content fingerprints within an
input session. A second caller validates its own inputs and resolver observations
before reusing a completed result. Builds validate their observed inputs before
publication; standalone requests validate when the request finishes. A source
edit during compilation rejects the request and removes entries it created.
Output-directory changes invalidate reuse without being treated as source edits.

Keys include source, loader, source maps, options and resolver environment.
Dependency contents, resolutions, source-provider policy and ancestor
configuration files are observed again before reuse. Configuration creation and
deletion are observable too. Failed operations are not retained, and an older
generation cannot publish its results into a newer generation.

Result and parser stores have independent limits of 512 entries and 64 MiB of
estimated retained payload by default, with least-recently-used eviction. These
estimates are cache accounting, not a bound on total process RSS. Closing the
owning plugin releases its results; shared parser facts are released after the
last active Vite environment closes.

Syntax-only analysis retains summaries rather than its temporary AST. Mutable
parser reads reuse small ASTs with an isolated copy that preserves source offsets
and comments; inputs above 8,192 UTF-16 code units are reparsed. Retained AST
accounting uses twice the V8-serialized size instead of source bytes, based on
[local parser measurements](./parser-cache-calibration.md). This policy and its
memory estimate should be recalibrated when parser/runtime behavior changes.

Custom Babel configuration, opaque plugins and synchronous value providers take
the normal uncached path when their inputs cannot be tracked safely. Transform
eligibility avoids running Mincho on ordinary modules, while the standalone
Babel API still emits JavaScript and validates syntax.

## Semantic dependencies and CSS effects

For a closed, declarative ESM dependency, an inspected export can retain its
consumer's transform when only unrelated exports change. The check includes
selected object members and their local captures. A changed used value, unknown
effect, mutable export, getter, CommonJS export or resolver-policy change keeps
full invalidation. Reused metadata is refreshed to the current provider source.

Cached sidecar compilation restores dependency watches and native asset output.
CSS evaluation and registry publication still run for each build. In Vite,
replacement CSS is staged until input validation completes and the owner
request is still current. Unchanged CSS remains available during an update;
deleted owners and failed current requests clear their generated artifacts.
A delayed older request cannot replace a newer owner's styles.

## Verification

The regression suites cover input edits with unchanged timestamps, concurrent
callers, failed-provider retry, parser immutability, environment isolation,
semantic export changes, asset replay and stale CSS publication.

The [compilation benchmark](./compilation-performance.md#reproducible-compilation-benchmark)
also has `logic-24`, `helpers-24`, `tokens-used-24`, `tokens-unused-24` and
`environments-24` workloads. Development edits call Vite's watcher hooks before
invalidating the module graph. Use an actual parent/candidate pair and record
uninstrumented timings separately from `--diagnostics` counters; archived
framework measurements do not describe this PR's performance.

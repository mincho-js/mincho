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

The styled runtime computes variant keys once per component and splits props
once per render. It does not memoize against the newly allocated rest-props
object. Polymorphic `as`, refs and explicit class-name ordering remain unchanged.

Module analysis shares one lexical resolver for imports, require bindings and
re-exports. It keeps import and require conditions separate and refuses mutable,
ambiguous or cyclic definitions. Graph traversals own their scopes; later
transforms do not reuse mutable Babel scopes from another traversal.

Build integrations enable bounded memory and filesystem caches by default. Set
`cache: false` to compare uncached builds. Each Vite environment or esbuild
context owns its memory cache;
closing it releases those entries. Validated disk entries survive a process
restart. Source ASTs are cloned before traversal. Transform reuse validates source-provider reads and resolutions;
sidecar reuse checks dependency contents, resolution directories and ancestor
configuration files. Pending work is shared only within a build generation.
Failures are never retained, and stale completions cannot replace newer entries.

File reads, content hashes, configuration discovery and package metadata are
shared within a build. Vite development requests and standalone integration
calls get a fresh input session. Sessions recheck their observed inputs when
they finish, including same-mtime edits and configuration creation or deletion.
A changed source rejects the result and rolls back that session's cache writes.
Directory changes invalidate reuse without rejecting native output-directory
creation. These checks supplement `buildWithMincho`'s existing two-pass snapshot;
they do not make ordinary native bundler writes transactional.

Runtime analysis caches validate their resolve/load observations against the
current provider, including freshly evaluated serialized sidecars. A hit skips
analysis and rewriting; CSS execution and registry publication still take place.
Factory configurations and component identity proofs are shared within one
analysis graph, and identity proofs are rechecked if the graph grows. Modules
with no recipe or styled consumers skip this analysis. Existing ASTs are reused
only with the standard parser configuration. Custom Babel parsers keep their
normal parsing path.

CommonJS export descriptions are cached by filename and source contents, then
cloned before graph-specific re-export discovery. Ordinary ESM skips that
inspection. In development, ordinary modules also skip Mincho's transform-cache
configuration checks; the native dev server retains its own transform cache.

Invalidation follows dependency-to-owner links transitively, leaving unrelated
results available. Cache entries and parsed source caches each retain at most
512 entries and 64 MiB of accounted data. Parsed-source accounting measures
source bytes, not the full heap occupied by ASTs. There is no disk cache and no
additional compiler worker pool.

Custom Babel configuration and unknown compilation plugins bypass reuse because
their external inputs cannot be tracked. Cache hits restore dependency watches
and native assets. Eligible CSS evaluation results can be replayed into an
isolated registry
session; registry publication still runs for each build. Mutable evaluation state
is not shared across builds. Diagnostics distinguish hits, misses, invalidations,
pending work and bypasses.

See [memory compilation cache](./memory-compilation-cache.md) for input-session
validation, semantic dependency reuse and CSS publication behavior.

## Default settings and opt-outs

Vite and esbuild use the same defaults in development and production:

```ts
minchoVitePlugin({
  cache: true,
  execution: { evaluation: "auto", workers: "auto" },
});
minchoEsbuildPlugins({
  cache: true,
  execution: { evaluation: "auto", workers: "auto" },
});
```

Omitting `cache`, setting it to `true`, or selecting `{ type: "filesystem" }`
enables bounded memory and filesystem caches. Use `{ type: "memory" }` for
in-process caching without persistence, or `cache: false` to disable compilation
memoization. `execution: { evaluation: "fresh" }` independently disables guarded
VM reuse and serialized evaluation-result replay. A cache hit still validates
inputs and reconstructs CSS through the current registry and callbacks.

`evaluation: "auto"` reuses a context only when the installed vanilla-extract
version and the closed program satisfy the compatibility proof. Unsupported
programs use fresh evaluation. Missing, corrupt or unavailable disk caches fall
back to compilation. See [compiler execution](./compiler-execution.md) for the
proof boundary and [filesystem caching](./persistent-compilation-cache.md) for
cache locations, budgets and invalidation.

Compiler workers still require a positive `execution.workers` setting. `"auto"`
keeps compiler transforms inline and retains the existing large package-graph
analysis threshold; `0` disables workers. This default change does not enable
additional compiler workers or change CSS and runtime optimization settings.

`optimize.pureFunctions` defaults to `true`. CSS arguments and JSX `css`
rules can use helpers resolved through ESM or CommonJS imports and reexports.
The compiler interprets function declarations and const arrows/functions with
identifier parameters, static defaults, local const declarations and one return.
It supports the existing literal operators, objects, arrays, conditionals and
nested proved helpers. It never executes component modules for this pass.
Mutation, getters, `this`, async code, loops, recursion and unknown calls prevent
folding. Each expression has a shared budget of 50 levels and 10,000 visited
nodes across helper calls. Unproved expressions retain their existing behavior.

Both build adapters accept `optimize`. Vite merges explicitly specified top-level
fields over `babel.optimize`; `defineRulesCxConditions` retains its existing
opt-in behavior. Babel supports same-file helpers directly, while integration
prepares asynchronous cross-module results and retains their dependency watches.

Both adapters also accept `optimizationMode: "development" | "production"`.
Vite selects development for `serve` and production for `build`, independently
of `NODE_ENV` and Vite's named `mode`. esbuild defaults to production; opt into
development explicitly for watch sessions. Individual defined `optimize` fields
override the selected profile. `undefined` does not erase an earlier setting.

| Option                    | Development | Production |
| ------------------------- | ----------- | ---------- |
| `pureFunctions`           | `true`      | `true`     |
| `staticRecipes`           | `false`     | `true`     |
| `styledComponents`        | `false`     | `true`     |
| `defineRulesCxConditions` | Opt-in      | Opt-in     |

```ts
minchoEsbuildPlugins({ optimizationMode: "development" });
minchoVitePlugin({
  optimizationMode: "development",
  optimize: { staticRecipes: true },
});
```

Development keeps CSS extraction and pure helper evaluation while avoiding the
additional recipe folding and styled JSX analysis by default. It retains more
runtime JavaScript. Production keeps the existing bundle and runtime
optimizations. Standalone Babel behavior does not change.

## Runtime package boundaries

The existing `@mincho-js/css/rules/createRuntimeFn` and
`@mincho-js/css/defineRules/createDefineRulesCxRuntime` exports resolve to a
separate runtime directory whose package boundary declares `sideEffects: false`.
Their shared chunks contain only recipe and class-name helpers. Unused serialized
runtime factories can therefore disappear together with their configuration.
The CSS authoring entry and registry retain their existing effect declarations;
`createDefineRulesCssRuntime` also stays outside the pure boundary because it
registers definitions. The package contract checks unused and dynamic runtime
bundles in both ESM and CommonJS output formats.

`optimize.staticRecipes` defaults to `true` in the production profile. Calls to
Mincho `rules` with proved static arguments become class-name literals, including
calls through local imports and reexports. The pass reads serialized configuration
from the normal extracted sidecar and invokes only the known pure recipe runtime.
It does not evaluate component modules or enumerate possible variant combinations.
Repeated observed arguments share results within a build generation, and the
native sidecar pipeline evaluates each sidecar once per build.

Dynamic calls, public recipe methods and CSS imports remain intact. CommonJS
exports can retain their recipe runtime even when a particular call is folded;
replacing a call with a string does not always reduce bundle size. Vanilla Extract
recipes and sprinkles keep their normal extraction support but are not folded by
this pass. Standalone `.css.ts` authoring modules also keep their existing behavior.

## Reproducible compilation benchmark

Build each revision with `PACKAGE_PUBLISH=true` before packaging it. Keep
baseline and candidate consumers in separate, fresh directories:

```sh
yarn benchmark:compilation --pack=/path/to/baseline --candidate=/tmp/mincho-baseline
yarn benchmark:compilation --pack=/path/to/candidate --candidate=/tmp/mincho-candidate
yarn benchmark:compilation \
  --baseline=/tmp/mincho-baseline --candidate=/tmp/mincho-candidate \
  --baseline-label=f6a4844b --candidate-label=working-tree \
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
comparison uses the supplied plugin options for each revision.

Reports contain per-round incremental medians, overall medians, min/max and
quartiles. Process-to-first-result timing includes package loading; phase timing
excludes fixture creation, output compression and SSR assertions. Post-GC heap
and peak RSS describe the Node process, excluding native compiler subprocesses.
Production output checks compare exact CSS and, for esbuild, exported values and
SSR markup at the end of each measured phase. Every unchanged rebuild is also
checked against that process's first output. Sizes include raw/gzip/Brotli byte counts;
concatenated chunks are not a network transfer-size estimate.

Run `--diagnostics` separately into another output directory. Its counters
include reads/hashes, input reuse and validation, parse/cache hits, provider
loads/resolutions, optional-pass skips and CSS evaluation. Instrumented wall
times are not the timing baseline. The existing 512 KiB package-graph worker
threshold is unchanged.

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

## Measuring the defaults

`--baseline-options` and `--candidate-options` accept JSON plugin options. To
compare the former defaults with the new defaults using identical installed
compiler bytes, use the same prepared consumer for both arguments:

```sh
yarn benchmark:compilation \
  --baseline=/tmp/mincho-candidate --candidate=/tmp/mincho-candidate \
  --baseline-options='{"cache":{"type":"memory"},"execution":{"evaluation":"fresh"}}' \
  --candidate-options='{}' \
  --rounds=5 --restart --output=.cache/compiler-defaults
```

The old-default configuration retains in-memory transform caches and uses fresh
CSS evaluation. This comparison isolates default settings; it is not a
comparison between compiler revisions. Omit those option arguments when
comparing two revisions with their respective defaults.

Each cold sample removes only the fixture-owned Mincho and Vite caches. The
`--restart` sample creates a new process with the same original source and keeps
those caches; output hashes and byte sizes must match the original build.
Unchanged rebuilds and edits measure the existing process. `--first-only` skips
incremental iterations when only cold/restarted processes are relevant. Cases
`vanilla-24` and `vanilla-240` exercise direct vanilla-extract styles as well as
Mincho-generated inputs.

Run `--diagnostics` separately to observe validated disk hits and evaluation
reuse. `--resources` optionally samples the Linux process tree through `/proc`
and records RSS, threads and context switches. Sampling adds overhead and can
miss short-lived processes or threads; use it for diagnostics, not timing gates.
Process-to-first-result, total process duration and close time are reported
separately so persistence and cleanup costs remain visible.

The [default settings comparison](./compiler-defaults-performance.md) records
measurements for this adoption separately from later compiler optimizations.

## Historical compilation diagnostics

For the 24-module ESM esbuild fixture, a separate diagnostic run comparing
`f6a4844b` with this implementation recorded the following unchanged rebuild.
Counts include failed configuration probes and the final input validation:

| Operation                          | `f6a4844b` | Current |
| ---------------------------------- | ---------: | ------: |
| Node `fs.promises.readFile` calls  |      9,849 |     304 |
| Node `crypto.createHash` calls     |        562 |     228 |
| Runtime-analysis passes            |         25 |       0 |
| Runtime-result cache hits          |          0 |       1 |
| Producer modules skipping analysis |          0 |      24 |
| CSS evaluations                    |         24 |      24 |

The first build runs runtime analysis once instead of 25 times. Editing a
producer invalidates the consumer's runtime result and analyzes it again.
The unchanged rebuild still evaluates every sidecar, so these savings do not
depend on retaining CSS execution or registry state across builds.

## Build-time comparison

The following measurements compare `f6a4844b` (the nine earlier optimizations)
with this implementation on 2026-09-19. The machine used Linux x64, an Intel
Core i5-8265U, Node 24.21.0, esbuild 0.27.7, Vite 7.3.3, Babel 7.29.7,
React 19.2.6 and vanilla-extract CSS 1.21.2. No diagnostics, tests or package
builds ran alongside the timed workers.

The npm ESM matrix ran five rounds per revision and case. Values below are
milliseconds, shown as baseline → current. Rebuild values are the median of
each round's three-rebuild median.

| Fixture                    |          esbuild first |      esbuild unchanged |         esbuild edited |        Vite production |
| -------------------------- | ---------------------: | ---------------------: | ---------------------: | ---------------------: |
| 24 style modules           |   1,302 → 925 (−28.9%) |     667 → 197 (−70.5%) |     641 → 258 (−59.8%) | 1,547 → 1,135 (−26.7%) |
| 240 style modules          | 9,013 → 5,631 (−37.5%) | 6,284 → 1,666 (−73.5%) | 6,166 → 2,188 (−64.5%) | 9,422 → 6,119 (−35.1%) |
| 24 modules sharing tokens  |          1,542 → 1,096 |              728 → 213 |              704 → 263 |          1,714 → 1,255 |
| 240 modules without styles |          2,313 → 1,180 |            1,796 → 190 |            1,798 → 177 |          3,155 → 1,911 |

Editing the shared token file rebuilt its consumers in 463 ms versus 1,159 ms
(−60.1%). For the four smaller recipe/styled cases, esbuild's initial build
improved by 3.4–12.2% and unchanged rebuilds by 46.9–52.3%. Vite's static styled
case was effectively unchanged (536.5 → 535.9 ms); the other small cases
improved by 4.5–18.0%. None of these ESM medians regressed by more than 5%.

For the compilation phase, the 24-module esbuild initial-build goal of −30%
was narrowly missed at −28.9%.
The 240-module initial-build goal, both sizes' unchanged/edit goals of −40%/−30%,
and Vite production's −20% goal were met. These fixture results are not timing
guarantees for other machines or projects.

Including worker startup and package loading, time to the first result was
1,714 → 1,377 ms for esbuild's 24-module case (−19.7%) and
9,429 → 6,086 ms for 240 modules (−35.5%). Vite's corresponding timings were
2,129 → 1,681 ms (−21.0%) and 9,977 → 6,695 ms (−32.9%).

All production CSS and runtime comparisons passed. CSS and esbuild JS sizes
were unchanged from `f6a4844b` in raw, gzip and Brotli form. Vite's mixed recipe
and dynamic styled JS each lost 62 raw bytes (9/11 gzip bytes and 6/8 Brotli
bytes respectively); the other Vite outputs were unchanged. For 240 style modules,
esbuild's post-GC heap was 44.4 → 43.4 MiB and peak Node RSS was
696.4 → 424.5 MiB. Vite's corresponding values were 40.5 → 40.3 MiB and
400.3 → 411.0 MiB. Bounded input/analysis retention adds memory, while skipping
repeated AST work reduces allocation; peak RSS is workload-dependent and is
not guaranteed to decrease.

The complete five-round records, including dispersion and process startup
timings, are written to `.cache/compilation-benchmark-optimized/report.json`.

The npm CommonJS matrix ran three rounds with the same measurement procedure:

| Fixture                    |          esbuild first |      esbuild unchanged |         esbuild edited |         Vite production |
| -------------------------- | ---------------------: | ---------------------: | ---------------------: | ----------------------: |
| 24 style modules           | 1,446 → 1,054 (−27.1%) |     679 → 212 (−68.7%) |     639 → 294 (−54.0%) |  5,536 → 2,148 (−61.2%) |
| 240 style modules          | 9,722 → 6,271 (−35.5%) | 6,408 → 1,697 (−73.5%) | 6,398 → 2,202 (−65.6%) | 42,243 → 9,042 (−78.6%) |
| Static styled              |              417 → 403 |                94 → 57 |                85 → 72 |   1,328 → 1,360 (+2.4%) |
| 240 modules without styles |          2,286 → 1,144 |            1,751 → 196 |            1,805 → 166 |           3,895 → 2,627 |

Raw, gzip and Brotli JS/CSS sizes were unchanged in all four CommonJS cases,
and CSS/runtime comparisons passed. The small Vite styled case regressed 2.4%,
below the 5% review threshold. The first 24-module esbuild candidate run was
slower than baseline, so the three individual samples and dispersion remain
available in `.cache/compilation-benchmark-cjs/report.json`.

Vite development ran three rounds per format with each revision's default
profile. These are application-graph requests, not browser HMR timings:

| Format / fixture                      |   First graph | Edited graph | Unchanged graph |
| ------------------------------------- | ------------: | -----------: | --------------: |
| ESM / 24 style modules                | 1,284 → 1,179 |     119 → 58 |     3.40 → 4.97 |
| ESM / static styled                   |     385 → 317 |      97 → 59 |     0.38 → 0.43 |
| ESM / 240 modules without styles      | 2,588 → 1,165 |  60.7 → 62.5 |   14.15 → 15.16 |
| CommonJS / 24 style modules           | 4,772 → 1,658 |     309 → 94 |     3.61 → 4.04 |
| CommonJS / static styled              |     593 → 571 |    284 → 118 |     0.40 → 0.38 |
| CommonJS / 240 modules without styles | 3,349 → 1,956 |    460 → 277 |   15.49 → 13.84 |

Unchanged development requests mostly use Vite's own transform cache. A separate
diagnostic run of the ESM style/styled cases recorded no compilation, filesystem
read or hash work in those requests. The 24-module unchanged graph walk still
increased by 1.57 ms (+46.2%), and the plain ESM dependency edit increased 2.9%.
The development profile retains runtime calls and can retain a larger module
graph; it does not promise that every cached request becomes faster. Full records
are in `.cache/compilation-benchmark-development/report.json`.

Strict PnP ran one additional ESM/CommonJS matrix for 24 style modules, static
styled and mixed recipes through both production adapters. All CSS/runtime
comparisons passed; its individual timings in
`.cache/compilation-benchmark-pnp/report.json` are smoke measurements, not
stable performance estimates. An initially slower ESM mixed-recipe sample was
rechecked for five rounds: esbuild's first build improved 472 → 433 ms (−8.3%),
unchanged rebuilds 81 → 39 ms (−52.6%) and edits 79 → 44 ms (−44.9%). Vite's
first build improved 1,522 → 1,472 ms (−3.3%). These repeat records are in
`.cache/compilation-benchmark-pnp-repeat/report.json`.

### Reference before the nine optimizations

A separate three-round npm ESM comparison against `fbc32c0d` shows the remaining
cost of the earlier features. These are fresh measurements of both revisions;
the current medians differ slightly from the five-round table above.

| Fixture          |      esbuild first | esbuild unchanged |   esbuild edited |      Vite production | esbuild JS bytes |
| ---------------- | -----------------: | ----------------: | ---------------: | -------------------: | ---------------: |
| 24 style modules | 585 → 961 (+64.2%) |         239 → 195 |        252 → 254 | 960 → 1,103 (+14.9%) |      6,657 → 526 |
| Static styled    | 295 → 330 (+11.7%) |           42 → 34 | 36 → 43 (+17.0%) |    480 → 497 (+3.5%) |      1,787 → 253 |
| Recipe           | 253 → 319 (+26.1%) |           33 → 31 | 29 → 34 (+19.4%) |    468 → 457 (−2.4%) |      1,338 → 342 |

The corresponding esbuild gzip JS sizes were 1,372 → 274, 887 → 207 and
600 → 77 bytes; Brotli sizes were 1,135 → 238, 817 → 166 and 549 → 86 bytes.
CSS and runtime comparisons passed. The build-time changes recover much of the
overhead introduced by the nine optimizations, while retaining their bundle
benefits; they do not restore the earlier first-build or small-edit timings in
every case. Records are in `.cache/compilation-benchmark-before-nine/report.json`.

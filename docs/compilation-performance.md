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
`cache: false` to compare uncached builds. Each esbuild context owns its cache.
Vite environments own separate transform/evaluation caches and share a bounded
cache of immutable source analysis within one plugin instance. Closing the last
environment releases shared entries. Source ASTs are cloned before mutation. Transform reuse validates source-provider reads and resolutions;
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
source bytes, not the full heap occupied by ASTs. Memory and filesystem caching
are enabled by default. Execution and cache options are described below.

Custom Babel configuration and unknown compilation plugins bypass reuse because
their external inputs cannot be tracked. Cache hits restore dependency watches
and native assets. Compatible CSS evaluation results can also be replayed from
the cache. Each replay restores independent registry state and reruns current
CSS callbacks and package-graph validation. Diagnostics distinguish hits, misses,
invalidations, pending work and bypasses.

## Shared analysis and incremental reuse

The adapters use these additional reuse paths without adding a native compiler
or changing application runtime APIs:

| Phase                 | Reused work                                                                           | Validation and fallback                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source analysis       | Immutable ASTs, import/JSX/call summaries and normalized `extractCalls` registrations | Parser options and source contents are part of the key; transformations receive independent ASTs/scopes. Accessor-bearing configurations are not memoized.                                                                                     |
| Adapter dispatch      | Babel is skipped for files with no possible Mincho work                               | CommonJS, custom Babel configuration/plugins, extraction registrations and ambiguous syntax retain the normal path. The standalone Babel API still emits JavaScript.                                                                           |
| Pure helpers          | Successful literal results of proven pure functions                                   | Captures and module implementations are resolved before a hit; arguments, lexical values and evaluation depth distinguish entries. Hits consume the original evaluation budget and clone the returned AST.                                     |
| Vite environments     | Source ASTs and immutable analysis across client and SSR                              | Transforms, module graphs, CSS, evaluation results and mutable scopes remain environment-specific. Shared entries are bounded and released when the last environment closes.                                                                   |
| CSS publication       | Existing virtual CSS when its contents are unchanged                                  | New CSS is staged until evaluation and input validation succeed. Changed/deleted CSS still invalidates its module; obsolete sidecar IDs are removed. Newer owner requests and build generations reject late publication.                       |
| Dependency validation | Transforms whose used ESM exports/members are unchanged                               | Export fingerprints include local captures and import boundaries. CommonJS, unknown effects, ambiguous exports and failed analyses fall back to full-file invalidation. Changed values refresh source metadata and watch edges.                |
| Evaluation            | Serialized CSS, exports and snapshotable registry effects in memory/disk              | Only closed, compatible evaluations qualify. Replay restores an independent registry and reruns current CSS callbacks and package-graph validation. Unknown inputs, opaque effects, custom identifier functions and failures execute normally. |

Pure-helper results share the existing parser/analysis LRU. Serialized evaluations
share the existing compilation-cache limits and disk cleanup. These paths trade
bounded memory and first-use analysis/serialization for less repeated work; they
do not reduce application JavaScript/CSS by themselves. Filesystem cache format
`mincho-compilation-v3-runtime-canonical` prevents older manifests from being reused
after the canonical recipe-order change.

Evaluation keys include source, file scope, identifier mode, environment,
compiler/library implementations and observed configuration. Entry shims and
sibling implementation chunks are fingerprinted. No live VM context, Babel scope,
function closure or adapter instance is written to disk.

See [memory compilation cache](./memory-compilation-cache.md) for input-session
validation, semantic dependency reuse and CSS publication behavior.

## Execution and filesystem cache options

The cache and evaluation defaults apply in both development and production.

Both bundlers accept the same options:

```ts
minchoVitePlugin({
  execution: {
    workers: "auto", // default; compiler transforms currently stay inline
    evaluation: "auto", // default; reuse only proven compatible programs
  },
  cache: true, // default memory + filesystem cache
});

minchoEsbuildPlugins({
  execution: { workers: 2, ioConcurrency: 16, evaluation: "auto" },
  cache: {
    type: "filesystem",
    evaluationResults: true, // default; replay serializable, closed evaluations
    directory: "/absolute/project-cache/mincho",
    maxBytes: 256 * 1024 * 1024,
  },
});
```

`workers: 0` keeps all CPU work inline. A positive integer enables Babel and
scoped-dependency transforms in Tinypool, capped by the detected CPU budget.
`auto` retains the existing large package-graph worker threshold; it does not
automatically enable compiler workers. The compiler-worker timing gate has not
passed. Guarded VM reuse and filesystem caching are enabled by default. Omitted
`cache`, `true` and `{ type: "filesystem" }` all retain memory and disk results.
Use `{ type: "memory" }` for in-process caching without persistence, or
`cache: false` to disable result, parser, script and disk memoization.
`evaluation: "fresh"` independently disables context reuse and evaluation result
replay. `cache: { type: "filesystem", evaluationResults: false }` disables only serialized evaluation
results, retaining AST/transform/native compilation caches and guarded VM reuse.

The CPU budget is the minimum of Node's available parallelism, allowed physical
cores when known, and the floored cgroup CPU quota (at least one). Linux reads
allowed CPUs, socket/core topology and nested cgroup v1/v2 limits. macOS uses
`sysctl`; Windows uses CIM. Unknown topology or unverified affinity disables
automatic workers instead of assuming that half the logical CPUs are physical
cores. Automatic work leaves one CPU budget slot for the main thread. Explicit
counts remain capped. This budget is process-local and does not control
esbuild's native threads or other Node processes.

Pools are lazy and shared by plugin instances using the same resolved worker
entry. Each worker handles one job at a time, pending admission is bounded at
twice the CPU budget, and overflow uses the inline path. Source and options cross
the worker boundary as structured data; ASTs and executable callbacks do not.
Custom Babel plugins/configurations stay inline. Provider resolution/loading
stays on the main thread; recursive provider work goes inline to avoid deadlock
with one worker. Generation changes reject stale results, and closing the last
owner destroys the pool. Vite package-graph analysis uses the same admission
budget and preserves the graph from the time of the request.

When `ioConcurrency` is specified, PromisePool limits Mincho's fingerprint and
disk-cache I/O and drains batches of 64, bounding the library's retained results.
Each lane takes another file when its I/O finishes, avoiding per-file library
scheduling. Each caller receives its original error. Omitting the option
preserves native concurrent reads; a cap reduces I/O pressure but can slow small cached reads.
No I/O permit is held across recursive module-provider work. Parser cache
budgets are divided between the main thread and compiler workers. These are
source-byte accounting limits, not limits on V8 heap or total RSS.

Filesystem caching stores versioned, checksummed V8-serialized data through
atomic rename. The namespace includes compiler content, Node/V8/platform,
process flags and bundler environment. Entries keep input content hashes,
including missing configuration files and resolver directory snapshots.
Provider sources and native asset data are revalidated before reuse. Writes are
published after successful compilation/input validation; failed compilations
do not publish their results. Corrupt, missing, incompatible or unwritable cache
entries are misses. The default directory is `.cache/mincho` beneath esbuild's
working root, or `mincho` beneath Vite's configured `cacheDir`. The default
256 MiB budget is enforced with approximate access-time eviction. No live
registry sessions, functions or ASTs are persisted.

VM reuse is guarded by a closed syntax proof of the complete compiled program.
It accepts trusted compiler helpers, plain data and a small set of Mincho and
official vanilla-extract calls. Unknown calls, callbacks, getters, asynchronous
work, global/prototype mutation and unrecognized helpers use vanilla-extract's
fresh evaluator. The compatibility processor currently requires vanilla-extract
integration 8.0.10 and matching adapter/file-scope instances. Other versions
remain supported through the fresh evaluator. Each leased context gets fresh
CommonJS bindings; the lease covers CSS serialization and artifact validation,
and a failure discards the context. Script/proof caching is bounded to 512
entries/64 MiB by source size; filesystem mode can additionally retain V8 cached
data. This is a compatibility optimization, not a sandbox for untrusted code.

Diagnostics expose `cpu-budget`, `worker-wait`, `worker-pool-initialize`,
`worker-run`, `worker-overhead`, `worker-bypass`, `disk-cache-*` and `vm-*` events.
Worker overhead includes startup, serialization and IPC; it is not a pure IPC
measurement.

## Compiler optimizations

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
| `runtimeCodegen`          | `false`     | `true`     |
| `defineRulesCxConditions` | Opt-in      | Opt-in     |
| `jsxRuntimeGuards`        | `false`     | `true`     |
| `dependencyGraph`         | `false`     | `false`    |
| `staticStyles`            | `false`     | `false`    |
| `staticScopedCx`          | `false`     | `false`    |
| `symbolicTokens`          | `false`     | `false`    |

See [atomic/runtime optimizations](atomic-runtime-optimizations.md) for scoped
`cx` baking, symbolic token references, conditional atom sharing, and the separate
`experimental.cssBooleanGates` option (also disabled by default).

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
optimizations. Standalone Babel enables the new code-generation reductions only
with `optimize.runtimeCodegen: true`; JSX guard specialization requires the
bundler integration. See [runtime optimization](runtime-optimizations.md) for
eligibility, the canonical recipe-order change, and experimental options.

## Runtime package boundaries

The existing `@mincho-js/css/rules/createRuntimeFn` and
`@mincho-js/css/defineRules/createDefineRulesCxRuntime` exports resolve to a
separate runtime directory whose package boundary declares `sideEffects: false`.
Their shared chunks contain only recipe and class-name helpers. Unused serialized
runtime factories can therefore disappear together with their configuration.
Known serialized recipe factory calls also carry explicit pure annotations so
both esbuild and Rollup can remove unused initialization after JSX flattening.
The CSS authoring entry and registry retain their existing effect declarations;
`createDefineRulesCssRuntime` also stays outside the pure boundary because it
registers definitions. The package contract checks unused and dynamic runtime
bundles in both ESM and CommonJS output formats.

`optimize.staticRecipes` defaults to `true` in the production profile. Calls to
Mincho `rules` with proved static arguments become class-name literals, including
calls through local imports and reexports. The pass reads serialized configuration
from the normal extracted sidecar and invokes only the known pure recipe runtime.
It does not evaluate component modules. Repeated observed arguments share results
within a build generation, and the native sidecar pipeline evaluates each sidecar
once per build.

With `optimize.runtimeCodegen` enabled, recipe selections built from literal values
and containers with up to four conditional expressions can expand into at most
16 precomputed class strings. The conditions still run at runtime in their original
order. Unproved selections and expansions over the budget retain the original call.

The static-argument pass keeps other dynamic calls, public recipe methods and CSS
imports intact. CommonJS exports can retain their recipe runtime even when a
particular call is folded; replacing a call with a string does not always reduce
bundle size. Vanilla Extract recipes and sprinkles keep their normal extraction
support but are not folded by this pass. Standalone `.css.ts` authoring modules
also keep their existing behavior.

`optimize.styledComponents` also defaults to `true` in production. For example, a static
`<Button size="large" className="extra">` can become an intrinsic `<button>`
with the exact serialized recipe classes. Analysis follows the same lexical
imports and reexports, including CommonJS and namespace JSX. Other attributes
and children retain their evaluation order. Defaults, compound variants and
the runtime's class-name ordering (including its trailing space) are preserved.

Spreads, `as`, refs, custom component targets, dynamic variants/class names,
component escapes, mutations and observed element types prevent flattening.
The pass checks component uses in the loaded source graph; it does not perform
whole-program analysis of consumers outside that graph. Disable
`styledComponents` for code that changes exported component objects indirectly
at runtime. Public component exports and remaining dynamic JSX retain wrappers. The new
`runtimeCodegen` pass additionally supports a conservative subset of closed,
dynamic intrinsic JSX and local styled chains. Recipe/styled graph analysis
requires a build integration; Babel-only operation retains those runtime calls.

The package contract compares SSR markup, attribute/child evaluation order and
module effects before and after flattening in ESM and CommonJS bundles. It also
reports raw/gzip/Brotli sizes and three-round median compilation times for fresh
contexts, unchanged rebuilds and dependency edits. These context measurements
share a process; they are not fresh-process startup benchmarks or timing gates.

The following historical package-contract measurements are from `f6a4844b`,
before the build-time changes below. They used Node 24.21.0 and esbuild 0.27.7
on 2026-09-19, with the same minifier and identifier settings in each comparison.
The static styled fixture retained identical CSS and SSR output:

| Format   | JS bytes before → after |  gzip bytes | Brotli bytes |
| -------- | ----------------------: | ----------: | -----------: |
| ESM      |             1,776 → 262 |   891 → 218 |    809 → 186 |
| CommonJS |             2,282 → 749 | 1,121 → 471 |  1,011 → 401 |

The separate small recipe fixture reduced JS from 1,218 to 246 bytes, but did
**not** demonstrate a build-time speedup. Its median timings in milliseconds
were:

| Linker / mode                             | New context | Unchanged rebuild | Dependency edit |
| ----------------------------------------- | ----------: | ----------------: | --------------: |
| npm / optimizations off, cache off        |        26.8 |              21.8 |            21.4 |
| npm / optimizations on, cache off         |        44.1 |              50.0 |            43.3 |
| npm / optimizations on, cache on          |        59.7 |              49.4 |            60.2 |
| strict PnP / optimizations off, cache off |        72.2 |              27.5 |            30.9 |
| strict PnP / optimizations on, cache off  |       101.7 |              48.0 |            52.2 |
| strict PnP / optimizations on, cache on   |       123.0 |              70.1 |            75.1 |

Analysis and cache validation add overhead that can exceed recompilation costs
for small inputs. These results support bundle reduction, not a general claim
of faster builds. Measure the actual project with diagnostics; `cache: false`
and individual `optimize` switches remain available when that tradeoff is
unfavorable.

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
comparison uses each revision's default profile.

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

`--baseline-options` and `--candidate-options` accept JSON plugin options, so
the same installed revision can compare `workers: 0` with a worker count, or
`evaluation: "fresh"` with `"auto"`. `--restart` prepares the original fixture
again and starts a second Node process, preserving the experiment's filesystem
cache. For bundled output it checks that the restart matches the first build;
development measures graph transforms without producing a bundle. Explicit
filesystem experiments use a separate cache directory per case/revision/round.
Both explicit and bundler-default cache directories are cleared before each cold
run and retained for its restart. `--first-only` skips same-process rebuilds when
measuring startup and restart alone. `vanilla-24` and `vanilla-240` use official
vanilla-extract calls so the guarded evaluator can actually reuse contexts.

Use `--resources` in a separate run. On Linux it samples the child process tree
and its threads at 25 ms intervals, including native compiler processes. It
reports sampled peak RSS, peak thread count and sampled voluntary/involuntary
context-switch counts. Sampling can miss short-lived peaks and adds its own
I/O/CPU work; these measurements are not the uninstrumented timing baseline.

## Measuring the defaults

`--baseline-options` and `--candidate-options` accept JSON plugin options. To
compare fresh evaluation with the current defaults using identical installed
compiler bytes, use the same prepared consumer for both arguments:

```sh
yarn benchmark:compilation \
  --baseline=/tmp/mincho-candidate --candidate=/tmp/mincho-candidate \
  --baseline-options='{"cache":{"type":"memory"},"execution":{"evaluation":"fresh"}}' \
  --candidate-options='{}' \
  --rounds=5 --restart --output=.cache/compiler-defaults
```

The baseline configuration retains in-memory transform caches and uses fresh
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

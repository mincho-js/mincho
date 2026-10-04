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
`mincho-compilation-v2` prevents older manifests from being reused.

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

## Execution pool measurements

Local measurements on 2026-09-19 used an Intel i5-8265U (4 physical cores,
8 logical CPUs), Node 24.21.0, esbuild 0.27.7 and vanilla-extract CSS 1.21.2.
The installed baseline's production source matched `12ef6601`. Tests, builds
and resource sampling were stopped during timing runs. Order alternated between
revisions, and each round started a new Node process.

Five-round medians with memory caching and fresh evaluation (the defaults before
the policy update below), in milliseconds:

| esbuild ESM case           | First, before → after | Unchanged, before → after | Edit, before → after |
| -------------------------- | --------------------: | ------------------------: | -------------------: |
| 24 Mincho style modules    |             941 → 946 |                 199 → 195 |            265 → 257 |
| 24 vanilla-extract modules |             568 → 552 |                 106 → 108 |             103 → 97 |
| 240 ordinary modules       |         1,157 → 1,192 |                 192 → 204 |            174 → 169 |

The ordinary-module unchanged rebuild was about 6.3% slower (12 ms), so the
comparison does **not** establish a universal improvement or meet a 5% regression
gate in every case. Other phase differences ranged from -6.0% to +3.0%.
Node peak RSS medians increased by 0.4–5.6%. Filesystem caching and VM reuse were
disabled in this comparison; its 6.3% regression is not a measurement of either
option's cost.

Three-round option comparisons used the same installed compiler on both sides:

| Option and case                                         |   Before → after | Change |
| ------------------------------------------------------- | ---------------: | -----: |
| VM reuse, 240 vanilla-extract modules, first build      | 2,661 → 2,653 ms |  -0.3% |
| VM reuse, unchanged rebuild                             |     732 → 527 ms | -28.0% |
| VM reuse, edited rebuild                                |     694 → 490 ms | -29.4% |
| Filesystem cache, 240 Mincho modules, empty-cache build | 5,717 → 5,988 ms |  +4.7% |
| Filesystem cache, new process with warm disk entries    | 5,705 → 3,520 ms | -38.3% |

VM comparisons used `workers: 0` and changed only `evaluation`. Filesystem
comparisons used `workers: 0`, `evaluation: "fresh"`, `--first-only --restart`
and changed only the cache type. These gains apply to the measured cases, not
arbitrary stylesheets; unsupported programs always keep fresh evaluation.

Default activation considers cumulative build time, independently for each
optimization. For the 240-module filesystem-cache fixture, the cold-build cost
was 271 ms and a subsequent process restart saved 2,185 ms. Adding the phase
medians gives 11,422 ms with memory caching versus 9,507 ms with filesystem
caching, about 16.8% less across the two builds. Reusing the cache once recovers
its creation cost. The default therefore retains disk entries; a single-use
build can explicitly choose memory caching. Guarded VM reuse also defaults to
`auto`, with fresh evaluation for unsupported programs or integration versions.

| Optimization        | Default                          | Reason                                                                      |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Filesystem cache    | Enabled alongside memory caching | Repeated builds amortize cache creation; memory-only remains available.     |
| VM reuse            | `evaluation: "auto"`             | Reuse is guarded by compatibility and effect checks, with a fresh fallback. |
| Compiler workers    | Explicit positive worker count   | Startup and transfer costs outweighed parallel work in measured cases.      |
| I/O concurrency cap | Unset                            | Native concurrency avoids pool scheduling costs for small cached reads.     |

Follow-up three-round measurements compared memory caching plus fresh evaluation
against the new defaults on the same final compiler. Cold runs clear the
fixture-owned caches; Vite's cache directory is pinned to the fixture so a
parent package's cache cannot affect cold timing. Medians in milliseconds:

| Bundler and case                       | Cold, before → after | Restart, before → after | Cold + restart change |
| -------------------------------------- | -------------------: | ----------------------: | --------------------: |
| esbuild, 24 Mincho modules             |          939 → 1,059 |               968 → 704 |                 -7.6% |
| esbuild, 240 ordinary modules          |        1,184 → 1,325 |             1,163 → 366 |                -27.9% |
| Vite build, 24 Mincho modules          |        1,141 → 1,259 |             1,110 → 850 |                 -6.3% |
| Vite build, 240 ordinary modules       |        1,954 → 2,156 |           1,979 → 1,218 |                -14.2% |
| Vite development, 24 Mincho modules    |        1,241 → 1,318 |             1,189 → 965 |                 -6.1% |
| Vite development, 240 ordinary modules |        1,219 → 1,211 |           1,201 → 1,227 |                 +0.7% |
| esbuild, 240 vanilla-extract modules   |        2,596 → 3,065 |           2,712 → 1,469 |                -14.6% |

With both defaults active on 240 vanilla-extract modules, unchanged rebuilds
fell from 747 to 537 ms (-28.1%) and edits from 716 to 521 ms (-27.2%). The cold
build was 18.0% slower while process restart was 45.9% faster. This combined
comparison preserves the VM-reuse benefit and recovers the disk creation cost
after one restart in this fixture.

Same-process rebuilds are not uniformly faster. The 24-module Mincho edit in
esbuild rose from 256 to 278 ms (+8.7%); ordinary-module unchanged rebuilds rose
from 195 to 211 ms (+8.3%). Vite development's Mincho edit fell from 57 to 52 ms,
while its ordinary-module edit rose from 66 to 70 ms. The final implementation
avoids disk eviction scans when a request publishes no new entries. Long-lived
sessions dominated by edits can still select memory caching independently of VM
reuse.

Separate memory-cache comparisons on 24 vanilla-extract modules reduced esbuild
unchanged and edited rebuilds by 23.3% and 15.9% with VM reuse, respectively.
The matching Vite development edit improved by 5.4%; its Mincho fixture edit
cost about 5 ms more. These are workload-dependent tradeoffs, not an expectation
that every program benefits from VM reuse.

The follow-up reports are `.cache/compilation-defaults-final/report.json`
(esbuild and Vite development), `.cache/compilation-defaults-vite/report.json`
(Vite production with corrected cache-directory isolation), and
`.cache/compilation-defaults-vm/report.json` (VM-only comparison).
The 240-module combined-default comparison is in
`.cache/compilation-defaults-large/report.json`.

Compiler-worker trials did not pass the proposed automatic activation gate:
at least 10% faster in a target case, at most 5% slower for small/incremental
work, and no more than 50% additional total RSS. Reusing threads does not by
itself reduce per-build context switches or offset startup/IPC cost. Positive
worker counts remain available for project-specific measurement. Bounded I/O
also remains explicit: scheduling lanes in batches removed much of its cost,
but capped reads still slowed some small cached workloads.

Output checks retained identical CSS, exported values and JS size measurements.
Separate npm/PnP smoke runs checked Vite and esbuild, ESM/CommonJS and process
restart with workers, VM reuse and filesystem caching enabled together. PnP
diagnostics confirmed real worker execution and disk hits; ESM fixtures reused
VM contexts while the CommonJS fixtures used the fresh fallback. Native asset
restoration and invalidation were also checked under npm and PnP. The one-round
Vite smoke runs are correctness checks, not performance acceptance evidence.

Reports are written beneath `.cache/compilation-pools-final-{default,vm,disk,pnp,vite}`
and contain raw samples, compiler hashes, versions and output hashes. For example:

```sh
node scripts/benchmark-compilation.mjs \
  --baseline=/tmp/mincho-candidate --candidate=/tmp/mincho-candidate \
  --baseline-options='{"cache":{"type":"memory"},"execution":{"workers":0,"evaluation":"fresh"}}' \
  --candidate-options='{"cache":{"type":"memory"},"execution":{"workers":0,"evaluation":"auto"}}' \
  --cases=vanilla-240 --formats=esm --bundlers=esbuild --rounds=3
```

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

## Shared-analysis measurement (2026-09-19–20)

Baseline: `c21a0a49`, which already includes worker/I/O pools, guarded VM reuse and default filesystem caching. The candidate adds the seven reuse paths above. Both revisions were packed into isolated npm consumers with identical dependency versions. Measurements use Node 24.21.0 on Linux x64, Intel i5-8265U (4 physical cores / 8 logical CPUs), ESM, default options and five rounds with alternating revision order. Diagnostics were disabled and no tests/builds ran alongside the timed workers.

The table reports milliseconds, baseline → candidate. Each round measures one cold build, three unchanged rebuilds and three edits; reported rebuild values are medians of per-round medians. Restart launches another Node process with the original fixture and retained disk cache. Phase timings exclude package loading, fixture preparation and artifact assertions.

| esbuild fixture                  |            Cold |     Unchanged |         Edited |        Restart |
| -------------------------------- | --------------: | ------------: | -------------: | -------------: |
| 240 ordinary TS modules          |  1351.9 → 347.8 | 199.4 → 157.4 |  202.5 → 154.2 |  405.5 → 355.3 |
| 24 Mincho recipes                | 1055.9 → 1053.3 | 176.9 → 180.7 |  255.3 → 245.1 |  635.4 → 657.1 |
| 24 vanilla-extract styles        |   610.1 → 655.0 |   88.6 → 91.3 |    92.7 → 93.9 |  254.5 → 269.5 |
| 24 styles, owner JS-only edit    |  987.2 → 1014.4 |  101.0 → 99.6 |  129.9 → 122.2 |  740.1 → 293.5 |
| 24 users of a 48-property helper |  1677.3 → 998.7 | 104.1 → 102.2 | 1249.2 → 644.3 | 1649.1 → 950.4 |
| 24 users, used token changed     |  959.5 → 1024.5 |  99.4 → 102.3 |  527.1 → 550.2 |  979.5 → 956.8 |
| 24 users, unused token changed   |  971.0 → 1014.0 |  104.1 → 98.0 |  523.7 → 282.4 |  991.6 → 650.0 |

For ordinary TS, process startup through the first result also fell from 1,808.0 to 768.7 ms; the 74% cold-phase reduction is not a claim about the entire process. Node peak RSS fell from 261.4 to 157.0 MiB for that fixture and from 274.5 to 247.7 MiB for unused-token edits. These RSS values exclude child processes.

All seven esbuild fixtures retained equal raw/gzip/Brotli JS and CSS sizes, CSS hashes and runtime export hashes through the measured edits. This is a build-work reduction, not an application bundle-size or runtime-render optimization.

The changes do not improve every workload: tiny vanilla-extract styles added 44.9 ms (+7.4%) cold and 15.0 ms (+5.9%) on restart. Used-token edits still perform the necessary work and rose by 23.1 ms (+4.4%). The evaluation cache adds serialization, hashing and disk I/O; `cache: { type: "filesystem", evaluationResults: false }` disables that layer while keeping the other caches and guarded VM reuse.

After the measured build/edit/restart sequence, the helper fixture retained 4.63 MiB of disk entries versus 2.80 MiB at baseline, and vanilla-extract retained 1.53 versus 0.98 MiB. Ordinary TS retained no compilation entries versus 4.28 MiB. These are fixture totals after several source versions, not per-build write volumes; the existing 256 MiB disk limit still applies.

Independent diagnostics confirmed 23 helper-cache hits after the first of 24
identical calls. Each unchanged rebuild reused 24 evaluation results and performed
zero VM evaluations; each unused-export edit reused 24 transforms and 24 evaluation
results. A one-owner Vite client/SSR probe recorded zero additional parser misses
in SSR (eight parser hits); three JS-only edits retained identical CSS in every
publication. Diagnostics timings are excluded from the table.

Reproduce the esbuild comparison after packing both built revisions with the existing `--pack` command:

```sh
node scripts/benchmark-compilation.mjs \
  --baseline=/path/to/baseline-consumer \
  --candidate=/path/to/candidate-consumer \
  --rounds=5 --formats=esm --bundlers=esbuild --restart \
  --cases=plain-240,styles-24,vanilla-24,logic-24,helpers-24,tokens-used-24,tokens-unused-24 \
  --output=.cache/compilation-benchmark/analysis-seven-final-esbuild
```

The local raw report is `.cache/compilation-benchmark/analysis-seven-final-esbuild/report.json`. Development fixtures now invoke watcher hooks as well as invalidating Vite modules, so build-time-only dependencies are actually refreshed.

Vite development measurements used the same toolchain and five-round method.

| Vite development fixture       |     First graph | Unchanged |          Edited |         Restart |
| ------------------------------ | --------------: | --------: | --------------: | --------------: |
| 24 styles, owner JS-only edit  | 1636.0 → 1737.0 | 0.5 → 0.4 |     70.9 → 81.4 |  1411.7 → 919.0 |
| 24 users, unused token changed | 1640.9 → 1690.4 | 0.4 → 0.4 | 2229.0 → 1415.3 | 1646.2 → 1351.0 |
| 24 styles, client + SSR        | 3119.3 → 3322.2 | 1.1 → 1.4 |   157.6 → 175.4 | 2776.8 → 1711.9 |

Unused-token edits improved 36.5%, and restarting client + SSR improved 38.3%. First-graph work increased 3.0–6.5%; JS-only edits increased by 10.5 ms for client and 17.8 ms for client + SSR. Vite already serves unchanged requests from its own module cache, so sub-millisecond differences there are not evidence of a Mincho speedup.

CSS equality avoids replacing an identical virtual stylesheet, but these timings do not measure browser style recalculation or rendering. This implementation is most useful for repeated analysis, unused dependency edits and process restarts; it does not eliminate every small-module overhead.

Reproduce with `--bundlers=vite-dev --cases=logic-24,tokens-unused-24,environments-24 --rounds=5 --formats=esm --restart`. The local report is `.cache/compilation-benchmark/analysis-seven-final-vite/report.json`.

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

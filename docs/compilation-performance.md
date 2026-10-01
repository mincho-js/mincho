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

`optimize.staticRecipes` defaults to `true` in build integrations. Calls to
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
comparison uses the supplied plugin options for each revision.

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

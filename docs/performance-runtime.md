# Runtime optimization and measurement

Mincho removes work when the compiler can prove its result, then uses small
runtime helpers for the remaining dynamic inputs. `optimize.runtimeCodegen` and
`optimize.jsxRuntimeGuards` default to `true` in production integration profiles
and `false` in development. The guarded public JSX runtimes remain the fallback
for calls whose props cannot be proved safe.

Use `@mincho-js/css/classname` for application-side `cx` calls. Its ESM and CommonJS
entries export the same function as their respective root entry without loading
CSS authoring, theme, or registry code. The root package retains its authoring
side effects. Generated helper cleanup and the canonical recipe order apply
independently of the optimization profile.

## Recipe order and runtime contracts

Recipe output order is base classes, selected variants in
`Object.keys(mergedVariantClassNames)` order, then matching compound classes in
declaration order. `recipe.variants()` reports that same variant order. Argument
key order no longer controls the string; array selections still use the final
value for a repeated variant. Defaults, nullish fallback, and strict compound
comparisons remain intact. `true` and `"true"` can select the same variant class
while matching different compounds.

This is a breaking string-order change, with no legacy ordering switch. CSS rule
emission order is unchanged. `defineRules.cx` still resolves registered writes
in input order, so its result can change when given a reordered recipe string.

The existing direct factories continue to support their mutable input contracts.
Serialization selects separate compiled factories whose private configuration
and class-write artifacts are immutable. Input objects are normalized on every
call, including getter and callback execution on cache hits. Caches use normalized
values rather than object identity. Related inherited getters bypass recipe
result caching. Public `.variants()` and `.classNames.variants` accesses continue
to return fresh snapshots; closed compiler-proven consumers can omit unused
metadata.

## Cache policy and costs

Compiled recipe factories lazily prepare variant names and compound-check keys.
An estimated work count sums variant count, compound count, and compound key
count. Recipes below 32 use those indexes without a result cache. More complex
recipes run eight calls before creating a result cache. Every subsequent window
of 64 calls must contain at least 16 cache hits; otherwise the factory clears its
cache and releases its lookup data for the rest of that instance's lifetime.
This policy favors repeated expensive selections and bounds the overhead when
inputs have little reuse. It deliberately does not retry caching after a later
workload change.

Eligible finite state spaces of at most 256 states use compact table keys;
larger or out-of-domain selections use typed normalized keys. `true`, `"true"`,
and numeric selections remain distinguishable for compound checks. Each active
result cache has at most 256 entries and accounts for at most 65,536 UTF-16 code
units across keys and result strings. This is a retained-string budget, **not a
JavaScript heap-byte limit**: maps, objects, string representations, and prepared
indexes also occupy memory.

Compiled `defineRules.cx` factories prepare class and segment indexes on first
use, reuse validated segments, and cache normalized results. Segment entries and
results share the same entry/string budget. Inputs longer than 4,096 code units
bypass caching. Unknown class tokens and their duplicates remain unchanged, and
invalid segment markers retain their ordinary semantics. Live authoring registry
merging is not memoized.

Cache machinery and preparation add JavaScript bytes and first-use work. Small
recipes avoid result caches because the initial unconditional recipe cache was
slower in the measured cold, hot, and low-reuse cases. Scoped `cx` has a more
expensive merge step and benefits much more from repeated inputs. Compiler folding
can remove a call and its helper entirely; that is separate from the runtime
measurements below.

## Reproduce the measurements

```sh
mise exec -- yarn workspace @mincho-js/css build
mise exec -- yarn node --expose-gc scripts/benchmark-runtime.mjs \
  --baseline-ref e257bbdf --iterations 20000 --rounds 5 \
  --heap-instances 128 --output /var/tmp/mincho-runtime.json
```

Run without concurrent builds. The baseline is the actual historical TypeScript
factory implementation at the given Git commit, transpiled into a temporary
module tree using the current pinned compiler and dependencies. It is not an
alias for today's direct factory. The candidate is the last built ESM runtime;
build it after changing source. The report records source and built-artifact
fingerprints and rejects a run if either changes during measurement.

Each case rotates implementation order, performs two warmup rounds, and records
the median and quartiles of the requested sample count. Cold cases include factory
creation, with at most 1,000 operations per sample. Steady-state cases create
their factories and inputs before the timer. The 512-state/input cases exceed
the cache entry capacity and exercise low reuse. A separate 64-compound fixture
checks repeated expensive recipe selections. The historical key-permutation
case intentionally has the old ordering contract; all other fixture outputs are
checked for equality before timing.

“Cold” here means fresh factory instances. Module imports and the engine's JIT
state are shared across samples; this is not a process-startup benchmark.

With `--expose-gc`, the heap report retains 128 independent factories, explicitly
collects garbage, and reports the median of three retained-heap deltas. Shared
fixture/configuration objects are excluded. Small or negative individual deltas
are engine noise, not evidence of negative memory use. The measurements do not
cover React rendering, browser style recalculation, network transfer, compiler
folding, or whole-application latency.

The package contract fixture bundles real runtime imports in ESM and CommonJS,
checks authoring-module absence, and reports raw and gzip bytes. Its pure `cx`
consumer must remain below 4 KiB minified; timing numbers are not CI pass/fail
thresholds. The full package contract repeats these checks in installed npm and
strict Yarn PnP consumers, including conditional declaration exports.

## Recorded local comparison

A quiet run on 2026-09-20 (KST) used Node 24.21.0 on Linux x64, an Intel
Core i5-8265U, and the command above. The historical revision was
`e257bbdfcda56f541780b5b48e94186672824053`; the candidate was the uncommitted
implementation on that revision. Its runtime source fingerprint was
`8a60a93317f37671dcccacf146e5bce63966d7aa60382c87176c074aba54a579` and built
artifact fingerprint was
`ebc3b5c9b5565cc2613af4853828f324cbfcd923245a751b12098905ca514d6f`.

Times are median microseconds per operation. “Current direct” uses the current
canonical factory without result caching; it is not the historical baseline.
The compiled column includes preparation and metadata differences as well as
adaptive caching. All three columns retain the full public metadata API.

| Scenario                                | Historical | Current direct | Current compiled |
| --------------------------------------- | ---------: | -------------: | ---------------: |
| Recipe definition, unused               |      1.265 |          1.028 |            1.139 |
| Recipe definition and first call        |      2.259 |          1.709 |            2.034 |
| Small recipe, repeated selections       |      0.688 |          0.790 |            0.804 |
| 64-compound recipe, repeated selections |      8.334 |          8.193 |            2.460 |
| Recipe key permutations                 |      0.692 |          0.772 |            0.815 |
| Recipe, 512 selections with low reuse   |      2.889 |          3.118 |            3.095 |
| Scoped cx definition, unused            |      1.100 |          1.257 |            0.176 |
| Scoped cx definition and first call     |     12.755 |         11.942 |           13.214 |
| Scoped cx, repeated inputs              |     11.737 |         11.566 |            0.545 |
| Scoped cx, 512 inputs with low reuse    |     14.466 |         14.295 |           15.735 |

The expensive recipe and repeated scoped merge were about 71% and 95% faster
than the historical implementation in these fixtures. Small recipe calls were
about 17% slower than historical, and close to current direct calls (+1.7%).
Low-reuse recipes were about 7% slower than historical; low-reuse scoped merging
was about 8.8% slower. Caching therefore does not improve every workload.

The cold recipe measurements were noisy: historical first-call samples ranged
from 1.51 to 8.41 microseconds, while compiled samples ranged from 1.79 to 3.69.
The apparent historical cold improvement is not a reliable speedup claim.
Compared with current direct, the compiled first-call median was 19% higher.
Scoped cx first-call cost was about 3.6% above historical and 11% above current
direct. These first-use costs remain even when steady-state calls improve.

Approximate retained bytes per factory after explicit GC:

| Scenario                                | Historical | Current direct | Current compiled |
| --------------------------------------- | ---------: | -------------: | ---------------: |
| Recipe, unused                          |        701 |            804 |              836 |
| Small recipe, repeated selections       |        740 |            804 |            1,148 |
| 64-compound recipe, repeated selections |        830 |            941 |           14,786 |
| Recipe, 512 selections                  |        864 |            961 |            2,445 |
| Scoped cx, unused                       |      1,074 |          1,105 |              386 |
| Scoped cx, 512 inputs                   |      1,226 |          1,178 |           49,947 |

An earlier unconditional recipe-cache candidate retained about 269 kB per
factory in the same 512-selection fixture and regressed low-reuse calls by 69%.
The adaptive policy releases those result strings and keeps only the prepared
variant/compound indexes. An active cache still trades memory for repeated-call
speed; the table's heap values are observations, not maximum heap guarantees.

The installed npm consumer produced these minified runtime bundle sizes. The
same import, type, tree-shaking, and compiler-output checks also passed in strict
Yarn PnP consumers.

| Consumer                               | ESM raw / gzip bytes | CommonJS raw / gzip bytes |
| -------------------------------------- | -------------------: | ------------------------: |
| Unused pure factories, one live export |              37 / 57 |                 478 / 307 |
| Direct recipe plus scoped cx           |        3,337 / 1,481 |             3,778 / 1,673 |
| Compiled recipe plus scoped cx         |        6,116 / 2,516 |             6,560 / 2,697 |
| Pure classname cx                      |            829 / 431 |               1,107 / 579 |

The compiled recipe/merge pair costs about 2.8 kB more raw JavaScript, or 1 kB
more gzip, than the direct pair in this small fixture. Individual gzip sizes
describe these complete bundles, not the sum of separately compressed modules.
No React code, CSS asset, browser layout, or application code is included in
these sizes. Compiler folding and metadata pruning can remove additional code
in actual applications; this runtime-only fixture does not measure that effect.

The installed consumer also measures actual compiler output. These minified
fixture bundles keep React external, compare optimization off/on, and assert
CSS and server-rendered markup parity:

| Styled fixture         | Wrapper count off → on | ESM raw / gzip bytes off → on | CommonJS raw / gzip bytes off → on |
| ---------------------- | ---------------------: | ----------------------------: | ---------------------------------: |
| Static styled element  |                  1 → 0 |     4,867 / 2,087 → 262 / 218 |          5,352 / 2,297 → 749 / 472 |
| Dynamic styled element |                  1 → 0 | 4,719 / 2,014 → 4,931 / 2,086 |      5,196 / 2,212 → 5,411 / 2,280 |
| Nested styled chain    |                  2 → 1 | 4,897 / 2,046 → 5,273 / 2,192 |      5,374 / 2,247 → 5,781 / 2,390 |

Static folding removes most of its fixture's JavaScript. Dynamic flattening and
chain compilation remove React wrappers while increasing these small bundles by
about 0.2–0.4 kB raw. The generated selection/evaluation-order code and staged
chain runtime explain that tradeoff. Wrapper counts and markup parity are
verified here; React render/reconciliation latency has not been measured.

The JSX code-generation fixture emitted 1,107 raw / 562 gzip bytes in ESM and
1,542 / 766 in CommonJS with either `verbatimModuleSyntax` setting. Its metafile
contains neither authoring modules nor guarded JSX runtime modules. Those sizes
include the fixture's generated JSX code and differ from the pure `cx` import
fixture above.

Uncacheable values retain ordinary coercion/getter behavior. Very large inputs
can still require allocation and linear processing even when they exceed the
cache's retention budget. Prototype properties may force recipe cache bypass,
and low-reuse detection uses a finite sample rather than predicting future
inputs. Measure the application's own selection distribution, startup path,
retained heap, and emitted assets before extrapolating these local timings.

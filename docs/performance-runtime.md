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
recipe result cache has at most 256 entries and accounts for at most 65,536 UTF-16 code
units across keys and result strings. This is a retained-string budget, **not a
JavaScript heap-byte limit**: maps, objects, string representations, and prepared
indexes also occupy memory.

Compiled `defineRules.cx` factories prepare class and segment indexes on first
use and reuse token/write-ID data for repeated string arguments. Scalar string
tuples can skip normalization; objects and arrays still run clsx on every call.
Their per-argument strings can then reuse a tuple before concatenation or the
whole-string result lookup. Adaptive tuple/sequence caching,
prepared fragments and second-chance result eviction share the same 1,024-entry /
131,072-unit budget. A fragment's first sighting retains only its key; token/ID
copies are prepared on a repeat. Fragment keys and retained token strings both
count toward that allowance. Segment validation still checks each required write
ID, including segments that cross argument boundaries; a marker alone never
proves validity.
Fragment preparation starts when tuple reuse is ineffective or unavailable,
so factories already served by tuple hits avoid retaining redundant token data.
After a tuple miss, primitive string/falsy arguments use a compacted local
rest array and `join` to form the result-cache key. Mixed values are normalized
in order into that private array; neither caller arrays nor objects are modified.
Inputs longer than 4,096 code units bypass caching. A direct character scanner
preserves unknown tokens, duplicates, whitespace normalization and invalid marker
semantics. Live authoring registry merging is not memoized. Tuples accept 2–8
arguments after normalization and initially reserve 512 entries / 16,384 units from the
total allowance. They can borrow more string space as needed, evicting only the
necessary result/fragment entries without raising either total limit. Rotation
or a result too large for the remaining space returns the borrowed allowance.
The first 512 lookups allow a full retained tuple set to warm before judging
reuse. Each subsequent 64-lookup window requires at least 16 hits; otherwise
tuple caching is released. Entries and strings are allocated only as needed;
the larger limits do not preallocate space for 512 tuples. After 32 consecutive hits on the same
result-cache entry, a normalized tuple can reactivate it once. A second failure
is permanent, preventing repeated allocation for changing tuples that normalize
to the same string. Prediction is disabled independently under the same
threshold. Every tuple or prediction hit requires exact ordered string matches;
two/three-argument predictions compare the first string slots directly. Tuples
with at most three nonempty strings initially retain only those slots; a wide
prediction adds their array representation lazily. Longer tuples keep their
array from insertion. Predictions for up to eight arguments
can return before the general merge wrapper. Four-to-eight-argument calls pass
fixed slots, avoiding a second rest array, only while prediction has an entry to
check. A predicted hit
advances only the window counter. Non-predicted lookups count misses instead of
hits, preserving the same 16-of-64 retention boundary while avoiding two writes
on hot hits.
After the outer probe misses, the general lookup skips a duplicate prediction
for scalar arguments. Resolved objects and arrays retry with their strings.
Recovery compares entry identities without copying or comparing another
string. A unary string cache hit also returns before the general wrapper.
Mutable inputs still reach clsx on every call, in the original evaluation order.
A single array can also supply normalized tuple slots. Its length is captured
once and truthy indices are read twice, matching clsx even when accessors change
their values between reads. This also applies to arrays returned by `cx.with`.
The tuple index initially uses the first truthy string as its key, stores each
entry directly without a bucket array, and verifies the complete tuple. If a
first string is shared, retained entries switch to
their sampled hashes until the next clear. This skips per-argument hash work
for unique prefixes without introducing long shared-prefix buckets. The switch
is bounded by 512 entries and each entry retains its hash for that conversion.

On the second actual merge, compiled factories prepare a `Uint32Array` of write
generations for dense integer IDs below 4,096. This avoids allocating a `Set`
on subsequent merges. Its separate buffer is at most 16 KiB; the UTF-16 cache
budget does not include it. Factories served by a single merge plus cache hits
never allocate the buffer. Sparse or unusual IDs use `Set`, as does the mutable
direct factory. Marks are only used after getter/segment evaluation finishes,
and are cleared when the unsigned generation wraps. When no segment markers
exist, merging also skips construction of an unused write-sequence string.

After 16 actual merges, eligible compiled factories can also prepare a class-name
index and reusable numeric token spans. This path records offsets and write IDs
without creating a substring for each token. Hashes select a lookup bucket;
length and exact string comparisons determine identity. Segment markers still
validate their following writes. Nested merges use the ordinary path while a
buffer is active, and exceptions release it. ASCII whitespace checks have a
short path; non-ASCII input keeps the full ECMAScript whitespace contract.

This index is limited to 1,024 registered class/marker entries and the existing
dense-ID limit; it only serves inputs within the 4,096-unit cacheable limit.
Initialization waits while scalar tuple reuse remains effective. The lookup and
retained token buffers together use at most 24 KiB of additional typed storage,
plus an array of references to existing registered names. Inputs with more than
1,024 tokens use temporary overflow storage. These buffers are separate from
both the write-generation buffer and retained-string budget. Unsupported inputs
and the mutable direct factory retain the ordinary scanner.

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
their factories and inputs before the timer. The 512-state/input cases exceeded
the cache entry capacity in the initial comparison; later scoped-cx capacity
changes are measured separately below. A separate 64-compound fixture
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

This table records the initial sixteen optimizations, **before** the subsequent
cx changes. Its cx timings, heap, and combined helper bundle sizes are historical
observations; the [additional scoped cx comparison](#additional-scoped-cx-comparison)
below records the newer results.

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

## Additional scoped cx comparison

The seventeenth optimization was measured against a source and build snapshot
of the completed sixteen optimizations, including their existing compiled cx
cache. On the same machine and Node version, isolated processes with four warmup
blocks and seven samples of 50,000 operations produced these median times:

| Scenario                             | Before |  After |
| ------------------------------------ | -----: | -----: |
| Two string arguments                 |  0.656 |  0.100 |
| Existing repeated-input fixture      |  0.556 |  0.072 |
| Existing 512-input low-reuse fixture | 16.131 |  3.082 |
| Definition and first call            | 26.206 | 19.543 |
| Definition, unused                   |  0.130 |  0.151 |

Times are microseconds per operation. First-call samples use 4,000 operations;
the shorter unused-definition case uses nine samples of 100,000 operations.
These are function timings, not application or React rendering speedups.
The actual scoped-cx consumer adds 2,874 raw / 941 gzip bytes in ESM and
2,912 raw / 952 gzip bytes in CommonJS. Approximate retained heap per factory
increases from 21.7 to 35.7 kB for 64 recurring tuples, but decreases from 49.8
to 43.7 kB for the existing 512-input fixture. String budgets do not bound heap.

To compare a future change, build and snapshot before editing, then rebuild and
measure. The harness checks output parity and source/build fingerprints, records
all samples and quartiles, and runs allocation/heap sampling separately. Warmup
and timing use the same loop. `--processes 3` repeats each comparison in three
independent processes with alternating implementation order. Heap and external
ArrayBuffer bytes are reported separately; ArrayBuffers already count toward
external memory and must not be added to it twice.

```sh
PACKAGE_PUBLISH=true mise exec -- yarn workspace @mincho-js/css build
mise exec -- yarn benchmark:cx --snapshot /var/tmp/mincho-cx-before
# Apply the change, then rebuild without concurrent builds.
PACKAGE_PUBLISH=true mise exec -- yarn workspace @mincho-js/css build
mise exec -- yarn benchmark:cx --baseline /var/tmp/mincho-cx-before \
  --published --processes 3 --rounds 9 --output /var/tmp/mincho-cx-comparison.json
```

Uncacheable values retain ordinary coercion/getter behavior. Very large inputs
can still require allocation and linear processing even when they exceed the
cache's retention budget. Prototype properties may force recipe cache bypass,
and low-reuse detection uses a finite sample rather than predicting future
inputs. Measure the application's own selection distribution, startup path,
retained heap, and emitted assets before extrapolating these local timings.

A further 2026-09-20 comparison used a local pre-amend source/dist
snapshot (`3c469b7f`), Node 24.21.0 and the same i5-8265U. Published runtimes ran
in three independent processes per case, with six warmup blocks and nine samples
per process. Most blocks contained 100,000 calls; unique/large-conflict cases
used 20,000, and first-call/long-string cases used 4,000.

| Scenario                                     | Before, ns | After, ns | Change |
| -------------------------------------------- | ---------: | --------: | -----: |
| One cached string                            |       63.4 |      53.3 | -16.0% |
| Two strings                                  |       60.2 |      40.0 | -33.5% |
| Three conditional arguments                  |       76.3 |      42.4 | -44.5% |
| Unique inputs followed by one repeated tuple |      258.3 |     114.4 | -55.7% |
| 24 write IDs, 16 tokens, no markers          |    5,889.9 |   4,451.1 | -24.4% |
| 256 write IDs, 64 tokens, no markers         |   23,586.2 |  18,345.4 | -22.2% |
| Unique object inputs                         |    3,483.2 |   3,892.2 | +11.7% |
| Long cacheable strings                       |    4,628.3 |   5,099.2 | +10.2% |
| Existing 512-input legacy fixture            |    2,103.5 |   2,338.7 | +11.2% |

First-call and unused-factory time remained within the observed variation.
Ordered/random 64-tuple cases changed by +3.3%/+2.4%, with overlapping quartiles.
The scoped consumer grew by 1,359 raw / 499 gzip bytes in ESM and 1,436 raw /
516 gzip bytes in CommonJS. With 64 tuples, retained heap grew from 35,747 to
36,035 bytes per factory, plus a 96-byte ArrayBuffer. The 256-ID fixture added
269 heap bytes and a 1,024-byte buffer. Approximate sampled allocations in that
fixture fell from 12,811 to 5,947 bytes/call; sampling includes preparation and
is not an exact allocation count. These gains do not imply faster application
rendering, and the measured 10–12% regressions remain relevant to low-reuse users.

The chosen changes specialize scalar predictions, recover tuple caching once,
reuse bounded numeric marks and skip unnecessary marker work. Second-chance
eviction and string budgets remain unchanged. At that stage, broader token
buffers, larger tuple caches and admission filters were deferred because of
startup, per-factory memory or bundle costs. The later comparison below revisits
token buffers with exact name lookup. Per-argument object normalization was also deferred:
its hot-case gains came with extra retention and slower unique inputs. Mutable
objects and arrays continue through the original clsx implementation every time.

### Further merge-path improvements

A subsequent comparison uses the source/dist snapshot taken immediately before
this change (`f90fa9e7`), not the earlier sixteen-optimization baseline. Node
24.21.0 on the same i5-8265U ran the final published runtime in three isolated
processes per implementation/case, alternating order, with six warmup blocks and
seven timed samples each. Ordinary blocks used 50,000 calls, unique blocks 20,000,
first-call/long-string blocks 4,000, and unused-factory blocks 100,000. Builds
finished before timing; source/build fingerprints and output parity were checked.

| Scenario                          | Before, ns | After, ns | Change |
| --------------------------------- | ---------: | --------: | -----: |
| Two cached string arguments       |       45.3 |      45.2 |  -0.3% |
| Three conditional arguments       |       48.4 |      53.2 |  +9.9% |
| 128 recurring combinations        |      528.8 |     478.2 |  -9.6% |
| 512 recurring combinations        |    3,688.8 |   1,917.2 | -48.0% |
| Unique SSR, recurring base string |    4,443.8 |   3,179.5 | -28.5% |
| Unique SSR, changing base string  |    5,011.8 |   5,274.0 |  +5.2% |
| Segments split between arguments  |    3,856.3 |   2,315.9 | -39.9% |
| 16 long cacheable tuples          |    4,440.6 |     140.7 | -96.8% |
| Long single-token cache bypass    |   87,576.7 |   3,948.9 | -95.5% |

Times are medians of 21 samples. The 512-combination interquartile range was
3,538–3,806 ns before and 1,809–2,034 ns after; recurring-base SSR was
4,283–4,487 versus 3,131–3,411 ns. Small-hit results were less stable: two
arguments had overlapping 37–51 / 39–52 ns quartiles, and three had 42–54 /
48–66 ns. One cached string's median rose 15.3%, also with overlapping quartiles.
Changing-base SSR was 4,916–5,355 / 4,997–5,554 ns; less reusable input still
pays fragment probes. This change does not improve every workload.
Unused-factory creation remained about 156 ns; first-call medians were
17.2 / 16.3 microseconds with overlapping quartiles.

The adopted changes reuse scalar fragments' tokens and raw write IDs, share
unused string allowance with tuples, and join scalar cache keys using the local
rest array. Segments are still validated, including those spanning fragments.
The long-bypass fixture benefits from the single-token whitespace check, not a
cache hit; arbitrary long, whitespace-heavy input still needs linear scanning.
Prepared fragments alone reduced the 512-input time by about 41% in an earlier
isolated experiment. Comparing the final `join` candidate only against the
fragment/borrowed-budget implementation reduced 128/192-combination medians by
about 12% and 512-combination retained heap from 79,867 to 65,655 bytes.
Requiring a second fragment sighting reduced changing-base SSR heap from
123,876 to 52,472 bytes in a separate source comparison, for about 10 gzip bytes;
its time quartiles overlapped, so the adoption is primarily a memory improvement.

Final retained heap, measured separately with 32 factories per sample, changed
from 67,948 to 65,422 bytes per factory for 512 combinations and from 73,238 to
65,464 for split segments. Recurring-base SSR retention was 65,470 / 65,694 bytes,
changing-base SSR was 67,384 / 52,375 bytes, and 64 recurring tuples stayed about
36 kB. The long-tuple improvement retains more
useful entries: heap grew from 14,528 to 42,461 bytes. All caches still share
256 entries / 65,536 UTF-16 string units; that allowance is not a heap-byte cap.
Approximate sampled allocations fell from 1,884 to 1,337 bytes/call for 512
combinations and from 1,469 to 1,015 for recurring-base SSR. Allocation sampling
includes preparation and is not an exact per-call count.

The actual scoped consumer grew from 8,580 / 3,106 raw/gzip bytes to
10,367 / 3,727 in ESM, and from 9,239 / 3,368 to 11,037 / 4,035 in CommonJS.
Native regex tokenization and a named-parameter call front were rejected after
common-case regressions. Per-argument object/array normalization was rejected
after small hot-case gains increased retained heap substantially; mutable values
still reach clsx on every call. These function measurements do not establish an
application or React rendering speedup.

For a separate `cn` comparison, both implementations received the same 24 class
spellings in six non-overlapping groups and produced equal output in 21,578
checks. This fixture has no Mincho segment markers; `cn` uses the full default
tables from commit
[`398d55a7`](https://github.com/shadcn-ui/cn/blob/398d55a74203157a128d5ae291fba18ff936cd8a/packages/cn/src/engine.ts).
Each implementation/case again used three isolated processes, six warmup blocks
and seven samples. Blocks used 500,000 hot calls, 100,000 object calls, 50,000
512-combination calls, 10,000 unique calls, 20,000 long-string calls, or 300
factory/first calls. Imports and table loading are outside the timing.

| Same-output scenario, ns/call        | Mincho before | Mincho after |        cn |
| ------------------------------------ | ------------: | -----------: | --------: |
| Two cached string arguments          |          31.5 |         32.4 |      25.2 |
| Three conditional arguments          |          36.1 |         38.9 |      30.7 |
| Object/array inputs                  |         728.5 |        697.2 |     359.7 |
| 512 combinations with changing bases |       4,505.1 |      4,081.5 |      49.5 |
| Unique SSR with changing bases       |       5,752.9 |      6,266.3 |   5,658.2 |
| 16 long cacheable tuples             |       4,266.2 |         83.3 |      55.0 |
| Factory and first call               |      10,122.0 |      9,642.0 | 152,916.9 |

The long-tuple gap shrank from about 78x to 1.5x. Warm two/three-argument calls
remain about 1.3x slower than `cn`; neither implementation parses grammar on
these cache hits. The 512-combination gap remains about 82x because `cn` can
serve this set from its much larger caches (`cacheSize=8192` plus larger tuple
generations), whereas Mincho preserves its shared 256-entry/string allowance.
These are unequal cache budgets, not a measurement of parser cost alone.
Changing-base SSR remains a limitation: the Mincho medians rose 8.9% in this
fixture, with overlapping 5,630–5,984 / 5,694–6,689 ns quartiles. Its final
per-process medians also varied from 5,694 to 7,256 ns. The lower Mincho factory
cost includes only six registered groups, while `cn` initializes its broader
default configuration; it is not a general startup-speed ratio for applications.

### Exact token classification

This follow-up compares against the **uncommitted implementation immediately
above**, not HEAD. Its source/dist snapshot fingerprints start with
`75f0a51b` / `ed5aab60`; the new implementation's are `b36d2e45` / `404f5eb8`.
The same Node version and CPU were used. Published-runtime measurements again
use three isolated processes, six warmup blocks and seven samples per process,
with the block sizes described above. All 167,280 ESM/CommonJS comparisons
against the preceding implementation passed for both factories.

The adopted path combines numeric token spans, an exact class-name index,
short ASCII whitespace checks, and an integer end-of-input sentinel instead of
reading past the string's end. Hash lookup verifies names before using their
write IDs; it avoids allocating a token substring before classification.
Reusing ordinary JavaScript arrays regressed four of five isolated merge
medians and was rejected. Typed spans that still sliced every token and used
`Map.get` barely improved the 32-token cases. The combined index/span candidate
was 27–43% faster than the simpler ASCII/sentinel scanner in a separate paired
experiment; individual improvements are not additive.

To distinguish merging from cache policy, a separate internal-entry benchmark
disables both implementations' whole-result caches and bypasses argument
wrappers. Mincho's fragment cache is also absent; `cn` retains its warmed token
memo. It uses the same 24 class spellings in six groups, 512 input strings,
eight warmup blocks, nine samples of 10,000 operations and three isolated
processes per implementation/case. Classifier preparation is outside timing.
All 2,560 output comparisons passed. Times below are median nanoseconds/call.

| Internal merge scenario                 | Before | After |    cn |
| --------------------------------------- | -----: | ----: | ----: |
| 8 registered tokens                     |  3,420 | 1,893 | 2,120 |
| 32 registered tokens                    | 11,592 | 5,865 | 6,690 |
| 32 tokens, including unknown classes    | 12,604 | 5,701 | 8,503 |
| Segment metadata, ordinary class input  |  5,889 | 3,111 | 3,708 |
| Segment marker plus required validation |  5,981 | 3,414 | 3,474 |

The marked case adds a Mincho marker before the same CSS classes; `cn` receives
the classes without that marker. An unknown suffix prevents synthesized markers
from making outputs different. Mincho is 11–33% faster in the first three
fixtures; the marked case is effectively tied, with overlapping 3,171–3,652 /
3,373–3,616 ns quartiles. Registered 32-token quartiles are 5,695–6,081 /
6,304–7,157 ns. Known write IDs remove grammar discovery, but neither token
recognition nor segment validation is free. `cn` also avoids repeated grammar
parsing through its token memo; these results do not compare against a parser
that starts from scratch on every call.

The complete published Mincho function, including normalization and caches,
produced these separate before/after medians:

| Public runtime scenario              | Before, ns | After, ns | Change |
| ------------------------------------ | ---------: | --------: | -----: |
| 16 tokens / 24 registered write IDs  |      5,355 |     2,921 | -45.4% |
| 64 tokens / 256 registered write IDs |     20,500 |     7,778 | -62.1% |
| Unique object/array input            |      4,753 |     3,759 | -20.9% |
| Unique SSR, changing base string     |      6,991 |     4,513 | -35.4% |
| Unique SSR, recurring base string    |      4,382 |     3,637 | -17.0% |
| Segments split between arguments     |      2,839 |     2,403 | -15.4% |
| 512 recurring combinations           |      2,503 |     2,422 |  -3.2% |

The 256-ID quartiles are 19,620–21,456 / 7,645–8,003 ns; changing-base SSR is
6,847–7,391 / 4,324–4,817 ns. The 512-combination quartiles overlap, so its small
difference is inconclusive. Factory-only medians were 205 / 203 ns; first-call
medians were 22.7 / 20.2 microseconds. The new index is not prepared on first use.

Initial cache-hit measurements showed +3% for one string, +10% for long tuples
and +16% for 64 ordered tuples. A targeted follow-up increased each timed block
to 500,000 calls, with six warmups and nine samples in each of three processes.
Those medians were 50.2 / 47.6, 64.4 / 64.8 and 124.0 / 127.1 ns respectively,
all with overlapping quartiles. This does not establish a consistent cache-hit
improvement or regression; the adopted change targets actual merging.

In the 256-ID case, approximate sampled allocation fell from 5,984 to 1,133
bytes/call. Retained heap increased from 61,170 to 66,018 bytes/factory and
ArrayBuffer storage from 1,024 to 7,936 bytes. Changing-base SSR heap rose from
52,376 to 62,719 bytes, with buffers increasing from 96 to 1,892 bytes; its sampled
allocation fell from 1,338 to 740 bytes/call. The 512-combination case retained
less heap (65,422 / 61,204 bytes) but more buffer storage (96 / 1,892 bytes).
Allocation sampling is approximate and includes preparation. Heap, typed
buffers and the retained-string allowance are different quantities.

The minified scoped consumer grew from 10,367 / 3,727 raw/gzip bytes to
12,637 / 4,618 in ESM, and from 11,037 / 4,035 to 13,430 / 4,986 in CommonJS.
The extra 891 / 951 gzip bytes and per-factory numeric state buy faster merges
and fewer temporary allocations. The 1,024-name limit, delayed preparation and
existing cache limits bound that tradeoff; larger registries retain the ordinary
scanner. These function measurements do not establish application or React
rendering speedups.

Repeating the earlier public-function comparison against the pinned `cn`
revision, with both libraries' default caches enabled, gives the following
medians. This uses the same seven fixtures and process/sample counts as that
comparison; all 21,578 output checks passed again.

| Same-output scenario, ns/call        | Mincho before | Mincho after |      cn |
| ------------------------------------ | ------------: | -----------: | ------: |
| Two cached string arguments          |          41.5 |         42.5 |    32.1 |
| Three conditional arguments          |          43.2 |         50.7 |    33.6 |
| Object/array inputs                  |         885.9 |        861.4 |   511.2 |
| 512 combinations with changing bases |       4,814.4 |      2,984.7 |    56.7 |
| Unique SSR with changing bases       |       7,497.4 |      5,518.4 | 6,732.3 |
| 16 long cacheable tuples             |          93.4 |         83.1 |    73.8 |

Unique SSR is now about 18% faster than `cn` in this fixture, while warm scalar
hits remain 1.3–1.5x slower and object/array calls 1.7x slower. The three-argument
case regressed 17.4% from its immediate baseline (41.0–44.6 / 45.1–55.2 ns
quartiles), although the broader published fixture above moved in the opposite
direction. The new merge path does not guarantee a faster cache hit. The
512-combination gap falls from about 85x to 53x, but still compares Mincho cache
misses with `cn` cache hits. This merge experiment kept the retained-string
budget fixed; the subsequent capacity comparison below revisits that choice.
The pure-merge results and default-cache
results answer different questions and should not be combined into one ratio.

### Larger scoped cache working sets

The next change raises the shared scoped-cx limits to 1,024 entries and 131,072
UTF-16 units, with at most 512 argument tuples. Its 512-lookup warmup is tied to
that tuple capacity; subsequent 64-lookup windows retain the existing 25% hit
requirement. The initial tuple string reservation remains 16,384 units, with
borrowing inside the shared allowance. Recipe caches and the 4,096-unit input
bypass are unchanged. No storage for the full capacity is preallocated.

An isolated experiment first varied these limits independently. In the
512-combination fixture, changing only the entry limit gave 2,660 → 1,464 ns,
also doubling the string allowance gave 654 ns, and raising the tuple limit
without its warmup gave 630 ns. Raising the warmup too gave 54 ns. The fixture
needs 73,590 units for normalized keys/results, exceeding the old 65,536 limit;
the old tuple reuse check also disabled caching before the second cycle. This
experiment used in-memory copies of one published bundle, not modified sources.

The implemented version was then measured against the uncommitted source/dist
snapshot immediately preceding this change (`b36d2e45` / `404f5eb8`). The new
fingerprints start with `621c2ca0` / `526b40e1`. The same Node 24.21.0 and CPU
were used, with three isolated processes and seven timed samples per case.
Usual cases use six warmup blocks and up to 50,000 operations; unique/large-token
cases use up to 20,000, and cold/long-string cases up to 4,000. The new short-SSR
case uses 256 distinct inputs on each fresh instance and 79 throwaway warmup
instances, so its timed instance stays cold while the engine receives at least
20,000 warmup calls. The phase-change prefill is now 576 calls for both versions.
Unused-factory blocks use 100,000 operations.

| Public-runtime scenario                       | Before, ns | After, ns | Change |
| --------------------------------------------- | ---------: | --------: | -----: |
| 128 recurring combinations                    |        640 |       100 | -84.3% |
| 512 recurring combinations                    |      2,596 |        99 | -96.2% |
| 512 combinations with changing bases          |      2,982 |       112 | -96.3% |
| Same 512 combinations in irregular order      |      1,770 |       389 | -78.0% |
| 513 recurring combinations                    |      1,580 |       624 | -60.5% |
| 1,024 recurring combinations                  |      2,587 |       907 | -65.0% |
| 2,048 recurring combinations                  |      2,491 |     1,715 | -31.1% |
| Segments split between arguments              |      2,713 |       171 | -93.7% |
| Unique SSR with recurring base                |      4,093 |     4,193 |  +2.4% |
| Unique SSR with changing base                 |      4,723 |     4,749 |  +0.5% |
| 64 tokens / 256 write IDs, over string budget |      8,905 |    10,070 | +13.1% |

The changing-base 512-case quartiles are 2,906–3,141 / 103–121 ns; irregular
order is 1,731–1,888 / 372–408 ns. The long-token case cannot retain its working
set even with the larger string allowance and regressed in this run (8,623–9,227 /
9,592–11,212 ns). Both unique-SSR quartiles overlap. Short SSR changed from
15.8 to 14.6 microseconds with wide, overlapping quartiles; no reliable speedup
is claimed. Unused factories measured 201 / 230 ns and first calls 21.4 / 23.1
microseconds, so this run also records cold regressions of 14.4% / 8.3%.

A focused recheck used four isolated processes per implementation, balanced
execution order, nine timed samples, and 200,000 operations per unused-factory
block (4,000 first calls / 20,000 long-token calls). Factory medians were
187 / 189 ns, first calls 18.1 / 18.7 microseconds, and the long-token case
7,308 / 7,303 ns, all with overlapping quartiles. The initial cold and long-token
regressions were therefore not consistent across runs; the latter still gains
no dependable speed benefit from a cache too small for its working set.

The additional retention is material. Approximate retained heap per factory:

| Workload                         | Before, bytes | After, bytes |
| -------------------------------- | ------------: | -----------: |
| Unused                           |           450 |          450 |
| 64 recurring tuples              |        36,090 |       36,090 |
| 512 combinations, changing bases |        62,829 |      221,098 |
| Unique object/array inputs       |        58,992 |      186,386 |
| 256-input short SSR              |        34,724 |       90,492 |

These figures exclude shared input/configuration fixtures and use at most the
first 1,024 inputs in the retained-heap pass. They are not worst-case heap
bounds or measurements of a whole application's memory. The 512-case's tracked
ArrayBuffer storage fell from 1,892 to 96 bytes because tuple hits avoid the
additional token index. Sampled allocation in the recurring-base unique case
rose from 655 to 1,062 bytes/call over the separate first-2,000-call sample,
including preparation: the longer learning window allocates more before
disabling low-reuse tuples. Its full 20,000-call timing rose only 2.4%.

The ESM consumer stays at 12,637 raw bytes and changes from 4,618 to 4,625 gzip
bytes. CommonJS changes from 13,430 / 4,986 to 13,426 / 4,987 bytes. Larger
retention, not additional helper code, is the primary cost.

The separate same-output comparison against the pinned `cn` revision used its
previous fixtures and methodology. The 512-combination case changed from
3,073 to 77.8 ns, versus `cn` at 60.0 ns: the gap shrank from about 51x to 1.3x.
Quartiles were 71.1–95.6 ns for new Mincho and 52.7–63.4 ns for `cn`; the
in-memory prototype's 54 ns should not replace this deployed-code result.
Two/three-argument hits remain about 1.3x slower than `cn`, and object/array
calls about 2.1x slower. Unique SSR measured 5,643 / 6,186 / 7,627 ns for old
Mincho / new Mincho / `cn`: a 9.6% regression against old Mincho in that fixture,
with overlapping quartiles, while remaining about 19% faster than `cn`.

Validation passed 490 CSS tests (one existing skip), type checking, lint and
doctor, plus 231,036 ESM/CommonJS direct/compiled comparisons and 21,578
same-output checks against `cn`. Capacity, borrowing, eviction, recovery and
reentrant-buffer tests cover the larger limits. These measurements describe
function calls, not application or React rendering speed.

### Lower prediction-hit overhead

The next comparison uses the immediately preceding dirty source/dist snapshot
(`621c2ca0` / `526b40e1`), including the larger cache limits above, rather than
`HEAD`. The merge scanner, write IDs, segment validation, cache capacity and
public mutable factory are unchanged. This change reduces work after those
merges have already been cached:

- Two/three-argument predictions compare fixed string fields and the exact
  truthy count. Short tuples retain no separate argument array. All falsy
  positions, ordered equality and hash-collision checks remain supported.
- Predicted hits advance one counter. Misses are counted separately; more than
  48 misses in 64 lookups is exactly the former fewer-than-16-hits boundary.
  The 512-lookup warmup, independent prediction cutoff and one-time recovery
  are unchanged.
- Four-to-eight-argument predictions can return before the general wrapper,
  but are attempted only while a prediction exists. Arguments are forwarded
  variadically, and the general lookup skips a probe already tried outside.
  Objects, arrays, getters and helper callbacks still take their existing
  evaluation paths; the returned function remains non-constructible with
  `length === 0`.

Candidates were compared independently in isolated processes before choosing
the combination. Counting misses alone had small, variable benefits. Fixed
short slots and direct comparison supplied the larger hot-path improvement.
Keeping an additional array for every short tuple, borrowing the private
normalized array, named-parameter wrappers, and additional generic prefix
branches did not improve the overall tradeoff and were excluded. In particular,
the first version's unconditional many-argument probe was fast on ordered calls
but added allocation and regressed an irregular four-slot workload. A focused
comparison measured 261 / 308 / 260 ns for the baseline / unconditional probe /
guarded variadic probe; ordered eight-slot calls measured 175 / 125 / 147 ns.
The guarded version was chosen to preserve the irregular-call performance,
accepting a smaller gain on ordered many-argument calls. These candidate
numbers are not additive contributions or substitutes for the deployed-runtime
measurements below.

The final source/dist fingerprints start with `dafcd06d` / `f220294c`. The
25-case published-runtime comparison uses Node 24.21.0 on the same i5-8265U,
three isolated processes per implementation/case, seven timed samples, six
warmup blocks and the capacity section's operation counts and short-SSR
warmup. Builds finished before timing began. Selected results, in ns/call:

| Scenario | Before | After | Change |
| --- | ---: | ---: | ---: |
| Two strings | 50.7 | 41.2 | -18.6% |
| Three conditional arguments | 64.1 | 46.3 | -27.6% |
| Eight argument slots | 212.6 | 174.0 | -18.2% |
| Ordered 64, four slots | 147.9 | 132.1 | -10.7% |
| Irregular 64, four slots | 265.3 | 257.9 | -2.8% |
| Changing-base 512 | 89.4 | 76.0 | -15.0% |
| Irregular changing-base 512 | 329.4 | 284.8 | -13.5% |
| Working set of 2,048 | 1,314.8 | 1,523.0 | +15.8% |
| Unique SSR, recurring base | 3,670.6 | 3,837.2 | +4.5% |
| Unique SSR, changing base | 4,097.0 | 4,138.9 | +1.0% |
| Short 256-input SSR request | 11,898.0 | 10,640.4 | -10.6% |

The irregular four-slot case's quartiles are 260.8–279.0 / 255.4–268.8 ns;
the intermediate version's regression is absent in this run. The 2,048-case
regression has non-overlapping quartiles (1,285.8–1,351.1 / 1,414.7–1,606.8 ns)
and is checked again below. Both unique-SSR comparisons have overlapping
quartiles. Short requests remain noisy, with quartiles of 10.98–16.66 /
10.13–13.11 microseconds. Unused factories measured 174.9 / 180.5 ns and first
calls 19.65 / 19.32 microseconds, also with overlapping quartiles. No dependable
cold-start gain is claimed.

The separate comparison against the pinned `cn` engine uses the same-output
24-class/six-group fixture, with no Mincho segment markers and the engine's
full default tables and caches. It uses three isolated processes, six warmup
blocks and nine samples: 500,000 operations for scalar/sequence cases, 100,000
for objects, 20,000 for long strings, 10,000 unique SSR inputs, and 300 first
calls. The longer blocks differ from the earlier capacity comparison; compare
implementations within this run, not its absolute times against earlier runs.

| Same-output scenario, ns/call | Before | After | `cn` |
| --- | ---: | ---: | ---: |
| One string | 33.8 | 34.7 | 34.7 |
| Two strings | 39.6 | 30.8 | 28.6 |
| Three conditional arguments | 44.1 | 32.5 | 33.5 |
| Eight argument slots | 167.6 | 152.5 | 92.7 |
| Ordered 64 | 48.5 | 37.8 | 39.5 |
| Irregular 64 | 202.8 | 180.2 | 171.3 |
| Ordered 512 | 63.1 | 40.4 | 38.5 |
| Objects and arrays | 940.4 | 801.6 | 468.1 |
| Unique SSR | 5,331.8 | 5,210.2 | 6,659.3 |
| Long strings | 89.4 | 72.4 | 71.2 |

New Mincho / `cn` quartiles are 28.9–34.0 / 27.5–29.1 ns for two arguments,
32.0–36.5 / 32.0–36.8 ns for three, and 37.3–47.8 / 37.3–40.9 ns for ordered
512. The scalar gap is much smaller; this is not a universal win. Eight-slot
and mutable-value calls still take about 1.6x and 1.7x as long as `cn`.
Both engines avoid grammar parsing and merging on a prediction hit, so this
comparison cannot demonstrate an advantage from precomputed write IDs.
First calls measured 10.33 / 11.05 / 183.12 microseconds, respectively; `cn`'s
full-table initialization differs from this small Mincho artifact and should
not be treated as an equal-configuration cold-start comparison.

Retained heap per factory, excluding shared input/artifact fixtures:

| Workload | Before, bytes | After, bytes |
| --- | ---: | ---: |
| Unused | 450 | 450 |
| Ordered 64, mixed three/four-string tuples | 36,090 | 32,250 |
| Changing-base 512, short tuples | 221,072 | 143,066 |
| Short 256-input SSR request | 90,492 | 51,587 |
| Ordered 64, eight argument slots | 37,034 | 39,082 |
| 512 tuples with split segments | 168,318 | 184,942 |

Short tuples save the array object; longer tuples retain it in addition to
the first three fields and count, so their metadata is larger. The string
budget remains a UTF-16-unit allowance, not a heap-byte ceiling. Temporary
allocation does not always decrease: the separate first-2,000-call allocation
sample, including preparation, measured 192 → 327 bytes/call for eight slots
and 176 → 208 for the irregular four-slot case. The latter intermediate probe
had measured about 260 bytes/call. Allocation sampling is approximate; it is
not a steady-state or peak-heap measurement.

The ESM consumer changes from 12,637 / 4,625 to 13,171 / 4,792 raw/gzip bytes;
CommonJS changes from 13,426 / 4,987 to 13,960 / 5,152 bytes. The additions are
534 raw bytes and 167 / 165 gzip bytes. No dependency or cache limit changed.

A focused recheck used four isolated processes per implementation, balanced
order, eight warmup blocks and nine samples. Factory blocks used 200,000 calls,
first-call blocks 4,000, irregular blocks 500,000 and over-capacity blocks
50,000. Short SSR used 32 independent fresh 256-input requests per block; no
cache survived a request boundary. Results in ns/call:

| Recheck | Before, median [p25–p75] | After, median [p25–p75] |
| --- | ---: | ---: |
| Unused factory | 180.6 [174.4–190.2] | 188.6 [180.7–197.8] |
| First call | 18,581 [17,840–19,083] | 18,616 [17,731–19,435] |
| Short SSR | 6,377 [5,614–6,743] | 6,972 [6,559–7,412] |
| Irregular 64, four slots | 250.6 [246.9–256.3] | 266.2 [251.3–275.4] |
| Working set of 2,048 | 1,299 [1,272–1,379] | 1,393 [1,283–1,494] |

The quartiles overlap, but the medians still show possible costs: about 9% for
short SSR, 6% for irregular four-slot calls and 7% for the over-capacity set.
The latter also regressed by 16% in the broader run; it should not be reported
as improved. The selection favors the consistent scalar-hit gains and reduced
retention of small tuples, with these limits and the extra many-argument
allocation made explicit. These are function benchmarks on one Node/V8 and CPU,
not measurements of application or React rendering throughput.

Validation passed 496 CSS tests (one existing skip), type checking, lint and
doctor, plus 231,036 direct/compiled ESM/CommonJS comparisons against the
immediate baseline and 21,578 same-output checks against the pinned `cn`.
New regression tests cover the exact 15/16-hit thresholds, independent prediction
cutoff, complete short-tuple matches and compact tuples in longer argument
lists. Existing tests continue to cover mutable values, exceptions, callback
order, segments, cache pressure and reentry.


### Normalized arguments and direct tuple indexing

This comparison preserves the preceding dirty source/dist (`dafcd06d` /
`f220294c`), including the previous prediction improvements, as its baseline.
The final source/dist fingerprints begin with `a3dc1a2d` / `ac289bd5`.
The changes are confined to compiled scoped `cx` input processing and caching:

- Resolve each mutable argument with clsx on every call, then probe the resulting
  string tuple before joining a full result-cache key. Two/three and four-to-eight
  resolved slots use their respective fixed-slot predictions.
- Resolve a single array into private string slots, preserving clsx's captured
  length, two reads of truthy indices, getter/exception order, and numeric values
  that change to zero or NaN between reads. Callbacks and reentry remain observable.
- Pass wide predictions as fixed arguments. Compact entries acquire an array only
  when a wide prediction needs it; subsequent comparisons index it directly.
- Index unique first strings directly to entries. A shared first string converts
  the current generation to sampled-hash buckets. Full tuple comparisons remain
  mandatory in both modes. The conversion is bounded by 512 entries, and the
  existing entry/string budgets, warmup, cutoff and one retry remain in place.

Independent source-bundle experiments rejected named/method wrappers, repeated
spread forwarding, and combined normalization/compaction because their small-call
or irregular-call costs outweighed the benefit. A two-level prefix index sped up
unique prefixes but regressed shared-prefix input; the whole-generation fallback
removed that cost. An intermediate unique-prefix index retained a one-element
bucket array per entry. Direct entry storage removed those arrays, reducing that
candidate's 512-tuple heap from about 188 KB to 93 KB in the isolated comparison.

The deployed-runtime measurements use Node 24.21.0 on an i5-8265U, sequential
isolated processes, rotated implementation order, six warmup blocks and three
processes per case. The 27-case Mincho matrix uses seven samples and the existing
worker's operation counts, 32 retained factories, and its separate allocation
sample. The pinned cn revision remains
[`398d55a742`](https://github.com/shadcn-ui/cn/blob/398d55a74203157a128d5ae291fba18ff936cd8a/packages/cn/src/engine.ts).
Its comparison uses nine samples, the same 24-class/six-group equivalent-output
fixture without Mincho markers, and cn's full default tables/caches. Scalar and
sequence cases use 500,000 calls; objects/arrays 100,000; long strings 20,000;
unique SSR 10,000. These are comparisons within this run, not against absolute
latencies from earlier sections.

| Same-output call, ns | Before | After | `cn` |
| --- | ---: | ---: | ---: |
| One string | 31.7 | 32.0 | 31.8 |
| Two strings | 31.9 | 31.3 | 27.2 |
| Three conditional slots | 31.9 | 35.8 | 32.1 |
| Eight slots, ordered | 142.3 | 86.7 | 90.8 |
| Ordered 64 | 34.2 | 36.7 | 34.8 |
| Irregular 64, three slots | 195.1 | 146.4 | 175.1 |
| Ordered 512 | 38.4 | 34.7 | 37.7 |
| Objects and arrays | 784.7 | 382.6 | 435.7 |
| Single array | 793.6 | 402.6 | 409.5 |
| Eight slots with objects | 1,253.7 | 563.3 | 586.8 |
| Eight slots, irregular, distinct first strings | 323.4 | 219.7 | 310.2 |
| Eight slots, irregular, shared first string | 324.0 | 333.4 | 547.6 |
| Unique SSR | 5,118.6 | 5,089.9 | 5,961.1 |
| Long strings | 70.7 | 71.1 | 77.4 |

For eight ordered slots, the after/cn quartiles are 84.7–88.4 / 90.4–93.2 ns;
for irregular distinct first strings they are 216.6–223.3 / 303.4–323.5 ns.
Object inputs measure 374.7–404.0 / 408.8–449.7 ns. Single-array quartiles overlap
(396.3–410.4 / 402.9–418.5 ns), so their small median lead is not a dependable win.
Two/three-string medians still trail cn by about four nanoseconds. No universal
advantage is claimed. Mincho factory/first-call medians in the native matrix are
168.5 / 18,324 ns before and 164.2 / 18,352 ns after; their quartiles overlap.
The cn first-call configuration initializes its full tables, so it is not an
equal-configuration comparison of factory costs.

| Retained heap per factory, bytes | Before | After |
| --- | ---: | ---: |
| Unused | 450 | 450 |
| 512 distinct first strings | 143,066 | 93,997 |
| 64 eight-slot tuples | 39,082 | 39,594 |
| 64 mixed three/four-string tuples | 32,250 | 35,066 |
| 16 reused object tuples | 8,664 | 12,142 |
| 64 single arrays | 24,122 | 20,634 |

The 512 distinct-prefix case retains about 34% less heap than the immediate
baseline. Other cases retain more: wide predictions may allocate compact-entry
arrays, and each entry stores a hash for index conversion. Temporary allocation
also has tradeoffs. The separate first-2,000-call sample, including preparation,
measures 325 → 222 bytes/call for eight slots, 375 → 609 for a single array, and
339 → 371 for reused object inputs. These sampled allocations are approximate,
not steady-state or peak-heap measurements. UTF-16 string budgets are unchanged
and do not represent a heap-byte ceiling.

Actual consumer ESM raw/gzip sizes change from 13,171 / 4,792 to 14,576 / 5,253
bytes (+1,405 / +461). CommonJS changes from 13,960 / 5,152 to 15,365 / 5,629
(+1,405 / +477). No runtime dependency was added.

A focused check uses four isolated processes per implementation, balanced order,
eight warmup blocks and nine samples. Hot cases use 500,000 calls, the 2,048-case
50,000, and short SSR 32 independent fresh requests of 256 inputs per block.
The phase-change case repeats its cold prefill outside each timed block.

| Focused recheck, ns [p25–p75] | Before | After |
| --- | ---: | ---: |
| One string via spread | 45.1 [44.0–46.7] | 45.5 [43.7–49.1] |
| Irregular 64, shared first string | 243.4 [239.7–251.6] | 255.8 [250.1–283.2] |
| 512 tuples | 46.7 [45.3–48.4] | 46.9 [45.4–48.8] |
| 513 tuples | 505.3 [490.9–516.2] | 513.7 [493.2–521.0] |
| 2,048 tuples | 1,286.6 [1,259.9–1,328.0] | 1,345.1 [1,286.3–1,424.6] |
| Long cacheable strings | 46.3 [45.3–49.7] | 47.0 [45.1–49.2] |
| Reuse after an earlier cold phase | 59.3 [57.2–62.5] | 59.7 [55.8–63.7] |
| Fresh 256-input SSR requests | 6,660.4 [6,047.3–7,140.7] | 6,145.1 [5,751.6–6,643.1] |

These longer blocks did not reproduce the broader run's 25% unary-spread or
13% long-string regression. Shared-prefix irregular input and the over-capacity
2,048 set still show about 5% higher medians with overlapping quartiles; those
costs remain a limitation. Short-request medians improve here, but their
quartiles overlap and no dependable SSR startup gain is claimed. Function
benchmarks do not establish application or React rendering speedups.

Validation: 500 CSS tests passed (one existing skip), type checking, CSS lint,
ESM/CommonJS builds, and doctor with zero new/stale/expired diagnostics.
Published ESM/CommonJS direct and compiled factories passed 231,804 comparisons
against the immediate baseline; cn output parity passed another 22,090 checks.
Regression tests cover normalized-value reuse and reentry, array accessors and
captured length, falsy slots and overflow past eight arguments, prefix-index
conversion and sampled-hash collisions. The native benchmark now also exposes
`array-single` as a repeatable scenario.

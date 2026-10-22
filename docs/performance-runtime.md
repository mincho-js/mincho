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
the cache entry capacity in the initial comparison; record the current limits
when comparing revisions. A separate 64-compound fixture
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

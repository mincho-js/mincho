# Runtime optimizations

Mincho reduces runtime work only when the compiler can establish the required
bindings, inputs and observable uses. Unproven calls keep the runtime path. CSS
rule emission order is unchanged by the JavaScript optimizations.

## Recipe order: breaking change

Recipe classes now use this order regardless of the argument object's key order:

1. Base classes.
2. Selected variants in `Object.keys(mergedVariantClassNames)` order, including
   toggles. This is also the order returned by `.variants()`.
3. Matching compounds in their declaration order.

Defaults, nullish fallback, array last-write-wins selection and strict compound
equality remain unchanged. For example, `true` and `"true"` can select the same
variant class but remain distinct compound conditions. There is no legacy-order
option. This change does not reorder emitted CSS.

`defineRules.cx` still resolves conflicts by the last input class. Passing a
recipe result to it therefore uses the new canonical recipe class order.

## Implemented reductions

| #   | Reduction                                   | Eligibility and fallback                                                                                                                                                                  |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pure `@mincho-js/css/classname` entry       | Generated `cx` imports use a runtime-only ESM/CJS entry; public root `cx` retains the same function identity.                                                                             |
| 2   | Inline `recipe.props`                       | A known compiled recipe and literal, known prop keys; evaluates inputs first and preserves ordinary assignment behavior. Unknown keys, escapes and spreads keep the method call.          |
| 3   | Simplify `vx`                               | Syntax-proven primitive values only; unknown values retain the scalar guard. TypeScript annotations are not proof.                                                                        |
| 4   | Elide redundant object copies               | Fresh data-only object literals or conditional fresh literals; getters, spreads, computed keys and `__proto__` remain untouched.                                                          |
| 5   | Adaptive compiled recipe cache              | Immutable compiler-produced configurations, with precomputed key order and bounded result caching for sufficiently complex, reused recipes. Direct factory use retains the uncached path. |
| 6   | Compiled `defineRules.cx` indexes and cache | Lazy rule indexes and a bounded result cache; the public direct factory keeps observable input behavior.                                                                                  |
| 7   | Fold constant `cx` arguments                | Literal scalar/array runs are joined at build time. Dynamic expressions retain evaluation order, duplicates and whitespace. Objects are not folded.                                       |
| 8   | Finite recipe branches                      | At most 4 syntactic conditions, 16 leaves and 4,096 serialized UTF-8 class bytes; retains condition order and short circuiting. No Cartesian enumeration of variant definitions.          |
| 9   | Flatten eligible dynamic styled JSX         | Closed local intrinsic components and a fixed, safe JSX shape. Public exports, unknown props, spreads, refs, polymorphic `as`, unsafe children and list/conditional use keep wrappers.    |
| 10  | Reduce `$$styled` allocations               | Removes temporary split tuples; reuses small ordinary prop objects only when inherited properties permit it. Larger objects retain the spread path.                                       |
| 11  | Collapse local styled chains                | A compiler-only chain helper keeps each stage's variant filtering, defaults and class order, with one wrapper. It does not merge recipe configurations.                                   |
| 12  | Remove unobserved recipe metadata           | Closed compiled recipes can omit unused `.props`, `.variants()` and `.classNames` setup. Observed or escaped metadata and visible prototype mutations retain setup.                       |
| 13  | Remove unused generated helpers             | Removes only unreferenced compiler-generated bindings; explicit authored side-effect imports survive.                                                                                     |
| 14  | Specialize JSX runtime guards               | esbuild proves the final file; Vite proves individual lowered calls and original import provenance. Explicit public runtime uses and uncertain transforms retain the guard.               |
| 15  | Non-inheriting generated variables          | Experimental: only generated variables proven to be consumed on the same supported intrinsic element.                                                                                     |
| 16  | Share CSS prefixes across chunks            | Experimental Vite/esbuild finalization with ordered shared CSS, asset and loading checks, and conservative fallback.                                                                      |
| 17  | Reduce scoped `cx` lookup and merge work    | Normalized tuple caching with adaptive prediction, second-chance eviction and direct token scanning; mutable inputs retain normalization and getter evaluation.                           |

## Options

The production optimization profile defaults `optimize.runtimeCodegen` and
`optimize.jsxRuntimeGuards` to `true`; the development profile defaults them to
`false`. Vite selects the profile from its `build` or `serve` command, independently
of Vite's `mode`. esbuild defaults to production, including context/watch builds;
set `optimizationMode: "development"` explicitly for that profile. Both adapters
accept `optimizationMode` and individual boolean overrides. The runtime factories'
canonical order and compiled cache behavior do not depend on these transform flags.

```ts
// Vite
import { minchoVitePlugins } from "@mincho-js/vite";

export default {
  esbuild: { jsx: "automatic", jsxImportSource: "@mincho-js/react" },
  plugins: minchoVitePlugins({
    jsxCssProp: true,
    optimize: { runtimeCodegen: true, jsxRuntimeGuards: true },
    experimental: {
      nonInheritingCssVars: true,
      cssChunkSharing: true,
    },
  }),
};
```

The Vite preset installs original-source capture, lowering and final guard
proof hooks in the required order. Unknown subsequent transforms, missing source
provenance or explicit runtime imports prevent specialization. The existing
`minchoVitePlugin` entry remains available.

```ts
// esbuild
import { buildWithMincho } from "@mincho-js/esbuild";

await buildWithMincho({
  entryPoints: ["src/app.tsx"],
  bundle: true,
  outdir: "dist",
  jsx: "automatic",
  jsxImportSource: "@mincho-js/react",
  mincho: {
    jsxCssProp: true,
    optimize: { runtimeCodegen: true, jsxRuntimeGuards: true },
    experimental: { nonInheritingCssVars: true, cssChunkSharing: true },
  },
});
```

In standalone Babel, set `optimize.runtimeCodegen: true` explicitly to use local
syntax reductions. Recipe/styled graph analysis and JSX guard specialization need
the build integration. Direct `eval` (including a shadowed binding that can hold
the intrinsic function) and `with` disable optimizations that require a closed
lexical reference graph.

Both experimental options default to `false`:

- `nonInheritingCssVars` emits an `@property` registration with `syntax: "*"`
  and `inherits: false` for eligible generated variables. Selector-dependent
  consumption, custom components/elements, customized built-ins (`is`) and JSX
  spreads keep ordinary variables. It intentionally changes inheritance for these
  private variables;
  it does not register user-defined properties.
- `cssChunkSharing` accepts `true` or `{ minBoundaries, minBytes }`, defaulting to
  2 boundaries and 4,096 source bytes when enabled. It shares compatible whole
  leading CSS module sequences, preserving shared-before-private order and native
  asset handling. Vite retains lazy CSS loading. Missing ownership, unsupported
  CSS or import attributes keep the native layout; arbitrary equal rules are not
  globally deduplicated. esbuild requires the one-shot `buildWithMincho` API and
  adds a CSS-only replay build after its analyze/emit passes. For shared entries,
  the manifest is keyed by emitted JavaScript filename: load its ordered
  `minchoCssManifest.entries[outputFile].css` list instead of the retained
  `fallbackCssBundle`. Entries without sharing keep their native CSS bundle.
  Changed transaction inputs fail before publication. See the
  [Vite](../packages/vite/README.md) and [esbuild](../packages/esbuild/README.md)
  adapter documentation for other restrictions.

## Cost and verification

Each compiled recipe cache stores at most 256 results and 65,536 UTF-16 units of keys and results
per compiled instance. Recipe caching starts after 8 calls only when the
variant/compound cost is at least 32. A 64-lookup window with fewer than 16 hits
disables the cache for that instance. Scoped `cx` bypasses caching for inputs
over 4,096 UTF-16 units. Tuples, prepared token/write-ID fragments and results
share a separate 1,024-entry / 131,072-unit allowance. A first fragment sighting retains
only its key; a repeat can retain tokens and write IDs. Tuples can borrow unused
string space and return it when result caching needs it. Tuples reserve 512
entries and initially 16,384 units, with 512 warmup lookups before the first
64-lookup reuse check. The limits grow retention as entries arrive, without
preallocating the full allowance. Mutable inputs are evaluated
on every call before their per-argument strings can hit the tuple cache, avoiding
the full-string join on a hit. The result cache handles other normalized inputs.
A single array can use its normalized elements as tuple slots while preserving
clsx's array getter order, repeated reads and captured length.
Cache misses and unsupported values preserve the original contracts,
including strict compound comparisons. The direct token scanner preserves
whitespace and conflict handling; already normalized, unchanged merges return
their input. Two/three-argument predictions compare slots directly; short tuples
add an array only when a wider prediction needs it. Predictions for up to eight arguments return
before the general merge wrapper; four-to-eight-argument probes pass fixed slots
without another rest array. Hot predictions update one window counter;
counting misses preserves the existing reuse thresholds. A failed outer probe
is not repeated for scalar arguments; resolved values retry with their strings.
Tuple caching and
prediction stop when their reuse rate is too low; a
disabled tuple cache gets one retry after 32 identical result-cache hits.
Unique first strings index tuples directly without bucket arrays, with full equality checks. A shared
first string switches that cache generation to sampled tuple hashes, avoiding
long prefix buckets. The conversion is bounded by the 512 retained entries.
Segments crossing cached fragment boundaries are revalidated from write IDs.
Compiled conflict resolution reuses bounded write-generation marks from its
second merge; public mutable factories retain independent `Set` tracking.
The optional numeric buffer costs at most another 16 KiB, outside the UTF-16
string allowance.
After 16 actual merges, eligible compiled factories can prepare an exact
class-name lookup and numeric token spans, avoiding per-token substring
allocation. Hash collisions are checked against complete names. The path waits
while scalar tuple reuse is effective, accepts at most 1,024 registered
class/marker entries, and preserves segment validation and nested-call behavior.
It retains at most another 24 KiB of typed storage plus registered-name
references; larger token buffers are temporary. These allocations are separate
from the write marks and string budget. The mutable direct factory and unusual
IDs keep the ordinary path.

These are workload-dependent optimizations. Compiled cache helpers add JavaScript
bytes; initialization and low-reuse calls can be slower. The reproducible
[runtime benchmark](performance-runtime.md) reports hot, cold, low-reuse, heap
and raw/gzip bundle measurements separately.

Validation includes differential runtime tests, existing Babel and adapter
regressions, actual Vite/esbuild builds, isolated npm and strict Yarn PnP
consumers, ESM/CommonJS declaration and bundle contracts, and JSX settings with
both values of `verbatimModuleSyntax`. Browser checks on Chromium, Firefox and
WebKit cover shared/private cascade, Vite lazy loading and the inheritance
change from generated `@property` registrations.

# Atomic/runtime optimizations

These optimizations extend Mincho's existing extraction pipeline. They do not add
runtime stylesheet injection. Every new switch defaults to `false` in development,
production, application and library builds.

```ts
minchoVitePlugin({
  optimize: {
    staticScopedCx: true,
    defineRulesCxConditions: true,
    symbolicTokens: true,
  },
  jsxCssProp: true,
  experimental: {
    globalAtomicClasses: true,
    cssBooleanGates: true,
  },
});
```

The esbuild adapter accepts the same compiler options. Standalone Babel puts
`optimize` and `experimental` directly in its Mincho plugin options. The Babel
package declares its CSS runtime dependency and vanilla-extract peer for local
scoped-cx evaluation; the merge implementation is loaded only when needed.

## Static scoped cx

`optimize.staticScopedCx` computes calls backed by a proven literal
`createCompiledDefineRulesCxRuntime` artifact with the same runtime implementation
used by consumers. It preserves exact class strings, segment markers, unknown
classes and conflict resolution. Literal arrays/objects are supported; getters,
spreads, mutable aliases, unknown factories and observable prototype mutations
retain the original call.

Local callees, operands and aliases must be initialized by an earlier statement
in the same execution scope. Reads before initialization, skipped declarations,
and captures across function/class boundaries retain their runtime behavior.
This deliberately leaves some safe closures unoptimized rather than assuming
that a function declared later cannot be called early. The same check applies
before removing an unused factory.

The existing `defineRulesCxConditions` switch creates condition tables. Enabling
`staticScopedCx` additionally bakes supported table entries; it does not turn table
generation on. Condition expressions retain their order and evaluation count.
Class tables and baked calls share a per-module budget of 256 entries and 4,096
UTF-16 code units; the existing four-condition limit is unchanged.

Unused private factories and imports are removed. An imported producer's CSS
side-effect edge remains, including CommonJS `require`. Cached analyses reload
providers to publish the current generation's CSS. Standalone Babel supports
local literal factories; imported artifacts require a bundler source provider.
This pass operates on Mincho's serialized extraction sidecars (including recipes
returned by configured `extractCalls`). An independently processed
vanilla-extract `.css.ts` module is not made available to that provider and keeps
its existing runtime path. It does not evaluate arbitrary authoring calls to
`defineRules` in application JavaScript.

## Symbolic token references

`optimize.symbolicTokens` captures actual Mincho `createVar` results during CSS
evaluation. A build-only, versioned artifact binds immutable primitive exports to
their producer, compiler identity and serialized source hash. No variable name is
derived from a token identifier or replaced with a new naming scheme.

The first supported contract is a primitive named export, including aliases,
namespace reads and proven re-exports. Mutable theme objects, nested token
containers, getters, unknown producers and incompatible package copies fall back.
This is deliberately narrower than StyleX's dedicated theme-file protocol.
Local aliases use the same initialization-order proof as scoped cx. The pass
substitutes reads in the extracted JavaScript; it does not bypass the original
CSS evaluator for expressions already consumed during CSS extraction.

The producer still runs through normal evaluation or validated effect replay.
Consumers can replace verified reference reads without parsing that producer on
the direct path. A CSS-value-only edit reloads the provider and updates CSS while
keeping a matching direct-reference analysis cached. Reference/name/shape/compiler
changes invalidate it. Re-export traversal can still require normal source
analysis. No artifact is published into client JavaScript.

Direct token dependencies can retain their in-memory analysis after explicit
cache invalidation, but every reuse reloads and verifies the current provider
artifact. Source observations and changes to the consumer still use ordinary
invalidation. Failed reference validation invalidates dependent analyses too.
This cache entry is not persisted to disk. Source hashing and provider loading
remain part of a cache hit.

Both options remain off by default in development and production. Measure
matching installed consumers before enabling them; build-time substitutions do
not establish a per-render speedup for ordinary `.css.ts` consumers.

## Conditional atom sharing

The existing `experimental.globalAtomicClasses` now accepts private named
conditions containing `&`, `:hover`, `:focus`, `:focus-visible`, `:active`,
`:disabled`, and static media/supports/layer conditions. Equal atoms share a name
and declaration inside the same original file and cascade domain.

Only independent literal longhands qualify. Multiple writes to the same property,
intervening potentially conflicting writes, arbitrary selectors, containers,
URLs, shorthand/logical conflicts, public classes, presets and scoped-cx escapes
retain the scoped path. Files and lazy chunks are never merged by this option.

## CSS boolean gates

`experimental.cssBooleanGates` is an opt-in experiment on existing intrinsic JSX
`css` syntax. Complete conditional trees with at most four tests can use static
CSS declarations plus private inline gate variables. Every leaf must provide the
same ordered longhands at the same selector/at-rule positions. Nested self pseudo
selectors and static media/supports blocks keep their original positions.

The initial subset accepts literal values and preserves short-circuit evaluation
of conditions. Dynamic leaf values, missing declarations, nullish values,
CSS-wide keywords, shorthands, custom components, spreads and existing
`className`/`style` attributes use the existing lowering. There is no `and/or/not`
authoring API, global `*` reset, event listener or runtime rule insertion.

Repeated fallback expressions are factored only when their emitted CSS text cost,
including the generated variable declaration and all references, decreases.
Compression and browser minification are measured separately. Gates reset on
their generated element class to avoid inherited state. This mode introduces
inline custom properties and therefore needs a CSP that permits style attributes;
keep it disabled when the application requires class-only styling.

Gates can increase CSS and SSR HTML even if JavaScript decreases. The option stays
experimental regardless of favorable individual fixtures.

## Diagnostics and validation

Existing `diagnostics` reports include scoped-cx results/budgets, token-reference
application, gate outcomes, class-strategy decisions, AST/VM fallbacks, CommonJS
and export-star widening, cache creation bytes versus hits, hashing time, and
evaluation registry copy time. Hash timing excludes key serialization. Detailed payloads
are evaluated only with active diagnostics. Phase durations are inclusive; do not
sum nested phases as total build time.

Native esbuild's root named-import CSS limitation is unchanged: library
consumers needing selective CSS should use subpath imports.

## Reproducing measurements

Build the baseline and candidate checkouts with
`mise exec -- yarn install --immutable` and `mise exec -- yarn build:release`
in each checkout. Use fresh consumer directories for every compiler revision;
reusing an installed directory can retain cached package tarballs.

From the candidate checkout:

```sh
mise exec -- yarn node scripts/benchmark-compilation.mjs --pack /path/to/baseline-checkout --candidate /tmp/atomic-baseline-consumer
mise exec -- yarn node scripts/benchmark-compilation.mjs --pack /path/to/candidate-checkout --candidate /tmp/atomic-candidate-consumer
mise exec -- yarn node scripts/benchmark-atomic-runtime.mjs --baseline /tmp/atomic-baseline-consumer --candidate /tmp/atomic-candidate-consumer --browser
mise exec -- yarn node scripts/benchmark-compilation.mjs --baseline /tmp/atomic-baseline-consumer --candidate /tmp/atomic-candidate-consumer --baseline-label baseline --candidate-label candidate --rounds 5 --formats esm --cases styles-24,shared-24 --bundlers esbuild,vite,vite-dev --output .cache/atomic-default-regression
```

Full reports default to `.cache/benchmarks/atomic-runtime-results.json` and its
Markdown companion.

`--browser` requires Chromium; set `--chromium /path/to/chromium` when needed.
To rerun only the browser checks, replace `--browser` with
`--browser-only --output .cache/atomic-browser-results.json`. Both the JSON and
companion Markdown paths must be unused and separate from the default full
report, so browser-only results cannot replace its build and size measurements.

Run measurements without concurrent builds, tests or installs. The atomic script
runs each profile in five alternating pairs, using cache off, workers zero and
separate diagnostic runs. The default regression script also checks output
hashes and measures unchanged, leaf-edit and shared-edit rebuilds where supported.
Its Vite development figures measure the transform graph, not browser HMR latency.
The installed-package contract additionally covers strict PnP, CJS, workers and
cache-enabled builds; those checks are separate from the timing samples.

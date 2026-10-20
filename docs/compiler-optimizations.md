# Compiler optimizations

Mincho keeps the Babel → esbuild → vanilla-extract pipeline. The compiler can
skip work only when its input satisfies a closed proof; other inputs use the
existing path. These changes do not add an Oxc, Rust, or WASM dependency.

```ts
minchoVitePlugin({
  optimize: {
    // Opt in after measuring these passes in your project.
    dependencyGraph: true,
    staticStyles: true,
  },
  appCss: {
    mode: "dist-chunk",
    optimize: {
      mergeRules: true,
      pruneGenerated: true,
      compactThemes: true,
      shareAtoms: true,
    },
  },
  experimental: {
    globalAtomicClasses: false,
    compileClass: false,
  },
});
```

`dependencyGraph` and `staticStyles` default to `false` in both profiles. Five
paired measurement rounds did not establish a consistent build time benefit,
so these passes require explicit opt-in. See the
[measurement record](framework-optimization-audit/compiler-results.md) before
choosing a configuration. The esbuild plugin supports these two options and both
experimental class options too. `appCss` belongs to the Vite application adapter.

## Evaluation

`dependencyGraph` prepares the demanded exports and object members of closed,
acyclic ESM data modules and named barrels. It retains side effects, CSS imports,
CommonJS, namespace escapes, mutation, getters, unknown calls, and dependencies
requiring external Babel configuration. A module is not treated as pure just
because the consumer reads one of its properties.

`staticStyles` directly evaluates supported built-in style calls with literal
arguments. It proves the entire program before emitting CSS, registering classes,
or changing file scope. This includes Babel-generated `var` declarations and
aliases of earlier proven locals; reassignment, duplicate declarations and forward
references are not accepted. Unsupported calls, user styling functions, or dynamic
values use ordinary compilation and evaluation. `execution.evaluation: "fresh"`
always uses the existing fresh evaluation path.

Both optional passes use lightweight preflight checks to skip extra AST analysis
when no supported intrinsic import or dependency syntax is present. Ambiguous
syntax continues through the full analysis rather than being treated as proof.

Immutable syntax summaries share the parser cache across identical source text.
Mutable ASTs stay isolated by file and are cloned before transformation. Source
keys distinguish UTF-16 code units, including lone surrogates. Negative analysis
results use the same bounded cache and invalidate when source/options change.

## Application CSS

The CSS passes require explicit `appCss.optimize: true` or an options object in
`appCss.mode: "dist-chunk"` builds using the validated Vite/vanilla-extract adapter.
Omitting `appCss.optimize` keeps them disabled in both profiles. Native mode,
development serving, libraries, and SSR keep their existing CSS path. Generated
class names are preserved by all four passes.

| Option           | Applied scope                                                       | Preservation boundaries                                                                                                                           |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeRules`     | Adjacent generated class rules with exactly equal flat declarations | File order, fallback/declaration order, conditions, global selectors, and non-finite values                                                       |
| `pruneGenerated` | Captured Mincho variables with no live reference or exported use    | Public/foreign variables, inheriting property registrations, layers, keyframes, animation/transition effects, opaque references, and external CSS |
| `compactThemes`  | Adjacent identical theme variable declarations                      | Differing values, conditions, inheritance, and theme selection                                                                                    |
| `shareAtoms`     | Existing native graph sharing of ordered CSS module prefixes        | Actual entry/lazy boundaries, explicit route/layout reach, cascade barriers, and configured thresholds                                            |

`shareAtoms` does not move arbitrary individual rules across files. The automatic
policy uses the existing minimum of two boundaries and 4096 bytes, and explicit
`appCss.sharing` settings take precedence. `appCss.sharing: false` disables this
automatic sharing. `appCss.optimize: false` disables the new CSS passes and
automatic sharing; separately requested module sharing remains available.

Resource provenance is attached during evaluation, using the actual variable
names returned by Mincho's `createVar` and theme construction. The live graph
follows variable aliases across retained owners. The compiler does not infer
ownership from a name that merely looks generated. CSS identity is independent
of consumer export metadata; owner replacement/removal updates that metadata.
CSSOM or computed-style access in the retained JavaScript graph disables resource
pruning, because those readers can observe otherwise unused custom properties.
This guard recognizes standard API names; dynamically constructed lookups,
external scripts, and reflective access cannot be ruled out by that scan. Set
`pruneGenerated: false` when such code observes generated custom properties.

Custom PostCSS configuration disables structural passes. Its transforms still
run through Vite. Serialization memoization stores only pure, pre-PostCSS text,
so URL resolution, asset emission, hashing, manifests, and CSS preload behavior
remain Vite's responsibility. `cache: false` also disables this memo.

The compiler does not lower theme pairs to `light-dark()`: the current API does
not prove equivalence under inherited variables or a later `color-scheme`
override. It also leaves single-importer chunk cleanup to the native bundler.

## Experimental class strategies

`experimental.globalAtomicClasses` and `experimental.compileClass` are opt-in
because they change generated names. Eligibility is restricted to a private
`defineRules` owner and a literal composition used as the sole `className` of
an intrinsic element, for example `css([privateRules.css({ color: "red" })])`.
Only independent, unconditional longhand declarations qualify.

The global-atom strategy currently reuses atoms within the original file's
cascade domain. It does not establish a single CSS owner across different files.
This domain includes the absolute source filename. Build client and SSR output
from the same project path; matching names across separate checkout paths is not
part of the experimental contract.
`compileClass` can replace a proven composition with one class and rule. Public
exports, `cx`, presets, selectors, conditions, spreads, external composition,
and intervening unknown styles retain the scoped implementation. Compilation
helpers are extracted into the build-time sidecar and removed from client code.

Generated CSS, returned class names, serialized `defineRules` data, and atomic
metadata must agree. These options do not promise smaller output for every
input: class-name overhead can outweigh declaration savings for small styles.

## Caching, workers, and verification

Worker payloads use bounded content-addressed source reuse, with a receiver miss
request and direct fallback. Provider calls remain distinct because they record
per-consumer dependency facts. Cache/diagnostic file writes use a per-path queue,
coalesce newer valid writes, and replace files atomically. See
[compiler transport](compiler-transport.md) for budgets and invalidation rules.

Compile/evaluation cache schemas include the new option and metadata contracts.
`cache: false`, reset, environment changes, and generation changes retain their
existing bypass/invalidation behavior. The implementation uses existing parser,
compilation, and worker cache budgets rather than an unbounded source cache.

The [92-item implementation map](framework-optimization-audit/compiler-implementation.md)
links every audit candidate to its implementation, test, existing behavior, or
reason for conservative fallback. Build timing and bundle sizes must be compared
on the same installed consumer and toolchain; phase removal alone is not a
wall-clock speed claim. Native esbuild's root named-import CSS limitation remains
unchanged: library consumers needing selective CSS should use subpath imports.

# Vite library CSS finalization (U1)

The native CSS linking change remains a release prerequisite. The existing
plugin modifies entry JavaScript in `generateBundle`, after Rollup has computed
its content hash and source map. Moving this work to `renderChunk` is insufficient
for all supported configurations: Vite finalizes unsplit CSS in `generateBundle`.

`packages/vite/src/libraryCssFinalization.test.ts` runs the public plugin in real
Vite builds with custom asset names, ESM/CJS, and both `cssCodeSplit` values. Run:

```sh
mise exec -- yarn workspace @mincho-js/vite test src/libraryCssFinalization.test.ts
```

The fixture distinguishes the current outcomes:

| Contract                                                               | Split CSS           | Unsplit CSS                    |
| ---------------------------------------------------------------------- | ------------------- | ------------------------------ |
| Changing the emitted CSS asset name changes the entry JS hash          | Passes this fixture | Fails                          |
| Entry source map still points to the original marker after CSS linking | Fails               | Fails                          |
| Lazy library entry imports its emitted CSS                             | Fails               | Not tested by the lazy fixture |

The failing expectations are explicitly marked `it.fails`. A green test run
therefore does **not** mean the release prerequisite is satisfied. Unexpected
success requires investigating the underlying Vite behavior and replacing the
expected failure with an ordinary regression. The split hash result concerns
native emitted assets; it does not establish hash correctness for arbitrary
external ancestor stylesheet references.

Use `mise exec -- yarn check:vite-native-css-contract` as the strict release
check. It runs these same expectations as ordinary tests and currently exits
with failure. The `publish` script requires this check before publishing. The
normal suite retains expected failures so unrelated fixes can be checked while
this prerequisite is open.

Completion requires a supported Vite hook or a maintained upstream backport
that exposes finalized CSS ownership and filenames early enough for native JS
hashing and source-map generation. Then integrate the package graph at each
actual output scope, including dynamic roots, and replace these expected failures
with ordinary passing tests. Keep `cssCodeSplit: false`, user filename callbacks,
ESM/CJS, layers, and chunk loading intact. Do not guess filenames, force CSS
splitting, rewrite completed bundles, or patch private Vite hooks.

The independent package graph, esbuild two-pass API, and package consumer tests
can be reviewed without this prerequisite. Vite's existing automatic library
CSS connection is not being presented as a complete implementation of the new
output-scoped topological linking design.

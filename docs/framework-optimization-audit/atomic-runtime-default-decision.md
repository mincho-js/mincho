# Atomic/runtime default decision

Keep `optimize.staticScopedCx: false` and `optimize.symbolicTokens: false` in both development and production. The initialization-order and semantic-cache correctness fixes remain in place; these measurements evaluate that fixed implementation.

`staticScopedCx` is useful as an explicit production option for projects that expose immutable compiled cx artifacts and have many static calls. It is not a general improvement for ordinary `.css.ts` consumers. `symbolicTokens` does not justify default activation: its native esbuild path adds substantial work and can duplicate token strings in emitted JavaScript.

Run: 2026-09-24T17:42:50.044Z. Node v24.21.0; Intel(R) Core(TM) i5-8265U CPU @ 1.60GHz. Vite 7.3.3, Rollup 4.63.4, esbuild 0.27.7, Babel 7.29.0. Vanilla Extract CSS 1.20.1, Vite plugin 5.2.2, compiler 0.7.2, vite-node 6.0.0.

Seven paired rounds per comparison: **168 timed samples and 24 separate diagnostic runs**. Each sample uses a fresh Node process; on/off order alternates, workloads and bundlers rotate, and benchmark samples run sequentially. Both sides use exactly the same compiler snapshot and dependency versions. Current Babel, integration and adapter sources were rebuilt in a private consumer with Vite/Rollup; the CSS distribution matches the workspace byte for byte. No workspace `dist` files were rebuilt. The raw report contains source-tree and emitted-package fingerprints.

Memory cache, workers 0, diagnostics disabled for timed samples. Production output is minified; gzip uses level 9 and Brotli quality 11. Cold timing covers the native compiler operation after dependency imports and fixture setup. Compression and exported-value checks run outside the build timer. Unchanged esbuild rebuilds and two edits run in the same context. Vite production measures a fresh build; development measures client graph transformation and native watcher/HMR hooks, including Vanilla Extract’s internal compiler server. OS watcher debounce, browser transport, hydration and rendering latency are excluded.

Values below are milliseconds, off → on. The percentage is the **median of the seven paired percentage changes**, so it need not equal the ratio of the two independently reported medians. Positive percentages mean slower. No samples were removed. Small changes with mixed signs are not evidence of a general speedup.

| Workload                              | Option         | Bundler |                     Cold |              Unchanged |          CSS-value edit |         Reference edit |
| ------------------------------------- | -------------- | ------- | -----------------------: | ---------------------: | ----------------------: | ---------------------: |
| Ordinary .css.ts (24 consumers)       | staticScopedCx | esbuild |    481.5 → 498.5 (+3.8%) |  268.9 → 282.6 (+4.7%) |   139.4 → 137.5 (-1.9%) |  115.3 → 117.2 (+3.2%) |
| Ordinary .css.ts (24 consumers)       | staticScopedCx | vite    |  1762.7 → 1734.3 (-1.6%) |                      — |                       — |                      — |
| Ordinary .css.ts (24 consumers)       | symbolicTokens | esbuild |    477.5 → 514.6 (+8.2%) |  273.9 → 278.5 (+1.3%) |  139.2 → 196.9 (+45.3%) | 118.4 → 161.7 (+40.2%) |
| Ordinary .css.ts (24 consumers)       | symbolicTokens | vite    |  1741.1 → 1742.2 (+1.0%) |                      — |                       — |                      — |
| Extracted cx (24 features / 72 calls) | staticScopedCx | esbuild | 1065.3 → 1212.0 (+14.6%) |  640.7 → 679.6 (+4.6%) |  218.1 → 237.5 (+12.3%) | 208.9 → 232.5 (+13.0%) |
| Extracted cx (24 features / 72 calls) | staticScopedCx | vite    |  1991.3 → 2098.5 (+5.4%) |                      — |                       — |                      — |
| Tokens (48 consumers / 768 reads)     | symbolicTokens | esbuild |  292.0 → 836.1 (+190.1%) | 102.0 → 149.8 (+43.8%) | 105.5 → 575.4 (+449.0%) | 98.7 → 542.7 (+462.7%) |
| Tokens (48 consumers / 768 reads)     | symbolicTokens | vite    |    512.5 → 550.9 (+9.8%) |                      — |                       — |                      — |

Vite development uses unminified module transforms. Unchanged graph requests take less than one millisecond; only absolute times are useful for those measurements.

| Workload                              | Option         |                    Cold |  Unchanged ms |     CSS-value update |    Reference update |
| ------------------------------------- | -------------- | ----------------------: | ------------: | -------------------: | ------------------: |
| Ordinary .css.ts (24 consumers)       | staticScopedCx |   845.0 → 819.3 (-1.5%) | 0.244 → 0.236 |  35.8 → 33.9 (-4.2%) | 27.3 → 28.9 (+3.5%) |
| Ordinary .css.ts (24 consumers)       | symbolicTokens |   834.8 → 833.7 (-0.9%) | 0.307 → 0.212 |  33.5 → 32.7 (+0.2%) | 27.5 → 28.0 (+0.7%) |
| Extracted cx (24 features / 72 calls) | staticScopedCx | 1365.5 → 1454.2 (+6.9%) | 0.386 → 0.414 | 53.0 → 58.3 (+12.5%) | 46.7 → 47.7 (+2.3%) |
| Tokens (48 consumers / 768 reads)     | symbolicTokens |   657.6 → 695.9 (+5.6%) | 0.365 → 0.394 | 61.0 → 68.8 (+14.6%) | 57.6 → 62.9 (+7.8%) |

Production JavaScript sizes are bytes, off → on. **Production CSS is identical between on/off in every comparison.**

| Workload                              | Option         | Bundler |          Raw JS |       gzip JS |     Brotli JS |
| ------------------------------------- | -------------- | ------- | --------------: | ------------: | ------------: |
| Ordinary .css.ts (24 consumers)       | staticScopedCx | esbuild | 131951 → 131951 | 42792 → 42792 | 37521 → 37521 |
| Ordinary .css.ts (24 consumers)       | staticScopedCx | vite    | 131619 → 131619 | 42171 → 42171 | 37064 → 37064 |
| Ordinary .css.ts (24 consumers)       | symbolicTokens | esbuild | 131951 → 131951 | 42792 → 42792 | 37521 → 37521 |
| Ordinary .css.ts (24 consumers)       | symbolicTokens | vite    | 131619 → 131619 | 42171 → 42171 | 37064 → 37064 |
| Extracted cx (24 features / 72 calls) | staticScopedCx | esbuild | 158093 → 139405 | 50661 → 44256 | 44167 → 38870 |
| Extracted cx (24 features / 72 calls) | staticScopedCx | vite    | 158021 → 139003 | 49999 → 43546 | 43667 → 38347 |
| Tokens (48 consumers / 768 reads)     | symbolicTokens | esbuild |    4510 → 17077 |     919 → 910 |     630 → 581 |
| Tokens (48 consumers / 768 reads)     | symbolicTokens | vite    |     4320 → 4204 |     910 → 854 |     620 → 574 |

For `staticScopedCx`, diagnostics found **0 candidates in the ordinary `.css.ts` workload** and folded **72 of 72 calls** in the configured `extractCalls` workload. The latter saved 6,405 gzip bytes with esbuild and 6,453 with Vite. Cold builds were slower in all seven pairs on both bundlers: median paired increases were 14.6% and 5.4%. Vite development CSS updates increased 12.5%. Node module initialization medians improved from 21.7 to 17.4 ms (esbuild output) and 23.6 to 18.8 ms (Vite output). These are module-initialization calls; the fixture’s render functions already use lookup tables, so this is not a measured per-render benefit.

Enable `staticScopedCx` explicitly for a production build when its own diagnostics show substantial folding and the resulting byte savings matter more than the measured build cost. Keep it off by default in development and in a general project configuration. Enabling it does not make ordinary `.css.ts` factories analyzable.

For `symbolicTokens`, the token-heavy esbuild workload changed from 292 to 836 ms for cold builds and from 105 to 575 ms for a CSS-value edit. These regressions occurred in all seven pairs. The unchanged rebuild also became slower: 102 to 150 ms. gzip saved only 9 bytes while raw JavaScript grew from 4,510 to 17,077 bytes because token references were repeated as string literals. Node module initialization changed from 2.8 to 4.3 ms. Sample peak RSS changed from 151.5 to 280.8 MiB; that peak includes output verification and is not a browser heap measurement. Vite’s path behaved differently, saving 56 gzip bytes with a 9.8% median paired cold-build increase and a 14.6% development CSS-update increase.

Native esbuild diagnostics explain the limited cache benefit: the token workload performed 785 reference checks against validated artifacts on both cold and unchanged builds. After a CSS-only edit, exported token values were unchanged, but 48 consumer runtime-cache entries failed revalidation and 49 analyses were created (including the changed producer). The ordinary `.css.ts` workload found no validated artifacts and invalidated 24 consumers after a CSS edit. The earlier semantic-cache fix supports direct artifact dependencies; native import/sidecar chains still retain full-source observations that require ordinary revalidation. Vite recorded 17 reference checks at cold build, so the esbuild cost must not be generalized to all adapters.

Reconsider `symbolicTokens` only after artifact verification is shared per producer and generation, native consumers can reuse analysis across CSS-only edits while preserving fresh CSS, and literal duplication is controlled. Re-run these native workloads before changing either default.

Every production on/off pair checks exported runtime values and CSS hashes. Rebuild checks confirm unchanged output, fresh CSS after value edits, stable token values for CSS-only changes, and changed values after variable creation-order/name edits. Development checks confirm fresh CSS and removal of stale token references. In the cx workload, both edits change one feature’s CSS; the column labelled reference edit is a second CSS edit there.

Reproduce from an installed consumer with the existing package-contract dependency set:

```sh
node scripts/benchmark-atomic-defaults.mjs \
  --consumer /path/to/installed-mincho-consumer \
  --vanilla-consumer /path/to/consumer-with-vanilla-vite-plugin \
  --rounds 7 \
  --output docs/framework-optimization-audit/atomic-runtime-default-decision.json
```

The supplemental consumer provides missing third-party packages only; existing packages and private Mincho copies are not overwritten. The runner prints the isolated snapshot directory. Use `--prepared /that/directory` to repeat the same snapshot. `--smoke --rounds 1` validates the fixtures without producing decision-quality timing data.

[Raw samples, diagnostics and fingerprints](./atomic-runtime-default-decision.json). [Runner](../../scripts/benchmark-atomic-defaults.mjs). [Native fixtures and assertions](../../scripts/benchmark-atomic-defaults/worker.mjs).

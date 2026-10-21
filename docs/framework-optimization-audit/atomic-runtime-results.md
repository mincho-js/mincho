# Atomic/runtime measurements

Baseline: c9298a76. 5 paired rounds, Node v24.21.0.

Cold installed consumers, cache off, workers 0, diagnostics off. Timings are medians; relative timings are observations, not universal speedups. JS/CSS sizes use the same esbuild minifier for both bundlers. HTML is two server renders. Initialization imports the unminified generated module. Heap is an allocation delta, not retained heap.

| Bundler | Profile | Build ms (base → candidate) |     Δ |                            JS raw/gzip/br |             CSS raw/gzip/br |         HTML raw/gzip/br |
| ------- | ------- | --------------------------: | ----: | ----------------------------------------: | --------------------------: | -----------------------: |
| esbuild | off     |               384.7 → 393.3 |  2.2% | 148895→149732 / 47563→47883 / 41969→42229 | 376→376 / 212→212 / 179→179 |  146→146 / 90→90 / 71→71 |
| esbuild | cx      |               387.5 → 407.4 |  5.2% | 148895→137093 / 47563→43507 / 41969→38395 | 376→376 / 212→212 / 179→179 |  146→146 / 90→90 / 71→71 |
| esbuild | tokens  |               390.4 → 453.7 | 16.2% | 148895→149720 / 47563→47866 / 41969→42200 | 376→376 / 212→212 / 179→179 |  146→146 / 90→90 / 71→71 |
| esbuild | atoms   |               390.3 → 402.9 |  3.2% | 148895→149642 / 47563→47857 / 41969→42185 | 376→391 / 212→229 / 179→192 |  146→146 / 90→90 / 71→71 |
| esbuild | gates   |               386.3 → 423.0 |  9.5% | 148895→149923 / 47563→47977 / 41969→42256 | 376→660 / 212→265 / 179→220 | 146→258 / 90→128 / 71→96 |
| esbuild | all     |               383.6 → 489.9 | 27.7% | 148895→137182 / 47563→43573 / 41969→38478 | 376→675 / 212→282 / 179→243 | 146→258 / 90→128 / 71→96 |
| vite    | off     |             1199.2 → 1197.6 | -0.1% | 148554→149391 / 47486→47804 / 41799→42039 | 369→369 / 208→208 / 181→181 |  146→146 / 90→90 / 71→71 |
| vite    | cx      |             1275.4 → 1165.9 | -8.6% | 148554→136754 / 47486→43376 / 41799→38309 | 369→369 / 208→208 / 181→181 |  146→146 / 90→90 / 71→71 |
| vite    | tokens  |             1202.7 → 1263.8 |  5.1% | 148554→149373 / 47486→47779 / 41799→42029 | 369→369 / 208→208 / 181→181 |  146→146 / 90→90 / 71→71 |
| vite    | atoms   |             1206.6 → 1220.4 |  1.1% | 148554→149307 / 47486→47779 / 41799→42049 | 369→384 / 208→224 / 181→187 |  146→146 / 90→90 / 71→71 |
| vite    | gates   |             1207.2 → 1250.6 |  3.6% | 148554→149576 / 47486→47887 / 41799→42127 | 369→517 / 208→251 / 181→212 | 146→220 / 90→116 / 71→80 |
| vite    | all     |             1219.2 → 1288.3 |  5.7% | 148554→136833 / 47486→43419 / 41799→38248 | 369→532 / 208→269 / 181→228 | 146→220 / 90→116 / 71→80 |

Browser timings compare candidate all against baseline off and cover 200 React updates with forced computed-style reads. They include React and DOM work and are not a gate-only CPU comparison. Paired runs verify colors, opacity, factored width/height, self-focus selectors, evaluation order, and opposite parent/child states.

- esbuild: median updates 32.5 → 44.5 ms (Chromium 147.0.7727.55 Arch Linux).
- vite: median updates 31.5 → 42.1 ms (Chromium 147.0.7727.55 Arch Linux).

No option is enabled by default. Small fixtures do not represent all applications. See the JSON for every sample, versions, fixture fingerprint and separate diagnostics.

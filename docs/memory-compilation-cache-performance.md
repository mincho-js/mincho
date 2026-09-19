# PR 11 memory cache comparison

This comparison uses the merged PR 10 baseline (`0c4bba36dc4b35ad6e8c238eb44a6cad33ac66a7`) and the independently built, pre-review PR 11 candidate (`003a72f31b059d4e133d456533495823d6d23792`). The candidate includes only the memory/input/analysis cache and transactional CSS changes. It does not include later pure-helper/runtime lowering, workers, filesystem caching or VM/evaluation-result reuse. The subsequent parser, Babel configuration and stale-request review fixes have not been remeasured here.

Node 20.19.0 on Linux x64; Intel Core i5-8265U, 8 logical CPUs and 15.3 GiB RAM. Both revisions use separate npm installations of release tarballs with identical pinned consumer tooling: esbuild 0.27.7, Vite 7.3.3, Babel 7.29.7, vanilla-extract CSS 1.21.2 and React 19.2.6. Measurements were collected on 2026-10-05.

## Results

Three rounds alternate revision order and rotate fixture order, with a fresh process for each revision and fixture. Each process measures one initial build, three unchanged rebuilds and three edits. The table reports medians of round medians in milliseconds. Diagnostics are disabled for these timings.

| Bundler / workload          |   Initial, PR 10 → PR 11 | Unchanged, PR 10 → PR 11 |  Edited, PR 10 → PR 11 |
| --------------------------- | -----------------------: | -----------------------: | ---------------------: |
| esbuild / styles-24         |    637.0 → 639.0 (+0.3%) |   259.2 → 131.3 (-49.4%) | 213.3 → 122.9 (-42.4%) |
| esbuild / tokens-unused-24  |    743.2 → 811.8 (+9.2%) |   360.3 → 119.8 (-66.8%) |  337.7 → 317.4 (-6.0%) |
| vite-dev / styles-24        | 635.3 → 1548.2 (+143.7%) |        0.8 → 0.9 (+5.0%) |  37.1 → 76.4 (+106.1%) |
| vite-dev / tokens-unused-24 | 811.3 → 1728.1 (+113.0%) |       1.7 → 1.0 (-42.8%) | 596.5 → 764.4 (+28.1%) |

esbuild unchanged rebuilds improved by 49–67%; editing an unused export improved by only 6%. The diagnostic run still recorded 24 sidecar compilations per unused-export edit. The initial esbuild build was effectively unchanged for `styles-24` and 9% slower for `tokens-unused-24`.

Vite development regressed in this comparison: initial transforms took 2.1–2.4 times as long, and edits took 28–106% longer. Vite already caches unchanged module transforms, so the sub-2 ms unchanged results do not demonstrate a useful compiler-cache gain. Median peak RSS rose from 145.5 to 197.7 MiB for `styles-24` and from 194.0 to 265.0 MiB for `tokens-unused-24`. These results are a limitation of this PR, not evidence for a universal speedup or for enabling later cache/worker defaults. `cache: false` remains available for application-specific comparisons.

## Correctness and diagnostic counters

For esbuild, the runner checks normalized CSS and rendered-value hashes for every captured phase across revisions; all 12 timing processes (six per revision) and four diagnostic processes passed. The initial esbuild JS/CSS sizes also matched. The Vite dev runner completed 12 timing processes (six per revision) and four diagnostic processes, but it measures transform requests without capturing CSS/runtime hashes. Each runner's timing count is two fixtures × two revisions × three rounds; the two runners total 24 processes. Vite correctness is covered separately by the 205-test regression suite, including client/SSR HMR. These fixtures do not measure browser network/render time, Vite production builds, CJS benchmark timings or strict-PnP performance. ESM/CJS and npm/strict-PnP functionality were checked separately with the installed package contract, including eight Chromium computed-style checks.

The separate one-round diagnostic run records work counts rather than timing claims. For esbuild `styles-24`, each baseline unchanged rebuild ran Babel 25 times and sidecar esbuild 24 times; the candidate ran neither. For unused-token edits, candidate Babel work also fell to zero, while sidecar esbuild still ran 24 times. Vite `styles-24` edits reduced Babel work from two to one invocation, and unused-token edits reduced Babel work to zero; the wall-time regression shows that reduced compiler work alone does not establish an overall speedup. Input observation, validation and publication remain on the request path.

## Reproduction and raw records

Prepare separate release consumers with the [shared benchmark runner](./compilation-performance.md#reproducible-compilation-benchmark), then run:

```sh
yarn benchmark:compilation \
  --baseline=/path/to/pr10-npm --candidate=/path/to/pr11-npm \
  --baseline-label=pr10 --candidate-label=pr11 \
  --formats=esm --bundlers=esbuild,vite-dev \
  --cases=styles-24,tokens-unused-24 --rounds=3 \
  --output=/path/to/timing-results
```

For counters, repeat with `--rounds=1 --diagnostics` and a different output directory. The counter run here overlapped unrelated package-contract checks, so its timings should not be compared with the uninstrumented run. The three timing rounds ran after those checks completed.

- [Uninstrumented measurements](./benchmarks/pr11-memory-cache-timing.json): phase samples, distributions, output hashes, artifact sizes and compiler package hashes.
- [Separate diagnostic measurements](./benchmarks/pr11-memory-cache-diagnostics.json): per-phase work and I/O/hash counts, plus the same output validation.

The small fixture set, three rounds and one laptop establish local observations only. The raw distributions should be consulted when comparing small differences. Existing archived framework results in later stack commits are not measurements of this parent/candidate pair.

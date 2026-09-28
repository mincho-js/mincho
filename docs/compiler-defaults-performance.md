# Compiler default settings comparison

This comparison uses the same packed compiler with two configurations:

- Previous defaults: memory-only caching and `execution.evaluation: "fresh"`.
- New defaults: omitted cache and execution options.

Compiler workers remain automatic/inline in both configurations. The comparison
isolates the settings change and does not measure differences between revisions.

The harness clears fixture-owned caches before each cold sample. A restart uses
a new process, original source contents and retained caches. Unchanged and edited
builds use the original process. Timing runs exclude diagnostic instrumentation.
Production CSS hashes and esbuild runtime values are compared between settings.
Unchanged and restarted builds must preserve their original CSS/runtime hashes
and JS/CSS byte sizes. Vite development measures transforms without emitted
bundles or browser rendering.

See [compilation performance](./compilation-performance.md#measuring-the-defaults)
for the reproducible command and measurement limitations.

## Local measurements

Measured on 2026-10-10 with Node 24.21.0, Linux x64, an Intel i5-8265U (4 physical
cores, 8 available logical CPUs) and 15.3 GiB RAM. Both configurations use the same
npm-installed tarballs: esbuild 0.27.7, Vite 7.3.3, vanilla-extract integration
8.0.11 and CSS 1.21.2. Compiler entry hashes, tool versions and all five samples
per configuration are in [the measurement data](./compiler-defaults-performance.json).

Five rounds alternate configuration order and rotate fixture order. Each
incremental sample is the median of three iterations in that process. The table
shows median phase milliseconds, **previous defaults → new defaults**. Cold and
restart columns exclude package startup; the data also records process-to-first
result, total duration, close time, post-GC heap and Node peak RSS. Other build and
test jobs were stopped during timing.

| Bundler / fixture     |            Cold |         Restart |     Unchanged |          Edit |
| --------------------- | --------------: | --------------: | ------------: | ------------: |
| esbuild / recipe      |   232.8 → 281.8 |   236.3 → 146.6 |   29.8 → 28.0 |   25.1 → 24.6 |
| esbuild / vanilla-24  |   446.1 → 559.2 |   432.0 → 237.5 |   96.8 → 82.2 |   91.4 → 94.8 |
| esbuild / plain-240   |   310.6 → 309.6 |   304.1 → 315.4 | 149.3 → 149.2 | 145.9 → 145.3 |
| vite / recipe         |   474.5 → 437.5 |   395.2 → 274.2 |             — |             — |
| vite / vanilla-24     |   708.8 → 861.0 |   691.0 → 477.8 |             — |             — |
| vite / plain-240      |   829.3 → 834.9 |   854.4 → 841.3 |             — |             — |
| vite-dev / recipe     |   250.0 → 287.9 |   254.7 → 151.0 |     0.1 → 0.1 |   61.7 → 52.9 |
| vite-dev / vanilla-24 |  960.7 → 1250.5 |   948.3 → 891.7 |     0.4 → 0.4 |   47.4 → 58.2 |
| vite-dev / plain-240  | 3055.6 → 3047.3 | 3413.1 → 3050.5 |     1.1 → 1.1 |   44.2 → 47.5 |

For the 24-style esbuild fixture, restarting improves from 432.0 to 237.5 ms
(45.0%) and unchanged rebuilds from 96.8 to 82.2 ms (15.1%). The cold build rises
from 446.1 to 559.2 ms (25.4%). Vite production also improves its styled restart,
from 691.0 to 477.8 ms (30.9%), with a cold-build cost of 708.8 to 861.0 ms (21.5%).
These results support reuse across builds and processes; they do not establish
that the defaults improve every workload. In particular, vanilla-extract edits
in the development transform graph rise from 47.4 to 58.2 ms. Plain-input and
sub-millisecond transform differences should be read with the individual
samples, not as a general speedup.

For short-lived builds without a reusable cache directory, the previous
configuration remains available through memory caching plus fresh evaluation.
Choose the options with the workload's cold-build, repeated-build and memory
costs in mind. RSS here covers Node, not all native subprocesses; resource
sampling is a separate diagnostic run.

The separate diagnostic run confirms one guarded context creation and 23 context
reuses for the 24 styles. After a process restart, the new defaults record 24
validated transform hits, 24 compiled-sidecar hits and 24 evaluation-result
replays. The previous settings recompile those inputs. These counts are included
in the data file; instrumented timings are excluded from the comparison.

## Reproduction

Build and pack the candidate, then compare settings in the same consumer:

```sh
PACKAGE_PUBLISH=true yarn build
yarn benchmark:compilation --pack="$PWD" --candidate=/tmp/mincho-defaults
yarn benchmark:compilation \
  --baseline=/tmp/mincho-defaults --candidate=/tmp/mincho-defaults \
  --baseline-options='{"cache":{"type":"memory"},"execution":{"evaluation":"fresh"}}' \
  --candidate-options='{}' \
  --rounds=5 --formats=esm --cases=recipe,vanilla-24,plain-240 \
  --bundlers=esbuild,vite,vite-dev --restart \
  --output=.cache/compiler-defaults
```

Run diagnostics separately with `--rounds=1 --cases=vanilla-24
--bundlers=esbuild --first-only --restart --diagnostics --resources` and a separate
output directory. Instrumented durations are excluded from the table above.
Timing coverage is ESM; package consumer checks separately verify ESM/CJS entry
points with npm and strict Yarn PnP, including default and opt-out cache settings.

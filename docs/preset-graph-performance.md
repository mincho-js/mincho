# Measuring defineRules preset graphs

Run the benchmark from the repository root with its existing mise environment and Yarn strict PnP configuration:

```sh
mise exec -- yarn node scripts/benchmark-preset-graph.mjs --nodes=100 --copies=4
mise exec -- yarn node scripts/benchmark-preset-graph.mjs --shape=diamond --nodes=100 --copies=4
mise exec -- yarn node scripts/benchmark-preset-graph.mjs --shape=wide --nodes=100 --copies=4 --target=dist
```

The default target is current source, using the pinned development Node's native TypeScript transformation. `--target=dist` measures the last built CSS package; build it first when evaluating a code change. This development benchmark does not change the package's minimum supported Node version or relax PnP resolution.

Each case runs in a separate child process with a 512 MiB V8 heap limit and a 60-second timeout. Defaults are three warmups and twenty samples; `--warmups` and `--samples` accept positive integers. `--atoms` controls synthetic Atoms per node, with one as the default. Output is JSON lines containing median/p95 elapsed time and peak RSS. RSS includes module loading, fixture preparation and all timed operations in that child, not just one phase. Snapshot owners are prepared individually outside the timer rather than retained as a sample-sized array.

The report records Node version, options, a source fingerprint and the measured source/dist fingerprint. Files changing during measurement invalidate the run. Save the output with the candidate commit identifier and machine/load details; do not compare a stale dist build against unrecorded source.

## What each case measures

| Case        | Input and purpose                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`    | The same caller-owned artifact appears repeatedly. Validating one call does not make mutable input trusted on later calls.                                                 |
| `cloned`    | Separate JSON copies of the artifact; same graph, repeated serialized content.                                                                                             |
| `verified`  | A normalized, immutable parser result reused across inputs. This exercises internal verified-object reuse.                                                                 |
| `authoring` | Actual `defineRules` calls, each consuming the preceding owner's snapshot. This case always builds an empty-Atom chain, independently of the synthetic shape/Atom options. |

Synthetic cases report parsing, graph resolution, actual `defineRules`, first snapshot creation and repeated snapshot access separately. They contain a single graph with repeated input artifacts, not a simulation of multiple installed npm packages. Their Atom values are deliberately equivalent across producers so that each producer has its own class for a shared Atom identity.

## Separate graph size from input volume

Record unique node count **V**, reachable parent edge count **E**, total Atom records, and the sum of serialized input bytes. For a fixed 500-node graph, passing 64 overlapping artifacts still presents much more content to validate than passing one. A graph walk visiting each node once does not imply the entire operation costs only O(V + E): reading records, canonicalizing values and validating hashes also depends on input bytes and Atoms.

Likewise, a chain produced through 5,000 successive `defineRules` calls repeatedly supplies growing snapshots. That authoring workload differs from importing one already-built 5,000-node artifact. Immutable node reuse reduces repeated validation and allocation but does not eliminate graph traversal, metadata hydration or snapshot node-array creation.

Trusted reuse is restricted to normalized, deeply frozen outputs created after validation within the current module instance. Frozen caller objects, claimed hashes and objects from another ESM/CJS module instance do not bypass initial validation. Do not optimize a benchmark by dropping content checks, cycle/missing-parent diagnostics, origin revision checks or existing-class registration.

## Comparison and acceptance

Use the same runtime, machine, shapes, input bytes, Atom counts, sample counts and output assertions for baseline and candidate. Run them without other builds when drawing performance conclusions; repeat noisy results. Compare both raw external inputs and verified snapshots so a fast internal cache does not conceal a regression at the package boundary. Check peak RSS alongside latency.

Increase one dimension at a time: chain depth, diamond overlap, parent count, copies, then Atom count. Large authoring cases can exceed the child's time or memory limit even when a single artifact of the same size succeeds. A timeout is a failed measurement, not proof of a fixed supported-node ceiling. The Babel static evaluator's separate limits do not define the supported preset graph size.

Correctness gates remain the graph/input traversal, artifact diagnostics and verified-input regressions in `packages/css/src/defineRules`, plus real package builds. Benchmark success alone does not establish CSS cascade, lazy loading, ESM/CJS or strict PnP consumer compatibility. Measure final application CSS separately, including raw, gzip and Brotli bytes for compressed and uncompressed builds; this script does not measure CSS output size.

## Historical candidate run

A source run on Node 24.21.0 used the first command above: 100 nodes, four input artifacts, one synthetic Atom per node, three warmups and twenty samples. Its source/measured SHA-256 fingerprint was `49946cefda2261ac53c84b09bf9288128690a793f1d831a41e3670df7ab3324c`. Other repository builds were running concurrently, so this is a reproducibility record, not a controlled baseline comparison.

| Case                     | Timed operation             | Median ms | p95 ms | Child peak RSS MiB |
| ------------------------ | --------------------------- | --------: | -----: | -----------------: |
| Shared external input    | `defineRules`               |     45.21 |  55.63 |              233.0 |
| Cloned external input    | `defineRules`               |     35.82 |  42.30 |              232.8 |
| Verified immutable input | `defineRules`               |      0.85 |   1.31 |              179.4 |
| Authoring chain          | All 100 calls and snapshots |     30.93 |  39.88 |              232.5 |

Different validation workloads explain why the verified case is separate; its timing does not establish an equivalent speedup for arbitrary external packages. RSS covers the whole child, including the other phases described above.

The historical run above did not include an isolated-machine, matched baseline/candidate comparison. Exploratory timings from concurrent development builds are not release performance guarantees. In particular, the source regression coverage for 5,000/10,000-node traversal is not a claim that arbitrary authoring graphs at those sizes are inexpensive. Large-graph candidate timing and independent npm/ESM/CJS performance comparisons have not been run for this record.

## PR 01–03 baseline comparison

Measured on 2026-09-26 KST (2026-09-25 UTC, as recorded in the raw results) with Node 24.21.0 on an Intel Core i5-8265U. The baseline is main `0ee56d1a3ca772e9aab023b46947ee7e7b415eb9`; the candidate source is `a612044000cde2fc254c61e7190a0bc25ede6dac`. Both use the same benchmark runner from the candidate and the same runtime. Source fingerprints, input volumes, median/p95 timings and peak RSS are in [the raw results](preset-graph-pr-01-03-results.json).

Runs were serial, without concurrent repository tests or builds. Each child used two warmups and five timed samples. The 100/4 and 200/4 cases ran baseline then candidate; the 100/16 case reversed that order. These are workload measurements, not a guarantee of a fixed speedup. In particular, the verified case uses already validated immutable objects and is not equivalent to reading arbitrary external package data.

The synthetic shape is a chain with one Atom per node. Varying nodes from 100 to 200 holds copies at four; varying copies from four to sixteen holds nodes at 100. The authoring case always creates an empty-Atom chain and ignores the copies option, so repeated authoring rows do not measure an effect of input copies.

| Nodes / copies | Case      | Median ms, baseline → candidate | Peak RSS MiB, baseline → candidate |
| -------------- | --------- | ------------------------------- | ---------------------------------- |
| 100 / 4        | shared    | 93.14 → 37.54                   | 255.4 → 201.4                      |
| 100 / 4        | cloned    | 92.80 → 37.37                   | 254.1 → 201.9                      |
| 100 / 4        | verified  | 94.81 → 1.83                    | 254.4 → 176.8                      |
| 100 / 4        | authoring | 665.89 → 29.18                  | 333.8 → 200.1                      |
| 200 / 4        | shared    | 193.46 → 81.39                  | 321.6 → 238.5                      |
| 200 / 4        | cloned    | 196.77 → 142.83                 | 323.4 → 238.3                      |
| 200 / 4        | verified  | 195.72 → 3.45                   | 322.8 → 177.6                      |
| 200 / 4        | authoring | 2925.20 → 133.49                | 378.2 → 238.0                      |
| 100 / 16       | shared    | 526.14 → 176.92                 | 330.8 → 238.9                      |
| 100 / 16       | cloned    | 520.06 → 244.59                 | 332.1 → 240.6                      |
| 100 / 16       | verified  | 512.61 → 2.01                   | 331.5 → 179.1                      |
| 100 / 16       | authoring | 913.66 → 46.25                  | 333.4 → 199.6                      |

All benchmark assertions passed. This measurement covers moderate graph sizes; deep traversal correctness is covered separately by the preset graph and nested-input regression tests. No timing claim is made for arbitrary 5,000/10,000-node authoring graphs or installed package consumers.

To reproduce, run the candidate script from each checkout root using the same Node binary and that checkout's Yarn environment:

```sh
yarn node /path/to/candidate/scripts/benchmark-preset-graph.mjs --nodes=100 --copies=4 --warmups=2 --samples=5
yarn node /path/to/candidate/scripts/benchmark-preset-graph.mjs --nodes=200 --copies=4 --warmups=2 --samples=5
yarn node /path/to/candidate/scripts/benchmark-preset-graph.mjs --nodes=100 --copies=16 --warmups=2 --samples=5
```

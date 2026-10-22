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

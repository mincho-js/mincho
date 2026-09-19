# Parser cache calibration

This local review follow-up measures parser reads separately from whole builds.
Node 20.19.0 and Babel 7.29.0 ran five timing batches per operation, rotating the
operation order after warm-up. No tests or builds ran during this measurement.
The [raw samples](./benchmarks/pr11-parser-cache.json) include timings and three
retained-heap samples per fixture after a discarded warm-up sample. Heap samples
retain 400 small ASTs, 80 parser ASTs or 16 Vite ASTs and force GC before and after.

| Fixture       | Source bytes | Parse ms | Structured clone ms | Cache read ms | Serialized AST bytes | Median retained heap bytes/AST |
| ------------- | -----------: | -------: | ------------------: | ------------: | -------------------: | -----------------------------: |
| small-token   |           70 |    0.231 |               0.084 |         0.029 |                3,705 |                          6,107 |
| component     |          224 |    0.439 |               0.211 |         0.077 |                9,364 |                         15,544 |
| module-parser |        6,551 |    3.434 |               4.298 |         1.319 |              172,179 |                        266,313 |
| vite-plugin   |      285,038 |   51.472 |             148.340 |        52.796 |            5,117,545 |                      7,993,472 |

The cache read copies small ASTs with a property-preserving clone. Offsets,
comments, shared references and locations survive, while mutations stay isolated.
Babel's `cloneNode(ast, true, false)` was faster but dropped offsets in all four
fixtures, so it cannot replace that copy without changing parser behavior.

For inputs larger than 8,192 UTF-16 code units, reads reparse without storing or
cloning the AST. This conservative policy retains the measured benefit for the
small fixtures and avoids the large fixture's clone cost; it does not establish
an optimal crossover for every syntax shape. Syntax-only analysis stores just
its immutable summary, regardless of input size.

Retained ASTs are charged twice their V8-serialized size, plus the cache key. The
measured heap samples were approximately 1.46–1.73 times serialized size. The
factor of two provides headroom for these fixtures and replaces source-byte
accounting, which missed most node and location allocations. Serialization runs
only when retaining a freshly parsed AST, not on hits or syntax-only checks.
This is a calibrated cache estimate, not a hard heap/RSS bound or a guarantee for
other Node versions and workloads. The 512-entry/64 MiB LRU limits still apply.

Reproduce after building the Babel package, from the repository root:

```sh
yarn workspace @mincho-js/babel build
yarn node --expose-gc scripts/benchmark-parser-cache.cjs \
  4059f4800fa3c452d2236081cda21d6c6b721d2b > parser-cache.json
```

The revision selects fixture source only; the script measures the currently
built Babel package. Omit it to use working-tree fixtures. These microbenchmarks
do not remeasure the earlier PR 10/11 Vite or esbuild build timings.

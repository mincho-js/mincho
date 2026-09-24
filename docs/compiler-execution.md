# Compiler execution and worker transport

Vite and esbuild accept the same optional execution settings:

```ts
minchoVitePlugin({
  execution: { workers: 2, ioConcurrency: 16 },
});

minchoEsbuildPlugins({
  execution: { workers: 2, ioConcurrency: 16 },
});
```

`workers` defaults to `"auto"`. Compiler transforms stay inline by default;
Vite package graph analysis can use a worker when its selected graph payload
exceeds 512 KiB. `workers: 0` keeps both paths inline. A positive integer
enables eligible Babel and scoped dependency transforms in reusable workers,
subject to the detected CPU budget. These options also work through
`buildWithMincho({ mincho: { execution: ... } })`.

`libraryCss.analysis` selects Vite's graph strategy (`"auto"`, `"worker"`, or
`"inline"`); the shared execution budget can still choose inline execution.
Queued analysis retains its request snapshot if graph registrations change
while it is waiting.

## CPU and I/O limits

CPU detection is lazy. Linux combines allowed CPU topology, available
parallelism and nested cgroup quotas; macOS and Windows query physical core
counts. Unknown physical topology disables automatic worker admission.
An explicit count is capped by the available budget. Logical CPU counts are
not divided by two to estimate physical cores.

Compiler pools are lazy and shared by resolved worker entry. Each worker runs
one job at a time. Admission is bounded before creating transferable payloads;
when the queue is full, compilation runs inline. Thus the worker limit bounds
worker admission, rather than the total number of compiler calls in flight.
Opaque Babel callbacks, custom plugins and external Babel configurations use
the inline path. Provider callbacks run in the calling process, and nested
provider transforms run inline to avoid waiting on their own worker.

Generation changes cancel queued or running worker jobs and reject stale
results before publication. Closing an execution releases its pool ownership;
the last owner destroys the pool. Closing does not wait for bundler-owned
deferred publication. Startup failures can fall back inline; user compilation
errors retain their error metadata and are propagated.

`ioConcurrency` is an optional positive integer. When supplied, it caps leaf
filesystem operations used for input fingerprints and persistent cache
reads/writes. Instances with the same cap share an I/O pool. Provider callbacks
never hold an I/O permit. Without this option, filesystem work uses native
dispatch. Cache writes keep the atomic replacement and flush contract described
in [persistent compilation caching](persistent-compilation-cache.md).

## Source reuse and provider messages

With compiler workers explicitly enabled and caching allowed, source strings
of at least 32 KiB can be addressed by content. Initial delivery includes the
source. After protocol confirmation, later jobs may send a reference covering
source, options, compiler identity, environment and generation. A worker that
does not hold those bytes fetches the original job source over its message
port and validates it before use. Sender eviction or dispatch to another worker
does not imply a receiver hit.

The aggregate 64 MiB parser allowance is split into 56 MiB for parsed sources
and 8 MiB for transported source strings, partitioned across the sender and
CPU-budgeted workers. Entry limits, byte eviction, generation reset and backoff
after repeated misses bound retention. Small or oversized sources, disabled
caching, unavailable compiler identity and an older worker protocol use direct
source delivery.

Provider requests issued in the same microtask can share a batch of at most
64 messages. Every resolve/load call still executes, including duplicates;
provider results and project-engine effects are not memoized by transport.
Mutable ASTs and executable callbacks are not transferred.

Diagnostics include `cpu-budget`, `worker-wait`, `worker-pool-initialize`,
`worker-run`, `worker-overhead`, `worker-bypass`, `worker-ipc-source`,
`worker-ipc-fetch` and `worker-ipc-result`. Transport byte counts cover payload
fields, not complete structured-clone framing. Measure end-to-end builds before
enabling workers: startup and transfer can outweigh parallel execution.

## Verification

The integration package's `test` command builds its worker entry before Vitest
runs. Under Turbo (`TURBO_HASH` is set), the existing `test` dependency on `build`
provides that output, avoiding a second build while dependent packages run.

Source regressions cover CPU detection and quotas, I/O concurrency, worker
cancellation and recovery, nested providers, generation isolation, reference
bounds, missing payload retransmission and inline/worker output equivalence.
The installed package contract exercises ESM and CommonJS worker entries with
npm and strict Yarn PnP, checks source reuse and public option declarations,
and compares CSS from inline and worker-enabled Vite/esbuild builds.

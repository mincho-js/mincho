# Compiler worker transport and output writes

Worker activation and CPU admission limits are unchanged: `workers: "auto"` still does not enable compiler workers. With workers explicitly enabled, cached execution can reuse source strings of at least 32 KiB. First use stays inline. Later jobs may carry a content address covering the source, module/options, compiler identity, environment and generation. Every worker validates inline or fetched content before caching it. A worker missing the address requests the original job source through its existing `MessagePort`; sender eviction and arbitrary Tinypool dispatch therefore do not imply a receiver hit.

The existing aggregate 64 MiB parser allowance is divided into 56 MiB for parsed sources and 8 MiB for transported source strings, partitioned across the shared sender and CPU-budgeted workers. Entry limits, byte eviction, generation reset and bounded backoff after repeated receiver misses limit retention and unnecessary fetches. Small or oversized sources, `cache: false`, `evaluation: "fresh"`, missing compiler identity and an older worker protocol use direct source delivery. This layer does not cache mutable ASTs, provider results or general Babel option objects.

Provider messages issued together may share a microtask batch of at most 64 requests. Every `resolve`/`load` call, including duplicates, still executes in request order; provider results and project-engine registry effects are not coalesced. `worker-ipc-source`, `worker-ipc-fetch` and `worker-ipc-result` diagnostics report source/reference bytes, cache hits/misses, fetch bytes, request counts and batch counts. Byte counts describe these payload fields, not complete structured-clone transport framing. These counters are evidence for reuse; they are not a speedup claim.

Disk compilation cache entries and JSON/trace reports use the same atomic writer. Concurrent owners coordinate by output path, keeping only the latest queued value for that path and retaining no completed path/content cache. Different cache entry paths remain independent. Serialization is deferred until a write is selected; oversized disk records can be skipped. Generation guards run again after awaited I/O and before replacement. Identical content is verified against the actual file with at most 64 KiB of comparison scratch space, so deleted or externally changed files are recreated. Temporary files are cleaned up on failure, later writes remain usable, and existing cache/report `flush()` boundaries drain their pending writes. Disk cache output stays optional; report write failures still reject `flush()`.

`disk-cache-write*` and `diagnostic-write-*` events distinguish written, coalesced, unchanged, stale, skipped and failed work when a compilation diagnostic context is active. Other worker isolates or processes still rely on atomic replacement and cache manifest validation; the in-flight path queue coordinates owners sharing this writer module in one JavaScript execution environment.

Targeted regression coverage:

- [compilerPayload.test.ts](../packages/integration/src/compilerPayload.test.ts): size/entry bounds, identity isolation, content validation, eviction and low-reuse fallback.
- [compilerTransport.test.ts](../packages/integration/src/compilerTransport.test.ts): sender eviction, worker misses, generation reset, direct/fresh paths, protocol fallback, provider ordering and failed batched transport.
- [coalescedWriter.test.ts](../packages/integration/src/coalescedWriter.test.ts): multiple owners, separate paths, stale publication, drain, content repair and failure recovery.
- [diskCache.test.ts](../packages/integration/src/diskCache.test.ts), [diagnostics.test.ts](../packages/integration/src/diagnostics.test.ts): real persistence/report wiring and unchanged output.
- [compilationExecution.test.ts](../packages/integration/src/compilationExecution.test.ts): worker lifecycle, abort/close, nested providers and visibility of fresh evaluation context.

Transport unit tests fix compiler identity to isolate the protocol from artifact
changes and separately test identity failure. Actual worker lifecycle tests run
alongside them; installed npm/PnP contracts verify the packaged integration.

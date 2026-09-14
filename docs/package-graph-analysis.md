# Package graph analysis

`@mincho-js/integration/package-graph` exports the graph collection, merging, and
style ordering APIs without loading Babel, esbuild, or the preset registry. Both
ESM and CommonJS entry points include their own declarations. Existing exports
from `@mincho-js/integration` remain available.

```ts
import {
  collectDefineRulesPackageGraph,
  getDefineRulesPackageStyleSpecifiers,
  mergeDefineRulesPackageGraphs,
} from "@mincho-js/integration/package-graph";

// Preset artifacts must already have passed V5 validation.
const graph = collectDefineRulesPackageGraph(validatedPresets, {
  owner: moduleId,
});
const combined = mergeDefineRulesPackageGraphs([graph]);
const styles = getDefineRulesPackageStyleSpecifiers(combined);
```

Collection preserves parent-first order and records dependency witnesses.
Merging preserves the supplied graph order for unrelated packages. Style ordering
excludes local packages by default; `excludePackages: []` includes them. Package
cycles are diagnosed before exclusions are applied, retaining the source owners
needed to investigate the conflict. This entry does not validate preset hashes or
execute stylesheet code.

The installed package contract verifies both module formats and strict
declarations under npm and Yarn strict PnP. It also checks that the complete
runtime dependency graph stays within the graph-only implementation.

## Vite worker service

Vite's internal `createPackageGraphAnalysis` service has `worker` and `inline`
execution modes. Both use the same merge and cycle checks. Callers register each
module's graph and supply module IDs in output declaration order, so asynchronous
registration order does not change CSS order. Registration and request data are
snapshotted, and full module IDs retain query strings and virtual prefixes.

`beginGeneration()` clears previous records and rejects pending requests from an
older build. Stale registrations and removals are ignored. A diagnosed graph does
not prevent later analysis; an unexpected worker failure rejects pending work and
requires a new generation before retrying. `close()` rejects pending work,
terminates the worker, and is terminal and idempotent.

The worker starts on the first graph registration and is reused across outputs
and generations. It is unreferenced while idle. ESM and CommonJS worker artifacts
live alongside their package entry, inheriting Node loader arguments and the
environment needed by strict PnP. Source-level worker tests require a package
build first, which the workspace test pipeline performs automatically.

The native library CSS linker registers graphs during transforms and awaits each
output's static dependency scope before returning its final chunk. Select the
execution mode with `libraryCss.analysis: "worker" | "inline"`; the default is
`"worker"`. See [native CSS finalization](vite-css-finalization.md) for output
naming, watch generations, and the single-build linking contract. Compiler worker
pools and payload-based execution selection are separate changes.

Regression tests cover inline/worker parity, output order, cycle witnesses,
generation cancellation, worker exit and recovery, and shutdown. Installed npm
and strict PnP consumers also start both worker formats and verify their results
against the graph-only entry without pulling compiler code into the worker.

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

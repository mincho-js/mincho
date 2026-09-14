---
"@mincho-js/vite": minor
---

Link library CSS before native JavaScript hashing and source-map composition in a
single Vite build. Support hashed split CSS, shared and lazy chunks, and fixed
unsplit CSS through `libraryCss.fileName`. Unsplit library consumers must configure
this path to match Vite's CSS output; implicit late CSS filename discovery has
been removed.

Analyze each entry's package dependency graph in a lazy Node worker by default,
with `libraryCss.analysis: "inline"` available for hosts that prefer synchronous
analysis. Preserve stable topological style order, isolate watch generations and
use ESM/CJS worker entries compatible with strict Yarn PnP through the existing
compiler-free `@mincho-js/integration/package-graph` API.

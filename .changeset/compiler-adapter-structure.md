---
"@mincho-js/babel": patch
"@mincho-js/integration": patch
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
---

Separate compiler analysis, code generation, source-provider adapters and CSS
state into focused modules. Share caller-based module resolution, native loader
inference and static-evaluation metadata helpers across build integrations while
preserving generated JavaScript, CSS ownership and package entry points.

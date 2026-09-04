---
"@mincho-js/babel": patch
"@mincho-js/esbuild": patch
"@mincho-js/integration": patch
"@mincho-js/transform-to-vanilla": patch
---

Harden static extraction, dependency loader composition, and asset handling. Preserve the existing fallback when a static CSS prepass reaches its owner traversal limits, independently of per-literal evaluation limits.

Keep source, file scope, and dependency metadata through Vite/esbuild transformations and declare the dependencies required by strict package managers.

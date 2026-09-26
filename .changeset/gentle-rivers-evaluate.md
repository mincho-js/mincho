---
"@mincho-js/integration": patch
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
---

Add opt-in guarded vanilla-extract evaluation through
`execution.evaluation: "auto"`. Reuse proved contexts and serialized results
with bounded caches, input validation, independent registry snapshots, and
fresh evaluation fallbacks. Fresh evaluation remains the default.

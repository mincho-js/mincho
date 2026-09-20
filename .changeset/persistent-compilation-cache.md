---
"@mincho-js/integration": patch
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
---

Add an opt-in filesystem compilation cache with validated process restart reuse,
CSS and asset replay, and atomic coalesced writes. Keep memory-only caching as the
default and expose the shared cache options through the bundler integrations.

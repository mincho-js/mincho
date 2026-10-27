---
"@mincho-js/babel": patch
"@mincho-js/css": patch
"@mincho-js/esbuild": patch
"@mincho-js/integration": patch
"@mincho-js/transform-to-vanilla": patch
"@mincho-js/vite": patch
---

Update compiler and runtime dependencies to patched releases. Validate the
dist-chunk and static-style adapters with Vite 7.3.7 and vanilla-extract CSS 1.21.3,
and serialize MagicString source maps at the Rollup plugin boundary.

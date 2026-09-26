---
"@mincho-js/integration": patch
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
---

Enable persistent compilation caches and guarded evaluation reuse by default in
Vite and esbuild. Missing or unusable cache entries fall back to compilation, and
unsupported evaluation contexts retain fresh evaluation. Use `cache: false` to
disable compilation caching, `cache: { type: "memory" }` to avoid disk writes, or
`execution: { evaluation: "fresh" }` to disable VM and evaluation-result reuse.

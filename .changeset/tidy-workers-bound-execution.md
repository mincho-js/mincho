---
"@mincho-js/integration": patch
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
---

Add opt-in compiler workers and bounded filesystem scheduling with shared CPU
budgets, generation cancellation and bounded source transport reuse. Expose
execution settings in Vite and esbuild while keeping compiler transforms inline
by default, and select Vite graph execution according to payload size and budget.

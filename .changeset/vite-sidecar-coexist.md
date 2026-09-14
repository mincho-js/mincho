---
"@mincho-js/vite": patch
---

Give Mincho-owned extracted sources private JavaScript virtual module IDs so
vanilla-extract does not attempt to reload them as physical CSS files. Preserve
physical compile paths, preset origins, generated classes and relative imports,
and invalidate both aliases when an owner changes or is removed. Verify ESM/CJS
coexistence and the packaged CommonJS worker path in npm and strict Yarn PnP.

---
"@mincho-js/vite": patch
---

Preserve resolved module metadata while preloading library dependencies. Packages
that mark JavaScript as free of side effects can then drop unused authoring code
without losing explicitly imported CSS assets.

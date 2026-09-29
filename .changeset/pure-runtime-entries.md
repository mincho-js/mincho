---
"@mincho-js/css": patch
"@mincho-js/babel": patch
---

Expose a pure ESM/CommonJS `@mincho-js/css/classname` entry and isolate recipe and
scoped class runtime modules so unused generated helpers can be removed without
dropping CSS authoring or registry effects. Babel imports generated class merging
from the classname entry and removes unused compiler-owned imports. Babel
requires the matching CSS release as a peer dependency so generated imports
resolve the new runtime subpath. Update the CSS package alongside Babel.

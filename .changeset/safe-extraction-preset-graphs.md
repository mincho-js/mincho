---
"@mincho-js/css": patch
"@mincho-js/integration": patch
---

Traverse deep preset dependency graphs without recursive calls.

Handle deeply nested preset inputs and reject array cycles without recursive traversal.

Avoid repeated canonical hash calculations and reuse privately verified immutable preset nodes.

Order package CSS by dependency and accept preset artifacts and registry sessions across ESM/CJS declaration formats. Validate both formats against installed packages while keeping cold source type builds independent of release output.

Serialize registry operations across ESM/CJS module instances.

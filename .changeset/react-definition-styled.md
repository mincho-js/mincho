---
"@mincho-js/react": minor
---

Add a React `defineRules()` adapter that accepts a core CSS definition, keeps
its `css`, `rules`, `cx`, and `preset`, and adds a typed `styled` factory for
intrinsic elements. Components use the definition's tokens and compile to the
existing styled runtime and static recipes.

Dynamic length props convert numeric values to pixels. Unitless properties and
explicit CSS strings retain their values; mixed length and unitless targets
require an explicit string for nonzero values.

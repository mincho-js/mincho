---
"@mincho-js/css": major
---

Remove the `theme(contract, replacementTokens, debugId?)` form. Replace existing-contract themes with `theme.extends(...)`. `theme.with<T>()` handles now provide type-fixed `handle.extends(...)` support.

Direct theme creation reserves the top-level `{ vars, values, cssVarByPath }` shape when all three fields are plain objects. Nest or rename token groups with this shape; the public input types now match the runtime contract check.

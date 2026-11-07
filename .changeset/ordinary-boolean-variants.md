---
"@mincho-js/css": minor
"@mincho-js/react": minor
---

Remove the separate `toggles` option from `rules`, compatibility `recipe`, and
`styled`. Define boolean states with ordinary `variants` instead:
`variants: { active: { true: { opacity: 1 }, false: { opacity: 0.5 } } }`.

Migrate each existing toggle style into its variant's `true` branch. Boolean
selections, defaults, compound conditions and inheritance remain supported.
When merging existing definitions, place the migrated boolean groups after the
original variant groups to preserve their class ordering.

Public generic types no longer take a separate toggle parameter:
`PatternOptions<Variants, Props>`, `PatternOptionsToProps<Variants, Props>` and
`StyledComponent<ComponentProps, Component, Variants, Props>`. The
`ConditionalVariants` merge type is removed.

Recipes without variants accept empty selections and defaults. Array selections
ignore `__proto__` entries without inheriting their properties.

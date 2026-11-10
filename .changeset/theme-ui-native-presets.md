---
"@mincho-js/theme-ui": minor
"@mincho-js/preset-theme-ui": minor
"@mincho-js/css": patch
---

Add separate Theme UI contract and preset packages for Mincho. Provide token
contract types, the shared `themeSpec(vars)` property mappings, and optional
`normalizeTheme()` conversion for original Theme UI token values.

Ship normalized preset values, compiled theme classes, color modes, variables,
and an explicit static stylesheet. Each preset exposes native `css`, `rules`,
`cx`, and `preset` APIs so consumers create their own component styles. Custom
themes use native `theme()` and `defineRules()`.

Preserve the upstream preset values and Theme Spec semantics with Mincho's CSS
types. Use original Theme UI types only as development compatibility references.

Resolve conditional token values before generating atomic styles, and decompose
spacing shortcuts into directional properties for precise `cx()` composition.

Allow optional condition maps in `defineRules()`, omitting undefined entries,
so dynamically sized breakpoint maps do not promise missing condition keys.

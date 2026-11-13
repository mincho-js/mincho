---
"@mincho-js/babel": minor
"@mincho-js/integration": minor
"@mincho-js/vite": minor
"@mincho-js/esbuild": minor
"@mincho-js/react": minor
"@mincho-js/transform-to-vanilla": patch
---

Allow JSX CSS props to use a module's `defineRules()` CSS function through
`jsxCssProp: { importSource }`. Register the same function with React's
`CssPropConfig` interface to type-check the definition's properties and tokens
directly in JSX. Styles remain compiled to static CSS.

Allow dotted export paths such as `system.css` in `extractCalls` so presets
can publish reusable extraction metadata for their named definitions.

Share compile-time numeric unit classification with React's definition adapter.

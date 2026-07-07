---
"@mincho-js/react": minor
"@mincho-js/babel": minor
"@mincho-js/integration": minor
"@mincho-js/vite": minor
"@mincho-js/esbuild": minor
---

Add optional React JSX `css` prop v2 support through scoped React JSX runtime exports and opt-in `jsxCssProp` transform, integration, Vite, and Esbuild options. Inline object `css` props compile through Mincho CSS-rule extraction, existing class values compile through `cx(...)`, and custom/member/custom-element targets rely on a `className` forwarding contract with runtime guards for missed transforms.

---
"@mincho-js/babel": patch
---

Support nested explicit JSX `css` prop spread aggregation and additional static CSS evaluation patterns.

Nested explicit JSX `css` prop spread aggregation now lowers safely outside direct statement-list positions, while direct return and expression-statement cases keep their existing hoisted behavior. Static evaluation now also supports static computed keys, optional members on proven values, supported primitive template interpolation, and deterministic CommonJS paths. The React README and site docs were updated to describe the new support and remaining guardrails.

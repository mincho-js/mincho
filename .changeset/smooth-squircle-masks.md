---
"@mincho-js/css": minor
"@mincho-js/react": minor
---

Add a fixed-size `squircle()` class pattern, framework-independent squircle
geometry helpers, and the polymorphic React `SquircleMask` component. Corners are
clipped with `clip-path`: fixed sizes render an exact `path()` on the server
without DOM measurement, and responsive sizes share a class rule with one
size-independent CSS `shape()`, inserted on mount. A shared observer checks for
size constraints; exact measured paths handle clamped corners, unsupported
`shape()`, and blocked stylesheets. Server-rendered base styles preserve the
border box and rounded fallback through hydration.

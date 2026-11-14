---
"@mincho-js/css": patch
"@mincho-js/integration": patch
---

Export the existing `mincho$` static block helper for styles authored beside
components. Resolve extracted dependency styles within their own package scopes
so published presets retain valid origins when used through co-location.

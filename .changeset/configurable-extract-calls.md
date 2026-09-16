---
"@mincho-js/babel": minor
"@mincho-js/integration": minor
"@mincho-js/esbuild": minor
"@mincho-js/vite": minor
---

Add declarative extractCalls registrations for package exports and root-relative
local style factories. Protect local implementations and reachable helpers from
independent extraction, retain mincho-js-ignore behavior, and track dependencies
for rebuilds and HMR without treating custom calls as read-only.

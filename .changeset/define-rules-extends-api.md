---
"@mincho-js/css": minor
"@mincho-js/babel": minor
---

Add `defineRules.extends(parent, config)` to inherit configuration and preset snapshots, merge named values, and replace allowed-value arrays with child definitions.

Preserve definition metadata through serialization, defer imported definition registration until CSS is used, and recognize extended definitions when optimizing scoped `cx` calls.

---
"@mincho-js/esbuild": minor
"@mincho-js/integration": patch
---

Add the opt-in `buildWithMincho` API to order preset package CSS before native esbuild linking. Isolate input snapshots per transaction, validate both build passes before publishing, and restore touched outputs when publication fails.

Allow child compilations to read source and asset bytes through the transaction snapshot so changed inputs cannot leak between passes.

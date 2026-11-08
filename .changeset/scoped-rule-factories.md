---
"@mincho-js/css": minor
---

Return a scoped `rules` factory from `defineRules()` and `defineRules.extends()`.
Recipe base, variant, and compound styles use the definition's properties,
tokens, shortcuts, conditions, and authoring context. Keep the existing recipe
runtime, boolean variant inference, dynamic props, and inheritance behavior.

Support `raw`, `multiple`, `with`, and `extends` helpers and serialization of
exported authoring factories. Generated recipes do not carry the scoped resolver
into application runtime bundles.

Preserve contextual typing and editor completions for scoped styles, callbacks,
variant selections, and dynamic props across the authoring helpers, including
independent recipes in `multiple()` and inherited variants in `extends()`.
Use TypeScript 5.7 or newer for inference across all scoped recipe helpers;
TypeScript 5.4–5.6 cannot infer some `rules.multiple()` compound callbacks.
Loading the package's public root declarations now requires at least TypeScript
5.4 due to the scoped recipe types' built-in `NoInfer` intrinsic. This also applies to
consumers that only use `css` or standalone `rules`, and to packages such as
`@mincho-js/react` that load these declarations.

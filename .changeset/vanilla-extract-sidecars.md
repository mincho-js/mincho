---
"@mincho-js/babel": minor
"@mincho-js/esbuild": patch
"@mincho-js/vite": patch
"@mincho-js/integration": patch
---

Extract vanilla-extract CSS definitions, Recipes and Sprinkles factories into
Mincho CSS sidecars from ordinary source files. Match APIs by their import
source, support Mincho compatibility exports and preserve dynamic runtime APIs.
Verify mixed styles and serialized runtime functions in esbuild and Vite builds.

Low-level CSS artifact serializers must pass `compile().cssScopeOrigins` together
with the same compiled `source` to Mincho’s
`processDefineRulesPresetRegistryFile`. Artifact callbacks now require this
explicit physical-producer metadata. When compiler-issued runtime origin metadata is present, multiple physical producers emitting under the same explicit package/file scope are rejected, including CSS-text output. Metadata-free legacy CSS text cannot identify those collisions; assign each producer a distinct scope ID. See
[CSS bundling](https://github.com/mincho-js/mincho/blob/main/docs/css-bundling.md) for the complete callback migration example.

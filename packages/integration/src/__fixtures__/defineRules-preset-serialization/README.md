# defineRules preset serialization fixtures

These fixtures lock the build-time contract for sharing `defineRules` preset output across package boundaries.

## Why generated files are tracked

- `provider-module/dist/esm/index.mjs` and `provider-module/dist/style.css` model the already-built output of a published preset provider.
- `node_modules/@mincho-js-proof/*` directories model consumers importing that published provider through normal package resolution.
- The generated `dist/` files and fake `node_modules` packages are intentionally committed so tests can detect drift in the serialized JS shape, sidecar CSS contract, and package-boundary resolution without depending on a separate publish step.

## Regeneration and verification contract

There is no separate generator script for this fixture set. When a fixture source changes, update the corresponding tracked `dist/` or fake package files in the same change and keep the diff limited to the expected serialized JS/CSS output.

Verify the contract with:

```bash
yarn vitest run "packages/integration/src/defineRulesPreset.ts"
yarn vitest run "packages/vite/src/index.ts" -t "defineRules|preset|fixture|build artifact|real Vite"
yarn vitest run "packages/esbuild/src/index.ts" -t "defineRules|preset|fixture|extracted-css|real esbuild"
```

Expected fixture diffs are limited to:

- class-name changes caused by intentional preset/style changes;
- serialized `presets` object changes that match the source fixture's static `css(...)` calls;
- sidecar CSS changes required for provider exports consumed through package imports.

Unexpected fixture diffs include removed sidecar imports, missing fake package metadata, leaked `__MINCHO_DEFINE_RULES_SENTINEL__:` values, or runtime `css({ ... })` calls left where a static class literal should be emitted.

## Unsupported callsite matrix

The unsupported fixtures are intentional fail-fast boundaries, not missing happy paths:

- `unsupported-helper-wrapped` (`negative-helper-wrapped/`): `defineRules(...)` hidden behind a helper function.
- `unsupported-non-top-level` (`negative-non-top-level/`): `defineRules(...)` nested in another expression or callback.
- `unsupported-non-object-literal` (`negative-non-object-literal/`): `defineRules(config)` where the config is not an object literal at the callsite.

These forms currently throw the locked preset-backfill mismatch error instead of being silently serialized. PRs that touch this fixture matrix should state whether each unsupported form remains fail-fast or is deliberately promoted into the supported matrix.

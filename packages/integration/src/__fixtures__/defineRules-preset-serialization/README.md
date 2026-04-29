# defineRules preset serialization fixtures

These fixtures lock the build-time contract for sharing `defineRules` preset output across package boundaries.

## Why generated files are tracked

- `provider-module/dist/esm/index.mjs` and `provider-module/dist/style.css` model the already-built output of a published preset provider.
- `node_modules/@mincho-js-proof/*` directories model consumers importing that published provider through normal package resolution.
- The generated `dist/` files and fake `node_modules` packages are intentionally committed so tests can detect drift in the serialized JS shape, sidecar CSS contract, and package-boundary resolution without depending on a separate publish step.

## Registry contract

The registry fixtures describe what actually executes while the extracted CSS module is evaluated. The base eval-executed cases cover direct and destructured owner exports, helper-wrapped calls, IIFEs, and const-config values. Each one must serialize when the evaluation path invokes it.

Serialized preset artifacts use the v3 shape:

```ts
{
  schema: "mincho.defineRulesPreset",
  version: 3,
  classNameByCache: {
    "<cache-key>": "<class-name>"
  }
}
```

`classNameByCache` must be populated from executed `css(...)` calls.

## Regeneration and verification contract

There is no separate generator script for this fixture set. When a fixture source changes, update the matching tracked `dist/` or fake package files in the same change and keep the diff limited to the expected serialized JS/CSS output.

Verify the contract with:

```bash
yarn vitest run "packages/integration/src/defineRulesPreset.ts" -t "registry fixture matrix"
yarn vitest run "packages/vite/src/index.ts" -t "defineRules|preset|fixture|build artifact|real Vite"
yarn vitest run "packages/esbuild/src/index.ts" -t "defineRules|preset|fixture|extracted-css|real esbuild"
```

Expected fixture diffs are limited to:

- class-name changes caused by intentional preset/style changes;
- serialized v3 `classNameByCache` artifact changes that match the source fixture's executed `css(...)` calls;
- sidecar CSS changes required for provider exports consumed through package imports.

Unexpected fixture diffs include removed sidecar imports, missing fake package metadata, legacy capture markers, or runtime `css({ ... })` calls left where a static class literal should be emitted.

# defineRules preset serialization fixtures

These fixtures lock the build-time contract for sharing `defineRules` preset output across package boundaries.

## Why generated files are tracked

- `provider-module/dist/esm/index.mjs` and `provider-module/dist/style.css` model the already-built output of a published preset provider.
- `node_modules/@mincho-js-proof/*` directories model consumers importing that published provider through normal package resolution.
- The generated `dist/` files and fake `node_modules` packages are intentionally committed so tests can detect drift in the serialized JS shape, sidecar CSS contract, and package-boundary resolution without depending on a separate publish step.

## Registry contract

The registry fixtures describe what actually executes while the extracted CSS module is evaluated. The eval-executed cases cover helper-wrapped calls, IIFEs, nested functions, imported helpers, const-config values, and multiple live `defineRules(...)` instances. Each one must serialize when the evaluation path invokes it.

`registry-exported-factory-not-executed` is the exported factory boundary. A factory that would call `defineRules(...)` does not serialize a preset artifact until the factory runs during `.css.ts` evaluation.

`registry-function-config-invalid` is the function-valued config boundary. Function-valued `properties` or `shortcuts` can't be represented in the preset artifact, so public `defineRules(...)` calls with function-valued config are not registered and do not serialize a preset artifact. Their local `css.raw(...)` usage still executes normally.

Serialized preset artifacts use the V4 shape:

```ts
{
  schema: "mincho.defineRulesPreset",
  version: 4,
  classNameByCache: {
    "<cache-key>": "<class-name>"
  },
  writeKeyByCacheKey: {
    "<cache-key>": 0
  },
  conditionById: {
    0: {
      layer: null,
      supports: null,
      media: null,
      container: null,
      selector: "&"
    }
  },
  propertyById: {
    0: "<property-name>"
  },
  writeKeyById: {
    0: {
      conditionId: 0,
      propertyId: 0
    }
  }
}
```

`classNameByCache` and `writeKeyByCacheKey` must be populated from executed `css(...)` calls. Empty artifacts only belong to cases where no `defineRules(...)` instance ran during evaluation.

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
- serialized V4 preset artifact changes that match the source fixture's executed `css(...)` calls;
- sidecar CSS changes required for provider exports consumed through package imports.

Unexpected fixture diffs include removed sidecar imports, missing fake package metadata, or runtime `css({ ... })` calls left where a static class literal should be emitted.

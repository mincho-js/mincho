# Runtime package boundaries

`@mincho-js/css/classname` exports the root package's `cx` function and class-name
types through dedicated ESM and CommonJS entries. Use it when application code
only needs class merging. `cx.multiple` and `cx.with` retain the same behavior and
function identity as the corresponding root export.

| Public entry                                            | JavaScript boundary                                 | Declaration location                                    |
| ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `@mincho-js/css/classname`                              | `dist/{esm,cjs}/runtime/classname`                  | `dist/{esm,cjs}/classname/index`                        |
| `@mincho-js/css/rules/createRuntimeFn`                  | `dist/{esm,cjs}/runtime/createRuntimeFn`            | `dist/{esm,cjs}/rules/createRuntimeFn`                  |
| `@mincho-js/css/defineRules/createDefineRulesCxRuntime` | `dist/{esm,cjs}/runtime/createDefineRulesCxRuntime` | `dist/{esm,cjs}/defineRules/createDefineRulesCxRuntime` |

JavaScript files use `.mjs`/`.cjs` and declarations use `.d.ts`/`.d.cts`. Each
runtime directory has its own `package.json` declaring `sideEffects: false`.
Shared recipe and class-name chunks stay inside that directory. The CSS authoring
entry, definition registration and registry modules retain their existing effect
declarations outside the pure boundary.

Babel emits class-merging imports from the classname entry. After extraction,
it removes unreferenced, constant bindings that it recorded as generated imports.
This also removes their empty generated declarations. Explicit authored module
effect imports remain, including bare CommonJS `require` calls. Update CSS and
Babel together so the generated code can resolve the new subpath. Babel declares
CSS as a required `workspace:^` peer. Changesets versions both packages before
release, and packing replaces this range with the new CSS version's caret range,
excluding releases that lack the classname entry.

The installed-package contract verifies both npm and strict Yarn PnP consumers:

- Root/subpath `cx` identity and ESM/CommonJS declaration resolution.
- Pure runtime manifests and the authoring package's effect declaration.
- Removal of unused factory calls marked `/*#__PURE__*/` together with their
  serialized configuration, using ESM inputs and both ESM/CommonJS output.
- Dynamic recipe/scoped class-merging behavior and absence of compiler, registry
  and CSS authoring code from the runtime consumer output.
- Native ESM and CommonJS classname consumers below 4 KiB, with dependency-graph
  checks excluding authoring modules. The fixture reports raw and gzip sizes.

Run `yarn build:release` followed by `yarn check:package-contract`. The contract
uses packed, separately installed packages. Babel tests additionally check
generated helper cleanup, authored effects and CommonJS output directly.

On 2026-10-10, Node 24.21.0 and esbuild 0.27.7 produced the following minified
fixture sizes. npm and strict Yarn PnP installations produced identical counts.
The sizes include the retained export and any module-format wrapper.

| Fixture                                             | ESM raw / gzip bytes | CommonJS raw / gzip bytes |
| --------------------------------------------------- | -------------------: | ------------------------: |
| Unused pure factories plus a retained string export |              37 / 57 |                 478 / 306 |
| Dynamic recipe and scoped class merging             |        3,019 / 1,335 |             3,460 / 1,545 |
| Classname subpath consumer                          |            829 / 431 |               1,107 / 579 |

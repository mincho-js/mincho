# Registering additional build-time calls

Use `extractCalls` to move calls to your own style factories into Mincho's CSS
sidecars. Registrations add to the built-in Mincho and vanilla-extract APIs.

```ts
import { minchoVitePlugin, type ExtractCalls } from "@mincho-js/vite";

const extractCalls: ExtractCalls = {
  "@acme/styles": ["style", "recipe"],
  "./src/style-utils.ts": ["defineStyle", "default"],
};

export default {
  plugins: [minchoVitePlugin({ extractCalls })],
};
```

The public type is `Readonly<Record<string, readonly string[]>>`. It is exported
by `@mincho-js/babel`, `@mincho-js/integration`, `@mincho-js/esbuild` and
`@mincho-js/vite`. Empty settings preserve the defaults. Repeated names and
registration order do not change the output.

## Configuration entry points

```ts
// esbuild plugin
minchoEsbuildPlugins({ extractCalls });

// esbuild build API
await buildWithMincho({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  mincho: { extractCalls },
});

// integration API: source is the caller's JavaScript or TypeScript text
await babelTransformSource({
  filename: "/project/src/index.ts",
  root: "/project",
  source,
  babel: { extractCalls },
});

// Babel plugin
const options = { extractCalls, result: ["", ""] };
transformSync(source, {
  filename: "/project/src/index.ts",
  root: "/project",
  plugins: [[minchoBabelPlugin(), options]],
});
```

Vite also accepts `babel: { extractCalls }`. When both settings are present,
the top-level option wins, including an explicit `{}`. Built-in APIs always
remain enabled. This setting does not require `jsxCssProp`.

## Package imports and local files

Package registrations match the import specifier and export name. Aliased named
imports, namespace calls (`styles.defineStyle(...)` and
`styles["defineStyle"](...)`) and default imports are supported. Use `"default"`
for a default export. Unrelated imports and shadowed local names do not match.

Local registrations use paths relative to the project root: Vite's `root`,
esbuild's `absWorkingDir`, Babel's `root`, or the integration API's `root`.
Their normal defaults apply when omitted. Prefer explicit source extensions,
such as `"./src/style-utils.ts"`.

Local calls match the resolved file rather than the spelling of the caller's
import. A registration for `"./src/style-utils.ts"` therefore also recognizes
`import { defineStyle } from "../style-utils"` in a nested component. Vite and
esbuild use their existing resolver and source loader, including aliases.
Babel alone uses Node/PnP resolution with TypeScript source extensions; it does
not infer bundler-only aliases.

Calls inside the registered factory's own module are extracted too, including
local bindings reached through renamed exports or re-exports. Shadowed names
remain untouched, and implementation bodies retain the protection described below.

## Protecting a local implementation

```ts
// src/style-utils.ts
import { style, type StyleRule } from "@vanilla-extract/css";

export function defineStyle(rule: StyleRule) {
  return style(rule);
}

export default defineStyle;
```

```ts
// src/components/button.ts
import { defineStyle } from "../style-utils";

export const button = defineStyle({ color: "tomato" });
```

Mincho protects the registered function body and its reachable local helpers
from independent call extraction. It executes the call from `button.ts` inside
the sidecar's file scope. Unrelated styles in the implementation module continue
to be extracted normally. Protection also works when the implementation is
transformed before the caller, or when there are multiple entry points.

Supported implementations include function declarations, arrow functions,
constant aliases, default exports and statically resolvable ESM or CommonJS re-exports.
Captured callbacks and helpers in local modules are followed. Ambiguous
re-exports, mutable implementation aliases, dynamically selected local namespace
helpers and factory exports produced by another function call cannot be
identified reliably and produce a diagnostic naming the registration.

For source files in your project, register the root-relative file path to enable
implementation protection. A package-specifier registration selects calls;
it does not turn an arbitrary source file into a protected local implementation.

Changes to implementations and their re-export/helper dependencies invalidate
the generated CSS and protection analysis, including Vite HMR and error recovery.

## Ignore comments and execution constraints

```ts
// This call remains at its original location.
const value = /* mincho-js-ignore */ defineStyle(rule);
```

The existing `mincho-js-ignore` comment takes precedence over extraction for
both built-in and registered calls. Comments inside protected implementations
are also preserved. Ignoring a call does not make file-scope-only APIs safe to
execute outside a CSS evaluation context.

Registration requests build-time execution. Arguments and their dependencies
must be available at build time, and return values must satisfy the existing
vanilla-extract serialization rules. Recipes can return their serialized runtime
functions; arbitrary closures cannot. Evaluation or serialization failures are
reported without falling back to runtime execution.

Registration does **not** declare a function read-only. Existing mutation checks
for shared JSX CSS values still apply. This API does not accept AST callbacks,
wildcards or computed export selection.

## CommonJS sources

The same registrations work with `require()`, including object destructuring, aliases,
namespace members and direct calls. Mincho and the supported official
vanilla-extract packages need no additional registration.
Array destructuring consumes iterator elements and does not identify registered
module exports, so those calls remain in place.

```js
const { style: makeStyle } = require("@vanilla-extract/css");
const factory = require("./style-factory.cjs");

exports.native = makeStyle({ color: "red" });
exports.custom = factory.defineStyle({ color: "blue" });
```

Register `"./style-factory.cjs": ["defineStyle"]` using the existing root-relative
path rules. Local implementation protection follows `exports.name`,
`module.exports.name`, object replacements, forwarding requires and verified
getter/compiler re-exports. Unreassigned `var` and `let` bindings are supported.

Use `"default"` for a directly exported function (`module.exports = fn`) or an
explicit `exports.default` function. Direct `factory()` and `factory.default()`
remain distinct calls; if both functions exist, both implementations are protected.

Babel callers can select `sourceType: "unambiguous"` (or `"script"`) to retain
CommonJS sidecar references. The bundler adapters detect CommonJS automatically.
`.cjs` and `.cts` are supported, including TypeScript `import = require` and
`export =` declarations. Import and require conditions are resolved separately.

Vite converts supported project CommonJS modules to ESM for builds, the browser
and SSR, including helpers that do not generate CSS. The default export of a
normalized CommonJS module is its `module.exports` value; an explicit `.default`
property remains part of that value. Registered implementation and re-export
changes participate in HMR and recovery after an invalid export is corrected.
Stylesheet dependencies loaded with `require()` remain in the bundler graph.
Mincho leaves CSS, CSS Modules and preprocessor files (including query variants)
to the consuming bundler instead of parsing them as JavaScript. Their handling
still depends on the bundler configuration.

External runtime CommonJS packages use Node loading in SSR. Packages owned by an
SSR build, including `ssr.noExternal` dependencies, are bundled with that output.
Local sources outside the project root stay in Vite's module graph for HMR.
Browser development uses Vite dependency optimization. Keep automatic dependency
discovery enabled, or explicitly include the require-condition entry in
`optimizeDeps.include` when discovery is disabled.

Supported compiler shapes include verified TypeScript `__createBinding` and
`__exportStar`, static Babel/SWC getters, and esbuild `__export`/`__toCommonJS`.
Verified Babel/TypeScript default-interop and esbuild namespace-interop helpers also work.
Helper names alone are not trusted. Arbitrary helpers, dynamic requires,
bundle bootstraps and cyclic CommonJS re-export initialization are unsupported.
Vite normalization also rejects conditional or lazy runtime requires and requires
that would move ahead of observable initialization, since ESM imports execute
dependencies eagerly. Explicit ESM named exports are preserved in mixed modules;
combining an ESM default export with CommonJS exports is unsupported because they
need different default values. ESM modules without CommonJS exports retain
guarded, dynamic or otherwise unsafe-to-hoist requires for the consumer runtime
to handle. Safe eager requires still normalize to imports. Babel and esbuild
retain their native CommonJS loading behavior.

Leading literal require declarations, static member reads and simple object
destructuring follow ESM import loading semantics. Their imported properties must
not use getters with observable side effects. Defaults, computed destructuring
keys and array iterators before a later require are rejected. Use native Babel or
esbuild loading when dependency initialization relies on precise CommonJS getter
or execution ordering.

Static export analysis refuses unknown export keys, detached `exports` aliases
and mutated export values instead of reusing an earlier value. Exporting an
unrelated name does not invalidate a known export.

Calls tied to a registered API through a reassigned binding, mutated/escaped
namespace or dynamic member produce a diagnostic instead of silently remaining
at runtime. `mincho-js-ignore` skips extraction and this call-level diagnostic;
it does not validate an invalid registration or make unsupported CommonJS
module structure executable in a browser. Registration still does not imply
that a custom function is read-only.

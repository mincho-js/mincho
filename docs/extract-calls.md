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

Keep registered receivers and their wrapper objects immutable. Receiver analysis
uses known own data properties; it does not reconstruct an object's earlier state
from assignments. Getters, iterators, implicit conversions and imported live values
can affect evaluation order even when the expression has no explicit function call.
An unresolved effect is not evidence that a call can safely move into a sidecar.
Build-time-only APIs still need a supported extraction path before they can run.

CSS modules have two surfaces: the source used to build styles and the generated
exports used by the application. Vite and the paired esbuild plugins analyze the
host's generated exports when checking consumers of classes, theme variables and
runtime recipes. Registered factory implementations are still analyzed from their
source. Changes to either surface and its dependencies invalidate the analysis;
an unavailable runtime module is not treated as a safe source module.

## Extraction safety contract

`extractCalls` is not a general JavaScript evaluator or a declaration that a
registered function is pure. The supported syntax above does not imply support
for every combination of JavaScript effects. Extraction requires evidence that
the selected operation and its dependencies can move into the sidecar.

That evidence must preserve invocation count, conditional execution, relative
ordering, observable reads and conversions, receiver identity, and suspension
boundaries. Consumer analysis also depends on the host's actual runtime source
and its execution dependencies. Missing evidence is not evidence of safety.

An unknown safety result means a required property could not be established; an
unsafe reference identifies a conflicting effect or invalid reference. Neither
permits extraction. An unknown intermediate value is different: its exact value
or allocation origin need not be known when a complete build-time group owns
all of its uses. These are safety distinctions, not a promise that every
unsupported call currently produces the same diagnostic.

Ordinary values and supported runtime operations can remain at their original
location. A build-time-only API still requires a supported extraction path;
leaving its call in place does not make it safe to execute in the application.
Registration alone does not distinguish such an API from a runtime-capable
helper. `mincho-js-ignore` deliberately preserves the call but does not establish
runtime compatibility.

Compiler-generated calls explicitly selected as complete build-time owners
must not survive a failed extraction proof: compilation reports a diagnostic
instead. This guarantee applies to the compiler's marked owner, not to every
registered custom function or its ordinary runtime operands. Unmarked custom
APIs still need a supported extraction path; registration does not classify them
as build-time-only. Explicit ignore comments retain their existing behavior.

CSS-authoring destructuring follows the same build intent as its producer.
When all selected consumers belong to a published build group, the producer and
its property reads run once in that group, not again on every component render.
The original declaration is removed only after exact-node capture, publication,
and absence of remaining runtime consumers have been verified. Unrelated
initializers in a multi-declaration remain in their original runtime order;
required dependencies remain available to the build group. Ignored or incomplete
groups fail closed instead of leaving a build copy and a second runtime producer.
This is phase ownership, not a claim that getters or factory results are pure.

### Standard intrinsics and the observation boundary

Some compiler operations rely on the existing standard-intrinsics assumption:
JavaScript built-ins have their standard behavior unless the compiler observes
relevant mutation or escape. This assumption supports narrowly defined operations,
not arbitrary-code isolation. For example, a primitive-result contract for a
Math call does not establish determinism, harmless argument coercion, or permission
to move the call. Pattern selection also needs separate evidence for native array
iteration and for the absence of inherited properties.

For namespace-effect observation, the standard realm includes the default
presence of `globalThis` and native `Object.keys` / `Array.prototype.forEach`.
A bounded proof may omit an inline callback when `Object.keys` receives an exact
empty own-data object with no intervening mutation, alias, or escape. It still
observes argument evaluation and other uses. A local global-object reference
used only in those unexecuted callbacks may use the corresponding proven
`typeof globalThis !== "undefined"` branch; this does not approve a `Function`
constructor or evaluate an arbitrary fallback body. Observed shadowing, mutation,
deletion, escape, or dynamic scope withdraws the relevant assumption, including
changes discovered in another observed module. These proofs affect namespace
observation only, not source values, call purity, or permission to move effects.

Relevant mutation or escape in observed source withdraws the affected contract.
Observation must include the host's applicable source and transformed runtime
views, not just an authoring file whose generated module can behave differently.
A known dependency that cannot be observed, or discovery that reaches a limit,
cannot be treated as an unchanged intrinsic environment. Retaining the standard
intrinsics assumption does not turn an unreadable dependency into an empty module.

An observed graph is not a proof of the complete future runtime closure. Deferred
opaque loading can remain unresolved even when the compiler has inspected the
available host views. That distinction must not be used as evidence that the
loader, its eventual module, or a callback is pure. In particular, a function body
is not necessarily deferred: an immediately invoked function, an initialization
call chain, or an opaque callback consumer can execute it while loading a module.
The compiler may conservatively decline cases where it cannot distinguish these
boundaries. Registration is not a way to override the distinction.

Internal evidence has different scopes:

- **Value or result evidence** describes a value, its origin, or a call's result
  on normal completion. It does not establish absence of effects.
- **Intrinsic-effect observation** concerns particular built-ins and the host
  views actually inspected. A host-native CSS effect record does not grant
  JavaScript exports, executable values, or extraction rights. A CSS transform
  that emits JavaScript requires observation of that JavaScript and its imports.
- **Execution-dependency evidence** concerns which executable dependencies were
  discovered. A separate intrinsic observation does not complete an unresolved
  execution graph.
- **Phase ownership** establishes the exact operations and aliases that belong to
  one build-time group. It does not make their results fresh, their callbacks
  pure, or the same operations safe to duplicate at application runtime.

The host observation boundary matters for plugin ordering. A source hash or
version identifies the view supplied to analysis, not every transformation that
might run later. JavaScript introduced by a subsequent plugin, an automatically
injected runtime import, or a different client/SSR transform is not covered merely
because an earlier view was inspected. Such changes require observation of the
applicable output and dependency invalidation; an earlier snapshot must not be
presented as proof about unseen output. This contract is not a guarantee that all
host/plugin combinations or later transformations are currently supported, nor a
whole-program sandbox guarantee. It introduces no new application syntax or
requirement to wrap ordinary application code in `mincho$`.

### Registered execution groups

Registration selects calls for build-time execution; it does not promise that
those calls are pure or that their results are independent allocations. A chain
such as `const value = factory(); consume(value)` can preserve that intent when
both calls are registered and the compiler proves that every use and alias of
`value` stays in the same ordered build-time group. Calls still execute once,
with their original argument evaluation and shared identities. This is not
permission to duplicate `factory()` for each consumer.

A runtime observer, a deferred or unselected conditional call, or a suspension
boundary cannot be silently absorbed into that group. The original intermediate
object must not remain at runtime alongside a separate build-time copy. Values
published out of the group still pass the existing serializer; an arbitrary
closure does not become serializable because its producer was registered.

A terminal build result can cross into the application only through publication.
The compiler records an obligation for the exact producing call and checks that
it was exported into the sidecar and replaced by its runtime reference. An
unfinished publication fails compilation; it is not a reason to keep the
original call at runtime while trusting an artifact proof. Downstream
serialization can still reject the result. This phase boundary does not prove
that invoking the resulting runtime function is pure or returns a fresh value.

This contract preserves the existing build-execution intent of registered
calls. It does not make an unregistered opaque producer safe, nor does it prove
that a provider has no hidden state shared with unrelated runtime code.

### Compiler-owned evidence, unchanged application syntax

The compiler keeps application syntax separate from its internal execution
boundaries. A source-visible authoring wrapper can forward to a verified
Vanilla Extract endpoint without requiring an explicit `mincho$` wrapper in
application code. Its argument construction, captures, initialization effects,
and replay order are checked independently.

Serialized recipe artifacts supply a separate runtime contract. The compiler
checks the resolved runtime endpoint and the serialized payload shape rather
than trusting recipe metadata alone. A verified recipe call returning a class
string does not make its argument evaluation effect-free: getters, coercions,
and exceptions must retain their original behavior.

Host rewrites do not change these obligations. For example, a rewritten import
URL or a validated CommonJS default namespace can identify the same endpoint,
but an arbitrary object with matching export names cannot grant that authority.

## CommonJS sources

The same registrations work with `require()`, including object destructuring, aliases,
namespace members and direct calls. Mincho and the supported official
vanilla-extract packages need no additional registration.
Array destructuring consumes iterator elements and does not identify registered
module exports, so those calls remain in place.

Namespace safety failures in registered CommonJS calls are reported as errors.
This includes descriptor-changing operations such as deleting a copied receiver
property: a later write could invoke an inherited setter. Use `mincho-js-ignore`
when the call is intended to remain at runtime.

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

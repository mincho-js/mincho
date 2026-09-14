# Compiler and adapter structure

The compiler and bundler adapters keep the existing extraction and CSS-loading
contracts while separating their implementation by responsibility. Public plugin
names, configuration and package entry points stay the same.

| Area                                                  | Responsibility                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `babel/src/index.ts`                                  | Register plugin visitors and export compiler entry points.           |
| `babel/src/jsxCssProp/preprocess.ts`                  | Coordinate JSX attribute analysis and emission.                      |
| `babel/src/jsxCssProp/cssPropEvaluation.ts`           | Evaluate CSS shape, policy and lowering decisions.                   |
| `babel/src/jsxCssProp/dynamicCssVariableAnalysis.ts`  | Analyze dynamic declaration and branch shapes.                       |
| `babel/src/jsxCssProp/dynamicCssVariableCodegen.ts`   | Generate classes, variables and runtime expressions after analysis.  |
| `babel/src/jsxCssProp/expressionShape.ts`             | Share expression-shape predicates between analysis and emission.     |
| `integration/src/staticCssEvalPrepassSource.ts`       | Read, resolve and classify prepass sources.                          |
| `integration/src/staticCssEvalPrepassDependencies.ts` | Collect dependency traversal inputs.                                 |
| `esbuild/src/plugin.ts`                               | Implement the esbuild plugin independently of the build entry point. |
| `esbuild/src/staticCssEvalSourceProvider.ts`          | Adapt esbuild resolution and loading to static evaluation.           |
| `vite/src/staticCssEvalSourceProvider.ts`             | Adapt Vite resolution and loading to static evaluation.              |
| `vite/src/cssState.ts`                                | Own generated sources, virtual CSS authorization and invalidation.   |

Shared internal helpers resolve modules from the caller's module, infer esbuild
loaders using the longest matching extension, and normalize static-evaluation
origins and dependency metadata. The adapters use those helpers while retaining
their own build and development lifecycle hooks.

JSX processing validates attributes and analyzes CSS before generating dynamic
variable expressions. Each transform keeps its own analysis state. Vite's CSS
state retains the relationship between an owner, its extracted sources and its
authorized virtual stylesheets so invalidation clears the same resources.

Compiler tests and snapshots live beside the responsibility they cover:
`index.test.ts`, `jsxCssProp.test.ts`, `jsxCssPropDynamic.test.ts`,
`jsxCssPropSpreads.test.ts` and `defineRulesCxConditions.test.ts`. Existing
transformation expectations move with those tests. Resolver, loader, metadata
and CSS-state tests cover the shared boundaries directly.

Validation includes the Babel, integration, esbuild and Vite suites, source type
checks, lint and Yarn Doctor. Release builds and isolated npm/strict Yarn PnP
consumers cover ESM/CJS exports, CSS sidecars, graph workers and browser styles.
Contextual blank-line cleanup is kept in a separate commit for review.

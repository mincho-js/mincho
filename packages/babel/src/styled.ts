import { types as t, PluginObj } from "@babel/core";
import type { PluginState, ProgramScope } from "@/types.js";
import { registerImportMethod } from "@/utils.js";

/**
 * Babel plugin that transforms `styled` calls from "@mincho-js/react" into runtime calls with tree-shaking annotations.
 *
 * Replaces calls to `styled` with calls to runtime-imported `$$styled` and `rules`, preserving comments and source locations for accurate source maps. Ensures transformed calls are annotated for tree-shaking and updates scope references after transformation.
 *
 * @returns A Babel plugin object for transforming styled component calls.
 */
export function styledComponentPlugin(): PluginObj<PluginState> {
  return {
    name: "mincho-js-babel:styled",
    visitor: {
      Program: {
        enter(path) {
          (path.scope as ProgramScope).minchoData ??= {
            imports: new Map(),
            bindings: [],
            nodes: [],
            cssFile: ""
          };

          path.traverse({
            CallExpression(callPath) {
              const callee = callPath.get("callee");

              const isReactAdapter = callee.referencesImport(
                "@mincho-js/react",
                "styled"
              );

              if (!isReactAdapter) {
                return;
              }

              const runtimeImport = "@mincho-js/react/runtime";

              const args = callPath.node.arguments;

              // Validate arguments
              if (args.length < 2) {
                return;
              }

              const [tag, styles, ...restArgs] = args;

              const styledIdentifier = registerImportMethod(
                callPath,
                "$$styled",
                runtimeImport
              );

              const recipeIdentifier = registerImportMethod(
                callPath,
                "rules",
                "@mincho-js/css"
              );

              // Create the recipe call expression
              const recipeCallExpression = t.callExpression(recipeIdentifier, [
                t.cloneNode(styles)
              ]);

              // Preserve existing comments if any
              if (callPath.node.leadingComments?.length) {
                t.addComments(
                  recipeCallExpression,
                  "leading",
                  callPath.node.leadingComments
                );
              }

              // Preserve source locations for better source maps
              recipeCallExpression.loc = styles.loc;

              const callExpression = t.callExpression(styledIdentifier, [
                t.cloneNode(tag),
                recipeCallExpression,
                ...restArgs
              ]);

              // Add @__PURE__ annotation for tree-shaking
              t.addComments(callExpression, "leading", [
                { type: "CommentBlock", value: " @__PURE__ " }
              ]);

              // Preserve source locations
              callExpression.loc = callPath.node.loc;

              callPath.replaceWith(callExpression);

              // recompute the references later used in `referencesImport` to check if the import is used
              path.scope.crawl();
            }
          });
        }
      }
    }
  };
}

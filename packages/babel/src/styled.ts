import { types as t, PluginObj } from "@babel/core";
import type { PluginState, ProgramScope } from "@/types.js";
import { registerImportMethod } from "@/utils.js";

/**
 * The plugin for transforming styled components
 *
 * This plugin transforms calls to `styled` from "@mincho-js/react" into runtime
 * calls with proper tree-shaking annotations.
 *
 * @returns The plugin object
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
                "recipe",
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

import { types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { PluginState, ProgramScope } from "./types.js";
import { registerImportMethod } from "./utils.js";

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
              const normalizedArguments = normalizeStyledCall(callPath);

              if (!normalizedArguments) {
                return;
              }

              const { tag, styles, rest } = normalizedArguments;

              const runtimeImport = "@mincho-js/react/runtime";

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
                ...rest.map((argument) => t.cloneNode(argument))
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

function normalizeStyledCall(callPath: NodePath<t.CallExpression>): {
  tag: t.Expression;
  styles: t.Expression;
  rest: Array<t.Expression | t.SpreadElement>;
} | null {
  const callee = callPath.get("callee");
  const args = callPath.node.arguments;

  const toValidRestArguments = (
    input: typeof args
  ): Array<t.Expression | t.SpreadElement> =>
    input.filter(
      (arg): arg is t.Expression | t.SpreadElement =>
        t.isExpression(arg) || t.isSpreadElement(arg)
    );

  if (callee.isIdentifier()) {
    if (!callee.referencesImport("@mincho-js/react", "styled")) {
      return null;
    }

    const [tag, styles, ...restArgs] = args;

    if (!tag || !styles || !t.isExpression(tag) || !t.isExpression(styles)) {
      return null;
    }

    return {
      tag,
      styles,
      rest: toValidRestArguments(restArgs)
    };
  }

  if (!callee.isMemberExpression()) {
    return null;
  }

  const object = callee.get("object");

  if (
    !object.isIdentifier() ||
    !object.referencesImport("@mincho-js/react", "styled")
  ) {
    return null;
  }

  const [styles, ...restArgs] = args;

  if (!styles || !t.isExpression(styles)) {
    return null;
  }

  const property = callee.get("property");

  let memberTag: t.Expression | null = null;

  if (callee.node.computed) {
    if (t.isExpression(property.node)) {
      memberTag = property.node;
    }
  } else if (property.isIdentifier()) {
    memberTag = t.stringLiteral(property.node.name);
  } else if (property.isStringLiteral()) {
    memberTag = t.stringLiteral(property.node.value);
  }

  if (!memberTag) {
    return null;
  }

  return {
    tag: memberTag,
    styles,
    rest: toValidRestArguments(restArgs)
  };
}

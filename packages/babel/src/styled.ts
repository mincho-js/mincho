import { types as t } from "@babel/core";
import type { NodePath, PluginObj } from "@babel/core";
import type { PluginState, ProgramScope } from "./types.js";
import { registerImportMethod } from "./utils.js";

const runtimeImport = "@mincho-js/react/runtime";

type NormalizedStyledCall = {
  tag: t.Expression;
  styles: t.Expression;
  rest: Array<t.Expression | t.SpreadElement>;
};

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

              const callExpression = createStyledRuntimeCall(
                normalizedArguments,
                styledIdentifier,
                recipeIdentifier,
                callPath.node
              );

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

function createStyledRuntimeCall(
  normalizedCall: NormalizedStyledCall,
  styledIdentifier: t.Expression,
  recipeIdentifier: t.Expression,
  originalCall: t.CallExpression
): t.CallExpression {
  const { tag, styles, rest } = normalizedCall;
  const recipeCallExpression = createRecipeCallExpression(
    styles,
    recipeIdentifier,
    originalCall
  );
  const callExpression = t.callExpression(styledIdentifier, [
    t.cloneNode(tag),
    recipeCallExpression,
    ...cloneStyledRestArguments(rest)
  ]);

  t.addComments(callExpression, "leading", [
    { type: "CommentBlock", value: " @__PURE__ " }
  ]);

  callExpression.loc = originalCall.loc;

  return callExpression;
}

function createRecipeCallExpression(
  styles: t.Expression,
  recipeIdentifier: t.Expression,
  originalCall: t.CallExpression
): t.CallExpression {
  const recipeCallExpression = t.callExpression(recipeIdentifier, [
    t.cloneNode(styles)
  ]);

  if (originalCall.leadingComments?.length) {
    t.addComments(
      recipeCallExpression,
      "leading",
      originalCall.leadingComments
    );
  }

  recipeCallExpression.loc = styles.loc;

  return recipeCallExpression;
}

function cloneStyledRestArguments(
  rest: NormalizedStyledCall["rest"]
): NormalizedStyledCall["rest"] {
  return rest.map((argument) => t.cloneNode(argument));
}

function normalizeStyledCall(
  callPath: NodePath<t.CallExpression>
): NormalizedStyledCall | null {
  const callee = callPath.get("callee");
  const args = callPath.node.arguments;

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

function toValidRestArguments(
  input: t.CallExpression["arguments"]
): Array<t.Expression | t.SpreadElement> {
  return input.filter(
    (arg): arg is t.Expression | t.SpreadElement =>
      t.isExpression(arg) || t.isSpreadElement(arg)
  );
}

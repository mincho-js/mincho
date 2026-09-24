import { types as t } from "@babel/core";
import { SourceAstCache } from "./staticCssEval/moduleParser.js";

export interface SourceAnalysis {
  readonly sources: readonly string[];
  readonly commonJs: boolean;
  readonly calls: boolean;
  readonly componentJsx: boolean;
  readonly cssJsx: boolean;
}

/** No scopes or mutable AST nodes escape this environment-independent summary. */
export function analyzeSource(
  filename: string,
  source: string,
  cache?: SourceAstCache
): SourceAnalysis {
  const jsx = !/\.[cm]?ts$/.test(filename);

  return (cache ?? new SourceAstCache(undefined, 0, 0)).analyzeSyntax(
    {
      resolvedFile: filename,
      source,
      parserOptions: {
        plugins: jsx ? ["jsx", "typescript"] : ["typescript"],
        sourceType: "unambiguous",
        jsx,
        typescript: true
      }
    },
    "source-candidates:v1",
    (ast) => {
      const sources = new Set<string>();
      let commonJs = false;
      let calls = false;
      let componentJsx = false;
      let cssJsx = false;
      t.traverseFast(ast, (node) => {
        if (
          t.isImportDeclaration(node) ||
          t.isExportNamedDeclaration(node) ||
          t.isExportAllDeclaration(node)
        ) {
          if (node.source) sources.add(node.source.value);
        }

        if (
          t.isTSImportEqualsDeclaration(node) ||
          t.isTSExportAssignment(node) ||
          (t.isIdentifier(node) &&
            ["require", "module", "exports"].includes(node.name))
        )
          commonJs = true;
        if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
          calls = true;

        if (t.isJSXOpeningElement(node)) {
          if (!t.isJSXIdentifier(node.name) || !/^[a-z]/.test(node.name.name))
            componentJsx = true;
          if (
            node.attributes.some(
              (attribute) =>
                t.isJSXSpreadAttribute(attribute) ||
                (t.isJSXAttribute(attribute) &&
                  t.isJSXIdentifier(attribute.name, { name: "css" }))
            )
          )
            cssJsx = true;
        }
      });

      return Object.freeze({
        sources: Object.freeze([...sources]),
        commonJs,
        calls,
        componentJsx,
        cssJsx
      });
    }
  );
}

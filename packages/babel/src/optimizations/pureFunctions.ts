import { types as t, type NodePath } from "@babel/core";
import { referencesModuleExport } from "../commonjs/bindings.js";
import { isBuiltInExtractionCall } from "../extractionCalls/builtins.js";
import {
  createModuleGraph,
  parseModuleProgram,
  type ModuleGraphFlow
} from "../moduleGraph.js";
import type { SourceAstCache } from "../staticCssEval/moduleParser.js";
import {
  createStaticExpressionBudget,
  evaluateStaticExpression
} from "./staticExpression.js";

export interface PreparedPureFunctions {
  readonly replacements: ReadonlyArray<{
    key: string;
    expression: t.Expression;
  }>;
  readonly dependencies: readonly string[];
  readonly diagnostics: ReadonlyArray<{
    key: string;
    result: "folded" | "deopt";
  }>;
}

export function expressionKey(path: NodePath<t.Node>): string {
  return `${locationKey(path.node)}\0${path.toString()}`;
}

function locationKey(node: t.Node): string {
  return [
    node.loc?.start.line,
    node.loc?.start.column,
    node.loc?.end.line,
    node.loc?.end.column
  ].join(":");
}

export function* analyzePureFunctions(options: {
  filename: string;
  source: string;
  jsxCssProp?: boolean;
  program?: NodePath<t.Program>;
  parserCache?: SourceAstCache;
}): ModuleGraphFlow<PreparedPureFunctions> {
  const graph = createModuleGraph({
    isExternal: (id) => /(?:^|\/)(?:node_modules|\.yarn)\//.test(id),

    parse: (id, source, jsx) =>
      parseModuleProgram(id, source, jsx, options.parserCache)
  });

  const owner = {
    id: options.filename,
    program:
      options.program ??
      parseModuleProgram(
        options.filename,
        options.source,
        true,
        options.parserCache
      )
  };

  graph.modules.set(owner.id, owner);

  const candidates = new Set<NodePath<t.Node>>();
  const jsxCandidates = new Set<NodePath<t.Node>>();
  owner.program.traverse({
    CallExpression(path) {
      const callee = path.get("callee");
      const styled =
        referencesModuleExport(callee, "@mincho-js/react", "styled") ||
        (callee.isMemberExpression() &&
          referencesModuleExport(
            callee.get("object"),
            "@mincho-js/react",
            "styled"
          ));

      if (isBuiltInExtractionCall(callee) || styled)
        for (const argument of path.get("arguments"))
          if (argument.isExpression()) candidates.add(argument);
    },

    JSXAttribute(path) {
      if (
        !options.jsxCssProp ||
        !path.get("name").isJSXIdentifier({ name: "css" })
      )
        return;

      const value = path.get("value");

      if (value.isJSXExpressionContainer()) {
        candidates.add(value.get("expression"));
        jsxCandidates.add(value.get("expression"));
      }
    }
  });

  const replacements: Array<{ key: string; expression: t.Expression }> = [];
  const diagnostics: Array<{ key: string; result: "folded" | "deopt" }> = [];

  for (const path of candidates) {
    const key = expressionKey(path);
    const budget = createStaticExpressionBudget();

    try {
      const expression = yield* evaluateStaticExpression(
        graph,
        owner,
        path,
        budget
      );

      const styleResult =
        t.isObjectExpression(expression) ||
        (t.isArrayExpression(expression) &&
          expression.elements.some((item) => t.isObjectExpression(item)));

      if (budget.calls && (!jsxCandidates.has(path) || styleResult)) {
        replacements.push({ key, expression });
        diagnostics.push({ key, result: "folded" });
      }
    } catch {
      // This optional pass never changes the existing extraction/error policy.
      diagnostics.push({ key, result: "deopt" });
    }
  }

  return { replacements, diagnostics, dependencies: [...graph.dependencies] };
}

export function applyPureFunctions(
  program: NodePath<t.Program>,
  prepared: PreparedPureFunctions
): void {
  if (!prepared.replacements.length) return;

  preserveModuleEffects(program, () => {
    const replacements = new Map(
      prepared.replacements.map((item) => [item.key, item.expression])
    );

    const locations = new Set(
      [...replacements.keys()].map((key) => key.split("\0")[0])
    );

    program.traverse({
      Expression(path) {
        if (!path.node.loc || !locations.has(locationKey(path.node))) return;

        const replacement = replacements.get(expressionKey(path));
        if (!replacement) return;

        path.replaceWith(t.cloneNode(replacement, true));
        path.skip();
      }
    });
  });
}

export function preserveModuleEffects(
  program: NodePath<t.Program>,
  transform: () => void
): void {
  const usedImports = program
    .get("body")
    .filter(
      (path) =>
        path.isImportDeclaration() &&
        path.node.importKind !== "type" &&
        path.node.specifiers.some(
          (specifier) =>
            program.scope.getBinding(specifier.local.name)?.referenced
        )
    );

  transform();
  program.scope.crawl();

  // TypeScript import elision must not erase the original module's effects.
  for (const path of usedImports) {
    if (
      path.isImportDeclaration() &&
      path.node.specifiers.every(
        (specifier) =>
          !program.scope.getBinding(specifier.local.name)?.referenced
      )
    )
      path.node.specifiers = [];
  }
}

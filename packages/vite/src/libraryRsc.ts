import type { Rollup } from "vite";
import { createRscExportGraph } from "./libraryRscExports.js";

type Statements = NonNullable<Rollup.ModuleInfo["ast"]>["body"];

function* directives(body: Statements) {
  for (const node of body) {
    if (
      node.type !== "ExpressionStatement" ||
      node.expression.type !== "Literal" ||
      typeof node.expression.value !== "string"
    )
      break;

    yield node.expression.value;
  }
}

function hasFunctionServerAction(ast: Rollup.ModuleInfo["ast"]) {
  const pending: unknown[] = [ast];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    const node = value as {
      type?: string;
      body?: { type: string; body: Statements };
    };
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression"
      ].includes(node.type ?? "") &&
      node.body?.type === "BlockStatement" &&
      [...directives(node.body.body)].includes("use server")
    )
      return true;
    pending.push(...Object.values(value));
  }
  return false;
}

/** Preserve explicit boundaries; never promote a mixed chunk to client code. */
export function createLibraryRscBoundaries() {
  const clients = new Set<string>();
  const servers = new Set<string>();
  const exports = createRscExportGraph();

  return {
    record(info: Rollup.ModuleInfo) {
      clients.delete(info.id);
      servers.delete(info.id);

      for (const directive of directives(info.ast?.body ?? [])) {
        if (directive === "use client") clients.add(info.id);
        if (directive === "use server") servers.add(info.id);
      }
      if (hasFunctionServerAction(info.ast)) servers.add(info.id);
      exports.record(info);
    },

    async clientDirective(
      chunk: Rollup.RenderedChunk,
      context: Pick<Rollup.PluginContext, "resolve">,
      chunks: Record<string, Rollup.RenderedChunk>
    ): Promise<boolean> {
      const live = Object.entries(chunk.modules)
        .filter(
          ([, module]) =>
            module.renderedLength > 0 || module.renderedExports.length > 0
        )
        .map(([id]) => id);
      live.push(...(await exports.retainedModules(chunk, context, chunks)));
      if (
        (chunk.facadeModuleId && servers.has(chunk.facadeModuleId)) ||
        live.some((id) => servers.has(id))
      )
        throw new Error(
          "libraryRsc does not compile 'use server' actions. Use your framework's server-action build pipeline."
        );
      if (chunk.facadeModuleId && clients.has(chunk.facadeModuleId))
        return true;

      const mixed = live.find((id) => clients.has(id));
      if (mixed)
        throw new Error(
          `libraryRsc cannot preserve the client boundary ${mixed} inside ${chunk.fileName}. Make the client module a separate library entry or use preserveModules.`
        );

      return false;
    }
  };
}

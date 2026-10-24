import type { Rollup } from "vite";

type ExportTarget = { source?: string; imported?: string };

/** Track retained re-exports, including modules omitted from chunk.modules. */
export function createRscExportGraph() {
  const modules = new Map<
    string,
    { named: Map<string, ExportTarget>; stars: string[] }
  >();

  return {
    record(info: Rollup.ModuleInfo) {
      const imports = new Map<string, ExportTarget>();
      const named = new Map<string, ExportTarget>(
        (info.exportedBindings?.["."] ?? []).map((name) => [name, {}])
      );
      const stars: string[] = [];
      modules.set(info.id, { named, stars });

      for (const node of info.ast?.body ?? []) {
        if (node.type !== "ImportDeclaration") continue;
        for (const specifier of node.specifiers)
          imports.set(specifier.local.name, {
            source: String(node.source.value),
            imported:
              specifier.type === "ImportSpecifier"
                ? specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : String(specifier.imported.value)
                : specifier.type === "ImportDefaultSpecifier"
                  ? "default"
                  : "*"
          });
      }

      for (const node of info.ast?.body ?? []) {
        if (node.type === "ExportNamedDeclaration") {
          for (const specifier of node.specifiers) {
            const name =
              specifier.exported.type === "Identifier"
                ? specifier.exported.name
                : String(specifier.exported.value);
            const local =
              specifier.local.type === "Identifier"
                ? specifier.local.name
                : String(specifier.local.value);
            named.set(
              name,
              node.source
                ? { source: String(node.source.value), imported: local }
                : (imports.get(local) ?? { imported: local })
            );
          }
        } else if (node.type === "ExportAllDeclaration") {
          if (node.exported) {
            const name =
              node.exported.type === "Identifier"
                ? node.exported.name
                : String(node.exported.value);
            named.set(name, {
              source: String(node.source.value),
              imported: "*"
            });
          } else stars.push(String(node.source.value));
        } else if (
          node.type === "ExportDefaultDeclaration" &&
          node.declaration.type === "Identifier" &&
          imports.has(node.declaration.name)
        )
          named.set("default", imports.get(node.declaration.name)!);
      }
    },

    async retainedModules(
      chunk: Rollup.RenderedChunk,
      context: Pick<Rollup.PluginContext, "resolve">,
      chunks: Record<string, Rollup.RenderedChunk>
    ) {
      const importedFacades = new Set(
        Object.values(chunks)
          .filter((other) => chunk.imports.includes(other.fileName))
          .map((other) => other.facadeModuleId)
      );
      const resolutions = new Map<string, ReturnType<typeof context.resolve>>();

      function resolve(id: string, source: string) {
        const key = JSON.stringify([id, source]);
        let resolution = resolutions.get(key);
        if (!resolution) {
          resolution = context.resolve(source, id);
          resolutions.set(key, resolution);
        }
        return resolution;
      }

      async function exportNames(id: string, seen = new Set<string>()) {
        const module = modules.get(id);
        const names = new Set<string>();
        if (!module || seen.has(id)) return names;
        const nextSeen = new Set(seen).add(id);
        for (const name of module.named.keys()) names.add(name);
        for (const source of module.stars) {
          const resolved = await resolve(id, source);
          if (!resolved || resolved.external) continue;
          for (const name of await exportNames(resolved.id, nextSeen))
            if (name !== "default") names.add(name);
        }
        return names;
      }

      type Resolution = { binding: string; ids: Set<string> };

      // Undefined is a missing/cyclic export; false is an ambiguous star export.
      async function trace(
        id: string,
        name: string,
        seen = new Set<string>()
      ): Promise<Resolution | false | undefined> {
        const key = JSON.stringify([id, name]);
        if (id !== chunk.facadeModuleId && importedFacades.has(id))
          return { binding: key, ids: new Set() };
        if (seen.has(key)) return undefined;
        const nextSeen = new Set(seen).add(key);
        const module = modules.get(id);
        if (!module) return { binding: key, ids: new Set() };

        if (name === "*") {
          const ids = new Set([id]);
          // Star exports omit default and ambiguous bindings. Explicit exports
          // shadow star exports through the named branch below.
          for (const exported of await exportNames(id)) {
            const reached = await trace(id, exported, nextSeen);
            if (reached) for (const moduleId of reached.ids) ids.add(moduleId);
          }
          return { binding: key, ids };
        }

        const targets = module.named.has(name)
          ? [module.named.get(name)!]
          : name === "default"
            ? []
            : module.stars.map((source) => ({ source, imported: name }));
        let result: Resolution | undefined;
        for (const target of targets) {
          let reached: Resolution | false | undefined;
          if (!target.source)
            reached = {
              binding: JSON.stringify([id, target.imported ?? name]),
              ids: new Set()
            };
          else {
            const resolved = await resolve(id, target.source);
            reached =
              resolved && !resolved.external
                ? await trace(resolved.id, target.imported!, nextSeen)
                : {
                    binding: JSON.stringify([
                      resolved?.id ?? target.source,
                      target.imported
                    ]),
                    ids: new Set()
                  };
          }
          if (reached === false) return false;
          if (!reached) continue;
          if (result && result.binding !== reached.binding) return false;
          if (!result) result = { binding: reached.binding, ids: new Set() };
          for (const moduleId of reached.ids) result.ids.add(moduleId);
        }
        result?.ids.add(id);
        return result;
      }

      const retained = new Set<string>();
      const roots = new Map(
        Object.entries(chunk.modules).map(([id, module]) => [
          id,
          module.renderedExports
        ])
      );
      if (chunk.facadeModuleId) roots.set(chunk.facadeModuleId, chunk.exports);
      for (const [id, names] of roots) {
        for (const name of names) {
          const reached = await trace(id, name);
          if (reached)
            for (const moduleId of reached.ids) retained.add(moduleId);
        }
      }
      return retained;
    }
  };
}

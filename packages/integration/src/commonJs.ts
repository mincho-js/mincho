import {
  transformAsync,
  types as t,
  type PluginObj,
  type TransformOptions
} from "@babel/core";
import {
  internalInspectCommonJs,
  internalCommonJsToEsmPlugin,
  internalResolveExtractCallsFile
} from "@mincho-js/babel";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import type { StaticCssEvalSourceProvider } from "./babel.js";

type Description = ReturnType<typeof internalInspectCommonJs>;

interface Module {
  id: string;
  commonJsRuntimeId?: string;
  opaqueExternal?: boolean;
  description: Description;
  source: string;
}

/** Infer the sidecar import format using the caller's already configured parser. */
export function inferCommonJsSourceType(): PluginObj {
  return {
    name: "mincho-infer-source-type",
    visitor: {
      Program(program) {
        let commonjs = program.node.body.some(
          (statement) =>
            t.isTSImportEqualsDeclaration(statement) ||
            t.isTSExportAssignment(statement)
        );

        let esm = program.node.body.some(
          (statement) =>
            t.isImportDeclaration(statement) || t.isExportDeclaration(statement)
        );

        program.traverse({
          ReferencedIdentifier(path) {
            if (
              ["require", "module", "exports"].includes(path.node.name) &&
              !path.scope.getBinding(path.node.name)
            )
              commonjs = true;
          },

          MetaProperty(path) {
            if (path.node.meta.name === "import") esm = true;
          }
        });
        program.node.sourceType = commonjs && !esm ? "script" : "module";
      }
    }
  };
}

/** Prepare require-condition imports before the synchronous Babel ESM pass. */
export async function transformCommonJsToEsm(options: {
  filename: string;
  source: string;
  provider?: StaticCssEvalSourceProvider;
  dependencies: Set<string>;
  sidecar: string;
  sourceMaps: boolean;
  inputSourceMap?: TransformOptions["inputSourceMap"];
  parserPlugins?: NonNullable<TransformOptions["parserOpts"]>["plugins"];
}) {
  // Escaped identifiers still take the parser path. Ordinary ESM has no CJS
  // bindings to inspect, and already passed through the configured Babel parser.
  if (!/\b(?:require|module|exports)\b|\\/.test(options.source)) return null;

  const owner = {
    id: options.filename,
    source: options.source,
    description: internalInspectCommonJs(
      options.source,
      options.filename,
      // The owner already passed through Babel's TypeScript preset and may
      // retain JSX enabled by a loader or syntax plugin, regardless of suffix.
      [...(options.parserPlugins ?? []), "jsx"]
    )
  };
  if (!owner.description.commonjs) return null;

  const modules = new Map<string, Module>([[owner.id, owner]]);
  const resolutions = new Map<string, Module | null>();

  async function resolveModule(
    importer: string,
    source: string,
    kind: "import" | "require" = "require"
  ): Promise<Module | null> {
    const key = `${importer}\0${source}\0${kind}`;
    if (resolutions.has(key)) return resolutions.get(key)!;

    // Generated sidecars are registered by the adapter after this transform.
    if (source === options.sidecar || source === `./${options.sidecar}`) {
      resolutions.set(key, null);

      return null;
    }

    const resolved = await options.provider?.resolve(importer, source, {
      kind
    });

    for (const file of resolved?.watchFiles ?? [])
      options.dependencies.add(file);

    const id =
      resolved?.id ??
      resolved?.resolvedFile ??
      resolved?.canonicalModuleId ??
      internalResolveExtractCallsFile(importer, source);

    const externalId =
      resolved?.canonicalModuleId ??
      resolved?.id ??
      resolved?.resolvedFile ??
      source;

    if (
      !id ||
      resolved?.sourceKind === "external-no-source" ||
      isBuiltin(externalId)
    ) {
      const commonJsRuntimeId =
        resolved?.commonJsRuntimeId ??
        (isBuiltin(externalId) ? externalId : undefined);

      if (commonJsRuntimeId) {
        const external = {
          id: id ?? externalId,
          commonJsRuntimeId,
          opaqueExternal: true,
          source: "",
          description: internalInspectCommonJs(
            "module.exports = {};",
            options.filename
          )
        };

        resolutions.set(key, external);

        return external;
      }

      if (resolved?.sourceKind === "external-no-source") {
        const external = {
          id: externalId,
          opaqueExternal: true,
          source: "",
          description: internalInspectCommonJs("export {};", options.filename)
        };

        resolutions.set(key, external);

        return external;
      }

      resolutions.set(key, null);

      return null;
    }

    options.dependencies.add(
      resolved?.realpath ?? resolved?.resolvedFile ?? id
    );

    const cached = modules.get(id);

    if (cached) {
      resolutions.set(key, cached);

      return cached;
    }

    // CSS sidecars are handled by the consuming bundler, including CSS Modules
    // and query variants. Preserve require-condition resolution without trying
    // to parse the stylesheet as JavaScript or probing it for CJS exports.
    if (
      /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)(?:[?#]|$)/.test(id)
    ) {
      const stylesheet = {
        id,
        source: "",
        description: internalInspectCommonJs("export {};", `${id}.js`)
      };

      modules.set(id, stylesheet);
      resolutions.set(key, stylesheet);

      return stylesheet;
    }

    if (modules.size >= 512)
      throw new Error("CommonJS module graph exceeds 512 modules");

    const loaded = options.provider
      ? await options.provider.load(resolved?.normalizedPathKey ?? id)
      : null;

    for (const file of loaded?.watchFiles ?? []) options.dependencies.add(file);

    let sourceText = loaded?.sourceText ?? loaded?.source;

    if (sourceText === undefined && !options.provider)
      sourceText = await readFile(id, "utf8");

    if (sourceText === undefined) {
      resolutions.set(key, null);

      return null;
    }

    const module = {
      id,
      commonJsRuntimeId: resolved?.commonJsRuntimeId,
      source: sourceText,
      description: internalInspectCommonJs(
        sourceText,
        id,
        options.parserPlugins
      )
    };

    modules.set(id, module);
    resolutions.set(key, module);

    return module;
  }

  const exportNames = new Map<string, string[]>();

  async function names(
    module: Module,
    seen = new Set<string>()
  ): Promise<string[]> {
    if (module.opaqueExternal)
      throw new Error(`Cannot identify CommonJS re-exports from ${module.id}`);

    if (seen.has(module.id))
      throw new Error(`Unsupported cyclic CommonJS re-export: ${module.id}`);

    const cached = exportNames.get(module.id);
    if (cached) return cached;

    const found = new Set(module.description.exports);
    const next = new Set(seen).add(module.id);

    for (const [source, kind] of [
      ...module.description.stars.map((source) => [source, "require"] as const),
      ...module.description.esmStars.map(
        (source) => [source, "import"] as const
      )
    ]) {
      const dependency = await resolveModule(module.id, source, kind);
      if (!dependency)
        throw new Error(
          `Cannot identify CommonJS re-exports from ${source} in ${module.id}`
        );

      for (const name of await names(dependency, next)) {
        if (name === "default" || name === "__esModule" || found.has(name))
          continue;

        found.add(name);

        if (kind === "require")
          module.description.reexports.push({ name, source, imported: name });
      }
    }

    const result = [...found].sort();
    exportNames.set(module.id, result);

    return result;
  }

  const imports: Record<string, { id: string; commonjs: boolean }> =
    Object.create(null);

  for (const source of owner.description.requires) {
    const dependency = await resolveModule(owner.id, source);
    imports[source] = {
      id:
        (dependency?.description.exportsObject &&
          dependency.commonJsRuntimeId) ||
        dependency?.id ||
        source,
      commonjs: dependency
        ? dependency.description.exportsObject || /\.json$/.test(dependency.id)
        : false
    };
  }

  const transformed = await transformAsync(options.source, {
    filename: options.filename,
    babelrc: false,
    configFile: false,
    sourceType: "unambiguous",
    parserOpts: { plugins: [...(options.parserPlugins ?? []), "jsx"] },
    plugins: [
      internalCommonJsToEsmPlugin({
        description: owner.description,
        imports,
        exportNames: await names(owner)
      })
    ],
    sourceMaps: options.sourceMaps,
    ...(options.inputSourceMap
      ? { inputSourceMap: options.inputSourceMap }
      : {})
  });
  if (!transformed?.code)
    throw new Error(`Cannot normalize CommonJS module ${options.filename}`);

  return transformed;
}

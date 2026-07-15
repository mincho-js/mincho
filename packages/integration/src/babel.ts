import { type TransformOptions, transformFileAsync } from "@babel/core";
import {
  internalCollectJsxCssPropStaticCssEvalCandidates as collectJsxCssPropStaticCssEvalCandidates,
  internalCreateImportedStaticCssEvalModuleRecord as createImportedStaticCssEvalModuleRecord,
  internalCreateImportedStaticCssEvalProvider as createImportedStaticCssEvalProvider,
  type InternalImportedStaticCssEvalImportResolution as ImportedStaticCssEvalImportResolution,
  type InternalImportedStaticCssEvalLoadedModule as ImportedStaticCssEvalLoadedModule,
  type InternalImportedStaticCssEvalModuleRecord as ImportedStaticCssEvalModuleRecord,
  type PluginOptions,
  minchoBabelPlugin,
  minchoStyledComponentPlugin
} from "@mincho-js/babel";

type MaybePromise<T> = T | Promise<T>;

export interface StaticCssEvalSourceResolution {
  id: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

export interface StaticCssEvalLoadedSource {
  source: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
}

/** @internal Async owner/dependency source provider for bundler prepasses. */
export interface StaticCssEvalSourceProvider {
  resolve(
    importerId: string,
    importPath: string
  ): MaybePromise<StaticCssEvalSourceResolution | null>;
  load(id: string): MaybePromise<StaticCssEvalLoadedSource | null>;
}

export interface StaticCssEvalPrepassResult {
  dependencyFiles: string[];
  ownerToDependencies: ReadonlyMap<string, string[]>;
  dependencyToOwners: ReadonlyMap<string, string[]>;
  resolvedModuleCache: ReadonlyMap<string, ImportedStaticCssEvalModuleRecord>;
}

interface PreparedStaticCssEvalPrepass {
  provider: NonNullable<PluginOptions["staticCssEvalProvider"]>;
  result: StaticCssEvalPrepassResult;
}

export type BabelOptions = Omit<
  TransformOptions,
  | "ast"
  | "filename"
  | "root"
  | "sourceFileName"
  | "sourceMaps"
  | "inputSourceMap"
> & {
  jsxCssProp?: boolean;
  staticCssEvalProvider?: PluginOptions["staticCssEvalProvider"];
  /** @internal Async source provider used to prepare imported css eval data. */
  staticCssEvalSourceProvider?: StaticCssEvalSourceProvider;
};

export type BabelTransformResult = {
  code: string;
  readonly jsxCssPropTransformed?: boolean;
  result: [string, string];
  readonly staticCssEval?: StaticCssEvalPrepassResult;
};

export async function babelTransform(
  path: string,
  babel: BabelOptions = {}
): Promise<BabelTransformResult> {
  const {
    jsxCssProp = false,
    staticCssEvalProvider,
    staticCssEvalSourceProvider,
    ...babelCoreOptions
  } = babel;
  const staticCssEvalPrepass =
    jsxCssProp === true && staticCssEvalSourceProvider
      ? await createStaticCssEvalPrepass(path, staticCssEvalSourceProvider)
      : undefined;
  const preparedStaticCssEvalProvider =
    staticCssEvalProvider ?? staticCssEvalPrepass?.provider;
  const options: PluginOptions & {
    jsxCssProp?: boolean;
  } = {
    result: ["", ""],
    jsxCssProp,
    staticCssEvalProvider: preparedStaticCssEvalProvider
  };
  const result = await transformFileAsync(path, {
    ...babelCoreOptions,
    plugins: [
      ...(Array.isArray(babelCoreOptions.plugins)
        ? babelCoreOptions.plugins
        : []),
      minchoStyledComponentPlugin(),
      [minchoBabelPlugin(), options]
    ],
    presets: [
      ...(Array.isArray(babelCoreOptions.presets)
        ? babelCoreOptions.presets
        : []),
      "@babel/preset-typescript"
    ],
    sourceMaps: false
  });

  if (result === null || result.code == null) {
    throw new Error(`Failed to transform ${path}`);
  }

  return {
    result: options.result,
    code: result.code,
    jsxCssPropTransformed: options.jsxCssPropTransformed === true,
    ...(staticCssEvalPrepass
      ? { staticCssEval: staticCssEvalPrepass.result }
      : {})
  };
}

async function createStaticCssEvalPrepass(
  ownerId: string,
  sourceProvider: StaticCssEvalSourceProvider
): Promise<PreparedStaticCssEvalPrepass> {
  const ownerSource = await sourceProvider.load(ownerId);

  if (!ownerSource) {
    throw new Error(`Failed to load static css eval owner source ${ownerId}`);
  }

  const ownerModule = createLoadedModule(ownerId, ownerSource);
  const ownerRecord = createImportedStaticCssEvalModuleRecord(ownerModule);
  const candidates = collectJsxCssPropStaticCssEvalCandidates(
    ownerRecord.programPath,
    { importerId: ownerId }
  );
  const loadedModules: ImportedStaticCssEvalLoadedModule[] = [ownerModule];
  const importResolutions: ImportedStaticCssEvalImportResolution[] = [];
  const resolvedModuleCache = new Map<
    string,
    ImportedStaticCssEvalModuleRecord
  >([[ownerRecord.id, ownerRecord]]);
  const ownerDependencies: string[] = [];
  const dependencyToOwners = new Map<string, string[]>();
  const resolvedImports = new Map<
    string,
    StaticCssEvalSourceResolution | null
  >();
  const loadedDependencyIds = new Set<string>([ownerId]);

  for (const candidate of candidates) {
    const importBinding = candidate.bindingName
      ? ownerRecord.imports.get(candidate.bindingName)
      : undefined;

    if (!importBinding || importBinding.kind === "namespace") {
      continue;
    }

    const importPath = importBinding.importPath;
    let resolution = resolvedImports.get(importPath);

    if (!resolvedImports.has(importPath)) {
      resolution = await sourceProvider.resolve(ownerId, importPath);
      resolvedImports.set(importPath, resolution ?? null);

      if (resolution) {
        importResolutions.push({
          importerId: ownerId,
          importPath,
          resolvedId: resolution.id
        });
      }
    }

    if (!resolution) {
      continue;
    }

    addOwnerDependency(
      ownerDependencies,
      dependencyToOwners,
      ownerId,
      resolution.id
    );

    if (loadedDependencyIds.has(resolution.id)) {
      continue;
    }

    loadedDependencyIds.add(resolution.id);
    const loadedSource = await sourceProvider.load(resolution.id);

    if (!loadedSource) {
      continue;
    }

    const loadedModule = createLoadedModule(
      resolution.id,
      loadedSource,
      resolution
    );

    try {
      const moduleRecord =
        createImportedStaticCssEvalModuleRecord(loadedModule);
      resolvedModuleCache.set(moduleRecord.id, moduleRecord);
      loadedModules.push(loadedModule);
    } catch {
      continue;
    }
  }

  const ownerToDependencies = new Map<string, string[]>([
    [ownerId, ownerDependencies]
  ]);
  const provider = createImportedStaticCssEvalProvider({
    modules: loadedModules,
    importResolutions,
    moduleRecords: [...resolvedModuleCache.values()]
  });

  return {
    provider,
    result: {
      dependencyFiles: [...ownerDependencies],
      ownerToDependencies,
      dependencyToOwners,
      resolvedModuleCache
    }
  };
}

function createLoadedModule(
  id: string,
  loadedSource: StaticCssEvalLoadedSource,
  resolution?: StaticCssEvalSourceResolution
): ImportedStaticCssEvalLoadedModule {
  return {
    id,
    source: loadedSource.source,
    realpath: loadedSource.realpath ?? resolution?.realpath,
    sourceHash: loadedSource.sourceHash ?? resolution?.sourceHash,
    version: loadedSource.version ?? resolution?.version
  };
}

function addOwnerDependency(
  ownerDependencies: string[],
  dependencyToOwners: Map<string, string[]>,
  ownerId: string,
  dependencyId: string
): void {
  if (!ownerDependencies.includes(dependencyId)) {
    ownerDependencies.push(dependencyId);
  }

  const owners = dependencyToOwners.get(dependencyId);

  if (!owners) {
    dependencyToOwners.set(dependencyId, [ownerId]);
    return;
  }

  if (!owners.includes(ownerId)) {
    owners.push(ownerId);
  }
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, expect, it } = import.meta.vitest;

  let fixtureIndex = 0;
  const fixtureRoots: string[] = [];

  async function createBabelFixture(source: string, label: string) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;
    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `mincho-babel-css-prop-${fixtureIndex}-${label}`
    );
    const fixturePath = path.join(fixtureRoot, `${label}.tsx`);

    fixtureRoots.push(fixtureRoot);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(fixturePath, source, "utf8");

    return fixturePath;
  }

  afterEach(async () => {
    const fs = await import("node:fs/promises");

    await Promise.all(
      fixtureRoots
        .splice(0)
        .map((fixtureRoot) =>
          fs.rm(fixtureRoot, { recursive: true, force: true })
        )
    );
  });

  function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  type StaticCssEvalProvider = NonNullable<
    PluginOptions["staticCssEvalProvider"]
  >;
  type StaticCssEvalProviderResult = ReturnType<
    StaticCssEvalProvider["getResolvedCssValue"]
  >;
  type StaticCssEvalValue = Extract<
    StaticCssEvalProviderResult,
    { kind: "resolved" }
  >["value"];

  function createResolvedStaticCssEvalProvider(
    values: Record<string, StaticCssEvalValue>
  ): StaticCssEvalProvider {
    return {
      getResolvedCssValue(query): StaticCssEvalProviderResult {
        const key = query.memberPath?.length
          ? `${query.bindingName}.${query.memberPath.join(".")}`
          : (query.bindingName ?? "");
        const value = values[key];

        if (value === undefined) {
          return { kind: "not-candidate" };
        }

        return {
          kind: "resolved",
          value,
          dependencies: ["/provider/styles.ts"]
        };
      }
    };
  }

  function createUnsupportedReexportStaticCssEvalProvider(): StaticCssEvalProvider {
    return {
      getResolvedCssValue(query): StaticCssEvalProviderResult {
        return {
          kind: "error",
          diagnostic: {
            code: "unsupported-source",
            message:
              'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax',
            reason: "reexport-or-barrel",
            owner: {
              file: query.importerId,
              start: query.expressionStart,
              end: query.expressionEnd
            },
            dependency: { file: "/provider/barrel.ts" },
            importPath: "./barrel",
            exportName: "button",
            memberPath: query.memberPath ?? [],
            importChain: [query.importerId, "/provider/barrel.ts#button"]
          },
          dependencies: ["/provider/barrel.ts"]
        };
      }
    };
  }

  interface FakeStaticCssEvalSourceProviderCalls {
    resolved: Array<{ importerId: string; importPath: string }>;
    loaded: string[];
  }

  function createFakeStaticCssEvalSourceProvider(options: {
    sources: Record<string, string>;
    resolutions: Record<string, string>;
  }): {
    provider: StaticCssEvalSourceProvider;
    calls: FakeStaticCssEvalSourceProviderCalls;
  } {
    const calls: FakeStaticCssEvalSourceProviderCalls = {
      resolved: [],
      loaded: []
    };

    return {
      calls,
      provider: {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });
          const resolvedId =
            options.resolutions[`${importerId}\0${importPath}`];

          return resolvedId ? { id: resolvedId } : null;
        },
        load(id) {
          calls.loaded.push(id);

          if (!Object.prototype.hasOwnProperty.call(options.sources, id)) {
            return null;
          }

          return { source: options.sources[id] ?? "" };
        }
      }
    };
  }

  describe("babelTransform", () => {
    it("extracts css prop generated css calls into sidecar output", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div className="base" css={{ color: "red" }} />;
          }
        `,
        "css-prop-sidecar"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarSource).toContain("@mincho-js/css");
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
      );
      expect(exportedDeclarations).toHaveLength(1);
      expect(sidecarSource).not.toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*cx\(/s
      );
      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);
      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);
      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
          code
        );
      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const classNameMergeMatch =
        /className=\{([A-Za-z_$][\w$]*)\("base", ([A-Za-z_$][\w$]*)\)\}/.exec(
          code
        );

      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(classNameMergeMatch).not.toBeNull();
      expect(classNameMergeMatch?.[1]).toBe(cxIdentifier);
      expect(sidecarRuntimeNames).toContain(classNameMergeMatch?.[2]);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={{");
      expect(code).not.toContain('color: "red"');
    });

    it("preserves direct object and class-value css props without a static source provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { css } from "@mincho-js/css";

          const styleA = css({ color: "blue" });
          const condition = true;

          function App() {
            return <>
              <div className="base" css={{ color: "red" }} />
              <div css={styleA} />
              <div css={condition ? "active" : "inactive"} />
            </>;
          }
        `,
        "css-prop-provider-absence"
      );
      const transformed = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const { result, code } = transformed;
      const [, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(transformed.staticCssEval).toBeUndefined();
      expect(exportedDeclarations).toHaveLength(2);
      expect(sidecarSource).toContain('color: "blue"');
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain(" css=");
      expect(code).toContain('className={_cx("base",');
      expect(code).toContain("className={_cx(styleA)}");
      expect(code).toContain(
        'className={_cx(condition ? "active" : "inactive")}'
      );
    });

    it("keeps class-value css props on the cx path without double wrapping", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { css } from "@mincho-js/css";

          const styleA = css({ color: "blue" });
          const condition = true;
          const flag = false;
          const providedClass = "provided";
          const maybeClass = null;

          function getClassName() {
            return "call-class";
          }

          function App() {
            return <>
              <div className="base" css={{ color: "red" }} />
              <div css={styleA} />
              <div css="literal-class" />
              <div css={condition ? "active" : "inactive"} />
              <div css={flag && "active"} />
              <div css={providedClass || "fallback"} />
              <div css={maybeClass ?? "fallback"} />
              <div css={getClassName()} />
            </>;
          }
        `,
        "css-prop-v2-classification"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];
      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
          code
        );
      const cxIdentifier = cxImportMatch?.[1] ?? "cx";

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(exportedDeclarations).toHaveLength(2);
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "blue"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "red"\s*\}\);/s
      );
      expect(sidecarSource).not.toMatch(/\bcss\(styleA\)/);
      expect(sidecarSource).not.toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*cx\(/s
      );
      expect(cxImportMatch).not.toBeNull();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={styleA}");
      expect(code).not.toContain("css(styleA)");
      expect(code).not.toContain("_css(styleA)");
      expect(code).toMatch(
        new RegExp(`className=\\{${escapeRegExp(cxIdentifier)}\\(styleA\\)\\}`)
      );
      expect(code).toContain('className="literal-class"');
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'condition ? "active" : "inactive"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'flag && "active"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'providedClass || "fallback"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            'maybeClass ?? "fallback"'
          )}\\)\\}`
        )
      );
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(${escapeRegExp(
            "getClassName()"
          )}\\)\\}`
        )
      );
    });

    it("resolves imported named, aliased, default, and nested static css props through a provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button as buttonStyle, aliasStyle, styles } from "./styles";
          import defaultObject from "./default-object";
          import defaultConst from "./default-const";

          function App() {
            return <>
              <div css={buttonStyle} />
              <div css={aliasStyle} />
              <div css={defaultObject} />
              <div css={defaultConst} />
              <div css={styles.button.primary} />
            </>;
          }
        `,
        "css-prop-imported-static-values"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalProvider: createResolvedStaticCssEvalProvider({
          buttonStyle: { color: "red" },
          aliasStyle: { color: "blue" },
          defaultObject: { color: "green" },
          defaultConst: { color: "orange" },
          "styles.button.primary": { color: "purple" }
        })
      });
      const [, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(exportedDeclarations).toHaveLength(5);
      expect(sidecarSource).toContain('color: "red"');
      expect(sidecarSource).toContain('color: "blue"');
      expect(sidecarSource).toContain('color: "green"');
      expect(sidecarSource).toContain('color: "orange"');
      expect(sidecarSource).toContain('color: "purple"');
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(buttonStyle)");
      expect(code).not.toContain("_cx(aliasStyle)");
      expect(code).not.toContain("_cx(defaultObject)");
      expect(code).not.toContain("_cx(defaultConst)");
      expect(code).not.toContain("_cx(styles.button.primary)");
    });

    it("runs async prepass only for css-prop-reachable imports", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./styles";
        import { unused } from "./unused";

        const value = unused;

        function App() {
          return <>
            <div css={button} />
            <span>{value}</span>
          </>;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-reachable-import"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const unusedId = path.join(fixtureRoot, "unused.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: `export const button = { color: "red" } as const;`,
          [unusedId]: `export const unused = { color: "blue" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId,
          [`${fixturePath}\0./unused`]: unusedId
        }
      });
      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );
      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, stylesId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(sidecarSource).not.toContain('color: "blue"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(unusedId)).toBe(false);
    });

    it("reports dependency maps for unsupported reexport fallback from async prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-reexport-fallback"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export { button } from "./styles";`,
          [stylesId]: `export const button = { color: "red" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./styles`]: stylesId
        }
      });
      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      expect(result[1]).toBe("");
      expect(code).toContain("className={_cx(button)}");
      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId]);
      expect(staticCssEval?.dependencyFiles).toEqual([barrelId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(barrelId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(false);
    });

    it("excludes failed dependency parses from async prepass caches", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-parse-failure"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: `export const button = ;`
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId
        }
      });
      const prepass = await createStaticCssEvalPrepass(fixturePath, provider);
      const resolution = prepass.provider.getResolvedCssValue({
        importerId: fixturePath,
        expressionStart: 0,
        expressionEnd: "button".length,
        bindingName: "button"
      });

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, stylesId]);
      expect(prepass.result.dependencyFiles).toEqual([stylesId]);
      expect(prepass.result.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(prepass.result.resolvedModuleCache.has(stylesId)).toBe(false);
      expect(resolution.kind).toBe("error");

      if (resolution.kind !== "error") {
        throw new Error("Expected failed dependency resolution");
      }

      expect(resolution.dependencies).toEqual([stylesId]);
      expect(resolution.diagnostic.code).toBe(
        "failed-project-local-dependency"
      );
      expect(resolution.diagnostic.message).toContain(
        `failed to load project-local dependency ${stylesId}`
      );
    });

    it("preserves whole-expression reexport fallback but rejects reexports inside static css rules", async () => {
      const wholeExpressionPath = await createBabelFixture(
        `
          import { button } from "./barrel";

          function App() {
            return <div css={button} />;
          }
        `,
        "css-prop-reexport-whole-expression"
      );
      const provider = createUnsupportedReexportStaticCssEvalProvider();
      const { result, code } = await babelTransform(wholeExpressionPath, {
        jsxCssProp: true,
        staticCssEvalProvider: provider
      });

      expect(result[1]).toBe("");
      expect(code).not.toContain(" css=");
      expect(code).toContain("className={_cx(button)}");

      const staticRulePath = await createBabelFixture(
        `
          import { button } from "./barrel";

          function App() {
            return <div css={{ color: button }} />;
          }
        `,
        "css-prop-reexport-static-rule"
      );

      await expect(
        babelTransform(staticRulePath, {
          jsxCssProp: true,
          staticCssEvalProvider: provider
        })
      ).rejects.toThrow(
        'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
      );
    });

    it("lowers representative logical css rule branches", async () => {
      const fixturePath = await createBabelFixture(
        `
          const providedClass = "provided";
          const maybeClass = null;
          const andClass = "and-class";

          function App() {
            return <>
              <div css={providedClass || { color: "red" }} />
              <div css={maybeClass ?? [{ color: "green" }]} />
              <div css={{ color: "blue" } || unreachableClass} />
              <div css={{ color: "yellow" } && andClass} />
              <div css={{ color: "purple" } && { color: "orange" }} />
            </>;
          }
        `,
        "css-prop-logical-rule-branches"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];
      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);
      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);
      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
          code
        );
      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const rightOrClassNameMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(providedClass \\|\\| ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);
      const rightNullishClassNameMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(maybeClass \\?\\? ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);
      const generatedOnlyClassNameMatches = [
        ...code.matchAll(/className=\{([A-Za-z_$][\w$]*)\}/g)
      ];
      const orangeCssMatches = [...sidecarSource.matchAll(/color: "orange"/g)];

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(exportedDeclarations).toHaveLength(4);
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "red"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\[\{\s*color: "green"\s*\}\]\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "blue"\s*\}\);/s
      );
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*\(\{\s*color: "orange"\s*\}\);/s
      );
      expect(orangeCssMatches).toHaveLength(1);
      expect(code).not.toContain(" css=");
      expect(rightOrClassNameMatch).not.toBeNull();
      expect(rightNullishClassNameMatch).not.toBeNull();
      expect(sidecarRuntimeNames).toContain(rightOrClassNameMatch?.[1]);
      expect(sidecarRuntimeNames).toContain(rightNullishClassNameMatch?.[1]);
      expect(
        generatedOnlyClassNameMatches.some(([, className]) =>
          sidecarRuntimeNames.includes(className)
        )
      ).toBe(true);
      expect(
        generatedOnlyClassNameMatches.filter(([, className]) =>
          sidecarRuntimeNames.includes(className)
        )
      ).toHaveLength(2);
      expect(code).toMatch(
        new RegExp(
          `className=\\{${escapeRegExp(cxIdentifier)}\\(andClass\\)\\}`
        )
      );
      expect(`${code}\n${sidecarSource}`).not.toContain("unreachableClass");
      expect(`${code}\n${sidecarSource}`).not.toContain('color: "yellow"');
      expect(`${code}\n${sidecarSource}`).not.toContain('color: "purple"');
    });

    it("leaves jsx css prop lowering disabled by default", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div className="base" css={{ color: "red" }} />;
          }
        `,
        "css-prop-disabled-default"
      );
      const { result, code } = await babelTransform(fixturePath);

      expect(result[1]).toBe("");
      expect(code).toContain('className="base"');
      expect(code).toContain("css={{");
      expect(code).toContain('color: "red"');
      expect(code).not.toContain("extracted_");
    });
  });
}

import { type TransformOptions, transformFileAsync } from "@babel/core";
import {
  type InternalImportedStaticCssEvalModuleRecord as ImportedStaticCssEvalModuleRecord,
  type MinchoStaticCssEvalMetadata,
  type PluginOptions,
  minchoBabelPlugin,
  minchoStyledComponentPlugin
} from "@mincho-js/babel";
import {
  createEmptyStaticCssEvalMetadata,
  createObservingStaticCssEvalProvider,
  createStaticCssEvalTransformResult,
  getStaticCssEvalMetadata,
  mergeStaticCssEvalMetadata
} from "./staticCssEvalMetadata.js";
import { createStaticCssEvalPrepass } from "./staticCssEvalPrepass.js";

type MaybePromise<T> = T | Promise<T>;

type StaticCssEvalMetadataDependency =
  MinchoStaticCssEvalMetadata["dependencies"][number];
type StaticCssEvalMetadataDiagnostic =
  MinchoStaticCssEvalMetadata["diagnostics"][number];
type StaticCssEvalMetadataCacheKey =
  MinchoStaticCssEvalMetadata["cacheKeys"][number];
export type StaticCssEvalResolverKind =
  | "source-provider"
  | "filesystem"
  | "vite"
  | "esbuild"
  | "test"
  | (string & {});

export interface StaticCssEvalSourceIdentity {
  sourceHash?: string;
  version?: string | number;
}

// Integration supplies bundler-aware identity/source freshness; Babel static
// eval remains the only owner of css value and symbol provenance.
export interface StaticCssEvalSourceResolution {
  /**
   * Legacy alias. When newer fields are absent, this is treated as the
   * resolved file, canonical module id, and normalized load key.
   */
  id?: string;
  /** File path used by Babel/static eval diagnostics, dependency files, and cache keys. */
  resolvedFile?: string;
  /** Bundler graph id that should be preserved for callers, even when it differs from the file path. */
  canonicalModuleId?: string;
  /** Stable provider load/cache key; integration passes this value back to `load()`. */
  normalizedPathKey?: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
  /** Source identity from the bundler; loaded source identity takes precedence. */
  sourceIdentity?: StaticCssEvalSourceIdentity;
  /** Identifies which resolver produced this source for downstream cache/debug consumers. */
  resolverKind?: StaticCssEvalResolverKind;
}

export interface StaticCssEvalLoadedSource {
  /** Preferred loaded module text. */
  sourceText?: string;
  /** Legacy alias for `sourceText`. */
  source?: string;
  resolvedFile?: string;
  canonicalModuleId?: string;
  normalizedPathKey?: string;
  realpath?: string;
  sourceHash?: string;
  version?: string | number;
  sourceIdentity?: StaticCssEvalSourceIdentity;
  resolverKind?: StaticCssEvalResolverKind;
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
  resolvedDependencies: StaticCssEvalResolvedDependency[];
}

export interface StaticCssEvalResolvedDependency {
  importerId: string;
  specifier: string;
  resolvedFile: string;
  canonicalModuleId: string;
  normalizedPathKey: string;
  resolverKind: StaticCssEvalResolverKind;
  loaded: boolean;
  sourceIdentity?: StaticCssEvalSourceIdentity;
}

export interface StaticCssEvalTransformResult
  extends StaticCssEvalPrepassResult, MinchoStaticCssEvalMetadata {}

export class BabelTransformError extends Error {
  readonly file: string;
  readonly staticCssEval?: StaticCssEvalTransformResult;
  override cause: unknown;

  constructor(
    file: string,
    cause: unknown,
    staticCssEval?: StaticCssEvalTransformResult
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BabelTransformError";
    this.file = file;
    this.cause = cause;
    this.staticCssEval = staticCssEval;
  }
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
  readonly staticCssEval?: StaticCssEvalTransformResult;
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
  const observedStaticCssEvalMetadata = createEmptyStaticCssEvalMetadata();
  const preparedStaticCssEvalProvider =
    staticCssEvalProvider ?? staticCssEvalPrepass?.provider;
  const observedStaticCssEvalProvider = preparedStaticCssEvalProvider
    ? createObservingStaticCssEvalProvider(
        preparedStaticCssEvalProvider,
        observedStaticCssEvalMetadata
      )
    : undefined;
  const options: PluginOptions & {
    jsxCssProp?: boolean;
  } = {
    result: ["", ""],
    jsxCssProp,
    staticCssEvalProvider: observedStaticCssEvalProvider
  };
  let result;

  try {
    result = await transformFileAsync(path, {
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
  } catch (error) {
    const staticCssEval = createStaticCssEvalTransformResult(
      staticCssEvalPrepass?.result,
      observedStaticCssEvalMetadata
    );

    if (staticCssEval) {
      throw new BabelTransformError(path, error, staticCssEval);
    }

    throw error;
  }

  if (result === null || result.code == null) {
    throw new Error(`Failed to transform ${path}`);
  }

  const staticCssEvalMetadata = mergeStaticCssEvalMetadata(
    getStaticCssEvalMetadata(result.metadata),
    observedStaticCssEvalMetadata
  );
  const staticCssEval = createStaticCssEvalTransformResult(
    staticCssEvalPrepass?.result,
    staticCssEvalMetadata
  );

  return {
    result: options.result,
    code: result.code,
    jsxCssPropTransformed: options.jsxCssPropTransformed === true,
    ...(staticCssEval ? { staticCssEval } : {})
  };
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

  async function createBabelFixtureFiles<
    FixtureFiles extends Record<string, string>
  >(files: FixtureFiles, label: string) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;
    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `mincho-babel-css-prop-${fixtureIndex}-${label}`
    );
    const filePaths = {} as Record<keyof FixtureFiles, string>;

    fixtureRoots.push(fixtureRoot);

    for (const fileName of Object.keys(files) as Array<keyof FixtureFiles>) {
      const fixturePath = path.join(fixtureRoot, String(fileName));
      filePaths[fileName] = fixturePath;
      await fs.mkdir(path.dirname(fixturePath), { recursive: true });
      await fs.writeFile(fixturePath, files[fileName], "utf8");
    }

    return { fixtureRoot, filePaths };
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

  function createTestSourceIdentity(
    sourceText: string
  ): StaticCssEvalSourceIdentity {
    const colorTag = sourceText.includes('color: "blue"')
      ? "blue"
      : sourceText.includes('color: "red"')
        ? "red"
        : "source";

    return { sourceHash: `test:${sourceText.length}:${colorTag}` };
  }

  function createFileBackedStaticCssEvalSourceProvider(options: {
    resolutions: Record<string, string>;
    resolverKind?: StaticCssEvalResolverKind;
  }): StaticCssEvalSourceProvider {
    return {
      resolve(importerId, importPath) {
        const resolvedFile =
          options.resolutions[`${importerId}\0${importPath}`];

        if (!resolvedFile) {
          return null;
        }

        return {
          resolvedFile,
          canonicalModuleId: `test:${resolvedFile}`,
          normalizedPathKey: resolvedFile,
          resolverKind: options.resolverKind ?? "test"
        };
      },
      async load(id) {
        const fs = await import("node:fs/promises");

        try {
          const sourceText = await fs.readFile(id, "utf8");

          return {
            sourceText,
            sourceIdentity: createTestSourceIdentity(sourceText),
            resolverKind: options.resolverKind ?? "test"
          };
        } catch {
          return null;
        }
      }
    };
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

    it("static css eval metadata dedupes dependency diagnostics and resolved module ids", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button } from "./styles";

          function App() {
            return <div css={button} />;
          }
        `,
        "css-prop-metadata-dedupe"
      );
      const dependency = {
        file: "/provider/styles.ts",
        kind: "imported",
        importer: fixturePath,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: true
      } satisfies StaticCssEvalMetadataDependency;
      const diagnostic = {
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        code: "unsupported-source",
        message: "test static css eval metadata diagnostic",
        reason: "reexport-or-barrel",
        owner: { file: fixturePath, start: 0, end: 1 },
        dependency: { file: dependency.file },
        importPath: "./styles",
        exportName: "button",
        memberPath: [],
        importChain: [fixturePath, dependency.file]
      } satisfies StaticCssEvalMetadataDiagnostic;
      const cacheKey = {
        importerFile: fixturePath,
        resolvedFile: dependency.file,
        resolvedId: dependency.file,
        exportName: "button",
        memberPath: [],
        sourceHash: "test:metadata-dedupe",
        pluginOptionsVersion: "test-plugin-options",
        resolverOptionsVersion: "test-resolver-options",
        staticEvalSupportVersion: "test-static-eval"
      } satisfies StaticCssEvalMetadataCacheKey;
      const provider: StaticCssEvalProvider = {
        getResolvedCssValue(): StaticCssEvalProviderResult {
          return {
            kind: "resolved",
            value: { color: "red" },
            dependencies: [dependency, { ...dependency }],
            diagnostics: [diagnostic, { ...diagnostic }],
            cacheKey
          } as unknown as StaticCssEvalProviderResult;
        }
      };

      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: provider
        }
      );
      const [, sidecarSource] = result;

      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(button)");
      expect(
        staticCssEval?.dependencies.filter(
          (item) => item.file === dependency.file && item.kind === "imported"
        )
      ).toHaveLength(1);
      expect(
        staticCssEval?.diagnostics.filter((item) => item.id === diagnostic.id)
      ).toHaveLength(1);
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([expect.objectContaining(cacheKey)])
      );
      expect(
        staticCssEval?.resolvedModuleIds.filter(
          (moduleId) => moduleId === dependency.file
        )
      ).toHaveLength(1);
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

    it("static css eval metadata preserves dependency files resolved dependencies cache keys and source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const redStylesSource = `export const button = { color: "red" } as const;`;
      const blueStylesSource = `export const button = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": redStylesSource
        },
        "css-prop-imported-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(stylesId, blueStylesSource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId
      ]);
      expect(firstTransform.staticCssEval?.cacheKeys[0]?.sourceHash).toBe(
        createTestSourceIdentity(redStylesSource).sourceHash
      );
      expect(secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash).toBe(
        createTestSourceIdentity(blueStylesSource).sourceHash
      );
      expect(firstTransform.staticCssEval?.cacheKeys[0]?.sourceHash).not.toBe(
        secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash
      );
      expect(secondTransform.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(blueStylesSource)
        })
      ]);
      expect(secondTransform.staticCssEval?.resolvedModuleIds).toContain(
        stylesId
      );
    });

    it("does not reuse an unresolved export result after imported source content changes", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const missingExportStylesSource = `export const card = { color: "red" } as const;`;
      const fixedStylesSource = `export const button = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": missingExportStylesSource
        },
        "css-prop-imported-unresolved-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });
      let firstError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        firstError = error;
      }

      expect(firstError).toBeInstanceOf(BabelTransformError);

      const transformError = firstError as BabelTransformError;
      const firstStaticCssEval = transformError.staticCssEval;

      expect(firstStaticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        owner: { file: componentId },
        dependency: { file: stylesId },
        importPath: "./styles",
        exportName: "button"
      });
      expect(firstStaticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        sourceHash: createTestSourceIdentity(missingExportStylesSource)
          .sourceHash
      });

      await fs.writeFile(stylesId, fixedStylesSource, "utf8");

      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(secondTransform.code).not.toContain("_cx(button)");
      expect(secondTransform.staticCssEval?.diagnostics).toEqual([]);
      expect(secondTransform.staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        sourceHash: createTestSourceIdentity(fixedStylesSource).sourceHash
      });
      expect(firstStaticCssEval?.cacheKeys[0]?.sourceHash).not.toBe(
        secondTransform.staticCssEval?.cacheKeys[0]?.sourceHash
      );
      expect(secondTransform.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          normalizedPathKey: stylesId,
          loaded: true,
          sourceIdentity: createTestSourceIdentity(fixedStylesSource)
        })
      ]);
    });

    it("BabelTransformError preserves static css eval metadata and deterministic imported failure context", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `export const card = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-imported-failure-context"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });
      let thrownError: unknown;

      try {
        await babelTransform(componentId, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      const transformError = thrownError as BabelTransformError;
      const staticCssEval = transformError.staticCssEval;
      const diagnostic = staticCssEval?.diagnostics[0];

      expect(transformError.file).toBe(componentId);
      expect(transformError.message).toContain(
        "Cannot statically evaluate css prop value"
      );
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: stylesId,
          canonicalModuleId: `test:${stylesId}`,
          normalizedPathKey: stylesId,
          resolverKind: "test",
          loaded: true,
          sourceIdentity: createTestSourceIdentity(stylesSource)
        })
      ]);
      expect(staticCssEval?.dependencies[0]).toMatchObject({
        file: stylesId,
        kind: "imported",
        importer: componentId,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: false
      });
      expect(diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
        owner: { file: componentId },
        dependency: { file: stylesId },
        importPath: "./styles",
        exportName: "button",
        memberPath: []
      });
      expect(diagnostic?.importChain).toEqual([
        componentId,
        `${stylesId}#button`,
        stylesId
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: [],
        sourceHash: createTestSourceIdentity(stylesSource).sourceHash
      });
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("resolves direct named reexports from the async source-provider prepass", async () => {
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
      const [, sidecarSource] = result;

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId, stylesId]);
      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.dependencyFiles).toEqual([barrelId, stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(barrelId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(barrelId)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({ file: barrelId, kind: "reexported" }),
        expect.objectContaining({ file: stylesId, kind: "reexported" })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: fixturePath,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: []
      });
      expect(staticCssEval?.resolvedModuleIds).toEqual(
        expect.arrayContaining([barrelId, stylesId])
      );
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

    it("resolves namespace members from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./styles";

        function App() {
          return <div css={styles.button.primary} />;
        }
      `;
      const stylesSource = `export const button = { primary: { color: "red" } } as const;`;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-namespace-member"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [stylesId]: stylesSource
        },
        resolutions: {
          [`${fixturePath}\0./styles`]: stylesId
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
      expect(code).not.toContain("_cx(styles.button.primary)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(fixturePath)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(fixturePath)).toBe(true);
      expect(staticCssEval?.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({
          file: stylesId,
          kind: "namespace-member",
          importer: fixturePath,
          specifier: "./styles",
          exportName: "button",
          memberPath: ["primary"],
          inspected: true,
          contributed: true
        })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: fixturePath,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: ["primary"]
      });
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
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

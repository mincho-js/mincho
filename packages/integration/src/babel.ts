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
import {
  MinchoProjectEngine,
  type StaticEvalProjectEngine,
  type StaticEvalProjectEngineGeneratedArtifact
} from "./staticCssEvalProjectEngine.js";

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

export const STATIC_CSS_EVAL_SOURCE_KINDS = [
  "project-source",
  "package-source",
  "provider-virtual",
  "static-data",
  "external-no-source",
  "unresolved",
  "unsupported-source-shape"
] as const;

export type StaticCssEvalSourceKind =
  (typeof STATIC_CSS_EVAL_SOURCE_KINDS)[number];

export const STATIC_CSS_EVAL_SOURCE_ORIGINS = [
  "project",
  "package",
  "provider",
  "data",
  "external",
  "unresolved",
  "unsupported"
] as const;

export type StaticCssEvalSourceOrigin =
  (typeof STATIC_CSS_EVAL_SOURCE_ORIGINS)[number];

export type StaticCssEvalSourceUnsupportedReason = NonNullable<
  StaticCssEvalMetadataDependency["unsupportedReason"]
>;

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
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];
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
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];
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
  readonly sourceKind?: StaticCssEvalSourceKind;
  readonly sourceOrigin?: StaticCssEvalSourceOrigin;
  readonly unsupportedReason?: StaticCssEvalSourceUnsupportedReason;
  readonly watchFiles?: readonly string[];
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
  staticCssEvalProjectEngine?: StaticEvalProjectEngine;
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
    staticCssEvalProjectEngine,
    ...babelCoreOptions
  } = babel;
  const projectEngine = staticCssEvalProjectEngine;
  const prepassSourceProvider =
    projectEngine && staticCssEvalSourceProvider
      ? projectEngine.getBabelStaticEvalProvider(
          path,
          staticCssEvalSourceProvider
        )
      : staticCssEvalSourceProvider;
  const staticCssEvalPrepass =
    jsxCssProp === true && prepassSourceProvider
      ? await createStaticCssEvalPrepass(path, prepassSourceProvider)
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

    projectEngine?.refreshFile({
      fileId: path,
      ...(staticCssEval ? { result: staticCssEval } : {}),
      preserveProviderRecords: true
    });
    throw new BabelTransformError(path, error, staticCssEval);
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
  projectEngine?.refreshFile({
    fileId: path,
    ...(staticCssEval ? { result: staticCssEval } : {}),
    generatedArtifacts: createStaticCssEvalGeneratedArtifacts(
      path,
      options.result
    ),
    preserveProviderRecords: true
  });

  return {
    result: options.result,
    code: result.code,
    jsxCssPropTransformed: options.jsxCssPropTransformed === true,
    ...(staticCssEval ? { staticCssEval } : {})
  };
}

function createStaticCssEvalGeneratedArtifacts(
  ownerFile: string,
  [artifactFile, source]: readonly [string, string]
): StaticEvalProjectEngineGeneratedArtifact[] {
  return artifactFile && source
    ? [{ ownerFile, artifactFile, source, kind: "sidecar-css-ts" }]
    : [];
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
  type StaticCssEvalProviderQuery = Parameters<
    StaticCssEvalProvider["getResolvedCssValue"]
  >[0];
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
    it("does not start a prepass for a project engine without a source provider", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div css={{ color: "red" }} />;
          }
        `,
        "css-prop-engine-without-provider"
      );
      const engine = new MinchoProjectEngine();

      await expect(
        babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalProjectEngine: engine
        })
      ).resolves.toMatchObject({ jsxCssPropTransformed: true });
    });

    it("refreshes the project engine when a transform fails without static css eval", async () => {
      const fixturePath = await createBabelFixture(
        "const broken =",
        "transform-failure-without-static-css-eval"
      );
      const engine = new MinchoProjectEngine();
      engine.refreshFile({
        fileId: fixturePath,
        result: { dependencyFiles: ["/stale-dependency.ts"] },
        generatedArtifacts: [
          {
            ownerFile: fixturePath,
            artifactFile: "stale.css.ts",
            source: "stale",
            kind: "sidecar-css-ts"
          }
        ]
      });
      const provider = engine.getBabelStaticEvalProvider(fixturePath);
      await provider.resolve(fixturePath, "./current-dependency");
      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          staticCssEvalProjectEngine: engine
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for failed transform");
      }

      expect(thrownError.staticCssEval).toBeUndefined();
      expect(engine.getFileResult(fixturePath)).toMatchObject({
        dependencyFiles: [],
        generatedArtifacts: [],
        providerSnapshot: [expect.objectContaining({ kind: "resolve" })]
      });
    });

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

    it("emits sidecar build-time call-valued leaf and spread call css prop rules", async () => {
      const fixturePath = await createBabelFixture(
        `
          function makeRule(color = "red") {
            return { color };
          }

          function makeColor() {
            return "blue";
          }

          function App() {
            return <>
              <div css={makeRule("red")} />
              <div css={{ color: makeColor() }} />
              <div css={{ ...makeRule("green") }} />
            </>;
          }
        `,
        "css-prop-sidecar-build-time-calls"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [, sidecarSource] = result;

      expect(code).not.toContain(" css=");
      expect(code).not.toMatch(/\bcss\(/);
      expect(code).not.toContain("_cx(makeRule");
      expect(code).not.toContain("_cx(makeColor");
      expect(sidecarSource).toContain('_css(makeRule("red"))');
      expect(sidecarSource).toMatch(/_css\(\{\s+color: makeColor\(\)\s+\}\)/);
      expect(sidecarSource).toMatch(
        /_css\(\{\s+\.\.\.makeRule\("green"\)\s+\}\)/
      );
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
              <div css={["call-base", getClassName()]} />
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
            '"call-base", getClassName()'
          )}\\)\\}`
        )
      );
    });

    it("recognizes aliased @mincho-js/css cx calls as class values", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { cx as classNames } from "@mincho-js/css";

          const active = true;

          function App() {
            return <div css={classNames("base", active && "active")} />;
          }
        `,
        "css-prop-cx-alias"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [, sidecarSource] = result;

      expect(sidecarSource).not.toContain("classNames(");
      expect(code).toContain('classNames("base", active && "active")');
    });

    it("does not treat unrelated local cx helpers as class-value escapes", async () => {
      const fixturePath = await createBabelFixture(
        `
          const cx = (value) => value;

          function App() {
            return <div css={cx({ color: "red" })} />;
          }
        `,
        "css-prop-local-cx"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [, sidecarSource] = result;

      expect(sidecarSource).toContain("cx({");
      expect(code).not.toContain(" css=");
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

    it("partial evaluator leaves reachable imports on the static css eval provider contract", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button, tokens } from "./styles";

          function App() {
            return <>
              <div css={button} />
              <div css={tokens.button.primary} />
            </>;
          }
        `,
        "css-prop-partial-evaluator-provider-boundary"
      );
      const queries: StaticCssEvalProviderQuery[] = [];
      const provider = createResolvedStaticCssEvalProvider({
        button: { color: "red" },
        "tokens.button.primary": { color: "purple" }
      });
      const observingProvider: StaticCssEvalProvider = {
        getResolvedCssValue(query): StaticCssEvalProviderResult {
          queries.push(query);
          return provider.getResolvedCssValue(query);
        }
      };
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalProvider: observingProvider
      });
      const queryKeys = queries.map(({ bindingName, memberPath }) =>
        memberPath?.length
          ? `${bindingName}.${memberPath.join(".")}`
          : bindingName
      );

      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "purple"');
      expect(code).not.toContain(" css=");
      expect(queryKeys).toEqual(
        expect.arrayContaining(["button", "tokens.button.primary"])
      );
    });

    it("static css eval metadata dedupes dependency diagnostics and resolved module ids", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { button } from "./styles";

          function App() {
            return <>
              <div css={button} />
              <span css={button} />
            </>;
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
      const packageCacheKey = {
        ...cacheKey,
        canonicalModuleId: "pkg:@scope/styles",
        normalizedPathKey: "pkg:@scope/styles?condition=import",
        sourceKind: "package-source",
        sourceOrigin: "package",
        watchFiles: ["/project/.pnp.cjs"],
        parserVersion: "test-parser-v1",
        parserOptions: {
          plugins: ["jsx", "typescript"],
          sourceType: "module",
          jsx: true,
          typescript: true
        }
      } satisfies StaticCssEvalMetadataCacheKey;
      const cacheKeys = [cacheKey, packageCacheKey] as const;
      let cacheKeyIndex = 0;
      const provider: StaticCssEvalProvider = {
        getResolvedCssValue(): StaticCssEvalProviderResult {
          const currentCacheKey = cacheKeys[cacheKeyIndex] ?? packageCacheKey;
          cacheKeyIndex += 1;

          return {
            kind: "resolved",
            value: { color: "red" },
            dependencies: [dependency, { ...dependency }],
            diagnostics: [diagnostic, { ...diagnostic }],
            cacheKey: currentCacheKey
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
        expect.arrayContaining([
          expect.objectContaining(cacheKey),
          expect.objectContaining(packageCacheKey)
        ])
      );
      expect(staticCssEval?.cacheKeys).toHaveLength(2);
      expect(
        staticCssEval?.resolvedModuleIds.filter(
          (moduleId) => moduleId === dependency.file
        )
      ).toHaveLength(1);
    });

    it("dependency pruning keeps unused import out of async prepass", async () => {
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

    it("prepass loads reachable spread and identifier operands without broad import sweep", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import { direct } from "./direct";
        import { button } from "./styles";
        import { tokens } from "./tokens";
        import { unused } from "./unused";

        const localButton = { ...direct, background: tokens.accent };
        const unusedValue = unused;

        function App() {
          return <>
            <div css={{ ...localButton, ...button.text }} />
            <span>{unusedValue}</span>
          </>;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-prepass-reachable-spread-identifier"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const directId = path.join(fixtureRoot, "direct.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const tokensId = path.join(fixtureRoot, "tokens.ts");
      const unusedId = path.join(fixtureRoot, "unused.ts");
      const baseId = path.join(fixtureRoot, "base.ts");
      const paletteId = path.join(fixtureRoot, "palette.ts");
      const ignoredId = path.join(fixtureRoot, "ignored.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [directId]: `export const direct = { marginTop: 1 } as const;`,
          [stylesId]: `
            import { base } from "./base";
            import { palette } from "./palette";
            import { ignored } from "./ignored";

            const unusedStyle = ignored;

            export const button = {
              text: { ...base, color: palette.primary },
              ignored
            } as const;
          `,
          [tokensId]: `export const tokens = { accent: "gold" } as const;`,
          [unusedId]: `export const unused = { color: "blue" } as const;`,
          [baseId]: `export const base = { padding: 4 } as const;`,
          [paletteId]: `export const palette = { primary: "red" } as const;`,
          [ignoredId]: `export const ignored = { color: "orange" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./direct`]: directId,
          [`${fixturePath}\0./styles`]: stylesId,
          [`${fixturePath}\0./tokens`]: tokensId,
          [`${fixturePath}\0./unused`]: unusedId,
          [`${stylesId}\0./base`]: baseId,
          [`${stylesId}\0./palette`]: paletteId,
          [`${stylesId}\0./ignored`]: ignoredId
        }
      });

      const { staticCssEval } = await babelTransform(fixturePath, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./direct" },
        { importerId: fixturePath, importPath: "./tokens" },
        { importerId: fixturePath, importPath: "./styles" },
        { importerId: stylesId, importPath: "./base" },
        { importerId: stylesId, importPath: "./palette" }
      ]);
      expect(calls.loaded).toEqual([
        fixturePath,
        directId,
        tokensId,
        stylesId,
        baseId,
        paletteId
      ]);
      expect(staticCssEval?.dependencyFiles).toEqual([
        directId,
        tokensId,
        stylesId,
        baseId,
        paletteId
      ]);
      expect(staticCssEval?.resolvedModuleCache.has(unusedId)).toBe(false);
      expect(staticCssEval?.resolvedModuleCache.has(ignoredId)).toBe(false);
    });

    it("prepass loads package data virtual and CommonJS static operands", async () => {
      const ownerSource = `
        import { packageButton } from "@scope/styles";
        import { dataButton } from "@scope/styles/tokens.json";
        import { virtualButton } from "virtual:mincho/styles";

        const cjsStyles = require("./styles.cjs");

        function App() {
          return <div css={{
            ...packageButton,
            color: dataButton.color,
            background: virtualButton.background,
            borderColor: cjsStyles.colors.border
          }} />;
        }
      `;
      const ownerId = await createBabelFixture(
        ownerSource,
        "css-prop-prepass-package-data-virtual-commonjs"
      );
      const packageId = "pkg:@scope/styles/index.ts";
      const packageLoadId = `${packageId}?condition=import`;
      const dataId = "pkg:@scope/styles/tokens.json?import";
      const virtualId = "\0virtual:mincho/styles";
      const cjsId = "/project/src/styles.cjs";
      const calls: FakeStaticCssEvalSourceProviderCalls = {
        resolved: [],
        loaded: []
      };
      const resolutions = new Map<string, StaticCssEvalSourceResolution>([
        [
          `${ownerId}\0@scope/styles`,
          {
            resolvedFile: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0@scope/styles/tokens.json`,
          {
            resolvedFile: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0virtual:mincho/styles`,
          {
            resolvedFile: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            resolverKind: "test"
          }
        ],
        [
          `${ownerId}\0./styles.cjs`,
          {
            resolvedFile: cjsId,
            canonicalModuleId: cjsId,
            normalizedPathKey: cjsId,
            resolverKind: "test"
          }
        ]
      ]);
      const loadedSources = new Map<string, StaticCssEvalLoadedSource>([
        [ownerId, { source: ownerSource }],
        [
          packageLoadId,
          {
            sourceText: `export const packageButton = { padding: 8 } as const;`,
            sourceKind: "package-source",
            sourceIdentity: { sourceHash: "package-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          dataId,
          {
            sourceText: JSON.stringify({ dataButton: { color: "green" } }),
            sourceKind: "static-data",
            sourceIdentity: { sourceHash: "data-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          virtualId,
          {
            sourceText: `export const virtualButton = { background: "blue" } as const;`,
            sourceKind: "provider-virtual",
            sourceIdentity: { sourceHash: "virtual-source-v1" },
            resolverKind: "test"
          }
        ],
        [
          cjsId,
          {
            sourceText: `exports.colors = { border: "black" };`,
            resolverKind: "test"
          }
        ]
      ]);
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          calls.resolved.push({ importerId, importPath });
          return resolutions.get(`${importerId}\0${importPath}`) ?? null;
        },
        load(id) {
          calls.loaded.push(id);
          return loadedSources.get(id) ?? null;
        }
      };

      const { staticCssEval } = await babelTransform(ownerId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(calls.resolved).toEqual([
        { importerId: ownerId, importPath: "@scope/styles" },
        { importerId: ownerId, importPath: "@scope/styles/tokens.json" },
        { importerId: ownerId, importPath: "virtual:mincho/styles" },
        { importerId: ownerId, importPath: "./styles.cjs" }
      ]);
      expect(calls.loaded).toEqual([
        ownerId,
        packageLoadId,
        dataId,
        virtualId,
        cjsId
      ]);
      expect(staticCssEval?.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            loaded: true
          }),
          expect.objectContaining({
            resolvedFile: cjsId,
            sourceKind: "project-source",
            sourceOrigin: "project",
            loaded: true
          })
        ])
      );
    });

    it("cache invalidation follows transitive spread operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `import { base } from "./base"; export const button = { ...base } as const;`;
      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "base.ts": redBaseSource
        },
        "css-prop-prepass-transitive-spread-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const baseId = filePaths["base.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./base`]: baseId
        }
      });

      const firstPrepass = await createStaticCssEvalPrepass(
        componentId,
        provider
      );
      await fs.writeFile(baseId, blueBaseSource, "utf8");
      const secondPrepass = await createStaticCssEvalPrepass(
        componentId,
        provider
      );

      expect(firstPrepass.result.dependencyFiles).toEqual([stylesId, baseId]);
      expect(secondPrepass.result.dependencyFiles).toEqual([stylesId, baseId]);
      expect(firstPrepass.result.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerId: stylesId,
            specifier: "./base",
            resolvedFile: baseId,
            loaded: true,
            sourceIdentity: createTestSourceIdentity(redBaseSource)
          })
        ])
      );
      expect(secondPrepass.result.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerId: stylesId,
            specifier: "./base",
            resolvedFile: baseId,
            loaded: true,
            sourceIdentity: createTestSourceIdentity(blueBaseSource)
          })
        ])
      );
      expect(
        firstPrepass.result.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondPrepass.result.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows computed key operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `import { colorKey } from "./keys"; export const button = { [colorKey]: "red" } as const;`;
      const colorKeySource = `export const colorKey = "color" as const;`;
      const backgroundKeySource = `export const colorKey = "background" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "keys.ts": colorKeySource
        },
        "css-prop-computed-key-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const keysId = filePaths["keys.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./keys`]: keysId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(keysId, backgroundKeySource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('background: "red"');
      expect(secondTransform.result[1]).toContain('background: "red"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        keysId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        keysId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(colorKeySource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(backgroundKeySource).sourceHash);
    });

    it("partial evaluator cache invalidation recomputes helper object spread and computed key outputs", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `
        import { base } from "./base";
        import { propertyKey } from "./keys";

        const helper = { ...base, [propertyKey]: "solid" } as const;
        export const button = { ...helper } as const;
      `;
      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const borderKeySource = `export const propertyKey = "borderColor" as const;`;
      const backgroundKeySource = `export const propertyKey = "background" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "base.ts": redBaseSource,
          "keys.ts": borderKeySource
        },
        "css-prop-partial-evaluator-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const baseId = filePaths["base.ts"];
      const keysId = filePaths["keys.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./base`]: baseId,
          [`${stylesId}\0./keys`]: keysId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(baseId, blueBaseSource, "utf8");
      await fs.writeFile(keysId, backgroundKeySource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).toContain('borderColor: "solid"');
      expect(firstTransform.result[1]).not.toContain('background: "solid"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('background: "solid"');
      expect(secondTransform.result[1]).not.toContain('borderColor: "solid"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        baseId,
        keysId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        baseId,
        keysId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(redBaseSource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(blueBaseSource).sourceHash);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(borderKeySource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === keysId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(backgroundKeySource).sourceHash);
    });

    it("cache invalidation follows sidecar build-time factory spread helper source identity without unused helper", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { makeButton } from "./factory";

        function App() {
          return <div css={makeButton()} />;
        }
      `;
      const factorySource = `
        import { base } from "./base";
        import { propertyKey } from "./keys";
        import { unused } from "./unused";

        const ignored = unused;

        export function makeButton() {
          return { ...base, [propertyKey]: "solid" } as const;
        }
      `;
      const redBaseSource = `export const base = { color: "red" } as const;`;
      const blueBaseSource = `export const base = { color: "blue" } as const;`;
      const keySource = `export const propertyKey = "borderColor" as const;`;
      const unusedSource = `export const unused = { color: "orange" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "factory.ts": factorySource,
          "base.ts": redBaseSource,
          "keys.ts": keySource,
          "unused.ts": unusedSource
        },
        "css-prop-sidecar-factory-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const factoryId = filePaths["factory.ts"];
      const baseId = filePaths["base.ts"];
      const keysId = filePaths["keys.ts"];
      const unusedId = filePaths["unused.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./factory`]: factoryId,
          [`${factoryId}\0./base`]: baseId,
          [`${factoryId}\0./keys`]: keysId,
          [`${factoryId}\0./unused`]: unusedId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(baseId, blueBaseSource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain("makeButton()");
      expect(secondTransform.result[1]).toContain("makeButton()");
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        factoryId,
        baseId,
        keysId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        factoryId,
        baseId,
        keysId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedModuleCache.has(unusedId)
      ).toBe(false);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(redBaseSource).sourceHash);
      expect(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === baseId
        )?.sourceIdentity?.sourceHash
      ).toBe(createTestSourceIdentity(blueBaseSource).sourceHash);
    });

    it("routes vite and esbuild style static css eval adapters through the project engine", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `import { token } from "./tokens"; export const button = { color: token } as const;`;
      const tokenSource = `export const token = "red" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "tokens.ts": tokenSource
        },
        "css-prop-project-engine-adapter-routes"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const tokensId = filePaths["tokens.ts"];
      const engine = new MinchoProjectEngine();
      const createAdapterProvider = (resolverKind: StaticCssEvalResolverKind) =>
        createFileBackedStaticCssEvalSourceProvider({
          resolverKind,
          resolutions: {
            [`${componentId}\0./styles`]: stylesId,
            [`${stylesId}\0./tokens`]: tokensId
          }
        });

      const viteTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalProjectEngine: engine,
        staticCssEvalSourceProvider: createAdapterProvider("vite")
      });
      const viteFileResult = engine.getFileResult(componentId);
      const invalidatedOwners = engine.invalidateByDependency(tokensId);
      const invalidatedFileResult = engine.getFileResult(componentId);
      const esbuildTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalProjectEngine: engine,
        staticCssEvalSourceProvider: createAdapterProvider("esbuild")
      });
      const esbuildFileResult = engine.getFileResult(componentId);

      expect(viteTransform.result[1]).toContain('color: "red"');
      expect(viteFileResult?.dependencyFiles).toEqual(
        expect.arrayContaining([stylesId, tokensId])
      );
      expect(viteFileResult?.generatedArtifacts).toHaveLength(1);
      expect(viteFileResult?.cacheKeys.length).toBeGreaterThan(0);
      expect(
        viteFileResult?.providerSnapshot.map((record) => record.kind)
      ).toEqual(expect.arrayContaining(["load", "resolve"]));
      expect(
        viteFileResult?.providerSnapshot.some(
          (record) => record.result?.resolverKind === "vite"
        )
      ).toBe(true);
      expect(invalidatedOwners).toEqual([componentId]);
      expect(invalidatedFileResult?.generatedArtifacts).toEqual([]);
      expect(esbuildTransform.result[1]).toContain('color: "red"');
      expect(esbuildFileResult?.invalidated).toBe(false);
      expect(esbuildFileResult?.generatedArtifacts).toHaveLength(1);
      expect(
        esbuildFileResult?.providerSnapshot.some(
          (record) => record.result?.resolverKind === "esbuild"
        )
      ).toBe(true);
    });

    it("cache invalidation follows template interpolation operand source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource =
        'import { brand } from "./brand"; export const button = { color: `${brand}` } as const;';
      const redBrandSource = `export const brand = "red" as const;`;
      const blueBrandSource = `export const brand = "blue" as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "brand.ts": redBrandSource
        },
        "css-prop-template-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const brandId = filePaths["brand.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./brand`]: brandId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(brandId, blueBrandSource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        brandId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        brandId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === brandId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === brandId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows optional member target source identity", async () => {
      const fs = await import("node:fs/promises");
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `import { palette } from "./palette"; export const button = { color: palette?.primary } as const;`;
      const redPaletteSource = `export const palette = { primary: "red" } as const;`;
      const bluePaletteSource = `export const palette = { primary: "blue" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource,
          "palette.ts": redPaletteSource
        },
        "css-prop-optional-member-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const paletteId = filePaths["palette.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId,
          [`${stylesId}\0./palette`]: paletteId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(paletteId, bluePaletteSource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(firstTransform.result[1]).not.toContain('color: "blue"');
      expect(secondTransform.result[1]).toContain('color: "blue"');
      expect(secondTransform.result[1]).not.toContain('color: "red"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        paletteId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        stylesId,
        paletteId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === paletteId
        )?.sourceIdentity?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies.find(
          (dependency) => dependency.resolvedFile === paletteId
        )?.sourceIdentity?.sourceHash
      );
    });

    it("cache invalidation follows const CommonJS require path source and target changes", async () => {
      const fs = await import("node:fs/promises");
      const redComponentSource = `
        const cjsPath = "./red-styles";
        const styles = require(cjsPath);

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const blueComponentSource = `
        const cjsPath = "./blue-styles";
        const styles = require(cjsPath);

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const redStylesSource = `exports.button = { color: "red" };`;
      const orangeStylesSource = `exports.button = { color: "orange" };`;
      const blueStylesSource = `exports.button = { color: "blue" };`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": redComponentSource,
          "red-styles.cjs": redStylesSource,
          "blue-styles.cjs": blueStylesSource
        },
        "css-prop-cjs-const-path-cache-invalidation"
      );
      const componentId = filePaths["component.tsx"];
      const redStylesId = filePaths["red-styles.cjs"];
      const blueStylesId = filePaths["blue-styles.cjs"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./red-styles`]: redStylesId,
          [`${componentId}\0./blue-styles`]: blueStylesId
        }
      });

      const firstTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(redStylesId, orangeStylesSource, "utf8");
      const secondTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });
      await fs.writeFile(componentId, blueComponentSource, "utf8");
      const thirdTransform = await babelTransform(componentId, {
        jsxCssProp: true,
        staticCssEvalSourceProvider: provider
      });

      expect(firstTransform.result[1]).toContain('color: "red"');
      expect(secondTransform.result[1]).toContain('color: "orange"');
      expect(thirdTransform.result[1]).toContain('color: "blue"');
      expect(firstTransform.staticCssEval?.dependencyFiles).toEqual([
        redStylesId
      ]);
      expect(secondTransform.staticCssEval?.dependencyFiles).toEqual([
        redStylesId
      ]);
      expect(thirdTransform.staticCssEval?.dependencyFiles).toEqual([
        blueStylesId
      ]);
      expect(
        firstTransform.staticCssEval?.resolvedDependencies[0]?.sourceIdentity
          ?.sourceHash
      ).not.toBe(
        secondTransform.staticCssEval?.resolvedDependencies[0]?.sourceIdentity
          ?.sourceHash
      );
      expect(
        thirdTransform.staticCssEval?.resolvedDependencies[0]
      ).toMatchObject({
        specifier: "./blue-styles",
        resolvedFile: blueStylesId,
        loaded: true
      });
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

    it("static css eval cache keys include source provider package data and virtual identity metadata", async () => {
      const componentSource = `
        import { button } from "@scope/styles";
        import { token } from "@scope/styles/tokens.json";
        import { virtualButton } from "virtual:mincho/styles";

        function App() {
          return <>
            <div css={button} />
            <div css={token} />
            <div css={virtualButton} />
          </>;
        }
      `;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource
        },
        "css-prop-source-provider-cache-metadata"
      );
      const componentId = filePaths["component.tsx"];
      const packageId = "pkg:@scope/styles/index.ts";
      const packageLoadId = `${packageId}?condition=import`;
      const dataId = "pkg:@scope/styles/tokens.json?import";
      const virtualId = "\0virtual:mincho/styles";
      const pnpWatchFile = "/project/.pnp.cjs";
      const dataWatchFile = "/project/node_modules/@scope/styles/tokens.json";
      const resolutions = new Map<string, StaticCssEvalSourceResolution>([
        [
          `${componentId}\0@scope/styles`,
          {
            resolvedFile: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            sourceIdentity: { version: "package-resolution-v1" },
            watchFiles: [pnpWatchFile],
            resolverKind: "test"
          }
        ],
        [
          `${componentId}\0@scope/styles/tokens.json`,
          {
            resolvedFile: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            watchFiles: [dataWatchFile],
            resolverKind: "test"
          }
        ],
        [
          `${componentId}\0virtual:mincho/styles`,
          {
            resolvedFile: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            sourceIdentity: { version: "virtual-resolution-v1" },
            resolverKind: "test"
          }
        ]
      ]);
      const loadedSources = new Map<string, StaticCssEvalLoadedSource>([
        [componentId, { source: componentSource }],
        [
          packageLoadId,
          {
            sourceText: `export const button = { color: "red" } as const;`,
            sourceKind: "package-source",
            sourceIdentity: { sourceHash: "package-source-v1" },
            watchFiles: [pnpWatchFile],
            resolverKind: "test"
          }
        ],
        [
          dataId,
          {
            sourceText: JSON.stringify({ token: { color: "green" } }),
            sourceKind: "static-data",
            sourceIdentity: { sourceHash: "data-source-v1" },
            watchFiles: [dataWatchFile],
            resolverKind: "test"
          }
        ],
        [
          virtualId,
          {
            sourceText: `export const virtualButton = { color: "blue" } as const;`,
            sourceKind: "provider-virtual",
            sourceIdentity: {
              sourceHash: "virtual-source-v1",
              version: "virtual-loaded-v1"
            },
            resolverKind: "test"
          }
        ]
      ]);
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          return resolutions.get(`${importerId}\0${importPath}`) ?? null;
        },
        load(id) {
          return loadedSources.get(id) ?? null;
        }
      };

      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );

      expect(result[1]).toContain('color: "red"');
      expect(result[1]).toContain('color: "green"');
      expect(result[1]).toContain('color: "blue"');
      expect(code).not.toContain("_cx(button)");
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            resolvedId: packageId,
            canonicalModuleId: "pkg:@scope/styles",
            normalizedPathKey: packageLoadId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            sourceHash: "package-source-v1",
            sourceVersion: "package-resolution-v1",
            watchFiles: [pnpWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            resolvedId: dataId,
            canonicalModuleId: dataId,
            normalizedPathKey: dataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            sourceHash: "data-source-v1",
            watchFiles: [dataWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            resolvedId: virtualId,
            canonicalModuleId: virtualId,
            normalizedPathKey: virtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            sourceHash: "virtual-source-v1",
            sourceVersion: "virtual-loaded-v1"
          })
        ])
      );
      expect(staticCssEval?.resolvedDependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resolvedFile: packageId,
            sourceKind: "package-source",
            sourceIdentity: expect.objectContaining({
              sourceHash: "package-source-v1"
            }),
            resolverKind: "test",
            watchFiles: [pnpWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: dataId,
            sourceKind: "static-data",
            sourceIdentity: expect.objectContaining({
              sourceHash: "data-source-v1"
            }),
            resolverKind: "test",
            watchFiles: [dataWatchFile]
          }),
          expect.objectContaining({
            resolvedFile: virtualId,
            sourceKind: "provider-virtual",
            sourceIdentity: {
              sourceHash: "virtual-source-v1",
              version: "virtual-loaded-v1"
            },
            resolverKind: "test"
          })
        ])
      );
    });

    it("resolves CommonJS require css prop metadata through the async source-provider prepass", async () => {
      const componentSource = `
        const styles = require("./styles");

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const stylesSource = `exports.button = { color: "red" };`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.cjs": stylesSource
        },
        "css-prop-cjs-require-metadata"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.cjs"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });

      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );
      const [, sidecarSource] = result;

      expect(sidecarSource).toContain('color: "red"');
      expect(code).not.toContain("_cx(styles.button)");
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(componentId)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        componentId
      ]);
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
      expect(staticCssEval?.dependencies).toEqual([
        expect.objectContaining({
          file: stylesId,
          kind: "imported",
          importer: componentId,
          specifier: "./styles",
          exportName: "button",
          memberPath: [],
          inspected: true,
          contributed: true,
          sourceHash: createTestSourceIdentity(stylesSource).sourceHash,
          resolverKind: "test"
        })
      ]);
      expect(staticCssEval?.cacheKeys[0]).toMatchObject({
        importerFile: componentId,
        resolvedFile: stylesId,
        resolvedId: stylesId,
        exportName: "button",
        memberPath: [],
        sourceHash: createTestSourceIdentity(stylesSource).sourceHash
      });
      expect(staticCssEval?.diagnostics).toEqual([]);
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("dedupes CommonJS unsupported diagnostics observed during transform", async () => {
      const componentSource = `
        const source = "./" + "styles";
        const styles = require(source);

        function App() {
          return <>
            <div css={styles.button} />
            <span css={styles.button} />
          </>;
        }
      `;
      const componentId = await createBabelFixture(
        componentSource,
        "css-prop-cjs-diagnostic-dedupe"
      );
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {}
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

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for dynamic CJS require");
      }

      expect(
        thrownError.staticCssEval?.diagnostics.filter(
          (diagnostic) =>
            diagnostic.id === "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        )
      ).toHaveLength(1);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([]);
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([]);
    });

    it("does not reuse a negative dependency unresolved export result after imported source content changes", async () => {
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

    it("reports prepared unsupported static-data reasons in transform diagnostics", async () => {
      const cases = [
        {
          label: "wasm-init",
          importPath: "@scope/styles/icon.wasm?init",
          resolvedId: "pkg:@scope/styles/icon.wasm?init",
          sourceText: `export default function init() {}`,
          unsupportedReason: "runtime-wasm-init"
        },
        {
          label: "invalid-json",
          importPath: "@scope/styles/broken.json",
          resolvedId: "pkg:@scope/styles/broken.json?import",
          sourceText: `{ "button": `,
          unsupportedReason: "invalid-json-data"
        }
      ] as const;

      for (const testCase of cases) {
        const componentSource = `
          import unsupported from "${testCase.importPath}";

          function App() {
            return <div css={unsupported} />;
          }
        `;
        const componentId = await createBabelFixture(
          componentSource,
          `css-prop-static-data-${testCase.label}`
        );
        const provider: StaticCssEvalSourceProvider = {
          resolve(importerId, importPath) {
            if (
              importerId !== componentId ||
              importPath !== testCase.importPath
            ) {
              return null;
            }

            return {
              resolvedFile: testCase.resolvedId,
              canonicalModuleId: testCase.resolvedId,
              normalizedPathKey: testCase.resolvedId,
              sourceKind: "static-data",
              resolverKind: "test"
            };
          },
          load(id) {
            if (id === componentId) {
              return { sourceText: componentSource, resolverKind: "test" };
            }

            if (id === testCase.resolvedId) {
              return {
                sourceText: testCase.sourceText,
                sourceKind: "static-data",
                sourceIdentity: {
                  sourceHash: createTestSourceIdentity(testCase.sourceText)
                    .sourceHash,
                  version: testCase.label
                },
                resolverKind: "test"
              };
            }

            return null;
          }
        };
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

        if (!(thrownError instanceof BabelTransformError)) {
          throw new Error(
            "Expected BabelTransformError for static data source"
          );
        }

        expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: testCase.unsupportedReason,
          dependency: { file: testCase.resolvedId },
          importPath: testCase.importPath,
          exportName: "default"
        });
        expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
          expect.objectContaining({
            resolvedFile: testCase.resolvedId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: testCase.unsupportedReason,
            sourceIdentity: {
              sourceHash: createTestSourceIdentity(testCase.sourceText)
                .sourceHash,
              version: testCase.label
            },
            resolverKind: "test",
            loaded: true
          })
        ]);
      }
    });

    it("keeps provider-declared unsupported reexport sources fail-closed without filesystem traversal", async () => {
      const componentSource = `
        import { button } from "./barrel";

        function App() {
          return <div css={button} />;
        }
      `;
      const barrelSource = `export { button } from "./styles";`;
      const stylesSource = `export const button = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "barrel.ts": barrelSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-unsupported-barrel-no-fallback"
      );
      const componentId = filePaths["component.tsx"];
      const barrelId = filePaths["barrel.ts"];
      const stylesId = filePaths["styles.ts"];
      const loadedIds: string[] = [];
      const provider: StaticCssEvalSourceProvider = {
        resolve(importerId, importPath) {
          if (importerId !== componentId || importPath !== "./barrel") {
            return null;
          }

          return {
            resolvedFile: barrelId,
            canonicalModuleId: `test:${barrelId}`,
            normalizedPathKey: barrelId,
            sourceKind: "unsupported-source-shape",
            unsupportedReason: "reexport-or-barrel",
            resolverKind: "test"
          };
        },
        load(id) {
          loadedIds.push(id);

          if (id === componentId) {
            return { sourceText: componentSource, resolverKind: "test" };
          }

          if (id === barrelId) {
            return {
              sourceText: barrelSource,
              sourceKind: "unsupported-source-shape",
              unsupportedReason: "reexport-or-barrel",
              resolverKind: "test"
            };
          }

          if (id === stylesId) {
            return { sourceText: stylesSource, resolverKind: "test" };
          }

          return null;
        }
      };
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

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for unsupported barrel");
      }

      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
        reason: "reexport-or-barrel",
        dependency: { file: barrelId },
        importPath: "./barrel",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./barrel",
          resolvedFile: barrelId,
          sourceKind: "unsupported-source-shape",
          sourceOrigin: "unsupported",
          unsupportedReason: "reexport-or-barrel",
          resolverKind: "test",
          loaded: true
        })
      ]);
      expect(loadedIds).not.toContain(stylesId);
    });

    it("keeps unresolved provider imports fail-closed even when the imported file exists", async () => {
      const componentSource = `
        import { button } from "./styles";

        function App() {
          return <div css={button} />;
        }
      `;
      const stylesSource = `export const button = { color: "red" } as const;`;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-unresolved-no-fallback"
      );
      const componentId = filePaths["component.tsx"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {}
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

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for unresolved import");
      }

      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        dependency: { file: "./styles" },
        importPath: "./styles",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([]);
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: componentId,
          specifier: "./styles",
          resolvedFile: "./styles",
          canonicalModuleId: "unresolved:./styles",
          normalizedPathKey: "unresolved:./styles",
          resolverKind: "source-provider",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
      expect(thrownError.staticCssEval?.dependencies[0]).toMatchObject({
        file: "./styles",
        kind: "imported",
        importer: componentId,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: false
      });
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

      expect(resolution.dependencies).toMatchObject([
        {
          file: stylesId,
          inspected: true,
          contributed: false,
          sourceKind: "unsupported-source-shape",
          unsupportedReason: "unsupported-source-shape"
        }
      ]);
      expect(resolution.diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
        code: "unsupported-source",
        reason: "unsupported-source-shape",
        dependency: { file: stylesId }
      });
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

    it("resolves imported static-shape spreads computed keys and member paths from the async source-provider prepass", async () => {
      const componentSource = `
        import { button, card } from "./styles";

        function App() {
          return <>
            <div css={button.primary} />
            <section css={card} />
          </>;
        }
      `;
      const stylesSource = `
        const backgroundKey = "backgroundColor";
        const base = { color: "red" } as const;
        const hover = { _hover: { color: "blue" } } as const;
        const row = [{ display: "flex" }] as const;
        const spacing = { gap: "8px" } as const;

        export const button = {
          primary: [
            ...row,
            { ...base, [backgroundKey]: "white" },
            { ...hover },
            spacing
          ]
        } as const;

        export const card = {
          ...base,
          [backgroundKey]: "black",
          ...hover
        } as const;
      `;
      const { filePaths } = await createBabelFixtureFiles(
        {
          "component.tsx": componentSource,
          "styles.ts": stylesSource
        },
        "css-prop-provider-static-shape-spreads"
      );
      const componentId = filePaths["component.tsx"];
      const stylesId = filePaths["styles.ts"];
      const provider = createFileBackedStaticCssEvalSourceProvider({
        resolutions: {
          [`${componentId}\0./styles`]: stylesId
        }
      });
      const { code, result, staticCssEval } = await babelTransform(
        componentId,
        {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        }
      );
      const [sidecarFile, sidecarSource] = result;

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(code).toMatch(
        new RegExp(`import \\{ [^}]+ \\} from "${escapeRegExp(sidecarFile)}";`)
      );
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("_cx(button.primary)");
      expect(code).not.toContain("_cx(card)");
      expect(sidecarSource).toContain('display: "flex"');
      expect(sidecarSource).toContain('gap: "8px"');
      expect(sidecarSource).toContain('backgroundColor: "white"');
      expect(sidecarSource).toContain('backgroundColor: "black"');
      expect(staticCssEval?.dependencyFiles).toEqual([stylesId]);
      expect(staticCssEval?.ownerToDependencies.get(componentId)).toEqual([
        stylesId
      ]);
      expect(staticCssEval?.dependencyToOwners.get(stylesId)).toEqual([
        componentId
      ]);
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
      expect(staticCssEval?.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stylesId,
            kind: "imported",
            importer: componentId,
            specifier: "./styles",
            exportName: "button",
            memberPath: ["primary"],
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: stylesId,
            kind: "imported",
            importer: componentId,
            specifier: "./styles",
            exportName: "card",
            memberPath: [],
            inspected: true,
            contributed: true
          })
        ])
      );
      expect(staticCssEval?.cacheKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerFile: componentId,
            resolvedFile: stylesId,
            resolvedId: stylesId,
            exportName: "button",
            memberPath: ["primary"],
            sourceHash: createTestSourceIdentity(stylesSource).sourceHash
          }),
          expect.objectContaining({
            importerFile: componentId,
            resolvedFile: stylesId,
            resolvedId: stylesId,
            exportName: "card",
            memberPath: [],
            sourceHash: createTestSourceIdentity(stylesSource).sourceHash
          })
        ])
      );
      expect(staticCssEval?.resolvedModuleIds).toContain(stylesId);
    });

    it("loads export-star namespace members from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button.primary} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-export-star-namespace-member"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./styles";`,
          [stylesId]: `export const button = { primary: { color: "red" } } as const;`
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
      expect(code).not.toContain("_cx(styles.button.primary)");
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
      expect(staticCssEval?.resolvedModuleIds).toEqual(
        expect.arrayContaining([barrelId, stylesId])
      );
    });

    it("loads whole namespace export-star graphs with explicit default reexports from the async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-whole-namespace-export-star-default"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const resetId = path.join(fixtureRoot, "reset.ts");
      const stylesId = path.join(fixtureRoot, "styles.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `
            export { default } from "./reset";
            export * from "./styles";
          `,
          [resetId]: `export default { margin: 0 } as const;`,
          [stylesId]: `export const button = { color: "red" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./reset`]: resetId,
          [`${barrelId}\0./styles`]: stylesId
        }
      });
      const { result: staticCssEval } = await createStaticCssEvalPrepass(
        fixturePath,
        provider
      );

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./reset" },
        { importerId: barrelId, importPath: "./styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId, resetId, stylesId]);
      expect(staticCssEval.dependencyFiles).toEqual([
        barrelId,
        resetId,
        stylesId
      ]);
      expect(staticCssEval.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        resetId,
        stylesId
      ]);
      expect(staticCssEval.dependencyToOwners.get(resetId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval.dependencyToOwners.get(stylesId)).toEqual([
        fixturePath
      ]);
      expect(staticCssEval.resolvedModuleCache.has(resetId)).toBe(true);
      expect(staticCssEval.resolvedModuleCache.has(stylesId)).toBe(true);
      expect(staticCssEval.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./reset",
          resolvedFile: resetId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./styles",
          resolvedFile: stylesId,
          loaded: true
        })
      ]);
    });

    it("excludes star-only default reexports from whole namespace export-star async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-star-only-default-exclusion"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const defaultBarrelId = path.join(fixtureRoot, "defaultBarrel.ts");
      const defaultLeafId = path.join(fixtureRoot, "defaultLeaf.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./defaultBarrel";`,
          [defaultBarrelId]: `
            export { default } from "./defaultLeaf";
            export const button = { color: "red" } as const;
          `,
          [defaultLeafId]: `export default { color: "blue" } as const;`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./defaultBarrel`]: defaultBarrelId,
          [`${defaultBarrelId}\0./defaultLeaf`]: defaultLeafId
        }
      });
      const { result: staticCssEval } = await createStaticCssEvalPrepass(
        fixturePath,
        provider
      );

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./defaultBarrel" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId, defaultBarrelId]);
      expect(staticCssEval.dependencyFiles).toEqual([
        barrelId,
        defaultBarrelId
      ]);
      expect(staticCssEval.ownerToDependencies.get(fixturePath)).toEqual([
        barrelId,
        defaultBarrelId
      ]);
      expect(staticCssEval.resolvedModuleCache.has(defaultBarrelId)).toBe(true);
      expect(staticCssEval.resolvedModuleCache.has(defaultLeafId)).toBe(false);
    });

    it("bounds export-star cycles in namespace async source-provider prepass", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-export-star-cycle"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const loopId = path.join(fixtureRoot, "loop.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./loop";`,
          [loopId]: `export * from "./barrel";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId,
          [`${barrelId}\0./loop`]: loopId,
          [`${loopId}\0./barrel`]: barrelId
        }
      });
      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error("Expected BabelTransformError for export-star cycle");
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./loop" },
        { importerId: loopId, importPath: "./barrel" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId, loopId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([
        barrelId,
        loopId
      ]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
        owner: { file: fixturePath }
      });
    });

    it("keeps unresolved export-star namespace prepass failures bounded", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-unresolved-export-star"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "./missing";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId
        }
      });
      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error(
          "Expected BabelTransformError for unresolved export-star"
        );
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "./missing" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        owner: { file: fixturePath },
        dependency: { file: "./missing" },
        importPath: "./missing",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "./missing",
          resolvedFile: "./missing",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
    });

    it("keeps package boundary export-star namespace prepass failures bounded", async () => {
      const path = await import("node:path");
      const ownerSource = `
        import * as styles from "./barrel";

        function App() {
          return <div css={styles.button} />;
        }
      `;
      const fixturePath = await createBabelFixture(
        ownerSource,
        "css-prop-async-prepass-package-boundary-export-star"
      );
      const fixtureRoot = path.dirname(fixturePath);
      const barrelId = path.join(fixtureRoot, "barrel.ts");
      const { provider, calls } = createFakeStaticCssEvalSourceProvider({
        sources: {
          [fixturePath]: ownerSource,
          [barrelId]: `export * from "@scope/styles";`
        },
        resolutions: {
          [`${fixturePath}\0./barrel`]: barrelId
        }
      });
      let thrownError: unknown;

      try {
        await babelTransform(fixturePath, {
          jsxCssProp: true,
          staticCssEvalSourceProvider: provider
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(BabelTransformError);

      if (!(thrownError instanceof BabelTransformError)) {
        throw new Error(
          "Expected BabelTransformError for package boundary export-star"
        );
      }

      expect(calls.resolved).toEqual([
        { importerId: fixturePath, importPath: "./barrel" },
        { importerId: barrelId, importPath: "@scope/styles" }
      ]);
      expect(calls.loaded).toEqual([fixturePath, barrelId]);
      expect(thrownError.staticCssEval?.dependencyFiles).toEqual([barrelId]);
      expect(thrownError.staticCssEval?.diagnostics[0]).toMatchObject({
        id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
        owner: { file: fixturePath },
        dependency: { file: "@scope/styles" },
        importPath: "@scope/styles",
        exportName: "button"
      });
      expect(thrownError.staticCssEval?.resolvedDependencies).toEqual([
        expect.objectContaining({
          importerId: fixturePath,
          specifier: "./barrel",
          resolvedFile: barrelId,
          loaded: true
        }),
        expect.objectContaining({
          importerId: barrelId,
          specifier: "@scope/styles",
          resolvedFile: "@scope/styles",
          sourceKind: "unresolved",
          sourceOrigin: "unresolved",
          unsupportedReason: "unresolved",
          loaded: false
        })
      ]);
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
      const { result, code, staticCssEval } = await babelTransform(
        wholeExpressionPath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: provider
        }
      );

      expect(staticCssEval?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported-source",
            reason: "reexport-or-barrel",
            importPath: "./barrel",
            exportName: "button",
            dependency: { file: "/provider/barrel.ts" }
          })
        ])
      );

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
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'Cannot statically evaluate css prop value: export "button" uses unsupported reexport/barrel syntax'
        ),
        staticCssEval: expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "unsupported-source",
              reason: "reexport-or-barrel",
              importPath: "./barrel",
              exportName: "button",
              dependency: { file: "/provider/barrel.ts" }
            })
          ])
        })
      });
    });

    it("lowers representative logical css rule branches", async () => {
      const fixturePath = await createBabelFixture(
        `
          const andClass = "and-class";

          function App(providedClass: string, maybeClass: string | null) {
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

    it("lowers representative recursive css prop branches", async () => {
      const fixturePath = await createBabelFixture(
        `
          import { styles } from "./styles";

          const condition = true;
          const flag = false;
          const styleA = "style-a";

          function App() {
            return <>
              <div css={condition ? flag ? { color: "red" } : { color: "blue" } : styleA} />
              <div css={condition && flag && { color: "green" }} />
              <div css={{ color: "yellow" } && (condition && { color: "orange" })} />
              <div css={["base", ["nested", condition && { color: "purple" }]]} />
              <div css={condition ? styles.red : { color: "black" }} />
            </>;
          }
        `,
        "css-prop-recursive-branches"
      );
      const { result, code, staticCssEval } = await babelTransform(
        fixturePath,
        {
          jsxCssProp: true,
          staticCssEvalProvider: createResolvedStaticCssEvalProvider({
            "styles.red": { color: "magenta" }
          })
        }
      );
      const [sidecarFile, sidecarSource] = result;
      const output = `${code}\n${sidecarSource}`;
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
      const nestedConditionalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition \\? flag \\? ([A-Za-z_$][\\w$]*) : ([A-Za-z_$][\\w$]*) : styleA\\)\\}`
      ).exec(code);
      const chainedLogicalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition && flag && ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);
      const staticLeftLogicalMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition && ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);
      const nestedArrayMatch = new RegExp(
        `className=\\{${escapeRegExp(cxIdentifier)}\\("base", ${escapeRegExp(
          cxIdentifier
        )}\\("nested", condition && ([A-Za-z_$][\\w$]*)\\)\\)\\}`
      ).exec(code);
      const providerBranchMatch = new RegExp(
        `className=\\{${escapeRegExp(
          cxIdentifier
        )}\\(condition \\? styles\\.red : ([A-Za-z_$][\\w$]*)\\)\\}`
      ).exec(code);
      const generatedClassNames = [
        ...(nestedConditionalMatch?.slice(1) ?? []),
        chainedLogicalMatch?.[1],
        staticLeftLogicalMatch?.[1],
        nestedArrayMatch?.[1],
        providerBranchMatch?.[1]
      ].filter(
        (className): className is string => typeof className === "string"
      );

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarSource).toContain("@mincho-js/css");
      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(exportedDeclarations).toHaveLength(6);
      expect(generatedClassNames).toHaveLength(6);
      expect(new Set(generatedClassNames)).toHaveLength(6);
      for (const color of [
        "red",
        "blue",
        "green",
        "orange",
        "purple",
        "black"
      ]) {
        expect(sidecarSource).toContain(`color: "${color}"`);
      }
      for (const className of generatedClassNames) {
        expect(sidecarRuntimeNames).toContain(className);
      }
      expect(nestedConditionalMatch).not.toBeNull();
      expect(chainedLogicalMatch).not.toBeNull();
      expect(staticLeftLogicalMatch).not.toBeNull();
      expect(nestedArrayMatch).not.toBeNull();
      expect(providerBranchMatch).not.toBeNull();
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={{");
      expect(code).not.toContain("css:");
      expect(output).not.toContain("_css(condition ?");
      expect(output).not.toContain("_css(condition &&");
      expect(output).not.toContain("css(condition ?");
      expect(output).not.toContain("css(condition &&");
      expect(output).not.toContain('color: "yellow"');
      expect(output).not.toContain('color: "magenta"');
      expect(staticCssEval?.dependencies ?? []).toEqual([]);
      expect(staticCssEval?.resolvedModuleIds ?? []).toEqual([]);
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

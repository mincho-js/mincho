import { types as t } from "@babel/core";
import { getUnsupportedLiteralReason } from "./ast.js";
import {
  createExportMapCacheKey,
  createStaticCssModuleCache,
  formatExportMapCacheKey,
  STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
  STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
} from "./moduleCache.js";
import type { StaticCssModuleCache } from "./moduleCache.js";
import type {
  ResolutionDependency,
  StaticCssEvalCacheKey,
  StaticCssEvalDiagnosticId,
  StaticCssEvalProvider,
  StaticCssEvalResult,
  StaticCssLiteral
} from "./types.js";
import type {
  ImportedStaticCssEvalImportResolution,
  ImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalResolutionState
} from "./importedModules/contracts.js";
import { createReferenceQuery } from "./importedModules/localReference.js";
import { createImportedStaticCssEvalModuleRecord } from "./importedModules/provider.js";
import {
  addResolutionDependency,
  getResolutionDependencies
} from "./importedModules/resolution.js";
import { findUnsupportedImportedStaticCssEvalReferenceDiagnostic } from "./importedModules/expression.js";
import { ImportedStaticCssEvalResolver } from "./importedModules/resolver.js";

export type {
  CreateImportedStaticCssEvalProviderOptions,
  ImportedStaticCssEvalCjsBinding,
  ImportedStaticCssEvalExportBinding,
  ImportedStaticCssEvalImportBinding,
  ImportedStaticCssEvalImportResolution,
  ImportedStaticCssEvalLoadedModule,
  ImportedStaticCssEvalModuleRecord,
  ResolveImportedStaticCssEvalExpressionResult
} from "./importedModules/contracts.js";
export {
  createImportedStaticCssEvalModuleRecord,
  createImportedStaticCssEvalProvider
} from "./importedModules/provider.js";
export {
  createStaticCssLiteralExpression,
  findUnsupportedImportedStaticCssEvalReferenceDiagnostic,
  resolveImportedStaticCssEvalExpression
} from "./importedModules/expression.js";

// == Tests ====================================================================

// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, expect, it } = import.meta.vitest;

  const ownerId = "/project/src/App.tsx";
  const stylesId = "/project/src/styles.ts";
  const barrelId = "/project/src/barrel.ts";
  const buttonId = "/project/src/button.ts";
  const packageBarrelId = "pkg:@scope/styles";
  const packageLeafId = "pkg:@scope/styles/leaf";
  const packageDataId = "data:@scope/styles/tokens";
  const packageJsonId = "data:@scope/styles/theme.json";
  const packageRawId = "data:@scope/styles/tokens.css?raw";
  const packageWasmUrlId = "data:@scope/styles/icon.wasm?url";
  const providerVirtualId = "virtual:mincho-styles";
  const tokensId = "/project/src/tokens.ts";

  function createProviderFromModules(options: {
    modules: readonly ImportedStaticCssEvalLoadedModule[];
    importResolutions: readonly ImportedStaticCssEvalImportResolution[];
    moduleCache?: StaticCssModuleCache;
  }): StaticCssEvalProvider {
    const resolver = new ImportedStaticCssEvalResolver(options);

    return {
      getResolvedCssValue(query) {
        return resolver.resolve(query);
      }
    };
  }

  function createCountingStaticCssModuleCache(): {
    cache: StaticCssModuleCache;
    missesByFile: ReadonlyMap<string, number>;
  } {
    const delegate = createStaticCssModuleCache();
    const seenKeys = new Set<string>();
    const missesByFile = new Map<string, number>();
    const cache: StaticCssModuleCache = {
      getParsedModule(source) {
        const key = formatExportMapCacheKey(createExportMapCacheKey(source));

        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          missesByFile.set(
            source.resolvedFile,
            (missesByFile.get(source.resolvedFile) ?? 0) + 1
          );
        }

        return delegate.getParsedModule(source);
      },
      getExportMap(source) {
        return cache.getParsedModule(source).exportMap;
      },
      getExportMapEntry(source, exportName) {
        return cache.getParsedModule(source).exportMap.get(exportName) ?? null;
      }
    };

    return { cache, missesByFile };
  }

  type ResolvedStaticCssEvalResultWithMetadata = {
    kind: "resolved";
    value: StaticCssLiteral;
    cacheKey: StaticCssEvalCacheKey;
    dependencies: ResolutionDependency[];
  };

  function expectResolvedResult(
    result: StaticCssEvalResult
  ): ResolvedStaticCssEvalResultWithMetadata {
    expect(result.kind).toBe("resolved");

    if (result.kind !== "resolved") {
      throw new Error("Expected static css eval result to resolve");
    }

    if (!("cacheKey" in result)) {
      throw new Error(
        "Expected resolved static css eval result to include cache key"
      );
    }

    if (
      !Array.isArray(result.dependencies) ||
      result.dependencies.some((dependency) => typeof dependency === "string")
    ) {
      throw new Error(
        "Expected resolved static css eval result dependencies metadata"
      );
    }

    return result as ResolvedStaticCssEvalResultWithMetadata;
  }

  function createProvider(
    stylesSource: string,
    ownerSource = `import { button } from "./styles"; <div css={button} />;`,
    barrelSource = `export { button } from "./styles";`,
    extraModules: readonly ImportedStaticCssEvalLoadedModule[] = [],
    extraImportResolutions: readonly ImportedStaticCssEvalImportResolution[] = []
  ): StaticCssEvalProvider {
    return createProviderFromModules({
      modules: [
        { id: ownerId, source: ownerSource },
        { id: stylesId, source: stylesSource },
        {
          id: barrelId,
          source: barrelSource
        },
        ...extraModules
      ],
      importResolutions: [
        { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
        { importerId: ownerId, importPath: "./barrel", resolvedId: barrelId },
        { importerId: barrelId, importPath: "./styles", resolvedId: stylesId },
        ...extraImportResolutions
      ]
    });
  }

  function resolveFixture(
    provider: StaticCssEvalProvider,
    bindingName: string,
    memberPath: string[] = []
  ): StaticCssEvalResult {
    return provider.getResolvedCssValue({
      importerId: ownerId,
      expressionStart: 0,
      expressionEnd: bindingName.length,
      bindingName,
      ...(memberPath.length > 0 ? { memberPath } : {})
    });
  }

  type CjsUnsupportedFixture = {
    readonly stylesSource: string;
    readonly ownerSource: string;
    readonly bindingName: string;
    readonly expectedDiagnosticId: StaticCssEvalDiagnosticId;
    readonly memberPath?: readonly string[];
  };

  function expectCjsUnsupportedFixture(fixture: CjsUnsupportedFixture): void {
    expect(
      resolveFixture(
        createProvider(fixture.stylesSource, fixture.ownerSource),
        fixture.bindingName,
        [...(fixture.memberPath ?? [])]
      )
    ).toMatchObject({
      kind: "error",
      diagnostic: { id: fixture.expectedDiagnosticId }
    });
  }

  function createEsbuildHelperSource(copyPropsSource: string): string {
    return `
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
      };
      ${copyPropsSource}
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    `;
  }

  function createEsbuildCopyPropsHelperSource(): string {
    return `
      var __copyProps = (to, from, except, desc) => {
        if (from && typeof from === "object" || typeof from === "function") {
          for (let key of __getOwnPropNames(from))
            if (!__hasOwnProp.call(to, key) && key !== except)
              __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
        return to;
      };
    `;
  }

  describe("imported static css eval module records", () => {
    it("preserves reference ranges in nested resolution queries", () => {
      const reference = {
        kind: "supported" as const,
        bindingName: "styles",
        memberPath: ["button"],
        expressionStart: 42,
        expressionEnd: 57
      };

      expect(createReferenceQuery(ownerId, reference)).toEqual({
        importerId: ownerId,
        expressionStart: 42,
        expressionEnd: 57,
        bindingName: "styles",
        memberPath: ["button"]
      });
    });

    it("preserves watch files when resolution dependencies merge", () => {
      const state: ImportedStaticCssEvalResolutionState = {
        owner: { file: ownerId },
        dependencies: new Map(),
        resolutionChain: [],
        stack: []
      };
      const dependency = {
        file: stylesId,
        kind: "imported",
        importer: ownerId,
        specifier: "./styles",
        exportName: "button",
        memberPath: [],
        inspected: true,
        contributed: true,
        sourceKind: "project-source",
        sourceOrigin: "project",
        canonicalModuleId: "project:styles",
        normalizedPathKey: "/project/src/styles.ts",
        watchFiles: ["/project/.pnp.cjs"],
        unsupportedReason: "unresolved"
      } satisfies ResolutionDependency;

      addResolutionDependency(state, dependency);
      addResolutionDependency(state, {
        ...dependency,
        sourceKind: undefined,
        sourceOrigin: undefined,
        canonicalModuleId: undefined,
        normalizedPathKey: undefined,
        watchFiles: undefined,
        unsupportedReason: undefined
      });

      expect(getResolutionDependencies(state)).toEqual([
        expect.objectContaining({
          sourceKind: "project-source",
          sourceOrigin: "project",
          canonicalModuleId: "project:styles",
          normalizedPathKey: "/project/src/styles.ts",
          watchFiles: ["/project/.pnp.cjs"],
          unsupportedReason: "unresolved"
        })
      ]);
    });

    it("matches parser plugins to the loaded module extension", () => {
      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.ts",
          source: `export const value = <number>1;`
        })
      ).not.toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.js",
          source: `export const value: number = 1;`
        })
      ).toThrow();

      expect(() =>
        createImportedStaticCssEvalModuleRecord({
          id: "/project/src/styles.jsx",
          source: `export const value = <div />;`
        })
      ).not.toThrow();
    });

    it("derives matching module and cache hashes from inline source content", () => {
      const red = createImportedStaticCssEvalModuleRecord({
        id: stylesId,
        source: `export const value = "red";`
      });
      const sky = createImportedStaticCssEvalModuleRecord({
        id: stylesId,
        source: `export const value = "sky";`
      });

      expect(red.sourceHash).toMatch(/^inline:[a-z0-9]+$/);
      expect(red.sourceHash).toBe(red.parsedModule.sourceHash);
      expect(red.sourceHash).not.toBe(sky.sourceHash);
    });

    it("reports imported module parse failures in unresolved diagnostics", () => {
      expect(
        resolveFixture(createProvider(`export const button = {`), "button")
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          message: expect.stringMatching(
            /Unexpected token|Unexpected end of input/
          )
        }
      });
    });

    it("preserves non-Error imported module parse failures", () => {
      const parseFailure = "synthetic parse failure";
      const delegate = createStaticCssModuleCache();
      const moduleCache: StaticCssModuleCache = {
        ...delegate,
        getParsedModule(source) {
          if (source.resolvedFile === stylesId) {
            throw parseFailure;
          }

          return delegate.getParsedModule(source);
        }
      };
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import { button } from "./styles"; <div css={button} />;`
          },
          {
            id: stylesId,
            source: `export const button = { color: "red" } as const;`
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId }
        ],
        moduleCache
      });

      expect(resolveFixture(provider, "button")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          message: expect.stringContaining(parseFailure)
        }
      });
    });

    it("collects literal CommonJS require bindings into module records", () => {
      const record = createImportedStaticCssEvalModuleRecord({
        id: ownerId,
        source: `
          import type { ThemeTokens } from "./styles";

          const styles = require("./styles");
          const memberButton = require("./styles").button;
          const memberDefault = require("./styles").default;
          const { button, card: cardStyle } = require("./styles");
        `
      });

      expect(record.imports.has("ThemeTokens")).toBe(false);
      expect([...record.cjsImports.entries()]).toEqual([
        [
          "styles",
          {
            kind: "cjs-module",
            localName: "styles",
            importPath: "./styles",
            propertyPath: []
          }
        ],
        [
          "memberButton",
          {
            kind: "cjs-member",
            localName: "memberButton",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "memberDefault",
          {
            kind: "cjs-member",
            localName: "memberDefault",
            importPath: "./styles",
            propertyPath: ["default"]
          }
        ],
        [
          "button",
          {
            kind: "cjs-destructured",
            localName: "button",
            importPath: "./styles",
            propertyPath: ["button"]
          }
        ],
        [
          "cardStyle",
          {
            kind: "cjs-destructured",
            localName: "cardStyle",
            importPath: "./styles",
            propertyPath: ["card"]
          }
        ]
      ]);
    });

    it("ignores literal CommonJS require when require is locally bound", () => {
      const record = createImportedStaticCssEvalModuleRecord({
        id: ownerId,
        source: `const require = makeRequire(); const styles = require("./styles");`
      });
      const provider = createProvider(
        `export const button = { color: "red" } as const;`,
        `const require = makeRequire(); const styles = require("./styles"); <div css={styles.button} />;`
      );

      expect(record.cjsImports.has("styles")).toBe(false);
      expect(resolveFixture(provider, "styles", ["button"])).toEqual({
        kind: "not-candidate"
      });
    });

    it("resolves named, aliased, default object, default const, and same-module export aliases", () => {
      expect(
        resolveFixture(
          createProvider(`export const button = { color: "red" } as const;`),
          "button"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: { kind: "imported", file: stylesId, exportName: "button" },
        dependencies: [
          {
            file: stylesId,
            kind: "imported",
            importer: ownerId,
            specifier: "./styles",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button as buttonStyle } from "./styles"; <div css={buttonStyle} />;`
          ),
          "buttonStyle"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });

      expect(
        resolveFixture(
          createProvider(
            `export default { color: "blue" } as const;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const button = { color: "green" } as const; export default button;`,
            `import styles from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });

      expect(
        resolveFixture(
          createProvider(
            `const x = { color: "orange" } as const; export { x as y };`,
            `import { y } from "./styles"; <div css={y} />;`
          ),
          "y"
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "orange" }
      });
    });

    it("resolves nested member paths over imported static objects", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const styles = { button: { primary: { color: "red" } } } as const;`,
            `import { styles } from "./styles"; <div css={styles.button.primary} />;`
          ),
          "styles",
          ["button", "primary"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
    });

    it("resolves imported static css eval spreads from same-module and imported operands", () => {
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import { button, rule } from "./styles";
              <><div css={button} /><div css={rule} /></>;
            `
          },
          {
            id: stylesId,
            source: `
              import { base, stack } from "./tokens";
              const localBase = { color: "red", padding: 4 } as const;
              const localStack = [{ display: "grid" }] as const;
              export const button = { ...localBase, ...base, color: "blue" } as const;
              export const rule = [...localStack, ...stack, { gap: 8 }] as const;
            `
          },
          {
            id: tokensId,
            source: `
              export const base = { color: "green", margin: 2 } as const;
              export const stack = [{ alignItems: "center" }] as const;
            `
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
          { importerId: stylesId, importPath: "./tokens", resolvedId: tokensId }
        ]
      });

      const button = expectResolvedResult(resolveFixture(provider, "button"));
      const rule = expectResolvedResult(resolveFixture(provider, "rule"));

      expect(button.value).toEqual({
        color: "blue",
        margin: 2,
        padding: 4
      });
      expect(rule.value).toEqual([
        { display: "grid" },
        { alignItems: "center" },
        { gap: 8 }
      ]);
      expect(button.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stylesId,
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: tokensId,
            inspected: true,
            contributed: true,
            exportName: "base"
          })
        ])
      );
      expect(rule.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: tokensId,
            inspected: true,
            contributed: true,
            exportName: "stack"
          })
        ])
      );
    });

    it("resolves imported static css eval identifier and namespace member operands", () => {
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import { button } from "./styles"; <div css={button} />;`
          },
          {
            id: stylesId,
            source: `
              import * as tokens from "./tokens";
              const localColor = "red";
              export const button = {
                color: localColor,
                backgroundColor: tokens.colors.primary,
                padding: tokens.space
              } as const;
            `
          },
          {
            id: tokensId,
            source: `
              export const colors = { primary: "blue" } as const;
              export const space = 6;
            `
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
          { importerId: stylesId, importPath: "./tokens", resolvedId: tokensId }
        ]
      });

      const result = expectResolvedResult(resolveFixture(provider, "button"));

      expect(result.value).toEqual({
        backgroundColor: "blue",
        color: "red",
        padding: 6
      });
      expect(result.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: tokensId,
            kind: "namespace-member",
            exportName: "colors",
            memberPath: ["primary"],
            inspected: true,
            contributed: true
          }),
          expect.objectContaining({
            file: tokensId,
            kind: "namespace-member",
            exportName: "space",
            memberPath: [],
            inspected: true,
            contributed: true
          })
        ])
      );
    });

    it("resolves imported static css eval computed optional and template operands", () => {
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import { button } from "./styles"; <div css={button} />;`
          },
          {
            id: stylesId,
            source: `
              import {
                backgroundKey,
                brand,
                enabled,
                empty,
                indexKey,
                palette,
                stateKey
              } from "./tokens";

              const colorKey = "color";
              const styles = {
                button: { color: "base" },
                states: { hover: { color: "hover" } },
                cards: [{ color: "from-array" }]
              } as const;

              export const button = {
                [colorKey]: \`\${brand}-\${2}-\${enabled}-\${empty}\`,
                [backgroundKey]: palette?.primary,
                duplicate: "first",
                ["duplicate"]: "last",
                nested: styles["button"][colorKey],
                state: styles?.states?.[stateKey]?.color,
                fromArray: styles.cards?.[indexKey]?.color
              } as const;
            `
          },
          {
            id: tokensId,
            source: `
              export const backgroundKey = "backgroundColor";
              export const brand = "brand";
              export const enabled = true;
              export const empty = null;
              export const indexKey = 0;
              export const palette = { primary: "blue" } as const;
              export const stateKey = "hover";
            `
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId },
          { importerId: stylesId, importPath: "./tokens", resolvedId: tokensId }
        ]
      });

      const result = expectResolvedResult(resolveFixture(provider, "button"));

      expect(result.value).toEqual({
        color: "brand-2-true-null",
        backgroundColor: "blue",
        duplicate: "last",
        nested: "base",
        state: "hover",
        fromArray: "from-array"
      });
      expect(result.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: tokensId,
            exportName: "backgroundKey",
            contributed: true
          }),
          expect.objectContaining({
            file: tokensId,
            exportName: "palette",
            contributed: true
          }),
          expect.objectContaining({
            file: tokensId,
            exportName: "brand",
            contributed: true
          })
        ])
      );
    });

    it("rejects non-canonical imported array member names", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: ["red", "blue"]["01"] } as const;`,
          `import { button } from "./styles"; <div css={button} />;`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
        }
      });
    });

    it("resolves namespace export-star computed optional imported static css eval operands", () => {
      const provider = createProvider(
        `
          import { colorKey, palette } from "./tokens";
          export const button = { [colorKey]: palette?.primary } as const;
        `,
        `import * as styles from "./barrel"; <div css={styles.button} />;`,
        `export * from "./styles";`,
        [
          {
            id: tokensId,
            source: `
              export const colorKey = "color";
              export const palette = { primary: "red" } as const;
            `
          }
        ],
        [{ importerId: stylesId, importPath: "./tokens", resolvedId: tokensId }]
      );

      expect(resolveFixture(provider, "styles", ["button"])).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: expect.arrayContaining([
          expect.objectContaining({ file: barrelId, contributed: true }),
          expect.objectContaining({ file: stylesId, contributed: true }),
          expect.objectContaining({ file: tokensId, contributed: true })
        ])
      });
    });

    it("resolves package data virtual and CommonJS operands through the expanded literal grammar", () => {
      const packageProvider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import { button } from "@scope/styles"; <div css={button} />;`
          },
          {
            id: packageBarrelId,
            source: `export { button } from "@scope/styles/leaf";`,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            id: packageLeafId,
            source: `
              import { base, colorKey, tone } from "@scope/styles/tokens";
              import virtualTokens from "virtual:mincho-styles";
              const accentKey = "accent";
              export const button = {
                ...base,
                [colorKey]: \`\${tone}-\${virtualTokens?.accent}\`,
                [accentKey]: virtualTokens?.accent
              } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            id: packageDataId,
            source: `
              export const base = { padding: 4 } as const;
              export const colorKey = "color";
              export const tone = "green";
            `,
            sourceKind: "static-data",
            sourceOrigin: "data"
          },
          {
            id: providerVirtualId,
            source: `export default { accent: "purple" } as const;`,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider"
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/styles",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/leaf",
            resolvedId: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            importerId: packageLeafId,
            importPath: "@scope/styles/tokens",
            resolvedId: packageDataId,
            sourceKind: "static-data",
            sourceOrigin: "data"
          },
          {
            importerId: packageLeafId,
            importPath: "virtual:mincho-styles",
            resolvedId: providerVirtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider"
          }
        ]
      });
      const cjsProvider = createProvider(
        `
          const tokens = require("./tokens");
          exports.button = {
            [tokens.colorKey]: \`\${tokens.color}-\${tokens.palette?.primary}\`,
            padding: tokens.space?.[0]
          };
        `,
        `const styles = require("./styles"); <div css={styles.button} />;`,
        `export { button } from "./styles";`,
        [
          {
            id: tokensId,
            source: `
              export const colorKey = "color";
              export const color = "red";
              export const palette = { primary: "blue" } as const;
              export const space = [4] as const;
            `
          }
        ],
        [{ importerId: stylesId, importPath: "./tokens", resolvedId: tokensId }]
      );

      const packageResult = expectResolvedResult(
        resolveFixture(packageProvider, "button")
      );
      const cjsResult = expectResolvedResult(
        resolveFixture(cjsProvider, "styles", ["button"])
      );

      expect(packageResult.value).toEqual({
        padding: 4,
        color: "green-purple",
        accent: "purple"
      });
      expect(packageResult.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: packageDataId, contributed: true }),
          expect.objectContaining({
            file: providerVirtualId,
            contributed: true
          })
        ])
      );
      expect(cjsResult.value).toEqual({ color: "red-blue", padding: 4 });
      expect(cjsResult.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: stylesId, contributed: true }),
          expect.objectContaining({ file: tokensId, contributed: true })
        ])
      );
    });

    it("resolves direct named reexport chains with inspected dependency metadata", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("resolves named reexport through export star barrel with dependency metadata", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./styles";`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("resolves namespace members through export star barrels", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import * as styles from "./barrel"; <div css={styles.button} />;`,
          `export * from "./styles";`
        ),
        "styles",
        ["button"]
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        dependencies: [
          {
            file: barrelId,
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("keeps export star default semantics ESM-accurate for namespace members", () => {
      expect(
        resolveFixture(
          createProvider(
            `export default { color: "red" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.default} />;`,
            `export * from "./styles";`
          ),
          "styles",
          ["default"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT",
          exportName: "default"
        },
        dependencies: [{ file: barrelId, inspected: true, contributed: false }]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.default} />;`,
            `export default { color: "blue" } as const; export * from "./styles";`
          ),
          "styles",
          ["default"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `export default { color: "green" } as const;`,
            `import * as styles from "./barrel"; <div css={styles.root} />;`,
            `export { default as root } from "./styles"; export * from "./styles";`
          ),
          "styles",
          ["root"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "green" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "default",
          reexportName: "root"
        }
      });
    });

    it("resolves package provider named default namespace reexport export-star json raw and wasm imports", () => {
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import rootDefault, { button, dataToken } from "@scope/styles";
              import * as styles from "@scope/styles";
              import theme, { jsonButton } from "@scope/styles/theme.json";
              import rawToken from "@scope/styles/tokens.css?raw";
              import wasmUrl from "@scope/styles/icon.wasm?url";
              import virtualDefault from "virtual:mincho-styles";
              <>
                <div css={button} />
                <div css={rootDefault} />
                <div css={dataToken} />
                <div css={styles.reexported} />
                <div css={styles.default} />
                <div css={jsonButton} />
                <div css={theme.card} />
                <div css={rawToken} />
                <div css={wasmUrl} />
                <div css={virtualDefault} />
              </>;
            `
          },
          {
            id: packageBarrelId,
            source: `
              export { default, button as reexported } from "@scope/styles/leaf";
              export * from "@scope/styles/leaf";
              export * from "@scope/styles/tokens";
            `,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles",
            normalizedPathKey: packageBarrelId,
            watchFiles: ["/project/node_modules/@scope/styles/package.json"]
          },
          {
            id: packageLeafId,
            source: `
              export const button = { color: "red" } as const;
              export default { color: "blue" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf",
            normalizedPathKey: packageLeafId
          },
          {
            id: packageDataId,
            source: `export const dataToken = { color: "green" } as const;`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/tokens",
            normalizedPathKey: packageDataId
          },
          {
            id: packageJsonId,
            source: `
              export default { card: { color: "orange" } } as const;
              export const jsonButton = { color: "cyan" } as const;
            `,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/theme",
            normalizedPathKey: packageJsonId
          },
          {
            id: packageRawId,
            source: `export default "tomato";`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "raw:@scope/styles/tokens",
            normalizedPathKey: packageRawId
          },
          {
            id: packageWasmUrlId,
            source: `export default "/assets/icon.wasm";`,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "wasm-url:@scope/styles/icon",
            normalizedPathKey: packageWasmUrlId
          },
          {
            id: providerVirtualId,
            source: `export default { color: "purple" } as const;`,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: providerVirtualId,
            normalizedPathKey: providerVirtualId
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/styles",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles",
            normalizedPathKey: packageBarrelId
          },
          {
            importerId: ownerId,
            importPath: "virtual:mincho-styles",
            resolvedId: providerVirtualId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: providerVirtualId,
            normalizedPathKey: providerVirtualId
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/leaf",
            resolvedId: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf",
            normalizedPathKey: packageLeafId
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/tokens",
            resolvedId: packageDataId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/tokens",
            normalizedPathKey: packageDataId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/theme.json",
            resolvedId: packageJsonId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "json:@scope/styles/theme",
            normalizedPathKey: packageJsonId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/tokens.css?raw",
            resolvedId: packageRawId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "raw:@scope/styles/tokens",
            normalizedPathKey: packageRawId
          },
          {
            importerId: ownerId,
            importPath: "@scope/styles/icon.wasm?url",
            resolvedId: packageWasmUrlId,
            sourceKind: "static-data",
            sourceOrigin: "data",
            canonicalModuleId: "wasm-url:@scope/styles/icon",
            normalizedPathKey: packageWasmUrlId
          }
        ]
      });
      const buttonResult = expectResolvedResult(
        resolveFixture(provider, "button")
      );

      expect(buttonResult.value).toEqual({ color: "red" });
      expect(resolveFixture(provider, "rootDefault")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });
      expect(resolveFixture(provider, "dataToken")).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });
      expect(resolveFixture(provider, "styles", ["reexported"])).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
      expect(resolveFixture(provider, "styles", ["default"])).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });
      expect(resolveFixture(provider, "jsonButton")).toMatchObject({
        kind: "resolved",
        value: { color: "cyan" }
      });
      expect(resolveFixture(provider, "theme", ["card"])).toMatchObject({
        kind: "resolved",
        value: { color: "orange" }
      });
      expect(resolveFixture(provider, "rawToken")).toMatchObject({
        kind: "resolved",
        value: "tomato"
      });
      expect(resolveFixture(provider, "wasmUrl")).toMatchObject({
        kind: "resolved",
        value: "/assets/icon.wasm"
      });
      expect(resolveFixture(provider, "virtualDefault")).toMatchObject({
        kind: "resolved",
        value: { color: "purple" }
      });
      expect(buttonResult.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles"
          }),
          expect.objectContaining({
            file: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package",
            canonicalModuleId: "npm:@scope/styles/leaf"
          })
        ])
      );
      expect(buttonResult.cacheKey).toMatchObject({
        resolvedFile: packageLeafId,
        sourceKind: "package-source",
        sourceOrigin: "package",
        canonicalModuleId: "npm:@scope/styles/leaf",
        normalizedPathKey: packageLeafId
      });
    });

    it("resolves package whole namespace imports only when every export is static", () => {
      const staticNamespaceProvider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import * as styles from "@scope/namespace"; <div css={styles} />;`
          },
          {
            id: packageBarrelId,
            source: `
              export { default } from "@scope/styles/leaf";
              export * from "@scope/styles/leaf";
              export const card = { color: "green" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            id: packageLeafId,
            source: `
              export const button = { color: "red" } as const;
              export default { color: "blue" } as const;
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/namespace",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          },
          {
            importerId: packageBarrelId,
            importPath: "@scope/styles/leaf",
            resolvedId: packageLeafId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ]
      });
      const nonStaticNamespaceProvider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `import * as styles from "@scope/namespace"; <div css={styles} />;`
          },
          {
            id: packageBarrelId,
            source: `
              export const button = { color: "red" } as const;
              export const dynamic = createStyle();
            `,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/namespace",
            resolvedId: packageBarrelId,
            sourceKind: "package-source",
            sourceOrigin: "package"
          }
        ]
      });

      expect(resolveFixture(staticNamespaceProvider, "styles")).toMatchObject({
        kind: "resolved",
        value: {
          default: { color: "blue" },
          button: { color: "red" },
          card: { color: "green" }
        }
      });
      expect(
        resolveFixture(nonStaticNamespaceProvider, "styles")
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_NAMESPACE_PARTIAL_UNSUPPORTED",
          code: "unsupported-source",
          reason: "partial-namespace-failure",
          dependency: { file: packageBarrelId },
          importPath: "@scope/namespace",
          exportName: "dynamic"
        }
      });
    });

    it("preserves special property names on imported object literals", () => {
      const result = expectResolvedResult(
        resolveFixture(
          createProvider(
            `export const styles = { __proto__: { color: "red" }, constructor: { color: "blue" } } as const;`,
            `import { styles } from "./styles"; <div css={styles} />;`
          ),
          "styles"
        )
      );

      if (
        result.value === null ||
        typeof result.value !== "object" ||
        Array.isArray(result.value)
      ) {
        throw new TypeError("expected a static object literal");
      }

      expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
      expect(Object.keys(result.value)).toContain("__proto__");
    });

    it("rejects unsupported provider source kinds with source metadata", () => {
      const unresolvedId = "unresolved:@scope/missing";
      const externalId = "external:@scope/external";
      const virtualNoSourceId = "virtual:missing-styles";
      const unsupportedShapeId = "unsupported:@scope/runtime";
      const wasmRuntimeId = "unsupported:@scope/wasm-init";
      const nonLiteralLoaderId = "unsupported:@scope/nonliteral";
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import { button as externalButton } from "@scope/external";
              import { button as unresolvedButton } from "@scope/missing";
              import virtualStyles from "virtual:missing-styles";
              import { button as runtimeButton } from "@scope/runtime";
              import wasmInit from "@scope/wasm-init";
              import nonLiteral from "@scope/nonliteral";
              <>
                <div css={externalButton} />
                <div css={unresolvedButton} />
                <div css={virtualStyles} />
                <div css={runtimeButton} />
                <div css={wasmInit} />
                <div css={nonLiteral} />
              </>;
            `
          }
        ],
        importResolutions: [
          {
            importerId: ownerId,
            importPath: "@scope/external",
            resolvedId: externalId,
            sourceKind: "external-no-source",
            sourceOrigin: "external",
            unsupportedReason: "external-no-source",
            canonicalModuleId: "npm:@scope/external",
            normalizedPathKey: externalId,
            watchFiles: ["/project/package.json"]
          },
          {
            importerId: ownerId,
            importPath: "@scope/missing",
            resolvedId: unresolvedId,
            sourceKind: "unresolved",
            sourceOrigin: "unresolved",
            unsupportedReason: "unresolved",
            canonicalModuleId: "npm:@scope/missing",
            normalizedPathKey: unresolvedId
          },
          {
            importerId: ownerId,
            importPath: "virtual:missing-styles",
            resolvedId: virtualNoSourceId,
            sourceKind: "provider-virtual",
            sourceOrigin: "provider",
            canonicalModuleId: virtualNoSourceId,
            normalizedPathKey: virtualNoSourceId
          },
          {
            importerId: ownerId,
            importPath: "@scope/runtime",
            resolvedId: unsupportedShapeId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "unsupported-source-shape",
            canonicalModuleId: "npm:@scope/runtime",
            normalizedPathKey: unsupportedShapeId
          },
          {
            importerId: ownerId,
            importPath: "@scope/wasm-init",
            resolvedId: wasmRuntimeId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "runtime-wasm-init-or-function",
            canonicalModuleId: "npm:@scope/wasm-init",
            normalizedPathKey: wasmRuntimeId
          },
          {
            importerId: ownerId,
            importPath: "@scope/nonliteral",
            resolvedId: nonLiteralLoaderId,
            sourceKind: "unsupported-source-shape",
            sourceOrigin: "unsupported",
            unsupportedReason: "non-literal-loader-output",
            canonicalModuleId: "npm:@scope/nonliteral",
            normalizedPathKey: nonLiteralLoaderId
          }
        ]
      });

      const externalResult = resolveFixture(provider, "externalButton");

      expect(externalResult).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "external-no-source",
          dependency: { file: externalId },
          importPath: "@scope/external",
          exportName: "button"
        },
        dependencies: [
          expect.objectContaining({
            file: externalId,
            sourceKind: "external-no-source",
            sourceOrigin: "external",
            unsupportedReason: "external-no-source",
            canonicalModuleId: "npm:@scope/external",
            normalizedPathKey: externalId,
            watchFiles: ["/project/package.json"],
            inspected: true,
            contributed: false
          })
        ]
      });
      expect(resolveFixture(provider, "unresolvedButton")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          code: "unsupported-source",
          reason: "failed-project-local-dependency",
          dependency: { file: unresolvedId },
          importPath: "@scope/missing"
        }
      });
      const virtualResult = resolveFixture(provider, "virtualStyles");
      expect(virtualResult).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "provider-virtual-no-source",
          dependency: { file: virtualNoSourceId },
          importPath: "virtual:missing-styles"
        }
      });
      expect(resolveFixture(provider, "runtimeButton")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          code: "unsupported-source",
          reason: "unsupported-source-shape",
          dependency: { file: unsupportedShapeId },
          importPath: "@scope/runtime"
        }
      });
      expect(resolveFixture(provider, "wasmInit")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: "runtime-wasm-init-or-function",
          dependency: { file: wasmRuntimeId },
          importPath: "@scope/wasm-init"
        }
      });
      expect(resolveFixture(provider, "nonLiteral")).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_PROVIDER_SOURCE_UNSUPPORTED",
          reason: "non-literal-loader-output",
          dependency: { file: nonLiteralLoaderId },
          importPath: "@scope/nonliteral"
        }
      });
      expect(
        externalResult.kind === "error" ? externalResult.diagnostic.message : ""
      ).toContain(
        'Cannot statically evaluate css prop value: external module "external:@scope/external" has no provider source'
      );
      expect(
        virtualResult.kind === "error" ? virtualResult.diagnostic.message : ""
      ).toContain(
        'Cannot statically evaluate css prop value: provider virtual module "virtual:missing-styles" has no source from the bundler provider'
      );
    });

    it("lets explicit direct exports override same-named export star candidates", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./button"; export { button } from "./styles";`,
          [
            {
              id: buttonId,
              source: `export const button = { color: "blue" } as const;`
            }
          ],
          [
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            }
          ]
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        dependencies: [
          { file: barrelId, inspected: true, contributed: true },
          { file: stylesId, inspected: true, contributed: true }
        ]
      });
      expect(result.kind === "resolved" ? result.dependencies : []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ file: buttonId })])
      );
    });

    it("reports ambiguous export star conflict without choosing a candidate", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { button } from "./barrel"; <div css={button} />;`,
          `export * from "./styles"; export * from "./button";`,
          [
            {
              id: buttonId,
              source: `export const button = { color: "blue" } as const;`
            }
          ],
          [
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            }
          ]
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_EXPORT_STAR_AMBIGUOUS",
          reason: "ambiguous-star",
          exportName: "button",
          dependency: { file: barrelId },
          importChain: expect.arrayContaining([
            expect.stringContaining(`${stylesId}#button`),
            expect.stringContaining(`${buttonId}#button`)
          ])
        },
        dependencies: [
          { file: barrelId, inspected: true, contributed: false },
          { file: stylesId, inspected: true, contributed: false },
          { file: buttonId, inspected: true, contributed: false }
        ]
      });
      expect(
        result.kind === "error" ? result.diagnostic.message : ""
      ).toContain("ambiguous");
    });

    it("rejects dynamic import values with precise diagnostics", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = import("./styles");`,
          `import { button } from "./styles"; <div css={button} />;`
        ),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-syntax",
          reason: "dynamic-import",
          dependency: { file: stylesId },
          importPath: "./styles",
          exportName: "button"
        }
      });
      expect(result.kind === "error" ? result.diagnostic.message : "").toBe(
        'Cannot statically evaluate css prop value: imported export "button" contains a dynamic import'
      );
    });

    it("classifies native import expressions as dynamic imports", () => {
      expect(
        getUnsupportedLiteralReason(
          t.importExpression(t.stringLiteral("./styles"))
        )
      ).toBe("dynamic-import");
    });

    it("rejects imported static css eval wrong-shape spread operands", () => {
      expect(
        resolveFixture(
          createProvider(
            `
              import { baseArray } from "./tokens";
              export const button = { ...baseArray } as const;
            `,
            `import { button } from "./styles"; <div css={button} />;`,
            `export { button } from "./styles";`,
            [
              {
                id: tokensId,
                source: `export const baseArray = [{ color: "red" }] as const;`
              }
            ],
            [
              {
                importerId: stylesId,
                importPath: "./tokens",
                resolvedId: tokensId
              }
            ]
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(
            `
              import { baseObject } from "./tokens";
              export const rule = [...baseObject] as const;
            `,
            `import { rule } from "./styles"; <div css={rule} />;`,
            `export { rule } from "./styles";`,
            [
              {
                id: tokensId,
                source: `export const baseObject = { color: "blue" } as const;`
              }
            ],
            [
              {
                importerId: stylesId,
                importPath: "./tokens",
                resolvedId: tokensId
              }
            ]
          ),
          "rule"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_OBJECT_SPREAD_UNSUPPORTED" }
      });
    });

    it("rejects imported static css eval mutated unresolved and dynamic operands", () => {
      expect(
        resolveFixture(
          createProvider(`
            let base = { color: "red" };
            export const button = { ...base } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_MUTABLE_BINDING" }
      });
      expect(
        resolveFixture(
          createProvider(`
            const base = { color: "red" } as const;
            base.color = "blue";
            export const button = { ...base } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_MUTATED_BINDING" }
      });
      expect(
        resolveFixture(
          createProvider(
            `
              const tokenName = getTokenName();
              export const button = { [tokenName]: "red" } as const;
            `,
            `import { button } from "./styles"; <div css={button} />;`,
            `export { button } from "./styles";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(
            `
              import * as tokens from "./tokens";
              const tokenName = getTokenName();
              export const button = { color: tokens[tokenName] } as const;
            `,
            `import { button } from "./styles"; <div css={button} />;`,
            `export { button } from "./styles";`,
            [{ id: tokensId, source: `export const primary = "red";` }],
            [
              {
                importerId: stylesId,
                importPath: "./tokens",
                resolvedId: tokensId
              }
            ]
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(
            `
              import * as tokens from "./tokens";
              export const button = { color: tokens?.primary?.() } as const;
            `,
            `import { button } from "./styles"; <div css={button} />;`,
            `export { button } from "./styles";`,
            [{ id: tokensId, source: `export const primary = "red";` }],
            [
              {
                importerId: stylesId,
                importPath: "./tokens",
                resolvedId: tokensId
              }
            ]
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { reason: "function-or-call" }
      });
      expect(
        resolveFixture(
          createProvider(`
            const maybe = null;
            export const button = maybe?.card;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(`
            const palette = { primary: "red" } as const;
            export const button = { color: \`\${palette}\` } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(`
            const getColor = () => "red";
            export const button = { color: \`\${getColor}\` } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { reason: "function-or-call" }
      });
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: \`\${getColor()}\` } as const;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { reason: "function-or-call" }
      });
      expect(
        resolveFixture(
          createProvider(`
            import { base } from "pkg";
            export const button = { ...base } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT" }
      });
      expect(
        resolveFixture(
          createProvider(`
            const tokens = require(name);
            export const button = { ...tokens.base } as const;
          `),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: { id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED" }
      });
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: getColor() } as const;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          code: "unsupported-syntax",
          reason: "function-or-call"
        }
      });
    });

    it("terminates export star reexport cycles with deterministic diagnostics", () => {
      const result = resolveFixture(
        createProviderFromModules({
          modules: [
            {
              id: ownerId,
              source: `import { button } from "./barrel"; <div css={button} />;`
            },
            { id: barrelId, source: `export * from "./button";` },
            { id: buttonId, source: `export * from "./barrel";` }
          ],
          importResolutions: [
            {
              importerId: ownerId,
              importPath: "./barrel",
              resolvedId: barrelId
            },
            {
              importerId: barrelId,
              importPath: "./button",
              resolvedId: buttonId
            },
            {
              importerId: buttonId,
              importPath: "./barrel",
              resolvedId: barrelId
            }
          ]
        }),
        "button"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_IMPORT_CYCLE",
          exportName: "button"
        },
        dependencies: expect.arrayContaining([
          expect.objectContaining({ file: barrelId, inspected: true }),
          expect.objectContaining({ file: buttonId, inspected: true })
        ])
      });
    });

    it("parses one imported source identity once for repeated binding resolutions", () => {
      const { cache, missesByFile } = createCountingStaticCssModuleCache();
      const provider = createProviderFromModules({
        modules: [
          {
            id: ownerId,
            source: `
              import { button, card, banner } from "./styles";
              <>
                <div css={button} />
                <div css={card} />
                <div css={banner} />
                <div css={button} />
              </>;
            `,
            sourceHash: "hash:owner-v1",
            version: "owner-v1"
          },
          {
            id: stylesId,
            source: `
              export const button = { color: "red" } as const;
              export const card = { color: "blue" } as const;
              export const banner = { color: "green" } as const;
            `,
            sourceHash: "hash:styles-v1",
            version: "styles-v1"
          }
        ],
        importResolutions: [
          { importerId: ownerId, importPath: "./styles", resolvedId: stylesId }
        ],
        moduleCache: cache
      });

      const button = expectResolvedResult(resolveFixture(provider, "button"));
      const card = expectResolvedResult(resolveFixture(provider, "card"));
      const banner = expectResolvedResult(resolveFixture(provider, "banner"));
      const repeatedButton = expectResolvedResult(
        resolveFixture(provider, "button")
      );

      expect(button.value).toEqual({ color: "red" });
      expect(card.value).toEqual({ color: "blue" });
      expect(banner.value).toEqual({ color: "green" });
      expect(repeatedButton.value).toEqual({ color: "red" });
      expect(missesByFile.get(stylesId)).toBe(1);
      expect(missesByFile.get(ownerId)).toBe(1);
      expect(
        [button, card, banner, repeatedButton].map((result) => ({
          resolvedFile: result.cacheKey.resolvedFile,
          sourceHash: result.cacheKey.sourceHash,
          sourceVersion: result.cacheKey.sourceVersion,
          pluginOptionsVersion: result.cacheKey.pluginOptionsVersion,
          resolverOptionsVersion: result.cacheKey.resolverOptionsVersion,
          parserVersion: result.cacheKey.parserVersion,
          staticEvalSupportVersion: result.cacheKey.staticEvalSupportVersion
        }))
      ).toEqual([
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        },
        {
          resolvedFile: stylesId,
          sourceHash: "hash:styles-v1",
          sourceVersion: "styles-v1",
          pluginOptionsVersion: "static-css-eval-provider:v1",
          resolverOptionsVersion: "static-css-eval-provider:v1",
          parserVersion: STATIC_CSS_MODULE_CACHE_PARSER_VERSION,
          staticEvalSupportVersion: STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION
        }
      ]);
    });

    it("normalizes direct imports and direct reexports to the same terminal dependency file", () => {
      const directResult = expectResolvedResult(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      );
      const reexportResult = expectResolvedResult(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "./barrel"; <div css={button} />;`
          ),
          "button"
        )
      );
      const directDependency = directResult.dependencies.find(
        (dependency) => dependency.file === stylesId
      );
      const reexportDependency = reexportResult.dependencies.find(
        (dependency) => dependency.file === stylesId
      );

      expect(directDependency).toMatchObject({
        file: stylesId,
        kind: "imported"
      });
      expect(reexportDependency).toMatchObject({
        file: stylesId,
        kind: "reexported"
      });
      expect(directResult.cacheKey.resolvedFile).toBe(stylesId);
      expect(reexportResult.cacheKey.resolvedFile).toBe(stylesId);
      expect(directResult.cacheKey.resolvedId).toBe(
        reexportResult.cacheKey.resolvedId
      );
    });

    it("changes cache identity when imported source content identity changes", () => {
      const createVersionedProvider = (
        source: string,
        sourceHash: string,
        version: string
      ) =>
        createProviderFromModules({
          modules: [
            {
              id: ownerId,
              source: `import { button } from "./styles"; <div css={button} />;`
            },
            { id: stylesId, source, sourceHash, version }
          ],
          importResolutions: [
            {
              importerId: ownerId,
              importPath: "./styles",
              resolvedId: stylesId
            }
          ]
        });
      const red = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const button = { color: "red" } as const;`,
            "hash:styles-red",
            "styles-red"
          ),
          "button"
        )
      );
      const blue = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const button = { color: "blue" } as const;`,
            "hash:styles-blue",
            "styles-blue"
          ),
          "button"
        )
      );

      expect(red.value).toEqual({ color: "red" });
      expect(blue.value).toEqual({ color: "blue" });
      expect(red.cacheKey.resolvedFile).toBe(blue.cacheKey.resolvedFile);
      expect(red.cacheKey.sourceHash).toBe("hash:styles-red");
      expect(blue.cacheKey.sourceHash).toBe("hash:styles-blue");
      expect(red.cacheKey.sourceVersion).toBe("styles-red");
      expect(blue.cacheKey.sourceVersion).toBe("styles-blue");
      expect(red.cacheKey).not.toEqual(blue.cacheKey);
    });

    it("changes imported operand cache identity and static support version for expanded literals", () => {
      const { cache, missesByFile } = createCountingStaticCssModuleCache();
      const createVersionedProvider = (
        tokenSource: string,
        tokenHash: string,
        tokenVersion: string
      ) =>
        createProviderFromModules({
          modules: [
            {
              id: ownerId,
              source: `import { button } from "./styles"; <div css={button} />;`,
              sourceHash: "hash:owner-v1",
              version: "owner-v1"
            },
            {
              id: stylesId,
              source: `import { base } from "./tokens"; export const button = { ...base } as const;`,
              sourceHash: "hash:styles-v1",
              version: "styles-v1"
            },
            {
              id: tokensId,
              source: tokenSource,
              sourceHash: tokenHash,
              version: tokenVersion
            }
          ],
          importResolutions: [
            {
              importerId: ownerId,
              importPath: "./styles",
              resolvedId: stylesId
            },
            {
              importerId: stylesId,
              importPath: "./tokens",
              resolvedId: tokensId
            }
          ],
          moduleCache: cache
        });

      const red = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const base = { color: "red" } as const;`,
            "hash:tokens-red",
            "tokens-red"
          ),
          "button"
        )
      );
      const blue = expectResolvedResult(
        resolveFixture(
          createVersionedProvider(
            `export const base = { color: "blue" } as const;`,
            "hash:tokens-blue",
            "tokens-blue"
          ),
          "button"
        )
      );

      expect(red.value).toEqual({ color: "red" });
      expect(blue.value).toEqual({ color: "blue" });
      expect(missesByFile.get(tokensId)).toBe(2);
      expect(red.cacheKey.staticEvalSupportVersion).toBe(
        "static-css-module-export-graph:v4"
      );
      expect(STATIC_CSS_MODULE_CACHE_SUPPORT_VERSION).toBe(
        "static-css-module-export-graph:v4"
      );
      expect(
        formatExportMapCacheKey(
          createExportMapCacheKey({
            resolvedFile: stylesId,
            source: "",
            sourceHash: "hash:styles-v1"
          })
        )
      ).toContain('"supportVersion":"static-css-module-export-graph:v4"');
    });

    it("resolves limited namespace members from project-local literal chains", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "./styles"; <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "namespace-member",
          file: stylesId,
          exportName: "button",
          namespaceBinding: "styles"
        },
        dependencies: [
          {
            file: stylesId,
            kind: "namespace-member",
            inspected: true,
            contributed: true
          }
        ]
      });
    });

    it("resolves static CommonJS require bindings and require-backed CJS exports", () => {
      const cjsImportProvider = createProvider(
        `
          export const button = { color: "red" } as const;
          export const card = { color: "blue" } as const;
          export default { color: "green" } as const;
        `,
        `
          const styles = require("./styles");
          const directButton = require("./styles").button;
          const { card: cardStyle } = require("./styles");
        `
      );

      expect(
        resolveFixture(cjsImportProvider, "styles", ["button"])
      ).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "imported",
          file: stylesId,
          exportName: "button"
        },
        dependencies: [
          {
            file: stylesId,
            kind: "imported",
            importer: ownerId,
            specifier: "./styles",
            exportName: "button",
            memberPath: [],
            inspected: true,
            contributed: true
          }
        ]
      });
      expect(resolveFixture(cjsImportProvider, "directButton")).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
      expect(resolveFixture(cjsImportProvider, "cardStyle")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });

      expect(
        resolveFixture(
          createProvider(
            `module.exports = { button: { color: "red" }, card: { color: "blue" } };`,
            `const styles = require("./styles"); <div css={styles} />;`
          ),
          "styles"
        )
      ).toMatchObject({
        kind: "resolved",
        value: {
          button: { color: "red" },
          card: { color: "blue" }
        },
        provenance: {
          kind: "imported",
          file: stylesId,
          exportName: null
        }
      });

      const cjsReexportProvider = createProvider(
        `
          export const button = { color: "red" } as const;
          export const card = { color: "blue" } as const;
        `,
        `import { button, card } from "./barrel"; <><div css={button} /><div css={card} /></>;`,
        `
          const styles = require("./styles");
          exports.button = styles.button;
          exports.card = require("./styles").card;
        `
      );

      expect(resolveFixture(cjsReexportProvider, "button")).toMatchObject({
        kind: "resolved",
        value: { color: "red" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button",
          reexportName: "button"
        },
        dependencies: [
          {
            file: barrelId,
            kind: "reexported",
            inspected: true,
            contributed: true
          },
          {
            file: stylesId,
            kind: "reexported",
            inspected: true,
            contributed: true
          }
        ],
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
      expect(resolveFixture(cjsReexportProvider, "card")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "card",
          reexportName: "card"
        }
      });
    });

    it("resolves same-file const path CommonJS require bindings", () => {
      const provider = createProvider(
        `
          export const button = { color: "red" } as const;
          export const card = { color: "blue" } as const;
          export default { color: "green" } as const;
        `,
        `
          const path = "./styles";
          const templatePath = \`./styles\`;
          const styles = require(path);
          const directButton = require(path).button;
          const templateDefault = require(templatePath).default;
          const { card: cardStyle } = require(path);
          <>
            <div css={styles.button} />
            <div css={directButton} />
            <div css={templateDefault} />
            <div css={cardStyle} />
          </>;
        `
      );

      const stylesResult = expectResolvedResult(
        resolveFixture(provider, "styles", ["button"])
      );

      expect(stylesResult.value).toEqual({ color: "red" });
      expect(stylesResult.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stylesId,
            specifier: "./styles",
            exportName: "button",
            inspected: true,
            contributed: true
          })
        ])
      );
      expect(resolveFixture(provider, "directButton")).toMatchObject({
        kind: "resolved",
        value: { color: "red" }
      });
      expect(resolveFixture(provider, "templateDefault")).toMatchObject({
        kind: "resolved",
        value: { color: "green" }
      });
      expect(resolveFixture(provider, "cardStyle")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" }
      });
    });

    it("resolves esbuild static CommonJS helper named default and require-backed exports", () => {
      const esbuildStylesSource = `
        ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
        const button = { color: "red" };
        const root = { color: "green" };
        __export(exports, {
          button: () => button,
          default: () => root
        });
        module.exports = __toCommonJS(exports);
      `;
      const esbuildProvider = createProvider(
        esbuildStylesSource,
        `const styles = require("./styles"); <><div css={styles.button} /><div css={styles.default} /></>;`
      );
      const buttonResult = expectResolvedResult(
        resolveFixture(esbuildProvider, "styles", ["button"])
      );
      const defaultResult = expectResolvedResult(
        resolveFixture(esbuildProvider, "styles", ["default"])
      );

      expect(buttonResult.value).toEqual({ color: "red" });
      expect(defaultResult.value).toEqual({ color: "green" });

      const reexportProvider = createProvider(
        `export const button = { color: "blue" } as const;`,
        `import { button } from "./barrel"; <div css={button} />;`,
        `
          ${createEsbuildHelperSource(createEsbuildCopyPropsHelperSource())}
          const styles = require("./styles");
          __export(exports, { button: () => styles.button });
          module.exports = __toCommonJS(exports);
        `
      );

      expect(resolveFixture(reexportProvider, "button")).toMatchObject({
        kind: "resolved",
        value: { color: "blue" },
        provenance: {
          kind: "reexported",
          file: stylesId,
          exportName: "button",
          reexportName: "button"
        },
        resolutionChain: [
          { importer: ownerId, source: barrelId, exportName: "button" },
          { importer: barrelId, source: stylesId, exportName: "button" }
        ]
      });
    });

    it("rejects esbuild copyProps helper definitions missing required guard pieces", () => {
      const cases: readonly string[] = [
        `
          var __copyProps = (to, from, except, desc) => {
            if (from) {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of Object.keys(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key))
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: true });
            }
            return to;
          };
        `,
        `
          var __copyProps = (to, from, except, desc) => {
            if (from && typeof from === "object" || typeof from === "function") {
              for (let key of __getOwnPropNames(from))
                if (!__hasOwnProp.call(to, key) && key !== except)
                  __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) });
            }
            return to;
          };
        `
      ];

      for (const copyPropsSource of cases) {
        expectCjsUnsupportedFixture({
          stylesSource: `
            ${createEsbuildHelperSource(copyPropsSource)}
            var entry_exports = {};
            const button = { color: "red" };
            __export(entry_exports, { button: () => button });
            module.exports = __toCommonJS(entry_exports);
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        });
      }
    });

    it("rejects missing exports, unresolved imports, dynamic cjs, and cycles with exact diagnostics", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const card = { color: "red" } as const;`,
            `import { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import { button } from "pkg"; <div css={button} />;`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          importPath: "pkg"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import * as styles from "pkg"; <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_UNRESOLVED_IMPORT",
          importPath: "pkg"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `const styles = require(name); <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED",
          reason: "commonjs-require",
          message:
            "Cannot statically evaluate css prop value: commonjs dynamic require is unsupported"
        }
      });

      expect(
        resolveFixture(
          createProviderFromModules({
            modules: [
              {
                id: ownerId,
                source: `import { button } from "./a"; <div css={button} />;`
              },
              { id: barrelId, source: `export { button } from "./button";` },
              { id: buttonId, source: `export { button } from "./barrel";` }
            ],
            importResolutions: [
              { importerId: ownerId, importPath: "./a", resolvedId: barrelId },
              {
                importerId: barrelId,
                importPath: "./button",
                resolvedId: buttonId
              },
              {
                importerId: buttonId,
                importPath: "./barrel",
                resolvedId: barrelId
              }
            ]
          }),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_IMPORT_CYCLE"
        }
      });
    });

    it("rejects unsupported CommonJS require forms with narrow dynamic diagnostics", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `let path = "./styles"; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const path = "./styles"; path = "./other"; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `import { path } from "./paths"; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const path = "./" + "styles"; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const path = enabled ? "./styles" : "./fallback"; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const path = process.env.STYLES; const styles = require(path); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const styles = require(name); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = require(`./${name}`); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource: `const styles = enabled ? require("./styles") : require("./fallback"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = `prefix-${require(name)}`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = require(name)`styles`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = tag`styles-${require(name)}`; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = new (require(name))(); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = new Styles(require(name)); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = await require(name); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (target = require(name)); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (target[require(name)] = fallback); <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        },
        {
          stylesSource: `export const button = { color: "red" } as const;`,
          ownerSource:
            "const styles = (require(name))<unknown>; <div css={styles.button} />;",
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId:
            "STATIC_CSS_EVAL_CJS_DYNAMIC_REQUIRE_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `const path = "./styles"; const { [buttonKey]: button } = require(path); <div css={button} />;`
          ),
          "button"
        )
      ).toEqual({ kind: "not-candidate" });
    });

    it("fails closed when CommonJS globals are lexically shadowed", () => {
      const shadowedRequireProvider = createProvider(
        `export const button = { color: "red" } as const;`,
        `const require = makeRequire(); const styles = require("./styles"); <div css={styles.button} />;`
      );

      expect(
        resolveFixture(shadowedRequireProvider, "styles", ["button"])
      ).toEqual({
        kind: "not-candidate"
      });
      expectCjsUnsupportedFixture({
        stylesSource: `const exports = {}; exports.button = { color: "red" };`,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });
      expectCjsUnsupportedFixture({
        stylesSource: `const module = {}; module.exports = { button: { color: "red" } };`,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });

      const parameterShadowedExportsSource = `
        function write(exports) {
          exports.button = { color: "red" };
        }
        write({});
      `;
      const parameterShadowedExportsRecord =
        createImportedStaticCssEvalModuleRecord({
          id: stylesId,
          source: parameterShadowedExportsSource
        });

      expect(parameterShadowedExportsRecord.exports.has("button")).toBe(false);
      expectCjsUnsupportedFixture({
        stylesSource: parameterShadowedExportsSource,
        ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
        bindingName: "styles",
        memberPath: ["button"],
        expectedDiagnosticId: "STATIC_CSS_EVAL_UNRESOLVED_EXPORT"
      });
    });

    it("rejects unsupported CommonJS export mutations before className compilation", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            const button = { color: "red" };
            if (enabled) exports.button = button;
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        },
        {
          stylesSource: `
            const button = { color: "red" };
            for (const name of ["button"]) exports.button = button;
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        },
        {
          stylesSource: `
            const root = {};
            module.exports = root;
            exports.button = { color: "red" };
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects unsupported CommonJS helper definitions before className compilation", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            function __createBinding() { sideEffect(); }
            const theme = require("./theme");
            __createBinding(exports, theme, "button");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        },
        {
          stylesSource: `
            const button = { color: "red" };
            var __export = function () { sideEffect(); };
            __export(exports, { button: function () { return button; } });
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_HELPER_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects Webpack Turbopack and Parcel CommonJS bundle runtime snippets", () => {
      const cases: readonly CjsUnsupportedFixture[] = [
        {
          stylesSource: `
            var __webpack_modules__ = {
              "./style": function (module) {
                module.exports = { button: { color: "red" } };
              }
            };
            function __webpack_require__(id) { return __webpack_modules__[id]({ exports: {} }); }
            module.exports = __webpack_require__("./style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        },
        {
          stylesSource: `
            function __turbopack_require__(id) { return id; }
            module.exports = __turbopack_require__("[project]/style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        },
        {
          stylesSource: `
            var parcelRequire = function (id) { return id; };
            module.exports = parcelRequire("style");
          `,
          ownerSource: `const styles = require("./styles"); <div css={styles.button} />;`,
          bindingName: "styles",
          memberPath: ["button"],
          expectedDiagnosticId: "STATIC_CSS_EVAL_CJS_BUNDLE_RUNTIME_UNSUPPORTED"
        }
      ];

      for (const fixture of cases) {
        expectCjsUnsupportedFixture(fixture);
      }
    });

    it("rejects computed namespace members and ignores type-only imports", () => {
      const provider = createProvider(
        `export const button = { color: "red" } as const;`,
        `import * as styles from "./styles"; <div css={styles[variant]} />;`
      );
      const diagnostic =
        findUnsupportedImportedStaticCssEvalReferenceDiagnostic({
          expression: t.memberExpression(
            t.identifier("styles"),
            t.identifier("variant"),
            true
          ),
          ownerFile: ownerId,
          provider
        });

      expect(diagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
      });

      const optionalDiagnostic =
        findUnsupportedImportedStaticCssEvalReferenceDiagnostic({
          expression: t.optionalMemberExpression(
            t.identifier("styles"),
            t.identifier("button"),
            false,
            true
          ),
          ownerFile: ownerId,
          provider
        });

      expect(optionalDiagnostic).toMatchObject({
        id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED",
        expressionType: "OptionalMemberExpression"
      });
      expect(optionalDiagnostic?.message).toContain(
        "optional member paths are unsupported"
      );

      for (const expression of [
        t.objectExpression([
          t.spreadElement(
            t.memberExpression(
              t.identifier("styles"),
              t.identifier("variant"),
              true
            )
          )
        ]),
        t.arrayExpression([
          t.spreadElement(
            t.memberExpression(
              t.identifier("styles"),
              t.identifier("variant"),
              true
            )
          )
        ])
      ]) {
        expect(
          findUnsupportedImportedStaticCssEvalReferenceDiagnostic({
            expression,
            ownerFile: ownerId,
            provider
          })
        ).toMatchObject({
          id: "STATIC_CSS_EVAL_COMPUTED_MEMBER_UNSUPPORTED"
        });
      }

      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const;`,
            `import type { button } from "./styles"; <div css={button} />;`
          ),
          "button"
        )
      ).toEqual({ kind: "not-candidate" });
    });

    it("fails closed for imported member paths that miss or cross non-object values", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const styles = { card: { color: "red" } } as const;`,
            `import { styles } from "./styles"; <div css={styles.button} />;`
          ),
          "styles",
          ["button"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
        }
      });

      expect(
        resolveFixture(
          createProvider(
            `export const styles = { button: "class-name" } as const;`,
            `import { styles } from "./styles"; <div css={styles.button.primary} />;`
          ),
          "styles",
          ["button", "primary"]
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_DYNAMIC_EXPRESSION_UNSUPPORTED"
        }
      });
    });

    it("resolves numeric imported array member paths", () => {
      const result = resolveFixture(
        createProvider(
          `export const styles = { cards: [{ color: "red" }] } as const;`,
          `import { styles } from "./styles"; <div css={styles.cards[0].color} />;`
        ),
        "styles",
        ["cards", "0", "color"]
      );

      expect(expectResolvedResult(result).value).toBe("red");
    });

    it("defers imported array member paths across preceding spreads", () => {
      const result = resolveFixture(
        createProvider(
          `const baseCards = [{ color: "green" }, { color: "yellow" }] as const;
          export const styles = { cards: [{ color: "red" }, ...baseCards, { color: "blue" }] } as const;`,
          `import { styles } from "./styles"; <div css={styles.cards[2].color} />;`
        ),
        "styles",
        ["cards", "2", "color"]
      );

      expect(expectResolvedResult(result).value).toBe("yellow");
    });

    it("preserves holes in imported array member paths", () => {
      const result = resolveFixture(
        createProvider(
          `export const styles = { cards: [{ color: "red" }, , { color: "blue" }] } as const;`,
          `import { styles } from "./styles"; <div css={styles.cards[2].color} />;`
        ),
        "styles",
        ["cards", "2", "color"]
      );

      expect(expectResolvedResult(result).value).toBe("blue");
    });

    it("rejects unsupported namespace reexports with exact diagnostics", () => {
      const result = resolveFixture(
        createProvider(
          `export const button = { color: "red" } as const;`,
          `import { styles } from "./barrel"; <div css={styles} />;`,
          `export * as styles from "./styles";`
        ),
        "styles"
      );

      expect(result).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_NAMESPACE_REEXPORT_UNSUPPORTED",
          reason: "unsupported-namespace-reexport",
          dependency: { file: barrelId },
          importPath: "./styles",
          exportName: "styles"
        }
      });
    });

    it("rejects exported const mutations deterministically", () => {
      expect(
        resolveFixture(
          createProvider(
            `export const button = { color: "red" } as const; button.color = "blue";`
          ),
          "button"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_MUTATED_BINDING"
        },
        dependencies: [{ file: stylesId, inspected: true, contributed: false }]
      });

      expect(
        resolveFixture(
          createProvider(
            `export const buttons = [{ color: "red" }] as const; buttons.push({ color: "blue" });`,
            `import { buttons } from "./styles"; <div css={buttons} />;`
          ),
          "buttons"
        )
      ).toMatchObject({
        kind: "error",
        diagnostic: {
          id: "STATIC_CSS_EVAL_MUTATED_BINDING"
        },
        dependencies: [{ file: stylesId, inspected: true, contributed: false }]
      });
    });
  });
}

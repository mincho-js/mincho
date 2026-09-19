import { describe, expect, it, vi } from "vitest";
import { parseSync } from "@babel/core";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BabelTransformError,
  babelTransform,
  babelTransformSource
} from "./babel.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";
import { CompilationCache } from "./compilationCache.js";

const filename = "/virtual/mincho-owner.tsx";
const source =
  'export const marker = "incoming"; export const App = () => <div css={{color: "red"}} />;';

function seedArtifacts(engine: MinchoProjectEngine) {
  engine.refreshFile({
    fileId: filename,
    result: { dependencyFiles: ["/stale.ts"] },
    generatedArtifacts: [
      {
        ownerFile: filename,
        artifactFile: "stale.css.ts",
        source: "stale",
        kind: "sidecar-css-ts"
      }
    ]
  });
}

describe("babelTransformSource", () => {
  it.each(["cwd", "root", "default"] as const)(
    "observes a sibling Babel configuration selected through %s",
    async (selection) => {
      const directory = await mkdtemp(join(tmpdir(), "mincho-babel-root-"));
      const project = join(directory, "project");
      const sourceRoot = join(directory, "source");
      const config = join(project, "babel.config.json");
      const cwd =
        selection === "default"
          ? vi.spyOn(process, "cwd").mockReturnValue(project)
          : undefined;

      try {
        await Promise.all([mkdir(project), mkdir(sourceRoot)]);
        for (const color of ["blue", "green"]) {
          await writeFile(
            join(project, `${color}.cjs`),
            `module.exports = () => ({ parserOverride(code, options, parse) { return parse(code.replace('"red"', '"${color}"'), options); } });`
          );
        }

        const options = {
          filename: join(sourceRoot, "entry.ts"),
          source:
            'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
          babel: {
            compilationCache: new CompilationCache(),
            ...(selection === "cwd" ? { cwd: project } : {}),
            ...(selection === "root" ? { cwd: directory, root: "project" } : {})
          }
        };

        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );
        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );

        for (const color of ["blue", "green"]) {
          await writeFile(
            config,
            JSON.stringify({ plugins: [`./${color}.cjs`] })
          );
          expect((await babelTransformSource(options)).result[1]).toContain(
            `"${color}"`
          );
        }

        await rm(config);
        expect((await babelTransformSource(options)).result[1]).toContain(
          '"red"'
        );
      } finally {
        cwd?.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("honors an automatically discovered ESM Babel parser configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-parser-config-"));

    try {
      await writeFile(join(root, "package.json"), '{"name":"parser-config"}');
      await writeFile(
        join(root, ".babelrc.mjs"),
        'export default { plugins: [() => ({ parserOverride(code, options, parse) { return parse(code.replace("red", "blue"), options); } })] };'
      );

      const result = await babelTransformSource({
        filename: join(root, "entry.ts"),
        root,
        source:
          'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
        babel: { compilationCache: new CompilationCache(), cwd: root }
      });

      expect(result.result[1]).toContain('"blue"');
      expect(result.result[1]).not.toContain('"red"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors custom parsers even when the helper prepass has already parsed the source", async () => {
    const parserOverride = vi.fn((code: string) =>
      parseSync(code.replace('"red"', '"blue"'), {
        configFile: false,
        babelrc: false,
        parserOpts: { plugins: ["jsx", "typescript"] }
      })
    );

    const transformed = await babelTransformSource({
      filename,
      source:
        'import { css } from "@mincho-js/css"; export const cls = css({ color: "red" });',
      babel: {
        compilationCache: new CompilationCache(),
        plugins: [() => ({ parserOverride })]
      }
    });

    expect(parserOverride).toHaveBeenCalled();
    expect(transformed.result[1]).toContain('"blue"');
    expect(transformed.result[1]).not.toContain('"red"');
  });

  it("forwards extractCalls separately from Babel core options and respects effective JSX loaders", async () => {
    const transformed = await babelTransformSource({
      filename: "/virtual/entry.js",
      loader: "jsx",
      source:
        'import { make } from "custom-styles"; export const value = make({ color: "red" }); export const App = () => <div />;',
      babel: { extractCalls: { "custom-styles": ["make"] } }
    });

    expect(transformed.code).not.toContain("make({");
    expect(transformed.result[1]).toContain("make({");
  });

  it("matches owner bindings from the separately parsed extraction prepass", async () => {
    const source = `
      import { style } from "@vanilla-extract/css";
      const make = (rule) => style(rule);
      export { make as registered };
      export const primary = make({ color: "red" });
      export const shadowed = (make) => make({ color: "blue" });
    `;
    const load = vi.fn(() => null);
    const transformed = await babelTransformSource({
      filename: "/virtual/factory.ts",
      root: "/virtual",
      source,
      babel: {
        extractCalls: { "./factory.ts": ["registered"] },
        staticCssEvalSourceProvider: {
          resolve: (_importer, specifier) =>
            specifier === "./factory.ts" ? { id: "/virtual/factory.ts" } : null,
          load
        }
      }
    });

    expect(load).not.toHaveBeenCalled();
    expect(transformed.result[1]).toContain('color: "red"');
    expect(transformed.result[1]).toContain("style(rule)");
    expect(transformed.result[1]).not.toContain('color: "blue"');
    expect(transformed.code).not.toContain('color: "red"');
    expect(transformed.code).toContain("style(rule)");
    expect(transformed.code).toContain('color: "blue"');
  });

  it("uses bundler identities and load keys for local factories and tracks their dependencies", async () => {
    const engine = new MinchoProjectEngine();
    const files: Record<string, string> = {
      "/virtual/factory.ts": 'export { make } from "@helper";',
      "/virtual/helper.ts":
        'import { style } from "@vanilla-extract/css"; export const make = (rule) => style(rule);'
    };

    const provider = {
      resolve: vi.fn((_importer: string, specifier: string) => {
        const file =
          specifier === "./factory.ts" || specifier === "@styles"
            ? "/virtual/factory.ts"
            : specifier === "@helper"
              ? "/virtual/helper.ts"
              : null;

        return file
          ? {
              resolvedFile: file,
              normalizedPathKey: `load:${file}`,
              watchFiles: ["/virtual/aliases.json"]
            }
          : null;
      }),
      load: vi.fn((key: string) => ({
        sourceText: files[key.replace(/^load:/, "")],
        watchFiles: ["/virtual/templates.json"]
      }))
    };

    const babel = {
      extractCalls: { "./factory.ts": ["make"] },
      staticCssEvalSourceProvider: provider,
      staticCssEvalProjectEngine: engine
    };

    const helper = await babelTransformSource({
      filename: "/virtual/helper.ts",
      root: "/virtual",
      source: files["/virtual/helper.ts"]!,
      babel
    });

    expect(helper.code).toContain("style(rule)");
    expect(helper.result[1]).toBe("");

    const transformed = await babelTransformSource({
      filename: "/virtual/entry.ts",
      root: "/virtual",
      source:
        'import { make } from "@styles"; export const value = make({ color: "red" });',
      babel
    });

    expect(transformed.result[1]).toContain("make({");
    expect(transformed.staticCssEval?.dependencyFiles).toEqual(
      expect.arrayContaining([
        "/virtual/factory.ts",
        "/virtual/helper.ts",
        "/virtual/aliases.json",
        "/virtual/templates.json"
      ])
    );
    expect(provider.load).toHaveBeenCalledWith("load:/virtual/factory.ts");
    expect(engine.invalidateByDependency("/virtual/helper.ts")).toContain(
      "/virtual/entry.ts"
    );
  });

  it("keeps recovery dependencies when a registered implementation fails analysis", async () => {
    await expect(
      babelTransformSource({
        filename: "/virtual/entry.ts",
        root: "/virtual",
        source: "export const value = 1;",
        babel: {
          extractCalls: { "./factory.ts": ["make"] },
          staticCssEvalSourceProvider: {
            resolve: () => ({
              id: "/virtual/factory.ts",
              watchFiles: ["/virtual/aliases.json"]
            }),

            load: () => ({ sourceText: "export const make = 1;" })
          }
        }
      })
    ).rejects.toMatchObject({
      name: "BabelTransformError",
      message: expect.stringMatching(/extractCalls.*make.*implementation/),
      staticCssEval: {
        dependencyFiles: expect.arrayContaining([
          "/virtual/factory.ts",
          "/virtual/aliases.json"
        ])
      }
    });
  });

  it("uses the supplied owner source for both the prepass and transformation", async () => {
    const load = vi.fn(() => {
      throw new Error("The owner must not be reloaded");
    });

    const transformed = await babelTransformSource({
      filename,
      source,
      sourceMaps: true,
      babel: {
        jsxCssProp: true,
        staticCssEvalSourceProvider: { resolve: () => null, load }
      }
    });

    expect(load).not.toHaveBeenCalled();
    expect(transformed.code).toContain('marker = "incoming"');
    expect(transformed.result[1]).toContain('"red"');
    expect(transformed.map?.sourcesContent).toEqual([source]);
    expect(transformed.map?.mappings).toBeTruthy();
  });

  it.each([
    ["entry.jsx", "jsx", '<div css={{ color: "red" }} />'],
    ["entry.js", "jsx", '<div css={{ color: "red" }} />'],
    ["entry.js", "tsx", 'const color: string = "red"; <div css={{ color }} />']
  ] as const)(
    "parses %s with its effective %s loader",
    async (name, loader, input) => {
      const transformed = await babelTransformSource({
        filename: `/virtual/${name}`,
        source: input,
        loader,
        babel: { jsxCssProp: true }
      });

      expect(transformed.jsxCssPropTransformed).toBe(true);
      expect(transformed.map).toBeUndefined();
      expect(transformed.code).not.toContain(": string");
    }
  );

  it.each(["resolve", "load"] as const)(
    "clears old engine artifacts when the prepass %s fails",
    async (failure) => {
      const engine = new MinchoProjectEngine();
      seedArtifacts(engine);

      await expect(
        babelTransformSource({
          filename,
          source: 'import { style } from "./tokens"; <div css={style} />;',
          babel: {
            jsxCssProp: true,
            staticCssEvalProjectEngine: engine,
            staticCssEvalSourceProvider: {
              resolve() {
                if (failure === "resolve") throw new Error("resolve failed");

                return { id: "/virtual/tokens.ts" };
              },

              load() {
                throw new Error("load failed");
              }
            }
          }
        })
      ).rejects.toMatchObject({
        name: "BabelTransformError",
        file: filename,
        message: `${failure} failed`
      });

      expect(engine.getFileResult(filename)?.generatedArtifacts).toEqual([]);
      expect(engine.getFileResult(filename)?.dependencyFiles).not.toContain(
        "/stale.ts"
      );
    }
  );

  it("clears old engine artifacts when the file wrapper cannot read its owner", async () => {
    const engine = new MinchoProjectEngine();
    seedArtifacts(engine);

    await expect(
      babelTransform(filename, { staticCssEvalProjectEngine: engine })
    ).rejects.toBeInstanceOf(BabelTransformError);

    expect(engine.getFileResult(filename)?.generatedArtifacts).toEqual([]);
  });
});

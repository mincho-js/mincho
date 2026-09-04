import { describe, expect, it, vi } from "vitest";
import {
  BabelTransformError,
  babelTransform,
  babelTransformSource
} from "./babel.js";
import { MinchoProjectEngine } from "./staticCssEvalProjectEngine.js";

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

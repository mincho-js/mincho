import type { Rollup } from "vite";
import { internalMeasureBundleBytes } from "@mincho-js/integration";
import { describe, expect, it } from "vitest";
import { measureOutputBundle } from "./bundleMetrics.js";

type CssChunk = Rollup.OutputChunk & {
  viteMetadata?: {
    importedCss: Set<string>;
    importedAssets: Set<string>;
  };
};

function chunk(fileName: string, overrides: Partial<CssChunk> = {}): CssChunk {
  return {
    type: "chunk",
    fileName,
    preliminaryFileName: fileName,
    name: fileName,
    code: "export {};",
    isEntry: false,
    isDynamicEntry: false,
    isImplicitEntry: false,
    facadeModuleId: null,
    moduleIds: [],
    exports: [],
    imports: [],
    dynamicImports: [],
    implicitlyLoadedBefore: [],
    importedBindings: {},
    modules: {},
    referencedFiles: [],
    map: null,
    sourcemapFileName: null,
    ...overrides
  };
}

function asset(
  fileName: string,
  source: string | Uint8Array
): Rollup.OutputAsset {
  return {
    type: "asset",
    fileName,
    source,
    name: undefined,
    names: [],
    originalFileName: null,
    originalFileNames: [],
    needsCodeReference: false
  };
}

describe("final bundle metrics", () => {
  it("reports every emitted asset while keeping JS, CSS, and HTML totals separate", () => {
    const items = [
      chunk("entry.js", {
        isEntry: true,
        imports: ["extensionless"],
        viteMetadata: {
          importedCss: new Set(["style.css"]),
          importedAssets: new Set()
        }
      }),
      chunk("extensionless"),
      asset("style.css", ".a { color: red; }"),
      asset("index.html", "<p>hello</p>"),
      asset("image.png", new Uint8Array([137, 80, 78, 71])),
      asset("font.woff2", new Uint8Array([119, 79, 70, 50])),
      asset("module.wasm", new Uint8Array([0, 97, 115, 109])),
      asset("entry.js.map", '{"version":3}'),
      asset("manifest.json", "{}")
    ];
    const bundle = Object.fromEntries(
      items.map((item) => [item.fileName, item])
    );
    const report = measureOutputBundle(bundle);

    expect(Object.keys(report.assets).sort()).toEqual(
      Object.keys(bundle).sort()
    );

    for (const item of items) {
      expect(report.assets[item.fileName]).toMatchObject(
        internalMeasureBundleBytes(
          item.type === "chunk" ? item.code : item.source
        )
      );
    }

    const jsBytes = internalMeasureBundleBytes("export {};");
    expect(report.entries).toEqual([
      {
        entry: "entry.js",
        js: {
          raw: jsBytes.raw * 2,
          gzip: jsBytes.gzip * 2,
          brotli: jsBytes.brotli * 2
        },
        css: internalMeasureBundleBytes(".a { color: red; }"),
        jsAssets: 2,
        cssAssets: 1,
        routeVisits: []
      }
    ]);
    expect(report.totalCss).toEqual(
      internalMeasureBundleBytes(".a { color: red; }")
    );
    expect(report.cssAssets).toBe(1);
    expect(report.html).toEqual(internalMeasureBundleBytes("<p>hello</p>"));
  });

  it("traverses deep cyclic imports once and excludes dynamically imported chunks", () => {
    const depth = 20_000;
    const bundle: Rollup.OutputBundle = {};

    for (let index = 0; index < depth; index += 1) {
      const fileName = `chunk-${index}.js`;
      bundle[fileName] = chunk(fileName, {
        isEntry: index === 0,
        imports: [`chunk-${(index + 1) % depth}.js`, "external"],
        dynamicImports: ["lazy.js"],
        viteMetadata: {
          importedCss: new Set(
            index === depth - 1 ? ["leaf.css", "shared.css"] : ["shared.css"]
          ),
          importedAssets: new Set()
        }
      });
    }

    bundle["lazy.js"] = chunk("lazy.js", {
      isDynamicEntry: true,
      viteMetadata: {
        importedCss: new Set(["lazy.css"]),
        importedAssets: new Set()
      }
    });
    bundle["shared.css"] = asset("shared.css", ".shared{color:red}");
    bundle["leaf.css"] = asset("leaf.css", ".leaf{color:blue}");
    bundle["lazy.css"] = asset("lazy.css", ".lazy{color:green}");

    const report = measureOutputBundle(bundle);
    const entry = report.entries[0]!;
    expect(report.entries).toHaveLength(1);
    expect(entry.jsAssets).toBe(depth);
    expect(entry.js.raw).toBe(depth * Buffer.byteLength("export {};"));
    expect(entry.cssAssets).toBe(2);
    expect(entry.css.raw).toBe(
      Buffer.byteLength(".shared{color:red}.leaf{color:blue}")
    );
    expect(report.cssAssets).toBe(3);
  });

  it.each(["string", "Uint8Array", "Buffer"])(
    "counts UTF-8 declarations in %s sources",
    (kind) => {
      const body = 'content:"한글";color:red';
      const css = `.a{${body}}`;
      const bytes = Buffer.from(`prefix${css}suffix`);
      const source =
        kind === "string"
          ? css
          : kind === "Buffer"
            ? bytes.subarray(6, bytes.length - 6)
            : new Uint8Array(bytes).subarray(6, bytes.length - 6);
      const report = measureOutputBundle({
        "a.css": asset("a.css", source),
        "b.css": asset("b.css", `.b{${body}}`)
      });

      expect(report.duplicates).toEqual({
        measure: "identical-declaration-text",
        declarationBytes: Buffer.byteLength(body) * 2,
        duplicateDeclarationBytes: Buffer.byteLength(body),
        ratio: 0.5
      });
    }
  );
});

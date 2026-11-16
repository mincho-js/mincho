import { describe, expect, it } from "vitest";
import { createStaticCssModuleCache } from "../moduleCache.js";
import { createImportedStaticCssEvalModuleRecordWithCache } from "./moduleSource.js";

describe("imported module syntax and identity", () => {
  it.each([
    ["ts", 'export const color: string = "red";'],
    ["tsx", "export const view: unknown = <div />;"]
  ])(
    "infers %s syntax from physical files without merging logical variants",
    (extension, source) => {
      const cache = createStaticCssModuleCache();
      const first = createImportedStaticCssEvalModuleRecordWithCache(
        {
          id: "tokens:first",
          resolvedFile: `/tokens.${extension}`,
          source
        },
        cache
      );
      const second = createImportedStaticCssEvalModuleRecordWithCache(
        {
          id: "tokens:second",
          resolvedFile: `/tokens.${extension}`,
          source
        },
        cache
      );
      const changed = createImportedStaticCssEvalModuleRecordWithCache(
        {
          id: "tokens:second",
          resolvedFile: `/tokens.${extension}`,
          source: source
            .replace('"red"', '"blue"')
            .replace("<div />", "<span />")
        },
        cache
      );
      expect(first.id).toBe("tokens:first");
      expect(second.id).toBe("tokens:second");
      expect(first.parsedModule.file).toBe(first.id);
      expect(second.parsedModule.file).toBe(second.id);
      expect(
        new Set([first.parsedModule, second.parsedModule, changed.parsedModule])
          .size
      ).toBe(3);
      expect(first.parsedModule.cacheKey.parserOptions).toMatchObject({
        typescript: true,
        jsx: extension === "tsx"
      });
    }
  );

  it("defaults syntax inference to the module identity without physical metadata", () => {
    const record = createImportedStaticCssEvalModuleRecordWithCache(
      {
        id: "/tokens.ts",
        source: 'export const color: string = "red";'
      },
      createStaticCssModuleCache()
    );
    expect(record.parsedModule.file).toBe("/tokens.ts");
    expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
  });
});

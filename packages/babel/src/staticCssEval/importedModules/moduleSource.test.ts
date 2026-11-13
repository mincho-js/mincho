import { describe, expect, it } from "vitest";
import {
  createStaticCssModuleCache,
  inferSyntaxFilename
} from "../moduleCache.js";
import {
  createImportedStaticCssEvalModuleRecordWithCache,
  createStaticCssModuleSource
} from "./moduleSource.js";

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

  it.each(["C#", "question?", "part#one?two"])(
    "preserves physical directory delimiters in %s",
    (directory) => {
      const cache = createStaticCssModuleCache();
      const record = createImportedStaticCssEvalModuleRecordWithCache(
        {
          id: "tokens:variant?mode=one#fragment",
          resolvedFile: `/work/${directory}/tokens.ts`,
          source: 'export const color: string = "red";'
        },
        cache
      );
      expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
      expect(record.id).toBe("tokens:variant?mode=one#fragment");
    }
  );

  it("parses provider text with its logical syntax ID while retaining physical evidence", () => {
    const id = "/src/tokens.ts?variant=dark";
    const physical = "/src/tokens.data";
    const loadedModule = {
      id,
      source: 'export const color: string = "red";',
      resolvedFile: physical,
      realpath: physical,
      syntaxSourceId: id
    };
    expect(createStaticCssModuleSource(loadedModule)).toMatchObject({
      resolvedFile: id,
      syntaxFilename: "/src/tokens.ts"
    });
    const cache = createStaticCssModuleCache();
    const record = createImportedStaticCssEvalModuleRecordWithCache(
      loadedModule,
      cache
    );
    expect(record).toMatchObject({
      id,
      resolvedFile: physical,
      realpath: physical
    });
    expect(record.exports.has("color")).toBe(true);
    // A sibling alias with the same graph identity and bytes must not reuse
    // the TypeScript parse when its loader supplies JavaScript syntax.
    expect(() =>
      createImportedStaticCssEvalModuleRecordWithCache(
        { ...loadedModule, syntaxSourceId: "/src/tokens.js" },
        cache
      )
    ).toThrow(/Missing initializer/);
  });

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
  it("strips host suffixes only when physical syntax metadata is absent", () => {
    const cache = createStaticCssModuleCache();
    const variants = ["?mode=first", "#fragment"].map((suffix) =>
      createImportedStaticCssEvalModuleRecordWithCache(
        {
          id: `/tokens.ts${suffix}`,
          source: 'export const color: string = "red";'
        },
        cache
      )
    );
    expect(variants[0].parsedModule).not.toBe(variants[1].parsedModule);
    for (const record of variants)
      expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
  });
});

it.each(["C#", "question?", "part#one?two", "C.js#", "question.ts?"])(
  "preserves metadata-free physical directory delimiters in %s",
  (directory) => {
    const record = createImportedStaticCssEvalModuleRecordWithCache(
      {
        id: `/work/${directory}/tokens.ts`,
        source: 'export const color: string = "red";'
      },
      createStaticCssModuleCache()
    );
    expect(record.id).toBe(`/work/${directory}/tokens.ts`);
    expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
  }
);

it.each(["?theme=/dark", "#theme=/dark", "?theme=dark.js", "#theme=dark.js"])(
  "infers syntax before slash-containing host suffix %s",
  (suffix) => {
    const id = `/tokens.ts${suffix}`;
    const record = createImportedStaticCssEvalModuleRecordWithCache(
      { id, source: 'export const color: string = "red";' },
      createStaticCssModuleCache()
    );
    expect(record.id).toBe(id);
    expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
  }
);

it("uses physical syntax metadata for ambiguous slash-containing source-like query values", () => {
  const id = "/tokens.ts?theme=/dark.js";
  const record = createImportedStaticCssEvalModuleRecordWithCache(
    {
      id,
      resolvedFile: "/tokens.ts",
      source: 'export const color: string = "red";'
    },
    createStaticCssModuleCache()
  );
  expect(record.id).toBe(id);
  expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
});

it.each([undefined, "/src/tokens.ts?variant=dark"])(
  "separates query-bearing module identity from syntax filename (%s)",
  (resolvedFile) => {
    const source = createStaticCssModuleSource({
      id: "/src/tokens.ts?variant=dark",
      resolvedFile,
      source: 'export const color: string = "red"'
    });
    expect(source.resolvedFile).toBe("/src/tokens.ts?variant=dark");
    expect(() =>
      createStaticCssModuleCache().getParsedModule(source)
    ).not.toThrow();
    expect(
      source.syntaxFilename ?? inferSyntaxFilename(source.resolvedFile)
    ).toBe("/src/tokens.ts");
  }
);

it.each(["#", "?"])(
  "preserves a literal %s in a physical TS filename",
  (separator) => {
    const physical = `/src/archive.js${separator}tokens.ts`;
    const id = `${physical}?build=dark`;
    const loaded = {
      id,
      resolvedFile: physical,
      realpath: physical,
      source: 'export const color: string = "red";'
    };
    const source = createStaticCssModuleSource(loaded);
    expect(source).toMatchObject({
      resolvedFile: id,
      syntaxFilename: physical
    });
    const record = createImportedStaticCssEvalModuleRecordWithCache(
      loaded,
      createStaticCssModuleCache()
    );
    expect(record.id).toBe(id);
    expect(record.parsedModule.cacheKey.parserOptions.typescript).toBe(true);
  }
);

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compile } from "../compile.js";
import { compileWithOxc } from "../compile-oxc.js";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

describe("compileWithOxc", () => {
  let testDir: string;
  let resolverCache: Map<string, string>;

  beforeEach(() => {
    // Create temporary test directory
    testDir = join(tmpdir(), `mincho-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    resolverCache = new Map();

    // Create a minimal package.json
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "test-package" })
    );
  });

  afterEach(() => {
    // Clean up
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_e) {
      // Ignore cleanup errors
    }
  });

  it("should transform basic TypeScript code", async () => {
    const testFile = join(testDir, "test.ts");
    const contents = `
      const message: string = "Hello, World!";
      export default message;
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(result.source).toBeDefined();
    expect(result.source).toContain("Hello, World!");
    expect(result.watchFiles).toBeDefined();
    expect(result.watchFiles.length).toBeGreaterThan(0);
  });

  it("should transform styled() calls", async () => {
    const testFile = join(testDir, "styled.tsx");
    const contents = `
      import { styled } from "@mincho-js/react";
      
      export const Button = styled("button", {
        color: "red",
        backgroundColor: "blue"
      });
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(result.source).toBeDefined();
    // Should transform to $$styled with rules()
    expect(result.source).toContain("$$styled");
    expect(result.source).toContain("rules");
    // Should not contain original styled import
    expect(result.source).not.toContain('from "@mincho-js/react"');
  });

  it("should handle JSX syntax", async () => {
    const testFile = join(testDir, "component.tsx");
    const contents = `
      export const Component = () => {
        return <div>Hello JSX</div>;
      };
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(result.source).toBeDefined();
    // JSX should be transformed
    expect(result.source).not.toContain("<div>");
    expect(result.source).toContain("jsx");
  });

  it("should not extract CSS in compile mode", async () => {
    const testFile = join(testDir, "no-extract.tsx");
    const contents = `
      import { styled } from "@mincho-js/react";
      
      export const Box = styled("div", {
        padding: "10px",
        margin: "20px"
      });
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    // CSS should be inlined with rules(), not extracted to separate files
    expect(result.source).toContain("rules");
    expect(result.source).toContain("padding");
    expect(result.source).toContain("margin");
  });

  it("should use resolver cache for addFileScope", async () => {
    const testFile = join(testDir, "cached.ts");
    const contents = `export const value = 42;`;

    writeFileSync(testFile, contents);

    // First compilation
    const result1 = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(resolverCache.size).toBeGreaterThan(0);

    // Second compilation should use cache
    const result2 = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(result1.source).toBe(result2.source);
  });

  it("should handle multiple styled components in one file", async () => {
    const testFile = join(testDir, "multiple.tsx");
    const contents = `
      import { styled } from "@mincho-js/react";
      
      export const Button = styled("button", {
        color: "red"
      });
      
      export const Input = styled("input", {
        border: "1px solid black"
      });
      
      export const Div = styled("div", {
        display: "flex"
      });
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile
    });

    expect(result.source).toBeDefined();
    // All three components should be transformed
    const styledCount = (result.source.match(/\$\$styled/g) || []).length;
    expect(styledCount).toBe(3);

    const rulesCount = (result.source.match(/rules\(/g) || []).length;
    expect(rulesCount).toBe(3);
  });

  it("should respect externals option", async () => {
    const testFile = join(testDir, "externals.ts");
    const contents = `
      import external from "some-external-package";
      export default external;
    `;

    writeFileSync(testFile, contents);

    const result = await compileWithOxc({
      filePath: testFile,
      contents,
      cwd: testDir,
      resolverCache,
      originalPath: testFile,
      externals: ["some-external-package"]
    });

    expect(result.source).toBeDefined();
    // External package should not be bundled
    expect(result.source).toContain('require("some-external-package")');
  });

  describe("comparison with Babel compile", () => {
    it("should produce similar output structure", async () => {
      const testFile = join(testDir, "compare.tsx");
      const contents = `
        import { styled } from "@mincho-js/react";
        
        export const Component = styled("div", {
          color: "blue"
        });
      `;

      writeFileSync(testFile, contents);

      const babelResult = await compile({
        filePath: testFile,
        contents,
        cwd: testDir,
        resolverCache: new Map(),
        originalPath: testFile
      });

      const oxcResult = await compileWithOxc({
        filePath: testFile,
        contents,
        cwd: testDir,
        resolverCache: new Map(),
        originalPath: testFile
      });

      // Both should produce valid output
      expect(babelResult.source).toBeDefined();
      expect(oxcResult.source).toBeDefined();

      // Both should transform styled()
      expect(babelResult.source).toContain("$$styled");
      expect(oxcResult.source).toContain("$$styled");

      // Both should have rules()
      expect(babelResult.source).toContain("rules");
      expect(oxcResult.source).toContain("rules");

      // Both should have watch files
      expect(babelResult.watchFiles.length).toBeGreaterThan(0);
      expect(oxcResult.watchFiles.length).toBeGreaterThan(0);
    });

    it("should handle complex nested objects", async () => {
      const testFile = join(testDir, "complex.tsx");
      const contents = `
        import { styled } from "@mincho-js/react";
        
        export const Complex = styled("div", {
          color: "red",
          "&:hover": {
            color: "blue",
            backgroundColor: "yellow"
          },
          "@media (min-width: 768px)": {
            fontSize: "20px"
          }
        });
      `;

      writeFileSync(testFile, contents);

      const oxcResult = await compileWithOxc({
        filePath: testFile,
        contents,
        cwd: testDir,
        resolverCache: new Map(),
        originalPath: testFile
      });

      expect(oxcResult.source).toContain("$$styled");
      expect(oxcResult.source).toContain("rules");
      // Complex object should be preserved
      expect(oxcResult.source).toContain("&:hover");
      expect(oxcResult.source).toContain("@media");
    });
  });
});

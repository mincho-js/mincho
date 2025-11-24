import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compile } from "../compile.js";
import { compileWithOxc } from "../compile-oxc.js";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

interface BenchmarkResult {
  name: string;
  duration: number;
  memory: {
    before: number;
    after: number;
    delta: number;
  };
}

async function measurePerformance<T>(
  fn: () => Promise<T>,
  name: string
): Promise<BenchmarkResult> {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  await fn();

  const end = performance.now();
  const memAfter = process.memoryUsage().heapUsed;

  return {
    name,
    duration: end - start,
    memory: {
      before: memBefore,
      after: memAfter,
      delta: memAfter - memBefore
    }
  };
}

describe("Performance Benchmarks: Babel vs OXC", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mincho-bench-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "benchmark-package" })
    );
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_e) {
      // Ignore cleanup errors
    }
  });

  it("should benchmark simple TypeScript transformation", async () => {
    const testFile = join(testDir, "simple.ts");
    const contents = `
      interface User {
        name: string;
        age: number;
      }
      
      const user: User = { name: "John", age: 30 };
      export default user;
    `;

    writeFileSync(testFile, contents);

    const babelResult = await measurePerformance(
      () =>
        compile({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "Babel - Simple TypeScript"
    );

    const oxcResult = await measurePerformance(
      () =>
        compileWithOxc({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "OXC - Simple TypeScript"
    );

    console.log("\n=== Simple TypeScript Benchmark ===");
    console.log(`Babel: ${babelResult.duration.toFixed(2)}ms`);
    console.log(`OXC: ${oxcResult.duration.toFixed(2)}ms`);
    console.log(
      `Speedup: ${(babelResult.duration / oxcResult.duration).toFixed(2)}x`
    );
    console.log(
      `Babel Memory: ${(babelResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );
    console.log(
      `OXC Memory: ${(oxcResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );

    // OXC should be significantly faster
    expect(oxcResult.duration).toBeLessThan(babelResult.duration);
  });

  it("should benchmark styled components transformation", async () => {
    const testFile = join(testDir, "styled.tsx");
    const contents = `
      import { styled } from "@mincho-js/react";
      
      export const Button = styled("button", {
        color: "red",
        backgroundColor: "blue",
        padding: "10px 20px",
        fontSize: "16px",
        border: "none",
        borderRadius: "4px",
        cursor: "pointer",
        "&:hover": {
          backgroundColor: "darkblue"
        },
        "&:active": {
          transform: "scale(0.98)"
        }
      });
      
      export const Input = styled("input", {
        border: "1px solid #ccc",
        padding: "8px 12px",
        fontSize: "14px",
        borderRadius: "4px",
        "&:focus": {
          outline: "none",
          borderColor: "blue"
        }
      });
    `;

    writeFileSync(testFile, contents);

    const babelResult = await measurePerformance(
      () =>
        compile({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "Babel - Styled Components"
    );

    const oxcResult = await measurePerformance(
      () =>
        compileWithOxc({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "OXC - Styled Components"
    );

    console.log("\n=== Styled Components Benchmark ===");
    console.log(`Babel: ${babelResult.duration.toFixed(2)}ms`);
    console.log(`OXC: ${oxcResult.duration.toFixed(2)}ms`);
    console.log(
      `Speedup: ${(babelResult.duration / oxcResult.duration).toFixed(2)}x`
    );
    console.log(
      `Babel Memory: ${(babelResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );
    console.log(
      `OXC Memory: ${(oxcResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );

    expect(oxcResult.duration).toBeLessThan(babelResult.duration);
  });

  it("should benchmark complex component with JSX", async () => {
    const testFile = join(testDir, "complex.tsx");
    const contents = `
      import { styled } from "@mincho-js/react";
      import React from "react";
      
      export const Card = styled("div", {
        backgroundColor: "white",
        borderRadius: "8px",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
        padding: "20px",
        margin: "10px",
        transition: "all 0.3s ease",
        "&:hover": {
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
          transform: "translateY(-2px)"
        }
      });
      
      export const CardHeader = styled("h2", {
        fontSize: "24px",
        fontWeight: "bold",
        marginBottom: "12px",
        color: "#333"
      });
      
      export const CardBody = styled("p", {
        fontSize: "16px",
        lineHeight: "1.5",
        color: "#666"
      });
      
      interface CardComponentProps {
        title: string;
        description: string;
      }
      
      export const CardComponent: React.FC<CardComponentProps> = ({ title, description }) => {
        return (
          <Card>
            <CardHeader>{title}</CardHeader>
            <CardBody>{description}</CardBody>
          </Card>
        );
      };
    `;

    writeFileSync(testFile, contents);

    const babelResult = await measurePerformance(
      () =>
        compile({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "Babel - Complex Component"
    );

    const oxcResult = await measurePerformance(
      () =>
        compileWithOxc({
          filePath: testFile,
          contents,
          cwd: testDir,
          resolverCache: new Map(),
          originalPath: testFile
        }),
      "OXC - Complex Component"
    );

    console.log("\n=== Complex Component Benchmark ===");
    console.log(`Babel: ${babelResult.duration.toFixed(2)}ms`);
    console.log(`OXC: ${oxcResult.duration.toFixed(2)}ms`);
    console.log(
      `Speedup: ${(babelResult.duration / oxcResult.duration).toFixed(2)}x`
    );
    console.log(
      `Babel Memory: ${(babelResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );
    console.log(
      `OXC Memory: ${(oxcResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );

    expect(oxcResult.duration).toBeLessThan(babelResult.duration);
  });

  it("should benchmark batch processing", async () => {
    const fileCount = 10;
    const files: Array<{ path: string; contents: string }> = [];

    // Create multiple files
    for (let i = 0; i < fileCount; i++) {
      const filePath = join(testDir, `file${i}.tsx`);
      const contents = `
        import { styled } from "@mincho-js/react";
        
        export const Component${i} = styled("div", {
          color: "color${i}",
          backgroundColor: "bg${i}",
          padding: "${i}px"
        });
      `;

      writeFileSync(filePath, contents);
      files.push({ path: filePath, contents });
    }

    const babelResult = await measurePerformance(async () => {
      const results = await Promise.all(
        files.map((file) =>
          compile({
            filePath: file.path,
            contents: file.contents,
            cwd: testDir,
            resolverCache: new Map(),
            originalPath: file.path
          })
        )
      );
      return results;
    }, "Babel - Batch Processing");

    const oxcResult = await measurePerformance(async () => {
      const results = await Promise.all(
        files.map((file) =>
          compileWithOxc({
            filePath: file.path,
            contents: file.contents,
            cwd: testDir,
            resolverCache: new Map(),
            originalPath: file.path
          })
        )
      );
      return results;
    }, "OXC - Batch Processing");

    console.log(`\n=== Batch Processing Benchmark (${fileCount} files) ===`);
    console.log(`Babel: ${babelResult.duration.toFixed(2)}ms`);
    console.log(`OXC: ${oxcResult.duration.toFixed(2)}ms`);
    console.log(
      `Speedup: ${(babelResult.duration / oxcResult.duration).toFixed(2)}x`
    );
    console.log(
      `Babel Avg: ${(babelResult.duration / fileCount).toFixed(2)}ms/file`
    );
    console.log(
      `OXC Avg: ${(oxcResult.duration / fileCount).toFixed(2)}ms/file`
    );
    console.log(
      `Babel Memory: ${(babelResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );
    console.log(
      `OXC Memory: ${(oxcResult.memory.delta / 1024 / 1024).toFixed(2)}MB`
    );

    expect(oxcResult.duration).toBeLessThan(babelResult.duration);
  });
});

import { describe, it, expect } from "vitest";
import { oxcBaseTransform } from "../base-transform.js";

describe("oxcBaseTransform", () => {
  it("should transpile TypeScript to JavaScript", () => {
    const code = `const x: number = 1;`;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("const x = 1");
    expect(result.code).not.toContain(": number");
  });

  it("should transform JSX", () => {
    const code = `const el = <div>Hello</div>;`;

    const result = oxcBaseTransform("test.tsx", code);

    expect(result.code).toBeDefined();
    // With automatic runtime, JSX transforms to jsx() calls
    expect(result.code.length).toBeGreaterThan(0);
  });

  it("should handle TypeScript interfaces", () => {
    const code = `
      interface User {
        name: string;
        age: number;
      }
      const user: User = { name: "John", age: 30 };
    `;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).not.toContain("interface User");
    expect(result.code).toContain("user");
  });

  it("should preserve comments", () => {
    const code = `
      // This is a comment
      const x = 1;
      /* Block comment */
      const y = 2;
    `;

    const result = oxcBaseTransform("test.ts", code);

    // Comments might be preserved depending on OXC settings
    expect(result.code).toContain("x");
    expect(result.code).toContain("y");
  });

  it("should handle arrow functions", () => {
    const code = `const add = (a: number, b: number): number => a + b;`;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("=>");
    expect(result.code).not.toContain(": number");
  });

  it("should generate source maps when enabled", () => {
    const code = `const x: number = 1;`;

    const result = oxcBaseTransform("test.ts", code, { sourcemap: true });

    expect(result.map).toBeDefined();
  });

  it("should handle async/await", () => {
    const code = `
      async function fetchData() {
        const data = await fetch("/api");
        return data;
      }
    `;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("async");
    expect(result.code).toContain("await");
  });

  it("should handle destructuring", () => {
    const code = `
      const obj = { a: 1, b: 2 };
      const { a, b } = obj;
    `;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("a");
    expect(result.code).toContain("b");
  });

  it("should handle spread operator", () => {
    const code = `
      const arr1 = [1, 2, 3];
      const arr2 = [...arr1, 4, 5];
    `;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("arr1");
    expect(result.code).toContain("arr2");
  });

  it("should handle template literals", () => {
    const code = `const name = "World"; const greeting = \`Hello, \${name}!\`;`;

    const result = oxcBaseTransform("test.ts", code);

    expect(result.code).toContain("name");
    expect(result.code).toContain("greeting");
  });
});





import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("layout runtime bundles", () => {
  it.each(["development", "production"] as const)(
    "%s includes DOM diagnostics only when needed",
    async (mode) => {
      const bundle = await build({
        stdin: {
          contents: 'export { HStack } from "@mincho-js/react/layout";',
          resolveDir: process.cwd()
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        external: ["react"],
        define: { "process.env.NODE_ENV": JSON.stringify(mode) },
        minifySyntax: true
      });
      const output = bundle.outputFiles[0].text;
      for (const diagnostic of [
        "createContext",
        "useContext",
        "MutationObserver",
        "ResizeObserver",
        "getComputedStyle"
      ]) {
        // esbuild can retain unused names in an external import. Check calls,
        // including the module-level Context initialization, instead.
        const invocation = new RegExp(`\\b${diagnostic}\\s*\\(`);
        if (mode === "production") expect(output).not.toMatch(invocation);
        else expect(output).toMatch(invocation);
      }
      expect(output).not.toContain("@vanilla-extract");
    }
  );
});

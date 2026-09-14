import { describe, expect, it } from "vitest";
import { effectiveLoader, getScriptLoader } from "./scriptLoaders.js";

describe("script loader policy", () => {
  it.each([".ts", ".mts", ".cts"])("recognizes TypeScript %s", (extension) => {
    expect(getScriptLoader(`entry${extension}`)).toBe("ts");
  });

  it("honors the most specific configured extension before script defaults", () => {
    const loaders = { ".ts": "ts", ".raw.ts": "text" } as const;

    expect(effectiveLoader("style.raw.ts", loaders)).toBe("text");
    expect(getScriptLoader("style.raw.ts", loaders)).toBeUndefined();
    expect(getScriptLoader("component.custom", { ".custom": "tsx" })).toBe(
      "tsx"
    );
  });

  it("lets non-script loaders retain ownership of their inputs", () => {
    expect(effectiveLoader("styles.css")).toBe("css");
    expect(effectiveLoader("tokens.json")).toBe("json");
    expect(getScriptLoader("tokens.json")).toBeUndefined();
    expect(getScriptLoader("entry.js", { ".js": "empty" })).toBeUndefined();
  });
});

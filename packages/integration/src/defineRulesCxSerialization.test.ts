import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { processVanillaFile } from "@vanilla-extract/integration";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

const runtimeImport =
  "@mincho-js/css/defineRules/createDefineRulesCxRuntime" as const;

function hasScopedCx(
  value: unknown
): value is { readonly scopedCx: (...classNames: string[]) => string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "scopedCx" in value &&
    typeof value.scopedCx === "function"
  );
}

describe("defineRules cx serialization", () => {
  it("preserves prototype-like classes through vanilla-extract serialization", async () => {
    const cacheRoot = join(process.cwd(), "packages/integration/.cache");
    await mkdir(cacheRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(join(cacheRoot, "cx-serialization-"));
    const filePath = join(fixtureRoot, "fixture.css.ts");
    const outputPath = join(fixtureRoot, "fixture.mjs");

    try {
      const compiled = await compile({
        filePath,
        originalPath: filePath,
        contents: `
          import { addFunctionSerializer } from "@vanilla-extract/css/functionSerializer";
          import { createDefineRulesCxRuntime } from ${JSON.stringify(runtimeImport)};

          const artifact = {
            classWrites: [["__proto__", 1], ["owned", 1]]
          };
          export const scopedCx = addFunctionSerializer(
            createDefineRulesCxRuntime(artifact),
            {
              importPath: ${JSON.stringify(runtimeImport)},
              importName: "createDefineRulesCxRuntime",
              args: [artifact]
            }
          );
        `,
        resolverCache: new Map()
      });
      const serialized = await processVanillaFile({
        source: compiled.source,
        filePath,
        identOption: "debug"
      });
      await writeFile(outputPath, serialized, "utf8");
      const imported: unknown = await import(pathToFileURL(outputPath).href);

      expect(hasScopedCx(imported)).toBe(true);
      if (!hasScopedCx(imported)) return;
      expect(imported.scopedCx("__proto__ owned")).toBe("owned");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

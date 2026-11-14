import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { processDefineRulesPresetRegistryFile } from "./defineRulesPreset.js";

describe("co-located preset package scopes", () => {
  it.each([false, true])(
    "preserves sibling and nested package origins with a caller loader: %s",
    async (callerLoader) => {
      await mkdir(join(process.cwd(), ".cache"), { recursive: true });
      const root = await mkdtemp(
        join(process.cwd(), ".cache", "mincho-preset-scopes-")
      );
      const app = join(root, "app");
      const preset = join(root, "preset");
      const nested = join(preset, "nested");
      const filePath = join(app, "extracted_test.css.ts");

      try {
        await mkdir(app);
        await mkdir(nested, { recursive: true });
        await Promise.all([
          writeFile(join(app, "package.json"), '{"name":"scope-consumer"}'),
          writeFile(join(preset, "package.json"), '{"name":"scope-preset"}'),
          writeFile(join(nested, "package.json"), '{"name":"scope-nested"}'),
          writeFile(
            join(nested, "index.mjs"),
            `import { defineRules } from "@mincho-js/css";
             const definition = defineRules({ properties: { display: true } });
             export const nestedPreset = definition.preset;`
          ),
          writeFile(
            join(preset, "index.mjs"),
            `import { defineRules } from "@mincho-js/css";
             export { nestedPreset } from "./nested/index.mjs";
             const definition = defineRules({ properties: { color: { brand: "royalblue" } } });
             export const css = definition.css;
             export const preset = definition.preset;`
          )
        ]);

        const compiled = await compile({
          cwd: app,
          filePath,
          originalPath: join(app, "app.tsx"),
          contents: `import { css, preset, nestedPreset } from "../preset/index.mjs";
                     export const root = css({ color: "brand" });
                     export const origins = [preset.nodes[0].origin, nestedPreset.nodes[0].origin];`,
          resolverCache: new Map(),
          plugins: callerLoader
            ? [
                {
                  name: "preset-source-loader",
                  setup(build) {
                    build.onLoad({ filter: /\.mjs$/ }, async ({ path }) => ({
                      contents: await readFile(path, "utf8"),
                      loader: "js"
                    }));
                  }
                }
              ]
            : []
        });
        const css: string[] = [];
        const evaluated = await processDefineRulesPresetRegistryFile({
          source: compiled.source,
          filePath,
          serializeVirtualCssPath: ({ source }) => {
            css.push(source);

            return "";
          }
        });

        expect(evaluated.source).toContain(
          "scope-preset:index.mjs#defineRules:0"
        );
        expect(evaluated.source).toContain(
          "scope-nested:index.mjs#defineRules:0"
        );
        expect(css.join("\n")).toContain("color: royalblue");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

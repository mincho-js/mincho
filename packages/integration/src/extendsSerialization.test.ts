import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import {
  processDefineRulesPresetRegistryFile,
  runDefineRulesPresetRegistryStep
} from "./defineRulesPreset.js";

describe("extension serialization", () => {
  it("extends imported serialized parents twice, preserving classes, variables and CSS dependencies", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore This test runs as ESM; ignore import.meta for CJS declarations.
    const cacheRoot = fileURLToPath(new URL("../.cache/", import.meta.url));
    await mkdir(cacheRoot, { recursive: true });
    const root = await mkdtemp(join(cacheRoot, "extends-"));

    async function buildModule(name: string, contents: string) {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: `@test/extends-${name}`, type: "module" })
      );
      const filePath = join(directory, "index.css.ts");
      const compiled = await compile({
        filePath,
        originalPath: filePath,
        contents,
        resolverCache: new Map()
      });
      const css: string[] = [];
      const result = await runDefineRulesPresetRegistryStep(() =>
        processDefineRulesPresetRegistryFile({
          source: compiled.source,
          filePath,
          identOption: "debug",
          serializeVirtualCssPath: ({ source }) => {
            css.push(source);
            return "";
          }
        })
      );
      const outputPath = join(directory, "index.mjs");
      await writeFile(outputPath, result.source);
      return { ...result, css: css.join("\n"), outputPath };
    }

    try {
      const parent = await buildModule(
        "parent",
        `
        import { rules, defineRules } from "@mincho-js/css";
        export const rule = rules({
          color: "crimson", props: ["width"],
          variants: { size: { small: { padding: 4 } } }
        }, "parent");
        export const definitions = defineRules({
          properties: { color: { brand: "navy" }, background: true, paddingLeft: true, paddingRight: true },
          shortcuts: { px: ["paddingLeft", "paddingRight"] },
          conditions: { hov: { selector: "&:hover" } }
        });
        export const atomic = definitions.css({ color: "brand" });
      `
      );
      const child = await buildModule(
        "child",
        `
        import { rules, defineRules } from "@mincho-js/css";
        import { rule as parent, definitions as parentDefinitions } from "../parent/index.mjs";
        export const hydratedAtomic = parentDefinitions.css({ background: "lightcyan" });
        export const scopedRecipe = parentDefinitions.rules({
          base: { px: 4 },
          variants: { active: { true: { _hov: { color: "brand" } }, false: { color: "brand" } } },
          defaultVariants: { active: true }
        }, "scoped");
        export const rule = rules.extends(parent, {
          color: "royalblue", props: ["width"],
          variants: { size: { small: { margin: 8 }, large: { padding: 16 } } }
        }, "child");
        export const definitions = defineRules.extends(parentDefinitions, { properties: { display: ["grid"] } });
        export const atomic = definitions.css({ color: "brand" });
      `
      );
      const grandchild = await buildModule(
        "grandchild",
        `
        import { rules, defineRules } from "@mincho-js/css";
        import { rule as parent, definitions as parentDefinitions } from "../child/index.mjs";
        import { scopedRecipe as parentScoped } from "../child/index.mjs";
        export const rule = rules.extends(parent, { backgroundColor: "goldenrod" }, "grandchild");
        export const definitions = defineRules.extends(parentDefinitions, { properties: { color: { accent: "indigo" } } });
        export const atomic = definitions.css({ color: "brand" });
        export const raw = definitions.css.raw({ color: "accent", display: "grid" });
        export const scopedRecipe = definitions.rules.extends(parentScoped, {
          variants: { active: { true: { color: "accent" } } }
        }, "extendedScoped");
      `
      );

      type Output = {
        rule: {
          (selection: { size: "small" | "large" }): string;
          props(values: { width: number }): object;
          classNames: { base: string; variants: { size: { small: string } } };
        };
        atomic: string;
        raw?: object;
        scopedRecipe: {
          (selection?: { active?: boolean }): string;
          classNames: { variants: { active: { true: string; false: string } } };
        };
      };
      const importedParent = (await import(
        pathToFileURL(parent.outputPath).href
      )) as Output;
      const importedChild = (await import(
        pathToFileURL(child.outputPath).href
      )) as Output;
      const importedGrandchild = (await import(
        pathToFileURL(grandchild.outputPath).href
      )) as Output;
      const classes = importedGrandchild.rule({ size: "small" }).split(" ");
      expect(classes).toEqual(
        expect.arrayContaining([
          importedParent.rule.classNames.base,
          importedChild.rule.classNames.base,
          importedGrandchild.rule.classNames.base,
          importedParent.rule.classNames.variants.size.small,
          importedChild.rule.classNames.variants.size.small
        ])
      );
      expect(importedGrandchild.rule.classNames.variants.size.small).toBe(
        importedChild.rule.classNames.variants.size.small
      );
      expect(importedGrandchild.rule.props({ width: 12 })).toEqual(
        importedParent.rule.props({ width: 12 })
      );
      expect(importedGrandchild.raw).toEqual({
        color: "indigo",
        display: "grid"
      });
      expect(child.css).toContain("royalblue");
      expect(child.css).toContain("lightcyan");
      expect(child.css).toContain("padding-left: 4px");
      expect(child.css).toContain(":hover");
      expect(child.css).toContain("color: navy");
      expect(child.css).not.toContain("crimson");
      expect(
        importedChild.scopedRecipe({ active: false }).split(" ")
      ).toContain(importedChild.scopedRecipe.classNames.variants.active.false);
      expect(importedGrandchild.scopedRecipe().split(" ")).toEqual(
        expect.arrayContaining(importedChild.scopedRecipe().split(" "))
      );
      expect(grandchild.css).toContain("goldenrod");
      expect(grandchild.css).toContain("indigo");
      expect(grandchild.css).not.toMatch(/crimson|royalblue|navy/);
      expect(child.ancestorStyleSpecifiers).toEqual([
        "@test/extends-parent/style.css"
      ]);
      expect(grandchild.ancestorStyleSpecifiers).toEqual([
        "@test/extends-parent/style.css",
        "@test/extends-child/style.css"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

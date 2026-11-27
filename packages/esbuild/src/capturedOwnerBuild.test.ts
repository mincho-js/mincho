import { it, expect } from "vitest";
import { build } from "esbuild";
import { minchoEsbuildPlugins } from "./plugin.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runInNewContext } from "node:vm";
it.each([false, true])(
  "serializes registered callbacks capturing a defineRules owner (atoms: %s)",
  async (atomic) => {
    const parent = resolve(".cache");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "captured-owner-"));
    try {
      await writeFile(
        join(root, "build.ts"),
        "export const staticValue = fn => fn();"
      );
      await writeFile(
        join(root, "entry.ts"),
        `import {defineRules} from "@mincho-js/css";
import {staticValue} from "./build";
const owner = defineRules({properties:{color:true,display:true}});
const red = staticValue(() => owner.css({color:"red",display:"flex"}));
const blue = staticValue(() => owner.css({color:"blue"}));
const cx = staticValue(() => owner.cx);
export const stable = cx(red,blue);
const table = [cx(red),cx(red,blue)];
export const merge = active => table[active ? 1 : 0];`
      );
      const result = await build({
        absWorkingDir: root,
        entryPoints: ["entry.ts"],
        outdir: "out",
        bundle: true,
        write: false,
        format: "cjs",
        plugins: minchoEsbuildPlugins({
          extractCalls: { "./build.ts": ["staticValue"] },
          optimize: {
            defineRulesCxConditions: true,
            staticScopedCx: false,
            symbolicTokens: false
          },
          experimental: { globalAtomicClasses: atomic, cssBooleanGates: false },
          execution: { workers: 0 },
          cache: false
        })
      });
      const code = result.outputFiles!.find((f) =>
        f.path.endsWith(".js")
      )!.text;

      const module = {
        exports: {} as { stable: string; merge: (active: boolean) => string }
      };
      runInNewContext(code, {
        module,
        exports: module.exports,
        process: { env: { NODE_ENV: "production" } }
      });
      const runtime = module.exports;
      expect(runtime.merge(false)).not.toBe(runtime.merge(true));
      expect(runtime.merge(true)).toBe(runtime.stable);
      const css = result
        .outputFiles!.filter((file) => file.path.endsWith(".css"))
        .map((file) => file.text)
        .join("\n");
      for (const name of new Set(
        [runtime.merge(false), runtime.merge(true), runtime.stable].flatMap(
          (value) => value.split(/\s+/)
        )
      )) {
        if (!name.startsWith("__mincho_seg_"))
          expect(css).toContain("." + name);
      }
      expect(code).not.toContain("staticValue");
      expect(code).not.toContain("defineRules(");
      expect(code).not.toContain("getFileScope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000
);

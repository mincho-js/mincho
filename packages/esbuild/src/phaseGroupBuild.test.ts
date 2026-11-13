import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { buildWithMincho } from "./build.js";

it("serializes only the final primitive of a shared-provider authoring group", async () => {
  const parent = resolve(process.cwd(), ".test-build-api");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, "phase-group-"));

  try {
    const source = resolve(
      process.cwd(),
      "../integration/src/__fixtures__/extract-calls-phase-group"
    );
    await fs.cp(source, root, { recursive: true });
    const options = {
      absWorkingDir: root,
      entryPoints: ["entry.ts"],
      outdir: "out",
      write: false,
      bundle: true,
      format: "cjs" as const
    };
    const original = await build(options);
    const extracted = await buildWithMincho({
      ...options,
      mincho: {
        extractCalls: {
          "./provider": ["first", "second", "mutate", "finish"]
        }
      }
    });
    const execute = (code: string) => {
      const module = { exports: {} as { output: string } };
      runInNewContext(code, {
        module,
        exports: module.exports,
        process: { env: { NODE_ENV: "production" } }
      });
      expect(Object.keys(module.exports)).toEqual(["output"]);
      return module.exports.output;
    };
    const originalCode = original.outputFiles!.find((file) =>
      file.path.endsWith("/entry.js")
    )!.text;
    const extractedCode = extracted.outputFiles!.find((file) =>
      file.path.endsWith("/entry.js")
    )!.text;
    const expected =
      "true:blue:blue:changed|4|first,second,mutate:true,finish:true:blue:blue:changed";

    expect(execute(originalCode)).toBe(expected);
    expect(execute(extractedCode)).toBe(expected);
    // Running provider calls at runtime could also reproduce the value. Require
    // the actual serialized primitive, not a retained provider implementation.
    expect(extractedCode).toContain(expected);
    expect(extractedCode).not.toMatch(
      /function (?:first|second|mutate|finish)\b/
    );
    expect(extractedCode).not.toContain("singleton");
    expect(extractedCode).not.toContain("events.push");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("rejects an unserializable terminal closure instead of retaining the authoring group at runtime", async () => {
  const parent = resolve(process.cwd(), ".test-build-api");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, "phase-group-closure-"));

  try {
    const source = resolve(
      process.cwd(),
      "../integration/src/__fixtures__/extract-calls-phase-group"
    );
    await fs.cp(source, root, { recursive: true });
    await fs.appendFile(
      join(root, "provider.ts"),
      `
export function finishClosure(
  left: typeof singleton,
  right: typeof singleton,
  changed: string
) {
  const output = finish(left, right, changed);
  return () => output;
}
`
    );
    await fs.writeFile(
      join(root, "entry.ts"),
      `import { first, second, mutate, finishClosure } from "./provider";
const left = first();
const right = second();
const changed = mutate(left, right);
export const output = finishClosure(left, right, changed);
`
    );

    await expect(
      buildWithMincho({
        absWorkingDir: root,
        entryPoints: ["entry.ts"],
        outdir: "out",
        write: false,
        bundle: true,
        format: "cjs",
        mincho: {
          extractCalls: {
            "./provider": ["first", "second", "mutate", "finishClosure"]
          }
        }
      })
    ).rejects.toThrow(
      /Invalid exports\.[\s\S]*You can only export plain objects, arrays, strings, numbers and null\/undefined/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

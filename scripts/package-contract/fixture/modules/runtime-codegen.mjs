import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const root = resolve("fixture/modules/runtime-codegen");
await mkdir(root, { recursive: true });
await writeFile(
  join(root, "entry.tsx"),
  `
  export function merge(classes) { return <div className="base" css={classes}/>; }
  export function rule(flag) { return <div css={{color: flag ? "red" : "blue"}}/>; }
  export function width(size) { return <div css={{width: +size}}/>; }
`
);

for (const format of ["esm", "cjs"])
  for (const verbatimModuleSyntax of [false, true]) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["entry.tsx"],
      outdir: join(root, "dist"),
      bundle: true,
      minify: true,
      write: false,
      format,
      jsx: "automatic",
      jsxImportSource: "@mincho-js/react",
      external: ["react"],
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax } },
      logLevel: "silent",
      metafile: true,
      plugins: minchoEsbuildPlugins({ jsxCssProp: true, cache: false })
    });

    const code = result.outputFiles.find((file) =>
      file.path.endsWith(".js")
    ).text;

    assert.ok(
      Buffer.byteLength(code) < 4096,
      `Generated helpers exceed 4KiB: ${Buffer.byteLength(code)}`
    );
    assert.doesNotMatch(
      code,
      /setFileScope|registerDefineRulesRegistryInstance|appendCss|createRuntimeFn|assertNoCssProp/
    );

    const inputs = Object.keys(result.metafile.inputs).join("\n");

    assert.doesNotMatch(
      inputs,
      /@vanilla-extract\/|transform-to-vanilla|defineRulesRegistry|jsxCssPropRuntimeGuard/
    );

    const file = join(
      root,
      `${format}-${verbatimModuleSyntax}.${format === "esm" ? "mjs" : "cjs"}`
    );

    await writeFile(file, code);

    const imported = await import(pathToFileURL(file).href);
    const output = format === "esm" ? imported : imported.default;

    assert.equal(output.merge(["x", { y: true }]).props.className, "base x y");
    assert.notEqual(
      output.rule(true).props.className,
      output.rule(false).props.className
    );
    assert.deepEqual(Object.values(output.width(0).props.style), [0]);

    console.log(
      `[runtime-codegen] ${format}, verbatim=${verbatimModuleSyntax}: ${Buffer.byteLength(code)} raw / ${gzipSync(code).length} gzip bytes`
    );
  }

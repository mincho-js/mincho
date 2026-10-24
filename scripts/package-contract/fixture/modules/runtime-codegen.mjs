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
  import {rules} from "@mincho-js/css";
  const recipe = rules({variants:{tone:{red:{color:"red"},blue:{color:"blue"}}},props:["width","color"]});
  export function propsDynamic(input) {return recipe.props(input);}
  export function propsStatic(read) {return recipe.props({width:read("width"),color:read("color")});}
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
      /setFileScope|registerDefineRulesRegistryInstance|appendCss|createRuntimeFn|assertNoCssProp|variantClassNames|compoundVariants/
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

    const events = [];
    const mapped = output.propsDynamic({
      get width() {
        events.push("width");

        return 0;
      },

      get unknown() {
        events.push("unknown");

        return true;
      },

      get color() {
        events.push("color");

        return null;
      }
    });

    assert.deepEqual(Object.values(mapped), [0, null]);
    assert.deepEqual(events, ["width", "unknown", "color"]);
    assert.notEqual(output.propsDynamic({}), output.propsDynamic({}));

    events.length = 0;

    assert.deepEqual(
      Object.values(
        output.propsStatic((name) => {
          events.push(name);

          return name;
        })
      ),
      ["width", "color"]
    );
    assert.deepEqual(events, ["width", "color"]);

    const css = result.outputFiles.find((file) =>
      file.path.endsWith(".css")
    ).text;

    assert.match(css, /color:red/);
    assert.match(css, /color:#00f|color:blue/);

    console.log(
      `[runtime-codegen] ${format}, verbatim=${verbatimModuleSyntax}: ${Buffer.byteLength(code)} raw / ${gzipSync(code).length} gzip bytes`
    );
  }

await writeFile(
  join(root, "compact.ts"),
  `import {rules} from '@mincho-js/css';const button=rules({base:{display:'flex'},variants:{size:{small:{color:'red'},large:{color:'blue'}}},defaultVariants:{size:'small'}});export const render=value=>button(value);`
);
await writeFile(
  join(root, "literal.ts"),
  `import {rules} from '@mincho-js/css';const button=rules({variants:{size:{small:{color:'red'},large:{color:'blue'}}}});export const result=button({size:'small'});`
);
for (const format of ["esm", "cjs"]) {
  const sizes = [];
  for (const enabled of [false, true]) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["compact.ts"],
      outdir: join(root, "compact-dist"),
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      format,
      logLevel: "silent",
      plugins: minchoEsbuildPlugins({
        cache: false,
        optimize: { compactRuntime: enabled, sizeAware: enabled }
      })
    });
    const code = result.outputFiles.find((file) =>
      file.path.endsWith(".js")
    ).text;
    sizes.push(Buffer.byteLength(code));
    if (enabled) {
      const included = Object.values(result.metafile.outputs)
        .flatMap((output) =>
          Object.entries(output.inputs)
            .filter(([, info]) => info.bytesInOutput)
            .map(([id]) => id)
        )
        .join("\n");
      assert.match(included, /createCompactRuntimeFn/);
      assert.doesNotMatch(included, /runtime\/cache/);
    }
    const file = join(
      root,
      `compact-${enabled}.${format === "esm" ? "mjs" : "cjs"}`
    );
    await writeFile(file, code);
    const imported = await import(pathToFileURL(file).href);
    const output = format === "esm" ? imported : imported.default;
    assert.notEqual(
      output.render({ size: "small" }),
      output.render({ size: "large" })
    );
    assert.equal(output.render({}), output.render({ size: "small" }));
    let reads = 0;
    output.render({
      get size() {
        reads++;
        return "small";
      }
    });
    assert.equal(reads, 1);
  }
  assert.ok(
    sizes[1] < sizes[0],
    `Compact ${format} runtime must be smaller: ${sizes}`
  );
  const literal = await build({
    absWorkingDir: root,
    entryPoints: ["literal.ts"],
    outdir: join(root, "literal-dist"),
    bundle: true,
    minify: true,
    write: false,
    format,
    logLevel: "silent",
    plugins: minchoEsbuildPlugins({
      cache: false,
      optimize: { compactRuntime: true, compactMetadata: true, sizeAware: true }
    })
  });
  assert.doesNotMatch(
    literal.outputFiles.find((file) => file.path.endsWith(".js")).text,
    /variantClassNames|compoundVariants/
  );
  console.log(
    `[runtime-codegen] ${format} compact runtime: ${sizes[0]} -> ${sizes[1]} raw bytes; getters and literal elimination passed`
  );
}

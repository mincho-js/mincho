import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const imports = `
  import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
  import { createDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
`;

const recipe =
  '{ defaultClassName: "base", variantClassNames: { size: { large: "large" } }, defaultVariants: {}, compoundVariants: [], propVars: {} }';

const size = (source) =>
  `${Buffer.byteLength(source)} raw / ${gzipSync(source).byteLength} gzip bytes`;

async function executeBundle(source, format) {
  if (format === "esm") {
    return import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
  }

  const module = { exports: {} };
  new Function("exports", "module", source)(module.exports, module);

  return module.exports;
}

for (const format of ["esm", "cjs"]) {
  const bundle = async (contents) =>
    (
      await build({
        stdin: { contents, resolveDir: process.cwd() },
        bundle: true,
        write: false,
        format,
        minify: true,
        logLevel: "silent"
      })
    ).outputFiles[0].text;

  const unused = await bundle(`${imports}
    const recipe = /*#__PURE__*/ createRuntimeFn(${recipe});
    const cx = /*#__PURE__*/ createDefineRulesCxRuntime({ classWrites: [] });
    export const alive = "retained";
  `);

  assert.doesNotMatch(
    unused,
    /defaultClassName|variantClassNames|classWrites|compoundVariants|createCx/
  );

  const used = await bundle(`${imports}
    const recipe = /*#__PURE__*/ createRuntimeFn(${recipe});
    const cx = /*#__PURE__*/ createDefineRulesCxRuntime({ classWrites: [] });
    export const dynamic = input => cx(recipe(input), "extra");
  `);

  assert.ok(used.length > unused.length);
  assert.doesNotMatch(
    used,
    /vanilla-extract|setFileScope|registerDefineRulesRegistryInstance|appendCss|document/
  );

  const { dynamic } = await executeBundle(used, format);

  assert.equal(dynamic({ size: "large" }), "base large extra");

  console.log(
    `[runtime-boundaries] ${format}: unused=${size(unused)}, direct=${size(used)}`
  );

  const classnameSource =
    format === "esm"
      ? `import { cx } from "@mincho-js/css/classname";
         export const merge = input => cx("base", input, ["tail"]);`
      : `const { cx } = require("@mincho-js/css/classname");
         exports.merge = input => cx("base", input, ["tail"]);`;

  const classnameResult = await build({
    stdin: { contents: classnameSource, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format,
    minify: true,
    metafile: true,
    logLevel: "silent"
  });

  const classnameBundle = classnameResult.outputFiles[0].text;

  assert.ok(
    Buffer.byteLength(classnameBundle) < 4096,
    `${format} classname consumer must stay below 4 KiB`
  );
  assert.doesNotMatch(
    classnameBundle,
    /vanilla-extract|setFileScope|registerDefineRulesRegistryInstance|appendCss|document/
  );

  for (const input of Object.keys(classnameResult.metafile.inputs)) {
    assert.doesNotMatch(
      input,
      /vanilla-extract|transform-to-vanilla|registry|\/theme\/|\/defineRules\//,
      `${format} classname consumer must not load authoring inputs: ${input}`
    );
  }

  const { merge } = await executeBundle(classnameBundle, format);

  assert.equal(merge(["active", false, "active"]), "base active active tail");

  console.log(`[classname-boundary] ${format}: ${size(classnameBundle)}`);
}

const require = createRequire(import.meta.url);

for (const entry of [
  "@mincho-js/css/classname",
  "@mincho-js/css/rules/createRuntimeFn",
  "@mincho-js/css/defineRules/createDefineRulesCxRuntime"
]) {
  for (const manifest of [
    new URL("package.json", import.meta.resolve(entry)),
    join(dirname(require.resolve(entry)), "package.json")
  ]) {
    const metadata = JSON.parse(await readFile(manifest, "utf8"));
    assert.equal(
      metadata.sideEffects,
      false,
      `${entry}: pure package boundary`
    );
  }
}

const authoringManifest = JSON.parse(
  await readFile(
    new URL("../../package.json", import.meta.resolve("@mincho-js/css")),
    "utf8"
  )
);
assert.equal(authoringManifest.sideEffects, true, "retain authoring effects");

const authoringEsm = await import("@mincho-js/css");
const classnameEsm = await import("@mincho-js/css/classname");
const authoringCjs = require("@mincho-js/css");
const classnameCjs = require("@mincho-js/css/classname");

assert.equal(classnameEsm.cx, authoringEsm.cx);
assert.equal(classnameCjs.cx, authoringCjs.cx);
assert.equal(typeof classnameEsm.cx.multiple, "function");
assert.equal(typeof classnameCjs.cx.with, "function");

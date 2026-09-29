import assert from "node:assert/strict";
import { build } from "esbuild";

const imports = `
  import { createRuntimeFn } from "@mincho-js/css/rules/createRuntimeFn";
  import { createDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
`;

const recipe =
  '{ defaultClassName: "base", variantClassNames: { size: { large: "large" } }, defaultVariants: {}, compoundVariants: [], propVars: {} }';

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

  const dynamic =
    format === "esm"
      ? (
          await import(
            `data:text/javascript;base64,${Buffer.from(used).toString("base64")}`
          )
        ).dynamic
      : new Function(
          "exports",
          "module",
          `${used}; return module.exports.dynamic;`
        )({}, { exports: {} });

  assert.equal(dynamic({ size: "large" }), "base large extra");

  console.log(
    `[runtime-boundaries] ${format}: unused=${Buffer.byteLength(unused)}, used=${Buffer.byteLength(used)} bytes`
  );
}

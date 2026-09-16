import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { build as vite } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

const require = createRequire(import.meta.url);

function evaluate(code) {
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    process: { env: { NODE_ENV: "production" } }
  });

  return module.exports;
}

function assertClasses(css, classNames, label) {
  for (const name of classNames.split(/\s+/).filter(Boolean)) {
    assert.ok(css.includes(`.${name}`), `${label}: missing CSS for ${name}`);
  }
}

for (const mode of ["import", "require"]) {
  const [esbuild, minchoVite] = await Promise.all(
    ["@mincho-js/esbuild", "@mincho-js/vite"].map((name) =>
      mode === "import" ? import(name) : require(name)
    )
  );

  for (const name of ["vanilla-extract", "extract-calls"]) {
    const root = join(import.meta.dirname, "../extraction", name);
    const extractCalls =
      name === "extract-calls"
        ? { "./factory.ts": ["defineStyle", "makeRecipe"] }
        : undefined;

    const esbuildResult = await esbuild.buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["entry.ts"],
      outdir: "dist-esbuild",
      format: "cjs",
      write: false,
      logLevel: "silent",
      mincho: { extractCalls }
    });

    const outputs = [
      {
        label: `${mode}/${name}/esbuild`,
        code: esbuildResult.outputFiles.find((file) =>
          file.path.endsWith(".js")
        ).text,
        css: esbuildResult.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join("\n")
      }
    ];

    for (const vanilla of [false, true]) {
      const viteResult = await vite({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          minchoVite.minchoVitePlugin({ extractCalls }),
          ...(vanilla ? [vanillaExtractPlugin()] : [])
        ],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          rollupOptions: {
            input: join(root, "entry.ts"),
            preserveEntrySignatures: "strict",
            output: { format: "cjs" }
          }
        }
      });

      const files = (
        Array.isArray(viteResult) ? viteResult : [viteResult]
      ).flatMap((result) => result.output);

      outputs.push({
        label: `${mode}/${name}/vite/vanilla=${vanilla}`,
        code: files.find((file) => file.type === "chunk" && file.isEntry).code,
        css: files
          .filter(
            (file) => file.type === "asset" && file.fileName.endsWith(".css")
          )
          .map((file) => String(file.source))
          .join("\n")
      });
    }

    for (const { code, css, label } of outputs) {
      const runtime = evaluate(code);

      if (name === "extract-calls") {
        const quiet = runtime.render("quiet");
        const loud = runtime.render("loud");

        assert.notEqual(quiet, loud, label);
        assertClasses(css, runtime.className, label);
        assertClasses(css, runtime.localClassName, label);
        assert.match(css, /color:\s*orchid/, label);

        // Recipes without a base style still return a shared class with no rule.
        for (const [selected, other] of [
          [quiet, loud],
          [loud, quiet]
        ]) {
          const variants = selected
            .split(" ")
            .filter((value) => !other.split(" ").includes(value));
          assert.ok(variants.length > 0, label);
          assertClasses(css, variants.join(" "), label);
        }
        assert.match(css, /color:\s*tomato/, label);
        assert.match(css, /border-width:\s*3px/, label);
        assert.match(css, /outline-style:\s*dotted/, label);
      } else {
        const quiet = runtime.render("quiet", "flex", "red");
        const loud = runtime.render("loud", "grid", "blue");

        assert.notEqual(quiet.className, loud.className, label);
        assertClasses(css, `${quiet.className} ${loud.className}`, label);
        assert.deepEqual(Object.values(quiet.inline), ["red"], label);
        assert.deepEqual(Object.values(loud.inline), ["blue"], label);
        assert.equal(loud.normalized.mobile, "grid", label);
        assert.equal(quiet.normalized.desktop, "grid", label);
        assert.equal(quiet.mapped.desktop, 8, label);
        assert.match(css, /padding:\s*13px/, label);
        assert.match(css, /@layer reset/, label);
        assert.match(css, /@keyframes/, label);

        const assigned = {};
        runtime.update(
          {
            style: {
              setProperty: (key, value) => {
                assigned[key] = value;
              }
            }
          },
          "green"
        );
        assert.deepEqual(
          assigned,
          { [Object.keys(quiet.inline)[0]]: "green" },
          label
        );
      }
    }
  }
}

console.log(
  "[package-contract] installed ESM/CJS vanilla-extract and custom call extraction passed"
);

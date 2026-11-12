import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { buildWithMincho } from "@mincho-js/esbuild";

const require = createRequire(import.meta.url);

// Build configuration must load in Node without evaluating styles or authoring.
const configSource = "@mincho-js/preset-tailwind/config";
const esmConfigPath = fileURLToPath(import.meta.resolve(configSource));
const cjsConfigPath = require.resolve(configSource);
const modulesBeforeConfig = new Set(Object.keys(require.cache));
const esmConfig = await import(configSource);
const cjsConfig = require(configSource);
const expectedExtractCalls = {
  "@mincho-js/preset-tailwind": [
    "css",
    "rules",
    "rules.extends",
    "rules.multiple",
    "cx"
  ]
};
const { extractCalls } = esmConfig;

assert.deepEqual(esmConfig.extractCalls, expectedExtractCalls);
assert.deepEqual(cjsConfig.extractCalls, expectedExtractCalls);
assert.notEqual(esmConfigPath, cjsConfigPath);
assert.doesNotMatch(
  readFileSync(esmConfigPath, "utf8"),
  /\bimport(?:\s|\()|\bfrom\s*["']/,
  "ESM build configuration must contain only data"
);
assert.doesNotMatch(
  readFileSync(cjsConfigPath, "utf8"),
  /\brequire\s*\(|\bimport\s*\(/,
  "CommonJS build configuration must contain only data"
);
assert.deepEqual(
  Object.keys(require.cache).filter((path) => !modulesBeforeConfig.has(path)),
  [cjsConfigPath],
  "Loading build configuration must not load CSS or the style compiler"
);

for (const load of [(name) => import(name), (name) => require(name)]) {
  const contracts = await load("@mincho-js/tailwind");
  const compiled = await load("@mincho-js/preset-tailwind");
  const { tailwindTokens } = await load("@mincho-js/preset-tailwind/tokens");

  assert.equal(typeof contracts.themeSpec, "function");
  assert.equal(contracts.defaultBreakpoints["2xl"], "96rem");
  assert.equal(typeof compiled.themeClass, "string");
  for (const api of ["css", "rules", "cx"])
    assert.equal(typeof compiled[api], "function");
  assert.equal(compiled.preset.schema, "mincho.defineRulesPreset");
  assert.ok(!("utilities" in compiled));
  assert.match(compiled.vars.colors["sky-500"], /^var\(--/);
  assert.equal(compiled.contract.vars.spacing, compiled.vars.spacing);
  assert.equal(tailwindTokens.spacing, "0.25rem");
  assert.equal(Object.keys(tailwindTokens.colors).length, 288);
  assert.equal(tailwindTokens.dropShadows.DEFAULT.length, 2);
  assert.match(tailwindTokens.animations.spin, /^\S+ 1s linear infinite$/);
}

assert.throws(() => require.resolve("tailwindcss"));

const root = join(import.meta.dirname, "../tailwind");

// The published classes, variable contract and token data need no compiler.
for (const entry of ["precompiled.ts", "vars-only.ts", "tokens-only.ts"]) {
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      lib: { entry: join(root, entry), formats: ["es", "cjs"] }
    }
  });

  const bundles = Array.isArray(output) ? output : [output];
  checkCommonJsEntry(bundles);

  for (const bundle of bundles) {
    const css = bundle.output
      .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
      .map((file) => String(file.source))
      .join("\n");
    const chunks = bundle.output.filter((file) => file.type === "chunk");

    checkRuntime(chunks.map((file) => file.code).join("\n"));
    for (const chunk of chunks) {
      for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
        assert.doesNotMatch(
          dependency,
          /^@mincho-js\/css(?:\/|$)/,
          "Theme data must not retain an external style compiler"
        );
      }
    }
    if (entry !== "precompiled.ts") {
      assert.equal(css, "", "Data imports must not apply styles or Preflight");
    } else {
      checkCss(css, false);
      const cjs = chunks.find(
        (file) => file.isEntry && file.fileName.endsWith(".cjs")
      );
      if (cjs) checkExports(cjs.code, css, false);
    }
  }
}

const vite = await build({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [
    minchoVitePlugin({
      extractCalls,
      libraryCss: { fileName: "tailwind.css" }
    }),
    vanillaExtractPlugin()
  ],
  build: {
    write: false,
    minify: false,
    cssMinify: false,
    lib: {
      entry: join(root, "entry.ts"),
      formats: ["es", "cjs"],
      cssFileName: "tailwind"
    }
  }
});

const viteBundles = Array.isArray(vite) ? vite : [vite];
checkCommonJsEntry(viteBundles);

for (const bundle of viteBundles) {
  const css = bundle.output
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source))
    .join("\n");
  const chunks = bundle.output.filter((file) => file.type === "chunk");

  checkCss(css);
  checkRuntime(chunks.map((file) => file.code).join("\n"));
  const cjs = chunks.find(
    (file) => file.isEntry && file.fileName.endsWith(".cjs")
  );
  if (cjs) checkExports(cjs.code, css);
}

const esbuild = await buildWithMincho({
  absWorkingDir: root,
  entryPoints: ["entry.ts"],
  outdir: "dist-esbuild",
  format: "cjs",
  write: false,
  logLevel: "silent",
  mincho: { extractCalls }
});
const css = esbuild.outputFiles
  .filter((file) => file.path.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");
const code = esbuild.outputFiles.find((file) => file.path.endsWith(".js")).text;

checkCss(css);
checkRuntime(code);
checkExports(code, css);
console.log(
  "[package-contract] Tailwind: Node build configuration, plain tokens, compiled styles, ESM/CJS authoring, Vite/esbuild and optional Preflight passed"
);

function checkCss(css, authored = true) {
  assert.match(css, /--[^:]+:\s*0\.25rem/);
  assert.match(css, /oklch\(/);

  assert.match(css, /@keyframes\s+[^\s{]+/);
  assert.doesNotMatch(css, /--theme\(/);
  if (authored) {
    assert.match(css, /width\s*>=\s*96rem/);
    assert.match(css, /@layer mincho-tailwind-preflight/);
    assert.match(css, /filter:\s*blur\(0px\)\s+drop-shadow\(/);
    assert.match(css, /rebeccapurple/);
  } else {
    assert.doesNotMatch(
      css,
      /mincho-tailwind-preflight|text-overflow|clip-path|@media/
    );
  }
}

function checkRuntime(code) {
  assert.doesNotMatch(
    code,
    /themeSpec|breakpointEntries|registerClassName|appendCss|@tailwindcss/
  );
}

function checkCommonJsEntry(bundles) {
  assert.ok(
    bundles.some((bundle) =>
      bundle.output.some(
        (file) =>
          file.type === "chunk" &&
          file.isEntry &&
          file.fileName.endsWith(".cjs")
      )
    ),
    "Missing expected CommonJS entry"
  );
}

function checkExports(code, css, authored = true) {
  const module = { exports: {} };

  runInNewContext(code, {
    module,
    exports: module.exports,
    require(specifier) {
      assert.ok(
        specifier.endsWith(".css"),
        `unexpected runtime dependency: ${specifier}`
      );
      return {};
    }
  });

  const result = module.exports;
  const classes = [];

  if (authored) {
    checkRecipe(result.coLocatedRecipes.label(), css, {
      "padding-left": `calc(${result.presetVars.spacing} * 2)`,
      "padding-right": `calc(${result.presetVars.spacing} * 2)`,
      "padding-top": `calc(${result.presetVars.spacing} * 2)`,
      "padding-bottom": `calc(${result.presetVars.spacing} * 2)`
    });
    checkRecipe(result.coLocatedRecipes.badge({ tone: "quiet" }), css, {
      "background-color": result.presetVars.colors["blue-100"]
    });
    checkRecipe(result.coLocatedButton({ size: "large", tone: "soft" }), css, {
      "background-color": result.presetVars.colors["blue-500"],
      color: result.presetVars.colors["blue-700"],
      "padding-left": `calc(${result.presetVars.spacing} * 2)`,
      "padding-right": `calc(${result.presetVars.spacing} * 2)`,
      "padding-top": `calc(${result.presetVars.spacing} * 3)`,
      "padding-bottom": `calc(${result.presetVars.spacing} * 3)`
    });
    classes.push(
      result.light,
      result.dark,
      result.surface,
      result.section,
      result.primary,
      result.truncated,
      result.screenReaderOnly
    );
    checkRecipe(result.primary, css, {
      "background-color": result.presetVars.colors["blue-500"],
      color: result.presetVars.colors.white,
      "font-weight": result.presetVars.fontWeights.bold,
      "padding-left": `calc(${result.presetVars.spacing} * 3)`,
      "padding-right": `calc(${result.presetVars.spacing} * 3)`,
      "padding-top": `calc(${result.presetVars.spacing} * 2)`,
      "padding-bottom": `calc(${result.presetVars.spacing} * 2)`,
      "border-radius": result.presetVars.radii.DEFAULT
    });
    checkRecipe(result.badge({ tone: "success" }), css, {
      "background-color": result.presetVars.colors["emerald-100"],
      color: result.presetVars.colors["emerald-900"],
      "padding-left": `calc(${result.presetVars.spacing} * 2.5)`,
      "padding-right": `calc(${result.presetVars.spacing} * 2.5)`
    });
    // Recipes may contain Vanilla Extract composition aliases with no own rule.
    // Validate the declarations selected by each recipe, including both tones.
    checkRecipe(result.button({ tone: "solid", size: "large" }), css, {
      "background-color": result.vars.colors.brand,
      color: result.vars.colors.white,
      "font-size": result.vars.fontSizes.lg.size,
      "padding-left": `calc(${result.vars.spacing} * 6)`,
      "padding-right": `calc(${result.vars.spacing} * 6)`,
      "padding-top": `calc(${result.vars.spacing} * 3)`,
      "padding-bottom": `calc(${result.vars.spacing} * 3)`
    });
    checkRecipe(result.button({ tone: "soft" }), css, {
      "background-color": result.vars.colors["violet-100"],
      color: result.vars.colors["violet-900"],
      "font-size": result.vars.fontSizes.base.size,
      "padding-left": `calc(${result.vars.spacing} * 4)`,
      "padding-right": `calc(${result.vars.spacing} * 4)`,
      "padding-top": `calc(${result.vars.spacing} * 2)`,
      "padding-bottom": `calc(${result.vars.spacing} * 2)`
    });
  } else {
    classes.push(result.themeClass);
  }

  for (const className of classes) {
    assert.ok(className.length > 0);
    for (const name of className.split(/\s+/)) {
      // Native composition markers carry metadata, not CSS declarations.
      if (name.startsWith("__mincho_seg_")) continue;
      assert.ok(css.includes(`.${name}`), `Missing CSS for ${name}`);
    }
  }
}

function checkRecipe(className, css, expected) {
  const selected = new Set(className.split(/\s+/).filter(Boolean));
  const declarations = {};

  // Read the generated plain class rules in stylesheet order. Pseudo states
  // and inherited theme variables are covered by the Chromium example tests.
  for (const [, name, body] of css.matchAll(/\.([\w-]+)\s*\{([^{}]*)\}/g)) {
    if (!selected.has(name)) continue;
    for (const [, property, value] of body.matchAll(/([\w-]+):\s*([^;]+);/g)) {
      declarations[property] = value.replace(/\s+/g, " ").trim();
    }
  }

  for (const [property, value] of Object.entries(expected)) {
    assert.equal(
      declarations[property],
      value,
      `Missing or incorrect recipe ${property}`
    );
  }
}

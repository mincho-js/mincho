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
const configSource = "@mincho-js/preset-theme-ui/config";
const esmConfigPath = fileURLToPath(import.meta.resolve(configSource));
const cjsConfigPath = require.resolve(configSource);
const modulesBeforeConfig = new Set(Object.keys(require.cache));
const esmConfig = await import(configSource);
const cjsConfig = require(configSource);
const expectedExtractCalls = {
  "@mincho-js/preset-theme-ui": ["base", "system", "dark"].flatMap((name) =>
    ["css", "rules", "rules.extends", "rules.multiple", "cx"].map(
      (api) => `${name}.${api}`
    )
  )
};
const { extractCalls } = esmConfig;

assert.deepEqual(extractCalls, expectedExtractCalls);
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

for (const load of [
  () => import("@mincho-js/preset-theme-ui"),
  () => require("@mincho-js/preset-theme-ui")
]) {
  const preset = await load();
  assert.equal(typeof preset.baseClass, "string");
  assert.equal(typeof preset.systemModeClasses.dark, "string");
  for (const name of ["base", "system", "dark"]) {
    for (const api of ["css", "rules", "cx"])
      assert.equal(typeof preset[name][api], "function");
    assert.equal(preset[name].preset.schema, "mincho.defineRulesPreset");
    assert.ok(!("elements" in preset[name]));
    assert.ok(!("recipes" in preset[name]));
  }
}

for (const load of [(name) => import(name), (name) => require(name)]) {
  const contracts = await load("@mincho-js/theme-ui");

  assert.ok(contracts.scaleProperties.colors.includes("color"));
  assert.equal(typeof contracts.themeSpec, "function");
  assert.equal(typeof contracts.normalizeTheme, "function");
  assert.ok(!("createPresetStyles" in contracts));

  const presets = await load("@mincho-js/preset-theme-ui/presets");
  assert.equal(presets.baseTokens.space[2], "8px");
  assert.equal(presets.systemModes.dark.colors.background, "#060606");

  const vars = await load("@mincho-js/preset-theme-ui");
  assert.equal(
    vars.systemContract.vars.colors.primary,
    vars.systemVars.colors.primary
  );
  assert.match(vars.systemVars.colors.primary, /^var\(--/);
}

// Type compatibility must not make consumers install the upstream/Emotion packages.
assert.throws(() => require.resolve("@theme-ui/css"));
assert.throws(() => require.resolve("@emotion/react"));

const root = join(import.meta.dirname, "../theme-ui");

// Compiled theme classes and token data work without authoring plugins.
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
  checkEsEntry(bundles, entry);

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
    const cjs = chunks.find(
      (file) => file.isEntry && file.fileName.endsWith(".cjs")
    );

    if (entry !== "precompiled.ts") {
      assert.equal(css, "", "Variable contracts must not import preset CSS");
      if (cjs) checkDataExports(cjs.code, entry);
    } else {
      checkCss(css, false);
      if (cjs) checkExports(cjs.code, css, false);
    }
  }
}

const vite = await build({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [minchoVitePlugin({ extractCalls }), vanillaExtractPlugin()],
  build: {
    write: false,
    minify: false,
    cssMinify: false,
    cssCodeSplit: true,
    lib: { entry: join(root, "entry.ts"), formats: ["es", "cjs"] }
  }
});

const viteBundles = Array.isArray(vite) ? vite : [vite];
checkCommonJsEntry(viteBundles);
checkEsEntry(viteBundles, "entry.ts");

for (const bundle of viteBundles) {
  const css = bundle.output
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source))
    .join("\n");
  const chunks = bundle.output.filter((file) => file.type === "chunk");
  const code = chunks.map((file) => file.code).join("\n");

  checkCss(css);
  checkRuntime(code);

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
  "[package-contract] Theme UI: compiled themes, published authoring APIs, ESM/CJS consumers and static CSS passed"
);

function checkCss(css, authored = true) {
  assert.match(css, /--[^:]+:\s*8px/);
  if (authored) {
    assert.match(css, /min-width:\s*40em/);
    assert.match(css, /calc\(var\(--[^)]+\)\s*\*\s*-1\)/);
  } else {
    // A theme stylesheet contains variables, not an implicit document design.
    assert.doesNotMatch(css, /(?:font-size|box-sizing|padding|color):/);
  }
}

function checkRuntime(code) {
  assert.doesNotMatch(
    code,
    /createPresetStyles|normalizeTheme|themeSpec|registerClassName|appendCss|@theme-ui\/|@emotion\//
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

function checkEsEntry(bundles, fixture) {
  const entry = bundles
    .flatMap((bundle) => bundle.output)
    .find(
      (file) =>
        file.type === "chunk" && file.isEntry && /\.m?js$/.test(file.fileName)
    );
  assert.ok(entry, `${fixture} is missing its expected ES entry`);

  const names = {
    "entry.ts": [
      "panels",
      "spacing",
      "heading",
      "nested",
      "custom",
      "customDark",
      "coLocated",
      "systemModeClasses"
    ],
    "precompiled.ts": [
      "baseClass",
      "systemClass",
      "darkClass",
      "systemModeClasses"
    ],
    "vars-only.ts": ["systemVars", "systemContract"],
    "tokens-only.ts": [
      "baseTokens",
      "systemTokens",
      "darkTokens",
      "systemModes"
    ]
  }[fixture];

  for (const name of names)
    assert.ok(
      entry.exports.includes(name),
      `${fixture} must export ${name} in ES`
    );
}

function readExports(code) {
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

  return module.exports;
}

function checkDataExports(code, entry) {
  const variables = entry === "vars-only.ts";
  const source = require(
    variables
      ? "@mincho-js/preset-theme-ui"
      : "@mincho-js/preset-theme-ui/presets"
  );
  const names = variables
    ? ["systemVars", "systemContract"]
    : ["baseTokens", "systemTokens", "darkTokens", "systemModes"];
  const expected = Object.fromEntries(
    names.map((name) => [name, source[name]])
  );

  assert.deepEqual(
    structuredClone(readExports(code)),
    structuredClone(expected),
    `${entry} must preserve its exported data`
  );
}

function checkExports(code, css, authored = true) {
  const result = readExports(code);
  const classes = authored
    ? Object.values(result.panels).flatMap((panel) => [
        panel.themeClass,
        panel.root,
        panel.heading,
        panel.link
      ])
    : [result.baseClass, result.systemClass, result.darkClass];

  for (const className of classes) {
    assert.ok(className.length > 0);
    for (const name of className.split(/\s+/)) {
      if (name.startsWith("__mincho_seg_")) continue;
      assert.ok(css.includes(`.${name}`), `Missing consumer CSS for ${name}`);
    }
  }

  assert.equal(Object.keys(result.systemModeClasses).length, 4);
  for (const className of Object.values(result.systemModeClasses)) {
    assert.ok(
      css.includes(`.${className}`),
      `Missing mode CSS for ${className}`
    );
  }
  if (authored) {
    for (const name of ["base", "system", "dark"]) {
      const { root, button, multiple } = result.coLocated[name];

      assert.ok(root.split(" ").length > 1);
      assert.equal(typeof button, "function");
      assert.ok(button({ size: "large" }).length > 0);
      assert.notEqual(
        button({ size: "large", muted: true }),
        button({ size: "large" })
      );
      const vars = require("@mincho-js/preset-theme-ui")[`${name}Vars`];
      checkRecipe(button({ size: "large", muted: true }), css, {
        "padding-top": vars.space[3],
        "padding-right": vars.space[3],
        "padding-bottom": vars.space[3],
        "padding-left": vars.space[3],
        "outline-offset": "9px",
        opacity: "0.5"
      });
      checkRecipe(multiple.label(), css, { "outline-offset": "11px" });
      checkRecipe(multiple.badge({ active: true }), css, { opacity: "0.6" });
      for (const className of root.split(" ")) {
        if (className.startsWith("__mincho_seg_")) continue;
        assert.ok(css.includes(`.${className}`));
      }
    }
    assert.match(css, /outline-offset:\s*7px/);
    assert.match(css, /outline-offset:\s*9px/);
    assert.match(css, /opacity:\s*0\.5/);

    assert.ok(result.spacing.length > 0);
    assert.ok(result.heading({ size: "display" }).length > 0);
    assert.ok(css.includes(`.${result.custom.themeClass}`));
    assert.ok(css.includes(`.${result.customDark}`));
    assert.ok(css.includes("rebeccapurple"));
    assert.ok(result.custom.recipes.text({ variant: "display" }).length > 0);
    assert.ok(result.custom.recipes.buttons({ variant: "primary" }).length > 0);
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

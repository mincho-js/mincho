import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import { minchoVitePlugin } from "@mincho-js/vite";
import { buildWithMincho } from "@mincho-js/esbuild";

const require = createRequire(import.meta.url);
const parseCss = createRequire(require.resolve("vite/package.json"))(
  "postcss"
).parse;
const source = "@mincho-js/preset-theme-ui-react";
const configSource = `${source}/config`;
const { extractCalls } = await import(configSource);
const cjsConfig = require(configSource);

assert.deepEqual(cjsConfig.extractCalls, extractCalls);
const calls = extractCalls[source];
for (const name of [
  "css",
  "rules",
  "rules.extends",
  "rules.multiple",
  "cx",
  "styled",
  "styled.button",
  "styled.svg",
  "createComponents",
  "base.components",
  "system.components",
  "dark.components",
  "base.css",
  "system.rules.multiple",
  "dark.styled.a"
]) {
  assert.ok(calls.includes(name), `Missing React preset extraction: ${name}`);
}
assert.equal(new Set(calls).size, calls.length);

for (const path of [
  fileURLToPath(import.meta.resolve(configSource)),
  require.resolve(configSource)
]) {
  assert.doesNotMatch(readFileSync(path, "utf8"), /\.css["']|defineRules\(/);
}
// Check in a fresh process so the compiler imports above cannot hide a leak.
const configProbe = spawnSync(
  process.execPath,
  [
    ...process.execArgv,
    "--input-type=commonjs",
    "--eval",
    `
      const assert = require("node:assert/strict");
      require(${JSON.stringify(configSource)});
      for (const path of Object.keys(require.cache)) {
        assert.doesNotMatch(
          path,
          /node_modules\\/(?:react|@vanilla-extract\\/css|@mincho-js\\/css)\\//,
          "Build configuration must not load React or a CSS compiler"
        );
      }
    `
  ],
  { encoding: "utf8" }
);
assert.ifError(configProbe.error);
assert.equal(configProbe.status, 0, configProbe.stderr);

const root = join(import.meta.dirname, "../theme-ui-react");
const jsxCssProp = { importSource: source };
const external = /^react(?:\/|$)/;

const vite = await build({
  root,
  configFile: false,
  logLevel: "silent",
  esbuild: { jsx: "automatic", jsxDev: false, jsxImportSource: source },
  plugins: [
    minchoVitePlugin({ extractCalls, jsxCssProp }),
    vanillaExtractPlugin()
  ],
  build: {
    cssCodeSplit: true,
    write: false,
    minify: false,
    cssMinify: false,
    lib: { entry: join(root, "entry.tsx"), formats: ["es", "cjs"] },
    rollupOptions: { external }
  }
});
const bundles = Array.isArray(vite) ? vite : [vite];
let checkedCommonJs = false;
for (const bundle of bundles) {
  const css = bundle.output
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source))
    .join("\n");
  for (const chunk of bundle.output.filter((file) => file.type === "chunk")) {
    checkRuntime(chunk.code);
    if (chunk.isEntry && chunk.fileName.endsWith(".cjs")) {
      checkExports(chunk.code, css);
      checkedCommonJs = true;
    }
  }
}
assert.ok(checkedCommonJs, "Missing Vite CommonJS fixture");

for (const jsxDev of [false, true]) {
  const result = await buildWithMincho({
    absWorkingDir: root,
    entryPoints: ["entry.tsx"],
    outdir: "dist-esbuild",
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    jsxImportSource: source,
    jsxDev,
    minify: !jsxDev,
    external: ["react", "react-dom/server"],
    write: false,
    logLevel: "silent",
    mincho: { extractCalls, jsxCssProp }
  });
  const css = result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
  const code = result.outputFiles.find((file) =>
    file.path.endsWith(".js")
  ).text;
  checkRuntime(code);
  checkExports(code, css, jsxDev ? "development" : "production");
}

console.log(
  "[package-contract] Theme UI React: pure ESM/CJS config, component variants, scoped JSX, Vite/esbuild production/development runtimes passed"
);

function checkRuntime(code) {
  assert.doesNotMatch(
    code,
    /themeSpec|normalizeTheme|registerClassName|appendCss/
  );
}

function checkExports(code, css, nodeEnv = "production") {
  // Isolate React's module cache and NODE_ENV for each generated JSX runtime.
  const probe = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--input-type=commonjs",
      "--eval",
      `
        const assert = require("node:assert/strict");
        const { readFileSync } = require("node:fs");
        const { runInNewContext } = require("node:vm");
        const { createElement } = require("react");
        const { renderToStaticMarkup } = require("react-dom/server");
        const module = { exports: {} };
        runInNewContext(readFileSync(0, "utf8"), {
          module,
          exports: module.exports,
          process,
          require(specifier) {
            if (specifier.endsWith(".css")) return {};
            assert.match(specifier, /^react(?:\\/|$)/);
            return require(specifier);
          }
        });
        const { App, vars } = module.exports;
        const html = renderToStaticMarkup(createElement(App));
        process.stdout.write(JSON.stringify({ html, vars }));
      `
    ],
    {
      input: code,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: nodeEnv }
    }
  );
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);

  const { html, vars } = JSON.parse(probe.stdout);
  assert.match(html, /Documentation/);
  assert.match(html, /href="\/docs"/);
  assert.doesNotMatch(html, /\b(?:css|tone|variant)=/);

  const cssRoot = parseCss(css);
  const layers = new Map();
  cssRoot.walkAtRules("layer", (rule) => {
    for (const name of rule.params.split(",").map((part) => part.trim())) {
      assert.match(
        name,
        /^[\w-]+$/,
        "Expected a named top-level fixture layer"
      );
      if (!layers.has(name)) layers.set(name, layers.size);
    }
  });
  const baseLayer = "mincho-theme-ui-base";
  const variantLayer = "mincho-theme-ui-variants";
  assert.ok(layers.has(baseLayer) && layers.has(variantLayer));
  assert.ok(layers.get(baseLayer) < layers.get(variantLayer));

  const declarations = (id) => {
    const element = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(element, `Missing rendered component: ${id}`);
    const className = element.match(/class="([^"]+)"/)?.[1];
    assert.ok(className, `Missing class for component: ${id}`);
    const classes = new Set(className.split(/\s+/));
    return declarationsForClasses(cssRoot, classes);
  };
  const expectValue = (values, property, expected, active) => {
    const winner = winningDeclaration(
      values.get(property) ?? [],
      layers,
      active
    );
    assert.equal(
      winner?.value,
      expected,
      `Expected winning ${property}: ${expected}; received ${JSON.stringify(values.get(property))}`
    );
    return winner;
  };

  const secondary = declarations("secondary");
  assert.equal(
    secondary.get("background-color").find((value) => value.layer === baseLayer)
      ?.value,
    vars.colors.primary
  );
  assert.deepEqual(
    secondary
      .get("background-color")
      .filter((value) => value.layer === variantLayer)
      .map((value) => value.value),
    [vars.colors.secondary]
  );
  assert.equal(
    expectValue(secondary, "background-color", vars.colors.secondary).layer,
    variantLayer
  );
  expectValue(secondary, "color", vars.colors.background);
  expectValue(secondary, "font-weight", vars.fontWeights.heading);
  for (const side of ["left", "right"]) {
    const property = `padding-${side}`;
    assert.ok(
      secondary
        .get(property)
        ?.some(
          (value) =>
            value.layer === variantLayer && value.value === vars.space[2]
        )
    );
    assert.equal(expectValue(secondary, property, vars.space[3]).layer, null);
  }

  const heading = declarations("heading");
  expectValue(heading, "color", vars.colors.primary);
  expectValue(heading, "font-family", vars.fonts.heading);
  expectValue(heading, "font-weight", vars.fontWeights.display);
  expectValue(heading, "font-size", vars.fontSizes[5]);
  const smallScreen = (conditions) =>
    conditions.every(
      (condition) =>
        condition.name === "media" && /min-width:\s*40em/.test(condition.params)
    );
  const responsive = expectValue(
    heading,
    "font-size",
    vars.fontSizes[6],
    smallScreen
  );
  assert.equal(responsive.layer, variantLayer);
  assert.equal(responsive.conditions.length, 1);

  const rootVariant = declarations("root-variant");
  expectValue(rootVariant, "color", vars.colors.primary);
  expectValue(rootVariant, "font-family", vars.fonts.heading);

  const generic = declarations("generic");
  expectValue(generic, "color", vars.colors.secondary);
  const recipe = declarations("recipe");
  expectValue(recipe, "padding-left", vars.space[1]);
  expectValue(recipe, "padding-right", vars.space[1]);
}

function declarationsForClasses(root, classes) {
  const values = new Map();
  root.walkRules((rule) => {
    if (
      !rule.selectors.some((selector) => {
        const match = selector.match(/^\.([\w-]+)$/);
        return match && classes.has(match[1]);
      })
    ) {
      return;
    }
    let layer = null;
    const conditions = [];
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== "atrule") continue;
      if (parent.name === "layer") {
        assert.equal(layer, null, "Expected a single fixture layer");
        layer = parent.params;
      } else {
        conditions.unshift({ name: parent.name, params: parent.params });
      }
    }
    for (const declaration of rule.nodes) {
      if (declaration.type !== "decl") continue;
      assert.ok(!declaration.important, "Fixture expects normal declarations");
      const value = {
        value: declaration.value.replace(/\s+/g, " ").trim(),
        layer,
        conditions
      };
      values.set(declaration.prop, [
        ...(values.get(declaration.prop) ?? []),
        value
      ]);
    }
  });
  return values;
}

function winningDeclaration(
  values,
  layers,
  active = (conditions) => !conditions.length
) {
  let winner;
  const rank = (value) => {
    if (value.layer === null) return Infinity;
    assert.ok(
      layers.has(value.layer),
      `Undeclared fixture layer: ${value.layer}`
    );
    return layers.get(value.layer);
  };
  // The fixture compares normal declarations on single-class selectors: layer
  // order precedes source order, and unlayered inline css wins over both layers.
  for (const value of values) {
    if (!active(value.conditions)) continue;
    if (!winner || rank(value) >= rank(winner)) winner = value;
  }
  return winner;
}

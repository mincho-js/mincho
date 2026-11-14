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
const source = "@mincho-js/preset-tailwind-react";
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
  "styled.svg"
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

const root = join(import.meta.dirname, "../tailwind-react");
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
  "[package-contract] React Tailwind: pure ESM/CJS config, styled calls, scoped JSX, Vite/esbuild production/development runtimes passed"
);

function checkRuntime(code) {
  assert.doesNotMatch(
    code,
    /themeSpec|breakpointEntries|registerClassName|appendCss|@tailwindcss/
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
  assert.match(html, /Grow/);
  assert.match(html, /href="\/docs"/);
  assert.doesNotMatch(html, /\b(?:css|tone)=/);

  const button = html.match(/<button\b[^>]*>/)?.[0];
  assert.ok(button, "Styled button did not render");
  const classes = new Set(button.match(/class="([^"]+)"/)[1].split(/\s+/));
  const declarations = {};
  for (const [, name, body] of css.matchAll(/\.([\w-]+)\s*\{([^{}]*)\}/g)) {
    if (!classes.has(name)) continue;
    for (const [, property, value] of body.matchAll(
      /([\w-]+):\s*([^;]+)(?:;|$)/g
    )) {
      declarations[property] = value.replace(/\s+/g, " ").trim();
    }
  }
  assert.equal(declarations["background-color"], vars.colors["blue-500"]);
  assert.equal(declarations.color, vars.colors.white);
  for (const side of ["left", "right"]) {
    assert.equal(declarations[`padding-${side}`], `calc(${vars.spacing} * 3)`);
  }
}

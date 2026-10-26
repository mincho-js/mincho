import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { build } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "compact" },
    profile: { type: "string", default: "baseline" }
  }
});
const candidate = values.profile === "candidate";
const root = resolve("bundle-size-input", values.scenario);
await mkdir(root, { recursive: true });
const variants = Object.fromEntries(
  Array.from({ length: 240 }, (_, i) => [
    `v${i}`,
    {
      color: `rgb(${i % 255},${(i * 19) % 255},${(i * 37) % 255})`,
      paddingTop: `${i}px`
    }
  ])
);
const gradient = `linear-gradient(90deg,${Array.from({ length: 80 }, (_, i) => `rgb(${i},${i + 20},${i + 40}) ${i}%`).join(",")})`;
const rule = JSON.stringify({
  color: "red",
  backgroundImage: gradient,
  display: "flex",
  position: "relative",
  paddingTop: "2px"
});
const files = {
  "package.json": '{"name":"bundle-size-fixture","type":"module"}',
  "index.html": '<script type="module" src="/main.js"></script>'
};
const options = {
  cache: false,
  appCss: { mode: "dist-chunk", optimize: false },
  diagnostics: { json: "diagnostics.json" }
};
switch (values.scenario) {
  case "compact":
    files["main.js"] =
      `import {rules} from '@mincho-js/css'; const recipe=rules({base:{display:'flex'},variants:{size:{small:{color:'red'},large:{color:'blue'}}}});globalThis.render=input=>recipe(input);`;
    options.optimize = { compactRuntime: candidate, sizeAware: candidate };
    break;
  case "closed":
    files["button.js"] =
      `import {rules} from '@mincho-js/css';export const button=rules({base:{display:'flex'},variants:{size:${JSON.stringify(variants)}}});`;
    files["main.js"] =
      `import {button} from './button.js';globalThis.render=()=>button({size:'v0'});globalThis.read=el=>getComputedStyle(el).getPropertyValue('--external');`;
    if (candidate)
      Object.assign(options.appCss, {
        usage: { mode: "closed" },
        optimize: { scopedResourceAnalysis: true, pruneRecipes: true }
      });
    break;
  case "cross-file":
    files["a.js"] =
      `import {css} from '@mincho-js/css';export const a=css(${rule});`;
    files["b.js"] =
      `import {css} from '@mincho-js/css';export const b=css(${rule});`;
    files["main.js"] =
      `import {a} from './a.js';import {b} from './b.js';globalThis.classes=[a,b];`;
    if (candidate) options.appCss.optimize = { crossFileRules: true };
    break;
  case "resources": {
    const frames = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [
          `${i * 3}%`,
          { opacity: i / 30, transform: `translateX(${i * 7}px)` }
        ])
      )
    );
    for (const id of ["a", "b"])
      files[`${id}.js`] =
        `import {css,keyframes,fontFace} from '@mincho-js/css';const animation=keyframes(${frames});const font=fontFace({src:'url(data:font/woff2;base64,AAE=)',fontStyle:'normal',fontWeight:'400'});export const ${id}=css({animationName:animation,animationDuration:'2s',fontFamily:font});`;
    files["main.js"] =
      `import {a} from './a.js';import {b} from './b.js';globalThis.classes=[a,b];`;
    if (candidate)
      options.appCss.optimize = {
        dedupeResources: true,
        scopedResourceAnalysis: true
      };
    break;
  }
  case "sharing":
    files["main.js"] =
      'import "./shared.css";import "./home.css";globalThis.routes={a:()=>import("./a.js"),b:()=>import("./b.js")};';
    files["shared.css"] = Array.from(
      { length: 100 },
      (_, i) =>
        `.shared-${i}{padding:${i}px;color:rgb(${i},${i + 20},${i + 40})}`
    ).join("");
    files["home.css"] = ".home{color:red}";
    for (const id of ["a", "b"]) {
      files[`${id}.js`] =
        `import './shared.css';import './${id}.css';export const route='${id}';`;
      files[`${id}.css`] = `.${id}{color:blue}`;
    }
    Object.assign(options.appCss, {
      sharing: { minBytes: 0, cost: candidate ? {} : false },
      routes: [
        { id: "a", entry: "a.js" },
        { id: "b", entry: "b.js" }
      ],
      ssrManifest: true
    });
    break;
  case "theme-controller":
  case "themes": {
    for (const mode of ["light", "dark"])
      files[`${mode}.js`] =
        `import {css} from '@mincho-js/css';export const themeClass=css({vars:${JSON.stringify(Object.fromEntries(Array.from({ length: 220 }, (_, i) => [`--app-color-${i}`, `rgb(${mode === "light" ? i : 255 - i},${(i * 13) % 255},${(i * 17) % 255})`])))}});`;
    files["main.js"] =
      values.scenario === "theme-controller"
        ? candidate
          ? 'import {createThemeController} from "@mincho-js/vite/themes";globalThis.createThemes=(manifest,options)=>createThemeController(manifest,options);globalThis.app="ready";'
          : 'globalThis.app="ready";'
        : candidate
          ? 'globalThis.app="ready";'
          : 'import {themeClass as light} from "./light.js";import {themeClass as dark} from "./dark.js";globalThis.app={light,dark};';
    options.appCss.themes = {
      default: "light",
      entries: ["light", "dark"].map((id) => ({ id, entry: `${id}.js` }))
    };
    break;
  }
  default:
    throw new Error(`Unknown scenario: ${values.scenario}`);
}
await Promise.all(
  Object.entries(files).map(([name, content]) =>
    writeFile(join(root, name), content)
  )
);
const cpu = process.cpuUsage(),
  start = performance.now();
const built = await build({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [minchoVitePlugin(options)],
  build: { write: false, minify: true, cssMinify: true, manifest: true }
});
const time = {
  milliseconds: performance.now() - start,
  cpu: process.cpuUsage(cpu)
};
const output = (Array.isArray(built) ? built[0] : built).output;
const bytes = (source) => {
  const value = Buffer.from(source);
  return {
    raw: value.length,
    gzip: gzipSync(value, { level: 9 }).length,
    brotli: brotliCompressSync(value, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  };
};
const assets = Object.fromEntries(
  output.map((item) => [
    item.fileName,
    {
      type:
        item.type === "chunk"
          ? "js"
          : item.fileName.endsWith(".css")
            ? "css"
            : item.fileName.endsWith(".html")
              ? "html"
              : "metadata",
      ...bytes(item.type === "chunk" ? item.code : item.source)
    }
  ])
);
const chunks = new Map(
  output
    .filter((item) => item.type === "chunk")
    .map((item) => [item.fileName, item])
);
const entry = output.find(
  (item) =>
    item.type === "chunk" &&
    item.isEntry &&
    item.facadeModuleId?.endsWith("index.html")
);
assert.ok(entry);
const initial = new Set(["index.html"]);
function visit(chunk) {
  if (initial.has(chunk.fileName)) return;
  initial.add(chunk.fileName);
  for (const id of chunk.imports) if (chunks.has(id)) visit(chunks.get(id));
  for (const css of chunk.viteMetadata?.importedCss ?? []) initial.add(css);
}
visit(entry);
let themeVisits;
let routeFiles;
const themeAsset = output.find(
  (item) => item.fileName === ".vite/mincho-css-manifest.json"
);
if (themeAsset) {
  const registry = JSON.parse(String(themeAsset.source));
  routeFiles = registry.routes;
  if (registry.themes) {
    for (const file of registry.themes.entries.light.css) initial.add(file);
    themeVisits = registry.themes.entries.dark.css.filter(
      (file) => !initial.has(file)
    );
  }
}
const sum = (names, type) =>
  [...new Set(names)]
    .filter((name) => !type || assets[name]?.type === type)
    .reduce(
      (result, name) => {
        for (const metric of ["raw", "gzip", "brotli"])
          result[metric] += assets[name]?.[metric] ?? 0;
        return result;
      },
      { raw: 0, gzip: 0, brotli: 0 }
    );
const report = JSON.parse(
  await readFile(join(root, "diagnostics.json"), "utf8")
);
const routeCache = new Set(initial);
const routeVisits = Object.entries(routeFiles ?? {}).map(([id, files]) => {
  const additional = files.filter((file) => !routeCache.has(file));
  for (const file of additional) routeCache.add(file);
  return {
    id,
    additionalCss: sum(additional, "css"),
    cumulativeCss: sum(routeCache, "css")
  };
});
console.log(
  JSON.stringify({
    scenario: values.scenario,
    profile: values.profile,
    ...time,
    assets,
    initialJs: sum(initial, "js"),
    initialCss: sum(initial, "css"),
    initialHtml: sum(initial, "html"),
    totalCss: sum(Object.keys(assets), "css"),
    initialAssets: initial.size,
    themeTransitionCss: sum(themeVisits ?? [], "css"),
    routeVisits,
    diagnostics: report.builds
      .flatMap((build) => build.events)
      .filter((event) =>
        /bundle-size|closed-app-usage|css-chunk-optimize|css-sharing/.test(
          event.phase
        )
      )
      .map(({ phase, detail }) => ({ phase, detail }))
  })
);

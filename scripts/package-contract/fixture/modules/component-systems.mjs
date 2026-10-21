// Runs from an installed npm or strict-PnP consumer. Verification stays outside compiled modules.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { build } from "vite";
import { build as bundleVendor } from "esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "all" },
    scenario: { type: "string", default: "variants" },
    root: { type: "string", default: "fixture/modules/component-systems" },
    minify: { type: "boolean", default: false },
    diagnostics: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    workers: { type: "string", default: "0" },
    format: { type: "string", default: "es" },
    guard: { type: "string", default: "none" }
  }
});

const profiles = {
  conditional: "mergeConditionalRules",
  keyframes: "pruneKeyframes",
  recipes: "pruneRecipes",
  theme: "internThemeValues"
};

assert.ok(
  ["default", "off", "pruning", "all", ...Object.keys(profiles)].includes(
    values.profile
  )
);
assert.ok(["none", "cssom", "external", "react"].includes(values.guard));

const root = resolve(
  values.root,
  values.browser
    ? "browser"
    : values.guard === "none"
      ? values.scenario
      : `${values.scenario}-${values.guard}`
);

await mkdir(root, { recursive: true });

const file = async (name, contents) => {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), contents);
};

await file(
  "package.json",
  '{"name":"mincho-component-systems-fixture","type":"module","sideEffects":["**/*.css"]}'
);

const gradient =
  "linear-gradient(90deg, rgb(1, 20, 30) 0%, rgba(100, 200, 220, 0.75) 55%, rgb(240, 245, 250) 100%)";

const secondGradient =
  "linear-gradient(180deg, rgb(190, 20, 30) 0%, rgba(100, 30, 40, 0.75) 55%, rgb(25, 45, 50) 100%)";

const tokenSource = (count = 3) => `import {buildThemes} from './build.js';
 const styles=buildThemes(${JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => ["token" + i, gradient])))},${JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => ["token" + i, secondGradient])))});
 export const {day,night,first,second}=styles;`;

const recipeSource = (
  count = 16
) => `import {rules,keyframes} from '@mincho-js/css';
 const live=keyframes({from:{opacity:0},to:{opacity:1}}); const dead=keyframes({from:{opacity:0.123},to:{opacity:0.456}});
 const recipe=rules({base:{display:'block'},variants:{size:${JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => ["v" + i, { fontSize: 12 + i }])))}},toggles:{active:{opacity:0.9}},defaultVariants:{size:'v0'},compoundVariants:({size,active})=>[{condition:[size.v0,active.true],style:{color:'red'}},{condition:[size.v1],style:{color:'blue'}}]});
 const animated=rules({variants:{state:{on:{animationName:live,animationDuration:'1s'},off:{animationName:dead}}}});
 export const selected=recipe({size:'v0',active:true}); export const animation=animated({state:'on'});`;

const conditionalSource = (count = 8) => `import {css} from '@mincho-js/css';
 ${Array.from({ length: count }, (_, i) => `export const c${i}=css({'@media':{'(min-width:1px)':{'@supports':{'(display:grid)':{color:'rgb(${i >> 1}, 128, 0)',paddingTop:7}}}}});`).join("\n")}
 export const pair=[c0,c1].join(' ');`;

await file(
  "build.js",
  `import {theme,css,keyframes,globalKeyframes} from '@mincho-js/css';
 export function buildThemes(dayTokens,nightTokens){const day=theme(dayTokens);const night=theme.extends(day[2],nightTokens);return{day,night,first:css({backgroundImage:day[1].token0}),second:css({backgroundImage:day[1].token1})};}
 export function buildFrames(count){const frames=[];for(let i=0;i<count;i++)frames.push(keyframes({from:{opacity:0,transform:'translateX('+i+'px)'},to:{opacity:1}}));globalKeyframes('foreign-animation',{from:{opacity:0.5},to:{opacity:1}});return css({animation:frames[0]+' 1s linear'});}`
);
await file("tokens.js", tokenSource(values.browser ? 6 : 128));
await file("recipes.js", recipeSource(values.browser ? 16 : 160));
await file("conditions.js", conditionalSource(values.browser ? 8 : 128));
await file(
  "animations.js",
  `import {buildFrames} from './build.js'; export const active=buildFrames(160);`
);
await file(
  "ordinary.js",
  `import {css} from '@mincho-js/css'; export const ordinary=css({display:'flex',gap:8,color:'black'});`
);
await file(
  "route-a.js",
  `import {css} from '@mincho-js/css'; export const route=css({color:'purple'});`
);
await file(
  "route-b.js",
  `import {css} from '@mincho-js/css'; export const route=css({color:'orange'});`
);

const imports = {
  tokens: "import * as data from './tokens.js';",
  variants: "import * as data from './recipes.js';",
  keyframes: "import * as data from './animations.js';",
  conditional: "import * as data from './conditions.js';",
  small: "import * as data from './ordinary.js';"
};

let serverHtml;

if (values.browser) {
  await file(
    "app.js",
    `import {createElement} from 'react'; import {day,night,first,second} from './tokens.js'; import {selected,animation} from './recipes.js'; import {pair} from './conditions.js';
    export {day,night,first,second}; export function App(){return createElement('div',{id:'parent',className:day[0]},createElement('div',{id:'one',className:first+' '+selected}),createElement('div',{id:'two',className:second}),createElement('div',{id:'child',className:night[0]},createElement('div',{id:'nested',className:first})),createElement('div',{id:'conditional',className:pair}),createElement('div',{id:'animation',className:animation}));}`
  );
  await file("server.js", `export {App} from './app.js';`);
  await file(
    "main.js",
    `import {createElement} from 'react'; import {hydrateRoot} from 'react-dom/client'; import {App,day,night,first,second} from './app.js';
    globalThis.hydrationErrors=[]; hydrateRoot(document.getElementById('root'),createElement(App),{onRecoverableError:error=>globalThis.hydrationErrors.push(error.message)});
    globalThis.fixture={day,night,first,second,routes:{a:()=>import('./route-a.js'),b:()=>import('./route-b.js')}};`
  );
} else {
  assert.ok(imports[values.scenario]);

  await file(
    "main.js",
    `${imports[values.scenario]} globalThis.fixture=data; globalThis.routes={a:()=>import('./route-a.js'),b:()=>import('./route-b.js')};`
  );
}

await file(
  "index.html",
  '<!doctype html><div id="root"></div><pre id="result"></pre><script type="module" src="/main.js"></script>'
);

if (values.guard !== "none") {
  assert.ok(!values.browser);

  const guards = {
    cssom: "globalThis.observe=element=>getComputedStyle(element);",
    external: "import './external.css';",
    react:
      "import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; createRoot(document.getElementById('root')).render(createElement('div',{className:data.selected},'Pruning consumer'));"
  };

  if (values.guard === "external")
    await file("external.css", ".external{color:black}");

  await file(
    "main.js",
    (await readFile(join(root, "main.js"), "utf8")) + guards[values.guard]
  );
}

const enabled = Object.fromEntries(
  Object.entries(profiles).map(([profile, key]) => [
    key,
    values.profile === profile ||
      values.profile === "all" ||
      (values.profile === "pruning" &&
        ["pruneRecipes", "pruneKeyframes"].includes(key))
  ])
);

const out = join(
  root,
  `${values.profile}-${values.minify ? "min" : "raw"}-${values.format}`
);

const cacheDir = join(root, "compilation-cache");
await rm(cacheDir, { recursive: true, force: true });

const options = {
  extractCalls: { "./build.js": ["buildThemes", "buildFrames"] },
  appCss: {
    mode: "dist-chunk",
    ...(values.profile === "default" ? {} : { optimize: enabled }),
    routes: [
      { id: "a", entry: "route-a.js", layouts: [] },
      { id: "b", entry: "route-b.js", layouts: [] }
    ]
  },
  cache: { type: "filesystem", directory: cacheDir },
  execution: { workers: Number(values.workers) },
  ...(values.diagnostics
    ? { diagnostics: { json: join(root, "diagnostics.json") } }
    : {})
};

const config = () => ({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [minchoVitePlugin(options)],
  build: {
    outDir: out,
    write: false,
    minify: values.minify,
    cssMinify: values.minify,
    target: "esnext",
    manifest: true,
    rollupOptions: {
      ...(values.browser ? { external: ["react", "react-dom/client"] } : {}),
      output: { format: values.format }
    }
  }
});

const flatten = (output) =>
  (Array.isArray(output) ? output : [output]).flatMap((item) => item.output);

if (values.browser) {
  const output = flatten(
    await build({
      ...config(),
      build: {
        ...config().build,
        ssr: join(root, "server.js"),
        outDir: join(root, "server"),
        write: true,
        rollupOptions: {
          external: ["react", "react-dom/server"],
          output: { entryFileNames: "entry.mjs" }
        }
      }
    })
  );

  assert.ok(
    output.every(
      (item) => item.type !== "asset" || !item.fileName.endsWith(".css")
    )
  );

  const { App } = await import(
    pathToFileURL(join(root, "server/entry.mjs")).href
  );

  serverHtml = renderToString(createElement(App));
}

global.gc?.();

const start = performance.now();
const assets = flatten(await build(config()));
const coldBuildMs = performance.now() - start;
global.gc?.();

const heapBytes = process.memoryUsage().heapUsed;
const warmStart = performance.now();
const warm = flatten(await build(config()));
const warmBuildMs = performance.now() - warmStart;

const source = (item) =>
  item.type === "chunk" ? item.code : String(item.source);

const fingerprint = (assets) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...assets]
          .sort((left, right) => left.fileName.localeCompare(right.fileName))
          .map((item) => [item.fileName, source(item)])
      )
    )
    .digest("hex");

assert.equal(
  fingerprint(assets),
  fingerprint(warm),
  "warm filesystem replay changed output"
);

const manifest = JSON.parse(
  source(assets.find((item) => item.fileName === ".vite/manifest.json"))
);

const initial = new Set();

const visit = (key) => {
  const entry = manifest[key];
  if (!entry || initial.has(entry.file)) return;

  initial.add(entry.file);
  (entry.css ?? []).forEach((file) => initial.add(file));
  (entry.imports ?? []).forEach(visit);
};

Object.keys(manifest)
  .filter((key) => manifest[key].isEntry)
  .forEach(visit);

const sizes = (selected) =>
  selected.reduce(
    (sum, item) => {
      const text = source(item);
      sum.raw += Buffer.byteLength(text);
      sum.gzip += gzipSync(text, { level: 9 }).length;
      sum.brotli += brotliCompressSync(text, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
      }).length;

      return sum;
    },
    { raw: 0, gzip: 0, brotli: 0 }
  );

const js = assets.filter((item) => item.type === "chunk");
const css = assets.filter((item) => item.fileName.endsWith(".css"));
const cssText = css.map(source).join("\n");
const parseCss = createRequire(
  createRequire(import.meta.url).resolve("vite/package.json")
)("postcss").parse;

const exactRules = new Set(),
  declarationBlocks = new Set();

const duplication = {
  qualifiedRules: 0,
  declarationBytes: 0,
  exactRepeatedRules: 0,
  exactRepeatedDeclarationBytes: 0,
  repeatedDeclarationBlocks: 0,
  repeatedDeclarationBytes: 0
};

for (const asset of css)
  parseCss(source(asset)).walkRules((rule) => {
    const path = [];

    for (let parent = rule.parent; parent; parent = parent.parent)
      if (parent.type === "atrule") path.unshift([parent.name, parent.params]);

    const declarationNodes = rule.nodes.filter((node) => node.type === "decl");
    const declarations = declarationNodes.map((node) => [
      node.prop,
      node.value,
      !!node.important
    ]);

    // Excludes selector/wrapper whitespace; retains each declaration's spelling.
    const bytes = Buffer.byteLength(
      declarationNodes.map((node) => `${node.toString()};`).join("")
    );

    const exact = JSON.stringify([path, rule.selector, declarations]);
    const block = JSON.stringify([path, declarations]);
    duplication.qualifiedRules++;
    duplication.declarationBytes += bytes;

    if (exactRules.has(exact)) {
      duplication.exactRepeatedRules++;
      duplication.exactRepeatedDeclarationBytes += bytes;
    } else exactRules.add(exact);

    if (declarationBlocks.has(block)) {
      duplication.repeatedDeclarationBlocks++;
      duplication.repeatedDeclarationBytes += bytes;
    } else declarationBlocks.add(block);
  });

if (!values.browser && values.guard === "none") {
  if (enabled.pruneRecipes && values.scenario === "variants")
    assert.ok(
      !/font-size:\s*171px/.test(cssText),
      "unused recipe selections survived"
    );
  if (enabled.pruneKeyframes && values.scenario === "keyframes")
    assert.equal(
      (cssText.match(/@keyframes/g) ?? []).length,
      2,
      "private/global keyframe ownership"
    );
  if (enabled.mergeConditionalRules && values.scenario === "conditional")
    assert.equal(
      (cssText.match(/padding-top:\s*7px/g) ?? []).length,
      64,
      "adjacent conditional merging"
    );
  if (enabled.internThemeValues && values.scenario === "tokens")
    assert.ok(
      cssText.includes("--mi-"),
      "captured theme values were not interned"
    );
}

assert.ok(
  !js.map(source).join("\n").includes("compiler-style-resources"),
  "Build-only resource capture leaked into client output"
);

if (values.browser) {
  for (const item of assets) {
    await mkdir(dirname(join(out, item.fileName)), { recursive: true });
    await writeFile(join(out, item.fileName), source(item));
  }

  const html = await readFile(join(out, "index.html"), "utf8");

  // React's generic CSSOM implementation intentionally remains an opaque guard
  // in product builds. Build this known renderer separately to exercise pruning.
  const vendor = await bundleVendor({
    stdin: {
      contents:
        "export {createElement} from 'react'; export {hydrateRoot} from 'react-dom/client';",
      resolveDir: process.cwd()
    },
    bundle: true,
    plugins: [
      {
        name: "installed-vendor-resolution",

        setup(build) {
          const require = createRequire(import.meta.url);
          build.onResolve({ filter: /^[^./]/ }, (args) => ({
            path: require.resolve(args.path, {
              paths: [args.resolveDir || process.cwd()]
            })
          }));
        }
      }
    ],
    write: false,
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' }
  });

  await writeFile(join(out, "vendor.js"), vendor.outputFiles[0].text);
  await writeFile(
    join(out, "index.html"),
    html
      .replace(
        /^<!doctype html>/i,
        '$&<script type="importmap">{"imports":{"react":"./vendor.js","react-dom/client":"./vendor.js"}}</script>'
      )
      .replace('<div id="root"></div>', `<div id="root">${serverHtml}</div>`)
      .replace("</html>", "") + '<script src="./verify.js"></script>'
  );

  // This script is appended after building. CSSOM checks never disable compiler liveness.
  await writeFile(
    join(out, "verify.js"),
    `
    const check=(value,message)=>{if(!value)throw Error(message)};
    async function verify(){if(!globalThis.fixture){setTimeout(verify,20);return;} try {
      check(document.compatMode==='CSS1Compat','standards rendering mode');
      await new Promise(resolve=>setTimeout(resolve,100)); const {day,night,routes}=fixture;
      const parent=document.getElementById('parent'),one=document.getElementById('one'),two=document.getElementById('two'),nested=document.getElementById('nested');
      const image=node=>getComputedStyle(node).backgroundImage; const dayImage=image(one),nightImage=image(nested);
      check(dayImage!==nightImage,'parent/child themes'); check(image(two)===dayImage,'same literal');
      const token=day[1].token0.slice(4,-1); parent.style.setProperty(token,'linear-gradient(red, red)');
      check(image(one).includes('rgb(255, 0, 0)'),'independent override');check(image(two)===dayImage,'sibling token alias');check(image(nested)===nightImage,'nested token override');parent.style.removeProperty(token);
      check(getComputedStyle(document.getElementById('conditional')).paddingTop==='7px','merged conditional classes');
      check(getComputedStyle(one).fontSize==='12px','recipe selection');
      const animated=document.getElementById('animation');animated.style.animationIterationCount='infinite';animated.style.animationTimingFunction='linear';const animations=animated.getAnimations();check(animations.length===1,'live keyframe definition');animations[0].pause();animations[0].currentTime=500;const animationOpacity=Number(getComputedStyle(animated).opacity);check(Math.abs(animationOpacity-0.5)<0.01,'live animation midpoint');
      const transitions=[];for(const name of ['a','b','a']){const module=await routes[name]();one.className=module.route;transitions.push(getComputedStyle(one).color);}
      check(transitions.join('|')==='rgb(128, 0, 128)|rgb(255, 165, 0)|rgb(128, 0, 128)','route order');
      const start=performance.now();for(let i=0;i<200;i++){parent.className=i%2?day[0]:night[0];image(two);}const updateMs=performance.now()-start;
      check(hydrationErrors.length===0,'hydration');const css=performance.getEntriesByType('resource').filter(item=>item.name.includes('.css')).map(item=>({name:new URL(item.name).pathname,transferSize:item.transferSize}));
      document.getElementById('result').textContent=JSON.stringify({ok:true,errors:hydrationErrors,updateMs,transitions,css,dayImage,nightImage,animationOpacity});
    }catch(error){document.getElementById('result').textContent=JSON.stringify({error:error.stack});}}verify();`
  );

  if (values.profile === "all") {
    assert.ok(cssText.includes("--mi-"), "theme interning did not run");
    assert.ok(
      !cssText.includes("font-size: 27px"),
      "recipe pruning did not run"
    );
    assert.equal(
      (cssText.match(/@keyframes/g) ?? []).length,
      1,
      "keyframe pruning did not run"
    );
    assert.ok(
      /,[^{}]+\{[^{}]*padding-top/s.test(cssText) ||
        /,[^{}]+\{[^{}]*paddingTop/s.test(cssText),
      "conditional merging did not run"
    );
  }
}

const events = values.diagnostics
  ? JSON.parse(await readFile(join(root, "diagnostics.json"), "utf8"))
      .builds.flatMap((item) => item.events)
      .filter((item) =>
        [
          "css-ir-aggregation",
          "css-ir-optimize",
          "css-resource-proofs",
          "private-resource-analysis"
        ].includes(item.phase)
      )
  : undefined;

console.log(
  JSON.stringify({
    scenario: values.scenario,
    profile: values.profile,
    minify: values.minify,
    format: values.format,
    coldBuildMs,
    warmBuildMs,
    heapBytes,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    js: sizes(js),
    css: sizes(css),
    initialJs: sizes(js.filter((item) => initial.has(item.fileName))),
    initialCss: sizes(css.filter((item) => initial.has(item.fileName))),
    chunks: js.length,
    cssAssets: css.length,
    duplication,
    initialRequests: initial.size,
    hash: fingerprint(assets),
    ...(events ? { events } : {}),
    ...(values.browser ? { browser: out } : {})
  })
);

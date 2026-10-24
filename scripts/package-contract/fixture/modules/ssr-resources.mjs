import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { build as bundle } from "esbuild";
import { createElement as h, Suspense, use } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { minchoVitePlugin } from "@mincho-js/vite";
import {
  createSsrCssCollector,
  resolveSsrStylesheets
} from "@mincho-js/vite/ssr";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";
import { Stylesheets } from "@mincho-js/react/stylesheets";
import { verifySsrBrowser } from "./ssr-resources-browser.mjs";

const require = createRequire(import.meta.url);

assert.equal(
  typeof require("@mincho-js/vite/ssr").resolveSsrStylesheets,
  "function"
);
assert.equal(
  typeof require("@mincho-js/react/stylesheets").Stylesheets,
  "function"
);

const root = resolve("fixture/modules/ssr-resources");
await mkdir(root, { recursive: true });

async function file(name, text) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

await file("package.json", '{"type":"module","sideEffects":["**/*.css"]}');
await file(
  "layout.ts",
  "import {globalCss,css} from '@mincho-js/css';globalCss('.order',{backgroundColor:'green'});export const shared=css({padding:7});"
);

for (const [name, color] of [
  ["a", "red"],
  ["b", "blue"]
])
  await file(
    `route-${name}.tsx`,
    `import {createElement as h,useLayoutEffect} from 'react';import {globalCss,css} from '@mincho-js/css';import {shared} from './layout';globalCss('.order',{backgroundColor:'${color}'});const own=css({color:'${color}'});export function Page(){useLayoutEffect(()=>{const el=document.getElementById('target');globalThis.commits.push({route:'${name}',color:getComputedStyle(el).color})},[]);return h('div',{id:'target',className:'order '+shared+' '+own},'${name}')}`
  );

await file(
  "app.tsx",
  `import {createElement as h,Suspense,useState,useEffect} from 'react';import {Stylesheets} from '@mincho-js/react/stylesheets';import {resolveSsrStylesheets} from '@mincho-js/vite/ssr';import {loadStylesheets} from '@mincho-js/vite/css-loading';export function App({initial,manifest}){const [page,setPage]=useState({module:initial,name:'a'});useEffect(()=>{globalThis.switchPage=async(name)=>{const links=resolveSsrStylesheets(manifest,{entries:['index.html'],routes:[name]});const [,module]=await Promise.all([loadStylesheets(links),loaders[name]()]);setPage({module,name})}},[]);return h(Suspense,{fallback:h('p',null,'loading')},h(Stylesheets,{stylesheets:resolveSsrStylesheets(manifest,{entries:['index.html'],routes:[page.name]})}),h(page.module.Page))}export const loaders={a:()=>import('./route-a'),b:()=>import('./route-b')};`
);
await file(
  "memo.tsx",
  `import {createElement as h,memo,forwardRef,createRef} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {styled} from '@mincho-js/react';import {$$styled} from '@mincho-js/react/runtime';import {createClassRuntimeFn} from '@mincho-js/css/rules/createClassRuntimeFn';const Button=styled.button({base:{color:'purple'},variants:{size:{small:{padding:4},large:{padding:8}}}});export function verifyMemo(){let calls=0;const Counted=forwardRef((props,ref)=>{calls++;return h(Button,{...props,ref})});const Cached=memo(Counted);const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);const render=tree=>flushSync(()=>root.render(tree));const ref=createRef();for(let i=0;i<20;i++)render(h(Cached,{size:'small',ref},'same'));const stableCalls=calls;const firstTag=ref.current.tagName;render(h(Cached,{size:'large',ref,as:'a',href:'/link'},'same'));const result={stableCalls,firstTag,tag:ref.current.tagName,padding:getComputedStyle(ref.current).padding,href:ref.current.getAttribute('href')};const config={defaultClassName:'before',defaultVariants:{},variantClassNames:{},compoundVariants:[]};const Mutable=$$styled('div',createClassRuntimeFn(config));render(h(Mutable));config.defaultClassName='after';render(h(Mutable));result.mutableClass=host.firstElementChild.className.trim();flushSync(()=>root.unmount());host.remove();return result}`
);
await file(
  "main.tsx",
  `import {createElement as h} from 'react';import {hydrateRoot} from 'react-dom/client';import {App,loaders} from './app';import {verifyMemo} from './memo';import {loadStylesheets} from '@mincho-js/vite/css-loading';globalThis.loadStylesheets=loadStylesheets;globalThis.verifyMemo=verifyMemo;globalThis.commits=[];globalThis.hydrationErrors=[];async function boot(){const initial=await loaders.a();hydrateRoot(document.getElementById('root'),h(App,{initial,manifest:globalThis.manifest}),{onRecoverableError:e=>globalThis.hydrationErrors.push(e.message)});}void boot();`
);
await file(
  "index.html",
  '<html><head></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>'
);
await file(
  "server.tsx",
  "export {App} from './app';export {Page} from './route-a';"
);

const routes = [
  { id: "a", entry: "./route-a.tsx", layouts: ["./layout.ts"] },
  { id: "b", entry: "./route-b.tsx", layouts: ["./layout.ts"] }
];

for (const mode of ["native", "dist-chunk"]) {
  const out = join(root, mode);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    base: "/app/",
    plugins: [
      minchoVitePlugin({ appCss: { mode, ssrManifest: true, routes } })
    ],
    build: { outDir: out, target: "esnext", minify: true }
  });

  const manifest = JSON.parse(
    await readFile(join(out, ".vite/mincho-css-manifest.json"), "utf8")
  );

  const request = createSsrCssCollector(manifest);
  request.collect({ entries: ["index.html"], routes: ["a"] });

  const links = request.flush();

  assert.deepEqual(request.flush(), []);

  const other = createSsrCssCollector(manifest);
  other.collect({ entries: ["index.html"], routes: ["a"] });

  assert.deepEqual(other.flush(), links);

  const serverOut = join(root, "server-" + mode);
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      minchoVitePlugin({ appCss: { mode, ssrManifest: true, routes } })
    ],
    build: {
      outDir: serverOut,
      ssr: join(root, "server.tsx"),
      rollupOptions: {
        external: [
          "react",
          "react-dom/server",
          "@mincho-js/react/stylesheets",
          "@mincho-js/vite/ssr"
        ]
      }
    }
  });

  const { App, Page } = await import(
    pathToFileURL(join(serverOut, "server.js")).href
  );

  async function stream(element) {
    const chunks = [];
    let full = "";
    const errors = [];
    const pipe = new PassThrough();
    pipe.setEncoding("utf8");
    pipe.on("data", (s) => {
      chunks.push(s);
      full += s;
    });

    const done = new Promise((resolve, reject) => {
      pipe.on("end", resolve);
      pipe.on("error", reject);
    });

    const controller = renderToPipeableStream(element, {
      onShellReady() {
        controller.pipe(pipe);
      },

      onError: (e) => errors.push(e.message)
    });

    await done;

    assert.deepEqual(errors, []);

    return { chunks, html: full };
  }

  const builtHtml = await readFile(join(out, "index.html"), "utf8");
  const script = builtHtml.match(/<script[^>]*src="([^"]+)"/)?.[1];

  assert.ok(script);

  const rendered = await stream(
    h(
      "html",
      null,
      h(
        "head",
        null,
        h("script", {
          dangerouslySetInnerHTML: {
            __html: `globalThis.manifest=${JSON.stringify(manifest)}`
          }
        })
      ),
      h(
        "body",
        null,
        h("div", { id: "root" }, h(App, { initial: { Page }, manifest })),
        h("script", { type: "module", src: script })
      )
    )
  );

  await writeFile(join(out, "index.html"), rendered.html);

  // A real streamed shell and later boundary; the second use of the same links
  // must not emit the stylesheets again. Replay chunks over HTTP in the browser.
  let release;
  const ready = new Promise((resolve) => (release = resolve));

  function Delayed() {
    use(ready);

    return h(
      "section",
      { id: "stream-ready" },
      h(Stylesheets, {
        stylesheets: resolveSsrStylesheets(manifest, {
          entries: ["index.html"],
          routes: ["b"]
        })
      }),
      h("div", { className: "order" }, "streamed")
    );
  }

  setTimeout(() => release(true), 40);

  const streaming = await stream(
    h(
      "html",
      null,
      h("head", null, h(Stylesheets, { stylesheets: links })),
      h(
        "body",
        null,
        h(
          Suspense,
          { fallback: h("p", { id: "stream-fallback" }, "waiting") },
          h(Delayed)
        )
      )
    )
  );

  assert.ok(streaming.chunks.length >= 2, "SSR boundary did not stream");

  for (const link of links)
    assert.equal(
      streaming.html.split(`href="${link.href}"`).length - 1,
      1,
      "stream duplicated stylesheet"
    );

  await verifySsrBrowser({ root: out, manifest, streaming: streaming.chunks });
}

// Compile the public styled runtime as a real server-component module.
await file(
  "flight.tsx",
  `import {styled} from '@mincho-js/react';import {Stylesheets} from '@mincho-js/react/stylesheets';export const Box=styled.div({base:{color:'red'},variants:{size:{large:{padding:8},small:{padding:4}}}});export const App=({size})=><><Stylesheets stylesheets={[{href:'/flight.css'}]}/><Box size={size}>server</Box></>;export const CssProp=()=> <div css={{color:'blue'}}>css prop</div>;`
);
await bundle({
  entryPoints: [join(root, "flight.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  jsxImportSource: "@mincho-js/react",
  external: ["react", "react/*"],
  outfile: join(root, "flight.js"),
  plugins: minchoEsbuildPlugins({ jsxCssProp: true }),
  logLevel: "silent"
});
await file(
  "flight-run.mjs",
  `import assert from 'node:assert/strict';import {createElement as h,memo} from 'react';import {renderToPipeableStream,registerClientReference} from 'react-server-dom-webpack/server.node';import {PassThrough} from 'node:stream';import {App,Box,CssProp} from './flight.js';async function render(element,manifest={}){let text='';const errors=[];const out=new PassThrough();out.setEncoding('utf8');out.on('data',s=>text+=s);const done=new Promise((r,j)=>{out.on('end',r);out.on('error',j)});renderToPipeableStream(element,manifest,{onError:e=>{errors.push(e.message);return 'expected-error'}}).pipe(out);await done;return {text,errors}}for(const element of [h(App,{size:'large'}),h(CssProp),h(Box,{as:'a',href:'/link',size:'small'}),h(memo(Box),{size:'large'})]){const result=await render(element);assert.deepEqual(result.errors,[]);assert.ok(!/:I\\[/.test(result.text))}const Client=registerClientReference(()=>{},'probe/client','Widget');const client=await render(h(Box,{as:Client,size:'large'}),{'probe/client':{id:'client',chunks:[],name:'Widget'}});assert.deepEqual(client.errors,[]);assert.match(client.text,/:I\\[/);for(const props of [{ref:()=>{}},{onClick:()=>{}}])assert.ok((await render(h(Box,props))).errors.length>0);console.log('Flight contract passed');`
);
execFileSync(
  process.execPath,
  [
    ...process.execArgv.filter((x) => !x.startsWith("--conditions")),
    "--conditions=react-server",
    join(root, "flight-run.mjs")
  ],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } }
);
console.log(
  "[package-contract] SSR resources, explicit memo and Flight contracts passed"
);

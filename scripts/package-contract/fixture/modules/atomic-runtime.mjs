import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { performance } from "node:perf_hooks";
import { build as esbuild, transform as minify } from "esbuild";
import { build as vite } from "vite";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "fixture/modules/atomic-runtime" },
    profile: { type: "string", default: "all" },
    bundler: { type: "string", default: "esbuild" },
    format: { type: "string", default: "esm" },
    diagnostics: { type: "boolean", default: false },
    assertions: { type: "boolean", default: true },
    browser: { type: "boolean", default: false },
    workers: { type: "string", default: "0" },
    cache: { type: "boolean", default: false }
  }
});

const { profile, bundler, format } = values;

assert.ok(["off", "cx", "tokens", "atoms", "gates", "all"].includes(profile));
assert.ok(["esbuild", "vite"].includes(bundler));
assert.ok(["esm", "cjs"].includes(format));

const enabled = (name) => profile === name || profile === "all";

const root = resolve(values.root);
await mkdir(root, { recursive: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify({
    name: "mincho-atomic-fixture",
    version: "1.0.0",
    type: "module"
  })
);
await writeFile(
  join(root, "cx.ts"),
  `
import {defineRules} from "@mincho-js/css";
import {staticValue} from "./build";
const owner = defineRules({properties:{color:true,display:true}});
const red = staticValue(() => owner.css({color:"red",display:"flex"}));
const blue = staticValue(() => owner.css({color:"blue"}));
const cx = staticValue(() => owner.cx);
export const stable = cx(red,blue);
const table = [cx(red),cx(red,blue)];
export const merge = active => table[active ? 1 : 0];
`
);
await writeFile(
  join(root, "build.ts"),
  `export const staticValue = fn => fn();`
);
await writeFile(
  join(root, "tokens.ts"),
  `
import {createVar,globalCss} from "@mincho-js/css";
export const brand = createVar("brand");
globalCss(":root",{vars:{[brand]:"red"}});
`
);
await writeFile(
  join(root, "private.tsx"),
  `
import {defineRules,css} from "@mincho-js/css";
const a = defineRules({properties:{color:true},conditions:{active:"(min-width: 1px)"}});
const b = defineRules({properties:{color:true},conditions:{active:"(min-width: 1px)"}});
const ca = css([a.css({_active:{color:"purple"}})]);
const cb = css([b.css({_active:{color:"purple"}})]);
export const First = () => <button className={ca}>first</button>;
export const Second = () => <button className={cb}>second</button>;
`
);
await writeFile(
  join(root, "entry.tsx"),
  `
import {brand} from "./tokens";
export {stable,merge} from "./cx";
export {First,Second} from "./private";
export const reference = brand;
export const effects = [];
function trace(name,value){effects.push(name);return value;}
export function Gate({active,children}) {return <div tabIndex={0} data-before={trace("before","ok")} css={trace("test",active)
 ? {color:"red",backgroundColor:"white",width:"100px",height:"100px",opacity:1,selectors:{"&:focus":{color:"green"}}}
 : {color:"blue",backgroundColor:"white",width:"200px",height:"200px",opacity:0.5,selectors:{"&:focus":{color:"purple"}}}}
 data-after={trace("after","ok")}>{children}</div>;}
export const Missing = ({active}) => <div css={active ? {color:"red"}: {}}/>;
`
);

const options = {
  jsxCssProp: true,
  extractCalls: { "./build.ts": ["staticValue"] },
  optimize: {
    defineRulesCxConditions: true,
    staticScopedCx: enabled("cx"),
    symbolicTokens: enabled("tokens")
  },
  experimental: {
    globalAtomicClasses: enabled("atoms"),
    cssBooleanGates: enabled("gates")
  },
  execution: { workers: Number(values.workers) },
  cache: values.cache,
  ...(values.diagnostics
    ? {
        diagnostics: {
          json: join(root, `${bundler}-${profile}-diagnostics.json`)
        }
      }
    : {})
};

const out = join(
  root,
  `${bundler}-${profile}-${format}${values.browser ? "-browser" : ""}`
);

let entry = "entry.tsx";

if (values.browser) {
  entry = "browser.tsx";
  await writeFile(
    join(root, entry),
    `
import {createElement,useLayoutEffect} from "react";
import {hydrateRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {Gate,effects} from "./entry";
const serverParent=document.querySelector("main > div");
const server={color:getComputedStyle(serverParent).color,child:getComputedStyle(serverParent.firstElementChild).color};
const errors=[];let ready;
const hydrated=new Promise(resolve=>ready=resolve);
function App({active}){useLayoutEffect(()=>ready(),[]);return createElement(Gate,{active},createElement(Gate,{active:!active}));}
const root=hydrateRoot(document.querySelector("main"),createElement(App,{active:true}),{onRecoverableError:error=>errors.push(error.message)});
await hydrated;
const phases=[];
const render=active=>{effects.length=0;flushSync(()=>root.render(createElement(App,{active})));
 const parent=document.querySelector("main > div"), child=parent.firstElementChild;
 phases.push({active,color:getComputedStyle(parent).color,opacity:getComputedStyle(parent).opacity,width:getComputedStyle(parent).width,child:getComputedStyle(child).color,effects:[...effects]});};
render(true);render(false);render(true);
const parent=document.querySelector("main > div");parent.focus();
const focusColor=getComputedStyle(parent).color;parent.blur();
const start=performance.now();for(let i=0;i<200;i++)render(!!(i%2));
document.querySelector("pre").textContent=JSON.stringify({server,errors,phases:phases.slice(0,3),focusColor,updateMs:performance.now()-start});
`
  );
}

const start = performance.now();
let assets;

if (bundler === "esbuild") {
  const result = await esbuild({
    absWorkingDir: root,
    entryPoints: [entry],
    outdir: out,
    bundle: true,
    write: false,
    format,
    jsx: "automatic",
    jsxImportSource: "@mincho-js/react",
    define: values.browser ? { "process.env.NODE_ENV": '"production"' } : {},
    external: values.browser ? [] : ["react"],
    logLevel: "silent",
    minify: false,
    plugins: minchoEsbuildPlugins(options)
  });

  assets = result.outputFiles.map((file) => ({
    name: file.path.split(/[\\/]/).at(-1),
    text: file.text
  }));
} else {
  const result = await vite({
    root,
    configFile: false,
    logLevel: "silent",
    define: values.browser ? { "process.env.NODE_ENV": '"production"' } : {},
    plugins: [minchoVitePlugin(options)],
    esbuild: { jsx: "automatic", jsxImportSource: "@mincho-js/react" },
    build: {
      target: "esnext",
      write: false,
      minify: false,
      cssMinify: false,
      outDir: out,
      rollupOptions: {
        input: join(root, entry),
        preserveEntrySignatures: "exports-only",
        output: {
          format: format === "esm" ? "es" : "cjs",
          entryFileNames: "entry.js"
        },
        external: values.browser
          ? []
          : ["react", "react/jsx-runtime", "react/jsx-dev-runtime"]
      }
    }
  });

  assets = (Array.isArray(result) ? result : [result]).flatMap((output) =>
    output.output.map((file) => ({
      name: file.fileName,
      text: file.type === "chunk" ? file.code : String(file.source)
    }))
  );
}

const buildMs = performance.now() - start;
const js = assets
  .filter((file) => file.name.endsWith(".js"))
  .map((file) => file.text)
  .join("\n");

const css = assets
  .filter((file) => file.name.endsWith(".css"))
  .map((file) => file.text)
  .join("\n");

await mkdir(out, { recursive: true });

if (values.browser) {
  for (const file of assets) {
    await mkdir(dirname(join(out, file.name)), { recursive: true });
    await writeFile(
      join(out, file.name),
      (
        await minify(file.text, {
          loader: file.name.endsWith(".css") ? "css" : "js",
          minify: true
        })
      ).code
    );
  }

  const serverHtml = await readFile(
    join(root, `${bundler}-${profile}-${format}`, "server.html"),
    "utf8"
  );

  await writeFile(
    join(out, "index.html"),
    `<!doctype html><link rel="stylesheet" href="./${assets.find((file) => file.name.endsWith(".css")).name}"><main>${serverHtml}</main><pre id="result"></pre><script type="module" src="./${assets.find((file) => file.name.endsWith(".js")).name}"></script>`
  );
  console.log(
    JSON.stringify({ profile, bundler, format, browser: out, buildMs })
  );
} else {
  const file = join(out, format === "esm" ? "entry.mjs" : "entry.cjs");
  await writeFile(file, js);
  global.gc?.();

  const heapBefore = process.memoryUsage().heapUsed;
  const begin = performance.now();
  const loaded = await import(pathToFileURL(file).href);
  const runtime = format === "esm" ? loaded : loaded.default;
  const initializationMs = performance.now() - begin;
  const initializationHeap = process.memoryUsage().heapUsed - heapBefore;
  const merged = [runtime.merge(false), runtime.merge(true), runtime.stable];

  assert.notEqual(merged[0], merged[1]);
  assert.equal(merged[1], merged[2]);

  for (const name of new Set(merged.flatMap((value) => value.split(/\s+/)))) {
    if (!name.startsWith("__mincho_seg_"))
      assert.ok(
        css.includes(`.${name}`),
        `CSS for baked class ${name} was dropped`
      );
  }

  let renderMs = 0;
  const html = [true, false].map((active) => {
    runtime.effects.length = 0;

    const begin = performance.now();
    const result = renderToStaticMarkup(
      createElement(runtime.Gate, { active })
    );

    renderMs += performance.now() - begin;

    assert.deepEqual(runtime.effects, ["before", "test", "after"]);

    return result;
  });

  const classOf = (fn) => fn().props.className;

  if (values.assertions) {
    if (enabled("cx"))
      assert.doesNotMatch(
        js,
        /\b(?:const|let|var|function) createCompiledDefineRulesCxRuntime\b/
      );
    if (enabled("atoms"))
      assert.equal(classOf(runtime.First), classOf(runtime.Second));

    if (enabled("gates")) {
      assert.ok(html.every((value) => value.includes("style=")));
      assert.match(css, /var\(--.*,/);

      const styles = [true, false].map(
        (active) => runtime.Gate({ active }).props.style
      );

      assert.ok(Object.keys(styles[0]).length > 0);
      assert.deepEqual(Object.keys(styles[0]), Object.keys(styles[1]));

      for (const name of Object.keys(styles[0])) {
        assert.ok(name.startsWith("--"));

        const values = styles.map((style) => style[name]);

        // Older supported React renderers trim these values before setting
        // them. An empty value removes the override and exposes the CSS reset.
        assert.ok(
          values.every(
            (value) => typeof value === "string" && value.trim().length > 0
          ),
          `Gate ${name} must survive React's inline style normalization`
        );
        assert.notEqual(values[0], values[1]);
        assert.equal(values.filter((value) => value === "initial").length, 1);
      }
    }
  }

  assert.match(runtime.reference, /^var\(--/);
  assert.ok(css.includes(runtime.reference.slice(4, -1)));

  const size = (text) => ({
    raw: Buffer.byteLength(text),
    gzip: gzipSync(text, { level: 9 }).length,
    brotli: brotliCompressSync(text, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  });

  const minifiedJs = (await minify(js, { loader: "js", minify: true })).code;
  const minifiedCss = (await minify(css, { loader: "css", minify: true })).code;
  await writeFile(
    join(out, "server.html"),
    renderToString(
      createElement(
        runtime.Gate,
        { active: true },
        createElement(runtime.Gate, { active: false })
      )
    )
  );
  console.log(
    JSON.stringify({
      profile,
      bundler,
      format,
      buildMs,
      initializationMs,
      initializationHeap,
      renderMs,
      js: size(minifiedJs),
      css: size(minifiedCss),
      generatedJs: size(js),
      generatedCss: size(css),
      html: size(html.join("")),
      inlineProperties: html.map(
        (value) => (value.match(/--[\w-]+:/g) ?? []).length
      ),
      merged,
      classes: [classOf(runtime.First), classOf(runtime.Second)],
      reference: runtime.reference
    })
  );
}
